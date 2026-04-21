import type {
  AgentLimits,
  BuiltInRuntimeProfile,
  MemoryStore,
  ProfileConfig,
  ResolvedSmartAgentConfig,
  RuntimeProfile,
  SmartAgentOptions,
} from "../types.js";

const DEFAULT_CRITICAL_TOOLS = ["response", "manage_todo_list", "get_tool_response"];

// Shared defaults across all profiles — only overridden values need to be specified per profile.
const BASE_DEFAULTS: ProfileConfig = {
  limits: { maxToolCalls: 8, maxParallelTools: 2, maxContextTokens: 24000 },
  summarization: {
    enable: true,
    maxTokens: 24000,
    summaryTriggerTokens: 17000,
    summaryPromptMaxTokens: 7000,
    summaryCompressionRatioTarget: 0.35,
    summaryMode: "incremental",
    promptTemplate: "",
    toolFreeCall: true,
    integrityCheck: true,
  },
  context: {
    policy: "hybrid",
    lastTurnsToKeep: 8,
    toolResponsePolicy: "summarize_archive",
    archiveLargeToolResponses: true,
    retrieveArchivedToolResponseOnDemand: true,
    budget: {
      systemReserveTokens: 1200,
      goalsReserveTokens: 1200,
      recentTurnsReserveTokens: 5200,
      toolResponseReserveTokens: 2800,
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
    maxChildCalls: 4,
    maxParallelChild: 2,
    childContextPolicy: "scoped",
    requireJsonOutputContract: true,
  },
  toolResponses: {
    maxToolResponseChars: 12_000,
    maxToolResponseTokens: 3_000,
    defaultPolicy: "summarize_archive",
    toolResponseRetentionByTool: {},
    criticalTools: [...DEFAULT_CRITICAL_TOOLS],
    schemaValidation: "strict",
    retryOnSchemaError: true,
  },
};

function buildProfile(overrides: Partial<{
  limits: Partial<ProfileConfig["limits"]>;
  summarization: Partial<ProfileConfig["summarization"]>;
  context: Partial<ProfileConfig["context"]> & { budget?: Partial<ProfileConfig["context"]["budget"]> };
  planning: Partial<ProfileConfig["planning"]>;
  memory: Partial<ProfileConfig["memory"]>;
  delegation: Partial<ProfileConfig["delegation"]>;
  toolResponses: Partial<ProfileConfig["toolResponses"]>;
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
  };
}

export const DEFAULT_PROFILE_CONFIGS: Record<BuiltInRuntimeProfile, ProfileConfig> = {
  fast: buildProfile({
    limits: { maxToolCalls: 4, maxParallelTools: 1, maxContextTokens: 12000 },
    summarization: {
      maxTokens: 12000,
      summaryTriggerTokens: 9000,
      summaryPromptMaxTokens: 5000,
      summaryCompressionRatioTarget: 0.4,
    },
    context: {
      lastTurnsToKeep: 6,
      toolResponsePolicy: "keep_structured",
      budget: { systemReserveTokens: 1000, goalsReserveTokens: 900, recentTurnsReserveTokens: 3200, toolResponseReserveTokens: 1800 },
    },
    memory: { readPolicy: "recent_only" },
    delegation: { mode: "off", maxDelegationDepth: 1, maxChildCalls: 2, maxParallelChild: 1, childContextPolicy: "minimal" },
    toolResponses: { maxToolResponseChars: 8_000, maxToolResponseTokens: 2_000 },
  }),

  balanced: buildProfile({}),

  deep: buildProfile({
    limits: { maxToolCalls: 14, maxParallelTools: 3, maxContextTokens: 42000 },
    summarization: {
      maxTokens: 42000,
      summaryTriggerTokens: 30000,
      summaryPromptMaxTokens: 9000,
      summaryCompressionRatioTarget: 0.3,
    },
    context: {
      lastTurnsToKeep: 12,
      budget: { systemReserveTokens: 1400, goalsReserveTokens: 1600, recentTurnsReserveTokens: 7000, toolResponseReserveTokens: 3600 },
    },
    memory: { scope: "workspace" },
    delegation: { maxDelegationDepth: 3, maxChildCalls: 6 },
    toolResponses: { maxToolResponseChars: 16_000, maxToolResponseTokens: 4_000 },
  }),

  research: buildProfile({
    limits: { maxToolCalls: 20, maxParallelTools: 4, maxContextTokens: 56000 },
    summarization: {
      maxTokens: 56000,
      summaryTriggerTokens: 42000,
      summaryPromptMaxTokens: 10000,
      summaryCompressionRatioTarget: 0.28,
    },
    context: {
      lastTurnsToKeep: 20,
      budget: { systemReserveTokens: 1600, goalsReserveTokens: 1800, recentTurnsReserveTokens: 9000, toolResponseReserveTokens: 4800 },
    },
    memory: { scope: "workspace" },
    delegation: { mode: "automatic", maxDelegationDepth: 4, maxChildCalls: 8, maxParallelChild: 3, childContextPolicy: "full" },
    toolResponses: { maxToolResponseChars: 24_000, maxToolResponseTokens: 6_000 },
  }),
};

function mergeLimits(base: Required<AgentLimits>, override?: AgentLimits): Required<AgentLimits> {
  return {
    maxToolCalls: override?.maxToolCalls ?? base.maxToolCalls,
    maxParallelTools: override?.maxParallelTools ?? base.maxParallelTools,
    maxContextTokens: override?.maxContextTokens ?? base.maxContextTokens,
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
      toolResponsePolicy: opts.context?.toolResponsePolicy ?? customProfile.context?.toolResponsePolicy ?? preset.context.toolResponsePolicy,
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
      toolResponseRetentionByTool: {
        ...preset.toolResponses.toolResponseRetentionByTool,
        ...((customProfile.toolResponses?.toolResponseRetentionByTool || {})),
        ...((opts.toolResponses?.toolResponseRetentionByTool || {})),
      },
      criticalTools: opts.toolResponses?.criticalTools ?? customProfile.toolResponses?.criticalTools ?? preset.toolResponses.criticalTools,
    },
  };
}

export function getResolvedSmartConfig(opts: SmartAgentOptions, runtime?: { smart?: ResolvedSmartAgentConfig | undefined }): ResolvedSmartAgentConfig {
  return runtime?.smart || normalizeSmartAgentOptions(opts);
}