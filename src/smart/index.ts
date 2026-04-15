import type { AgentInvokeResult, InvokeConfig, SmartAgentOptions, SmartState, SmartAgentInstance } from "../types.js";
import type { ZodSchema } from "zod";
import { createAgent } from "../agent.js";
import { createContextTools } from "../contextTools.js";
import { createContextSummarizeNode } from "../nodes/contextSummarize.js";
import { buildSystemPrompt } from "../prompts.js";
import { resolverDecisionFactory, toolsDecisionFactory } from "../graph/decisions.js";
import { normalizeSmartAgentOptions } from "./runtimeConfig.js";
import { buildModelMessages } from "./contextPolicy.js";
import { readMemoryFacts, resolveMemoryStore, writeSummaryFactsToMemory } from "./memory.js";
import { StructuredOutputManager } from "../structuredOutput/manager.js";
import { resolveStrategy } from "../structuredOutput/resolver.js";
import { extractMessageText } from "../utils/content.js";

// SmartAgent on top of core createAgent: adds system prompt, optional planning context tools, and token-aware summarization.
export function createSmartAgent<TOutput = unknown>(opts: SmartAgentOptions & { outputSchema?: ZodSchema<TOutput> }): SmartAgentInstance<TOutput> {
  const resolved = normalizeSmartAgentOptions(opts);
  const planningEnabled = resolved.planning.mode !== 'off';
  const memoryStore = resolveMemoryStore(resolved);
  const runtimeOpts: SmartAgentOptions & { outputSchema?: ZodSchema<TOutput> } = {
    ...opts,
    runtimeProfile: resolved.runtimeProfile,
    limits: resolved.limits,
    summarization: resolved.summarization,
    context: resolved.context,
    planning: resolved.planning,
    delegation: resolved.delegation,
    memory: { ...resolved.memory, store: memoryStore },
    toolResponses: resolved.toolResponses,
    useTodoList: planningEnabled,
  };

  // Prepare context tools (todo + get_tool_response). Avoid duplicating response tool; base agent will add it if schema provided.
  const stateRef: any = { toolHistory: undefined, toolHistoryArchived: undefined, todoList: undefined, planVersion: 0, adherenceScore: 0 };
  const contextTools = createContextTools(stateRef, { planningEnabled });
  const mergedTools = [...((opts.tools as any) ?? []), ...contextTools];

  // Compose base agent – pass summarization config so createAgent's token-budget
  // guard and __needsSummarization throw know summarization is handled externally.
  const base = createAgent<TOutput>({ ...runtimeOpts, tools: mergedTools });
  base.__runtime.runtimeProfile = resolved.runtimeProfile;
  base.__runtime.smart = resolved;

  const summarizationEnabled = resolved.summarization.enable !== false;
  const summarizer = summarizationEnabled ? createContextSummarizeNode(runtimeOpts) : undefined;
  const decideBefore = resolverDecisionFactory(runtimeOpts, summarizationEnabled);
  const decideAfter = toolsDecisionFactory(runtimeOpts, summarizationEnabled);

  // Structured output: use the manager from the base agent's strategy resolution
  const soManager = opts.outputSchema
    ? new StructuredOutputManager<TOutput>(opts.outputSchema, resolveStrategy(opts.model))
    : undefined;

  const structuredOutputHint = soManager
    ? soManager.buildSystemPromptHint()
    : '';

  const runtimeHint = [
    resolved.runtimeProfile === resolved.baseProfile
      ? `Runtime profile: ${resolved.runtimeProfile}.`
      : `Runtime profile: ${resolved.runtimeProfile} (base: ${resolved.baseProfile}).`,
    `Context policy: ${resolved.context.policy}.`,
    `Planning mode: ${resolved.planning.mode}. Replan policy: ${resolved.planning.replanPolicy}.`,
    `Delegation mode: ${resolved.delegation.mode}. Child context policy: ${resolved.delegation.childContextPolicy}.`,
    `Tool response policy: ${resolved.context.toolResponsePolicy}.`,
  ].join('\n');

  function latestUserPrompt(messages: any[]): string {
    const latest = [...messages].reverse().find((message) => message.role === 'user');
    return latest ? extractMessageText(latest) : '';
  }

  async function syncMemory(state: SmartState): Promise<SmartState> {
    const query = latestUserPrompt(state.messages || []);
    const memoryFacts = await readMemoryFacts(memoryStore, resolved, query);
    return { ...state, memoryFacts };
  }

  async function persistLatestSummary(state: SmartState): Promise<SmartState> {
    if (!memoryStore) return state;
    if (resolved.memory.writePolicy === 'manual') return state;
    const latestSummary = state.summaryRecords?.[state.summaryRecords.length - 1];
    if (!latestSummary) return state;
    if (resolved.memory.writePolicy === 'auto_important' && latestSummary.stable_facts.length === 0) {
      return state;
    }
    const memoryFacts = await writeSummaryFactsToMemory(memoryStore, resolved, latestSummary, Math.max(1, (state.messages || []).filter((message) => message.role === 'user').length));
    return { ...state, memoryFacts };
  }

  function syncPlanState(state: SmartState): SmartState {
    if (!Array.isArray(stateRef.todoList)) return state;
    return {
      ...state,
      plan: {
        version: stateRef.planVersion || state.planVersion || 1,
        steps: stateRef.todoList,
        lastUpdated: new Date().toISOString(),
        adherenceScore: stateRef.adherenceScore || 0,
      },
      planVersion: stateRef.planVersion || state.planVersion || 1,
    };
  }

  function systemMessage(): any {
    const sys = buildSystemPrompt(
      [opts.systemPrompt, runtimeHint, structuredOutputHint].filter(Boolean).join("\n"),
      planningEnabled,
      opts.name || "Agent",
      opts.todoListPrompt,
    );
    return { role: 'system', content: sys } as any;
  }

  /** Runs the summarizer and applies the result to state. Returns updated state and whether summarization succeeded. */
  async function trySummarize(
    currentState: SmartState,
    currentRawMessages: any[],
  ): Promise<{ state: SmartState; rawMessages: any[]; compressed: boolean }> {
    if (!summarizer) return { state: currentState, rawMessages: currentRawMessages, compressed: false };
    const delta = await summarizer(currentState);
    if (!delta || Object.keys(delta).length === 0) {
      const ctx = { ...(currentState.ctx || {}), __summarizationExhausted: true };
      return { state: { ...currentState, ctx } as SmartState, rawMessages: currentRawMessages, compressed: false };
    }
    const ctx = { ...(currentState.ctx || {}) };
    delete ctx.__summarizationExhausted;
    const updated = await persistLatestSummary(syncPlanState({ ...currentState, ...delta, ctx } as SmartState));
    return { state: updated, rawMessages: [...(updated.messages || currentRawMessages)], compressed: true };
  }

  const instance: SmartAgentInstance<TOutput> = {
    invoke: async (input: SmartState, config?: InvokeConfig): Promise<AgentInvokeResult<TOutput>> => {
      // wire stateRef for context tools
      stateRef.toolHistory = input.toolHistory;
      stateRef.toolHistoryArchived = input.toolHistoryArchived;
      stateRef.todoList = input.plan?.steps;
      stateRef.planVersion = input.planVersion || input.plan?.version || 0;
      stateRef.adherenceScore = input.plan?.adherenceScore || 0;

      // Prepend a single system message once
      const alreadyHasSystem = Array.isArray(input.messages) && input.messages[0]?.role === 'system';
      const seedMessages = alreadyHasSystem ? [...(input.messages || [])] : [systemMessage(), ...(input.messages || [])];
      let state: SmartState = await syncMemory({ ...input, messages: seedMessages } as SmartState);
      let lastResult: AgentInvokeResult<TOutput> | null = null;
      let rawMessages = [...seedMessages];
      const effectiveMaxToolCalls = (config?.limits?.maxToolCalls ?? resolved.limits.maxToolCalls ?? 10) as number;
      const iterationLimit = Math.max(effectiveMaxToolCalls * 3 + 5, 30);

      for (let i = 0; i < iterationLimit; i++) {
        state = { ...state, messages: rawMessages } as SmartState;
        // Pre-agent summarization decision
        const next = summarizationEnabled ? decideBefore(state) : 'agent';
        if (next === 'contextSummarize' && summarizer) {
          const result = await trySummarize(state, rawMessages);
          state = result.state;
          rawMessages = result.rawMessages;
          if (result.compressed) continue;
        }

        // Delegate a full turn to base agent (includes tools + tool-limit finalize + structured output finalize)
        const modelMessages = buildModelMessages(state, resolved);
        const res = await base.invoke({ ...state, messages: modelMessages } as SmartState, config);
        lastResult = res as AgentInvokeResult<TOutput>;
        // Preserve summaries from current state when merging with result state
        const currentSummaries = state.summaries;
        const currentSummaryRecords = state.summaryRecords;
        const currentPlan = state.plan;
        const appendedMessages = res.messages.slice(modelMessages.length);
        rawMessages = [...rawMessages, ...appendedMessages];
        state = ((res.state as SmartState) || { ...state, messages: res.messages }) as SmartState;
        state = { ...state, messages: rawMessages } as SmartState;
        // Restore summaries if they were lost during state merge
        if (currentSummaries && currentSummaries.length > 0 && (!state.summaries || state.summaries.length === 0)) {
          state = { ...state, summaries: currentSummaries };
        }
        if (currentSummaryRecords && currentSummaryRecords.length > 0 && (!state.summaryRecords || state.summaryRecords.length === 0)) {
          state = { ...state, summaryRecords: currentSummaryRecords };
        }
        if (currentPlan && !state.plan) {
          state = { ...state, plan: currentPlan };
        }
        state = syncPlanState(await syncMemory(state));
        stateRef.toolHistory = state.toolHistory;
        stateRef.toolHistoryArchived = state.toolHistoryArchived;

        // Check if base agent signaled that summarization is needed (context too large)
        if ((state as any).ctx?.__needsSummarization && summarizer) {
          const ctx = { ...(state.ctx || {}) };
          delete ctx.__needsSummarization;
          state = { ...state, ctx } as SmartState;
          const result = await trySummarize(state, rawMessages);
          state = result.state;
          rawMessages = result.rawMessages;
          continue;
        }

        // If structured output finalize triggered, base already stopped with parsed output
        if ((state as any).ctx?.__finalizedDueToStructuredOutput) break;

        // If the base agent also parsed structured output via JSON-from-text fallback,
        // accept it and stop (the `output` field will be populated even without the flag).
        if (opts.outputSchema && lastResult?.output != null) break;

        // Post-tools summarization decision
        if (summarizationEnabled) {
          const after = decideAfter(state);
          if (after === 'contextSummarize' && summarizer) {
            const result = await trySummarize(state, rawMessages);
            state = result.state;
            rawMessages = result.rawMessages;
            if (result.compressed) continue;
          }
        }

        // If outputSchema is active but the base agent stopped without calling `response`,
        // the base agent's StructuredOutputManager handles retries internally.
        // No additional SmartAgent-level retries needed — the centralized manager
        // already exhausted its maxRetries with proper nudge/correction prompts.

        // If base produced an assistant message without tool calls (its normal stop), we're done.
        break;
      }

      // Fall back if base was never invoked (edge case)
      if (!lastResult) {
        const res = await base.invoke(state, config);
        lastResult = res as AgentInvokeResult<TOutput>;
      }

      // Ensure summaries are preserved in the final result
      if (state.summaries && state.summaries.length > 0) {
        if (lastResult.state) {
          lastResult = { ...lastResult, state: { ...lastResult.state, summaries: state.summaries, summaryRecords: state.summaryRecords, memoryFacts: state.memoryFacts, plan: state.plan, planVersion: state.planVersion, messages: rawMessages } };
        } else {
          lastResult = { ...lastResult, state: { ...state, summaries: state.summaries, summaryRecords: state.summaryRecords, memoryFacts: state.memoryFacts, plan: state.plan, planVersion: state.planVersion, messages: rawMessages } };
        }
      } else if (lastResult.state) {
        lastResult = { ...lastResult, state: { ...lastResult.state, memoryFacts: state.memoryFacts, plan: state.plan, planVersion: state.planVersion, messages: rawMessages } };
      }

      return lastResult as AgentInvokeResult<TOutput>;
    },
    snapshot: base.snapshot,
    resume: base.resume,
    resolveToolApproval: base.resolveToolApproval,
    asTool: base.asTool,
    asHandoff: base.asHandoff,
    __runtime: base.__runtime,
  };

  return instance;
}
