// Per-model request rules. One JSON file (model-rules.json, shipped in the
// package and importable as "@cognipeer/agent-sdk/model-rules.json") describes
// what every model family accepts; everything in the SDK that used to be a
// hardcoded model-name check reads it through the functions below.

import rulesJson from "./model-rules.json";
import type { ReasoningEffort } from "../providers/types.js";

export type { ReasoningEffort };

export type RuleFamily = "openai" | "anthropic" | "gemini" | "other";
export type ReasoningStyle = "effort" | "adaptive" | "budget" | "toggle" | "none";
/** How "reasoning off" is spelled on the wire (`none` = the effort value itself). */
export type OffMechanism = "none" | "disabled" | "between_tools";
export type TemperatureRule = "any" | "default-only" | "unsupported" | "thinking-requires-1";
export type MaxTokensParam = "max_tokens" | "max_completion_tokens";
export type RuleSource = "verified-2026-10-14" | "docs" | "learned";

export type ModelRule = {
  id: string;
  family: RuleFamily;
  /** Case-insensitive regex tested against the normalised candidate ids. */
  match: string;
  reasoning: {
    style: ReasoningStyle;
    /** Effort values the wire accepts (Chat Completions / Messages). Empty = no reasoning control. */
    efforts: ReasoningEffort[];
    /** Efforts the OpenAI Responses endpoint accepts, when they differ from `efforts`. */
    responsesEfforts?: ReasoningEffort[];
    off: OffMechanism | null;
  };
  sampling: {
    temperature: TemperatureRule;
    topP: boolean;
    topK: boolean;
    penalties: boolean;
    logprobs: boolean;
  };
  maxTokensParam: MaxTokensParam;
  chatTools: { reasoning: "any" | "force-none" };
  /** Request fields to leave out, learned from a provider 400 (not used in the shipped JSON). */
  dropParams?: string[];
  source: RuleSource;
  note: string;
};

export type ModelRules = {
  version: number;
  effortLadder: ReasoningEffort[];
  /** Thinking-token budgets for budget-style engines (Anthropic 3.7/4.x, Bedrock). */
  budgets: Record<Exclude<ReasoningEffort, "none">, number>;
  geminiBudgets: Record<Exclude<ReasoningEffort, "none">, number>;
  rules: ModelRule[];
};

/** A sparse override merged over a rule (what a provider 400 teaches us). */
export type RulePatch = {
  reasoning?: Partial<ModelRule["reasoning"]>;
  sampling?: Partial<ModelRule["sampling"]>;
  maxTokensParam?: MaxTokensParam;
  chatTools?: Partial<ModelRule["chatTools"]>;
  dropParams?: string[];
};

export type ResolvedModelRule = ModelRule & {
  /** Id of the rule that matched (e.g. `openai-gpt-6-plus`). */
  matchedRuleId: string;
  /** True when only the family's permissive default matched: the model is not in the JSON. */
  isDefault: boolean;
  /** True when a learned adjustment is merged into this rule. */
  learned: boolean;
};

export const MODEL_RULES: ModelRules = rulesJson as unknown as ModelRules;

const LADDER = MODEL_RULES.effortLadder;
const compiled = new Map<string, RegExp>();

function regexFor(rule: ModelRule): RegExp {
  let re = compiled.get(rule.id);
  if (!re) {
    re = new RegExp(rule.match, "i");
    compiled.set(rule.id, re);
  }
  return re;
}

// Region / cross-region inference prefixes and vendor namespaces used by
// gateways and Bedrock (`global.openai.gpt-6-luna`, `us.anthropic.claude-...`).
const GATEWAY_PREFIX = /^(?:(?:global|us|eu|apac|jp|au|ca|us-gov)\.)?(?:(?:openai|anthropic|google|meta|amazon|deepseek|qwen|mistral|cohere|ai21)\.)?/;

/** Normalised ids a rule is matched against: lowercase, last path segment, gateway prefixes stripped. */
export function modelIdCandidates(model: string | undefined): string[] {
  if (!model) return [];
  const lower = String(model).trim().toLowerCase();
  const last = lower.split("/").pop() ?? lower;
  const out: string[] = [];
  for (const id of [lower, last]) {
    for (const c of [id, id.replace(GATEWAY_PREFIX, "")]) {
      if (c && !out.includes(c)) out.push(c);
    }
  }
  return out;
}

const OPENAI_WIRE = new Set(["openai", "azure", "openai-compatible", "together", "openrouter", "groq", "fireworks", "ollama", "vllm", "litellm", "mistral", "deepseek", "xai", "jev"]);

/** Families to search for a provider, most specific first; the first is also the default family. */
function familiesFor(provider: string | undefined): RuleFamily[] {
  const p = (provider ?? "").toLowerCase();
  if (OPENAI_WIRE.has(p)) return ["openai"];
  if (p === "anthropic") return ["anthropic"];
  if (p === "bedrock") return ["anthropic", "openai", "other"];
  if (p === "vertex" || p === "gemini" || p === "google") return ["gemini", "anthropic"];
  return ["openai", "anthropic", "gemini", "other"];
}

function matchRule(family: RuleFamily, ids: string[], allowDefault: boolean): ModelRule | undefined {
  for (const rule of MODEL_RULES.rules) {
    if (rule.family !== family) continue;
    if (rule.match === ".*") {
      if (allowDefault) return rule;
      continue;
    }
    const re = regexFor(rule);
    if (ids.some((id) => re.test(id))) return rule;
  }
  return undefined;
}

export function mergeRulePatch<T extends RulePatch>(base: T, patch: RulePatch | undefined): T {
  if (!patch) return base;
  const out: any = { ...base };
  if (patch.reasoning) out.reasoning = { ...(base.reasoning ?? {}), ...patch.reasoning };
  if (patch.sampling) out.sampling = { ...(base.sampling ?? {}), ...patch.sampling };
  if (patch.chatTools) out.chatTools = { ...(base.chatTools ?? {}), ...patch.chatTools };
  if (patch.maxTokensParam) out.maxTokensParam = patch.maxTokensParam;
  if (patch.dropParams) out.dropParams = [...new Set([...(base.dropParams ?? []), ...patch.dropParams])];
  return out;
}

// ─── Learned adjustments ─────────────────────────────────────────────────────
// Bounded, in-process: what provider 400s taught us per (provider, model id).

const LEARNED_MAX = 500;
type LearnedEntry = { provider: string; model: string; scope?: string; patch: RulePatch };
const learned = new Map<string, LearnedEntry>();

// `scope` separates deployments that share a model id but not a backend (an
// Azure resource or openai-compatible endpoint: the id is a user-chosen name).
function learnedKey(provider: string | undefined, model: string | undefined, scope?: string): string {
  return `${(provider ?? "").toLowerCase()}@${scope ?? ""}::${(model ?? "").trim().toLowerCase()}`;
}

/** Records (merges) a learned patch; the oldest entry is evicted past 500. */
export function rememberModelRulePatch(provider: string, model: string, patch: RulePatch, scope?: string): void {
  const key = learnedKey(provider, model, scope);
  const merged = mergeRulePatch<RulePatch>(learned.get(key)?.patch ?? {}, patch);
  learned.delete(key);
  learned.set(key, { provider: provider.toLowerCase(), model: model.trim().toLowerCase(), scope, patch: merged });
  if (learned.size > LEARNED_MAX) learned.delete(learned.keys().next().value as string);
}

export function getLearnedModelRulePatch(provider: string, model: string, scope?: string): RulePatch | undefined {
  return learned.get(learnedKey(provider, model, scope))?.patch;
}

/** Snapshot of everything learned so far (hosts can persist it and re-seed with `rememberModelRulePatch`). */
export function listLearnedModelRules(): Array<{ provider: string; model: string; scope?: string; patch: RulePatch }> {
  return [...learned.values()].map((e) => ({ ...e }));
}

export function clearLearnedModelRules(): void {
  learned.clear();
}

/**
 * Finds the rule for a model: the first matching rule of the provider's family
 * (or families, for gateways such as Bedrock), else the family's permissive
 * default. Learned adjustments for (provider, model) are merged in; `patch`
 * lets a caller layer one more override on top (used by the retry loop).
 */
export function resolveModelRule(opts: { provider?: string; model?: string; patch?: RulePatch; scope?: string }): ResolvedModelRule {
  const families = familiesFor(opts.provider);
  const ids = modelIdCandidates(opts.model);
  let rule: ModelRule | undefined;
  for (const family of families) {
    rule = matchRule(family, ids, false);
    if (rule) break;
  }
  let isDefault = false;
  if (!rule) {
    isDefault = true;
    rule = matchRule(families[0], ids, true) ?? MODEL_RULES.rules[MODEL_RULES.rules.length - 1];
  }
  let effective: ModelRule = rule;
  const known = opts.model ? learned.get(learnedKey(opts.provider, opts.model, opts.scope))?.patch : undefined;
  if (known) effective = mergeRulePatch(effective, known);
  if (opts.patch) effective = mergeRulePatch(effective, opts.patch);
  return { ...effective, matchedRuleId: rule.id, isDefault, learned: !!known };
}

export type EffortMapping = {
  /** The effort value to put on the wire. */
  effort?: ReasoningEffort;
  /** The off mechanism to use instead (`disabled` / `between_tools`). */
  off?: Exclude<OffMechanism, "none">;
  /** False only when the requested value goes through untouched. */
  mapped: boolean;
};

/**
 * Maps a requested effort onto what the rule accepts. A supported value passes;
 * an unsupported one goes to the nearest LOWER supported value (nearest higher
 * if nothing lower exists). `none` uses the rule's off mechanism, else the
 * lowest supported value. A requested non-`none` effort never maps to `none`
 * (asking for "minimal" must not switch thinking off). A rule without reasoning
 * control returns `{ mapped: true }` with no value.
 */
export function mapReasoningEffort(rule: ModelRule, effort: ReasoningEffort, endpoint: "chat" | "responses" = "chat"): EffortMapping {
  const efforts = (endpoint === "responses" && rule.reasoning.responsesEfforts) || rule.reasoning.efforts;
  if (rule.reasoning.style === "none" || efforts.length === 0) return { mapped: true };
  const supported = LADDER.filter((e) => efforts.includes(e));
  if (supported.includes(effort)) return { effort, mapped: false };
  if (effort === "none") {
    const off = rule.reasoning.off;
    if (off && off !== "none") return { off, mapped: true };
    const lowest = supported.find((e) => e !== "none");
    return lowest ? { effort: lowest, mapped: true } : { mapped: true };
  }
  const at = LADDER.indexOf(effort);
  if (at < 0) return { mapped: true };
  for (let i = at - 1; i >= 1; i--) if (supported.includes(LADDER[i])) return { effort: LADDER[i], mapped: true };
  for (let i = at + 1; i < LADDER.length; i++) if (supported.includes(LADDER[i])) return { effort: LADDER[i], mapped: true };
  return supported.includes("none") ? { effort: "none", mapped: true } : { mapped: true };
}

export type SamplingField = "temperature" | "topP" | "topK" | "presencePenalty" | "frequencyPenalty" | "logprobs";

/** Whether the rule lets a sampling field through. `thinkingOn` matters for `thinking-requires-1`. */
export function allowsSampling(rule: ModelRule, field: SamplingField, value?: unknown, thinkingOn = false): boolean {
  const s = rule.sampling;
  switch (field) {
    case "temperature":
      switch (s.temperature) {
        case "any": return true;
        case "unsupported": return false;
        // The default is what the server applies anyway, so it is never sent.
        case "default-only": return false;
        case "thinking-requires-1": return !thinkingOn || value === 1;
      }
      return true;
    // Anthropic's thinking restriction covers top_p / top_k as well as temperature.
    case "topP": return s.topP && !(thinkingOn && s.temperature === "thinking-requires-1");
    case "topK": return s.topK && !(thinkingOn && s.temperature === "thinking-requires-1");
    case "presencePenalty":
    case "frequencyPenalty": return s.penalties;
    case "logprobs": return s.logprobs;
  }
}

/** Removes `rule.dropParams` (top-level keys) from a request body. */
export function applyDropParams(body: Record<string, any>, rule: ModelRule): void {
  for (const p of rule.dropParams ?? []) {
    const dot = p.indexOf(".");
    if (dot < 0) delete body[p];
    else if (body[p.slice(0, dot)] && typeof body[p.slice(0, dot)] === "object") delete body[p.slice(0, dot)][p.slice(dot + 1)];
  }
}

/** Token budget for a budget-style engine; 0 for `none`. */
export function effortBudget(effort: ReasoningEffort, table: "anthropic" | "gemini" = "anthropic"): number {
  if (effort === "none") return 0;
  return (table === "gemini" ? MODEL_RULES.geminiBudgets : MODEL_RULES.budgets)[effort] ?? 0;
}
