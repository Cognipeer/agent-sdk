// Provider-agnostic mapper for ReasoningRequestConfig.
// Each native provider calls one of these helpers inside its buildRequestBody.
// The helpers are defensive — unknown fields are ignored silently so callers
// can pass a unified config regardless of the current provider.

import type { ReasoningRequestConfig, ReasoningEffort } from "../types.js";

export type OpenAIReasoningMode = "legacy_effort" | "responses";

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
 * requires an explicit budget_tokens value — we derive it from effort when the
 * caller didn't specify one. Temperature must be unset/1 for thinking mode; the
 * caller is responsible for that.
 */
export function applyAnthropicReasoning(
  body: Record<string, any>,
  reasoning: ReasoningRequestConfig | undefined,
): void {
  if (!reasoning) return;
  const budget = resolveBudget(reasoning, { low: 2048, medium: 8192, high: 16384, minimal: 1024 });
  if (!budget) return;
  const thinking: Record<string, any> = { type: "enabled", budget_tokens: budget };
  if (reasoning.providerExtras) Object.assign(thinking, reasoning.providerExtras);
  body.thinking = thinking;
}

/** Maps onto Google Vertex / Gemini generationConfig. */
export function applyGeminiReasoning(
  generationConfig: Record<string, any>,
  reasoning: ReasoningRequestConfig | undefined,
): void {
  if (!reasoning) return;
  const budget = resolveBudget(reasoning, { low: 1024, medium: 4096, high: 12000, minimal: 512 });
  if (budget == null) return;
  const thinkingConfig: Record<string, any> = { thinkingBudget: budget };
  if (reasoning.includeThoughts) thinkingConfig.includeThoughts = true;
  if (reasoning.providerExtras) Object.assign(thinkingConfig, reasoning.providerExtras);
  generationConfig.thinkingConfig = thinkingConfig;
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
