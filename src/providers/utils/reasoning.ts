// Provider-agnostic mapper for ReasoningRequestConfig.
// Each native provider calls one of these helpers inside its buildRequestBody.
// The helpers are defensive — unknown fields are ignored silently so callers
// can pass a unified config regardless of the current provider.

import type { ReasoningRequestConfig, ReasoningEffort } from "../types.js";

export type OpenAIReasoningMode = "legacy_effort" | "responses";

// ─── Effort → token-budget tables ──────────────────────────────────────────
// Centralised so every provider derives budgets from the same numbers. Values
// are deliberately conservative; Anthropic/Bedrock additionally clamp the
// budget below `max_tokens` (a provider hard requirement).
export const ANTHROPIC_EFFORT_BUDGET: Record<ReasoningEffort, number> = {
  minimal: 1024,
  low: 2048,
  medium: 8192,
  high: 16384,
};

export const GEMINI_EFFORT_BUDGET: Record<ReasoningEffort, number> = {
  minimal: 512,
  low: 1024,
  medium: 4096,
  high: 12000,
};

/** Minimum gap between the thinking budget and `max_tokens` for Anthropic/Bedrock. */
const THINKING_OUTPUT_RESERVE = 1024;
/** Floor for `max_tokens` once thinking is enabled (budget + reserve at least this). */
const THINKING_MIN_MAX_TOKENS = 4096;

/** Maps a unified reasoning config onto the OpenAI Chat Completions body.
 *
 * For o-series (o1, o3, o4, gpt-5) the accepted field is `reasoning_effort`.
 * We keep the mapping best-effort; models that don't support it will respond
 * with a 400 — in that case callers should not pass `reasoning` at all.
 */
export function applyOpenAIReasoning(
  body: Record<string, any>,
  reasoning: ReasoningRequestConfig | undefined,
  mode: OpenAIReasoningMode = "legacy_effort",
): void {
  if (!reasoning) return;
  const effort = normalizeEffort(reasoning.effort);
  if (mode === "responses") {
    const obj: Record<string, any> = {};
    if (effort) obj.effort = effort;
    if (reasoning.includeThoughts) obj.summary = "auto";
    if (reasoning.providerExtras) Object.assign(obj, reasoning.providerExtras);
    if (Object.keys(obj).length > 0) body.reasoning = obj;
  } else {
    if (effort) body.reasoning_effort = effort;
    if (reasoning.providerExtras) Object.assign(body, reasoning.providerExtras);
  }
}

/** Maps onto Anthropic Messages API body.
 *
 * Requires claude-sonnet-3.7+, claude-opus-4, claude-sonnet-4 etc. Anthropic
 * requires an explicit budget_tokens value (we derive it from effort when the
 * caller didn't specify one) AND that `budget_tokens < max_tokens`. When
 * thinking is enabled Anthropic also rejects non-default `temperature`/`top_p`/
 * `top_k`, so we strip them here so callers can pass a unified config safely.
 */
export function applyAnthropicReasoning(
  body: Record<string, any>,
  reasoning: ReasoningRequestConfig | undefined,
): void {
  if (!reasoning) return;
  let budget = resolveBudget(reasoning, ANTHROPIC_EFFORT_BUDGET);
  if (!budget) return;

  // Ensure max_tokens leaves room for the visible answer on top of thinking.
  const currentMax = typeof body.max_tokens === "number" ? body.max_tokens : 0;
  const requiredMax = Math.max(THINKING_MIN_MAX_TOKENS, budget + THINKING_OUTPUT_RESERVE);
  if (currentMax < requiredMax) {
    body.max_tokens = requiredMax;
  }
  // Clamp the budget strictly below max_tokens (Anthropic hard requirement).
  budget = clampBudget(budget, body.max_tokens);

  const thinking: Record<string, any> = { type: "enabled", budget_tokens: budget };
  if (reasoning.providerExtras) Object.assign(thinking, reasoning.providerExtras);
  body.thinking = thinking;

  // Thinking mode forbids sampling overrides.
  stripSamplingParams(body, ["temperature", "top_p", "top_k"]);
}

/** Maps onto AWS Bedrock Converse for thinking-capable Anthropic models via
 * `additionalModelRequestFields.thinking`. Same budget/temperature rules as the
 * direct Anthropic API apply. The Converse body is mutated in place.
 */
export function applyBedrockReasoning(
  body: Record<string, any>,
  reasoning: ReasoningRequestConfig | undefined,
): void {
  if (!reasoning) return;
  let budget = resolveBudget(reasoning, ANTHROPIC_EFFORT_BUDGET);
  if (!budget) return;

  const inference = (body.inferenceConfig ??= {});
  const currentMax = typeof inference.maxTokens === "number" ? inference.maxTokens : 0;
  const requiredMax = Math.max(THINKING_MIN_MAX_TOKENS, budget + THINKING_OUTPUT_RESERVE);
  if (currentMax < requiredMax) {
    inference.maxTokens = requiredMax;
  }
  budget = clampBudget(budget, inference.maxTokens);

  const extra = (body.additionalModelRequestFields ??= {});
  const thinking: Record<string, any> = { type: "enabled", budget_tokens: budget };
  if (reasoning.providerExtras) Object.assign(thinking, reasoning.providerExtras);
  extra.thinking = thinking;

  // Thinking mode forbids sampling overrides on the inferenceConfig.
  stripSamplingParams(inference, ["temperature", "topP"]);
}

/** Maps onto Google Vertex / Gemini generationConfig. */
export function applyGeminiReasoning(
  generationConfig: Record<string, any>,
  reasoning: ReasoningRequestConfig | undefined,
): void {
  if (!reasoning) return;
  const budget = resolveBudget(reasoning, GEMINI_EFFORT_BUDGET);
  if (budget == null) return;
  const thinkingConfig: Record<string, any> = { thinkingBudget: budget };
  if (reasoning.includeThoughts) thinkingConfig.includeThoughts = true;
  if (reasoning.providerExtras) Object.assign(thinkingConfig, reasoning.providerExtras);
  generationConfig.thinkingConfig = thinkingConfig;
}

function stripSamplingParams(target: Record<string, any>, keys: string[]): void {
  for (const k of keys) {
    if (k in target) delete target[k];
  }
}

function clampBudget(budget: number, maxTokens: number | undefined): number {
  if (typeof maxTokens !== "number" || maxTokens <= 0) return budget;
  const ceiling = maxTokens - THINKING_OUTPUT_RESERVE;
  if (ceiling < 1024) return Math.max(1024, Math.floor(maxTokens / 2));
  return Math.min(budget, ceiling);
}

function normalizeEffort(effort: ReasoningEffort | undefined): ReasoningEffort | undefined {
  if (!effort) return undefined;
  const allowed: ReasoningEffort[] = ["minimal", "low", "medium", "high"];
  return allowed.includes(effort) ? effort : undefined;
}

function resolveBudget(
  reasoning: ReasoningRequestConfig,
  effortBudget: Record<ReasoningEffort, number>,
): number | undefined {
  if (typeof reasoning.budgetTokens === "number" && reasoning.budgetTokens > 0) {
    return Math.floor(reasoning.budgetTokens);
  }
  const effort = normalizeEffort(reasoning.effort);
  if (effort && effortBudget[effort]) return effortBudget[effort];
  return undefined;
}
