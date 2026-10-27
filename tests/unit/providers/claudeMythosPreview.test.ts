/**
 * Claude Mythos Preview is the one 4.7+ model that still takes extended thinking
 * (budget_tokens) and cannot have it disabled; the numbered Mythos 5 / 5.1 and Fable
 * models are adaptive-only.
 */

import { describe, it, expect } from "vitest";
import { applyAnthropicReasoning } from "../../../src/providers/utils/reasoning.js";
import { resolveModelRule } from "../../../src/models/rules.js";

const body = (model: string) => ({ model, max_tokens: 16000 }) as Record<string, any>;

describe("Mythos rules", () => {
  it.each(["claude-mythos-5", "claude-mythos-5-1", "claude-fable-5", "claude-fable-5-1"])("%s uses the adaptive Fable rule", (model) => {
    expect(resolveModelRule({ provider: "anthropic", model }).matchedRuleId).toBe("claude-fable");
  });

  it("claude-mythos-preview has its own budget-style rule", () => {
    const r = resolveModelRule({ provider: "anthropic", model: "claude-mythos-preview" });
    expect(r.matchedRuleId).toBe("claude-mythos-preview");
    expect(r.reasoning.style).toBe("budget");
    expect(r.reasoning.efforts).not.toContain("none");
  });
});

describe("Mythos thinking on the Messages API", () => {
  it("preview with budgetTokens sends enabled + budget_tokens", () => {
    const b = body("claude-mythos-preview");
    applyAnthropicReasoning(b, { budgetTokens: 4000 });
    expect(b.thinking).toEqual({ type: "enabled", budget_tokens: 4000 });
    expect(b.output_config).toBeUndefined();
  });

  it("mythos-5 with budgetTokens maps to adaptive + effort, never budget_tokens", () => {
    const b = body("claude-mythos-5");
    applyAnthropicReasoning(b, { budgetTokens: 4000 });
    expect(b.thinking.type).toBe("adaptive");
    expect(b.thinking.budget_tokens).toBeUndefined();
    expect(typeof b.output_config.effort).toBe("string");
  });

  it("effort none on preview never sends disabled", () => {
    for (const reasoning of [{ effort: "none" as const }, { effort: "none" as const, budgetTokens: 4000 }]) {
      const b = body("claude-mythos-preview");
      applyAnthropicReasoning(b, reasoning);
      expect(b.thinking).toBeUndefined();
    }
  });
});
