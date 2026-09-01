/**
 * Guardrail transport + the plugin that drives it.
 *
 * Layered the way tracing sinks are layered — a transport seam, a generic HTTP
 * implementation, an in-process escape hatch, and thin first-party presets on
 * top (see `cognipeerGuardrail`, `portkeyGuardrail`). What is deliberately NOT
 * copied from tracing is its retry policy: a trace post can afford four
 * attempts at an 8s timeout because nothing waits on it, while a guardrail sits
 * on the critical path of every turn and the same policy would stall an agent
 * for half a minute.
 */

import type { AgentPlugin, HookContext, MaybePromise } from "../types.js";
import type { AIMessage, Message } from "../../types.js";
import { extractMessageText } from "../../utils/content.js";
import type { MediaAttachment } from "../../utils/content.js";

/**
 * `tool` is the ARGUMENTS a model wants to run; `tool_result` is what came
 * back. They are different surfaces with different risks — one is an action
 * about to happen, the other is untrusted content entering the context — and a
 * policy usually wants different rules for each.
 */
export type GuardrailPhaseName = "input" | "output" | "tool" | "tool_result";

export type GuardrailRequest = {
  phase: GuardrailPhaseName;
  content: string;
  /** Tool name for `tool` / `tool_result`, otherwise unset. */
  subject?: string;
  /** The SDK hook this check was raised from, so a preset can map it exactly. */
  hook?: string;
  /** Structured tool arguments, for a service that wants them un-stringified. */
  toolArgs?: unknown;
  /** The tool's return value, for `tool_result`. */
  toolResult?: unknown;
  /**
   * Non-text parts of the turn — images, audio, video, files. A text-only
   * policy sees the caption and nothing else, so a service that moderates
   * media needs these; one that does not simply ignores the field.
   *
   * Inline payloads are DESCRIBED (kind, media type, size) rather than
   * inlined: shipping a base64 image on every check would multiply the cost of
   * the guardrail by the size of the upload. A service that needs the bytes
   * should take a URL, or the caller should override `buildRequest`.
   */
  attachments?: MediaAttachment[];
  metadata?: Record<string, unknown>;
};

export type GuardrailViolation = {
  id?: string;
  type?: string;
  severity?: string;
  detail?: string;
};

export type GuardrailVerdict = {
  action: "allow" | "block" | "mask";
  message?: string;
  /** Required when `action === "mask"`. */
  maskedContent?: string;
  violations?: GuardrailViolation[];
  /** The untouched service response, for tracing and debugging. */
  raw?: unknown;
};

export type GuardrailCallContext = {
  runId: string;
  agentName?: string;
  /** Correlates a guardrail decision with the trace session in the console UI. */
  traceId?: string;
  signal?: AbortSignal;
};

export type GuardrailTransport = {
  name: string;
  /** Verdicts must come back in the same order as `requests`. */
  evaluate(requests: GuardrailRequest[], ctx: GuardrailCallContext): MaybePromise<GuardrailVerdict[]>;
  /**
   * Optional setup-time handshake. When a service can say which phases carry
   * active rules, every other phase skips the network entirely — usually the
   * single biggest latency win available here.
   */
  describe?: () => MaybePromise<{ activePhases?: GuardrailPhaseName[] } | null | undefined>;
  close?: () => MaybePromise<void>;
};

const ALLOW: GuardrailVerdict = { action: "allow" };

// ─── HTTP transport ──────────────────────────────────────────────────────────

export type HttpGuardrailOptions = {
  url: string;
  /** Static headers, or a thunk so a rotating token is read per call. */
  headers?: Record<string, string> | (() => Record<string, string>);
  /** Hard ceiling per attempt. Default 3000ms — this is on the critical path. */
  timeoutMs?: number;
  /** Retries after the first attempt. Default 1. */
  retries?: number;
  /** Send all pending checks in one request. Default true. */
  batch?: boolean;
  /** Override the wire request. Default: `{ items, runId, traceId }`. */
  buildRequest?: (requests: GuardrailRequest[], ctx: GuardrailCallContext) => unknown;
  /** Override response mapping. Default: `normalizeVerdicts`, which is forgiving. */
  mapVerdict?: (response: unknown, requests: GuardrailRequest[]) => GuardrailVerdict[];
  /**
   * Status codes that carry a VERDICT rather than an error. Some services
   * signal the outcome in the status line (e.g. 446 for a block); treating
   * those as transport failures would route a real decision through the
   * failureMode path with the wrong reason attached.
   */
  verdictStatuses?: number[];
  /** Optional GET endpoint for the setup-time handshake. */
  describeUrl?: string;
  name?: string;
};

const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);

class RetryableGuardrailError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RetryableGuardrailError";
  }
}

function resolveHeaders(headers: HttpGuardrailOptions["headers"]): Record<string, string> {
  const base = typeof headers === "function" ? headers() : headers;
  const out: Record<string, string> = { ...(base ?? {}) };
  if (!Object.keys(out).some((key) => key.toLowerCase() === "content-type")) {
    out["content-type"] = "application/json";
  }
  return out;
}

/**
 * Accepts the shapes a guardrail service is likely to return and normalizes
 * them. Being forgiving here is the point: the exact contract can change on the
 * service side without a client release, and a stricter parser would turn a
 * cosmetic field rename into an outage.
 */
export function normalizeVerdicts(response: unknown, requests: GuardrailRequest[]): GuardrailVerdict[] {
  const list = extractVerdictList(response, requests.length);
  return requests.map((_req, index) => normalizeSingleVerdict(list[index]));
}

function extractVerdictList(response: unknown, expected: number): unknown[] {
  if (Array.isArray(response)) return response;
  if (response && typeof response === "object") {
    const obj = response as Record<string, unknown>;
    for (const key of ["results", "items", "verdicts", "checks", "data"]) {
      if (Array.isArray(obj[key])) return obj[key] as unknown[];
    }
    // Single-verdict response applied to a single request.
    if (expected === 1) return [response];
  }
  return new Array(expected).fill(undefined);
}

function normalizeSingleVerdict(raw: unknown): GuardrailVerdict {
  if (!raw || typeof raw !== "object") return ALLOW;
  const obj = raw as Record<string, unknown>;

  const masked =
    pickString(obj, ["maskedContent", "masked_content", "redactedContent", "redacted", "sanitized", "output"]) ??
    undefined;
  const message =
    pickString(obj, ["message", "reason", "detail", "description", "explanation"]) ?? undefined;
  const violations = Array.isArray(obj.violations)
    ? (obj.violations as GuardrailViolation[])
    : Array.isArray(obj.findings)
      ? (obj.findings as GuardrailViolation[])
      : undefined;

  const declared = pickString(obj, ["action", "decision", "verdict", "result", "status"])?.toLowerCase();
  let action: GuardrailVerdict["action"] | undefined;
  if (declared) {
    if (["block", "blocked", "deny", "denied", "reject", "rejected", "fail", "failed"].includes(declared)) action = "block";
    else if (["mask", "masked", "redact", "redacted", "sanitize", "sanitized", "transform"].includes(declared)) action = "mask";
    else if (["allow", "allowed", "pass", "passed", "ok", "success", "clean"].includes(declared)) action = "allow";
  }
  if (!action) {
    // Boolean-shaped services: { blocked: true } / { passed: false } / { flagged: true }
    if (obj.blocked === true || obj.denied === true) action = "block";
    else if (obj.passed === false || obj.ok === false || obj.allowed === false) action = "block";
    else if (obj.flagged === true) action = masked ? "mask" : "block";
    else if (masked) action = "mask";
    else action = "allow";
  }
  // A mask verdict with nothing to substitute cannot be honoured; treating it
  // as allow would silently drop the finding, so it becomes a block.
  if (action === "mask" && !masked) action = "block";

  return { action, message, maskedContent: masked, violations, raw };
}

function pickString(obj: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = obj[key];
    if (typeof value === "string" && value.length > 0) return value;
  }
  return undefined;
}

export function httpGuardrail(options: HttpGuardrailOptions): GuardrailTransport {
  const timeoutMs = options.timeoutMs ?? 3000;
  const retries = Math.max(0, options.retries ?? 1);
  const buildRequest =
    options.buildRequest ??
    ((requests: GuardrailRequest[], ctx: GuardrailCallContext) => ({
      items: requests,
      runId: ctx.runId,
      traceId: ctx.traceId,
      agentName: ctx.agentName,
    }));
  const mapVerdict = options.mapVerdict ?? normalizeVerdicts;

  const postOnce = async (body: unknown, signal?: AbortSignal): Promise<unknown> => {
    const fetchFn = typeof globalThis.fetch === "function" ? globalThis.fetch.bind(globalThis) : undefined;
    if (!fetchFn) throw new Error("Guardrail transport requires fetch to be available in this runtime.");

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    // The run's own cancellation must also tear down an in-flight check.
    const onAbort = () => controller.abort();
    signal?.addEventListener("abort", onAbort, { once: true });

    let response: Response;
    try {
      response = await fetchFn(options.url, {
        method: "POST",
        headers: resolveHeaders(options.headers),
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (err) {
      throw new RetryableGuardrailError(`network error - ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    }

    if (!response.ok && !(options.verdictStatuses ?? []).includes(response.status)) {
      let text = "";
      try {
        text = await response.text();
      } catch {
        /* body is optional context */
      }
      const message = `HTTP ${response.status}${response.statusText ? ` ${response.statusText}` : ""}${
        text ? ` - ${text.slice(0, 200)}` : ""
      }`;
      if (RETRYABLE_STATUS.has(response.status)) throw new RetryableGuardrailError(message);
      throw new Error(message);
    }

    return response.json();
  };

  const post = async (body: unknown, signal?: AbortSignal): Promise<unknown> => {
    let lastError: unknown;
    for (let attempt = 0; attempt <= retries; attempt += 1) {
      try {
        return await postOnce(body, signal);
      } catch (err) {
        lastError = err;
        if (!(err instanceof RetryableGuardrailError) || attempt === retries) throw err;
        // A single short backoff. Anything longer defeats the point of a tight
        // timeout, because the caller is a model turn that is already waiting.
        await new Promise((resolve) => setTimeout(resolve, 150 * (attempt + 1)));
      }
    }
    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  };

  return {
    name: options.name ?? "http",

    async evaluate(requests, ctx) {
      if (requests.length === 0) return [];
      if (options.batch === false) {
        const verdicts: GuardrailVerdict[] = [];
        for (const request of requests) {
          const body = buildRequest([request], ctx);
          verdicts.push(...mapVerdict(await post(body, ctx.signal), [request]));
        }
        return verdicts;
      }
      const body = buildRequest(requests, ctx);
      return mapVerdict(await post(body, ctx.signal), requests);
    },

    describe: options.describeUrl
      ? async () => {
          const fetchFn = typeof globalThis.fetch === "function" ? globalThis.fetch.bind(globalThis) : undefined;
          if (!fetchFn) return null;
          const controller = new AbortController();
          const timer = setTimeout(() => controller.abort(), timeoutMs);
          try {
            const response = await fetchFn(options.describeUrl!, {
              method: "GET",
              headers: resolveHeaders(options.headers),
              signal: controller.signal,
            });
            if (!response.ok) return null;
            const json = (await response.json()) as Record<string, unknown>;
            const phases = json.activePhases ?? json.phases;
            return Array.isArray(phases) ? { activePhases: phases as GuardrailPhaseName[] } : null;
          } catch {
            // A failed handshake is not fatal: we fall back to checking every
            // configured phase, which is the conservative direction.
            return null;
          } finally {
            clearTimeout(timer);
          }
        }
      : undefined,
  };
}

/** In-process evaluation — regex policies, a local model, Presidio, tests. */
export function customGuardrail(
  evaluate: (request: GuardrailRequest, ctx: GuardrailCallContext) => MaybePromise<GuardrailVerdict | void>,
  name = "custom",
): GuardrailTransport {
  return {
    name,
    async evaluate(requests, ctx) {
      const results: GuardrailVerdict[] = [];
      for (const request of requests) {
        results.push((await evaluate(request, ctx)) || ALLOW);
      }
      return results;
    },
  };
}

// ─── The plugin ──────────────────────────────────────────────────────────────

export type GuardrailPluginOptions = {
  name: string;
  transport: GuardrailTransport;
  /** Which surfaces to check. Default: input + output. */
  apply?: GuardrailPhaseName[];
  /**
   * `shadow` evaluates and reports but never blocks or masks. This is how a
   * policy gets rolled out safely: measure what it would have caught first.
   */
  mode?: "enforce" | "shadow";
  /** Block when the service is unreachable. Default true. */
  failClosed?: boolean;
  timeoutMs?: number;
  priority?: number;
  inheritToSubagents?: boolean;
  /** Memoize verdicts per run. Default true. */
  cache?: boolean | { maxEntries?: number };
  /** Extra metadata attached to every request. */
  metadata?: Record<string, unknown>;
};

/** Per-run memo entry. The content is kept so a hash hit can be verified. */
type CachedVerdict = { content: string; attachmentKey: string; verdict: GuardrailVerdict };

/** Cheap, non-cryptographic — this only buckets entries, it never decides one. */
function hashContent(text: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(36);
}

export function createGuardrailPlugin(options: GuardrailPluginOptions): AgentPlugin {
  const applied = new Set<GuardrailPhaseName>(options.apply ?? ["input", "output"]);
  const shadow = options.mode === "shadow";
  const cacheEnabled = options.cache !== false;
  const cacheLimit = typeof options.cache === "object" ? (options.cache.maxEntries ?? 500) : 500;
  /** Phases the service told us carry no rules — skipped without a network call. */
  let activePhases: Set<GuardrailPhaseName> | null = null;

  const check = async (
    request: GuardrailRequest,
    ctx: HookContext,
  ): Promise<GuardrailVerdict | { failed: true; message: string }> => {
    if (!applied.has(request.phase)) return ALLOW;
    if (activePhases && !activePhases.has(request.phase)) return ALLOW;
    // A media-only turn has no text to score but is still a turn a policy may
    // want to refuse, so it is not short-circuited as "empty".
    if (
      (!request.content || request.content.trim().length === 0)
      && !request.attachments?.length
    ) {
      return ALLOW;
    }

    const cache = cacheEnabled
      ? ((ctx.store.__cache ??= new Map<string, CachedVerdict>()) as Map<string, CachedVerdict>)
      : null;
    // Attachments join the key: two uploads under the same caption are two
    // different requests, and sharing one verdict between them would let the
    // second through on the first's approval.
    const attachmentKey =
      request.attachments?.map((a) => `${a.kind}:${a.mediaType ?? ""}:${a.url ?? a.approxBytes ?? ""}`).join(",")
      ?? "";
    const key = cache
      ? `${request.phase}|${request.subject ?? ""}|${hashContent(request.content)}|${hashContent(attachmentKey)}`
      : "";
    // A digest match is only a candidate. The hash is 32-bit and the content is
    // model-controlled, so returning on the key alone would let a collision
    // serve someone else's ALLOW and skip the service entirely.
    const hit = cache?.get(key);
    if (hit && hit.content === request.content && hit.attachmentKey === attachmentKey) return hit.verdict;

    try {
      const [verdict] = await options.transport.evaluate([{ ...request, metadata: { ...options.metadata, ...request.metadata } }], {
        runId: ctx.runId,
        agentName: ctx.agentName,
        // Carrying the run's trace id lets the console line a guardrail
        // decision up with the run's timeline. It is absent for input-phase
        // checks on a smart agent, which run before the first model call
        // creates the session — `runId` above is the join key that always works.
        traceId: ctx.traceId,
        signal: ctx.signal,
      });
      const resolved = verdict ?? ALLOW;

      // A service can answer "this guardrail does not apply here" — a policy
      // scoped to one surface, asked about another. That is a configuration
      // mistake with no symptom: the caller asked for this surface to be
      // guarded and it silently is not. Said once per surface, not per turn.
      if ((resolved.raw as { disabled?: boolean } | undefined)?.disabled === true) {
        const warned = (ctx.store.__disabledWarned ??= new Set<string>()) as Set<string>;
        if (!warned.has(request.phase)) {
          warned.add(request.phase);
          ctx.logger.warn(
            `guardrail reports it is not active for the "${request.phase}" surface; nothing is being enforced there`,
          );
          ctx.emit({
            type: "metadata",
            guardrailInactive: { plugin: options.name, phase: request.phase },
          } as never);
        }
      }

      if (cache) {
        if (cache.size >= cacheLimit) cache.clear();
        cache.set(key, { content: request.content, attachmentKey, verdict: resolved });
      }
      return resolved;
    } catch (err) {
      return { failed: true, message: err instanceof Error ? err.message : String(err) };
    }
  };

  /**
   * A transport failure is re-thrown so the host's `failureMode` decides in one
   * place: fail-closed becomes a deny, fail-open a logged warning.
   */
  const raiseIfFailed = (
    verdict: GuardrailVerdict | { failed: true; message: string },
    ctx: HookContext,
  ): verdict is GuardrailVerdict => {
    if (!("failed" in verdict)) {
      ctx.store.__consecutiveFailures = 0;
      return true;
    }

    // A guardrail service that is DOWN produces one refusal per turn, each
    // identical and each blaming the transport. The count is what separates
    // "one blip" from "everything has been blocked for an hour", and it is the
    // difference between a glance and an investigation.
    const consecutiveFailures = ((ctx.store.__consecutiveFailures as number) ?? 0) + 1;
    ctx.store.__consecutiveFailures = consecutiveFailures;

    ctx.emit({
      type: "metadata",
      guardrailError: {
        plugin: options.name,
        transport: options.transport.name,
        message: verdict.message,
        consecutiveFailures,
        mode: shadow ? "shadow" : "enforce",
        // Says what the failure COSTS, which the message alone does not.
        effect: shadow || options.failClosed === false ? "allowed" : "blocked",
      },
    } as never);
    if (consecutiveFailures === 1) {
      ctx.logger.error(
        `guardrail transport "${options.transport.name}" failed: ${verdict.message}` +
          (shadow || options.failClosed === false ? " (fail-open: turn continues)" : " (fail-closed: turn is blocked)"),
      );
    }

    // Named, so the refusal a caller sees points at the service rather than at
    // an anonymous "hook error".
    throw new Error(`guardrail "${options.transport.name}" unavailable: ${verdict.message}`);
  };

  const report = (verdict: GuardrailVerdict, ctx: HookContext, subject?: string) => {
    ctx.emit({
      type: "metadata",
      guardrail: {
        plugin: options.name,
        action: verdict.action,
        subject,
        message: verdict.message,
        violations: verdict.violations,
        enforced: !shadow,
      },
    } as never);
  };

  const hooks: NonNullable<AgentPlugin["hooks"]> = {
    userPromptSubmit: async ({ text, attachments }, ctx) => {
      const verdict = await check(
        {
          phase: "input",
          content: text,
          hook: "userPromptSubmit",
          attachments: attachments?.length ? attachments : undefined,
        },
        ctx,
      );
      if (!raiseIfFailed(verdict, ctx) || verdict.action === "allow") return undefined;
      report(verdict, ctx);
      if (shadow) return undefined;
      if (verdict.action === "mask" && verdict.maskedContent !== undefined) {
        return { text: verdict.maskedContent };
      }
      return { decision: "deny", reason: verdict.message ?? "Request blocked by guardrail policy." };
    },

    postModelCall: async ({ message }, ctx) => {
      const text = extractMessageText(message as unknown as Message);
      if (!text) return undefined;
      const verdict = await check({ phase: "output", content: text, hook: "postModelCall" }, ctx);
      if (!raiseIfFailed(verdict, ctx) || verdict.action === "allow") return undefined;
      report(verdict, ctx);
      if (shadow) return undefined;
      if (verdict.action === "mask" && verdict.maskedContent !== undefined) {
        // The assistant turn is an object: rewrite its content, keep tool_calls.
        return { message: { ...(message as AIMessage), content: verdict.maskedContent } };
      }
      return { decision: "deny", reason: verdict.message ?? "Response blocked by guardrail policy." };
    },
  };

  // Registering an inert `preToolUse` would still put this plugin on the tool
  // path, where the host has to assume any preToolUse handler might pause.
  if (applied.has("tool")) {
    hooks.preToolUse = async ({ toolName, args }, ctx) => {
      const verdict = await check(
        { phase: "tool", content: safeStringify(args), subject: toolName, hook: "preToolUse", toolArgs: args },
        ctx,
      );
      if (!raiseIfFailed(verdict, ctx) || verdict.action === "allow") return undefined;
      report(verdict, ctx, toolName);
      if (shadow) return undefined;
      if (verdict.action === "mask" && verdict.maskedContent !== undefined) {
        try {
          return { args: JSON.parse(verdict.maskedContent) };
        } catch {
          return { decision: "deny", reason: "Guardrail returned unparseable masked arguments." };
        }
      }
      return { decision: "deny", reason: verdict.message ?? `Tool call blocked by guardrail policy: ${toolName}` };
    };
  }

  // Tool OUTPUT is a separate surface from tool arguments: one is an action
  // about to happen, the other is untrusted content entering the context. A
  // policy usually wants different rules for each, so it is opted into
  // separately.
  if (applied.has("tool_result")) {
    hooks.postToolUse = async ({ toolName, args, output }, ctx) => {
      const verdict = await check(
        {
          phase: "tool_result",
          content: safeStringify(output),
          subject: toolName,
          hook: "postToolUse",
          toolArgs: args,
          toolResult: output,
        },
        ctx,
      );
      if (!raiseIfFailed(verdict, ctx) || verdict.action === "allow") return undefined;
      report(verdict, ctx, toolName);
      if (shadow) return undefined;
      if (verdict.action === "mask" && verdict.maskedContent !== undefined) {
        try {
          return { output: JSON.parse(verdict.maskedContent) };
        } catch {
          // Not JSON: the masked string still beats the raw payload.
          return { output: verdict.maskedContent };
        }
      }
      return {
        decision: "deny",
        reason: verdict.message ?? `Tool output blocked by guardrail policy: ${toolName}`,
      };
    };
  }

  return {
    name: options.name,
    priority: options.priority ?? 20,
    failureMode: options.failClosed === false || shadow ? "open" : "closed",
    timeoutMs: options.timeoutMs ?? 3000,
    inheritToSubagents: options.inheritToSubagents,
    // A verdict is only allow / block / mask, so a tool call never pauses here
    // and the batch it belongs to can stay parallel.
    mayRequireApproval: false,

    setup: async () => {
      if (typeof options.transport.describe === "function") {
        try {
          const described = await options.transport.describe();
          if (described?.activePhases?.length) activePhases = new Set(described.activePhases);
        } catch {
          /* handshake is best-effort; falling back checks every phase */
        }
      }
      return async () => {
        await options.transport.close?.();
      };
    },

    hooks,
  };
}

function safeStringify(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value) ?? "";
  } catch {
    return String(value);
  }
}
