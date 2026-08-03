// Resolves the unified ReasoningConfig into concrete shapes consumed by the loop:
//  - native reasoning request config for the model adapter (per provider)
//  - reflection config (cadence / token budget / injection rules)
//
// Resolution is a pure function — defaults are applied based on `level` when
// sub-fields are omitted. Any explicit sub-field wins.

import type {
  ReasoningConfig,
  ReasoningLevel,
  ReflectionConfig,
  ReflectionCadence,
  ReflectionHookContext,
  ReflectionRecord,
  NativeReasoningConfig,
} from "../types.js";

export type ResolvedReflectionConfig = {
  enabled: boolean;
  cadence: ReflectionCadence;
  mode: "piggyback" | "separate";
  maxTokens: number;
  maxChars: number;
  keepLast: number;
  summarize: boolean;
  promptTemplate?: string;
  emitEvents: boolean;
  maxPerRun?: number;
  everyNTurns: number;
  feedTo: "memory" | "plan" | "none";
  shouldReflect?: (ctx: ReflectionHookContext) => boolean;
  buildPrompt?: (ctx: ReflectionHookContext & { defaultPrompt: string; maxChars: number }) => string;
  onReflection?: (record: ReflectionRecord, ctx: ReflectionHookContext) => void;
};

export type ResolvedReasoning = {
  enabled: boolean;
  level: ReasoningLevel;
  native?: NativeReasoningConfig;
  reflection: ResolvedReflectionConfig;
};

const LEVEL_DEFAULTS: Record<ReasoningLevel, {
  native: NativeReasoningConfig;
  reflection: Pick<ResolvedReflectionConfig, "maxTokens" | "maxChars" | "cadence">;
}> = {
  minimal: {
    native: { effort: "minimal" },
    reflection: { maxTokens: 150, maxChars: 400, cadence: "off" },
  },
  low: {
    native: { effort: "low" },
    reflection: { maxTokens: 200, maxChars: 600, cadence: "on_branch" },
  },
  medium: {
    native: { effort: "medium" },
    reflection: { maxTokens: 350, maxChars: 1200, cadence: "initial_then_after_tool" },
  },
  high: {
    native: { effort: "high" },
    reflection: { maxTokens: 600, maxChars: 2000, cadence: "initial_then_after_tool" },
  },
};

const VALID_LEVELS: ReasoningLevel[] = ["minimal", "low", "medium", "high"];
const VALID_CADENCES: ReflectionCadence[] = ["off", "every_turn", "after_tool", "on_branch", "initial_then_after_tool"];
// `none` is here but NOT in VALID_LEVELS: a level is a preset that also drives
// reflection cadence and token caps, and there is no coherent "none" preset —
// `reasoning.enabled: false` is how you turn the whole thing off. `none` is only
// meaningful on the native side, where it is the instruction "do not think"
// travelling to a model that otherwise would.
const VALID_EFFORTS = ["none", "minimal", "low", "medium", "high"];

/**
 * Validates a user-supplied ReasoningConfig and throws a descriptive error for
 * obviously-wrong values. Pure; safe to call before resolveReasoning.
 */
export function validateReasoningConfig(input: ReasoningConfig | undefined): void {
  if (!input) return;
  if (input.level !== undefined && !VALID_LEVELS.includes(input.level)) {
    throw new Error(`reasoning.level must be one of ${VALID_LEVELS.join(", ")} (got "${input.level}")`);
  }
  if (input.native) {
    const n = input.native;
    if (n.effort !== undefined && !VALID_EFFORTS.includes(n.effort)) {
      throw new Error(`reasoning.native.effort must be one of ${VALID_EFFORTS.join(", ")} (got "${n.effort}")`);
    }
    if (n.budgetTokens !== undefined && (!Number.isFinite(n.budgetTokens) || n.budgetTokens < 0)) {
      throw new Error(`reasoning.native.budgetTokens must be a non-negative number (got ${n.budgetTokens})`);
    }
  }
  if (input.reflection) {
    const r = input.reflection;
    if (r.cadence !== undefined && !VALID_CADENCES.includes(r.cadence)) {
      throw new Error(`reasoning.reflection.cadence must be one of ${VALID_CADENCES.join(", ")} (got "${r.cadence}")`);
    }
    if (r.maxPerRun !== undefined && (!Number.isFinite(r.maxPerRun) || r.maxPerRun < 0)) {
      throw new Error(`reasoning.reflection.maxPerRun must be a non-negative number (got ${r.maxPerRun})`);
    }
    if (r.everyNTurns !== undefined && (!Number.isFinite(r.everyNTurns) || r.everyNTurns < 1)) {
      throw new Error(`reasoning.reflection.everyNTurns must be >= 1 (got ${r.everyNTurns})`);
    }
    if (r.feedTo !== undefined && !["memory", "plan", "none"].includes(r.feedTo)) {
      throw new Error(`reasoning.reflection.feedTo must be "memory", "plan", or "none" (got "${r.feedTo}")`);
    }
  }
}

export function resolveReasoning(input: ReasoningConfig | undefined): ResolvedReasoning | undefined {
  if (!input || input.enabled === false) return undefined;
  validateReasoningConfig(input);
  const enabled = input.enabled ?? (input.native !== undefined || input.reflection !== undefined || input.level !== undefined);
  if (!enabled) return undefined;

  const level: ReasoningLevel = input.level ?? "medium";
  const presets = LEVEL_DEFAULTS[level];

  // --- native ---
  let native: NativeReasoningConfig | undefined;
  if (input.native === false) {
    native = undefined;
  } else {
    native = { ...presets.native, ...(input.native ?? {}) };
  }

  // --- reflection ---
  const reflection = resolveReflection(input.reflection, presets.reflection);

  return { enabled: true, level, native, reflection };
}

function resolveReflection(
  input: ReflectionConfig | false | undefined,
  preset: { maxTokens: number; maxChars: number; cadence: ReflectionCadence },
): ResolvedReflectionConfig {
  if (input === false) {
    return {
      enabled: false,
      cadence: "off",
      mode: "piggyback",
      maxTokens: preset.maxTokens,
      maxChars: preset.maxChars,
      keepLast: 3,
      summarize: false,
      emitEvents: true,
      everyNTurns: 1,
      feedTo: "none",
    };
  }
  const cfg = input ?? {};
  const enabled = cfg.enabled ?? true;
  const cadence: ReflectionCadence = cfg.cadence ?? preset.cadence;
  return {
    enabled: enabled && cadence !== "off",
    cadence: enabled ? cadence : "off",
    mode: cfg.mode ?? "piggyback",
    maxTokens: cfg.maxTokens ?? preset.maxTokens,
    maxChars: cfg.maxChars ?? preset.maxChars,
    keepLast: cfg.keepLast ?? 3,
    summarize: cfg.summarize ?? false,
    promptTemplate: cfg.promptTemplate,
    emitEvents: cfg.emitEvents ?? true,
    maxPerRun: typeof cfg.maxPerRun === "number" && cfg.maxPerRun >= 0 ? cfg.maxPerRun : undefined,
    everyNTurns: Math.max(1, Math.trunc(cfg.everyNTurns ?? 1)),
    feedTo: cfg.feedTo ?? "none",
    shouldReflect: cfg.shouldReflect,
    buildPrompt: cfg.buildPrompt,
    onReflection: cfg.onReflection,
  };
}
