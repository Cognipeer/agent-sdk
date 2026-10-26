/**
 * model-rules.json: rule matching (incl. namespaced / Bedrock ids), the effort
 * ladder mapping, the learned-adjustment cache and the legacy helper wrappers.
 */
import { describe, it, expect, beforeEach } from "vitest";
import {
  MODEL_RULES,
  resolveModelRule,
  mapReasoningEffort,
  modelIdCandidates,
  rememberModelRulePatch,
  listLearnedModelRules,
  clearLearnedModelRules,
} from "../../../src/models/index.js";
import { isReasoningModel } from "../../../src/providers/openai.js";
import { supportsAdaptiveThinking, ANTHROPIC_EFFORT_BUDGET, GEMINI_EFFORT_BUDGET } from "../../../src/providers/utils/reasoning.js";

beforeEach(() => clearLearnedModelRules());

const rule = (provider: string, model: string) => resolveModelRule({ provider, model });

describe("model-rules.json", () => {
  it("has a version, the ladder and an ordered rule list ending in each family default", () => {
    expect(MODEL_RULES.version).toBe(1);
    expect(MODEL_RULES.effortLadder).toEqual(["none", "minimal", "low", "medium", "high", "xhigh", "max"]);
    for (const family of ["openai", "anthropic", "gemini", "other"]) {
      const rules = MODEL_RULES.rules.filter((r) => r.family === family);
      expect(rules[rules.length - 1].match).toBe(".*");
    }
    for (const r of MODEL_RULES.rules) expect(() => new RegExp(r.match, "i")).not.toThrow();
  });
  it("budget tables come from the JSON", () => {
    expect(ANTHROPIC_EFFORT_BUDGET.max).toBe(MODEL_RULES.budgets.max);
    expect(GEMINI_EFFORT_BUDGET.xhigh).toBe(MODEL_RULES.geminiBudgets.xhigh);
    expect(MODEL_RULES.budgets.max).toBeGreaterThan(MODEL_RULES.budgets.xhigh);
  });
});

describe("rule matching", () => {
  it.each([
    ["azure", "gpt-6-luna", "openai-gpt-6-plus"],
    ["openai", "gpt-6.1-sol", "openai-gpt-6-plus"],
    ["openai", "gpt-7", "openai-gpt-6-plus"],
    ["bedrock", "global.openai.gpt-6-luna", "openai-gpt-6-plus"],
    ["openai-compatible", "openai/gpt-6", "openai-gpt-6-plus"],
    ["azure", "gpt-5.6-terra", "openai-gpt-5x"],
    ["openai", "gpt-5.1", "openai-gpt-5x"],
    ["openai", "gpt-5", "openai-gpt-5-base"],
    ["openai", "gpt-5-mini", "openai-gpt-5-base"],
    ["openai", "gpt-5-codex", "openai-gpt-5-base"],
    ["openai", "gpt-5-chat-latest", "openai-chat-models"],
    ["openai", "gpt-5.1-chat-latest", "openai-chat-models"],
    ["openai", "o3", "openai-o-series"],
    ["openai", "o4-mini", "openai-o-series"],
    ["openai", "gpt-oss-120b", "openai-gpt-oss"],
    ["together", "openai/gpt-oss-20b", "openai-gpt-oss"],
    ["bedrock", "openai.gpt-oss-120b-1:0", "openai-gpt-oss"],
    ["openai", "gpt-4o", "openai-legacy-gpt"],
    ["openai", "gpt-4.1-mini", "openai-legacy-gpt"],
    ["openai-compatible", "deepseek-r1", "openai-compatible-toggle"],
    ["openai-compatible", "Qwen/QwQ-32B", "openai-compatible-toggle"],
    ["openai-compatible", "qwen3-32b", "openai-compatible-toggle"],
    ["anthropic", "claude-haiku-5-5", "claude-haiku-5"],
    ["anthropic", "claude-sonnet-5-5", "claude-sonnet-5"],
    ["anthropic", "claude-opus-5-5", "claude-opus-5"],
    ["anthropic", "claude-sonnet-5", "claude-sonnet-5"],
    ["bedrock", "us.anthropic.claude-sonnet-5-5-20260101-v1:0", "claude-sonnet-5"],
    ["bedrock", "global.anthropic.claude-opus-5-5-v1:0", "claude-opus-5"],
    ["vertex", "claude-sonnet-5@20260101", "claude-sonnet-5"],
    ["anthropic", "anthropic/claude-haiku-5-5", "claude-haiku-5"],
    ["anthropic", "claude-fable-5-1", "claude-fable"],
    ["anthropic", "claude-opus-4-7", "claude-4-7"],
    ["anthropic", "claude-opus-4-6", "claude-4-6"],
    ["anthropic", "claude-sonnet-4-5", "claude-legacy-budget"],
    ["anthropic", "claude-sonnet-4-20250514", "claude-legacy-budget"],
    ["bedrock", "anthropic.claude-3-7-sonnet-20250219-v1:0", "claude-legacy-budget"],
    ["anthropic", "claude-3-5-haiku-20241022", "claude-legacy-budget"],
    ["vertex", "gemini-2.5-flash", "gemini-budget"],
    ["gemini", "models/gemini-2.5-pro", "gemini-2.5-pro"],
  ])("%s / %s -> %s", (provider, model, id) => {
    const r = rule(provider, model);
    expect(r.matchedRuleId).toBe(id);
    expect(r.isDefault).toBe(false);
  });

  it("unknown ids get the family's permissive default and say so", () => {
    for (const [provider, model, id] of [
      ["azure", "my-prod-deployment", "openai-default"],
      ["openai", "acme-large-1", "openai-default"],
      ["openai-compatible", "anthropic/claude-haiku-5-5", "openai-default"],
      ["anthropic", "mystery", "anthropic-default"],
      ["vertex", "mystery", "gemini-default"],
    ] as const) {
      const r = rule(provider, model);
      expect(r.matchedRuleId, `${provider}/${model}`).toBe(id);
      expect(r.isDefault).toBe(true);
    }
    const d = rule("openai", "acme-large-1");
    expect(d.sampling.temperature).toBe("any");
    expect(d.reasoning.efforts).toEqual(MODEL_RULES.effortLadder);
  });

  it("normalises candidate ids", () => {
    expect(modelIdCandidates("Global.OpenAI.GPT-6-Luna")).toContain("gpt-6-luna");
    expect(modelIdCandidates("openai/gpt-6")).toContain("gpt-6");
    expect(modelIdCandidates("us.anthropic.claude-sonnet-5-5-v1:0")).toContain("claude-sonnet-5-5-v1:0");
    expect(modelIdCandidates(undefined)).toEqual([]);
  });

  it("verified rules carry the verified source, docs rules say docs", () => {
    expect(rule("azure", "gpt-6-luna").source).toBe("verified-2026-10-14");
    expect(rule("anthropic", "claude-opus-5-5").source).toBe("verified-2026-10-14");
    expect(rule("openai", "o3").source).toBe("docs");
    expect(rule("vertex", "gemini-2.5-pro").source).toBe("docs");
  });
});

describe("mapReasoningEffort", () => {
  const map = (provider: string, model: string, effort: any, endpoint?: "chat" | "responses") => mapReasoningEffort(rule(provider, model), effort, endpoint);

  it("gpt-6: max -> xhigh on chat, kept on responses; minimal -> low; none stays none", () => {
    expect(map("azure", "gpt-6-luna", "max")).toEqual({ effort: "xhigh", mapped: true });
    expect(map("azure", "gpt-6-luna", "max", "responses")).toEqual({ effort: "max", mapped: false });
    expect(map("azure", "gpt-6-luna", "minimal")).toEqual({ effort: "low", mapped: true });
    expect(map("azure", "gpt-6-luna", "none")).toEqual({ effort: "none", mapped: false });
    expect(map("azure", "gpt-6-luna", "high")).toEqual({ effort: "high", mapped: false });
  });
  it("gpt-5 base: xhigh -> high, minimal kept, none -> lowest (minimal)", () => {
    expect(map("openai", "gpt-5", "xhigh")).toEqual({ effort: "high", mapped: true });
    expect(map("openai", "gpt-5-mini", "minimal")).toEqual({ effort: "minimal", mapped: false });
    expect(map("openai", "gpt-5", "none")).toEqual({ effort: "minimal", mapped: true });
  });
  it("o-series: max -> high, minimal -> low, none -> low", () => {
    expect(map("openai", "o3", "max")).toEqual({ effort: "high", mapped: true });
    expect(map("openai", "o3", "minimal")).toEqual({ effort: "low", mapped: true });
    expect(map("openai", "o3", "none")).toEqual({ effort: "low", mapped: true });
  });
  it("Claude 5.5: off mechanisms per model; opus cannot turn thinking off", () => {
    expect(map("anthropic", "claude-opus-5-5", "none")).toEqual({ effort: "low", mapped: true });
    expect(map("anthropic", "claude-sonnet-5-5", "none")).toEqual({ off: "between_tools", mapped: true });
    expect(map("anthropic", "claude-haiku-5-5", "none")).toEqual({ off: "disabled", mapped: true });
    expect(map("anthropic", "claude-opus-5-5", "minimal")).toEqual({ effort: "low", mapped: true });
    expect(map("anthropic", "claude-opus-5-5", "max")).toEqual({ effort: "max", mapped: false });
  });
  it("Claude 4.6 tops out at max without xhigh (xhigh -> high); 4.7 takes xhigh", () => {
    expect(map("anthropic", "claude-opus-4-6", "xhigh")).toEqual({ effort: "high", mapped: true });
    expect(map("anthropic", "claude-opus-4-7", "xhigh")).toEqual({ effort: "xhigh", mapped: false });
  });
  it("models without reasoning control return no value; budget / unknown models pass everything", () => {
    expect(map("openai", "gpt-4o", "high")).toEqual({ mapped: true });
    expect(map("openai", "gpt-5-chat-latest", "high")).toEqual({ mapped: true });
    expect(map("anthropic", "claude-sonnet-4-5", "xhigh")).toEqual({ effort: "xhigh", mapped: false });
    expect(map("openai", "acme-large-1", "max")).toEqual({ effort: "max", mapped: false });
  });
  it("when nothing lower exists the nearest higher is used", () => {
    expect(mapReasoningEffort({ ...rule("openai", "o3"), reasoning: { style: "effort", efforts: ["high"], off: null } }, "low")).toEqual({ effort: "high", mapped: true });
  });
});

describe("legacy helpers read the rules", () => {
  it("isReasoningModel", () => {
    for (const m of ["gpt-6", "gpt-6-luna", "gpt-7", "openai/gpt-6", "global.openai.gpt-6-luna", "gpt-5.6-terra", "gpt-5-mini", "o3", "o4-mini"]) {
      expect(isReasoningModel(m), m).toBe(true);
    }
    for (const m of ["gpt-4o", "gpt-4.1", "gpt-3.5-turbo", "claude-sonnet-5-5", "gpt-5-chat-latest", "gpt-oss-120b", "acme-large-1", undefined]) {
      expect(isReasoningModel(m as any), String(m)).toBe(false);
    }
  });
  it("supportsAdaptiveThinking", () => {
    for (const m of ["claude-sonnet-5-5", "claude-opus-4-6", "claude-opus-4-7", "claude-fable-5-1"]) expect(supportsAdaptiveThinking(m), m).toBe(true);
    for (const m of ["claude-sonnet-4-5", "claude-3-7-sonnet-20250219", "gpt-6"]) expect(supportsAdaptiveThinking(m), m).toBe(false);
  });
});

describe("Azure gpt-3.5 deployment ids", () => {
  it.each(["gpt-35-turbo", "gpt-35-turbo-16k", "gpt-35-turbo-instruct"])("%s is a legacy non-reasoning model", (m) => {
    expect(rule("azure", m).matchedRuleId).toBe("openai-legacy-gpt");
    expect(rule("azure", m).reasoning.style).toBe("none");
  });
  it("gpt-6 and gpt-10 style ids still match gpt-6-plus", () => {
    expect(rule("openai", "gpt-6-luna").matchedRuleId).toBe("openai-gpt-6-plus");
    expect(rule("openai", "gpt-10").matchedRuleId).toBe("openai-gpt-6-plus");
  });
});

describe("learned adjustments", () => {
  it("are merged into the resolved rule and flagged", () => {
    rememberModelRulePatch("openai", "Acme-Large-1", { sampling: { temperature: "unsupported" }, maxTokensParam: "max_completion_tokens" });
    const r = rule("openai", "acme-large-1");
    expect(r.learned).toBe(true);
    expect(r.sampling.temperature).toBe("unsupported");
    expect(r.maxTokensParam).toBe("max_completion_tokens");
    expect(rule("azure", "acme-large-1").learned).toBe(false);
  });
  it("the cache is bounded at 500 entries (oldest evicted)", () => {
    for (let i = 0; i < 520; i++) rememberModelRulePatch("openai", `m-${i}`, { dropParams: ["seed"] });
    expect(listLearnedModelRules()).toHaveLength(500);
    expect(rule("openai", "m-0").learned).toBe(false);
    expect(rule("openai", "m-519").learned).toBe(true);
  });
});
