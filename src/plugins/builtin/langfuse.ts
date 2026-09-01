/**
 * Langfuse export, driven by hooks instead of by a tracing sink.
 *
 * The SDK already has a tracing runtime (`tracing: { enabled: true }` plus a
 * sink — file / http / otlp / cognipeer / custom) and that remains the richer
 * path: it carries prompts, tool payloads, response formats and the full span
 * tree. This plugin exists for two reasons the sink cannot serve.
 *
 *   1. Packaging. A product that already ships its guardrails as plugins can
 *      hand its users one array — `plugins: [cognipeerGuardrail(), langfuseTracing()]`
 *      — instead of a plugin array plus a separate `tracing` block.
 *   2. Reach. A sink only ever sees what the SDK core records. A plugin sits on
 *      the hook chain, so it also sees things that never become trace events:
 *      a tool call another plugin denied at `preToolUse` (recorded here as a
 *      span that opens and never closes cleanly), a model turn a guardrail
 *      rejected, a short-circuited call that never reached a provider.
 *
 * Content is deliberately NOT exported. Prompts, tool arguments and tool
 * results stay inside the process: shipping them to a third party by default
 * would be a surprise, and the SDK's own tracing runtime already has `logData`
 * for anyone who wants it. What goes out is shape and cost — model, latency,
 * token usage, tool names, outcomes. `buildPayload` is the seam for a caller
 * who wants more.
 *
 * WIRE CONTRACT — UNVERIFIED. The endpoint and auth scheme below
 * (`POST {baseUrl}/api/public/ingestion`, HTTP Basic `publicKey:secretKey`, a
 * `{ batch: [...] }` body of typed events) are what this module assumes, and
 * the per-event body shapes in `defaultBuildPayload` are an assumption on top
 * of that assumption — they were NOT verified against Langfuse documentation
 * while writing this. Everything about the body is therefore behind the
 * overridable `buildPayload(events, ctx)`: if Langfuse's schema differs, pass
 * your own and nothing else in this file has to move.
 */

import type { AgentPlugin, HookContext, PluginLogger } from "../types.js";
import type { AIMessage, SmartState } from "../../types.js";

const DEFAULT_BASE_URL = "https://cloud.langfuse.com";
const INGESTION_PATH = "/api/public/ingestion";

/**
 * A neutral, in-house description of one thing worth reporting. Hooks produce
 * these; only `buildPayload` knows what Langfuse calls them. Keeping the two
 * apart is what makes the unverified schema a single-function problem.
 */
export type LangfuseEventKind = "trace-start" | "trace-end" | "generation" | "span-start" | "span-end";

export type LangfuseEvent = {
  /** Idempotency id for this ingestion envelope — unique per event, never reused. */
  id: string;
  kind: LangfuseEventKind;
  /** ISO time the event was produced (not the time the work happened). */
  timestamp: string;
  /** The run's Langfuse trace id. Every event of one run shares it. */
  traceId: string;
  /** Observation id — set for generations and spans, absent for the trace itself. */
  observationId?: string;
  name: string;
  startTime?: string;
  endTime?: string;
  model?: string;
  /** Token counts, already normalized across provider spellings. */
  usage?: { input?: number; output?: number; total?: number };
  /** Structured outcome. Never message content — see the module header. */
  output?: unknown;
  level?: "DEFAULT" | "WARNING" | "ERROR";
  statusMessage?: string;
  metadata?: Record<string, unknown>;
};

/** The static, per-plugin half of a payload; the varying half is the events. */
export type LangfuseBuildContext = {
  baseUrl: string;
  publicKey: string;
  release?: string;
  userId?: string;
  sessionId?: string;
  tags?: string[];
};

export type LangfuseTracingConfig = {
  /** Defaults to `LANGFUSE_PUBLIC_KEY`. */
  publicKey?: string;
  /** Defaults to `LANGFUSE_SECRET_KEY`. */
  secretKey?: string;
  /** Defaults to `LANGFUSE_BASE_URL`, then Langfuse Cloud. Point at a self-hosted instance here. */
  baseUrl?: string;
  /** Build/version tag attached to the trace. */
  release?: string;
  /** End-user attribution for the trace. */
  userId?: string;
  /** Groups several runs into one Langfuse session (a chat thread, typically). */
  sessionId?: string;
  tags?: string[];
  /** Flush once this many events are buffered. Default 20. */
  flushAt?: number;
  /** Flush a partially-filled buffer after this long. Default 5000ms. 0 disables the timer. */
  flushIntervalMs?: number;
  /** Escape hatch for the whole wire body — see the UNVERIFIED note in the module header. */
  buildPayload?: (events: LangfuseEvent[], ctx: LangfuseBuildContext) => unknown;
  /** Plugin name, when exporting to more than one Langfuse project at once. */
  name?: string;
};

// ─── Default wire mapping (the unverified part) ──────────────────────────────

const WIRE_TYPE: Record<LangfuseEventKind, string> = {
  // A trace is assumed to upsert by id, so the closing event reuses the create
  // type rather than inventing an update type that may not exist.
  "trace-start": "trace-create",
  "trace-end": "trace-create",
  generation: "generation-create",
  "span-start": "span-create",
  "span-end": "span-update",
};

function defaultBody(event: LangfuseEvent, ctx: LangfuseBuildContext): Record<string, unknown> {
  if (event.kind === "trace-start" || event.kind === "trace-end") {
    return {
      id: event.traceId,
      name: event.name,
      timestamp: event.timestamp,
      userId: ctx.userId,
      sessionId: ctx.sessionId,
      release: ctx.release,
      tags: ctx.tags,
      output: event.output,
      metadata: event.metadata,
    };
  }
  if (event.kind === "generation") {
    return {
      id: event.observationId,
      traceId: event.traceId,
      name: event.name,
      startTime: event.startTime,
      endTime: event.endTime,
      model: event.model,
      usage: event.usage ? { ...event.usage, unit: "TOKENS" } : undefined,
      level: event.level,
      statusMessage: event.statusMessage,
      metadata: event.metadata,
    };
  }
  return {
    id: event.observationId,
    traceId: event.traceId,
    name: event.name,
    startTime: event.startTime,
    endTime: event.endTime,
    output: event.output,
    level: event.level,
    statusMessage: event.statusMessage,
    metadata: event.metadata,
  };
}

/** The assumed `{ batch: [...] }` ingestion body. Replaceable via `buildPayload`. */
export function defaultBuildPayload(events: LangfuseEvent[], ctx: LangfuseBuildContext): unknown {
  return {
    batch: events.map((event) => ({
      id: event.id,
      type: WIRE_TYPE[event.kind],
      timestamp: event.timestamp,
      body: defaultBody(event, ctx),
    })),
  };
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

let idCounter = 0;

/** Unique enough for an idempotency key; deliberately not a crypto import. */
function newId(prefix: string): string {
  idCounter += 1;
  return `${prefix}_${Date.now().toString(36)}${idCounter.toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Basic auth without a Node import, so the plugin also loads in a worker
 * runtime where `Buffer` does not exist but `btoa` does.
 */
function basicAuth(publicKey: string, secretKey: string): string {
  const raw = `${publicKey}:${secretKey}`;
  const runtime = globalThis as {
    Buffer?: { from(input: string, encoding: string): { toString(encoding: string): string } };
    btoa?: (input: string) => string;
  };
  if (typeof runtime.Buffer?.from === "function") {
    return runtime.Buffer.from(raw, "utf8").toString("base64");
  }
  if (typeof runtime.btoa === "function") return runtime.btoa(raw);
  throw new Error("[agent-sdk] langfuseTracing needs Buffer or btoa to encode Basic auth.");
}

/** Providers disagree on the spelling; the Langfuse body wants one shape. */
function normalizeUsage(raw: unknown): LangfuseEvent["usage"] | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const usage = raw as Record<string, unknown>;
  const num = (...keys: string[]): number | undefined => {
    for (const key of keys) {
      const value = Number(usage[key]);
      if (Number.isFinite(value)) return value;
    }
    return undefined;
  };
  const input = num("prompt_tokens", "promptTokens", "input_tokens", "inputTokens");
  const output = num("completion_tokens", "completionTokens", "output_tokens", "outputTokens");
  const total = num("total_tokens", "totalTokens");
  if (input === undefined && output === undefined && total === undefined) return undefined;
  return { input, output, total: total ?? (input ?? 0) + (output ?? 0) };
}

/**
 * `postModelCall` runs BEFORE the loop extracts usage into `state.usage`, so
 * the freshest ledger entry belongs to the previous turn. The message's own
 * provider metadata is therefore consulted first.
 */
function resolveModelName(state: SmartState, message: AIMessage | undefined): string | undefined {
  const candidates = [
    (message as Record<string, unknown> | undefined)?.model,
    // The model that actually SERVED the call. `fromNativeProvider` writes it
    // as `model_name` (never `model`), so without this candidate the name
    // resolves from the agent-level fallbacks — i.e. the model the caller
    // REQUESTED. The two agree until a gateway reroutes (a fallback tier, an
    // alias, capacity spillover), and then the dashboard attributes cost and
    // latency to a model that never answered, with no symptom.
    ((message as Record<string, unknown> | undefined)?.response_metadata as Record<string, unknown> | undefined)?.model_name,
    ((message as Record<string, unknown> | undefined)?.response_metadata as Record<string, unknown> | undefined)?.model,
    ((message as Record<string, unknown> | undefined)?.metadata as Record<string, unknown> | undefined)?.model,
    state.usage?.perRequest?.[state.usage.perRequest.length - 1]?.modelName,
    (state.agent?.model as Record<string, unknown> | undefined)?.modelName,
    (state.agent?.model as Record<string, unknown> | undefined)?.model,
  ];
  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.trim().length > 0) return candidate.trim();
  }
  return undefined;
}

function tokenTotals(state: SmartState): { input: number; output: number; total: number } {
  const totals = { input: 0, output: 0, total: 0 };
  for (const entry of Object.values(state.usage?.totals ?? {})) {
    totals.input += Number(entry?.input) || 0;
    totals.output += Number(entry?.output) || 0;
    totals.total += Number(entry?.total) || 0;
  }
  return totals;
}

type OpenSpan = { observationId: string; toolName: string; startTime: string };

/** Per-run, per-plugin scratch: tool spans awaiting their closing half. */
function openSpans(store: Record<string, unknown>): Map<string, OpenSpan> {
  return (store.__langfuseSpans ??= new Map<string, OpenSpan>()) as Map<string, OpenSpan>;
}

const consoleLogger: PluginLogger = {
  debug: () => {},
  warn: (...args: unknown[]) => console.warn("[agent-sdk:langfuse]", ...args),
  error: (...args: unknown[]) => console.error("[agent-sdk:langfuse]", ...args),
};

// ─── The plugin ──────────────────────────────────────────────────────────────

export function langfuseTracing(config: LangfuseTracingConfig = {}): AgentPlugin {
  const publicKey = config.publicKey ?? process.env.LANGFUSE_PUBLIC_KEY;
  const secretKey = config.secretKey ?? process.env.LANGFUSE_SECRET_KEY;
  const baseUrl = (config.baseUrl ?? process.env.LANGFUSE_BASE_URL ?? DEFAULT_BASE_URL).replace(/\/+$/, "");

  // Missing credentials are a configuration bug, not an outage: an analytics
  // plugin that silently exported nothing for a week is worse than one that
  // refuses to construct. Runtime failures, by contrast, are always swallowed.
  if (!publicKey || !secretKey) {
    throw new Error(
      "[agent-sdk] langfuseTracing requires publicKey and secretKey " +
        "(pass them, or set LANGFUSE_PUBLIC_KEY / LANGFUSE_SECRET_KEY).",
    );
  }

  const url = `${baseUrl}${INGESTION_PATH}`;
  const flushAt = Math.max(1, config.flushAt ?? 20);
  const flushIntervalMs = config.flushIntervalMs ?? 5_000;
  const buildPayload = config.buildPayload ?? defaultBuildPayload;
  const buildCtx: LangfuseBuildContext = {
    baseUrl,
    publicKey,
    release: config.release,
    userId: config.userId,
    sessionId: config.sessionId,
    tags: config.tags,
  };
  // Authorization is computed once, at construction — no network, no I/O.
  const authorization = `Basic ${basicAuth(publicKey, secretKey)}`;

  /**
   * A hard ceiling on the buffer. During a sustained Langfuse outage the
   * oldest events are dropped rather than accumulated: observability must
   * never be the reason a long-running agent process runs out of memory.
   */
  const maxBuffered = Math.max(flushAt * 10, 1000);

  const buffer: LangfuseEvent[] = [];
  let timer: ReturnType<typeof setTimeout> | undefined;
  let logger: PluginLogger = consoleLogger;

  const clearTimer = () => {
    if (timer !== undefined) {
      clearTimeout(timer);
      timer = undefined;
    }
  };

  /** Resolves, always. Every failure path here is a logged no-op by design. */
  const flush = async (): Promise<void> => {
    clearTimer();
    if (buffer.length === 0) return;
    // Drain before awaiting, so events produced during the POST land in the
    // next batch instead of being sent twice or lost on failure.
    const batch = buffer.splice(0, buffer.length);

    const fetchFn = typeof globalThis.fetch === "function" ? globalThis.fetch.bind(globalThis) : undefined;
    if (!fetchFn) {
      logger.warn("no fetch in this runtime; dropped", batch.length, "events");
      return;
    }

    try {
      const response = await fetchFn(url, {
        method: "POST",
        headers: { "content-type": "application/json", Authorization: authorization },
        body: JSON.stringify(buildPayload(batch, buildCtx)),
      });
      if (!response.ok) {
        let text = "";
        try {
          text = await response.text();
        } catch {
          /* body is optional context */
        }
        logger.warn(`ingestion returned HTTP ${response.status}${text ? ` - ${text.slice(0, 200)}` : ""}`);
      }
    } catch (err) {
      // Swallowed on purpose: an analytics outage must never stop an agent, and
      // the batch is already drained so it cannot pile up behind the failure.
      logger.warn("ingestion failed, dropped", batch.length, "events:", err instanceof Error ? err.message : err);
    }
  };

  const scheduleFlush = () => {
    if (timer !== undefined || flushIntervalMs <= 0) return;
    timer = setTimeout(() => {
      timer = undefined;
      void flush();
    }, flushIntervalMs);
    // A pending analytics flush must not hold a CLI process open.
    (timer as unknown as { unref?: () => void }).unref?.();
  };

  const enqueue = (event: LangfuseEvent, ctx: HookContext) => {
    logger = ctx.logger;
    buffer.push(event);
    if (buffer.length > maxBuffered) buffer.splice(0, buffer.length - maxBuffered);
    // Fire-and-forget: the hook chain is on a model turn's critical path, and
    // only `sessionEnd` — where nothing is waiting on the agent — awaits.
    if (buffer.length >= flushAt) void flush();
    else scheduleFlush();
  };

  /**
   * The run id doubles as the Langfuse trace id: it is stable across a
   * pause/resume, available on every hook, and lets a reader jump between the
   * SDK's own trace and Langfuse without a lookup table.
   */
  const traceIdOf = (ctx: HookContext) => ctx.runId;

  /** Correlation back to the SDK's own trace session, when tracing is on too. */
  const sdkTraceId = (ctx: HookContext): string | undefined =>
    (ctx.state as { ctx?: { __traceSession?: { traceId?: string } } }).ctx?.__traceSession?.traceId;

  return {
    name: config.name ?? "langfuse-tracing",
    // Same reasoning as auditLog (0) and sessionMetrics (1): these hooks are
    // gates, a deny ends the chain, and an observability record that only saw
    // the traffic nothing objected to describes a different agent than the one
    // that ran. Ahead of budgetGuard (5) and every policy plugin above it.
    priority: 2,
    // Observability. A missing span is a reporting gap, never a safety hole.
    failureMode: "open",
    // Records tool spans but never returns a decision, so the tool batch it
    // watches stays in the parallel fan-out.
    mayRequireApproval: false,

    setup: (ctx) => {
      logger = ctx.logger;
      // Whatever is still buffered when the agent goes away is worth one last
      // POST; after this the plugin holds no timer and no pending work.
      return async () => {
        await flush();
      };
    },

    hooks: {
      sessionStart: ({ messages, resumed }, ctx) => {
        const now = new Date().toISOString();
        enqueue(
          {
            id: newId("evt"),
            kind: "trace-start",
            timestamp: now,
            traceId: traceIdOf(ctx),
            name: ctx.agentName ?? "agent",
            metadata: {
              runId: ctx.runId,
              resumed,
              depth: ctx.depth,
              messageCount: messages.length,
              sdkTraceId: sdkTraceId(ctx),
            },
          },
          ctx,
        );
        return undefined;
      },

      postModelCall: ({ message, usage, durationMs, iteration, shortCircuited }, ctx) => {
        const endedAt = Date.now();
        const latency = Math.max(0, Number(durationMs) || 0);
        enqueue(
          {
            id: newId("evt"),
            kind: "generation",
            observationId: newId("gen"),
            timestamp: new Date(endedAt).toISOString(),
            traceId: traceIdOf(ctx),
            name: `model-call#${iteration}`,
            startTime: new Date(endedAt - latency).toISOString(),
            endTime: new Date(endedAt).toISOString(),
            model: resolveModelName(ctx.state as SmartState, message),
            usage: normalizeUsage(usage),
            metadata: {
              iteration,
              latencyMs: latency,
              // A short-circuited turn never reached a provider; without this
              // flag its zero-token generation reads as a broken export.
              shortCircuited,
              depth: ctx.depth,
            },
          },
          ctx,
        );
        return undefined;
      },

      preToolUse: ({ toolName, toolCallId }, ctx) => {
        const startTime = new Date().toISOString();
        const observationId = newId("span");
        openSpans(ctx.store).set(toolCallId, { observationId, toolName, startTime });
        enqueue(
          {
            id: newId("evt"),
            kind: "span-start",
            observationId,
            timestamp: startTime,
            traceId: traceIdOf(ctx),
            name: `tool:${toolName}`,
            startTime,
            metadata: { toolCallId, depth: ctx.depth },
          },
          ctx,
        );
        return undefined;
      },

      postToolUse: ({ toolName, toolCallId, error, durationMs, executionId }, ctx) => {
        const spans = openSpans(ctx.store);
        const open = spans.get(toolCallId);
        spans.delete(toolCallId);
        const endTime = new Date().toISOString();
        enqueue(
          {
            id: newId("evt"),
            kind: "span-end",
            // A `postToolUse` with no matching open span means this leg resumed
            // mid-call; a fresh id still records the outcome rather than losing it.
            observationId: open?.observationId ?? newId("span"),
            timestamp: endTime,
            traceId: traceIdOf(ctx),
            name: `tool:${toolName}`,
            startTime: open?.startTime,
            endTime,
            output: { status: error ? "error" : "success" },
            level: error ? "ERROR" : "DEFAULT",
            statusMessage: error?.message,
            metadata: { toolCallId, executionId, durationMs, depth: ctx.depth },
          },
          ctx,
        );
        return undefined;
      },

      sessionEnd: async ({ status, durationMs, error }, ctx) => {
        const state = ctx.state as SmartState;
        const endTime = new Date().toISOString();

        // Spans still open never reached `postToolUse`: the call was denied at
        // the approval gate or by a policy plugin that ran after this one. That
        // asymmetry is the whole reason to export from a hook rather than a
        // sink, so it gets closed explicitly instead of being left dangling.
        const spans = openSpans(ctx.store);
        for (const [toolCallId, open] of spans) {
          const record = (state.toolHistory ?? []).find((entry) => entry?.tool_call_id === toolCallId);
          enqueue(
            {
              id: newId("evt"),
              kind: "span-end",
              observationId: open.observationId,
              timestamp: endTime,
              traceId: traceIdOf(ctx),
              name: `tool:${open.toolName}`,
              startTime: open.startTime,
              endTime,
              output: { status: record?.status ?? "not_executed" },
              level: "WARNING",
              statusMessage: `Tool call did not execute (${record?.status ?? "denied or abandoned"}).`,
              metadata: { toolCallId, depth: ctx.depth },
            },
            ctx,
          );
        }
        spans.clear();

        const totals = tokenTotals(state);
        enqueue(
          {
            id: newId("evt"),
            kind: "trace-end",
            timestamp: endTime,
            traceId: traceIdOf(ctx),
            name: ctx.agentName ?? "agent",
            output: { status },
            level: status === "error" ? "ERROR" : "DEFAULT",
            statusMessage: error?.message,
            metadata: {
              runId: ctx.runId,
              status,
              durationMs,
              tokens: totals,
              toolCalls: (state.toolHistory ?? []).length,
              sdkTraceId: sdkTraceId(ctx),
            },
          },
          ctx,
        );

        // The one place a flush is awaited: the run is over, so nothing is
        // waiting on the agent, and a process that exits here would otherwise
        // drop the trace it just finished.
        await flush();
      },
    },
  };
}
