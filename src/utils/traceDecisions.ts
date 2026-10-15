/**
 * Trace events for the human side of a paused run: a tool call waiting for an
 * approval, and the decision (or answer) that resumed it.
 *
 * The wait is recorded twice on purpose. When the run pauses, a `pending`
 * event says what is being waited on — that is all a reader of the paused
 * session can know. When the run resumes, a second event records the outcome
 * with the wait as its duration (timestamp = decision time, like every other
 * agent-sdk event, which is stamped when the step ends). Both carry the same
 * `approvalId` / `questionId`, so a viewer can fold them into one step.
 */

import type {
  PendingToolApproval,
  PendingUserQuestion,
  TraceDataSection,
  TraceSessionRuntime,
} from "../types.js";
import { recordTraceEvent, sanitizeTracePayload } from "./tracing.js";

/** Marks a ledger entry whose outcome is already in the trace. */
const TRACED_KEY = "__outcomeTraced";

function waitedMs(from?: string, to?: string): number | undefined {
  if (!from || !to) return undefined;
  const ms = Date.parse(to) - Date.parse(from);
  return Number.isFinite(ms) && ms >= 0 ? ms : undefined;
}

function sameJson(a: unknown, b: unknown): boolean {
  try {
    return JSON.stringify(a) === JSON.stringify(b);
  } catch {
    return false;
  }
}

/** The run is pausing for `entry`: record what it is waiting on. */
export function recordApprovalRequested(
  session: TraceSessionRuntime | undefined,
  entry: PendingToolApproval,
): void {
  if (!session) return;
  const logData = session.resolvedConfig.logData;
  const sections: TraceDataSection[] = [
    {
      kind: "metadata",
      label: "Approval",
      data: {
        approvalId: entry.id,
        toolCallId: entry.toolCallId,
        status: "pending",
        requestedAt: entry.requestedAt,
        ...(entry.metadata?.prompt !== undefined ? { prompt: entry.metadata.prompt } : {}),
      },
    },
  ];
  if (logData) {
    sections.push({ kind: "tool_call", label: "Arguments to approve", tool: entry.toolName, arguments: sanitizeTracePayload(entry.args) });
  }
  recordTraceEvent(session, {
    type: "tool_approval",
    label: `Approval requested · ${entry.toolName}`,
    timestamp: entry.requestedAt,
    status: "pending",
    actor: { scope: "agent", name: entry.toolName, role: "approval_request" },
    sections,
  });
}

/**
 * Records the outcome of every approval and question resolved since the run
 * paused. Called once a resumed run has opened its iteration, before the
 * approved tools run, so the trace reads: decision, then the tool.
 */
export function recordHumanDecisions(
  session: TraceSessionRuntime | undefined,
  state: {
    pendingApprovals?: PendingToolApproval[];
    pendingUserQuestions?: PendingUserQuestion[];
    toolHistory?: Array<Record<string, any>>;
  },
): void {
  if (!session) return;
  const logData = session.resolvedConfig.logData;

  for (const entry of state.pendingApprovals ?? []) {
    if (!entry.decidedAt || entry.metadata?.[TRACED_KEY]) continue;
    if (entry.status !== "approved" && entry.status !== "rejected") continue;
    const approved = entry.status === "approved";
    const edited = approved && entry.approvedArgs !== undefined && !sameJson(entry.approvedArgs, entry.args);
    const sections: TraceDataSection[] = [
      {
        kind: "metadata",
        label: "Decision",
        data: {
          approvalId: entry.id,
          toolCallId: entry.toolCallId,
          decision: entry.status,
          ...(entry.decidedBy ? { decidedBy: entry.decidedBy } : {}),
          ...(entry.comment ? { comment: entry.comment } : {}),
          requestedAt: entry.requestedAt,
          decidedAt: entry.decidedAt,
          ...(waitedMs(entry.requestedAt, entry.decidedAt) !== undefined ? { waitedMs: waitedMs(entry.requestedAt, entry.decidedAt) } : {}),
          ...(edited ? { argumentsEdited: true } : {}),
        },
      },
    ];
    if (logData) {
      sections.push({ kind: "tool_call", label: "Requested arguments", tool: entry.toolName, arguments: sanitizeTracePayload(entry.args) });
      if (edited) {
        sections.push({ kind: "tool_call", label: "Approved arguments", tool: entry.toolName, arguments: sanitizeTracePayload(entry.approvedArgs) });
      }
    }
    recordTraceEvent(session, {
      type: "tool_approval",
      label: `${approved ? "Approved" : "Rejected"} · ${entry.toolName}`,
      timestamp: entry.decidedAt,
      durationMs: waitedMs(entry.requestedAt, entry.decidedAt),
      status: "success",
      actor: { scope: "human", name: entry.decidedBy || "reviewer", role: "approver" },
      sections,
    });
    entry.metadata = { ...(entry.metadata || {}), [TRACED_KEY]: true };
  }

  for (const entry of state.pendingUserQuestions ?? []) {
    if (!entry.answeredAt || entry.metadata?.[TRACED_KEY]) continue;
    if (entry.status !== "answered" && entry.status !== "cancelled") continue;
    const clientTool = readClientTool(entry);
    if (clientTool) {
      recordClientToolResult(session, entry, clientTool, state.toolHistory);
      entry.metadata = { ...(entry.metadata || {}), [TRACED_KEY]: true };
      continue;
    }
    const cancelled = entry.status === "cancelled";
    const data: Record<string, unknown> = {
      questionId: entry.id,
      toolCallId: entry.toolCallId,
      status: entry.status,
      ...(entry.answeredBy ? { answeredBy: entry.answeredBy } : {}),
      ...(entry.notes ? { notes: entry.notes } : {}),
      requestedAt: entry.requestedAt,
      answeredAt: entry.answeredAt,
      ...(waitedMs(entry.requestedAt, entry.answeredAt) !== undefined ? { waitedMs: waitedMs(entry.requestedAt, entry.answeredAt) } : {}),
    };
    const sections: TraceDataSection[] = [{ kind: "metadata", label: "Answer", data }];
    if (logData) {
      sections.push({
        kind: "metadata",
        label: "Questions and answers",
        data: {
          items: (entry.questions ?? []).map((item) => ({
            question: item.question,
            ...(item.header ? { header: item.header } : {}),
            answer: sanitizeTracePayload(entry.answers?.[item.question] ?? (item.header ? entry.answers?.[item.header] : undefined) ?? null),
          })),
        },
      });
    }
    recordTraceEvent(session, {
      type: "user_question",
      label: cancelled ? "Question cancelled" : "Answer from user",
      timestamp: entry.answeredAt,
      durationMs: waitedMs(entry.requestedAt, entry.answeredAt),
      status: cancelled ? "skipped" : "success",
      actor: { scope: "human", name: entry.answeredBy || "user", role: "user" },
      sections,
    });
    entry.metadata = { ...(entry.metadata || {}), [TRACED_KEY]: true };
  }
}

/** The run is pausing for a host-run tool: record what the host was asked to run. */
export function recordClientToolRequested(
  session: TraceSessionRuntime | undefined,
  entry: PendingUserQuestion,
): void {
  if (!session) return;
  const clientTool = readClientTool(entry);
  if (!clientTool) return;
  const sections: TraceDataSection[] = [
    {
      kind: "metadata",
      label: "Client tool",
      data: { questionId: entry.id, toolCallId: entry.toolCallId, status: "pending", requestedAt: entry.requestedAt },
    },
  ];
  if (session.resolvedConfig.logData) {
    sections.push({ kind: "tool_call", label: "Arguments", tool: clientTool.name, arguments: sanitizeTracePayload(clientTool.args) });
  }
  recordTraceEvent(session, {
    type: "tool_call",
    label: `Tool Execution - ${clientTool.name} (client)`,
    timestamp: entry.requestedAt,
    status: "pending",
    actor: { scope: "client", name: clientTool.name, role: "tool" },
    sections,
  });
}

/**
 * A tool the HOST runs (a browser page, a desktop app): the run pauses on a
 * pending-question entry whose `metadata.clientTool` names the tool, and the
 * host resumes it with the tool's result. Recorded as the tool step it is —
 * not as an answer from the user.
 */
function readClientTool(entry: PendingUserQuestion): { name: string; args?: unknown } | undefined {
  const meta = entry.metadata?.clientTool;
  if (!meta || typeof meta !== "object" || typeof (meta as any).name !== "string") return undefined;
  return { name: (meta as any).name, args: (meta as any).args };
}

function recordClientToolResult(
  session: TraceSessionRuntime,
  entry: PendingUserQuestion,
  clientTool: { name: string; args?: unknown },
  toolHistory: Array<Record<string, any>> | undefined,
): void {
  const step = [...(toolHistory ?? [])].reverse().find((item) => item?.tool_call_id === entry.toolCallId);
  const failed = step?.status === "error" || entry.status === "cancelled";
  const sections: TraceDataSection[] = [
    {
      kind: "metadata",
      label: "Client tool",
      data: {
        questionId: entry.id,
        toolCallId: entry.toolCallId,
        status: failed ? "error" : "answered",
        ...(entry.answeredBy ? { answeredBy: entry.answeredBy } : {}),
        requestedAt: entry.requestedAt,
        answeredAt: entry.answeredAt,
        ...(waitedMs(entry.requestedAt, entry.answeredAt) !== undefined ? { waitedMs: waitedMs(entry.requestedAt, entry.answeredAt) } : {}),
      },
    },
  ];
  if (session.resolvedConfig.logData) {
    sections.push({ kind: "tool_call", label: "Arguments", tool: clientTool.name, arguments: sanitizeTracePayload(clientTool.args) });
    if (step) {
      const output = step.rawOutput ?? step.output;
      sections.push({
        kind: "tool_result",
        label: "Result from client",
        tool: clientTool.name,
        output: sanitizeTracePayload(output),
        summary: typeof step.output === "string" ? step.output.slice(0, 2000) : undefined,
      } as TraceDataSection);
    }
  }
  const ranMs = typeof step?.durationMs === "number" ? step.durationMs : undefined;
  recordTraceEvent(session, {
    type: "tool_call",
    label: `Tool Execution - ${clientTool.name} (client)`,
    timestamp: entry.answeredAt,
    durationMs: waitedMs(entry.requestedAt, entry.answeredAt) ?? ranMs,
    status: failed ? "error" : "success",
    actor: { scope: "client", name: clientTool.name, role: "tool" },
    sections,
  });
}
