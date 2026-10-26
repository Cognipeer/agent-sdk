// Provider-agnostic mapper for ReasoningRequestConfig.
// Each native provider calls one of these helpers inside its buildRequestBody.
// The helpers are defensive — unknown fields are ignored silently so callers
// can pass a unified config regardless of the current provider.

import type { ReasoningRequestConfig, ReasoningEffort } from "../types.js";
import {
  MODEL_RULES,
  resolveModelRule,
  mapReasoningEffort,
  allowsSampling,
  type ModelRule,
} from "../../models/rules.js";

export type OpenAIReasoningMode = "legacy_effort" | "responses";

// ─── Effort → token-budget tables ──────────────────────────────────────────
// Centralised in model-rules.json so every provider (and the console) derives
// budgets from the same numbers. Values are deliberately conservative;
// Anthropic/Bedrock additionally clamp the budget below `max_tokens` (a
// provider hard requirement).
export const ANTHROPIC_EFFORT_BUDGET: Record<ReasoningEffort, number> = {
  // 0 = off. `applyAnthropicReasoning` bails on a falsy budget and emits no
  // thinking block, which on Anthropic IS off — thinking there is opt-in.
  none: 0,
  ...MODEL_RULES.budgets,
};

// Adaptive thinking has no budget: `max_tokens` is one hard cap over thinking
// plus the visible answer, so a small value is spent on thinking alone.
export const ANTHROPIC_ADAPTIVE_MAX_TOKENS: Record<Exclude<ReasoningEffort, "none">, number> = {
  ...MODEL_RULES.adaptiveMaxTokens,
};

export const GEMINI_EFFORT_BUDGET: Record<ReasoningEffort, number> = {
  // 0 is Gemini's own documented spelling for "do not think", and unlike
  // Anthropic it has to be SENT — hence `applyGeminiReasoning` testing for null
  // rather than falsiness.
  none: 0,
  ...MODEL_RULES.geminiBudgets,
};

/** Minimum gap between the thinking budget and `max_tokens` for Anthropic/Bedrock. */
const THINKING_OUTPUT_RESERVE = 1024;
/** Anthropic rejects `budget_tokens` below this (a 400 invalid_request_error). */
const MIN_THINKING_BUDGET = 1024;
/** Floor for `max_tokens` once thinking is enabled (budget + reserve at least this). */
const THINKING_MIN_MAX_TOKENS = 4096;
/** Gemini counts thinking tokens against `maxOutputTokens`; keep this much for the answer. */
const GEMINI_OUTPUT_RESERVE = 2048;

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
  model?: string,
  rule?: ModelRule,
): void {
  if (!reasoning) return;
  const requested = normalizeEffort(reasoning.effort);
  const r = rule ?? resolveModelRule({ provider: "openai", model: model ?? body.model });
  // The rule decides what the model takes: an unsupported value is mapped to the
  // nearest supported one, and a model without reasoning control gets none.
  const effort = requested && mapReasoningEffort(r, requested, mode === "responses" ? "responses" : "chat").effort;
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

/**
 * Which `thinking` shape a Claude model accepts. Newer models (the 5.x family)
 * reject `{type:"enabled", budget_tokens}` and want `{type:"adaptive"}` plus
 * `output_config.effort`; older ones only know the budget form.
 * `auto` (default) detects by model id.
 */
export type ThinkingMode = "auto" | "adaptive" | "budget";

/** True when the model's rule uses `thinking:{type:"adaptive"}` + `output_config.effort` (Claude 4.6+ / 5.x). */
export function supportsAdaptiveThinking(model: unknown): boolean {
  if (typeof model !== "string") return false;
  return resolveModelRule({ provider: "anthropic", model }).reasoning.style === "adaptive";
}

export function resolveThinkingForm(model: unknown, mode: ThinkingMode | undefined, rule?: ModelRule): "adaptive" | "budget" {
  if (mode === "adaptive" || mode === "budget") return mode;
  if (rule) return rule.reasoning.style === "adaptive" ? "adaptive" : "budget";
  return supportsAdaptiveThinking(model) ? "adaptive" : "budget";
}

type ThinkingOpts = {
  model?: string;
  mode?: ThinkingMode;
  rule?: ModelRule;
  /** max_tokens on the body is the provider's own default, not the caller's: adaptive thinking may raise it. */
  defaultedMaxTokens?: boolean;
};

/** Drops the sampling params the rule does not allow (all of them for Claude 5.x; while thinking for older Claude). */
export function enforceAnthropicSampling(target: Record<string, any>, rule: ModelRule, thinkingOn: boolean, bedrock = false): void {
  const fields: Array<[string, "temperature" | "topP" | "topK"]> = bedrock
    ? [["temperature", "temperature"], ["topP", "topP"]]
    : [["temperature", "temperature"], ["top_p", "topP"], ["top_k", "topK"]];
  for (const [key, field] of fields) {
    if (key in target && !allowsSampling(rule, field, target[key], thinkingOn)) delete target[key];
  }
}

/** Adaptive thinking: the effort goes through the rule's mapping; `none` uses the off mechanism. Returns whether thinking is ON. */
function applyAdaptiveThinking(
  reasoning: ReasoningRequestConfig,
  rule: ModelRule,
  setThinking: (v: Record<string, any>) => void,
  setOutputConfig: (o: Record<string, any>) => void,
  raiseMaxTokens: (floor: number) => void,
): boolean {
  let requested = normalizeEffort(reasoning.effort);
  if (!requested && typeof reasoning.budgetTokens === "number" && reasoning.budgetTokens > 0) {
    requested = reasoning.budgetTokens <= ANTHROPIC_EFFORT_BUDGET.low ? "low" : reasoning.budgetTokens <= ANTHROPIC_EFFORT_BUDGET.medium ? "medium" : "high";
  }
  if (!requested) return false;
  const mapped = mapReasoningEffort(rule, requested);
  if (mapped.off) {
    setThinking({ type: mapped.off });
    return false;
  }
  if (!mapped.effort || mapped.effort === "none") return false;
  const thinking: Record<string, any> = { type: "adaptive" };
  // Claude 5.x returns an empty `thinking` string unless display is asked for.
  // Default: summarized, unless the caller opted out with includeThoughts:false.
  // providerExtras (below) can still set any other display value.
  if (reasoning.includeThoughts !== false) thinking.display = "summarized";
  if (reasoning.providerExtras) Object.assign(thinking, reasoning.providerExtras);
  setThinking(thinking);
  setOutputConfig({ effort: mapped.effort });
  const floor = ANTHROPIC_ADAPTIVE_MAX_TOKENS[mapped.effort as Exclude<ReasoningEffort, "none">];
  if (floor) raiseMaxTokens(floor);
  return true;
}

/** Maps onto Anthropic Messages API body.
 *
 * Requires claude-sonnet-3.7+, claude-opus-4, claude-sonnet-4 etc. Anthropic
 * requires an explicit budget_tokens value (we derive it from effort when the
 * caller didn't specify one) AND that `budget_tokens < max_tokens`. When
 * thinking is enabled Anthropic also rejects non-default `temperature`/`top_p`/
 * `top_k`, so we strip them here so callers can pass a unified config safely.
 * Which sampling params a model takes, and which thinking form, comes from its
 * rule in model-rules.json.
 */
export function applyAnthropicReasoning(
  body: Record<string, any>,
  reasoning: ReasoningRequestConfig | undefined,
  opts?: ThinkingOpts,
): void {
  const rule = opts?.rule ?? resolveModelRule({ provider: "anthropic", model: opts?.model ?? body.model });
  if (!reasoning) {
    enforceAnthropicSampling(body, rule, false);
    return;
  }
  if (resolveThinkingForm(opts?.model ?? body.model, opts?.mode, rule) === "adaptive") {
    const on = applyAdaptiveThinking(reasoning, rule, (t) => (body.thinking = t), (o) => (body.output_config = { ...(body.output_config ?? {}), ...o }),
      // Only the provider's own default: a caller's max_tokens is a hard cap and stays
      // (adaptive thinking, unlike a budget, does not require room above it).
      (floor) => { if (opts?.defaultedMaxTokens && typeof body.max_tokens === "number" && body.max_tokens < floor) body.max_tokens = floor; });
    enforceAnthropicSampling(body, rule, on);
    return;
  }
  let budget = resolveBudget(reasoning, ANTHROPIC_EFFORT_BUDGET, rule);
  if (!budget) {
    enforceAnthropicSampling(body, rule, false);
    return;
  }

  // Ensure max_tokens leaves room for the visible answer on top of thinking.
  const currentMax = typeof body.max_tokens === "number" ? body.max_tokens : 0;
  const requiredMax = Math.max(THINKING_MIN_MAX_TOKENS, budget + THINKING_OUTPUT_RESERVE);
  if (currentMax < requiredMax) {
    body.max_tokens = requiredMax;
  }
  // Clamp the budget strictly below max_tokens (Anthropic hard requirement),
  // and never under the API's minimum budget.
  budget = Math.max(MIN_THINKING_BUDGET, clampBudget(budget, body.max_tokens));

  const thinking: Record<string, any> = { type: "enabled", budget_tokens: budget };
  if (reasoning.providerExtras) Object.assign(thinking, reasoning.providerExtras);
  body.thinking = thinking;

  // Thinking mode forbids sampling overrides.
  enforceAnthropicSampling(body, rule, true);
}

/** Maps onto AWS Bedrock Converse for thinking-capable Anthropic models via
 * `additionalModelRequestFields.thinking`. Same budget/temperature rules as the
 * direct Anthropic API apply. The Converse body is mutated in place.
 */
export function applyBedrockReasoning(
  body: Record<string, any>,
  reasoning: ReasoningRequestConfig | undefined,
  opts?: ThinkingOpts,
): void {
  const rule = opts?.rule ?? resolveModelRule({ provider: "bedrock", model: opts?.model ?? body.modelId });
  if (!reasoning) {
    if (body.inferenceConfig) enforceAnthropicSampling(body.inferenceConfig, rule, false, true);
    return;
  }
  if (resolveThinkingForm(opts?.model ?? body.modelId, opts?.mode, rule) === "adaptive") {
    const fields = () => (body.additionalModelRequestFields ??= {});
    // No raise here: an unset maxTokens is the model maximum on Converse, and a set one is the caller's cap.
    const on = applyAdaptiveThinking(reasoning, rule, (t) => (fields().thinking = t), (o) => (fields().output_config = { ...(fields().output_config ?? {}), ...o }), () => {});
    if (body.inferenceConfig) enforceAnthropicSampling(body.inferenceConfig, rule, on, true);
    return;
  }
  let budget = resolveBudget(reasoning, ANTHROPIC_EFFORT_BUDGET, rule);
  if (!budget) {
    if (body.inferenceConfig) enforceAnthropicSampling(body.inferenceConfig, rule, false, true);
    return;
  }

  const inference = (body.inferenceConfig ??= {});
  const currentMax = typeof inference.maxTokens === "number" ? inference.maxTokens : 0;
  const requiredMax = Math.max(THINKING_MIN_MAX_TOKENS, budget + THINKING_OUTPUT_RESERVE);
  if (currentMax < requiredMax) {
    inference.maxTokens = requiredMax;
  }
  budget = Math.max(MIN_THINKING_BUDGET, clampBudget(budget, inference.maxTokens));

  const extra = (body.additionalModelRequestFields ??= {});
  const thinking: Record<string, any> = { type: "enabled", budget_tokens: budget };
  if (reasoning.providerExtras) Object.assign(thinking, reasoning.providerExtras);
  extra.thinking = thinking;

  // Thinking mode forbids sampling overrides on the inferenceConfig.
  enforceAnthropicSampling(inference, rule, true, true);
}

/** Maps onto Google Vertex / Gemini generationConfig. */
export function applyGeminiReasoning(
  generationConfig: Record<string, any>,
  reasoning: ReasoningRequestConfig | undefined,
): void {
  if (!reasoning) return;
  const budget = resolveBudget(reasoning, GEMINI_EFFORT_BUDGET);
  const level = typeof reasoning.thinkingLevel === "string" && reasoning.thinkingLevel ? reasoning.thinkingLevel : undefined;
  // `effort: none` still wins over a level; otherwise an explicit level replaces the budget.
  if (budget == null && !level) return;
  const thinkingConfig: Record<string, any> =
    level && budget !== 0 ? { thinkingLevel: level } : { thinkingBudget: budget ?? 0 };
  if (reasoning.includeThoughts) thinkingConfig.includeThoughts = true;
  if (reasoning.providerExtras) Object.assign(thinkingConfig, reasoning.providerExtras);
  generationConfig.thinkingConfig = thinkingConfig;
  // Thinking tokens come out of maxOutputTokens: keep room for the answer.
  // Dynamic (-1), 0 and levels have no known size, so they are left alone.
  const tb = thinkingConfig.thinkingBudget;
  const cap = generationConfig.maxOutputTokens;
  if (typeof tb === "number" && tb > 0 && typeof cap === "number" && cap < tb + GEMINI_OUTPUT_RESERVE) {
    generationConfig.maxOutputTokens = tb + GEMINI_OUTPUT_RESERVE;
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
  const allowed: ReasoningEffort[] = ["none", "minimal", "low", "medium", "high", "xhigh", "max"];
  return allowed.includes(effort) ? effort : undefined;
}

function resolveBudget(
  reasoning: ReasoningRequestConfig,
  effortBudget: Record<ReasoningEffort, number>,
  rule?: ModelRule,
): number | undefined {
  // `none` wins over an explicit budget, and the order is the whole point: a
  // caller that says "do not think" while an endpoint-level budgetTokens is
  // still set has stated the later and more specific intent, and silently
  // thinking anyway is the failure this ordering exists to prevent.
  const effort = normalizeEffort(reasoning.effort);
  if (effort === "none") return 0;
  if (typeof reasoning.budgetTokens === "number" && reasoning.budgetTokens > 0) {
    return Math.floor(reasoning.budgetTokens);
  }
  const mapped = effort && rule ? mapReasoningEffort(rule, effort).effort : effort;
  if (mapped && effortBudget[mapped]) return effortBudget[mapped];
  return undefined;
}
