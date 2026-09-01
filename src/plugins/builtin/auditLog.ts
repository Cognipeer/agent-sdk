/**
 * Append-only record of what the agent tried to do.
 *
 * Registered at priority 0 so it observes every tool attempt *before* any
 * policy plugin can deny it — an audit log that only sees the calls that were
 * allowed answers the wrong question. The outcome of each attempt is reconciled
 * at `sessionEnd` from `toolHistory`, which carries the final status
 * (`success` / `error` / `rejected` / `handoff`) for every call.
 */

import type { AgentPlugin, MaybePromise } from "../types.js";
import type { SmartState } from "../../types.js";

export type AuditEntry = {
  runId: string;
  agentName?: string;
  at: string;
  kind: "tool_attempt" | "tool_outcome" | "notification" | "session_end";
  toolName?: string;
  toolCallId?: string;
  args?: unknown;
  status?: string;
  detail?: unknown;
};

export type AuditLogConfig = {
  /** Where entries go. Defaults to `console.log` of a compact JSON line. */
  sink?: (entry: AuditEntry) => MaybePromise<void>;
  /** Include tool arguments. Off by default — arguments routinely carry PII. */
  includeArgs?: boolean;
  /** Truncate serialized arguments to this many characters. Default 2000. */
  maxArgChars?: number;
  name?: string;
};

export function auditLog(config: AuditLogConfig = {}): AgentPlugin {
  const sink =
    config.sink ??
    ((entry: AuditEntry) => {
      console.log(`[audit] ${JSON.stringify(entry)}`);
    });
  const maxArgChars = config.maxArgChars ?? 2000;

  const write = async (entry: AuditEntry) => {
    try {
      await sink(entry);
    } catch {
      // An audit sink failure must not take the run down. If the log matters
      // that much, the sink itself should be durable.
    }
  };

  const renderArgs = (args: unknown): unknown => {
    if (!config.includeArgs) return undefined;
    try {
      const text = JSON.stringify(args) ?? "";
      return text.length > maxArgChars ? `${text.slice(0, maxArgChars)}…[truncated]` : JSON.parse(text);
    } catch {
      return "[unserializable]";
    }
  };

  return {
    name: config.name ?? "audit-log",
    // Lowest number: runs first, so denials by later plugins are still recorded
    // as attempts.
    priority: 0,
    failureMode: "open",
    // Purely observational, so the tool batch it watches stays parallel.
    mayRequireApproval: false,

    hooks: {
      preToolUse: async ({ toolName, toolCallId, args }, ctx) => {
        await write({
          runId: ctx.runId,
          agentName: ctx.agentName,
          at: new Date().toISOString(),
          kind: "tool_attempt",
          toolName,
          toolCallId,
          args: renderArgs(args),
        });
        return undefined;
      },

      notification: async ({ kind, detail }, ctx) => {
        await write({
          runId: ctx.runId,
          agentName: ctx.agentName,
          at: new Date().toISOString(),
          kind: "notification",
          status: kind,
          detail,
        });
      },

      sessionEnd: async ({ status }, ctx) => {
        const history = (ctx.state as SmartState).toolHistory ?? [];
        for (const record of history) {
          await write({
            runId: ctx.runId,
            agentName: ctx.agentName,
            at: record.timestamp ?? new Date().toISOString(),
            kind: "tool_outcome",
            toolName: record.toolName,
            toolCallId: record.tool_call_id,
            status: record.status,
          });
        }
        await write({
          runId: ctx.runId,
          agentName: ctx.agentName,
          at: new Date().toISOString(),
          kind: "session_end",
          status,
          detail: { toolCalls: history.length },
        });
      },
    },
  };
}
