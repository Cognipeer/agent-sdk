import { z } from "zod";
import { nanoid } from "nanoid";

import { createTool } from "../../tool.js";
import type {
  AgentInvokeResult,
  InvokeConfig,
  SmartAgentEvent,
  SmartAgentInstance,
  SmartState,
  ToolInterface,
} from "../../types.js";
import { resolveToolApprovalState } from "../../utils/toolApprovals.js";
import { resolveUserQuestionState } from "../../utils/userQuestions.js";
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
} from "./types.js";

/**
 * Per-invoke sub-agent tools (`delegate_to`, `spawn_subagent`,
 * `spawn_subagents_parallel`). They read the parent runtime/context from the
 * tool `_stateRef` (injected by the tools node), build child agents via the
 * injected `buildChild` factory (dependency injection avoids a circular import
 * with createSmartAgent), and forward events/streaming/cancellation into each
 * child. Human-in-the-loop pauses inside a sequential child are surfaced to the
 * parent and resumed via `state.ctx.__subagentPending`.
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
};

const DEFAULT_DELEGATE_DESCRIPTION =
  "Delegate a self-contained subtask to a predefined sub-agent. Pass the sub-agent " +
  "name (from <available_subagents>) and a complete, standalone `input` describing " +
  "the task and the expected result. The sub-agent runs in isolation and returns a concise result.";

const DEFAULT_SPAWN_DESCRIPTION =
  "Create a sub-agent on the fly. Provide a short `role`, a `prompt` defining how it " +
  "should behave, and a complete `input` task. Optionally pass `tools` (names of the " +
  "parent's tools the sub-agent may use). Use for one-off specialist subtasks.";

const DEFAULT_PARALLEL_DESCRIPTION =
  "Run several independent subtasks concurrently. Each task is either a registry " +
  "`subagent` + `input`, or an ad-hoc `role` + `prompt` + `input`. Returns one result " +
  "per task in order. Do NOT use for tasks that require human input (approval / questions).";

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

/** Forward a child event to the parent host, stamped with sub-agent origin. */
function makeChildEventForwarder(
  parentOnEvent: ((e: SmartAgentEvent) => void) | undefined,
  spawnId: string,
  name: string,
) {
  return (event: SmartAgentEvent) => {
    if (!parentOnEvent) return;
    // Do not leak the child's terminal signals as the parent's own. The parent
    // emits dedicated `subagent` lifecycle events instead.
    if (event?.type === "finalAnswer" || event?.type === "metadata") return;
    try {
      parentOnEvent({ ...(event as any), subagentId: spawnId, subagentName: name });
    } catch {
      /* host callback errors never break the run */
    }
  };
}

/** Build the child InvokeConfig that forwards events/streaming/cancellation. */
function buildChildConfig(parentCtx: Record<string, any>, spawnId: string, name: string): InvokeConfig {
  const streaming = Boolean(parentCtx.__streaming);
  const parentOnStream = parentCtx.__onStream as ((c: { text: string; isFinal?: boolean }) => void) | undefined;
  return {
    onEvent: makeChildEventForwarder(parentCtx.__onEvent, spawnId, name),
    onProgress: parentCtx.__onProgress,
    // Forward streaming deltas but swallow the child's `isFinal` chunk so the
    // host does not mistake a child completion for the parent's final answer.
    onStream: streaming && parentOnStream ? (chunk) => { if (!chunk.isFinal) parentOnStream(chunk); } : undefined,
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

/**
 * Run one sub-agent task. Handles a fresh run AND a resume-after-human-input
 * (when a pending record exists for this parent tool-call). Sequential callers
 * (delegate_to / spawn_subagent) pass `allowHITL=true`; parallel children pass
 * `false` and surface a human-input requirement as an error result.
 */
async function runChild(
  spec: ResolvedSpec,
  input: string,
  deps: SubagentToolDeps,
  ref: any /* tool _stateRef */,
  opts: { allowHITL: boolean; parentToolCallId: string; parallel?: boolean; isResume?: boolean; record?: SubagentPendingRecord },
): Promise<{ kind: "result"; result: SubagentResult } | { kind: "approval"; toolCallId: string; approvalId: string } | { kind: "user_question"; toolCallId: string; id: string }> {
  const parentCtx: Record<string, any> = ref.ctx || {};
  const parentOnEvent = parentCtx.__onEvent as ((e: SmartAgentEvent) => void) | undefined;
  const spawnId = `sa_${nanoid(6)}`;
  const start = Date.now();

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
      const reason = gate.reason || `Delegation to "${spec.name}" was blocked by policy.`;
      return { kind: "result", result: { name: spec.name, mode: spec.mode, input, error: reason } };
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

  const childConfig = buildChildConfig(parentCtx, spawnId, spec.name);

  let childInput: SmartState;
  if (opts.isResume && opts.record) {
    // Apply the host's resolution (held on the parent-surfaced pending entry)
    // to the restored child state, then resume the child.
    const restored = { ...opts.record.childState } as SmartState;
    if (opts.record.pendingKind === "approval") {
      const entry = (ref.pendingApprovals || []).find((e: any) => e.id === opts.record!.pendingId);
      if (!entry) {
        return { kind: "result", result: { name: spec.name, mode: spec.mode, input, error: "Pending approval resolution missing on resume." } };
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
        return { kind: "result", result: { name: spec.name, mode: spec.mode, input, error: "Pending question resolution missing on resume." } };
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

  let res: AgentInvokeResult<any>;
  try {
    res = await child.invoke(childInput, childConfig);
  } catch (err: any) {
    const result: SubagentResult = { name: spec.name, mode: spec.mode, input, error: err?.message || String(err), durationMs: Date.now() - start };
    deps.registryRef.results.push(result);
    parentOnEvent?.({ type: "subagent", phase: "error", name: spec.name, id: spawnId, mode: spec.mode, error: { message: result.error! }, parentToolCallId: opts.parentToolCallId } as any);
    return { kind: "result", result };
  }

  const childState = res.state as SmartState | undefined;
  const awaitingApproval = childState?.ctx?.__awaitingApproval;
  const awaitingQuestion = childState?.ctx?.__awaitingUserQuestion;

  // ── Child paused for human input ────────────────────────────────────────────
  if (childState && (awaitingApproval || awaitingQuestion)) {
    if (!opts.allowHITL) {
      const result: SubagentResult = {
        name: spec.name, mode: spec.mode, input,
        error: "Sub-agent requested human input, which is not supported inside parallel fan-out. Run it via delegate_to / spawn_subagent instead.",
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
  const result: SubagentResult = {
    name: spec.name,
    mode: spec.mode,
    input,
    content: res.content,
    output: res.output,
    summary: summaryOf(childState),
    durationMs: Date.now() - start,
  };
  deps.registryRef.results.push(result);
  parentOnEvent?.({ type: "subagent", phase: "result", name: spec.name, id: spawnId, mode: spec.mode, content: res.content, durationMs: result.durationMs, parentToolCallId: opts.parentToolCallId } as any);
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
    systemPrompt: def.systemPrompt,
    model: def.model ?? parentRuntime?.model,
    tools,
    outputSchema: def.outputSchema,
    limits: def.limits,
    childContextPolicy: def.childContextPolicy ?? deps.policy.childContextPolicy,
    metadata: def.metadata,
  };
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
    systemPrompt: systemPrompt || undefined,
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
  return outcome.result;
}

export function createDelegateTool(deps: SubagentToolDeps): ToolInterface {
  const names = deps.subagents.map((s) => s.name);
  const tool = createTool({
    name: "delegate_to",
    description: deps.descriptions?.delegate ?? DEFAULT_DELEGATE_DESCRIPTION,
    schema: z
      .object({
        subagent: (names.length > 0 ? z.enum(names as [string, ...string[]]) : z.string().min(1)).describe("Name of a sub-agent from <available_subagents>."),
        input: z.string().min(1).describe("Complete, standalone task for the sub-agent."),
      })
      .strict(),
    func: async ({ subagent, input }: { subagent: string; input: string }) => {
      const ref: any = (tool as any)._stateRef || {};
      const d = (tool as any)._deps as SubagentToolDeps;
      const parentRuntime = ref.parentRuntime;
      const parentToolCallId: string = ref.__currentToolCallId || `delegate_${nanoid(6)}`;
      const parentCtx: Record<string, any> = ref.ctx || (ref.ctx = {});

      const def = findSubagent(d.subagents, subagent);
      if (!def) return { error: `Unknown sub-agent: ${subagent}. Choose one from <available_subagents>.` };
      if (def.isAvailable && !(await def.isAvailable())) return { error: `Sub-agent ${subagent} is not available right now.` };

      const record = parentCtx.__subagentPending?.[parentToolCallId] as SubagentPendingRecord | undefined;
      const spec = await specFromRegistry(def, d, parentRuntime);
      if (!record) {
        const depth = withinDepth(Number(parentCtx.__delegationDepth) || 0, d.policy);
        if (!depth.ok) return { error: depth.reason };
        const budget = canSpawn(d.registryRef, d.policy, 1);
        if (!budget.ok) return { error: budget.reason };
        d.registryRef.spawnedCount += 1;
      }
      return toToolReturn(await runChild(spec, record?.input ?? input, d, ref, { allowHITL: true, parentToolCallId, isResume: !!record, record }));
    },
  });
  (tool as any)._deps = deps;
  (tool as any)._stateRef = {};
  (tool as any).__source = "smart-subagents";
  return tool;
}

export function createSpawnTool(deps: SubagentToolDeps): ToolInterface {
  const tool = createTool({
    name: "spawn_subagent",
    description: deps.descriptions?.spawn ?? DEFAULT_SPAWN_DESCRIPTION,
    schema: z
      .object({
        role: z.string().min(1).describe("Short role name, e.g. 'db-analyst'."),
        prompt: z.string().optional().describe("System prompt defining how the sub-agent behaves."),
        input: z.string().min(1).describe("Complete, standalone task for the sub-agent."),
        tools: z.array(z.string().min(1)).optional().describe("Names of the parent's tools the sub-agent may use."),
        outputContract: z.string().optional().describe("Optional description of the expected output shape."),
      })
      .strict(),
    func: async (args: { role: string; prompt?: string; input: string; tools?: string[]; outputContract?: string }) => {
      const ref: any = (tool as any)._stateRef || {};
      const d = (tool as any)._deps as SubagentToolDeps;
      if (d.policy.mode !== "registry_and_adhoc") {
        return { error: "Ad-hoc sub-agents are disabled (subagentPolicy.mode is not 'registry_and_adhoc'). Use delegate_to." };
      }
      const parentRuntime = ref.parentRuntime;
      const parentToolCallId: string = ref.__currentToolCallId || `spawn_${nanoid(6)}`;
      const parentCtx: Record<string, any> = ref.ctx || (ref.ctx = {});

      const record = parentCtx.__subagentPending?.[parentToolCallId] as SubagentPendingRecord | undefined;
      const spec = record?.adhoc
        ? await specFromAdhoc(record.adhoc, d, parentRuntime)
        : await specFromAdhoc(args, d, parentRuntime);
      if (!record) {
        const depth = withinDepth(Number(parentCtx.__delegationDepth) || 0, d.policy);
        if (!depth.ok) return { error: depth.reason };
        const budget = canSpawn(d.registryRef, d.policy, 1);
        if (!budget.ok) return { error: budget.reason };
        d.registryRef.spawnedCount += 1;
      }
      return toToolReturn(await runChild(spec, record?.input ?? args.input, d, ref, { allowHITL: true, parentToolCallId, isResume: !!record, record }));
    },
  });
  (tool as any)._deps = deps;
  (tool as any)._stateRef = {};
  (tool as any).__source = "smart-subagents";
  return tool;
}

export function createParallelTool(deps: SubagentToolDeps): ToolInterface {
  const tool = createTool({
    name: "spawn_subagents_parallel",
    description: deps.descriptions?.parallel ?? DEFAULT_PARALLEL_DESCRIPTION,
    schema: z
      .object({
        tasks: z
          .array(
            z
              .object({
                subagent: z.string().optional().describe("Registry sub-agent name."),
                role: z.string().optional().describe("Ad-hoc role (when not using `subagent`)."),
                prompt: z.string().optional(),
                tools: z.array(z.string().min(1)).optional(),
                input: z.string().min(1),
              })
              .strict(),
          )
          .min(1)
          .max(16)
          .describe("Independent subtasks to run concurrently."),
      })
      .strict(),
    func: async ({ tasks }: { tasks: Array<{ subagent?: string; role?: string; prompt?: string; tools?: string[]; input: string }> }) => {
      const ref: any = (tool as any)._stateRef || {};
      const d = (tool as any)._deps as SubagentToolDeps;
      const parentRuntime = ref.parentRuntime;
      const parentToolCallId: string = ref.__currentToolCallId || `parallel_${nanoid(6)}`;
      const parentCtx: Record<string, any> = ref.ctx || (ref.ctx = {});

      const depth = withinDepth(Number(parentCtx.__delegationDepth) || 0, d.policy);
      if (!depth.ok) return { error: depth.reason };

      // Resolve specs first (validation), then charge the spawn budget only for
      // the tasks that will actually spawn a child (invalid tasks short-circuit
      // to an error result and must not consume the per-run child-call budget).
      const specs: Array<{ spec: ResolvedSpec; input: string } | { error: string; input: string }> = [];
      for (const task of tasks) {
        if (task.subagent) {
          const def = findSubagent(d.subagents, task.subagent);
          if (!def) { specs.push({ error: `Unknown sub-agent: ${task.subagent}`, input: task.input }); continue; }
          specs.push({ spec: await specFromRegistry(def, d, parentRuntime), input: task.input });
        } else if (task.role) {
          if (d.policy.mode !== "registry_and_adhoc") { specs.push({ error: "Ad-hoc sub-agents are disabled.", input: task.input }); continue; }
          specs.push({ spec: await specFromAdhoc({ role: task.role, prompt: task.prompt, tools: task.tools }, d, parentRuntime), input: task.input });
        } else {
          specs.push({ error: "Each task needs either `subagent` or `role`.", input: task.input });
        }
      }

      const spawnCount = specs.filter((entry) => !("error" in entry)).length;
      const budget = canSpawn(d.registryRef, d.policy, spawnCount);
      if (!budget.ok) return { error: budget.reason };
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
            results[i] = { name: "?", mode: "adhoc", input: entry.input, error: entry.error };
            continue;
          }
          const outcome = await runChild(entry.spec, entry.input, d, ref, {
            allowHITL: false,
            parentToolCallId: `${parentToolCallId}#${i}`,
            parallel: true,
          });
          results[i] = outcome.kind === "result"
            ? outcome.result
            : { name: entry.spec.name, mode: entry.spec.mode, input: entry.input, error: "Unexpected pause in parallel child." };
        }
      };
      await Promise.all(Array.from({ length: concurrency }, () => worker()));
      return { results };
    },
  });
  (tool as any)._deps = deps;
  (tool as any)._stateRef = {};
  (tool as any).__source = "smart-subagents";
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
