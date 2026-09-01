/**
 * OTLP/HTTP export of a finished run, driven by a hook instead of by a sink.
 *
 * The SDK already ships `otlpSink(endpoint, headers)`, and when observability
 * is configured on its own that remains the right tool — it is wired straight
 * into `finalizeTraceSession` and needs no plugin at all. This plugin exists
 * for the product that wants one array: `plugins: [cognipeerGuardrail(),
 * otelTracing({ endpoint })]`, with tracing and policy declared side by side
 * rather than in two unrelated config blocks.
 *
 * It does NOT re-implement the sink. The conversion is `traceSessionToOtlp`,
 * the same function `otlpSink` uses, applied to the same session object — so a
 * span tree exported through this plugin and one exported through the sink are
 * the same spans. What the plugin adds is placement: it runs on the hook chain,
 * next to the guardrails, and can therefore be turned on and off with them.
 *
 * Because it reads the SDK's trace session, it needs `tracing: { enabled: true }`
 * on the agent. Without it there is no session to export and the plugin says so
 * out loud (a `metadata` event plus a warning) rather than doing nothing: a
 * silent no-op in an observability tool is the failure that costs the most,
 * because it is discovered days later when someone goes looking for the traces.
 */

import type { AgentPlugin } from "../types.js";
import type {
  SmartState,
  TraceSessionFile,
  TraceSessionRuntime,
  TraceSessionStatus,
} from "../../types.js";
import { traceSessionToOtlp } from "../../utils/tracing.js";

export type OtelTracingConfig = {
  /** OTLP/HTTP JSON traces endpoint, e.g. `https://collector.example.com/v1/traces`. */
  endpoint: string;
  /** Auth and tenancy headers for the collector. */
  headers?: Record<string, string>;
  /** `service.name` on the exported resource. Defaults to the agent's name. */
  serviceName?: string;
  /** Plugin name, when exporting to more than one collector at once. */
  name?: string;
};

/**
 * A run can end in states the trace-session vocabulary has no word for.
 * `paused` is genuinely still open — the run continues on resume — so it stays
 * `in_progress`; `cancelled` produced a real but incomplete span tree, which is
 * exactly what `partial` means.
 */
function toSessionStatus(status: "success" | "error" | "paused" | "cancelled"): TraceSessionStatus {
  if (status === "success") return "success";
  if (status === "error") return "error";
  return status === "paused" ? "in_progress" : "partial";
}

export function otelTracing(config: OtelTracingConfig): AgentPlugin {
  const endpoint = config.endpoint?.trim();
  if (!endpoint) {
    // A collector-less exporter is a configuration bug, and finding out at the
    // end of the first run is too late to be useful.
    throw new Error("[agent-sdk] otelTracing requires a non-empty `endpoint`.");
  }

  return {
    name: config.name ?? "otel-tracing",
    // Registers only the `sessionEnd` observer, and observers run concurrently,
    // so this number orders nothing at runtime. It is set above checkpointing
    // (900) to record intent: this plugin is the last thing interested in the
    // run, and it never sits on a gate chain where a high number would cost.
    priority: 950,
    // Observability. A dropped export is a reporting gap, never a safety hole.
    failureMode: "open",

    hooks: {
      sessionEnd: async ({ status, durationMs, error }, ctx) => {
        const state = ctx.state as SmartState;
        const session = state.ctx?.__traceSession as TraceSessionRuntime | undefined;

        if (!session) {
          const message =
            "otelTracing exported nothing: the agent has no trace session. " +
            "Enable the SDK's tracing runtime with `tracing: { enabled: true }` — " +
            "the plugin exports the session the runtime records, it does not record one itself.";
          ctx.logger.warn(message);
          ctx.emit({ type: "metadata", otelTracing: { exported: false, reason: message } } as never);
          return;
        }

        const endedAtMs = Date.now();
        const startedAtIso = new Date(session.startedAt).toISOString();
        const errors = error
          ? [...session.errors, { eventId: "session", message: error.message, stack: error.stack, type: "session" }]
          : session.errors;

        const payload: TraceSessionFile = {
          sessionId: session.sessionId,
          traceId: session.traceId,
          rootSpanId: session.rootSpanId,
          threadId: session.threadId,
          startedAt: startedAtIso,
          endedAt: new Date(endedAtMs).toISOString(),
          durationMs: durationMs ?? endedAtMs - session.startedAt,
          // `service.name` is read off `agent.name` inside the conversion, so
          // the override is applied here rather than by editing spans after.
          agent: {
            ...(session.agentInfo ?? {}),
            name: config.serviceName ?? session.agentInfo?.name ?? session.configAgentName ?? ctx.agentName,
          },
          metadata: session.configMetadata,
          // Carried only to satisfy the type: `traceSessionToOtlp` reads the
          // events, summary and identifiers, never the sink snapshot.
          config: { enabled: true, logData: session.resolvedConfig.logData, sink: { type: "otlp", endpoint } },
          summary: session.summary,
          events: session.events,
          status: toSessionStatus(status),
          errors,
        };

        try {
          const fetchFn = typeof globalThis.fetch === "function" ? globalThis.fetch.bind(globalThis) : undefined;
          if (!fetchFn) {
            ctx.logger.warn("otelTracing needs fetch to be available in this runtime; export skipped.");
            return;
          }
          const response = await fetchFn(endpoint, {
            method: "POST",
            headers: { "content-type": "application/json", ...(config.headers ?? {}) },
            body: JSON.stringify(traceSessionToOtlp(payload)),
            // The run is over, but a host that cancelled it should not be made
            // to wait on a collector that is refusing to answer.
            signal: ctx.signal,
          });
          if (!response.ok) {
            ctx.logger.warn(`otelTracing export returned HTTP ${response.status}.`);
            return;
          }
          ctx.emit({
            type: "metadata",
            otelTracing: { exported: true, endpoint, spans: session.events.length + 1 },
          } as never);
        } catch (err) {
          // Swallowed: a collector outage must never surface as an agent error.
          ctx.logger.warn("otelTracing export failed:", err instanceof Error ? err.message : err);
        }
      },
    },
  };
}
