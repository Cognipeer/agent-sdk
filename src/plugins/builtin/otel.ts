/**
 * OTLP export of a run to a collector, declared next to the other plugins.
 *
 * `plugins: [cognipeerGuardrail(), otelTracing({ endpoint })]` keeps tracing and
 * policy in one array instead of two unrelated config blocks. The plugin does
 * not build or send anything itself: it contributes an exporter
 * (`AgentPlugin.traceExporters`) and the SDK runs it inside
 * `finalizeTraceSession`, the same path the `otlpSink` uses. That is what makes
 * the output identical to the sink's: the SDK knows which leg ends the run (the
 * root span goes out once, with that leg), the plugin never has to.
 *
 * The `sessionEnd` observer only reports. It reads what the exporter did for
 * this run and surfaces it (a `metadata` event, a warning on failure). It also
 * says so out loud when there is no trace session at all: a silent no-op in an
 * observability tool is discovered days later, when someone goes looking for
 * the traces, so `tracing: { enabled: true }` is called out by name.
 *
 * A sub-agent inherits this plugin but records into its parent's session, which
 * is still being written. Only a root session finalizes and exports, so the
 * observer returns early for a child run.
 */

import type { AgentPlugin } from "../types.js";
import type { SmartState, TraceSessionRuntime } from "../../types.js";
import { createOtlpExporter } from "../../utils/otlp/exporter.js";
import type { OtlpExportOptions } from "../../utils/otlp/types.js";
import { isSubagentTraceScope } from "../../utils/tracing.js";

export type OtelTracingConfig = OtlpExportOptions & {
  /**
   * Plugin name, when exporting to more than one collector at once. Defaults to
   * `otel-tracing`.
   */
  name?: string;
};

export function otelTracing(config: OtelTracingConfig = {}): AgentPlugin {
  // An endpoint that is given must say something. Leaving it out is allowed: the
  // exporter then reads OTEL_EXPORTER_OTLP_* from the environment, and throws
  // when those name no endpoint either.
  if (config.endpoint !== undefined && !config.endpoint.trim()) {
    // A collector-less exporter is a configuration bug, and finding out at the
    // end of the first run is too late to be useful.
    throw new Error("[agent-sdk] otelTracing requires a non-empty `endpoint`.");
  }
  const name = config.name ?? "otel-tracing";
  let exporter;
  try {
    exporter = createOtlpExporter({ ...config, endpoint: config.endpoint?.trim(), name });
  } catch {
    throw new Error(
      "[agent-sdk] otelTracing requires a non-empty `endpoint` (or OTEL_EXPORTER_OTLP_ENDPOINT / OTEL_EXPORTER_OTLP_TRACES_ENDPOINT in the environment).",
    );
  }

  return {
    name,
    // Registers only the `sessionEnd` observer, and observers run concurrently,
    // so this number orders nothing at runtime. It is set above checkpointing
    // (900) to record intent: this plugin is the last thing interested in the
    // run, and it never sits on a gate chain where a high number would cost.
    priority: 950,
    // Observability. A dropped export is a reporting gap, never a safety hole.
    failureMode: "open",
    traceExporters: [exporter],

    hooks: {
      sessionEnd: async (_event, ctx) => {
        const state = ctx.state as SmartState;
        const session = state.ctx?.__traceSession as TraceSessionRuntime | undefined;

        if (isSubagentTraceScope(session)) return;

        if (!session) {
          const message =
            "otelTracing exported nothing: the agent has no trace session. " +
            "Enable the SDK's tracing runtime with `tracing: { enabled: true }` — " +
            "the plugin exports the session the runtime records, it does not record one itself.";
          ctx.logger.warn(message);
          ctx.emit({ type: "metadata", otelTracing: { exported: false, reason: message } } as never);
          return;
        }

        // The export already ran, in finalizeTraceSession; this is its latest report.
        const reports = (session.exportReports ?? []).filter((report) => !report.sink && report.exporter === name);
        const report = reports[reports.length - 1];
        if (!report) return;
        const { result } = report;

        if (!result.ok) {
          // Swallowed: a collector outage must never surface as an agent error.
          ctx.logger.warn(`otelTracing export failed: ${result.error ?? "unknown error"}`);
          return;
        }
        if (result.skipped) {
          ctx.emit({ type: "metadata", otelTracing: { exported: false, reason: result.reason ?? "nothing to export" } } as never);
          return;
        }
        ctx.emit({
          type: "metadata",
          otelTracing: {
            exported: true,
            endpoint: report.endpoint,
            spans: result.spans,
            terminal: report.terminal,
            // A 200 that refused some spans: the collector's count and message.
            ...(result.partialSuccess ? { rejectedSpans: result.partialSuccess.rejectedSpans, ...(result.partialSuccess.message ? { rejectionMessage: result.partialSuccess.message } : {}) } : {}),
          },
        } as never);
      },
    },
  };
}
