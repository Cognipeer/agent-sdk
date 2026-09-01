import type { AgentInvokeResult, InvokeConfig, SmartAgentOptions, SmartState, SmartAgentInstance, HumanInTheLoopAskUserConfig } from "../types.js";
import type { ZodSchema } from "zod";
import { createAgent, buildHandoffTools } from "../agent.js";
import { nanoid } from "nanoid";
import { countMessagesTokens } from "../utils/utilTokens.js";
import { openPluginSession } from "../plugins/session.js";
import { createPluginTraceRecorder } from "../plugins/trace.js";
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
import { preopenSkills } from "./skills/preopen.js";
import { appendBoundTools, buildSkillHeaderBlock, composeToolSets, resolveAvailableSkills } from "./skills/registry.js";
import { createSubagentRegistryRef, DEFAULT_SUBAGENT_POLICY, type SubagentDef, type SubagentPolicy } from "./subagents/types.js";
import { buildSubagentCatalogBlock, resolveAvailableSubagents } from "./subagents/registry.js";
import { createSubagentTools, type BuildChildConfig, type SubagentToolDeps } from "./subagents/subagentTools.js";
import type { PromptHooks, ToolInterface } from "../types.js";

// SmartAgent on top of core createAgent: adds system prompt, optional planning context tools, and token-aware summarization.
export function createSmartAgent<TOutput = unknown>(opts: SmartAgentOptions & { outputSchema?: ZodSchema<TOutput> }): SmartAgentInstance<TOutput> {
  const resolved = normalizeSmartAgentOptions(opts);
  const planningEnabled = resolved.planning.mode !== 'off';
  // Reassigned by ensurePluginSetup when a plugin fills the slot and the caller
  // passed no `memory.store` of their own. It is a `let` because the host does
  // not exist yet at this point — the core agent owns it, and the core agent is
  // built further down.
  let memoryStore = resolveMemoryStore(resolved);
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
  const handoffTools = Array.isArray(opts.handoffs) ? buildHandoffTools(opts.handoffs) : [];
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

  const factoryToolsWithoutRecovery = [...userTools, ...handoffTools, ...factoryContextTools];
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
    // A policy a delegation can shed is not a policy: children inherit every
    // plugin that has not explicitly opted out with inheritToSubagents: false.
    plugins: pluginHost?.childPlugins(),
    pluginOptions: (opts as any).pluginOptions,
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
    // Plugin overrides first, then the legacy promptHooks map, so a caller's
    // own promptHooks still has the last word. Applied exactly once over the
    // fully composed set — a second pass would feed an already-overridden
    // string into a function-form override that expects the real default.
    const pluginOverrides = pluginHost?.contributions.toolDescriptions;
    const overrides =
      pluginOverrides && Object.keys(pluginOverrides).length > 0
        ? { ...pluginOverrides, ...(promptHooks?.toolDescriptions ?? {}) }
        : promptHooks?.toolDescriptions;
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

  // Declared before buildInvokeToolSet so the closure can read it; populated by
  // ensurePluginSetup(), which every invoke awaits before building its tool set.
  type InvokeToolSet = {
    /** The last runtime this loop wrote its tools onto — see syncRuntimeTools. */
    ownedRuntime?: any;
    /**
     * Stamped onto every runtime this loop builds. Object identity alone is not
     * enough: the tools node clones the runtime when a skill injects tools
     * (`__runtimeToolsDelta`), and a clone would look foreign and freeze the
     * tool set for the rest of the run.
     */
    ownerToken?: symbol;
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
    // Plugin `tools` contributions land in THREE places or they exist in some
    // runs and not others: the per-agent factory list (resume / asTool), this
    // per-invoke list (the live loop), and the skill rebuild closure below.
    // The core agent covers the first; this covers the other two.
    // Handoff tools belong to every tool set this agent builds. createAgent
    // appends them to its own runtime, but the smart loop OVERWRITES
    // state.agent.tools with this set on every iteration, so anything missing
    // here is invisible to the model — which is how a typed, documented
    // `handoffs` option came to do nothing at all on a smart agent.
    const coreBase = [...userTools, ...handoffTools, ...pluginContributedTools, ...ctxTools];
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

  // The core agent owns the plugin host; the smart layer borrows its resolved
  // contributions rather than building a second host (two hosts would mean two
  // setups, two slot registries and two decision paths).
  const pluginHost = (base as any).__plugins as import("../plugins/host.js").PluginHost | undefined;
  let pluginContributedTools: any[] = [];
  const ensurePluginSetup = async () => {
    if (!pluginHost) return;
    await pluginHost.setup({ agentName: opts.name, agentVersion: opts.version, model: opts.model });
    pluginContributedTools = pluginHost.contributions.tools as any[];
    // An explicit `memory.store` always wins; the slot only replaces the
    // implicit in-memory default that every profile falls back to.
    if (pluginHost.slots.memoryStore && !opts.memory?.store) {
      memoryStore = pluginHost.slots.memoryStore;
    }
  };
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

  function systemMessage(extraBlock?: string, pluginAppend?: string): any {
    let sys = buildSystemPrompt(
      [opts.systemPrompt, runtimeHint, structuredOutputHint, extraBlock].filter(Boolean).join("\n"),
      planningEnabled,
      opts.name || "Agent",
      opts.todoListPrompt,
    );
    // Plugin contributions compose BEFORE the legacy transform, whose
    // documented contract is that it receives the fully-composed prompt.
    if (pluginHost) sys = pluginHost.contributions.applySystemPrompt(sys);
    if (pluginAppend) sys = `${sys}\n\n${pluginAppend}`;
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

    // A handoff replaces state.agent with the TARGET agent's runtime. Writing
    // this agent's tools onto it would hand the target its predecessor's tool
    // set and silently undo the handoff on the next iteration, so a runtime
    // this loop did not produce is left exactly as it is.
    if (
      toolSet.ownerToken
      && (currentRuntime as any).__ownerToken !== toolSet.ownerToken
      && currentRuntime !== base.__runtime
    ) {
      return currentState;
    }

    if (currentRuntime.tools === nextTools) {
      return currentState;
    }

    if (!toolSet.ownerToken) toolSet.ownerToken = Symbol("smart-runtime-owner");
    // Tools a TOOL put on the runtime — `open_skill` and friends, via
    // `__runtimeToolsDelta` — are not in either of this loop's sets, so writing
    // a set over the runtime would drop them and the model would lose a skill it
    // had just opened. They are carried across every sync instead.
    const loopToolNames = new Set<string>([
      ...toolSet.toolsWithoutRecovery.map((tool: any) => tool?.name),
      ...toolSet.toolsWithRecovery.map((tool: any) => tool?.name),
    ]);
    const injected = ((currentRuntime.tools as any[]) ?? []).filter(
      (tool) => tool?.name && !loopToolNames.has(tool.name),
    );
    // The token rides on the object, so a clone the tools node makes is still
    // recognised as ours.
    const nextRuntime = {
      ...currentRuntime,
      tools: injected.length > 0 ? [...nextTools, ...injected] : nextTools,
      __ownerToken: toolSet.ownerToken,
    };
    toolSet.ownedRuntime = nextRuntime;
    return { ...currentState, agent: nextRuntime };
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

    // Read from ctx rather than a closure: this helper runs per compaction pass
    // and the host is per-invoke, so binding it at factory time would share one
    // host across concurrent invokes of the same agent.
    const compactHost = (currentState.ctx as any)?.__plugins as
      | import("../plugins/host.js").PluginRunHost
      | undefined;
    const tokensBefore = countMessagesTokens((currentState.messages || []) as any);

    if (compactHost?.has("preCompact")) {
      const gate = await compactHost.runGate("preCompact", {
        reason: "token_pressure",
        messages: (currentState.messages || []) as any,
        tokenCount: tokensBefore,
        threshold: resolved.summarization.summaryTriggerTokens,
      });
      if (gate.flags.skip) {
        // Mapped onto the SAME shape an empty delta produces, so the
        // exhaustion stamp still lands and the driver does not re-arm
        // compaction every iteration.
        const ctx = {
          ...(currentState.ctx || {}),
          __summarizationExhausted: true,
          __summarizationExhaustedAtToolCount: (currentState.toolHistory || []).length,
        };
        return { state: { ...currentState, ctx } as SmartState, rawMessages: currentRawMessages, compressed: false };
      }
    }

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

    const latestSummary = updated.summaryRecords?.[updated.summaryRecords.length - 1];
    if (compactHost?.has("postCompact") && latestSummary) {
      await compactHost.runObservers("postCompact", {
        summary: latestSummary,
        tokensBefore,
        tokensAfter: countMessagesTokens((updated.messages || []) as any),
        strategy: "builtin",
      });
    }

    return { state: updated, rawMessages: [...(updated.messages || currentRawMessages)], compressed: true };
  }

  const instance: SmartAgentInstance<TOutput> = {
    invoke: async (input: SmartState, config?: InvokeConfig): Promise<AgentInvokeResult<TOutput>> => {
      // Per-invoke tool set + stateRef so concurrent invocations on the same
      // agent instance never share planning/todo/tool-history state.
      await ensurePluginSetup();

      // ── Plugin session ────────────────────────────────────────────────────
      // The driver below calls base.invoke() repeatedly for one logical turn,
      // so the session is opened HERE and threaded down. A base leg that
      // receives `__pluginSession` fires neither sessionStart, sessionEnd nor
      // preFinalAnswer — it is mid-turn by definition.
      const sessionHolder: { value: SmartState } = { value: input };
      const emitSessionEvent = (event: any) => {
        try { (config?.onEvent as ((e: any) => void) | undefined)?.(event); } catch { /* host callback */ }
      };
      const sessionRunId = `run_${nanoid(10)}`;
      const traceRecorder = createPluginTraceRecorder(
        () => (sessionHolder.value as any)?.ctx?.__traceSession,
      );
      const runHost = pluginHost?.hasAny()
        ? pluginHost.beginRun({
            runId: sessionRunId,
            agentName: opts.name,
            getState: () => sessionHolder.value,
            emit: emitSessionEvent,
            // Looked up lazily: the trace session is created inside the first
            // base leg, after the input guardrail has already had its say.
            recordTrace: traceRecorder.record,
            signal: (config?.cancellationToken as AbortSignal | undefined)?.aborted !== undefined
              ? (config?.cancellationToken as AbortSignal)
              : undefined,
            depth: Number((input as any).ctx?.__delegationDepth) || 0,
          })
        : undefined;

      const sessionStartedAt = Date.now();
      let sessionEnded = false;
      const endSession = async (
        status: "success" | "error" | "paused" | "cancelled",
        payload: { result?: AgentInvokeResult<TOutput>; error?: Error },
      ) => {
        if (!runHost || sessionEnded) return;
        sessionEnded = true;
        try {
          await runHost.runObservers("sessionEnd", {
            status,
            result: payload.result as any,
            error: payload.error,
            usage: sessionHolder.value?.usage,
            durationMs: Date.now() - sessionStartedAt,
          });
        } finally {
          traceRecorder.flush();
          runHost.end();
        }
      };

      let turnConfig = config;
      if (runHost) {
        turnConfig = {
          ...(config || {}),
          __pluginSession: {
            host: runHost,
            runId: sessionRunId,
            stateHolder: sessionHolder,
          },
        } as InvokeConfig;

        const resumed = Boolean(
          (input as any).ctx?.__restoredFromSnapshot
          || (input as any).ctx?.__paused
          || (input as any).ctx?.__resumeStage
          || (input as any).ctx?.__awaitingApproval
          || (input as any).ctx?.__awaitingUserQuestion
        );
        const opened = await openPluginSession(runHost, {
          messages: (input.messages || []) as any,
          resumed,
          config,
        });

        if (opened.denied) {
          const reason = opened.denied.reason;
          const blocked = {
            ...input,
            messages: [...(opened.messages as any[]), { role: "assistant", name: "guardrail", content: reason }],
          } as SmartState;
          sessionHolder.value = blocked;
          const deniedResult = {
            content: reason,
            output: undefined,
            outputError: undefined,
            metadata: { usage: (blocked as any).usage },
            messages: blocked.messages,
            state: blocked,
          } as AgentInvokeResult<TOutput>;
          emitSessionEvent({ type: "finalAnswer", content: reason });
          await endSession("success", { result: deniedResult });
          return deniedResult;
        }

        // Applied BEFORE seedMessages so the system prompt is prepended to the
        // hydrated transcript and the driver's `modelMessages.length` slice
        // boundary is computed from the same array the run actually starts with.
        input = { ...input, messages: opened.messages as any } as SmartState;
        sessionHolder.value = input;
        if (opened.systemPromptAppend) {
          input = {
            ...input,
            ctx: { ...((input as any).ctx || {}), __pluginSystemPromptAppend: opened.systemPromptAppend },
          } as SmartState;
        }
      }

      try {
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
      const seedMessages = alreadyHasSystem
        ? [...(input.messages || [])]
        : [
            systemMessage(disclosureBlock, (input as any).ctx?.__pluginSystemPromptAppend as string | undefined),
            ...(input.messages || []),
          ];

      // Deterministic pre-opening: skills the caller requires for this run are
      // opened here, after the user message and before the first model call, as
      // a real tool exchange rather than something the model has to discover.
      let seedToolHistory = input.toolHistory;
      if (skillsEnabled && toolSet.skillRegistryRef) {
        const preopenKeys = (config?.preopenedSkills ?? []) as string[];
        if (preopenKeys.length > 0) {
          const preopened = await preopenSkills({
            skillKeys: preopenKeys,
            tools: toolSet.toolsWithoutRecovery,
            alreadyOpenedKeys: toolSet.skillRegistryRef.openedSkillKeys,
            existingMessages: seedMessages,
            onEvent: config?.onEvent ?? (opts as any).onEvent,
          });
          if (preopened.messages.length > 0) {
            seedMessages.push(...preopened.messages);
            seedToolHistory = [...(seedToolHistory ?? []), ...preopened.toolHistory];
            stateRef.toolHistory = seedToolHistory;
          }
        }
      }

      // A handoff is scoped to ONE invoke. Both `state.agent` and the handoff
      // marker ride out on the returned state, so a caller doing the ordinary
      // multi-turn continuation would otherwise open the next turn already
      // holding the TARGET's runtime, while this loop binds its OWN tools onto
      // it — the target's model driven by the originating agent's menu, and a
      // transcript describing neither. Control starts each turn with this agent.
      const carriedCtx = (input as any).ctx as Record<string, any> | undefined;
      let freshCtx = carriedCtx;
      if (carriedCtx && carriedCtx.__handoffActive) {
        freshCtx = { ...carriedCtx };
        delete freshCtx.__handoffActive;
      }
      let state: SmartState = syncRuntimeTools(await syncMemory({ ...input, ctx: freshCtx, agent: base.__runtime, messages: seedMessages, toolHistory: seedToolHistory } as SmartState), seedMessages, toolSet);
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
        const res = await base.invoke({ ...state, messages: modelMessages } as SmartState, turnConfig);
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
        const res = await base.invoke(state, turnConfig);
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

      sessionHolder.value = (lastResult.state as SmartState) ?? sessionHolder.value;

      // ── Plugin gate: preFinalAnswer ─────────────────────────────────────
      // Fired here, on the leg that actually returns the answer, rather than
      // inside a base leg — the base agent is mid-turn on every iteration but
      // the last, and gating it there would skip the hook on exactly the runs
      // that compacted or paused.
      const finalCtx: any = (lastResult.state as any)?.ctx || {};
      const finalBlocked = Boolean(
        finalCtx.__awaitingApproval
        || finalCtx.__awaitingUserQuestion
        || finalCtx.__cancelled
        || finalCtx.__paused
        || finalCtx.__limitBreached
      );
      if (runHost && !finalBlocked && runHost.has("preFinalAnswer")) {
        const finalGate = await runHost.runGate("preFinalAnswer", {
          content: lastResult.content ?? "",
          output: lastResult.output,
        });
        const continueWith = (finalGate as unknown as { continueWith?: string }).continueWith;
        if (continueWith) {
          emitSessionEvent({
            type: "metadata",
            pluginWarning: "preFinalAnswer.continueWith is not implemented yet and was ignored.",
          });
        }
        if (finalGate.decision === "deny") {
          const reason = finalGate.reason || "Response blocked by policy.";
          // A denied answer must not leave a parsed structured output behind:
          // returning `output` while `content` says "blocked" would hand the
          // caller the very payload the policy refused.
          lastResult = { ...lastResult, content: reason, output: undefined, outputError: undefined };
        } else if (finalGate.input.content !== lastResult.content) {
          if (lastResult.output !== undefined) {
            emitSessionEvent({
              type: "metadata",
              pluginWarning:
                "preFinalAnswer rewrote `content` but `output` is produced by the structured-output schema and was left unchanged.",
            });
          }
          lastResult = { ...lastResult, content: finalGate.input.content as string };
        }
      }

      const endStatus: "success" | "paused" | "cancelled" = finalCtx.__cancelled
        ? "cancelled"
        : (finalCtx.__paused || finalCtx.__awaitingApproval || finalCtx.__awaitingUserQuestion)
          ? "paused"
          : "success";
      await endSession(endStatus, { result: lastResult as AgentInvokeResult<TOutput> });

      return lastResult as AgentInvokeResult<TOutput>;
      } catch (err) {
        // The driver itself can throw between base legs — a memory store, the
        // summarizer's model call, buildModelMessages. Without this the run
        // would end with sessionStart fired and sessionEnd never fired, and
        // checkpointing() (which only persists on sessionEnd) would save
        // nothing for precisely the failure it exists to capture.
        await endSession("error", { error: err instanceof Error ? err : new Error(String(err)) });
        throw err;
      }
    },
    // Re-exported one by one, so anything new on AgentInstance has to be added
    // here too or it is silently missing for smart agents.
    dispose: base.dispose,
    __plugins: (base as any).__plugins,
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
