/**
 * Exact-match cache for model responses.
 *
 * Agent loops replay the same prefix constantly — a retried tool, a re-planned
 * step, a fan-out of sub-agents that all start from the same system prompt and
 * the same question. When the wire messages and the tool menu are byte-identical
 * the provider's answer is the only thing that is not free, so it is served
 * from memory and the call never leaves the process. Nothing is inferred:
 * "similar" is not a hit, only "identical" is.
 */

import type { AgentPlugin, HookContext, HookMap } from "../types.js";
import type { AIMessage, Message, ToolInterface } from "../../types.js";

export type ResponseCacheConfig = {
  /** How long an entry stays servable. Default 5 minutes. */
  ttlMs?: number;
  /** Entry ceiling; the least recently used entry is dropped past it. Default 100. */
  maxEntries?: number;
  /**
   * Replace the default key. Returning `undefined` means "do not cache this
   * call" — the honest way to exclude anything non-deterministic (a prompt
   * carrying `now()`, a per-user tool result) without turning the plugin off.
   */
  keyOf?: (input: HookMap["preModelCall"]["input"]) => string | undefined;
  /**
   * `run` gives every `invoke()` a fresh cache (safe by default: nothing
   * outlives the conversation it came from); `agent` shares one cache across
   * every run on this agent instance, which is where the real savings are and
   * also where a stale or cross-tenant answer becomes possible. Default `run`.
   */
  scope?: "run" | "agent";
  name?: string;
  priority?: number;
};

type Entry = { message: AIMessage; expiresAt: number };

const STORE_KEY = "__responseCache";
const PENDING_KEY = "__responseCachePending";

/**
 * Deep copy on both edges of the cache. The transcript owns the assistant turn
 * it is handed and the loop mutates it in place (provider fields are
 * re-attached, `tool_calls` get consumed and rewritten), so a cache that handed
 * out its own object would watch its entries be edited by the run that read
 * them — and the next hit would serve a message from a different conversation.
 * `tool_calls` entries are copied element-wise for the same reason: a shallow
 * array copy still shares each call object, and its `id` is the thing that
 * pairs a tool result to a request.
 */
function cloneMessage(message: AIMessage): AIMessage {
  try {
    return JSON.parse(JSON.stringify(message)) as AIMessage;
  } catch {
    // A provider message carrying something JSON cannot express (a stream
    // handle, a class instance) still gets its identity-bearing fields copied.
    return {
      ...message,
      tool_calls: Array.isArray(message.tool_calls)
        ? message.tool_calls.map((call: unknown) =>
            call && typeof call === "object" ? { ...(call as object) } : call,
          )
        : message.tool_calls,
    } as AIMessage;
  }
}

/** Every field the SDK's usage extractor will look at, at either nesting level. */
const USAGE_FIELDS = ["usage", "usage_metadata", "usageMetadata", "token_usage", "tokenUsage"];

/**
 * A replayed answer costs nothing, so it must not be billed. The cached message
 * still carries the original call's token counts, and the loop reads them off
 * whatever assistant turn it receives — leaving them in would charge the run
 * for a request that never left the process and would walk `budgetGuard` toward
 * a ceiling on traffic that does not exist.
 */
function withoutUsage(message: AIMessage): AIMessage {
  const stripped = { ...message } as Record<string, unknown>;
  for (const field of USAGE_FIELDS) delete stripped[field];
  const metadata = stripped.response_metadata;
  if (metadata && typeof metadata === "object") {
    const copy = { ...(metadata as Record<string, unknown>) };
    for (const field of USAGE_FIELDS) delete copy[field];
    stripped.response_metadata = copy;
  }
  return stripped as AIMessage;
}

/**
 * The key is the serialization itself, not a hash of it. A 32-bit digest of a
 * whole transcript collides often enough to matter, and the failure mode of a
 * collision here is serving one conversation's answer into another — `maxEntries`
 * already bounds what this costs.
 */
function defaultKey(messages: Message[], tools: ToolInterface[]): string {
  return JSON.stringify({
    m: messages.map((message) => [
      message.role,
      message.content ?? null,
      message.tool_calls ?? null,
      message.tool_call_id ?? null,
    ]),
    // Names only, and sorted: the menu changes what the model may answer, but
    // the order it was bound in does not.
    t: tools.map((tool) => tool?.name).filter(Boolean).sort(),
  });
}

export function responseCache(config: ResponseCacheConfig = {}): AgentPlugin {
  const ttlMs = config.ttlMs ?? 5 * 60_000;
  const maxEntries = config.maxEntries ?? 100;
  const agentCache = new Map<string, Entry>();

  const cacheFor = (ctx: HookContext): Map<string, Entry> => {
    if ((config.scope ?? "run") === "agent") return agentCache;
    return ((ctx.store[STORE_KEY] ??= new Map<string, Entry>()) as Map<string, Entry>);
  };

  /**
   * `preModelCall` knows the key, `postModelCall` has to write under it, and
   * nothing is threaded between them. Parking it per iteration rather than in a
   * single slot keeps the pairing exact even when a `retry` re-enters the model
   * call, and leaves nothing behind for the next iteration to misread.
   */
  const pendingFor = (ctx: HookContext): Map<number, string> =>
    ((ctx.store[PENDING_KEY] ??= new Map<number, string>()) as Map<number, string>);

  return {
    name: config.name ?? "response-cache",
    /**
     * Deliberately late (default is 100). Redaction and guardrail plugins
     * rewrite the messages this key is computed from, so running before them
     * would key the same conversation two different ways — a cache that never
     * hits once a rewrite is in play, and worse, one that could store a
     * pre-redaction message and replay it after.
     */
    priority: config.priority ?? 200,
    // A convenience: a broken cache must degrade to a normal provider call.
    failureMode: "open",

    hooks: {
      preModelCall: (input, ctx) => {
        const key = config.keyOf ? config.keyOf(input) : defaultKey(input.messages, input.tools);
        if (key === undefined) return undefined;

        const cache = cacheFor(ctx);
        const entry = cache.get(key);
        if (!entry || entry.expiresAt <= Date.now()) {
          if (entry) cache.delete(key);
          pendingFor(ctx).set(input.iteration, key);
          return undefined;
        }

        // Re-insert to move the entry to the young end of the Map's insertion
        // order, which is what makes the eviction below LRU rather than FIFO.
        cache.delete(key);
        cache.set(key, entry);
        ctx.emit({ type: "metadata", responseCache: { hit: true, iteration: input.iteration } } as never);
        return { shortCircuit: cloneMessage(entry.message) };
      },

      postModelCall: ({ message, iteration, shortCircuited }, ctx) => {
        const pending = pendingFor(ctx);
        const key = pending.get(iteration);
        pending.delete(iteration);
        if (key === undefined) return undefined;
        // A short-circuited turn is what this plugin (or another one) just
        // served: rewriting it would extend the TTL of an entry that was never
        // re-validated, so an answer cached once could be served forever.
        if (shortCircuited) return undefined;

        const cache = cacheFor(ctx);
        cache.set(key, { message: withoutUsage(cloneMessage(message)), expiresAt: Date.now() + ttlMs });
        while (cache.size > maxEntries) {
          const oldest = cache.keys().next();
          if (oldest.done) break;
          cache.delete(oldest.value);
        }
        return undefined;
      },
    },
  };
}
