// A minimal agent builder: no system prompt, no summarization, with tool limit and optional structured output finalize.
import type { AgentInvokeResult, InvokeConfig, SmartAgentEvent, AgentOptions, AgentState, AgentInstance, AgentRuntimeConfig, HandoffDescriptor, GuardrailOutcome, AgentSnapshot, SnapshotOptions, RestoreSnapshotOptions, ToolApprovalResolution, UserQuestionResolution, HumanInTheLoopAskUserConfig } from "./types.js";
import { GuardrailPhase } from "./types.js";
import { z, ZodSchema } from "zod";
import { createResolverNode } from "./nodes/resolver.js";
import { createAgentCoreNode } from "./nodes/agentCore.js";
import { createToolsNode } from "./nodes/tools.js";
import { createToolLimitFinalizeNode } from "./nodes/toolLimitFinalize.js";
import { createReflectionNode, shouldRunReflection } from "./nodes/reflect.js";
import { resolveReasoning } from "./smart/reasoning.js";
import { createTool } from "./tool.js";
import { createTraceSession, finalizeTraceSession, startStreamingSession, recordTraceEvent } from "./utils/tracing.js";
import { evaluateGuardrails } from "./guardrails/engine.js";
import { captureSnapshot, restoreSnapshot } from "./utils/stateSnapshot.js";
import { resolveToolApprovalState } from "./utils/toolApprovals.js";
import { resolveUserQuestionState } from "./utils/userQuestions.js";
import { createAskUserQuestionTool } from "./humanLoop.js";
import { countMessagesTokens } from "./utils/utilTokens.js";
import { isSyntheticSummaryMessage } from "./utils/syntheticMessages.js";
import { extractMessageText } from "./utils/content.js";
import { StructuredOutputManager } from "./structuredOutput/manager.js";
import { resolveStrategy, getModelCapabilities } from "./structuredOutput/resolver.js";
import type { StructuredOutputError } from "./structuredOutput/types.js";

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

/**
 * Decision helper for summarization signaling. Returns "trigger" only when:
 *  - the conversation (excluding synthetic/context-overhead system messages)
 *    exceeds the configured threshold, AND
 *  - the summarizer has not already given up (`__summarizationExhausted`), AND
 *  - we are not bouncing right after a fresh summary pass (15% tolerance).
 * Returns "skip" in every other case so the loop continues without breaking.
 */
function shouldSignalSummarization(state: AgentState, threshold: number): "trigger" | "skip" {
  const tokCountMessages = (state.messages || []).filter((message: any) => {
    if (isSyntheticSummaryMessage(message)) return false;
    if (message.role === 'system' && (message.name === 'context_summary' || message.name === 'memory_context')) return false;
    return true;
  });
  const tokenCount = countMessagesTokens(tokCountMessages);
  if (tokenCount <= threshold) return "skip";

  // SmartAgent already attempted and could not compress further; pressing
  // again would deadlock. Proceed with the clamped context instead.
  if ((state.ctx as any)?.__summarizationExhausted) return "skip";

  // Fresh summary in transcript + only marginally over budget: do not
  // re-summarize. Context overhead alone can keep us 0–15% above the trigger.
  const hasFreshSummary = (state.messages || []).some((m: any) =>
    m.role === 'tool'
    && typeof m.content === 'string'
    && (m.content === 'SUMMARIZED' || m.content.startsWith('SUMMARIZED_TOOL_RESPONSE'))
  );
  if (hasFreshSummary && tokenCount <= threshold * 1.15) return "skip";

  return "trigger";
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

  // Resolve human-in-the-loop config; when askUser is enabled we attach the
  // built-in ask_user_question tool to the agent's tool surface.
  const askUserConfig: HumanInTheLoopAskUserConfig | undefined = (() => {
    const raw = (opts as any).humanInTheLoop?.askUser;
    if (!raw) return undefined;
    if (raw === true) return { enabled: true, allowFreeText: true };
    return {
      enabled: true,
      allowFreeText: raw.allowFreeText !== false,
      promptOverride: raw.promptOverride,
    };
  })();
  const askUserOnQuestion = typeof (opts as any).humanInTheLoop?.askUser === "object"
    ? (opts as any).humanInTheLoop?.askUser?.onQuestion as ((event: any) => void) | undefined
    : undefined;
  // Shared per-agent stateRef for the ask_user tool. Each invoke replaces the
  // pendingUserQuestions array via the tools node, but the tool object itself
  // is reused — that's fine because it only reads from this ref at call time.
  const askUserStateRef: any = askUserConfig
    ? { pendingUserQuestions: undefined, ctx: undefined, __onEvent: undefined, __currentToolCallId: undefined }
    : undefined;
  if (askUserConfig && askUserStateRef) {
    toolsBase.push(createAskUserQuestionTool(askUserStateRef, askUserConfig));
  }

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

  // Resolve unified reasoning config (provider-native + reflection). When omitted,
  // the loop behaves exactly as before: no reflection node and no reasoning extras.
  const resolvedReasoning = resolveReasoning((opts as any).reasoning);
  const reflectNode = resolvedReasoning?.reflection.enabled
    ? createReflectionNode(opts as any, resolvedReasoning.reflection)
    : undefined;

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
    humanInTheLoop: askUserConfig ? { askUser: askUserConfig } : undefined,
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

    // Forward resolved native reasoning into ctx so agentCore picks it up and
    // adapters map it to provider-specific body fields. We (re)apply this on
    // every invoke so a resumed run cannot inherit a stale `__reasoning` value
    // from a previous config — and we clear it when native reasoning is off.
    if (resolvedReasoning) {
      const ctx: any = { ...(state.ctx || {}) };
      if (resolvedReasoning.native) {
        ctx.__reasoning = resolvedReasoning.native;
      } else {
        delete ctx.__reasoning;
      }
      state = { ...state, ctx: Object.keys(ctx).length > 0 ? ctx : undefined } as AgentState;
    }
    const mergedLimits = {
      ...(opts.limits || {}),
      ...((config?.limits || {}) as any),
    } as AgentOptions["limits"];

    const maxToolCalls = (mergedLimits?.maxToolCalls === undefined) ? 50 : mergedLimits?.maxToolCalls;
    const iterationLimit = maxToolCalls === Infinity ? 100 : Math.max(maxToolCalls * 3 + 10, 40);
    const wallClockStart = Date.now();
    // Treat 0 / undefined as "disabled" so resolved-profile placeholders do not
    // accidentally throttle the loop.
    const maxWallClockMs = mergedLimits?.maxWallClockMs && mergedLimits.maxWallClockMs > 0 ? mergedLimits.maxWallClockMs : undefined;
    const maxTotalOutputTokens = mergedLimits?.maxTotalOutputTokens && mergedLimits.maxTotalOutputTokens > 0 ? mergedLimits.maxTotalOutputTokens : undefined;
    const maxCostUsd = mergedLimits?.maxCostUsd && mergedLimits.maxCostUsd > 0 ? mergedLimits.maxCostUsd : undefined;
    const costEstimator = (opts as any).costEstimator as ((args: { modelName?: string; inputTokens: number; outputTokens: number; cachedInputTokens?: number; reasoningTokens?: number }) => number) | undefined;
    const checkBudgetBreached = (): { breached: false } | { breached: true; reason: string } => {
      if (maxWallClockMs && Date.now() - wallClockStart > maxWallClockMs) {
        return { breached: true, reason: `maxWallClockMs (${maxWallClockMs}ms) exceeded` };
      }
      if (maxTotalOutputTokens) {
        const totals = (state as any).usage?.totals as Record<string, { output: number }> | undefined;
        if (totals) {
          let outputSum = 0;
          for (const v of Object.values(totals)) outputSum += Number(v?.output) || 0;
          if (outputSum > maxTotalOutputTokens) {
            return { breached: true, reason: `maxTotalOutputTokens (${maxTotalOutputTokens}) exceeded` };
          }
        }
      }
      if (maxCostUsd && costEstimator) {
        const perRequest = (state as any).usage?.perRequest as Array<{ modelName: string; usage: any }> | undefined;
        if (perRequest) {
          let cost = 0;
          for (const r of perRequest) {
            cost += costEstimator({
              modelName: r.modelName,
              inputTokens: Number(r.usage?.prompt_tokens) || 0,
              outputTokens: Number(r.usage?.completion_tokens) || 0,
              cachedInputTokens: Number(r.usage?.prompt_tokens_details?.cached_tokens) || 0,
              reasoningTokens: Number(r.usage?.completion_tokens_details?.reasoning_tokens) || 0,
            }) || 0;
          }
          if (cost > maxCostUsd) {
            return { breached: true, reason: `maxCostUsd ($${maxCostUsd}) exceeded (actual: $${cost.toFixed(4)})` };
          }
        }
      }
      return { breached: false };
    };
    let iterations = 0;
    // Run-scoped reflection counter. `state.reflections` accumulates across the
    // whole (possibly resumed) conversation, so it cannot back `maxPerRun`.
    let reflectionsThisRun = 0;
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

    // R1: "initial_then_after_tool" cadence reflects once up-front (a planning
    // note) before the first model call, then behaves like "after_tool" inside
    // the loop. Only fire on a fresh run (no assistant turn yet, not resuming).
    if (
      reflectNode &&
      resolvedReasoning?.reflection.enabled &&
      resolvedReasoning.reflection.cadence === "initial_then_after_tool" &&
      resumeStage === null &&
      !state.ctx?.__awaitingApproval &&
      !state.ctx?.__awaitingUserQuestion &&
      !(state.messages as any[]).some((m) => m?.role === "assistant")
    ) {
      try {
        const patch = await reflectNode(state as any, "initial_then_after_tool");
        if (patch && Object.keys(patch).length > 0) {
          state = { ...state, ...patch } as AgentState;
          reflectionsThisRun++;
        }
      } catch {
        // never fail the run due to reflection errors
      }
    }

    while (iterations < iterationLimit) {
      iterations++;
      // Enforce budget limits before each iteration so we never spend extra
      // tokens after the cap has been hit.
      const budget = checkBudgetBreached();
      if (budget.breached) {
        emit?.({ type: "metadata", limitBreached: budget.reason });
        const ctx = { ...(state.ctx || {}), __limitBreached: budget.reason } as any;
        state = { ...state, ctx } as AgentState;
        break;
      }

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

        // Defer to a single decision helper for context summarization. The
        // helper returns "trigger" only when the context truly exceeds the
        // budget and re-running the summarizer can plausibly shrink it.
        if (summarizationThreshold !== undefined) {
          const verdict = shouldSignalSummarization(state, summarizationThreshold);
          if (verdict === "trigger") {
            const ctx = { ...(state.ctx || {}), __needsSummarization: true };
            state = { ...state, ctx } as AgentState;
            break;
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
        if (
          soManager &&
          !(state as any).ctx?.__finalizedDueToStructuredOutput &&
          !(state as any).ctx?.__structuredOutputForceFinalize
        ) {
          // Native strategy: the provider API (e.g. OpenAI `response_format:
          // json_schema` with strict=true) guarantees the text content is valid
          // JSON matching the schema. Parse and finalize in a single call — no
          // nudges, no retries. If parsing fails we surface the error to the
          // caller rather than burning extra round-trips trying to "fix" it.
          if (soManager.strategy.kind === "native") {
            const assistantText = extractMessageText(lastMsg);
            if (assistantText) {
              const parsed = soManager.parseFromContent(assistantText);
              if (parsed.success) {
                const ctx = {
                  ...(state.ctx || {}),
                  __finalizedDueToStructuredOutput: true,
                  __structuredOutputParsed: parsed.data,
                };
                state = { ...state, ctx } as AgentState;
              }
            }
            // Exit unconditionally for native: either we finalized or the
            // caller will receive the parse error via result.outputError.
            break;
          }

          // Tool-based strategy: model skipped calling `response` and emitted
          // plain text instead. Inject a one-time nudge so the loop can re-ask
          // it to call the tool.
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
      if (state.ctx?.__awaitingUserQuestion) break;
      if (checkpointIfRequested("after_tools")) break;
      if (state.ctx?.__finalizedDueToStructuredOutput) break;

      // Post-tool reflection (piggyback). Runs only when reasoning.reflection is
      // enabled and cadence matches. Errors are swallowed inside the node so the
      // main loop is never disturbed.
      if (reflectNode && resolvedReasoning?.reflection.enabled) {
        const cadence = resolvedReasoning.reflection.cadence;
        const refl = resolvedReasoning.reflection;
        // Single source of truth for throttling:
        //  - maxPerRun caps reflections within THIS invoke (run-scoped counter).
        //  - everyNTurns is enforced once, here, against the last reflection's turn.
        //  - shouldRunReflection only decides cadence-shape (after_tool/on_branch/…).
        const lastTurn = ((state as any).reflections?.at(-1)?.turn ?? -Infinity) as number;
        const currentTurn = state.toolCallCount || 0;
        const budgetExceeded = typeof refl.maxPerRun === "number" && reflectionsThisRun >= refl.maxPerRun;
        const sinceLast = currentTurn - (Number.isFinite(lastTurn) ? lastTurn : -refl.everyNTurns);
        const cadenceGap = sinceLast < refl.everyNTurns;
        // R2: a custom shouldReflect predicate overrides the built-in cadence
        // decision (throttles still apply on top).
        const cadenceWantsIt = refl.shouldReflect
          ? !!refl.shouldReflect({ state: state as any, turn: currentTurn, trigger: cadence, ranToolsThisTurn: true })
          : shouldRunReflection(cadence, state as any, true);
        if (!budgetExceeded && !cadenceGap && cadenceWantsIt) {
          try {
            const patch = await reflectNode(state as any, cadence);
            if (patch && Object.keys(patch).length > 0) {
              state = { ...state, ...patch } as AgentState;
              reflectionsThisRun++;
            }
          } catch {
            // never fail the run due to reflection errors
          }
        }
      }
    }

    // Best-effort structured-output finalization when the loop exited without
    // a parsed output. For native strategy we only attempt a one-shot parse of
    // the last assistant message — no extra model calls. Retries are reserved
    // for the tool-based strategy, where the model can stubbornly skip calling
    // `response` and we need to nudge it.
    if (soManager && !(state as any).ctx?.__finalizedDueToStructuredOutput) {
      const lastForParse: any = state.messages[state.messages.length - 1];
      if (lastForParse?.role === "assistant") {
        const assistantText = extractMessageText(lastForParse);
        if (assistantText) {
          const parsed = soManager.parseFromContent(assistantText);
          if (parsed.success) {
            const ctx = {
              ...(state.ctx || {}),
              __finalizedDueToStructuredOutput: true,
              __structuredOutputParsed: parsed.data,
            };
            state = { ...state, ctx } as AgentState;
          }
        }
      }
    }

    if (
      soManager &&
      soManager.strategy.kind === "tool_based" &&
      !(state as any).ctx?.__finalizedDueToStructuredOutput
    ) {
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
        state.ctx?.__awaitingUserQuestion ||
        state.ctx?.__cancelled ||
        state.ctx?.__finalizedDueToStructuredOutput ||
        state.ctx?.__finalizedDueToToolLimit ||
        state.ctx?.__needsSummarization ||
        state.ctx?.__limitBreached;
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
    // Install custom token counter for the duration of this invoke. The
    // setter is process-wide but we restore it in `finally` below so nested
    // / concurrent invokes do not poison one another's counter.
    const userTokenCounter = (opts as any).tokenCounter as ((text: string) => number) | undefined;
    if (userTokenCounter) {
      // Lazy import to avoid circular deps when this module is preloaded.
      const { setTokenCounter } = await import("./utils/utilTokens.js");
      setTokenCounter(userTokenCounter);
    }
    const callerOnEvent = config?.onEvent;
    const onEvent = askUserOnQuestion
      ? (event: SmartAgentEvent) => {
          if (event && (event as any).type === "user_question") {
            try { askUserOnQuestion(event as any); } catch (err) { console.warn('[agent-sdk] humanInTheLoop.askUser.onQuestion error:', err); }
          }
          callerOnEvent?.(event);
        }
      : callerOnEvent;
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
      pendingUserQuestions: input.pendingUserQuestions || [],
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
      if (userTokenCounter) {
        const { setTokenCounter } = await import("./utils/utilTokens.js");
        setTokenCounter(undefined);
      }
      throw err;
    } finally {
      // Restore default token counter as soon as the loop ends so subsequent
      // unrelated invokes do not inherit it.
      if (userTokenCounter) {
        try {
          const { setTokenCounter } = await import("./utils/utilTokens.js");
          setTokenCounter(undefined);
        } catch {
          // ignore
        }
      }
    }

    await finalizeTraceSession(traceSession, {
      agentRuntime: res.agent || runtime,
      status: "success",
    });

    // The base loop can exit purely to signal SmartAgent that the conversation
    // needs summarization before the model can be invoked again. In that case the
    // last assistant message in state can be a synthetic summarize_context call
    // produced by the previous summarization pass — it is internal runtime
    // metadata, not a real terminal answer. Treat this as "no final answer yet"
    // and let the SmartAgent driver loop continue without leaking the synthetic
    // marker as visible assistant content / finalAnswer event.
    const isTransientSummarizationExit = !!(res as any).ctx?.__needsSummarization;
    const finalAssistantMsg = isTransientSummarizationExit
      ? undefined
      : getLastAssistantMessage(res.messages);
    const finalIsSyntheticSummary = !isTransientSummarizationExit
      && finalAssistantMsg
      && isSyntheticSummaryMessage(finalAssistantMsg);
    const content = (isTransientSummarizationExit || finalIsSyntheticSummary)
      ? ""
      : extractMessageText(finalAssistantMsg);

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
      } else if (!isTransientSummarizationExit) {
        // No content at all — report no_output error
        const noResult = soManager.noOutputResult(1);
        if (!noResult.success) {
          outputError = noResult.error;
        }
      }
    }

    // Only emit a final answer event when the loop actually produced one.
    // Suppress when we exited transiently for summarization (SmartAgent will
    // retry) or when the only candidate is the synthetic summary marker.
    if (!isTransientSummarizationExit && !finalIsSyntheticSummary) {
      emit({ type: "finalAnswer", content });
      if (streamEnabled && content) {
        onStream?.({ text: content, isFinal: true });
        emit({ type: "stream", text: content, isFinal: true });
      }
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

  const resolveUserQuestion = (state: AgentState, resolution: UserQuestionResolution) =>
    resolveUserQuestionState(state, resolution);

  const instance: AgentInstance<TOutput> = {
    invoke: invokeAgent,
    snapshot: snapshotState,
    resume: resumeAgent,
    resolveToolApproval,
    resolveUserQuestion,
    asTool: ({ toolName, description, inputDescription }: { toolName: string; description?: string; inputDescription?: string }) => {
      const schema = z.object({ input: z.string().describe(inputDescription || "Input for delegated agent") });
      const delegatedTool: any = createTool({
        name: toolName,
        description: description || `Delegate task to agent ${opts.name || 'Agent'}`,
        schema,
        func: async ({ input }) => {
          // Read parent runtime delegation policy + current depth from the
          // injected _stateRef. The toolsNode wires this on every call.
          const ref: any = delegatedTool._stateRef;
          const parentCtx: any = ref.ctx || {};
          const parentMessages: any[] = Array.isArray(ref.messages) ? ref.messages : [];
          const parentRuntime: any = ref.parentRuntime;
          // The parent runtime is whichever agent is currently executing.
          // Pull its resolved delegation policy if available (SmartAgent only).
          const resolvedSmart = parentRuntime?.smart || (opts as any).__resolvedSmart;
          const delegationPolicy = resolvedSmart?.delegation || {
            mode: "role_based",
            maxDelegationDepth: 2,
            maxChildCalls: 4,
            childContextPolicy: "scoped",
          };
          const currentDepth = Number(parentCtx.__delegationDepth) || 0;
          if (delegationPolicy.mode === "off") {
            return { error: "Delegation disabled by runtime policy." };
          }
          if (currentDepth >= delegationPolicy.maxDelegationDepth) {
            return {
              error: `Delegation depth limit reached (${delegationPolicy.maxDelegationDepth}). Refusing nested call.`,
            };
          }
          parentCtx.__delegatedCallCount = (parentCtx.__delegatedCallCount || 0) + 1;
          if (parentCtx.__delegatedCallCount > delegationPolicy.maxChildCalls) {
            return {
              error: `Child-call budget exhausted (${delegationPolicy.maxChildCalls}).`,
            };
          }

          // Apply childContextPolicy when seeding the child agent.
          let childMessages: any[];
          switch (delegationPolicy.childContextPolicy) {
            case "full":
              childMessages = [...parentMessages, { role: "user", content: input } as any];
              break;
            case "scoped": {
              // Last assistant message + last user task + the explicit delegation input.
              const systemPrefix = parentMessages[0]?.role === "system" ? [parentMessages[0]] : [];
              const lastUser = [...parentMessages].reverse().find((m) => m?.role === "user");
              childMessages = [
                ...systemPrefix,
                ...(lastUser ? [lastUser] : []),
                { role: "user", content: input } as any,
              ];
              break;
            }
            case "minimal":
            default:
              childMessages = [{ role: "user", content: input } as any];
          }

          const childCtx = { __delegationDepth: currentDepth + 1 };
          const res = await instance.invoke({ messages: childMessages, ctx: childCtx } as any);
          return {
            content: res.content,
            output: res.output,
            summary: res.state?.summaries?.[res.state.summaries.length - 1],
          };
        }
      });
      // Eagerly initialize _stateRef so the parent's toolsNode (which only
      // writes into existing _stateRef objects) can deposit `parentRuntime`,
      // `ctx`, and `messages` before the delegation tool runs.
      delegatedTool._stateRef = {};
      return delegatedTool;
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
