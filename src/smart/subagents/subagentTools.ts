import { z } from "zod";
import { nanoid } from "nanoid";

import { createTool, type ToolCallContext } from "../../tool.js";
import type {
  AgentInvokeResult,
  InvokeConfig,
  SmartAgentEvent,
  SmartAgentInstance,
  SmartState,
  StreamChunk,
  ToolInterface,
} from "../../types.js";
import { resolveToolApprovalState } from "../../utils/toolApprovals.js";
import { resolveUserQuestionState } from "../../utils/userQuestions.js";
import { totalUsage } from "../../utils/usage.js";
import {
  canSpawn,
  findSubagent,
  resolveSubagentTools,
  seedChildMessages,
  withinDepth,
} from "./registry.js";
import type {
  SubagentDef,
  SubagentPendingRecord,
  SubagentPolicy,
  SubagentRegistryRef,
  SubagentResult,
  SubagentStatus,
  SubagentUsage,
} from "./types.js";

/**
 * Per-invoke sub-agent tools (`delegate_to`, `spawn_subagent`,
 * `spawn_subagents_parallel`). They read the parent runtime/context from the
 * tool `_stateRef` (injected by the tools node), build child agents via the
 * injected `buildChild` factory (dependency injection avoids a circular import
 * with createSmartAgent), and forward events/streaming/cancellation into each
 * child. Human-in-the-loop pauses inside a sequential child are surfaced to the
 * parent and resumed via `state.ctx.__subagentPending`.
 *
 * The `_stateRef` is shared by every call of a tool in a turn, so a call's own
 * identity (its tool_call id) comes from the per-call context the tools node
 * passes to `func`, never from the ref.
 */

/** Config a child agent is built from. The factory lives in createSmartAgent. */
export type BuildChildConfig = {
  name: string;
  model: any;
  systemPrompt?: string;
  tools: ToolInterface[];
  outputSchema?: any;
  limits?: any;
};

export type SubagentToolDeps = {
  registryRef: SubagentRegistryRef;
  subagents: SubagentDef[];
  policy: SubagentPolicy;
  /** DI: build a child SmartAgent instance (createSmartAgent closure). */
  buildChild: (cfg: BuildChildConfig) => SmartAgentInstance;
  /** Optional prompt-override descriptions for the three tools. */
  descriptions?: { delegate?: string; spawn?: string; parallel?: string };
  /** Names of the parent's tools an ad-hoc child may borrow, listed to the model. */
  parentToolNames?: string[];
};

const DELEGATE_DESCRIPTION =
  "Delegate one self-contained subtask to a named sub-agent and get its result back; you keep control and write the final answer. " +
  "`subagent` is a name from <available_subagents>. `input` is the only thing the sub-agent reliably sees: include the goal, " +
  "every needed fact/ID/constraint, the output format you want and the language to answer in. " +
  "Returns JSON { status, content, output?, error?, note? }: rely on `output`/`content` only when status is \"ok\".";

function spawnDescription(deps: SubagentToolDeps): string {
  const names = deps.parentToolNames ?? [];
  const tools = deps.policy.allowAdhocTools
    ? ` \`tools\` may only contain exact names of your tools${names.length > 0 ? ` (${names.join(", ")})` : ""}; unknown names are an error.`
    : " The sub-agent has no tools; do not request any.";
  return "Create a throwaway specialist for a one-off subtask that no registered sub-agent covers, run it and get its result back. " +
    "Give a short `role`, a `prompt` stating how it should behave and what to return, and a complete standalone `input`." + tools +
    " It cannot ask the user questions, so tell it to state assumptions and proceed. Returns the same JSON as delegate_to.";
}

function parallelDescription(deps: SubagentToolDeps): string {
  const adhoc = deps.policy.mode === "registry_and_adhoc";
  return `Run several INDEPENDENT subtasks at the same time (1-16 tasks, at most ${deps.policy.maxParallel} running concurrently). ` +
    `Each task is { subagent, input } using a name from <available_subagents>${adhoc ? ", or { role, prompt, input } for an ad-hoc one" : ""}. ` +
    "Returns { results: [...] } in task order; check each entry's `status` separately, one failing task does not cancel the others. " +
    "Do not use it when a task needs another task's output or needs human input (approval, questions); use delegate_to for those.";
}

const CTX_CALLBACK_KEYS = new Set([
  "__onEvent",
  "__onProgress",
  "__onStream",
  "__traceSession",
  "__paused",
  "__cancellationToken",
  "__abortSignal",
  "__deadline",
  // Live runtimes, never data: a child state carrying either of these is
  // stored and snapshotted by the parent, where structuredClone throws on
  // their function members. Kept in sync with DISALLOWED_CTX_KEYS in
  // utils/stateSnapshot.ts — the two lists are separate on purpose but must
  // agree about anything holding closures.
  "__contextPilot",
  "__plugins",
  "__applySystemPromptContribution",
  "__pluginState",
]);

/** Strip non-serializable parts from a child state so it can be stored/snapshotted. */
function cleanChildState(state: SmartState): any {
  const { agent: _agent, ctx, ...rest } = state as any;
  let cleanCtx: Record<string, any> | undefined;
  if (ctx && typeof ctx === "object") {
    cleanCtx = {};
    for (const [k, v] of Object.entries(ctx)) {
      if (CTX_CALLBACK_KEYS.has(k)) continue;
      cleanCtx[k] = v;
    }
  }
  return { ...rest, ctx: cleanCtx };
}

/**
 * What the model is shown of a result: no `input` (it wrote it), no `usage` or
 * `durationMs` (bookkeeping for the host, tokens for the model to spend).
 */
export function toModelResult(result: SubagentResult): Omit<SubagentResult, "input" | "usage" | "durationMs"> {
  const { input: _input, usage: _usage, durationMs: _durationMs, ...rest } = result;
  return rest;
}

const FAILED_STATUSES = new Set<SubagentStatus>(["error", "cancelled"]);

/**
 * The tools node asks a tool whether what it returned is a failure. A delegation
 * that came back `error` / `cancelled`, or that was refused before it started,
 * is a failed tool call even though it did not throw.
 */
function failureOf(output: any): string | undefined {
  if (!output || typeof output !== "object") return undefined;
  if (Array.isArray(output.results)) {
    const results = output.results as any[];
    if (results.length > 0 && results.every((r) => r && (FAILED_STATUSES.has(r.status) || (r.status === undefined && r.error)))) {
      return `All ${results.length} sub-agent tasks failed: ${results[0].error || results[0].note || results[0].status}`;
    }
    return undefined;
  }
  if (FAILED_STATUSES.has(output.status)) return output.error || output.note || `Sub-agent ${output.name ?? ""} ${output.status}`.trim();
  if (output.status === undefined && typeof output.error === "string") return output.error;
  return undefined;
}

/** A refusal before any child ran (unknown name, budget, depth, bad arguments). */
function refusal(message: string): { status: "error"; error: string } {
  return { status: "error", error: message };
}

/** Forward a child event to the parent host, stamped with sub-agent origin. */
function makeChildEventForwarder(
  parentOnEvent: ((e: SmartAgentEvent) => void) | undefined,
  spawnId: string,
  name: string,
  streamChildren: boolean,
) {
  return (event: SmartAgentEvent) => {
    if (!parentOnEvent) return;
    // Do not leak the child's terminal signals as the parent's own. The parent
    // emits dedicated `subagent` lifecycle events instead.
    if (event?.type === "finalAnswer" || event?.type === "metadata") return;
    // The child's text deltas are not the parent's text. Opt in to see them,
    // stamped like every other forwarded event.
    if (event?.type === "stream" && !streamChildren) return;
    try {
      parentOnEvent({ ...(event as any), subagentId: spawnId, subagentName: name });
    } catch {
      /* host callback errors never break the run */
    }
  };
}

/** Build the child InvokeConfig that forwards events/streaming/cancellation. */
function buildChildConfig(parentCtx: Record<string, any>, spawnId: string, name: string, streamChildren: boolean): InvokeConfig {
  const streaming = Boolean(parentCtx.__streaming);
  const parentOnStream = parentCtx.__onStream as ((c: StreamChunk) => void) | undefined;
  return {
    onEvent: makeChildEventForwarder(parentCtx.__onEvent, spawnId, name, streamChildren),
    onProgress: parentCtx.__onProgress,
    // A host's onStream appends `chunk.text` to the answer it is building, so a
    // child's tokens would read as the parent's. They are forwarded only on
    // request, tagged, and never the child's `isFinal` chunk (the host would
    // mistake a child completion for the parent's final answer).
    onStream: streaming && streamChildren && parentOnStream
      ? (chunk) => { if (!chunk.isFinal) parentOnStream({ ...chunk, subagentName: name, subagentId: spawnId }); }
      : undefined,
    stream: streaming,
    cancellationToken: parentCtx.__cancellationToken ?? parentCtx.__abortSignal,
  };
}

type ResolvedSpec = {
  name: string;
  mode: "registry" | "adhoc";
  systemPrompt?: string;
  model: any;
  tools: ToolInterface[];
  outputSchema?: any;
  limits?: any;
  childContextPolicy: SubagentPolicy["childContextPolicy"];
  metadata?: Record<string, any>;
  /** Preserved for HITL resume of an ad-hoc child. */
  adhoc?: { role: string; prompt?: string; toolNames?: string[]; outputContract?: string };
};

function summaryOf(state: SmartState | undefined): string | undefined {
  const summaries = state?.summaries;
  return Array.isArray(summaries) && summaries.length > 0 ? summaries[summaries.length - 1] : undefined;
}

/** How a child that ran to the end of its invoke actually ended. */
function outcomeOf(
  res: AgentInvokeResult<any>,
  childState: SmartState | undefined,
): { status: SubagentStatus; error?: string; note?: string } {
  const ctx: any = childState?.ctx || {};
  if (ctx.__cancelled) {
    return { status: "cancelled", note: `Cancelled before the sub-agent finished (${ctx.__cancelled.reason ?? "cancelled"}); the content is partial.` };
  }
  if (ctx.__guardrailBlocked) {
    const reason = ctx.__guardrailBlocked.incident?.reason || res.content || "blocked by a guardrail";
    return { status: "blocked", error: `The sub-agent's answer was blocked by policy: ${reason}` };
  }
  if (ctx.__limitBreached) {
    return { status: "incomplete", note: `The sub-agent stopped early: ${ctx.__limitBreached}. The content is partial.` };
  }
  if (res.outputError) {
    return { status: "error", error: `The sub-agent's structured output failed (${res.outputError.type}): ${res.outputError.message}` };
  }
  if (ctx.__finalizedDueToToolLimit) {
    return { status: "incomplete", note: "The sub-agent hit its tool-call limit and answered with what it had; the content may be incomplete." };
  }
  if (ctx.__paused) {
    return { status: "incomplete", note: "The sub-agent was paused before it finished; the content is partial." };
  }
  if (!(res.content || "").trim() && res.output === undefined) {
    return { status: "incomplete", note: "The sub-agent returned no answer." };
  }
  return { status: "ok" };
}

/**
 * Fold the model calls this run made into the parent's ledger, once. The
 * baseline is how many the child already had before the run: a resumed child
 * carries its earlier calls, which were merged when it paused.
 */
function mergeChildUsage(
  ref: any,
  childState: SmartState | undefined,
  baseline: number,
  tag: { name: string; id: string; mode: "registry" | "adhoc" },
): SubagentUsage | undefined {
  const entries = (childState?.usage?.perRequest ?? []).slice(baseline);
  if (entries.length === 0) return undefined;
  if (typeof ref.__appendUsage === "function") ref.__appendUsage(entries, tag);
  return { perRequest: entries, totals: totalUsage(entries) };
}

/**
 * Run one sub-agent task. Handles a fresh run AND a resume-after-human-input
 * (when a pending record exists for this parent tool-call). Sequential callers
 * (delegate_to / spawn_subagent) pass `allowHITL=true`; parallel children pass
 * `false` and surface a human-input requirement as a `needs_input` result.
 *
 * `reserved` says the caller already counted this spawn against the child-call
 * budget; a `subagentStart` denial gives it back.
 */
async function runChild(
  spec: ResolvedSpec,
  input: string,
  deps: SubagentToolDeps,
  ref: any /* tool _stateRef */,
  opts: { allowHITL: boolean; parentToolCallId: string; parallel?: boolean; isResume?: boolean; record?: SubagentPendingRecord; reserved?: boolean },
): Promise<{ kind: "result"; result: SubagentResult } | { kind: "approval"; toolCallId: string; approvalId: string } | { kind: "user_question"; toolCallId: string; id: string }> {
  const parentCtx: Record<string, any> = ref.ctx || {};
  const parentOnEvent = parentCtx.__onEvent as ((e: SmartAgentEvent) => void) | undefined;
  const spawnId = `sa_${nanoid(6)}`;
  const start = Date.now();
  const usageTag = { name: spec.name, id: spawnId, mode: spec.mode };

  // The parent's run host, reached the same way every node reaches it. Children
  // build their own host from the inherited plugin list; this gate belongs to
  // the PARENT, which is the agent deciding whether to delegate at all.
  const parentHost = parentCtx.__plugins as
    | import("../../plugins/host.js").PluginRunHost
    | undefined;
  const childDepth = (Number(parentCtx.__delegationDepth) || 0) + 1;

  // Charged on a fresh spawn only. Firing this on the HITL resume path too
  // would re-ask a gate that already said yes, and a deny there would abandon a
  // child the host has already answered a question for.
  if (!opts.isResume && parentHost?.has("subagentStart")) {
    const gate = await parentHost.runGate("subagentStart", {
      name: spec.name,
      task: input,
      depth: childDepth,
    });
    if (gate.decision === "deny") {
      // A refused delegation never ran, so it must not eat the child-call budget.
      if (opts.reserved) deps.registryRef.spawnedCount = Math.max(0, deps.registryRef.spawnedCount - 1);
      const reason = gate.reason || `Delegation to "${spec.name}" was blocked by policy.`;
      const result: SubagentResult = { name: spec.name, mode: spec.mode, status: "blocked", input, error: reason };
      deps.registryRef.results.push(result);
      return { kind: "result", result };
    }
    if (gate.input.task !== input) input = gate.input.task as string;
  }

  const child = deps.buildChild({
    name: spec.name,
    model: spec.model,
    systemPrompt: spec.systemPrompt,
    tools: spec.tools,
    outputSchema: spec.outputSchema,
    limits: spec.limits,
  });

  const childConfig = buildChildConfig(parentCtx, spawnId, spec.name, deps.policy.streamChildren === true);

  let childInput: SmartState;
  if (opts.isResume && opts.record) {
    // Apply the host's resolution (held on the parent-surfaced pending entry)
    // to the restored child state, then resume the child.
    const restored = { ...opts.record.childState } as SmartState;
    if (opts.record.pendingKind === "approval") {
      const entry = (ref.pendingApprovals || []).find((e: any) => e.id === opts.record!.pendingId);
      if (!entry) {
        return { kind: "result", result: { name: spec.name, mode: spec.mode, status: "error", input, error: "Pending approval resolution missing on resume." } };
      }
      // Still unanswered: this is a second concurrent pause the host has not
      // resolved yet (two delegating tool_calls both paused in one turn, and the
      // host answered the other). Re-surface it instead of force-resolving with
      // empty data (which would throw and abandon the child).
      if (entry.status === "pending") {
        if (!parentCtx.__awaitingApproval) {
          parentCtx.__awaitingApproval = { approvalId: entry.id, toolCallId: entry.toolCallId, toolName: entry.toolName, requestedAt: entry.requestedAt };
        }
        parentCtx.__resumeStage = "tools";
        return { kind: "approval", toolCallId: entry.toolCallId, approvalId: entry.id };
      }
      childInput = resolveToolApprovalState(restored, {
        id: opts.record.pendingId,
        approved: entry.status === "approved",
        approvedArgs: entry.approvedArgs,
        decidedBy: entry.decidedBy,
        comment: entry.comment,
      });
    } else {
      const entry = (ref.pendingUserQuestions || []).find((e: any) => e.id === opts.record!.pendingId);
      if (!entry) {
        return { kind: "result", result: { name: spec.name, mode: spec.mode, status: "error", input, error: "Pending question resolution missing on resume." } };
      }
      if (entry.status === "pending") {
        if (!parentCtx.__awaitingUserQuestion) {
          parentCtx.__awaitingUserQuestion = { id: entry.id, toolCallId: entry.toolCallId, requestedAt: entry.requestedAt };
        }
        parentCtx.__resumeStage = "tools";
        return { kind: "user_question", toolCallId: entry.toolCallId, id: entry.id };
      }
      childInput = resolveUserQuestionState(restored, {
        id: opts.record.pendingId,
        answers: entry.answers,
        answeredBy: entry.answeredBy,
        notes: entry.notes,
        cancelled: entry.cancelled === true,
      });
    }
  } else {
    parentOnEvent?.({ type: "subagent", phase: "start", name: spec.name, id: spawnId, mode: spec.mode, parallel: opts.parallel, parentToolCallId: opts.parentToolCallId, input } as any);
    const currentDepth = Number(parentCtx.__delegationDepth) || 0;
    childInput = {
      messages: seedChildMessages(spec.childContextPolicy, ref.messages || [], input),
      ctx: { __delegationDepth: currentDepth + 1 },
    } as SmartState;
  }
  // Counted before the run: a resumed child already holds the calls it made
  // before it paused, and those were merged into the parent back then.
  const usageBaseline = childInput.usage?.perRequest?.length ?? 0;

  let res: AgentInvokeResult<any>;
  try {
    res = await child.invoke(childInput, childConfig);
  } catch (err: any) {
    const result: SubagentResult = { name: spec.name, mode: spec.mode, status: "error", input, error: err?.message || String(err), durationMs: Date.now() - start };
    deps.registryRef.results.push(result);
    parentOnEvent?.({ type: "subagent", phase: "error", name: spec.name, id: spawnId, mode: spec.mode, status: "error", error: { message: result.error! }, parentToolCallId: opts.parentToolCallId } as any);
    return { kind: "result", result };
  }

  const childState = res.state as SmartState | undefined;
  const awaitingApproval = childState?.ctx?.__awaitingApproval;
  const awaitingQuestion = childState?.ctx?.__awaitingUserQuestion;

  // The calls the child made count against the parent whatever way it ended —
  // including the ones it made before pausing for a human.
  const usage = mergeChildUsage(ref, childState, usageBaseline, usageTag);

  // ── Child paused for human input ────────────────────────────────────────────
  if (childState && (awaitingApproval || awaitingQuestion)) {
    if (!opts.allowHITL) {
      const result: SubagentResult = {
        name: spec.name, mode: spec.mode, status: "needs_input", input,
        error: "Sub-agent requested human input, which is not supported inside parallel fan-out. Run it via delegate_to / spawn_subagent instead.",
        usage,
        durationMs: Date.now() - start,
      };
      deps.registryRef.results.push(result);
      return { kind: "result", result };
    }

    const pendingStore = (parentCtx.__subagentPending ||= {} as Record<string, SubagentPendingRecord>);

    if (awaitingApproval) {
      const childEntry = (childState.pendingApprovals || []).find((e) => e.status === "pending");
      if (childEntry) {
        // Surface the same entry to the parent, tagged so the host can render it.
        const surfaced = { ...childEntry, metadata: { ...(childEntry.metadata || {}), __subagent: { parentToolCallId: opts.parentToolCallId, name: spec.name } } };
        (ref.pendingApprovals ||= []).push(surfaced);
        // Signal the parent loop to pause (a tool returning __awaitingToolApproval
        // must set these itself; the tools node does not on this path). Guard the
        // single __awaiting* slot: if a concurrent sibling already claimed it this
        // turn, leave it primary — this one is still recorded and re-surfaces on a
        // later resume round so both pauses drain deterministically.
        if (!parentCtx.__awaitingApproval && !parentCtx.__awaitingUserQuestion) {
          parentCtx.__awaitingApproval = { approvalId: surfaced.id, toolCallId: surfaced.toolCallId, toolName: surfaced.toolName, requestedAt: surfaced.requestedAt };
        }
        parentCtx.__resumeStage = "tools";
        pendingStore[opts.parentToolCallId] = {
          parentToolCallId: opts.parentToolCallId, name: spec.name, mode: spec.mode,
          adhoc: spec.adhoc, input, childState: cleanChildState(childState),
          pendingKind: "approval", pendingId: childEntry.id,
        };
        parentOnEvent?.({ type: "subagent", phase: "paused", name: spec.name, id: spawnId, mode: spec.mode, parentToolCallId: opts.parentToolCallId } as any);
        return { kind: "approval", toolCallId: surfaced.toolCallId, approvalId: surfaced.id };
      }
    }

    if (awaitingQuestion) {
      const childEntry = (childState.pendingUserQuestions || []).find((e) => e.status === "pending");
      if (childEntry) {
        const surfaced = { ...childEntry, metadata: { ...(childEntry.metadata || {}), __subagent: { parentToolCallId: opts.parentToolCallId, name: spec.name } } };
        (ref.pendingUserQuestions ||= []).push(surfaced);
        // Guard the single __awaiting* slot against a concurrent sibling pause
        // (see the approval branch above).
        if (!parentCtx.__awaitingUserQuestion && !parentCtx.__awaitingApproval) {
          parentCtx.__awaitingUserQuestion = { id: surfaced.id, toolCallId: surfaced.toolCallId, requestedAt: surfaced.requestedAt };
        }
        parentCtx.__resumeStage = "tools";
        pendingStore[opts.parentToolCallId] = {
          parentToolCallId: opts.parentToolCallId, name: spec.name, mode: spec.mode,
          adhoc: spec.adhoc, input, childState: cleanChildState(childState),
          pendingKind: "user_question", pendingId: childEntry.id,
        };
        parentOnEvent?.({ type: "subagent", phase: "paused", name: spec.name, id: spawnId, mode: spec.mode, parentToolCallId: opts.parentToolCallId } as any);
        return { kind: "user_question", toolCallId: surfaced.toolCallId, id: surfaced.id };
      }
    }
  }

  // ── Child completed ─────────────────────────────────────────────────────────
  if (parentCtx.__subagentPending?.[opts.parentToolCallId]) {
    delete parentCtx.__subagentPending[opts.parentToolCallId];
  }
  const outcome = outcomeOf(res, childState);
  const result: SubagentResult = {
    name: spec.name,
    mode: spec.mode,
    status: outcome.status,
    input,
    content: res.content,
    output: res.output,
    summary: summaryOf(childState),
    ...(outcome.error ? { error: outcome.error } : {}),
    ...(outcome.note ? { note: outcome.note } : {}),
    usage,
    durationMs: Date.now() - start,
  };
  deps.registryRef.results.push(result);
  if (FAILED_STATUSES.has(outcome.status)) {
    parentOnEvent?.({ type: "subagent", phase: "error", name: spec.name, id: spawnId, mode: spec.mode, status: outcome.status, error: { message: outcome.error || outcome.note || outcome.status }, content: res.content, note: outcome.note, usage, durationMs: result.durationMs, parentToolCallId: opts.parentToolCallId } as any);
  } else {
    parentOnEvent?.({ type: "subagent", phase: "result", name: spec.name, id: spawnId, mode: spec.mode, status: outcome.status, content: res.content, note: outcome.note, usage, durationMs: result.durationMs, parentToolCallId: opts.parentToolCallId } as any);
  }
  if (parentHost?.has("subagentStop")) {
    await parentHost.runObservers("subagentStop", {
      name: spec.name,
      result,
      depth: childDepth,
      durationMs: result.durationMs,
    });
  }
  return { kind: "result", result };
}

/** Resolve a registry sub-agent name into a concrete spec. */
async function specFromRegistry(def: SubagentDef, deps: SubagentToolDeps, parentRuntime: any): Promise<ResolvedSpec> {
  const tools = await resolveSubagentTools(def.tools, parentRuntime?.tools || []);
  return {
    name: def.name,
    mode: "registry",
    // Without a prompt of its own the child still has to know what it is for.
    systemPrompt: def.systemPrompt || `You are ${def.title || def.name}. ${def.header}`,
    model: def.model ?? parentRuntime?.model,
    tools,
    outputSchema: def.outputSchema,
    limits: def.limits,
    childContextPolicy: def.childContextPolicy ?? deps.policy.childContextPolicy,
    metadata: def.metadata,
  };
}

/** The names of the parent's live tools a child may borrow (no delegation tools). */
function borrowableToolNames(parentRuntime: any): string[] {
  return ((parentRuntime?.tools as any[]) || [])
    .filter((tool) => tool?.name && tool?.__source !== "smart-subagents")
    .map((tool) => tool.name as string);
}

/** Names the model asked to borrow that the parent does not have. */
function unknownToolNames(requested: string[] | undefined, parentRuntime: any): string[] {
  if (!requested || requested.length === 0) return [];
  const known = new Set(borrowableToolNames(parentRuntime));
  return requested.filter((name) => !known.has(name));
}

function unknownToolsMessage(unknown: string[], parentRuntime: any): string {
  const available = borrowableToolNames(parentRuntime);
  return `Unknown tool name(s) for the sub-agent: ${unknown.join(", ")}.${available.length > 0 ? ` Your tools: ${available.join(", ")}.` : " You have no tools it could borrow."}`;
}

/** Resolve an ad-hoc {role, prompt, tools} spec. */
async function specFromAdhoc(
  args: { role: string; prompt?: string; tools?: string[]; toolNames?: string[]; outputContract?: string },
  deps: SubagentToolDeps,
  parentRuntime: any,
): Promise<ResolvedSpec> {
  // On a fresh spawn the borrowed tools arrive as `args.tools`; on a HITL resume
  // they come from the durable record as `toolNames` (SubagentPendingRecord.adhoc).
  // Accept either so a resumed ad-hoc child keeps its borrowed tools.
  const toolNames = deps.policy.allowAdhocTools ? (args.tools ?? args.toolNames ?? []) : [];
  const tools = await resolveSubagentTools(toolNames, parentRuntime?.tools || []);
  const systemPrompt = [args.prompt, args.outputContract ? `Output contract: ${args.outputContract}` : ""].filter(Boolean).join("\n\n");
  return {
    name: args.role,
    mode: "adhoc",
    systemPrompt: systemPrompt || `You are ${args.role}.`,
    model: parentRuntime?.model,
    tools,
    childContextPolicy: deps.policy.childContextPolicy,
    adhoc: { role: args.role, prompt: args.prompt, toolNames, outputContract: args.outputContract },
  };
}

/** Map a runChild outcome into the tool's return payload understood by the tools node. */
function toToolReturn(outcome: Awaited<ReturnType<typeof runChild>>): any {
  if (outcome.kind === "approval") {
    return { __awaitingToolApproval: true, toolCallId: outcome.toolCallId, approvalId: outcome.approvalId };
  }
  if (outcome.kind === "user_question") {
    return { __awaitingUserQuestion: true, toolCallId: outcome.toolCallId, id: outcome.id };
  }
  return toModelResult(outcome.result);
}

/**
 * This call's id. The tools node passes it per call; the shared `_stateRef` field
 * is only read for a caller that invokes `func` directly, and is overwritten by
 * every sibling call in the turn.
 */
function callIdOf(context: ToolCallContext | undefined, ref: any, fallbackPrefix: string): string {
  return context?.toolCallId || ref.__currentToolCallId || `${fallbackPrefix}_${nanoid(6)}`;
}

export function createDelegateTool(deps: SubagentToolDeps): ToolInterface {
  const names = deps.subagents.map((s) => s.name);
  const tool = createTool({
    name: "delegate_to",
    description: deps.descriptions?.delegate ?? DELEGATE_DESCRIPTION,
    schema: z
      .object({
        subagent: (names.length > 0 ? z.enum(names as [string, ...string[]]) : z.string().min(1)).describe("Name of a sub-agent from <available_subagents>."),
        input: z.string().min(1).describe("Complete standalone brief: goal, needed facts and constraints, desired output format, answer language."),
      })
      .strict(),
    func: async ({ subagent, input }: { subagent: string; input: string }, context?: ToolCallContext) => {
      const ref: any = (tool as any)._stateRef || {};
      const d = (tool as any)._deps as SubagentToolDeps;
      const parentRuntime = ref.parentRuntime;
      const parentToolCallId = callIdOf(context, ref, "delegate");
      const parentCtx: Record<string, any> = ref.ctx || (ref.ctx = {});

      const def = findSubagent(d.subagents, subagent);
      if (!def) return refusal(`Unknown sub-agent: ${subagent}. Choose one from <available_subagents>.`);
      if (def.isAvailable && !(await def.isAvailable())) return refusal(`Sub-agent ${subagent} is not available right now.`);

      const record = parentCtx.__subagentPending?.[parentToolCallId] as SubagentPendingRecord | undefined;
      const spec = await specFromRegistry(def, d, parentRuntime);
      if (!record) {
        const depth = withinDepth(Number(parentCtx.__delegationDepth) || 0, d.policy);
        if (!depth.ok) return refusal(depth.reason);
        const budget = canSpawn(d.registryRef, d.policy, 1);
        if (!budget.ok) return refusal(budget.reason);
        // Reserved now so concurrent siblings cannot overspend; runChild gives it
        // back if a `subagentStart` gate refuses the delegation.
        d.registryRef.spawnedCount += 1;
      }
      return toToolReturn(await runChild(spec, record?.input ?? input, d, ref, { allowHITL: true, parentToolCallId, isResume: !!record, record, reserved: !record }));
    },
  });
  (tool as any)._deps = deps;
  (tool as any)._stateRef = {};
  (tool as any).__source = "smart-subagents";
  (tool as any).__failureOf = failureOf;
  return tool;
}

export function createSpawnTool(deps: SubagentToolDeps): ToolInterface {
  const shape: Record<string, z.ZodTypeAny> = {
    role: z.string().min(1).describe("Short role name, e.g. 'db-analyst'."),
    prompt: z.string().optional().describe("System prompt defining how the sub-agent behaves and what it returns."),
    input: z.string().min(1).describe("Complete standalone brief: goal, needed facts and constraints, desired output format, answer language."),
    outputContract: z.string().optional().describe("Optional description of the expected output shape."),
  };
  // The field only exists when the policy honours it; otherwise the model would
  // ask for tools the child then silently does not get.
  if (deps.policy.allowAdhocTools) {
    shape.tools = z.array(z.string().min(1)).optional().describe("Exact names of YOUR tools the sub-agent may use. Omit if none are needed.");
  }
  const tool = createTool({
    name: "spawn_subagent",
    description: deps.descriptions?.spawn ?? spawnDescription(deps),
    schema: z.object(shape).strict(),
    func: async (args: { role: string; prompt?: string; input: string; tools?: string[]; outputContract?: string }, context?: ToolCallContext) => {
      const ref: any = (tool as any)._stateRef || {};
      const d = (tool as any)._deps as SubagentToolDeps;
      if (d.policy.mode !== "registry_and_adhoc") {
        return refusal("Ad-hoc sub-agents are disabled (subagentPolicy.mode is not 'registry_and_adhoc'). Use delegate_to.");
      }
      const parentRuntime = ref.parentRuntime;
      const parentToolCallId = callIdOf(context, ref, "spawn");
      const parentCtx: Record<string, any> = ref.ctx || (ref.ctx = {});

      const record = parentCtx.__subagentPending?.[parentToolCallId] as SubagentPendingRecord | undefined;
      if (!record && d.policy.allowAdhocTools) {
        const unknown = unknownToolNames(args.tools, parentRuntime);
        if (unknown.length > 0) return refusal(unknownToolsMessage(unknown, parentRuntime));
      }
      const spec = record?.adhoc
        ? await specFromAdhoc(record.adhoc, d, parentRuntime)
        : await specFromAdhoc(args, d, parentRuntime);
      if (!record) {
        const depth = withinDepth(Number(parentCtx.__delegationDepth) || 0, d.policy);
        if (!depth.ok) return refusal(depth.reason);
        const budget = canSpawn(d.registryRef, d.policy, 1);
        if (!budget.ok) return refusal(budget.reason);
        d.registryRef.spawnedCount += 1;
      }
      return toToolReturn(await runChild(spec, record?.input ?? args.input, d, ref, { allowHITL: true, parentToolCallId, isResume: !!record, record, reserved: !record }));
    },
  });
  (tool as any)._deps = deps;
  (tool as any)._stateRef = {};
  (tool as any).__source = "smart-subagents";
  (tool as any).__failureOf = failureOf;
  return tool;
}

export function createParallelTool(deps: SubagentToolDeps): ToolInterface {
  const adhoc = deps.policy.mode === "registry_and_adhoc";
  const names = deps.subagents.map((s) => s.name);
  const taskShape: Record<string, z.ZodTypeAny> = {};
  // Only what the active policy accepts is in the schema, so the model cannot
  // describe an ad-hoc task in a mode that refuses it.
  if (names.length > 0) {
    const named = z.enum(names as [string, ...string[]]).describe("Name from <available_subagents>.");
    taskShape.subagent = adhoc ? named.optional() : named;
  } else if (!adhoc) {
    taskShape.subagent = z.string().min(1).describe("Registry sub-agent name.");
  }
  if (adhoc) {
    taskShape.role = z.string().optional().describe("Ad-hoc role (when not using `subagent`).");
    taskShape.prompt = z.string().optional();
    if (deps.policy.allowAdhocTools) taskShape.tools = z.array(z.string().min(1)).optional();
  }
  taskShape.input = z.string().min(1).describe("Complete standalone brief for this task.");
  const tool = createTool({
    name: "spawn_subagents_parallel",
    description: deps.descriptions?.parallel ?? parallelDescription(deps),
    schema: z
      .object({
        tasks: z
          .array(z.object(taskShape).strict())
          .min(1)
          .max(16)
          .describe(`Independent subtasks to run concurrently (${deps.policy.maxParallel} at a time).`),
      })
      .strict(),
    func: async ({ tasks }: { tasks: Array<{ subagent?: string; role?: string; prompt?: string; tools?: string[]; input: string }> }, context?: ToolCallContext) => {
      const ref: any = (tool as any)._stateRef || {};
      const d = (tool as any)._deps as SubagentToolDeps;
      const parentRuntime = ref.parentRuntime;
      const parentToolCallId = callIdOf(context, ref, "parallel");
      const parentCtx: Record<string, any> = ref.ctx || (ref.ctx = {});

      const depth = withinDepth(Number(parentCtx.__delegationDepth) || 0, d.policy);
      if (!depth.ok) return refusal(depth.reason);

      // Resolve specs first (validation), then charge the spawn budget only for
      // the tasks that will actually spawn a child (invalid tasks short-circuit
      // to an error result and must not consume the per-run child-call budget).
      const specs: Array<{ spec: ResolvedSpec; input: string } | { error: string; input: string; name: string }> = [];
      for (const task of tasks) {
        if (task.subagent) {
          const def = findSubagent(d.subagents, task.subagent);
          if (!def) { specs.push({ error: `Unknown sub-agent: ${task.subagent}`, input: task.input, name: task.subagent }); continue; }
          specs.push({ spec: await specFromRegistry(def, d, parentRuntime), input: task.input });
        } else if (task.role) {
          if (d.policy.mode !== "registry_and_adhoc") { specs.push({ error: "Ad-hoc sub-agents are disabled.", input: task.input, name: task.role }); continue; }
          const unknown = d.policy.allowAdhocTools ? unknownToolNames(task.tools, parentRuntime) : [];
          if (unknown.length > 0) { specs.push({ error: unknownToolsMessage(unknown, parentRuntime), input: task.input, name: task.role }); continue; }
          specs.push({ spec: await specFromAdhoc({ role: task.role, prompt: task.prompt, tools: task.tools }, d, parentRuntime), input: task.input });
        } else {
          specs.push({ error: "Each task needs either `subagent` or `role`.", input: task.input, name: "?" });
        }
      }

      const spawnCount = specs.filter((entry) => !("error" in entry)).length;
      const budget = canSpawn(d.registryRef, d.policy, spawnCount);
      if (!budget.ok) return refusal(budget.reason);
      d.registryRef.spawnedCount += spawnCount;

      const results: SubagentResult[] = new Array(specs.length);
      const concurrency = Math.max(1, Math.min(d.policy.maxParallel, specs.length));
      let cursor = 0;
      const worker = async () => {
        while (true) {
          const i = cursor++;
          if (i >= specs.length) return;
          const entry = specs[i];
          if ("error" in entry) {
            results[i] = { name: entry.name, mode: "adhoc", status: "error", input: entry.input, error: entry.error };
            continue;
          }
          const outcome = await runChild(entry.spec, entry.input, d, ref, {
            allowHITL: false,
            parentToolCallId: `${parentToolCallId}#${i}`,
            parallel: true,
            reserved: true,
          });
          results[i] = outcome.kind === "result"
            ? outcome.result
            : { name: entry.spec.name, mode: entry.spec.mode, status: "error", input: entry.input, error: "Unexpected pause in parallel child." };
        }
      };
      await Promise.all(Array.from({ length: concurrency }, () => worker()));
      return { results: results.map(toModelResult) };
    },
  });
  (tool as any)._deps = deps;
  (tool as any)._stateRef = {};
  (tool as any).__source = "smart-subagents";
  (tool as any).__failureOf = failureOf;
  return tool;
}

/** Build the sub-agent tool set for an invoke, all sharing one registry ref. */
export function createSubagentTools(deps: SubagentToolDeps): ToolInterface[] {
  const tools: ToolInterface[] = [];
  if (deps.subagents.length > 0) tools.push(createDelegateTool(deps));
  if (deps.policy.mode === "registry_and_adhoc") tools.push(createSpawnTool(deps));
  tools.push(createParallelTool(deps));
  return tools;
}
