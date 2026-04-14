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
import { StructuredOutputManager } from "./structuredOutput/manager.js";
import { resolveStrategy, getModelCapabilities } from "./structuredOutput/resolver.js";
import type { StructuredOutputError } from "./structuredOutput/types.js";

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

function getActiveSummarizationThreshold(opts: AgentOptions): number | undefined {
  const summarization = (opts as any).summarization;
  if (!summarization || typeof summarization !== "object" || summarization.enable === false) {
    return undefined;
  }

  return (
    summarization.summaryTriggerTokens
    || summarization.maxTokens
    || opts.limits?.maxContextTokens
    || 50000
  );
}

function clearNeedsSummarization(state: AgentState): AgentState {
  if (!(state.ctx as any)?.__needsSummarization) {
    return state;
  }

  const nextCtx = { ...(state.ctx || {}) } as Record<string, unknown>;
  delete nextCtx.__needsSummarization;

  return {
    ...state,
    ctx: Object.keys(nextCtx).length > 0 ? nextCtx : undefined,
  } as AgentState;
}

export function createAgent<TOutput = unknown>(opts: AgentOptions & { outputSchema?: ZodSchema<TOutput> }): AgentInstance<TOutput> {
  const resolver = createResolverNode();
  const agentCore = createAgentCoreNode(opts);
  // Prepare tools list: base tools + structured output finalize if schema provided
  const toolsBase = [...((opts.tools as any) ?? [])];

  // Structured output manager: resolves strategy (native vs tool-based) based on model capabilities
  const soManager = opts.outputSchema
    ? new StructuredOutputManager<TOutput>(opts.outputSchema, resolveStrategy(opts.model))
    : undefined;

  if (soManager) {
    const modelCapabilities = getModelCapabilities(opts.model);
    const responseTool = soManager.getResponseTool();
    // Hard guard: when model supports native structured output, never attach the fallback response tool.
    if (responseTool && modelCapabilities.structuredOutput !== "native") {
      toolsBase.push(responseTool);
    }
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
    responseFormat: soManager?.getResponseFormat(),
    tracing: opts.tracing,
  };
  const summarizationThreshold = getActiveSummarizationThreshold(opts);

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

    if (summarizationThreshold === undefined) {
      state = clearNeedsSummarization(state);
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
        if (summarizationThreshold !== undefined) {
          // Exclude synthetic summary messages AND context overhead injected by SmartAgent's
          // buildModelMessages (context_summary, memory_context). These system messages are
          // added on top of the conversation and shouldn't trigger re-summarization.
          const tokCountMessages = (state.messages || []).filter((message: any) => {
            if (isSyntheticSummaryMessage(message)) return false;
            if (message.role === 'system' && (message.name === 'context_summary' || message.name === 'memory_context')) return false;
            return true;
          });
          const tokenCount = countMessagesTokens(tokCountMessages);
          if (tokenCount > summarizationThreshold) {
            // If SmartAgent already attempted summarization and it could not compress
            // anything (e.g. all tool responses use keep_full retention), breaking here
            // would create a deadlock: SmartAgent would re-invoke base, base would break
            // again, and no progress would ever be made.
            // When __summarizationExhausted is set, skip the break and let the agent
            // proceed with the available (clamped) context up to maxContextTokens.
            const summarizationExhausted = !!(state.ctx as any)?.__summarizationExhausted;

            // Only signal summarization if tokens exceed the threshold by a meaningful margin
            // or if summarization hasn't just been performed (prevents infinite break loops
            // where summarized output + context overhead barely exceeds the limit).
            const hasFreshSummary = (state.messages || []).some((m: any) =>
              m.role === 'tool'
              && typeof m.content === 'string'
              && (m.content === 'SUMMARIZED' || m.content.startsWith('SUMMARIZED_TOOL_RESPONSE'))
            );
            if (hasFreshSummary && tokenCount <= summarizationThreshold * 1.15) {
              // Summarization was recently performed and the overshoot is within 15%.
              // Proceed to agent call instead of re-triggering summarization.
            } else if (summarizationExhausted) {
              // Summarization was already attempted by SmartAgent but nothing could be
              // compressed (all tool responses are keep_full or no compressable messages).
              // Proceed with the current context instead of deadlocking.
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

      if (toolCalls.length === 0) {
        // If a structured output schema is active but the model produced a text response
        // instead of calling `response`, inject a one-time nudge and let the loop continue.
        // This keeps the full loop infrastructure (tool limits, summarization, etc.) available
        // for subsequent rounds instead of the fragile post-loop one-shot approach.
        if (
          soManager &&
          !(state as any).ctx?.__finalizedDueToStructuredOutput &&
          !(state as any).ctx?.__structuredOutputForceFinalize
        ) {
          const nudge = soManager.buildNudgeMessage(false);
          const ctx = { ...(state.ctx || {}), __structuredOutputForceFinalize: true };
          state = { ...state, messages: [...state.messages, nudge as any], ctx } as AgentState;
          continue;
        }
        break;
      }

      // Run tools
      onProgress?.({ stage: "tools", message: "Running tools" });
      if (cancelIfRequested("before_tools")) break;
      state = { ...state, ...(await toolsNode(state)) } as AgentState;
      onProgress?.({ stage: "tools", message: "Tools finished" });
      if (state.ctx?.__awaitingApproval) break;
      if (checkpointIfRequested("after_tools")) break;
      if (state.ctx?.__finalizedDueToStructuredOutput) break;
    }

    // Best-effort: if the loop exited with outputSchema active but the model stubbornly
    // never called `response` (even after the in-loop nudge), try a small retry loop.
    // Uses the StructuredOutputManager's centralized retry limit instead of scattered constants.
    if (soManager && !(state as any).ctx?.__finalizedDueToStructuredOutput) {
      const maxPostLoopRetries = soManager.maxRetries;
      for (let postRetry = 0; postRetry < maxPostLoopRetries; postRetry++) {
        if ((state as any).ctx?.__finalizedDueToStructuredOutput) break;

        const last: any = state.messages[state.messages.length - 1];
        const lastHasToolCalls = Array.isArray(last?.tool_calls) && last.tool_calls.length > 0;

        if (!lastHasToolCalls) {
          const isLastAttempt = postRetry === maxPostLoopRetries - 1;
          const nudge = soManager.buildNudgeMessage(isLastAttempt);
          state = { ...state, messages: [...state.messages, nudge as any] } as AgentState;
        }

        try {
          state = { ...state, ...(await agentCore(state)) } as AgentState;
          const lastAfter: any = state.messages[state.messages.length - 1];
          const toolCallsAfter: any[] = Array.isArray(lastAfter?.tool_calls) ? lastAfter.tool_calls : [];
          if (toolCallsAfter.length > 0) {
            state = { ...state, ...(await toolsNode(state)) } as AgentState;
          }
        } catch (err: unknown) {
          const errMsg = err instanceof Error ? err.message : String(err);
          emit?.({ type: "metadata", error: `Structured output force-finalize failed: ${errMsg}` });
          throw err;
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
    let outputError: StructuredOutputError | undefined = undefined;

    if (soManager) {
      if ((res as any).ctx?.__structuredOutputParsed) {
        // Primary path: tool-based finalization succeeded
        parsed = (res as any).ctx.__structuredOutputParsed as TOutput;
      } else if (content) {
        // Fallback: try to parse structured output from assistant message content
        const fallbackResult = soManager.parseFromContent(content);
        if (fallbackResult.success) {
          parsed = fallbackResult.data;
        } else {
          outputError = fallbackResult.error;
        }
      } else {
        // No content at all — report no_output error
        const noResult = soManager.noOutputResult(1);
        if (!noResult.success) {
          outputError = noResult.error;
        }
      }
    }

    emit({ type: "finalAnswer", content });
    if (streamEnabled && content) {
      onStream?.({ text: content, isFinal: true });
      emit({ type: "stream", text: content, isFinal: true });
    }

    return {
      content,
      output: parsed as TOutput | undefined,
      outputError,
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
