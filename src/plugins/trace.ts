/**
 * Putting hook decisions on the trace timeline.
 *
 * The point of this file is the Console question "where was this run blocked?".
 * A guardrail that denies a turn is invisible in a trace that only records
 * `ai_call` and `tool_call`, so the operator sees a run that simply stopped.
 *
 * Three constraints shape the mapping, all of them properties of the existing
 * tracing runtime rather than preferences:
 *
 *   - No token counts. Session totals are accumulated at record time, so a hook
 *     event echoing the model call it observed would double-count the run.
 *   - No `durationMs` on the event. It is summed into `totalDurationMs`, which
 *     already covers the model call this hook ran inside; the real number is
 *     reported in the section instead.
 *   - Payloads go through `sections` under the `logData` guard, never through
 *     `debug`, which is copied verbatim with no guard and no sanitizer.
 */

import type { PluginTraceRecord } from "./types.js";
import type { TraceSessionRuntime } from "../types.js";
import { recordTraceEvent, sanitizeTracePayload } from "../utils/tracing.js";

/** Hook outcomes raised before a trace session exists are held, not dropped. */
const MAX_PENDING = 32;

export type PluginTraceRecorder = {
  record: (record: PluginTraceRecord) => void;
  /**
   * Write anything still held. Must be called when the run ends: a record
   * buffered before the session existed would otherwise only be flushed by the
   * NEXT record, and a run whose single material outcome was the input
   * guardrail has no next record.
   */
  flush: () => void;
};

export function createPluginTraceRecorder(
  getSession: () => TraceSessionRuntime | undefined,
): PluginTraceRecorder {
  const pending: PluginTraceRecord[] = [];

  const write = (session: TraceSessionRuntime, record: PluginTraceRecord) => {
    const logData = session.resolvedConfig.logData;
    recordTraceEvent(session, {
      type: "hook",
      label: `Hook: ${record.plugin} → ${record.hook}`,
      actor: { scope: "plugin", name: record.plugin, role: "hook" },
      status: record.status,
      error: record.error ? { message: record.error.message } : undefined,
      sections: logData
        ? [
            {
              kind: "metadata",
              label: "Hook outcome",
              data: sanitizeTracePayload({
                hook: record.hook,
                decision: record.decision,
                mutated: record.mutated || undefined,
                shortCircuited: record.shortCircuited || undefined,
                reason: record.reason,
                mutatedBy: record.mutatedBy,
                durationMs:
                  typeof record.durationMs === "number" ? Math.round(record.durationMs) : undefined,
              }),
            },
          ]
        : undefined,
    });
  };

  const drain = (session: TraceSessionRuntime) => {
    if (pending.length === 0) return;
    const held = pending.splice(0, pending.length);
    for (const item of held) write(session, item);
  };

  return {
    record: (record: PluginTraceRecord) => {
      const session = getSession();
      if (!session) {
        // The input guardrail runs before the first model call, which is where
        // the session is created — and a blocked run is exactly the one worth
        // seeing, so the record waits rather than disappearing.
        if (pending.length < MAX_PENDING) pending.push(record);
        return;
      }
      drain(session);
      write(session, record);
    },
    flush: () => {
      const session = getSession();
      if (session) drain(session);
    },
  };
}
