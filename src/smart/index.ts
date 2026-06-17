import type { AgentInvokeResult, InvokeConfig, SmartAgentOptions, SmartState, SmartAgentInstance, HumanInTheLoopAskUserConfig } from "../types.js";
import type { ZodSchema } from "zod";
import { createAgent } from "../agent.js";
import { createContextTools, createGetToolResponseTool, hasToolResponseRecoveryReference } from "../contextTools.js";
import { createAskUserQuestionTool } from "../humanLoop.js";
import { createContextSummarizeNode } from "../nodes/contextSummarize.js";
import { buildSystemPrompt } from "../prompts.js";
import { resolverDecisionFactory, toolsDecisionFactory } from "../graph/decisions.js";
import { normalizeSmartAgentOptions } from "./runtimeConfig.js";
import { buildModelMessages } from "./contextPolicy.js";
import { readMemoryFacts, resolveMemoryStore, writeSummaryFactsToMemory } from "./memory.js";
import { StructuredOutputManager } from "../structuredOutput/manager.js";
import { resolveStrategy, getModelCapabilities } from "../structuredOutput/resolver.js";
import { extractMessageText } from "../utils/content.js";
import { createSkillRegistryRef, DEFAULT_SKILL_POLICY, type Skill, type SkillPolicy } from "./skills/types.js";
import { createSkillTools } from "./skills/skillTools.js";
import { buildSkillHeaderBlock, composeToolSets, resolveAvailableSkills } from "./skills/registry.js";

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

  // Build a placeholder stateRef + tool set for the base agent construction.
  // Each invoke replaces these with fresh per-call instances so concurrent
  // invocations of the same agent do not clobber each other's plan/todo state.
  const userTools = ((opts.tools as any) ?? []) as any[];
  const factoryStateRef: any = { toolHistory: undefined, toolHistoryArchived: undefined, todoList: undefined, planVersion: 0, adherenceScore: 0 };
  const factoryContextTools = createContextTools(factoryStateRef, { planningEnabled, includeGetToolResponse: false });

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

  const factoryToolsWithoutRecovery = [...userTools, ...factoryContextTools];
  if (askUserConfig) {
    factoryToolsWithoutRecovery.push(createAskUserQuestionTool(factoryStateRef, askUserConfig));
  }

  // Progressive capability disclosure: when `skills` are supplied, the model
  // sees cheap skill headers and opens them on demand to bind their tools.
  const skills: Skill[] = ((opts as any).skills as Skill[] | undefined) ?? [];
  const skillPolicy: SkillPolicy = ((opts as any).skillPolicy as SkillPolicy | undefined) ?? DEFAULT_SKILL_POLICY;
  const skillsEnabled = skills.length > 0;

  // Pre-resolve the structured-output manager so we can plug the `response`
  // finalize tool into the smart runtime's tool set (state.agent.tools).
  // Otherwise the smart agent would override base agent's tools without the
  // finalize tool and the model could never call it.
  const soManagerFactory = opts.outputSchema
    ? new StructuredOutputManager<TOutput>(opts.outputSchema, resolveStrategy(opts.model))
    : undefined;
  const modelCapabilities = opts.outputSchema ? getModelCapabilities(opts.model) : undefined;
  const responseFinalizeTool = soManagerFactory && modelCapabilities?.structuredOutput !== "native"
    ? soManagerFactory.getResponseTool()
    : undefined;

  type InvokeToolSet = {
    stateRef: any;
    toolsWithoutRecovery: any[];
    toolsWithRecovery: any[];
    skillRegistryRef?: any;
  };
  const buildInvokeToolSet = (): InvokeToolSet => {
    const ref: any = { toolHistory: undefined, toolHistoryArchived: undefined, todoList: undefined, planVersion: 0, adherenceScore: 0 };
    const ctxTools = createContextTools(ref, { planningEnabled, includeGetToolResponse: false });
    const recoveryTool = createGetToolResponseTool(ref);
    const coreBase = [...userTools, ...ctxTools];
    if (responseFinalizeTool) coreBase.push(responseFinalizeTool);
    if (askUserConfig) coreBase.push(createAskUserQuestionTool(ref, askUserConfig));

    if (!skillsEnabled) {
      const without = coreBase;
      const withRec = [...without, recoveryTool];
      return { stateRef: ref, toolsWithoutRecovery: without, toolsWithRecovery: withRec };
    }

    // Skill mode: open_skill/bind_skill_tools mutate a per-invoke registry and
    // call __onToolsChanged, which rebuilds BOTH tool-set variants with fresh
    // references so syncRuntimeTools' identity-swap propagates the newly-bound
    // tools (and the recovery variant can never drop them).
    const toolSet: InvokeToolSet = { stateRef: ref, toolsWithoutRecovery: [], toolsWithRecovery: [] };
    const skillRegistryRef = createSkillRegistryRef();
    const skillMetaTools = createSkillTools({ registryRef: skillRegistryRef, skills, policy: skillPolicy });
    const baseWithMeta = [...coreBase, ...skillMetaTools];
    const rebuild = () => {
      const composed = composeToolSets({
        base: baseWithMeta,
        boundSkillTools: skillRegistryRef.boundSkillTools,
        recoveryTool,
      });
      toolSet.toolsWithoutRecovery = composed.toolsWithoutRecovery;
      toolSet.toolsWithRecovery = composed.toolsWithRecovery;
    };
    skillRegistryRef.__onToolsChanged = rebuild;
    toolSet.skillRegistryRef = skillRegistryRef;
    rebuild();
    return toolSet;
  };

  // Compose base agent – pass summarization config so createAgent's token-budget
  // guard and __needsSummarization throw know summarization is handled externally.
  const base = createAgent<TOutput>({ ...runtimeOpts, tools: factoryToolsWithoutRecovery });
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

  function syncPlanStateWith(ref: any, state: SmartState): SmartState {
    if (!Array.isArray(ref.todoList)) return state;
    return {
      ...state,
      plan: {
        version: ref.planVersion || state.planVersion || 1,
        steps: ref.todoList,
        lastUpdated: new Date().toISOString(),
        adherenceScore: ref.adherenceScore || 0,
      },
      planVersion: ref.planVersion || state.planVersion || 1,
    };
  }

  function systemMessage(extraBlock?: string): any {
    const sys = buildSystemPrompt(
      [opts.systemPrompt, runtimeHint, structuredOutputHint, extraBlock].filter(Boolean).join("\n"),
      planningEnabled,
      opts.name || "Agent",
      opts.todoListPrompt,
    );
    return { role: 'system', content: sys } as any;
  }

  function syncRuntimeTools(
    currentState: SmartState,
    currentMessages: any[],
    toolSet: InvokeToolSet,
  ): SmartState {
    const needsRecoveryTool = hasToolResponseRecoveryReference(currentMessages as Array<{ content?: unknown }>);
    const nextTools = needsRecoveryTool ? toolSet.toolsWithRecovery : toolSet.toolsWithoutRecovery;
    const currentRuntime = currentState.agent || base.__runtime;

    if (currentRuntime.tools === nextTools) {
      return currentState;
    }

    return {
      ...currentState,
      agent: {
        ...currentRuntime,
        tools: nextTools,
      },
    };
  }

  function producedTerminalAssistantTurn(messages: any[]) {
    const lastAssistant = [...messages].reverse().find((message) => message?.role === 'assistant');
    if (!lastAssistant) return false;
    const toolCalls = Array.isArray(lastAssistant.tool_calls) ? lastAssistant.tool_calls : [];
    return toolCalls.length === 0;
  }

  /** Runs the summarizer and applies the result to state. Returns updated state and whether summarization succeeded. */
  async function trySummarize(
    currentState: SmartState,
    currentRawMessages: any[],
    ref: any,
  ): Promise<{ state: SmartState; rawMessages: any[]; compressed: boolean }> {
    if (!summarizer) return { state: currentState, rawMessages: currentRawMessages, compressed: false };
    const delta = await summarizer(currentState);
    if (!delta || Object.keys(delta).length === 0) {
      const ctx = { ...(currentState.ctx || {}), __summarizationExhausted: true };
      return { state: { ...currentState, ctx } as SmartState, rawMessages: currentRawMessages, compressed: false };
    }
    const ctx = { ...(currentState.ctx || {}) };
    delete ctx.__summarizationExhausted;
    const updated = await persistLatestSummary(syncPlanStateWith(ref, { ...currentState, ...delta, ctx } as SmartState));
    return { state: updated, rawMessages: [...(updated.messages || currentRawMessages)], compressed: true };
  }

  const instance: SmartAgentInstance<TOutput> = {
    invoke: async (input: SmartState, config?: InvokeConfig): Promise<AgentInvokeResult<TOutput>> => {
      // Per-invoke tool set + stateRef so concurrent invocations on the same
      // agent instance never share planning/todo/tool-history state.
      const toolSet = buildInvokeToolSet();
      const stateRef = toolSet.stateRef;
      stateRef.toolHistory = input.toolHistory;
      stateRef.toolHistoryArchived = input.toolHistoryArchived;
      stateRef.todoList = input.plan?.steps;
      stateRef.planVersion = input.planVersion || input.plan?.version || 0;
      stateRef.adherenceScore = input.plan?.adherenceScore || 0;

      const syncPlanFromRef = (state: SmartState) => syncPlanStateWith(stateRef, state);

      // Resolve which skills are usable this invoke (availability + tier gating)
      // and surface their headers in the system prompt so the model knows what
      // it can open. open_skill re-checks availability at call time.
      const availableSkills = skillsEnabled
        ? await resolveAvailableSkills(skills, { modelTier: skillPolicy.modelTier })
        : [];
      const skillBlock = availableSkills.length > 0 ? buildSkillHeaderBlock(availableSkills) : undefined;

      // Prepend a single system message once
      const alreadyHasSystem = Array.isArray(input.messages) && input.messages[0]?.role === 'system';
      const seedMessages = alreadyHasSystem ? [...(input.messages || [])] : [systemMessage(skillBlock), ...(input.messages || [])];
      let state: SmartState = syncRuntimeTools(await syncMemory({ ...input, messages: seedMessages } as SmartState), seedMessages, toolSet);
      let lastResult: AgentInvokeResult<TOutput> | null = null;
      let rawMessages = [...seedMessages];
      const effectiveMaxToolCalls = (config?.limits?.maxToolCalls ?? resolved.limits.maxToolCalls ?? 10) as number;
      const iterationLimit = Math.max(effectiveMaxToolCalls * 3 + 5, 30);

      for (let i = 0; i < iterationLimit; i++) {
        state = syncRuntimeTools({ ...state, messages: rawMessages } as SmartState, rawMessages, toolSet);
        // Pre-agent summarization decision
        const next = summarizationEnabled ? decideBefore(state) : 'agent';
        if (next === 'contextSummarize' && summarizer) {
          const result = await trySummarize(state, rawMessages, stateRef);
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
        state = syncRuntimeTools(syncPlanFromRef(await syncMemory(state)), rawMessages, toolSet);
        stateRef.toolHistory = state.toolHistory;
        stateRef.toolHistoryArchived = state.toolHistoryArchived;

        // Check if base agent signaled that summarization is needed (context too large)
        if ((state as any).ctx?.__needsSummarization && summarizer) {
          const ctx = { ...(state.ctx || {}) };
          delete ctx.__needsSummarization;
          state = { ...state, ctx } as SmartState;
          const result = await trySummarize(state, rawMessages, stateRef);
          state = result.state;
          rawMessages = result.rawMessages;
          continue;
        }

        // If structured output finalize triggered, base already stopped with parsed output
        if ((state as any).ctx?.__finalizedDueToStructuredOutput) break;

        // If the base agent also parsed structured output via JSON-from-text fallback,
        // accept it and stop (the `output` field will be populated even without the flag).
        if (opts.outputSchema && lastResult?.output != null) break;

        // Once the model has produced a terminal assistant turn, do not run a
        // post-turn summarization pass. Summary messages are internal state
        // maintenance and should only happen before the next model call, not
        // after a real final answer has already been produced for this turn.
        if (producedTerminalAssistantTurn(appendedMessages)) break;

        // Post-tools summarization decision
        if (summarizationEnabled) {
          const after = decideAfter(state);
          if (after === 'contextSummarize' && summarizer) {
            const result = await trySummarize(state, rawMessages, stateRef);
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
    resolveUserQuestion: base.resolveUserQuestion,
    asTool: base.asTool,
    asHandoff: base.asHandoff,
    __runtime: base.__runtime,
  };

  return instance;
}
