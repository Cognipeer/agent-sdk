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
import { createAskUserQuestionTool, ASK_USER_TOOL_NAME } from "./humanLoop.js";
import { countMessagesTokens } from "./utils/utilTokens.js";
import { isSyntheticSummaryMessage } from "./utils/syntheticMessages.js";
import { extractMessageText } from "./utils/content.js";
import { StructuredOutputManager } from "./structuredOutput/manager.js";
import { resolveStrategy, getModelCapabilities } from "./structuredOutput/resolver.js";
import type { StructuredOutputError } from "./structuredOutput/types.js";
import { getResolvedSmartConfig } from "./smart/runtimeConfig.js";
import { createContextPilotRuntime } from "./smart/contextPilot/index.js";
import { seedChildMessages } from "./smart/subagents/registry.js";
import { selectPendingToolCalls } from "./utils/pendingToolCalls.js";
import { nanoid } from "nanoid";
import { createPluginHost, type PluginRunHost } from "./plugins/host.js";
import type { AgentPlugin } from "./plugins/types.js";
import { openPluginSession } from "./plugins/session.js";
import { createPluginTraceRecorder } from "./plugins/trace.js";

/**
 * Turn handoff descriptors into the tools that expose them to the model.
 *
 * Shared with createSmartAgent, which builds its own per-invoke tool set and
 * would otherwise never see these — a typed, documented option doing nothing.
 */
export function buildHandoffTools(handoffs: HandoffDescriptor[]): any[] {
  return handoffs.map((descriptor) => {
    const schema = descriptor.schema || z.object({ reason: z.string().describe("Reason for handoff") });
    return createTool({
      name: descriptor.toolName,
      description: descriptor.description || `Handoff to ${descriptor.target.__runtime.name || "agent"}`,
      schema,
      func: async () => ({ __handoff: { runtime: descriptor.target.__runtime } }),
    });
  });
}

/**
 * Union by name, first occurrence wins. The agent's own tools take precedence
 * over a contribution, so a plugin can never shadow a built-in (`ask_user_question`,
 * `response`) and duplicate it on the wire — strict providers reject that.
 */
function mergeToolsByName(base: any[], extra: any[]): any[] {
  if (extra.length === 0) return base;
  const seen = new Set(base.map((tool) => tool?.name));
  const merged = [...base];
  for (const tool of extra) {
    const name = tool?.name;
    if (!name || seen.has(name)) continue;
    seen.add(name);
    merged.push(tool);
  }
  return merged;
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
  // again would deadlock. Proceed with the clamped context instead. The verdict
  // only holds until the next tool result lands — that is new compressable
  // material, so the summarizer gets another chance at it.
  if ((state.ctx as any)?.__summarizationExhausted) {
    const exhaustedAt = (state.ctx as any)?.__summarizationExhaustedAtToolCount;
    if (typeof exhaustedAt !== "number" || (state.toolHistory || []).length <= exhaustedAt) return "skip";
  }

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
  // Only attach it when the caller's tool list does not already carry one.
  // createSmartAgent builds its own ask_user tool into the list it hands to this
  // factory AND forwards `humanInTheLoop`, so attaching unconditionally left the
  // base agent with two tools of the same name. That is invisible to `invoke()`
  // (the smart layer rebuilds its tool set per call) but reaches the provider on
  // `resume()`, where strict APIs reject it outright — Bedrock answers
  // `The tool ask_user_question is already defined at toolConfig.tools.N`.
  const hasTool = (name: string) => toolsBase.some((tool: any) => tool?.name === name);
  if (askUserConfig && askUserStateRef && !hasTool(ASK_USER_TOOL_NAME)) {
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
    // Same name guard as ask_user above: a caller that already built the finalize
    // tool into its list must not end up with two of them on the wire.
    if (responseTool && modelCapabilities.structuredOutput !== "native" && !hasTool((responseTool as any).name)) {
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
    // Carried on the runtime so a HANDOFF can restore this agent's persona.
    // The core node never injects a system prompt itself (the smart driver
    // seeds one), but a handoff hands this whole runtime to another loop —
    // left undefined here, the target's own instructions and name are lost and
    // it runs under whichever agent handed control to it.
    systemPrompt: (opts as any).systemPrompt,
    todoListPrompt: opts.todoListPrompt,
    limits: opts.limits,
    useTodoList: (opts as any).useTodoList,
    outputSchema: opts.outputSchema as any,
    responseFormat: soManager?.getResponseFormat(),
    tracing: opts.tracing,
    humanInTheLoop: askUserConfig ? { askUser: askUserConfig } : undefined,
  };
  const summarizationThreshold = getActiveSummarizationThreshold(opts);

  // Plugin host: agent-scoped. It validates the plugin set, resolves slots and
  // contributions once, and owns setup/dispose. Everything run-scoped lives in
  // the handle `beginRun` returns, so two concurrent invokes on this instance
  // never share plugin state — the same rule the per-invoke tool set follows.
  const inlinePlugins: AgentPlugin[] = [];
  if ((opts as any).plugins) inlinePlugins.push(...((opts as any).plugins as AgentPlugin[]));
  if ((opts as any).hooks) {
    inlinePlugins.push({ name: "inline-hooks", hooks: (opts as any).hooks });
  }
  const pluginHost = createPluginHost(inlinePlugins, (opts as any).pluginOptions);
  let pluginModel: unknown;

  async function runLoop(
    initial: AgentState,
    config: InvokeConfig | undefined,
    emit?: (event: SmartAgentEvent) => void,
    /** Live pointer so HookContext.state is never a stale snapshot. */
    stateHolder?: { value: AgentState }
  ): Promise<AgentState> {
    let state = await resolver(initial);
    const publish = (next: AgentState) => {
      if (stateHolder) stateHolder.value = next;
      return next;
    };
    publish(state);
    if (state.ctx?.__paused) {
      const nextCtx = { ...state.ctx };
      delete nextCtx.__paused;
      state = { ...state, ctx: Object.keys(nextCtx).length > 0 ? nextCtx : undefined } as AgentState;
    }
    // Consumed: `invokeAgent` already folded this into `resumed` for the plugin
    // session. Left on ctx it would ride out on `result.state`, into the next
    // `invoke({ ...result.state })`, and into the next snapshot — marking every
    // later turn of the conversation as a resume.
    if (state.ctx?.__restoredFromSnapshot) {
      const nextCtx = { ...state.ctx };
      delete nextCtx.__restoredFromSnapshot;
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
    const costEstimator = ((opts as any).costEstimator ?? pluginHost.slots.costEstimator) as ((args: { modelName?: string; inputTokens: number; outputTokens: number; cachedInputTokens?: number; reasoningTokens?: number }) => number) | undefined;
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
      publish(state);
      // agentCore reads this for the preModelCall payload; the node cannot see
      // the loop's own counter any other way.
      if (state.ctx) (state.ctx as any).__iteration = iterations;
      // Enforce budget limits before each iteration so we never spend extra
      // tokens after the cap has been hit.
      const budget = checkBudgetBreached();
      if (budget.breached) {
        emit?.({ type: "metadata", limitBreached: budget.reason });
        const limitHost = (state.ctx as any)?.__plugins as PluginRunHost | undefined;
        if (limitHost?.has("notification")) {
          // Observation only: a throwing handler must not turn a graceful
          // budget exit into a thrown run.
          await limitHost.runObservers("notification", {
            kind: "limit",
            detail: { reason: budget.reason, iteration: iterations },
          });
        }
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
          state = publish({ ...state, ...(await agentCore(state)) } as AgentState);
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
      // Use the owning assistant turn's UNRESOLVED tool_calls, not literally the
      // last message. On resume after a sub-agent human-input pause the last
      // message can be a completed sibling tool result; reading its (absent)
      // tool_calls would strand the paused delegating tool. selectPendingToolCalls
      // is identical to lastMsg.tool_calls on the normal path.
      const toolCalls: any[] = selectPendingToolCalls(state.messages);
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
        // A plugin denial (preModelCall / postModelCall) ends the turn with a
        // refusal that has no tool_calls. Without the last term the tool-based
        // branch below would read that as "the model forgot to call `response`",
        // nudge it, and re-enter agentCore — one more provider call after a
        // deny, and an `output` populated next to `__guardrailBlocked`.
        if (
          soManager &&
          !(state as any).ctx?.__finalizedDueToStructuredOutput &&
          !(state as any).ctx?.__structuredOutputForceFinalize &&
          !(state as any).ctx?.__guardrailBlocked
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
      state = publish({ ...state, ...(await toolsNode(state)) } as AgentState);
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

    // The main loop can exit for reasons that mean "this run must not continue
    // right now": a human-in-the-loop pause (approval / user question), a
    // cancellation, a summarization signal (context over budget — the caller
    // must compact before any further model call), a breached budget limit, a
    // guardrail block, or a checkpoint pause. The structured-output finalizer
    // below must never override these. Running it anyway made the model re-ask
    // pending questions (duplicate ask_user_question entries piling up while
    // the run was supposedly paused), execute additional tools after the
    // pause, and issue model calls on an over-budget context (provider 400s)
    // with a dangling unresolved tool_calls tail.
    const structuredFinalizeBlocked = Boolean(
      pausedStage
      || state.ctx?.__awaitingApproval
      || state.ctx?.__awaitingUserQuestion
      || state.ctx?.__cancelled
      || (state.ctx as any)?.__needsSummarization
      || (state.ctx as any)?.__limitBreached
      || (state.ctx as any)?.__guardrailBlocked
    );

    // Best-effort structured-output finalization when the loop exited without
    // a parsed output. For native strategy we only attempt a one-shot parse of
    // the last assistant message — no extra model calls. Retries are reserved
    // for the tool-based strategy, where the model can stubbornly skip calling
    // `response` and we need to nudge it.
    if (soManager && !(state as any).ctx?.__finalizedDueToStructuredOutput && !structuredFinalizeBlocked) {
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
      !(state as any).ctx?.__finalizedDueToStructuredOutput &&
      !structuredFinalizeBlocked
    ) {
      const maxPostLoopRetries = soManager.maxRetries;
      for (let postRetry = 0; postRetry < maxPostLoopRetries; postRetry++) {
        if ((state as any).ctx?.__finalizedDueToStructuredOutput) break;
        // A pause or budget/summarization signal raised DURING a finalize round
        // (e.g. the nudged model called ask_user_question, or a tool required
        // approval) ends finalization immediately for the same reasons.
        if (
          state.ctx?.__awaitingApproval
          || state.ctx?.__awaitingUserQuestion
          || state.ctx?.__cancelled
          || (state.ctx as any)?.__limitBreached
          // preModelCall/postModelCall now cover this path too, so a denial
          // here has to end finalization instead of being retried.
          || (state.ctx as any)?.__guardrailBlocked
        ) break;

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

    publish(state);
    return state;
  }

  const invokeAgent = async (input: AgentState, config?: InvokeConfig): Promise<AgentInvokeResult<TOutput>> => {
    // Install custom token counter for the duration of this invoke. The
    // setter is process-wide but we restore it in `finally` below so nested
    // / concurrent invokes do not poison one another's counter.
    // The option wins over the slot: a caller who passed one explicitly meant it.
    // Slots are resolved at host construction (not at setup), so this is safe
    // before the await below.
    const userTokenCounter = ((opts as any).tokenCounter
      ?? pluginHost.slots.tokenCounter) as ((text: string) => number) | undefined;
    if (userTokenCounter) {
      // Lazy import to avoid circular deps when this module is preloaded.
      const { setTokenCounter } = await import("./utils/utilTokens.js");
      setTokenCounter(userTokenCounter);
    }
    // Contributions are resolved on first use, not at construction: `tools` may
    // be an async factory (an MCP server connecting, a registry fetch) while
    // createAgent is synchronous. `setup` is idempotent, so this is a no-op on
    // every invoke after the first.
    await pluginHost.setup({ agentName: opts.name, agentVersion: opts.version, model: opts.model });
    if (pluginModel === undefined) {
      pluginModel = pluginHost.contributions.applyModelWrappers(opts.model);
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

    // A session is never recovered from the incoming ctx. `invoke(previousState)`
    // is the ordinary continuation and branching pattern, so a handle parked on
    // ctx would hand a finished run's live host, its per-plugin stores and its
    // state pointer back to the next call — and to two concurrent branches at
    // once. The smart driver passes its session down explicitly instead.
    delete ctx.__plugins;
    delete (ctx as any).__applySystemPromptContribution;
    delete ctx.__pluginState;
    // A verdict about the PREVIOUS turn. Carried in, it would report this
    // turn's ordinary answer as blocked and keep structured-output finalization
    // disabled for the rest of the conversation. Cleared before any hook runs,
    // so the flag on `result.state` always describes the run that returned it.
    delete (ctx as any).__guardrailBlocked;

    const inheritedSession = (config as any)?.__pluginSession as
      | { host: PluginRunHost; runId: string; stateHolder: { value: AgentState } }
      | undefined;

    ctx.__runId = inheritedSession?.runId ?? traceSession?.sessionId ?? `run_${nanoid(10)}`;

    const stateHolder: { value: AgentState } =
      inheritedSession?.stateHolder ?? { value: undefined as unknown as AgentState };
    const traceRecorder = createPluginTraceRecorder(() => traceSession);

    const runHost: PluginRunHost | undefined =
      inheritedSession?.host
      ?? (pluginHost.hasAny()
        ? pluginHost.beginRun({
            runId: ctx.__runId,
            agentName: opts.name,
            getState: () => stateHolder.value as any,
            emit,
            recordTrace: traceRecorder.record,
            signal: ctx.__abortSignal,
            depth: Number(ctx.__delegationDepth) || 0,
          })
        : undefined);
    if (runHost) ctx.__plugins = runHost;
    // Separate from `__plugins`: a contribution-only plugin registers no hooks,
    // so `beginRun` is skipped and there is no run host — but its `systemPrompt`
    // contribution still has to survive a handoff, where the agent node rebuilds
    // the leading system message from the target's runtime.
    (ctx as any).__applySystemPromptContribution = (base: string) =>
      pluginHost.contributions.applySystemPrompt(base);

    // Only the creator of a session brackets it. A leg that inherited one is
    // mid-turn by definition, so firing sessionStart/sessionEnd there would
    // report a run start and a run end per driver iteration.
    const ownsRun = !inheritedSession && !!runHost;
    if (config?.cancellationToken) ctx.__cancellationToken = config.cancellationToken;
    if ((config?.cancellationToken as AbortSignal | undefined)?.aborted !== undefined) {
      ctx.__abortSignal = config?.cancellationToken as AbortSignal;
    }
    if (config?.timeoutMs && config.timeoutMs > 0) {
      ctx.__deadline = Date.now() + config.timeoutMs;
    }
    if (!ctx.__contextPilot) {
      // Fresh per-invoke CCR store + dedup tracker (never persisted across
      // snapshot/resume boundaries — see DISALLOWED_CTX_KEYS in stateSnapshot.ts).
      const resolvedForContextPilot = getResolvedSmartConfig(opts as any, runtime as any);
      ctx.__contextPilot = createContextPilotRuntime(resolvedForContextPilot.contextPilot);
    }

    // state.agent.tools is what BOTH the tools node and agentCore read, so
    // merging here is what makes a contributed tool visible on the live loop,
    // on resume, and on the asTool path alike.
    const contributedTools = pluginHost.contributions.tools;
    // A guardrail packaged inside a plugin has to reach the same evaluator the
    // `guardrails:` option feeds; otherwise the plugin installs cleanly, shows
    // up in host.plugins, and silently guards nothing.
    const contributedGuardrails = pluginHost.contributions.guardrails;
    const pluginRuntime: AgentRuntimeConfig =
      contributedTools.length > 0 || contributedGuardrails.length > 0 || pluginModel !== opts.model
        ? {
            ...runtime,
            tools: mergeToolsByName(runtime.tools as any[], contributedTools as any[]),
            guardrails: [...(runtime.guardrails ?? []), ...contributedGuardrails],
            model: pluginModel ?? runtime.model,
          }
        : runtime;
    const runtimeWithInvokeLimits: AgentRuntimeConfig = config?.limits
      ? { ...pluginRuntime, limits: { ...(pluginRuntime.limits || {}), ...config.limits } }
      : pluginRuntime;

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

    stateHolder.value = initial;

    // A resumed invoke is the only place these markers are still readable —
    // runLoop strips __paused and __resumeStage on entry.
    const pausedMidRun = Boolean(
      input.ctx?.__paused
      || input.ctx?.__resumeStage
      || input.ctx?.__awaitingApproval
      || input.ctx?.__awaitingUserQuestion
    );
    const resumed = Boolean(input.ctx?.__restoredFromSnapshot || pausedMidRun);
    // Consumed here, on every exit path — including the session-denial return
    // below, which never reaches runLoop's own strip. Left on ctx it would
    // ride out on `result.state` and mark every later turn as a resume.
    delete ctx.__restoredFromSnapshot;

    const startedAt = Date.now();
    let sessionEnded = false;
    /** Fires at most once per run, on every exit path. */
    const endSession = async (
      status: "success" | "error" | "paused" | "cancelled",
      payload: { result?: AgentInvokeResult<TOutput>; error?: Error; state?: AgentState },
    ) => {
      if (!runHost || !ownsRun || sessionEnded) return;
      sessionEnded = true;
      await runHost.runObservers("sessionEnd", {
        status,
        result: payload.result as any,
        error: payload.error,
        usage: (payload.state as any)?.usage,
        durationMs: Date.now() - startedAt,
      });
      traceRecorder.flush();
      runHost.end();
    };
    const statusFor = (st?: AgentState): "success" | "paused" | "cancelled" => {
      const c: any = st?.ctx || {};
      if (c.__cancelled) return "cancelled";
      if (c.__paused || c.__awaitingApproval || c.__awaitingUserQuestion) return "paused";
      return "success";
    };

    if (runHost && ownsRun) {
      const opened = await openPluginSession(runHost, {
        messages: initial.messages,
        resumed,
        pausedMidRun,
        config,
      });
      if (opened.messages !== initial.messages) {
        initial.messages = opened.messages as any;
      }
      if (opened.systemPromptAppend) ctx.__pluginSystemPromptAppend = opened.systemPromptAppend;
      stateHolder.value = initial;

      if (opened.denied) {
        const reason = opened.denied.reason;
        const blocked: AgentState = {
          ...initial,
          messages: [
            ...initial.messages,
            { role: "assistant", name: "guardrail", content: reason } as any,
          ],
          ctx: {
            ...ctx,
            __guardrailBlocked: {
              phase: "request",
              incident: { reason, deniedBy: opened.denied.deniedBy },
            },
          },
        };
        stateHolder.value = blocked;
        await finalizeTraceSession(traceSession, { agentRuntime: runtime, status: "success" });
        emit({ type: "finalAnswer", content: reason });
        const denied: AgentInvokeResult<TOutput> = {
          content: reason,
          output: undefined,
          outputError: undefined,
          metadata: { usage: (blocked as any).usage },
          messages: blocked.messages,
          state: blocked,
        };
        await endSession("success", { result: denied, state: blocked });
        return denied;
      }
    }

    let res: AgentState;
    try {
      await startStreamingSession(traceSession, runtimeWithInvokeLimits);
      res = await runLoop(initial, config, emit, stateHolder);
    } catch (err: any) {
      await finalizeTraceSession(traceSession, {
        agentRuntime: runtime,
        status: "error",
        error: { message: err?.message, stack: err?.stack },
      });
      await endSession("error", { error: err instanceof Error ? err : new Error(String(err)), state: stateHolder.value });
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
    let content = (isTransientSummarizationExit || finalIsSyntheticSummary)
      ? ""
      : extractMessageText(finalAssistantMsg);

    // ── Plugin gate: preFinalAnswer ─────────────────────────────────────────
    // Gated by the same predicate that blocks structured-output finalization:
    // a paused, cancelled, over-budget or summarization-bounce exit is not a
    // final answer, and running the hook there would let a deny overwrite the
    // assistant turn of a run that is still waiting on a human.
    const finalAnswerBlocked = Boolean(
      isTransientSummarizationExit
      || res.ctx?.__awaitingApproval
      || res.ctx?.__awaitingUserQuestion
      || res.ctx?.__cancelled
      || (res.ctx as any)?.__paused
      || (res.ctx as any)?.__limitBreached
    );
    if (runHost && ownsRun && !finalAnswerBlocked && runHost.has("preFinalAnswer")) {
      // Guarded by ownsRun only because an inherited leg is mid-turn; the smart
      // driver fires this itself on the leg that actually returns the answer.
      const finalGate = await runHost.runGate("preFinalAnswer", {
        content,
        message: finalAssistantMsg,
      });
      if (finalGate.decision === "deny") {
        content = finalGate.reason || "Response blocked by policy.";
      } else if (finalGate.input.content !== content) {
        // Applied BEFORE the structured-output parse below, so `output` and
        // `content` can never disagree — a redaction that only reached one of
        // them would leak the unredacted payload through the other.
        content = finalGate.input.content as string;
      }
      const continueWith = (finalGate as unknown as { continueWith?: string }).continueWith;
      if (continueWith) {
        // Re-entering runLoop would restart the wall-clock, iteration and
        // reflection budgets, so this is not implemented on either agent yet.
        emit({
          type: "metadata",
          pluginWarning: "preFinalAnswer.continueWith is not implemented yet and was ignored.",
        } as any);
      }
      if (finalGate.decision === "deny") {
        // A denied answer must not leave a parsed structured output behind —
        // returning `output` while `content` says "blocked" hands the caller
        // the very payload the policy refused.
        const deniedCtx = (res.ctx = res.ctx || {});
        delete (deniedCtx as any).__structuredOutputParsed;
      }
    }

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

    const result: AgentInvokeResult<TOutput> = {
      content,
      output: parsed as TOutput | undefined,
      outputError,
      metadata: { usage: (res as any).usage },
      messages: res.messages,
      state: res as AgentState,
    };
    // A summarization bounce is a transient exit: the smart driver is still
    // mid-turn and will call back in. Ending the session here would tell every
    // plugin the run finished while it is still running.
    if (!isTransientSummarizationExit) {
      await endSession(statusFor(res), { result, state: res });
    }
    return result;
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
    dispose: () => pluginHost.dispose(),
    __plugins: pluginHost,
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

          // Apply childContextPolicy when seeding the child agent (shared with
          // the sub-agent primitive via seedChildMessages).
          const childMessages = seedChildMessages(
            delegationPolicy.childContextPolicy as any,
            parentMessages as any,
            input,
          );

          const childCtx = { __delegationDepth: currentDepth + 1 };
          // Forward the parent's event/streaming/cancellation wiring so a
          // delegated child surfaces its progress to the host (previously the
          // child ran "dark"). Events are stamped with the child's name.
          const childConfig = {
            onEvent: parentCtx.__onEvent
              ? (e: any) => {
                  if (e?.type === "finalAnswer" || e?.type === "metadata") return;
                  try { parentCtx.__onEvent({ ...e, delegatedTo: opts.name }); } catch { /* ignore */ }
                }
              : undefined,
            onProgress: parentCtx.__onProgress,
            onStream: parentCtx.__streaming && parentCtx.__onStream
              ? (chunk: any) => { if (!chunk?.isFinal) parentCtx.__onStream(chunk); }
              : undefined,
            stream: Boolean(parentCtx.__streaming),
            cancellationToken: parentCtx.__cancellationToken ?? parentCtx.__abortSignal,
          };
          const res = await instance.invoke({ messages: childMessages, ctx: childCtx } as any, childConfig as any);
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
    runtime.tools = mergeToolsByName(runtime.tools as any[], buildHandoffTools(opts.handoffs));
  }

  return instance;
}
