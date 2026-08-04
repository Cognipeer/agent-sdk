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
import { appendBoundTools, buildSkillHeaderBlock, composeToolSets, resolveAvailableSkills } from "./skills/registry.js";
import { createSubagentRegistryRef, DEFAULT_SUBAGENT_POLICY, type SubagentDef, type SubagentPolicy } from "./subagents/types.js";
import { buildSubagentCatalogBlock, resolveAvailableSubagents } from "./subagents/registry.js";
import { createSubagentTools, type BuildChildConfig, type SubagentToolDeps } from "./subagents/subagentTools.js";
import type { PromptHooks, ToolInterface } from "../types.js";

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

  // Sub-agents: dynamic problem decomposition (registry + ad-hoc + parallel).
  // OPT-IN: the spawn tools + <available_subagents> catalog are only wired when
  // the caller explicitly passes `subagents` or `subagentPolicy`. Without either,
  // a plain createSmartAgent stays sub-agent-free.
  const subagentsProvided = (opts as any).subagents !== undefined || (opts as any).subagentPolicy !== undefined;
  const subagents: SubagentDef[] = ((opts as any).subagents as SubagentDef[] | undefined) ?? [];
  const subagentPolicy: SubagentPolicy = ((opts as any).subagentPolicy as SubagentPolicy | undefined) ?? DEFAULT_SUBAGENT_POLICY;
  const subagentsEnabled = subagentsProvided && subagentPolicy.mode !== "off" && (subagents.length > 0 || subagentPolicy.mode === "registry_and_adhoc");
  const promptHooks: PromptHooks | undefined = (opts as any).promptHooks as PromptHooks | undefined;

  // DI factory so the sub-agent tools can build child agents without importing
  // createSmartAgent (avoids a circular module dependency). Children inherit the
  // parent's HITL/reasoning/token wiring but NOT its sub-agents (depth-guarded).
  const buildChild = (cfg: BuildChildConfig): SmartAgentInstance => createSmartAgent({
    name: cfg.name,
    model: cfg.model,
    tools: cfg.tools,
    systemPrompt: cfg.systemPrompt,
    outputSchema: cfg.outputSchema,
    limits: cfg.limits,
    runtimeProfile: resolved.runtimeProfile,
    humanInTheLoop: (opts as any).humanInTheLoop,
    reasoning: (opts as any).reasoning,
    tokenCounter: (opts as any).tokenCounter,
    costEstimator: (opts as any).costEstimator,
    promptHooks,
    // Sub-agents are single-level by design: a child never gets its own spawn
    // tools, so it cannot delegate further. This keeps decomposition bounded and
    // is why the depth guard mainly governs `asTool`-composed nesting (which seeds
    // __delegationDepth externally) rather than sub-agent-of-sub-agent recursion.
    subagents: [],
    subagentPolicy: { ...subagentPolicy, mode: "off" },
  } as any);

  // Apply description overrides uniformly to any tool (clones the few user/skill
  // tools that have an override so shared tool objects are never mutated).
  const decorateToolDescriptions = (tools: ToolInterface[]): ToolInterface[] => {
    const overrides = promptHooks?.toolDescriptions;
    if (!overrides) return tools;
    return tools.map((tool) => {
      const override = overrides[(tool as any)?.name];
      if (override === undefined) return tool;
      const next = typeof override === "function" ? override((tool as any).description || "") : override;
      if (next === (tool as any).description) return tool;
      return { ...(tool as any), description: next } as ToolInterface;
    });
  };

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
    subagentRegistryRef?: any;
  };
  const buildInvokeToolSet = (): InvokeToolSet => {
    const ref: any = { toolHistory: undefined, toolHistoryArchived: undefined, todoList: undefined, planVersion: 0, adherenceScore: 0 };
    const ctxTools = createContextTools(ref, { planningEnabled, includeGetToolResponse: false });
    const recoveryTool = createGetToolResponseTool(ref);
    const coreBase = [...userTools, ...ctxTools];
    if (responseFinalizeTool) coreBase.push(responseFinalizeTool);
    if (askUserConfig) coreBase.push(createAskUserQuestionTool(ref, askUserConfig));

    // Sub-agent tools share one per-invoke registry ref (spawn budget/results).
    let subagentRegistryRef: any;
    if (subagentsEnabled) {
      subagentRegistryRef = createSubagentRegistryRef();
      const deps: SubagentToolDeps = {
        registryRef: subagentRegistryRef,
        subagents,
        policy: subagentPolicy,
        buildChild,
        // NOTE: promptHooks.toolDescriptions overrides for the sub-agent tools are
        // applied uniformly (and only) by decorateToolDescriptions below, so the
        // function form of an override receives the real DEFAULT_* string. Baking
        // them in here as well would double-apply and stringify the function.
      };
      coreBase.push(...createSubagentTools(deps));
    }

    if (!skillsEnabled) {
      const without = decorateToolDescriptions(coreBase);
      const withRec = decorateToolDescriptions([...coreBase, recoveryTool]);
      return { stateRef: ref, toolsWithoutRecovery: without, toolsWithRecovery: withRec, subagentRegistryRef };
    }

    // Skill mode: open_skill/bind_skill_tools mutate a per-invoke registry and
    // call __onToolsChanged, which rebuilds BOTH tool-set variants with fresh
    // references so syncRuntimeTools' identity-swap propagates the newly-bound
    // tools (and the recovery variant can never drop them).
    const toolSet: InvokeToolSet = { stateRef: ref, toolsWithoutRecovery: [], toolsWithRecovery: [], subagentRegistryRef };
    const skillRegistryRef = createSkillRegistryRef();
    const skillMetaTools = createSkillTools({ registryRef: skillRegistryRef, skills, policy: skillPolicy });
    const baseWithMeta = [...coreBase, ...skillMetaTools];
    const rebuild = () => {
      const composed = composeToolSets({
        base: baseWithMeta,
        boundSkillTools: skillRegistryRef.boundSkillTools,
        recoveryTool,
      });
      toolSet.toolsWithoutRecovery = decorateToolDescriptions(composed.toolsWithoutRecovery);
      toolSet.toolsWithRecovery = decorateToolDescriptions(composed.toolsWithRecovery);
    };
    skillRegistryRef.__onToolsChanged = rebuild;
    toolSet.skillRegistryRef = skillRegistryRef;
    rebuild();
    return toolSet;
  };

  // Skill state is per-invoke, so a resumed run (after any pause) would otherwise
  // rebuild the skill registry empty and drop every opened/bound skill tool. We
  // persist the opened keys + bound tool names on ctx.__skillState and rehydrate
  // by re-binding on the next invoke, so bound skill tools survive pause/resume.
  type PersistedSkillState = { openedSkillKeys: string[]; boundToolNames: string[] };
  async function rehydrateSkillRegistry(ref: any, persisted: PersistedSkillState | undefined): Promise<boolean> {
    if (!persisted) return false;
    const opened = Array.isArray(persisted.openedSkillKeys) ? persisted.openedSkillKeys : [];
    const boundNames = new Set(Array.isArray(persisted.boundToolNames) ? persisted.boundToolNames : []);
    if (opened.length === 0) return false;
    let changed = false;
    for (const key of opened) {
      if (!ref.openedSkillKeys.includes(key)) ref.openedSkillKeys.push(key);
      const skill = skills.find((s) => s.key === key);
      if (!skill) continue;
      let bound;
      try { bound = await skill.bindTools(); } catch { continue; }
      const wanted = (bound as any[]).filter((t) => boundNames.has(t.name));
      const added = appendBoundTools(ref, wanted, skillPolicy);
      if (added.length > 0) changed = true;
    }
    return changed;
  }
  function skillStateFromRegistry(ref: any): PersistedSkillState | undefined {
    if (!ref || !Array.isArray(ref.openedSkillKeys) || ref.openedSkillKeys.length === 0) return undefined;
    return {
      openedSkillKeys: [...ref.openedSkillKeys],
      boundToolNames: (ref.boundSkillTools || []).map((t: any) => t.name),
    };
  }

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
    let sys = buildSystemPrompt(
      [opts.systemPrompt, runtimeHint, structuredOutputHint, extraBlock].filter(Boolean).join("\n"),
      planningEnabled,
      opts.name || "Agent",
      opts.todoListPrompt,
    );
    // Prompt-override hook: let callers intercept the otherwise-static prompt.
    if (promptHooks?.transformSystemPrompt) {
      try {
        sys = promptHooks.transformSystemPrompt(sys, { agentName: opts.name || "Agent" });
      } catch (err) {
        console.warn('[agent-sdk] promptHooks.transformSystemPrompt error:', err);
      }
    }
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
      // Stamp the tool-history size: the summarizer could not reclaim anything at
      // THIS point, which is not the same as never. A pass deferred because the
      // only compressable messages were the model's live working set must not
      // disable summarization for the rest of the run — new tool output is what
      // creates new compressable material, so that is what re-arms it.
      const ctx = {
        ...(currentState.ctx || {}),
        __summarizationExhausted: true,
        __summarizationExhaustedAtToolCount: (currentState.toolHistory || []).length,
      };
      return { state: { ...currentState, ctx } as SmartState, rawMessages: currentRawMessages, compressed: false };
    }
    const ctx = { ...(currentState.ctx || {}) };
    delete ctx.__summarizationExhausted;
    delete (ctx as any).__summarizationExhaustedAtToolCount;
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

      // Rehydrate previously opened/bound skills so a resumed run keeps its skill
      // tools (they were bound in an earlier invoke's per-invoke registry).
      if (skillsEnabled && toolSet.skillRegistryRef) {
        const changed = await rehydrateSkillRegistry(toolSet.skillRegistryRef, (input as any).ctx?.__skillState);
        if (changed) toolSet.skillRegistryRef.__onToolsChanged?.();
      }

      const syncPlanFromRef = (state: SmartState) => syncPlanStateWith(stateRef, state);

      // Resolve which skills are usable this invoke (availability + tier gating)
      // and surface their headers in the system prompt so the model knows what
      // it can open. open_skill re-checks availability at call time.
      //
      // Under `disclosure: "search"` discovery moves into the search_skills tool
      // instead, so nothing is rendered here — and the availability probes are
      // skipped too, since that tool resolves them itself when it is called.
      const catalogDisclosure = skillPolicy.disclosure !== "search";
      const availableSkills =
        skillsEnabled && catalogDisclosure
          ? await resolveAvailableSkills(skills, { modelTier: skillPolicy.modelTier })
          : [];
      const skillBlock = availableSkills.length > 0 ? buildSkillHeaderBlock(availableSkills) : undefined;

      // Surface the sub-agent catalog so the model knows what it can delegate to.
      let subagentBlock: string | undefined;
      if (subagentsEnabled) {
        const availableSubagents = await resolveAvailableSubagents(subagents);
        let block = buildSubagentCatalogBlock(availableSubagents, subagentPolicy, {
          delegate: "delegate_to",
          spawn: "spawn_subagent",
          parallel: "spawn_subagents_parallel",
        });
        if (promptHooks?.subagentCatalog) {
          try { block = promptHooks.subagentCatalog(block, availableSubagents); }
          catch (err) { console.warn('[agent-sdk] promptHooks.subagentCatalog error:', err); }
        }
        subagentBlock = block;
      }
      const disclosureBlock = [skillBlock, subagentBlock].filter(Boolean).join("\n\n") || undefined;

      // Prepend a single system message once
      const alreadyHasSystem = Array.isArray(input.messages) && input.messages[0]?.role === 'system';
      const seedMessages = alreadyHasSystem ? [...(input.messages || [])] : [systemMessage(disclosureBlock), ...(input.messages || [])];
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

      // Persist opened/bound skills so a resumed run can rehydrate them.
      if (skillsEnabled && lastResult.state) {
        const persisted = skillStateFromRegistry(toolSet.skillRegistryRef);
        if (persisted) {
          const prevCtx = (lastResult.state as any).ctx || {};
          lastResult = { ...lastResult, state: { ...lastResult.state, ctx: { ...prevCtx, __skillState: persisted } } as SmartState };
        }
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
