// A minimal agent builder: no system prompt, no summarization, with tool limit and optional structured output finalize.
import type { AgentInvokeResult, InvokeConfig, SmartAgentEvent, AgentOptions, AgentState, AgentInstance, AgentRuntimeConfig, HandoffDescriptor, GuardrailOutcome, AgentSnapshot, SnapshotOptions, RestoreSnapshotOptions, ToolApprovalResolution } from "./types.js";
import { GuardrailPhase } from "./types.js";
import { z, ZodSchema } from "zod";
import { createResolverNode } from "./nodes/resolver.js";
import { createAgentCoreNode } from "./nodes/agentCore.js";
import { createToolsNode } from "./nodes/tools.js";
import { createToolLimitFinalizeNode } from "./nodes/toolLimitFinalize.js";
import { createTool } from "./tool.js";
import { createTraceSession, finalizeTraceSession, startStreamingSession, recordTraceEvent } from "./utils/tracing.js";
import { evaluateGuardrails } from "./guardrails/engine.js";
import { captureSnapshot, restoreSnapshot } from "./utils/stateSnapshot.js";
import { resolveToolApprovalState } from "./utils/toolApprovals.js";
import { countMessagesTokens } from "./utils/utilTokens.js";

function isSyntheticSummaryMessage(message: any): boolean {
  if (!message) return false;
  if (message.role === 'tool' && message.name === 'summarize_context') {
    return true;
  }

  if (message.role === 'assistant' && Array.isArray(message.tool_calls)) {
    return message.tool_calls.some((toolCall: any) => {
      const toolName = toolCall?.function?.name || toolCall?.name;
      return toolName === 'summarize_context';
    });
  }

  return false;
}

function getMessageText(message: any): string {
  if (typeof message?.content === "string") return message.content;
  if (Array.isArray(message?.content)) {
    return message.content
      .map((chunk: any) => (typeof chunk === "string" ? chunk : chunk?.text ?? chunk?.content ?? ""))
      .join("");
  }
  return "";
}

function getLastAssistantMessage(messages: any[]): any | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]?.role === "assistant") {
      return messages[index];
    }
  }
  return undefined;
}

export function createAgent<TOutput = unknown>(opts: AgentOptions & { outputSchema?: ZodSchema<TOutput> }): AgentInstance<TOutput> {
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

  const ensureGuardrailStore = (state: AgentState): GuardrailStore => {
    const ctx = (state.ctx = state.ctx || {});
    const existing = (ctx.__guardrailStore as GuardrailStore | undefined) || {
      lastRequestLength: -1,
      lastResponseLength: -1,
    };
    ctx.__guardrailStore = existing;
    return existing;
  };

  const getGuardrailConfig = (state: AgentState) => {
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
    todoListPrompt: opts.todoListPrompt,
    limits: opts.limits,
    useTodoList: undefined,
    outputSchema: opts.outputSchema as any,
    tracing: opts.tracing,
  };

  async function runLoop(
    initial: AgentState,
    config: InvokeConfig | undefined,
    emit?: (event: SmartAgentEvent) => void
  ): Promise<AgentState> {
    let state = await resolver(initial);
    if (state.ctx?.__paused) {
      const nextCtx = { ...state.ctx };
      delete nextCtx.__paused;
      state = { ...state, ctx: Object.keys(nextCtx).length > 0 ? nextCtx : undefined } as AgentState;
    }
    let resumeStage: "tools" | null = null;
    if (state.ctx?.__resumeStage) {
      const nextCtx = { ...state.ctx };
      if (nextCtx.__resumeStage === "tools") {
        resumeStage = "tools";
      }
      delete nextCtx.__resumeStage;
      state = { ...state, ctx: Object.keys(nextCtx).length > 0 ? nextCtx : undefined } as AgentState;
    }

    const mergedLimits = {
      ...(opts.limits || {}),
      ...((config?.limits || {}) as any),
    } as AgentOptions["limits"];

    const maxToolCalls = (mergedLimits?.maxToolCalls === undefined) ? 50 : mergedLimits?.maxToolCalls;
    const iterationLimit = maxToolCalls === Infinity ? 100 : Math.max(maxToolCalls * 3 + 10, 40);
    let iterations = 0;
    const onStateChange = config?.onStateChange;
    const checkpointReason = config?.checkpointReason;
    let pausedStage: string | null = null;

    const onProgress = (state.ctx as any)?.__onProgress as ((progress: { stage?: string; message?: string; percent?: number; detail?: any }) => void) | undefined;

    const isCancelled = () => {
      const ctx: any = state.ctx || {};
      const token = ctx.__cancellationToken as any;
      const signal = ctx.__abortSignal as AbortSignal | undefined;
      const deadline = ctx.__deadline as number | undefined;
      if (signal?.aborted) return { cancelled: true, reason: "aborted" };
      if (token && token.isCancellationRequested) return { cancelled: true, reason: "cancelled" };
      if (deadline && Date.now() > deadline) return { cancelled: true, reason: "timeout" };
      return { cancelled: false, reason: undefined } as const;
    };

    const cancelIfRequested = (stage: string) => {
      const result = isCancelled();
      if (!result.cancelled) return false;
      const ctx = { ...(state.ctx || {}) } as any;
      ctx.__cancelled = { stage, reason: result.reason, timestamp: new Date().toISOString() };
      state = { ...state, ctx } as AgentState;
      emit?.({ type: "cancelled", stage, reason: result.reason });
      onProgress?.({ stage, message: "Cancelled", detail: { reason: result.reason } });
      return true;
    };

    const checkpointIfRequested = (stage: string) => {
      if (typeof onStateChange !== "function") return false;
      let result = false;
      try {
        result = onStateChange(state);
      } catch (err) {
        console.warn('[agent-sdk] onStateChange callback error:', err);
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
      state = { ...state, ctx } as AgentState;
      pausedStage = stage;
      return true;
    };

    while (iterations < iterationLimit) {
      iterations++;

      // Open an iteration span as parent for all ai_call / tool_call events in this turn
      const traceSession = state.ctx?.__traceSession as import("./types.js").TraceSessionRuntime | undefined;
      if (traceSession) {
        const iterEvent = recordTraceEvent(traceSession, {
          type: "agent_iteration",
          label: `Iteration ${iterations}`,
          actor: { scope: "agent", name: opts.name || "agent", role: "orchestrator" },
          parentSpanId: traceSession.rootSpanId,
        });
        // Override the spanId for the iteration event so children reference it
        if (iterEvent) {
          traceSession.currentIterationSpanId = iterEvent.spanId;
        }
      }

      if (cancelIfRequested("loop")) break;

      const skippingAgent = resumeStage === "tools";
      if (!skippingAgent) {
        if (cancelIfRequested("before_guardrails")) break;
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
              state = { ...state, messages: [...state.messages, guardMessage] } as AgentState;
              const ctx = (state.ctx = state.ctx || {});
              (ctx as any).__guardrailBlocked = {
                phase: GuardrailPhase.Request,
                incident: blocking,
              };
              break;
            }
          }
        }

        // Check if context is too large and needs summarization (signal to SmartAgent).
        // Use summaryTriggerTokens (the intended threshold) rather than maxTokens
        // (which controls summary output size) to avoid premature compaction.
        let maxTok: number | undefined;
        if ((opts as any).summarization && typeof (opts as any).summarization === 'object') {
          maxTok = (opts as any).summarization.summaryTriggerTokens || (opts as any).summarization.maxTokens;
        }
        if (maxTok === undefined) {
          maxTok = 50000; // Default if not found
        }

        if (maxTok) {
          // Exclude synthetic summary messages AND context overhead injected by SmartAgent's
          // buildModelMessages (context_summary, memory_context). These system messages are
          // added on top of the conversation and shouldn't trigger re-summarization.
          const tokCountMessages = (state.messages || []).filter((message: any) => {
            if (isSyntheticSummaryMessage(message)) return false;
            if (message.role === 'system' && (message.name === 'context_summary' || message.name === 'memory_context')) return false;
            return true;
          });
          const tokenCount = countMessagesTokens(tokCountMessages);
          if (tokenCount > maxTok) {
            // Only signal summarization if tokens exceed the threshold by a meaningful margin
            // or if summarization hasn't just been performed (prevents infinite break loops
            // where summarized output + context overhead barely exceeds the limit).
            const hasFreshSummary = (state.messages || []).some((m: any) =>
              m.role === 'tool'
              && typeof m.content === 'string'
              && (m.content === 'SUMMARIZED' || m.content.startsWith('SUMMARIZED_TOOL_RESPONSE'))
            );
            if (hasFreshSummary && tokenCount <= maxTok * 1.15) {
              // Summarization was recently performed and the overshoot is within 15%.
              // Proceed to agent call instead of re-triggering summarization.
            } else {
              const ctx = { ...(state.ctx || {}), __needsSummarization: true };
              state = { ...state, ctx } as AgentState;
              break;
            }
          }
        }

          // Agent step
          onProgress?.({ stage: "agent", message: "Invoking model" });
          if (cancelIfRequested("before_agent")) break;
          state = { ...state, ...(await agentCore(state)) } as AgentState;
          onProgress?.({ stage: "agent", message: "Model response received" });

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
              state = { ...state, messages: updatedMessages } as AgentState;
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
        state = { ...state, ...(await finalizeNode(state)) } as AgentState;
        // One more assistant turn will occur, but without more tools ideally
        continue;
      }

      if (toolCalls.length === 0) break;

      // Run tools
      onProgress?.({ stage: "tools", message: "Running tools" });
      if (cancelIfRequested("before_tools")) break;
      state = { ...state, ...(await toolsNode(state)) } as AgentState;
      onProgress?.({ stage: "tools", message: "Tools finished" });
      if (state.ctx?.__awaitingApproval) break;
      if (checkpointIfRequested("after_tools")) break;
      if (state.ctx?.__finalizedDueToStructuredOutput) break;
    }

    // Best-effort: if a structured output schema is active but the model never called `response`,
    // append a force-finalize instruction and allow one more agent turn (without tools ideally).
    // This helps avoid "completed but no response generated" situations.
    if (opts.outputSchema && !(state as any).ctx?.__finalizedDueToStructuredOutput) {
      const last: any = state.messages[state.messages.length - 1];
      const lastHasToolCalls = Array.isArray(last?.tool_calls) && last.tool_calls.length > 0;

      // Only nudge if we appear to be done (no pending tool calls) but still no structured finalize.
      if (!lastHasToolCalls) {
        const forceMsg = {
          role: "system",
          content: [
            "A structured output schema is active.",
            "You MUST now call tool `response` with the final JSON object that matches the schema.",
            "Do not write the JSON in the assistant message.",
            "Call `response` exactly once, then stop.",
          ].join("\n"),
        } as any;

        // Avoid spamming the same instruction
        const alreadyForced = Boolean((state as any).ctx?.__structuredOutputForceFinalize);
        if (!alreadyForced) {
          const ctx = { ...(state.ctx || {}), __structuredOutputForceFinalize: true };
          state = { ...state, messages: [...state.messages, forceMsg], ctx } as AgentState;
          try {
            state = { ...state, ...(await agentCore(state)) } as AgentState;
            const lastAfter: any = state.messages[state.messages.length - 1];
            const toolCallsAfter: any[] = Array.isArray(lastAfter?.tool_calls) ? lastAfter.tool_calls : [];
            if (toolCallsAfter.length > 0) {
              state = { ...state, ...(await toolsNode(state)) } as AgentState;
            }
          } catch (err: unknown) {
            // Log structured output force-finalize error so callers can diagnose failures
            const errMsg = err instanceof Error ? err.message : String(err);
            emit?.({ type: "metadata", error: `Structured output force-finalize failed: ${errMsg}` });
            throw err;
          }
        }
      }
    }

    if ((state as any).ctx?.__needsSummarization && !(opts as any)?.summarization) {
      throw new Error(
        "Agent context exceeded the available budget before a final assistant response could be generated. Reduce tool response size or use createSmartAgent with summarization enabled."
      );
    }

    // Safety: detect abnormal loop exit where the last message is a tool response
    // but no valid exit condition is active (approval, cancellation, checkpoint,
    // structured-output finalize, summarization signal).
    // This catches edge cases like exhausted iteration budget or silent model errors
    // that would otherwise leak raw tool output to the caller.
    const lastAfterLoop = state.messages[state.messages.length - 1] as any;
    if (lastAfterLoop?.role === 'tool' && !pausedStage) {
      const isExpectedExit =
        state.ctx?.__awaitingApproval ||
        state.ctx?.__cancelled ||
        state.ctx?.__finalizedDueToStructuredOutput ||
        state.ctx?.__finalizedDueToToolLimit ||
        state.ctx?.__needsSummarization;
      if (!isExpectedExit) {
        throw new Error(
          "Agent loop terminated with a pending tool response but no subsequent model invocation. " +
          "This usually indicates a model provider error or exhausted iteration budget."
        );
      }
    }

    if (!pausedStage && typeof onStateChange === "function" && onStateChange(state)) {
      checkpointIfRequested("after_loop");
    }

    return state;
  }

  const invokeAgent = async (input: AgentState, config?: InvokeConfig): Promise<AgentInvokeResult<TOutput>> => {
    const onEvent = config?.onEvent;
    const onProgress = config?.onProgress;
    const onStream = config?.onStream;
    const streamEnabled = config?.stream === true;
    const emit = (e: SmartAgentEvent) => { try { onEvent?.(e); } catch (err) { console.warn('[agent-sdk] onEvent callback error:', err); } };
    const emitProgress = (progress: { stage?: string; message?: string; percent?: number; detail?: any }) => {
      try { onProgress?.(progress); } catch (err) { console.warn('[agent-sdk] onProgress callback error:', err); }
      emit({ type: "progress", ...progress });
    };
    const traceSession = createTraceSession(opts);

    const ctx: Record<string, any> = {
      ...(input.ctx || {}),
      __onEvent: onEvent,
      __onProgress: emitProgress,
      __onStream: onStream,
      __streaming: streamEnabled,
    };
    if (traceSession) ctx.__traceSession = traceSession;
    if (config?.cancellationToken) ctx.__cancellationToken = config.cancellationToken;
    if ((config?.cancellationToken as AbortSignal | undefined)?.aborted !== undefined) {
      ctx.__abortSignal = config?.cancellationToken as AbortSignal;
    }
    if (config?.timeoutMs && config.timeoutMs > 0) {
      ctx.__deadline = Date.now() + config.timeoutMs;
    }

    const runtimeWithInvokeLimits: AgentRuntimeConfig = config?.limits
      ? { ...runtime, limits: { ...(runtime.limits || {}), ...config.limits } }
      : runtime;

    const initial: AgentState = {
      messages: input.messages || [],
      toolCallCount: input.toolCallCount || 0,
      toolCache: input.toolCache || {},
      toolHistory: input.toolHistory || [],
      metadata: input.metadata,
      ctx,
      pendingApprovals: input.pendingApprovals || [],
      agent: input.agent || runtimeWithInvokeLimits,
      usage: input.usage || { perRequest: [], totals: {} },
    };

    let res: AgentState;
    try {
      await startStreamingSession(traceSession, runtimeWithInvokeLimits);
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

    const finalAssistantMsg = getLastAssistantMessage(res.messages);
    const content = getMessageText(finalAssistantMsg);

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

    emit({ type: "finalAnswer", content });
    if (streamEnabled && content) {
      onStream?.({ text: content, isFinal: true });
      emit({ type: "stream", text: content, isFinal: true });
    }

    return {
      content,
      output: parsed as TOutput | undefined,
      metadata: { usage: (res as any).usage },
      messages: res.messages,
      state: res as AgentState,
    };
  };

  const snapshotState = (state: AgentState, options?: SnapshotOptions) => captureSnapshot(state, options);

  const resumeAgent = async (snapshot: AgentSnapshot, config?: InvokeConfig, restoreOptions?: RestoreSnapshotOptions) => {
    const restoredState = restoreSnapshot(snapshot, restoreOptions);
    return invokeAgent(restoredState, config);
  };

  const resolveToolApproval = (state: AgentState, resolution: ToolApprovalResolution) =>
    resolveToolApprovalState(state, resolution);

  const instance: AgentInstance<TOutput> = {
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
          return {
            content: res.content,
            output: res.output,
            summary: res.state?.summaries?.[res.state.summaries.length - 1],
          };
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
