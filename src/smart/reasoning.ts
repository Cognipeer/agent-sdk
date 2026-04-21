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
  low: {
    native: { effort: "low" },
    reflection: { maxTokens: 200, maxChars: 600, cadence: "on_branch" },
  },
  medium: {
    native: { effort: "medium" },
    reflection: { maxTokens: 350, maxChars: 1200, cadence: "after_tool" },
  },
  high: {
    native: { effort: "high" },
    reflection: { maxTokens: 600, maxChars: 2000, cadence: "after_tool" },
  },
};

export function resolveReasoning(input: ReasoningConfig | undefined): ResolvedReasoning | undefined {
  if (!input || input.enabled === false) return undefined;
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
  };
}
