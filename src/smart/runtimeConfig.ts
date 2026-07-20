import type {
  AgentLimits,
  BuiltInRuntimeProfile,
  MemoryStore,
  ProfileConfig,
  ResolvedSmartAgentConfig,
  RuntimeProfile,
  SmartAgentOptions,
} from "../types.js";
import type { ContextPilotConfig } from "./contextPilot/types.js";

const DEFAULT_CRITICAL_TOOLS = ["response", "manage_todo_list", "get_tool_response"];

// Shared defaults across all profiles — only overridden values need to be specified per profile.
// These mirror the "balanced" profile and are scaled for modern frontier models
// (Claude 4.x, GPT-4o, Gemini 2.x) where 100k+ context windows are standard.
const BASE_DEFAULTS: ProfileConfig = {
  limits: { maxToolCalls: 20, maxParallelTools: 5, maxContextTokens: 96000, maxTotalOutputTokens: 0, maxCostUsd: 0, maxWallClockMs: 0 },
  summarization: {
    enable: true,
    maxTokens: 96000,
    summaryTriggerTokens: 72000,
    summaryPromptMaxTokens: 12000,
    summaryCompressionRatioTarget: 0.45,
    summaryMode: "incremental",
    promptTemplate: "",
    toolFreeCall: true,
    integrityCheck: true,
  },
  context: {
    policy: "hybrid",
    lastTurnsToKeep: 16,
    toolResponsePolicy: "summarize_archive",
    budget: {
      systemReserveTokens: 2000,
      goalsReserveTokens: 2000,
      recentTurnsReserveTokens: 18000,
      toolResponseReserveTokens: 9000,
    },
  },
  planning: {
    mode: "off",
    replanPolicy: "on_failure",
    everyNSteps: 0,
  },
  memory: {
    provider: "inMemory",
    scope: "session",
    writePolicy: "auto_important",
    readPolicy: "hybrid",
  },
  delegation: {
    mode: "role_based",
    maxDelegationDepth: 2,
    maxChildCalls: 6,
    maxParallelChild: 3,
    childContextPolicy: "scoped",
    requireJsonOutputContract: true,
  },
  toolResponses: {
    maxToolResponseChars: 32_000,
    maxToolResponseTokens: 8_000,
    defaultPolicy: "summarize_archive",
    toolResponseRetentionByTool: {},
    criticalTools: [...DEFAULT_CRITICAL_TOOLS],
    schemaValidation: "strict",
  },
  contextPilot: {
    enabled: true,
    compression: {
      json: { enabled: true, targetRatio: 0.35, minItems: 20 },
      text: { enabled: true, targetRatio: 0.5, minChars: 1200 },
      diff: { enabled: true, contextLines: 3 },
      log: { enabled: true, maxLines: 60 },
      search: { enabled: true, maxMatches: 30 },
    },
    ccr: { enabled: true, ttlMs: 30 * 60 * 1000, maxEntries: 500 },
    cacheAlignment: { enabled: true, warnOnVolatilePrompt: true },
    dedup: { enabled: true, minChars: 500 },
    excludeTools: [],
  },
};

function mergeContextPilot(base: ProfileConfig["contextPilot"], override?: ContextPilotConfig): ProfileConfig["contextPilot"] {
  return {
    enabled: override?.enabled ?? base.enabled,
    compression: {
      json: { ...base.compression.json, ...override?.compression?.json },
      text: { ...base.compression.text, ...override?.compression?.text },
      diff: { ...base.compression.diff, ...override?.compression?.diff },
      log: { ...base.compression.log, ...override?.compression?.log },
      search: { ...base.compression.search, ...override?.compression?.search },
    },
    ccr: { ...base.ccr, ...override?.ccr },
    cacheAlignment: { ...base.cacheAlignment, ...override?.cacheAlignment },
    dedup: { ...base.dedup, ...override?.dedup },
    excludeTools: override?.excludeTools ?? base.excludeTools,
  };
}

function buildProfile(overrides: Partial<{
  limits: Partial<ProfileConfig["limits"]>;
  summarization: Partial<ProfileConfig["summarization"]>;
  context: Partial<ProfileConfig["context"]> & { budget?: Partial<ProfileConfig["context"]["budget"]> };
  planning: Partial<ProfileConfig["planning"]>;
  memory: Partial<ProfileConfig["memory"]>;
  delegation: Partial<ProfileConfig["delegation"]>;
  toolResponses: Partial<ProfileConfig["toolResponses"]>;
  contextPilot: ContextPilotConfig;
}>): ProfileConfig {
  return {
    limits: { ...BASE_DEFAULTS.limits, ...overrides.limits },
    summarization: { ...BASE_DEFAULTS.summarization, ...overrides.summarization },
    context: {
      ...BASE_DEFAULTS.context,
      ...overrides.context,
      budget: { ...BASE_DEFAULTS.context.budget, ...overrides.context?.budget },
    },
    planning: { ...BASE_DEFAULTS.planning, ...overrides.planning },
    memory: { ...BASE_DEFAULTS.memory, ...overrides.memory },
    delegation: { ...BASE_DEFAULTS.delegation, ...overrides.delegation },
    toolResponses: {
      ...BASE_DEFAULTS.toolResponses,
      ...overrides.toolResponses,
      criticalTools: overrides.toolResponses?.criticalTools ?? [...DEFAULT_CRITICAL_TOOLS],
      toolResponseRetentionByTool: overrides.toolResponses?.toolResponseRetentionByTool ?? {},
    },
    contextPilot: mergeContextPilot(BASE_DEFAULTS.contextPilot, overrides.contextPilot),
  };
}

export const DEFAULT_PROFILE_CONFIGS: Record<BuiltInRuntimeProfile, ProfileConfig> = {
  fast: buildProfile({
    limits: { maxToolCalls: 8, maxParallelTools: 3, maxContextTokens: 32000 },
    summarization: {
      maxTokens: 32000,
      summaryTriggerTokens: 24000,
      summaryPromptMaxTokens: 6000,
      summaryCompressionRatioTarget: 0.5,
    },
    context: {
      lastTurnsToKeep: 8,
      toolResponsePolicy: "keep_structured",
      budget: { systemReserveTokens: 1500, goalsReserveTokens: 1200, recentTurnsReserveTokens: 6000, toolResponseReserveTokens: 3500 },
    },
    memory: { readPolicy: "recent_only" },
    delegation: { mode: "off", maxDelegationDepth: 1, maxChildCalls: 2, maxParallelChild: 1, childContextPolicy: "minimal" },
    toolResponses: { maxToolResponseChars: 16_000, maxToolResponseTokens: 4_000 },
    contextPilot: {
      compression: {
        json: { targetRatio: 0.25, minItems: 12 },
        text: { targetRatio: 0.35, minChars: 800 },
      },
    },
  }),

  balanced: buildProfile({}),

  deep: buildProfile({
    limits: { maxToolCalls: 40, maxParallelTools: 8, maxContextTokens: 200000 },
    summarization: {
      maxTokens: 200000,
      summaryTriggerTokens: 150000,
      summaryPromptMaxTokens: 16000,
      summaryCompressionRatioTarget: 0.4,
    },
    context: {
      lastTurnsToKeep: 30,
      budget: { systemReserveTokens: 2500, goalsReserveTokens: 2500, recentTurnsReserveTokens: 36000, toolResponseReserveTokens: 18000 },
    },
    memory: { scope: "workspace" },
    delegation: { maxDelegationDepth: 3, maxChildCalls: 10, maxParallelChild: 4 },
    toolResponses: { maxToolResponseChars: 64_000, maxToolResponseTokens: 16_000 },
    contextPilot: {
      compression: {
        json: { targetRatio: 0.5, minItems: 30 },
        text: { targetRatio: 0.6, minChars: 1600 },
      },
      ccr: { ttlMs: 60 * 60 * 1000 },
    },
  }),

  research: buildProfile({
    limits: { maxToolCalls: 80, maxParallelTools: 10, maxContextTokens: 400000 },
    summarization: {
      maxTokens: 400000,
      summaryTriggerTokens: 300000,
      summaryPromptMaxTokens: 24000,
      summaryCompressionRatioTarget: 0.35,
    },
    context: {
      lastTurnsToKeep: 60,
      budget: { systemReserveTokens: 3000, goalsReserveTokens: 3000, recentTurnsReserveTokens: 72000, toolResponseReserveTokens: 32000 },
    },
    memory: { scope: "workspace" },
    delegation: { mode: "automatic", maxDelegationDepth: 4, maxChildCalls: 16, maxParallelChild: 6, childContextPolicy: "full" },
    toolResponses: { maxToolResponseChars: 96_000, maxToolResponseTokens: 24_000 },
    contextPilot: {
      compression: {
        json: { targetRatio: 0.6, minItems: 40 },
        text: { targetRatio: 0.65, minChars: 2000 },
      },
      ccr: { ttlMs: 2 * 60 * 60 * 1000, maxEntries: 1000 },
    },
  }),
};

function mergeLimits(base: Required<AgentLimits>, override?: AgentLimits): Required<AgentLimits> {
  return {
    maxToolCalls: override?.maxToolCalls ?? base.maxToolCalls,
    maxParallelTools: override?.maxParallelTools ?? base.maxParallelTools,
    maxContextTokens: override?.maxContextTokens ?? base.maxContextTokens,
    maxTotalOutputTokens: override?.maxTotalOutputTokens ?? base.maxTotalOutputTokens ?? 0,
    maxCostUsd: override?.maxCostUsd ?? base.maxCostUsd ?? 0,
    maxWallClockMs: override?.maxWallClockMs ?? base.maxWallClockMs ?? 0,
  };
}

function resolveBaseProfile(opts: SmartAgentOptions, runtimeProfile: RuntimeProfile): BuiltInRuntimeProfile {
  if (opts.customProfile?.extends) return opts.customProfile.extends;
  if (runtimeProfile !== "custom") return runtimeProfile;
  return "balanced";
}

export function normalizeSmartAgentOptions(opts: SmartAgentOptions): ResolvedSmartAgentConfig {
  const runtimeProfile = opts.runtimeProfile ?? (opts.customProfile ? "custom" : "balanced");
  const baseProfile = resolveBaseProfile(opts, runtimeProfile);
  const preset = DEFAULT_PROFILE_CONFIGS[baseProfile];
  const customProfile = opts.customProfile || {};
  const useTodoList = opts.useTodoList === true;
  const summarizationDisabled = opts.summarization === false;
  const summarizationOverride = typeof opts.summarization === "object" ? opts.summarization : {};
  const planningMode = opts.planning?.mode ?? customProfile.planning?.mode ?? (useTodoList ? "todo" : preset.planning.mode);
  const memoryStore = (opts.memory?.store ?? customProfile.memory?.store) as MemoryStore | undefined;
  const contextToolResponsePolicy = opts.context?.toolResponsePolicy
    ?? customProfile.context?.toolResponsePolicy
    ?? preset.context.toolResponsePolicy;

  return {
    runtimeProfile,
    baseProfile,
    limits: mergeLimits(mergeLimits(preset.limits, customProfile.limits), opts.limits),
    summarization: {
      ...preset.summarization,
      ...(customProfile.summarization || {}),
      ...summarizationOverride,
      enable: summarizationDisabled ? false : (summarizationOverride.enable ?? customProfile.summarization?.enable ?? preset.summarization.enable),
      maxTokens: summarizationOverride.maxTokens ?? opts.limits?.maxContextTokens ?? customProfile.summarization?.maxTokens ?? preset.summarization.maxTokens,
      summaryTriggerTokens:
        summarizationOverride.summaryTriggerTokens
        ?? summarizationOverride.maxTokens
        ?? opts.limits?.maxContextTokens
        ?? customProfile.summarization?.summaryTriggerTokens
        ?? customProfile.summarization?.maxTokens
        ?? preset.summarization.summaryTriggerTokens,
      promptTemplate: summarizationOverride.promptTemplate ?? customProfile.summarization?.promptTemplate ?? preset.summarization.promptTemplate,
    },
    context: {
      ...preset.context,
      ...(customProfile.context || {}),
      ...(opts.context || {}),
      budget: {
        ...preset.context.budget,
        ...((customProfile.context?.budget || {})),
        ...((opts.context?.budget || {})),
      },
      toolResponsePolicy: contextToolResponsePolicy,
    },
    planning: {
      ...preset.planning,
      ...(customProfile.planning || {}),
      ...(opts.planning || {}),
      mode: planningMode,
    },
    memory: {
      ...preset.memory,
      ...(customProfile.memory || {}),
      ...(opts.memory || {}),
      store: memoryStore,
    },
    delegation: {
      ...preset.delegation,
      ...(customProfile.delegation || {}),
      ...(opts.delegation || {}),
    },
    toolResponses: {
      ...preset.toolResponses,
      ...(customProfile.toolResponses || {}),
      ...(opts.toolResponses || {}),
      defaultPolicy: opts.toolResponses?.defaultPolicy
        ?? customProfile.toolResponses?.defaultPolicy
        ?? contextToolResponsePolicy,
      toolResponseRetentionByTool: {
        ...preset.toolResponses.toolResponseRetentionByTool,
        ...((customProfile.toolResponses?.toolResponseRetentionByTool || {})),
        ...((opts.toolResponses?.toolResponseRetentionByTool || {})),
      },
      criticalTools: opts.toolResponses?.criticalTools ?? customProfile.toolResponses?.criticalTools ?? preset.toolResponses.criticalTools,
    },
    contextPilot: mergeContextPilot(mergeContextPilot(preset.contextPilot, customProfile.contextPilot), opts.contextPilot),
  };
}

export function getResolvedSmartConfig(opts: SmartAgentOptions, runtime?: { smart?: ResolvedSmartAgentConfig | undefined }): ResolvedSmartAgentConfig {
  return runtime?.smart || normalizeSmartAgentOptions(opts);
}