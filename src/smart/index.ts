import type { AgentInvokeResult, InvokeConfig, SmartAgentOptions, SmartState, SmartAgentInstance } from "../types.js";
import type { ZodSchema } from "zod";
import { createAgent } from "../agent.js";
import { createContextTools } from "../contextTools.js";
import { createContextSummarizeNode } from "../nodes/contextSummarize.js";
import { buildSystemPrompt } from "../prompts.js";
import { resolverDecisionFactory, toolsDecisionFactory } from "../graph/decisions.js";
import { normalizeSmartAgentOptions } from "./runtimeConfig.js";
import { buildModelMessages, estimateContextRotScore } from "./contextPolicy.js";
import { readMemoryFacts, resolveMemoryStore, writeSummaryFactsToMemory } from "./memory.js";
import { countApproxTokens } from "../utils/utilTokens.js";

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
    watchdog: resolved.watchdog,
    useTodoList: planningEnabled,
  };

  // Prepare context tools (todo + get_tool_response). Avoid duplicating response tool; base agent will add it if schema provided.
  const stateRef: any = { toolHistory: undefined, toolHistoryArchived: undefined, todoList: undefined, planVersion: 0, adherenceScore: 0 };
  const contextTools = createContextTools(stateRef, { planningEnabled, outputSchema: undefined });
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

  const structuredOutputHint = opts.outputSchema
    ? [
      'A structured output schema is active.',
      'Do NOT output the final JSON directly as an assistant message.',
      'When completely finished, call tool `response` passing the final JSON matching the schema as its arguments (direct object).',
      'Call it exactly once then STOP producing further assistant messages.'
    ].join('\n')
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
    if (!latest) return '';
    return typeof latest.content === 'string'
      ? latest.content
      : Array.isArray(latest.content)
      ? latest.content.map((part: any) => (typeof part === 'string' ? part : part?.text ?? part?.content ?? '')).join(' ')
      : '';
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
      let previousTokenCount = countApproxTokens(rawMessages.map((message: any) => typeof message.content === 'string' ? message.content : JSON.stringify(message.content)).join('\n'));

      for (let i = 0; i < iterationLimit; i++) {
        state = { ...state, messages: rawMessages } as SmartState;
        // Pre-agent summarization decision
        const next = summarizationEnabled ? decideBefore(state) : 'agent';
        if (next === 'contextSummarize' && summarizer) {
          const delta = await summarizer(state);
          // Prevent infinite loop if summarizer returns no changes (e.g. error or nothing to summarize)
          if (!delta || Object.keys(delta).length === 0) {
             // Summarization failed to produce a change. Proceed to agent to avoid stall, 
             // though it might hit token limits.
          } else {
             state = await persistLatestSummary(syncPlanState({ ...state, ...delta } as SmartState));
             rawMessages = [...(state.messages || rawMessages)];
             continue; // run decision again before calling base
          }
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

        const currentTokenCount = countApproxTokens(rawMessages.map((message: any) => typeof message.content === 'string' ? message.content : JSON.stringify(message.content)).join('\n'));
        const tokenDrift = Math.max(0, currentTokenCount - previousTokenCount);
        const toolMessagesThisTurn = appendedMessages.filter((message: any) => message.role === 'tool').length;
        const overToolingRate = appendedMessages.length === 0 ? 0 : Number((toolMessagesThisTurn / appendedMessages.length).toFixed(2));
        state = {
          ...state,
          watchdog: {
            tokenDrift,
            contextRotScore: estimateContextRotScore(state),
            overToolingRate,
            compactions: state.watchdog?.compactions || 0,
            lastAction: appendedMessages.length > 0 ? 'agent_turn' : state.watchdog?.lastAction,
          },
        };
        previousTokenCount = currentTokenCount;

        if (resolved.watchdog.enabled && resolved.watchdog.autoCompaction) {
          const shouldCompact = tokenDrift >= resolved.watchdog.tokenDriftThreshold
            || (state.watchdog?.overToolingRate || 0) >= resolved.watchdog.overToolingSpikeThreshold
            || (state.watchdog?.contextRotScore || 0) >= resolved.watchdog.contextRotThreshold;
          if (shouldCompact) {
            state = { ...state, ctx: { ...(state.ctx || {}), __needsSummarization: true } };
          }
        }

        // Check if base agent signaled that summarization is needed (context too large)
        if ((state as any).ctx?.__needsSummarization && summarizer) {
          // Clear the flag
          const ctx = { ...(state.ctx || {}) };
          delete ctx.__needsSummarization;
          state = { ...state, ctx } as SmartState;
          // Run summarization
          const delta = await summarizer(state);
          // If delta is valid, apply and loop back to retry the agent pass after compaction.
          // If delta is empty, summarization had nothing to compress — fall through to
          // the normal break logic so the loop can terminate.
          if (delta && Object.keys(delta).length > 0) {
             state = await persistLatestSummary(syncPlanState({ ...state, ...delta } as SmartState));
             rawMessages = [...(state.messages || rawMessages)];
             continue; // Loop will attempt another agent pass after summarization
          }
        }

        // If structured output finalize triggered, base already stopped with parsed output
        if ((state as any).ctx?.__finalizedDueToStructuredOutput) break;

        // Post-tools summarization decision
        if (summarizationEnabled) {
          const after = decideAfter(state);
          if (after === 'contextSummarize' && summarizer) {
            const delta = await summarizer(state);
             if (delta && Object.keys(delta).length > 0) {
                state = await persistLatestSummary(syncPlanState({ ...state, ...delta } as SmartState));
                rawMessages = [...(state.messages || rawMessages)];
                // Loop will attempt another agent pass
                continue;
             }
          }
        }

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
          lastResult = { ...lastResult, state: { ...lastResult.state, summaries: state.summaries, summaryRecords: state.summaryRecords, memoryFacts: state.memoryFacts, plan: state.plan, planVersion: state.planVersion, watchdog: state.watchdog, messages: rawMessages } };
        } else {
          lastResult = { ...lastResult, state: { ...state, summaries: state.summaries, summaryRecords: state.summaryRecords, memoryFacts: state.memoryFacts, plan: state.plan, planVersion: state.planVersion, watchdog: state.watchdog, messages: rawMessages } };
        }
      } else if (lastResult.state) {
        lastResult = { ...lastResult, state: { ...lastResult.state, memoryFacts: state.memoryFacts, plan: state.plan, planVersion: state.planVersion, watchdog: state.watchdog, messages: rawMessages } };
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
