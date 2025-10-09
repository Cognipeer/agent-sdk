// A minimal agent builder: no system prompt, no summarization, with tool limit and optional structured output finalize.
import type { AgentResult as AgentInvokeResult, InvokeConfig, AgentEvent as SmartAgentEvent, AgentOptions as SmartAgentOptions, AgentState as SmartState, AgentInstance as SmartAgentInstance, AgentRuntimeConfig, HandoffDescriptor, GuardrailOutcome, AgentSnapshot, SnapshotOptions, RestoreSnapshotOptions, ToolApprovalResolution } from "./types.js";
import { GuardrailPhase } from "./types.js";
import { z, ZodSchema } from "zod";
import { createResolverNode } from "./nodes/resolver.js";
import { createAgentCoreNode } from "./nodes/agentCore.js";
import { createToolsNode } from "./nodes/tools.js";
import { createToolLimitFinalizeNode } from "./nodes/toolLimitFinalize.js";
import { createTool } from "./tool.js";
import { createTraceSession, finalizeTraceSession } from "./utils/tracing.js";
import { evaluateGuardrails } from "./guardrails/engine.js";
import { captureSnapshot, restoreSnapshot } from "./utils/stateSnapshot.js";
import { resolveToolApprovalState } from "./utils/toolApprovals.js";

export function createAgent<TOutput = unknown>(opts: SmartAgentOptions & { outputSchema?: ZodSchema<TOutput> }): SmartAgentInstance<TOutput> {
  const resolver = createResolverNode();
  const agentCore = createAgentCoreNode(opts);
  // Prepare tools list: base tools + structured output finalize if schema provided
  const toolsBase = [...((opts.tools as any) ?? [])];
  if (opts.outputSchema) {
  const responseTool = createTool({
      name: 'response',
      description: 'Finalize the answer by returning the final structured JSON matching the required schema. Call exactly once when you are fully done, then stop.',
      schema: opts.outputSchema as any,
      func: async (data: any) => ({ __finalStructuredOutput: true, data }),
    });
    toolsBase.push(responseTool);
  }
  const toolsNode = createToolsNode(toolsBase, opts);
  const finalizeNode = createToolLimitFinalizeNode(opts);

  type GuardrailStore = { lastRequestLength: number; lastResponseLength: number };

  const mergeGuardrailOutcomes = (
    prev: GuardrailOutcome | undefined,
    next: GuardrailOutcome
  ): GuardrailOutcome => {
    if (!prev) return next;
    return {
      ok: prev.ok && next.ok,
      incidents: [...prev.incidents, ...next.incidents],
    };
  };

  const ensureGuardrailStore = (state: SmartState): GuardrailStore => {
    const ctx = (state.ctx = state.ctx || {});
    const existing = (ctx.__guardrailStore as GuardrailStore | undefined) || {
      lastRequestLength: -1,
      lastResponseLength: -1,
    };
    ctx.__guardrailStore = existing;
    return existing;
  };

  const getGuardrailConfig = (state: SmartState) => {
    const agentGuardrails = state.agent?.guardrails;
    return Array.isArray(agentGuardrails)
      ? agentGuardrails
      : Array.isArray(opts.guardrails)
      ? opts.guardrails
      : [];
  };

  const runtime: AgentRuntimeConfig = {
    name: opts.name,
    version: opts.version,
    model: opts.model,
    tools: toolsBase,
    guardrails: opts.guardrails,
    systemPrompt: undefined,
    limits: opts.limits,
    useTodoList: undefined,
    outputSchema: opts.outputSchema as any,
    tracing: opts.tracing,
  };

  async function runLoop(
    initial: SmartState,
    config: InvokeConfig | undefined,
    emit?: (event: SmartAgentEvent) => void
  ): Promise<SmartState> {
    let state = await resolver(initial);
    if (state.ctx?.__paused) {
      const nextCtx = { ...state.ctx };
      delete nextCtx.__paused;
      state = { ...state, ctx: Object.keys(nextCtx).length > 0 ? nextCtx : undefined } as SmartState;
    }
    let resumeStage: "tools" | null = null;
    if (state.ctx?.__resumeStage) {
      const nextCtx = { ...state.ctx };
      if (nextCtx.__resumeStage === "tools") {
        resumeStage = "tools";
      }
      delete nextCtx.__resumeStage;
      state = { ...state, ctx: Object.keys(nextCtx).length > 0 ? nextCtx : undefined } as SmartState;
    }

    const maxToolCalls = (opts.limits?.maxToolCalls ?? 10) as number;
    const iterationLimit = Math.max(maxToolCalls * 3 + 10, 40);
    let iterations = 0;
    const onStateChange = config?.onStateChange;
    const checkpointReason = config?.checkpointReason;
    let pausedStage: string | null = null;

    const checkpointIfRequested = (stage: string) => {
      if (typeof onStateChange !== "function") return false;
      let result = false;
      try {
        result = onStateChange(state);
      } catch {
        result = false;
      }
      if (!result) return false;
      const ctx = { ...(state.ctx || {}) };
      ctx.__paused = {
        stage,
        iteration: iterations,
        reason: checkpointReason,
        timestamp: new Date().toISOString(),
      };
      state = { ...state, ctx } as SmartState;
      pausedStage = stage;
      return true;
    };

    while (iterations < iterationLimit) {
      iterations++;

      const skippingAgent = resumeStage === "tools";
      if (!skippingAgent) {
        if (checkpointIfRequested("before_guardrails")) break;

        const preGuardrails = getGuardrailConfig(state);
        if (preGuardrails.length > 0) {
          const store = ensureGuardrailStore(state);
          if (store.lastRequestLength !== state.messages.length) {
            const outcome = await evaluateGuardrails({
              guardrails: preGuardrails,
              phase: GuardrailPhase.Request,
              state,
              runtime: state.agent || runtime,
              options: opts,
              emit,
            });
            store.lastRequestLength = state.messages.length;
            state.guardrailResult = mergeGuardrailOutcomes(state.guardrailResult, outcome);
            const blocking = outcome.incidents.find((incident) => incident.disposition === "block");
            if (blocking) {
              const guardMessage: any = {
                role: "assistant",
                name: "guardrail",
                content: blocking.reason || "Request blocked by guardrail policy.",
                metadata: {
                  guardrail: {
                    phase: GuardrailPhase.Request,
                    incidents: outcome.incidents,
                  },
                },
              };
              state = { ...state, messages: [...state.messages, guardMessage] } as SmartState;
              const ctx = (state.ctx = state.ctx || {});
              (ctx as any).__guardrailBlocked = {
                phase: GuardrailPhase.Request,
                incident: blocking,
              };
              break;
            }
          }
        }

        // Agent step
  state = { ...state, ...(await agentCore(state)) } as SmartState;

  if (checkpointIfRequested("after_agent")) break;

        const postGuardrails = getGuardrailConfig(state);
        if (postGuardrails.length > 0) {
          const store = ensureGuardrailStore(state);
          if (store.lastResponseLength !== state.messages.length) {
            const outcome = await evaluateGuardrails({
              guardrails: postGuardrails,
              phase: GuardrailPhase.Response,
              state,
              runtime: state.agent || runtime,
              options: opts,
              emit,
            });
            store.lastResponseLength = state.messages.length;
            state.guardrailResult = mergeGuardrailOutcomes(state.guardrailResult, outcome);
            const blocking = outcome.incidents.find((incident) => incident.disposition === "block");
            if (blocking) {
              const updatedMessages = [...state.messages];
              const replaced = updatedMessages.pop();
              updatedMessages.push({
                role: "assistant",
                name: "guardrail",
                content: blocking.reason || "Response blocked by guardrail policy.",
                metadata: {
                  guardrail: {
                    phase: GuardrailPhase.Response,
                    incidents: outcome.incidents,
                    replaced,
                  },
                },
              } as any);
              state = { ...state, messages: updatedMessages } as SmartState;
              const ctx = (state.ctx = state.ctx || {});
              (ctx as any).__guardrailBlocked = {
                phase: GuardrailPhase.Response,
                incident: blocking,
                replaced,
              };
              break;
            } else if (outcome.incidents.length > 0) {
              const last = state.messages[state.messages.length - 1] as any;
              if (last) {
                last.metadata = {
                  ...(last.metadata || {}),
                  guardrail: {
                    phase: GuardrailPhase.Response,
                    incidents: outcome.incidents,
                  },
                };
              }
            }
          }
        }
      } else {
        resumeStage = null;
      }

      const lastMsg: any = state.messages[state.messages.length - 1];
      const toolCalls: any[] = Array.isArray(lastMsg?.tool_calls) ? lastMsg.tool_calls : [];
      const toolCallCount = state.toolCallCount || 0;

      // Tool limit finalize gate
      if (state.ctx?.__finalizedDueToToolLimit) {
        break;
      }
      if (toolCallCount >= maxToolCalls && toolCalls.length > 0) {
        state = { ...state, ...(await finalizeNode(state)) } as SmartState;
        // One more assistant turn will occur, but without more tools ideally
        continue;
      }

      if (toolCalls.length === 0) break;

      // Run tools
      state = { ...state, ...(await toolsNode(state)) } as SmartState;
      if (state.ctx?.__awaitingApproval) break;
      if (checkpointIfRequested("after_tools")) break;
      if (state.ctx?.__finalizedDueToStructuredOutput) break;
    }

    if (!pausedStage && typeof onStateChange === "function" && onStateChange(state)) {
      checkpointIfRequested("after_loop");
    }

    return state;
  }

  const invokeAgent = async (input: SmartState, config?: InvokeConfig): Promise<AgentInvokeResult<TOutput>> => {
    const onEvent = config?.onEvent;
    const emit = (e: SmartAgentEvent) => { try { onEvent?.(e); } catch {} };
    const traceSession = createTraceSession(opts);

    const ctx: Record<string, any> = { ...(input.ctx || {}), __onEvent: onEvent };
    if (traceSession) ctx.__traceSession = traceSession;

    const initial: SmartState = {
      messages: input.messages || [],
      summaries: input.summaries || [],
      toolCallCount: input.toolCallCount || 0,
      toolCache: input.toolCache || {},
      toolHistory: input.toolHistory || [],
      toolHistoryArchived: input.toolHistoryArchived || [],
      metadata: input.metadata,
      ctx,
      plan: input.plan || null,
      planVersion: input.planVersion || 0,
      pendingApprovals: input.pendingApprovals || [],
      agent: input.agent || runtime,
      usage: input.usage || { perRequest: [], totals: {} },
    };

    let res: SmartState;
    try {
      res = await runLoop(initial, config, emit);
    } catch (err: any) {
      await finalizeTraceSession(traceSession, {
        agentRuntime: runtime,
        status: "error",
        error: { message: err?.message, stack: err?.stack },
      });
      throw err;
    }

    await finalizeTraceSession(traceSession, {
      agentRuntime: res.agent || runtime,
      status: "success",
    });

    const finalMsg = res.messages[res.messages.length - 1];
    let content = "";
    if (typeof finalMsg?.content === "string") content = finalMsg.content;
    else if (Array.isArray(finalMsg?.content)) content = finalMsg.content.map((c: any) => (typeof c === "string" ? c : c?.text ?? c?.content ?? "")).join("");

    let parsed: TOutput | undefined = undefined;
    const schema = opts.outputSchema as ZodSchema<TOutput> | undefined;
    if (schema && (res as any).ctx?.__structuredOutputParsed) {
      parsed = (res as any).ctx.__structuredOutputParsed as TOutput;
    } else if (schema && content) {
      // Fallback: try to parse JSON from assistant message
      let jsonText: string | null = null;
      const fenced = content.match(/```(?:json)?\n([\s\S]*?)```/i);
      if (fenced && fenced[1]) jsonText = fenced[1].trim();
      else {
        const braceIdx = content.indexOf("{");
        const bracketIdx = content.indexOf("[");
        const start = [braceIdx, bracketIdx].filter(i => i >= 0).sort((a, b) => a - b)[0];
        if (start !== undefined) jsonText = content.slice(start).trim();
      }
      try {
        const raw = JSON.parse(jsonText ?? content);
        parsed = schema.parse(raw) as TOutput;
      } catch {}
    }

    emit({ type: "finalAnswer", content: typeof finalMsg?.content === 'string' ? finalMsg.content : content });

    return {
      content,
      output: parsed as TOutput | undefined,
      metadata: { usage: (res as any).usage },
      messages: res.messages,
      state: res as SmartState,
    };
  };

  const snapshotState = (state: SmartState, options?: SnapshotOptions) => captureSnapshot(state, options);

  const resumeAgent = async (snapshot: AgentSnapshot, config?: InvokeConfig, restoreOptions?: RestoreSnapshotOptions) => {
    const restoredState = restoreSnapshot(snapshot, restoreOptions);
    return invokeAgent(restoredState, config);
  };

  const resolveToolApproval = (state: SmartState, resolution: ToolApprovalResolution) =>
    resolveToolApprovalState(state, resolution);

  const instance: SmartAgentInstance<TOutput> = {
    invoke: invokeAgent,
    snapshot: snapshotState,
    resume: resumeAgent,
    resolveToolApproval,
    asTool: ({ toolName, description, inputDescription }: { toolName: string; description?: string; inputDescription?: string }) => {
      const schema = z.object({ input: z.string().describe(inputDescription || "Input for delegated agent") });
  return createTool({
        name: toolName,
        description: description || `Delegate task to agent ${opts.name || 'Agent'}`,
        schema,
        func: async ({ input }) => {
          const res = await instance.invoke({ messages: [{ role: 'user', content: input } as any] });
          return { content: res.content };
        }
      });
    },
    asHandoff: ({ toolName, description, schema }: { toolName?: string; description?: string; schema?: ZodSchema<any>; }): HandoffDescriptor => {
      const finalName = toolName || `handoff_to_${runtime.name || 'agent'}`;
      const zschema = schema || z.object({ reason: z.string().describe('Reason for handoff') });
      createTool({
        name: finalName,
        description: description || `Handoff control to agent ${runtime.name || 'Agent'}`,
        schema: zschema,
        func: async (_args: any) => ({ __handoff: { runtime } })
      });
      return { type: 'handoff', toolName: finalName, description: description || '', schema: zschema, target: instance } as any;
    },
    __runtime: runtime,
  };

  if (opts.handoffs && Array.isArray(opts.handoffs)) {
    const handoffTools = opts.handoffs.map(h => {
      const schema = h.schema || z.object({ reason: z.string().describe('Reason for handoff') });
  return createTool({
        name: h.toolName,
        description: h.description || `Handoff to ${h.target.__runtime.name || 'agent'}`,
        schema,
        func: async (_args: any) => ({ __handoff: { runtime: h.target.__runtime } })
      });
    });
    runtime.tools = [...runtime.tools, ...handoffTools];
  }

  return instance;
}
