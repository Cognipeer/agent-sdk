/**
 * Unit tests for the provider-agnostic reasoning mappers.
 * Verifies budget derivation, max_tokens raising, budget clamping and the
 * sampling-parameter stripping that thinking-mode requires.
 */

import { describe, it, expect } from "vitest";
import {
  applyOpenAIReasoning,
  applyAnthropicReasoning,
  applyBedrockReasoning,
  applyGeminiReasoning,
  ANTHROPIC_EFFORT_BUDGET,
  GEMINI_EFFORT_BUDGET,
} from "../../../src/providers/utils/reasoning.js";

describe("applyOpenAIReasoning", () => {
  it("maps effort to reasoning_effort in legacy mode", () => {
    const body: any = {};
    applyOpenAIReasoning(body, { effort: "high" }, "legacy_effort");
    expect(body.reasoning_effort).toBe("high");
  });

  it("nests effort under reasoning in responses mode and supports summary", () => {
    const body: any = {};
    applyOpenAIReasoning(body, { effort: "medium", includeThoughts: true }, "responses");
    expect(body.reasoning).toEqual({ effort: "medium", summary: "auto" });
  });

  it("is a no-op when reasoning is undefined", () => {
    const body: any = { temperature: 0.5 };
    applyOpenAIReasoning(body, undefined);
    expect(body).toEqual({ temperature: 0.5 });
  });

  it("ignores invalid effort values", () => {
    const body: any = {};
    applyOpenAIReasoning(body, { effort: "ultra" as any });
    expect(body.reasoning_effort).toBeUndefined();
  });
});

describe("applyAnthropicReasoning", () => {
  it("derives budget from effort and raises max_tokens above the budget", () => {
    const body: any = { max_tokens: 1000, temperature: 0.7, top_p: 0.9 };
    applyAnthropicReasoning(body, { effort: "high" });
    expect(body.thinking.type).toBe("enabled");
    // budget must be strictly below max_tokens
    expect(body.thinking.budget_tokens).toBeLessThan(body.max_tokens);
    expect(body.max_tokens).toBeGreaterThanOrEqual(ANTHROPIC_EFFORT_BUDGET.high);
    // sampling params stripped
    expect(body.temperature).toBeUndefined();
    expect(body.top_p).toBeUndefined();
  });

  it("respects an explicit budgetTokens override", () => {
    const body: any = { max_tokens: 20000 };
    applyAnthropicReasoning(body, { budgetTokens: 5000 });
    expect(body.thinking.budget_tokens).toBe(5000);
  });

  it("is a no-op without effort or budget", () => {
    const body: any = { max_tokens: 1000 };
    applyAnthropicReasoning(body, {});
    expect(body.thinking).toBeUndefined();
    expect(body.max_tokens).toBe(1000);
  });
});

describe("applyBedrockReasoning", () => {
  it("sets thinking on additionalModelRequestFields and manages inferenceConfig", () => {
    const body: any = { inferenceConfig: { maxTokens: 1000, temperature: 0.5, topP: 0.8 } };
    applyBedrockReasoning(body, { effort: "medium" });
    expect(body.additionalModelRequestFields.thinking.type).toBe("enabled");
    expect(body.additionalModelRequestFields.thinking.budget_tokens).toBeLessThan(
      body.inferenceConfig.maxTokens,
    );
    expect(body.inferenceConfig.temperature).toBeUndefined();
    expect(body.inferenceConfig.topP).toBeUndefined();
  });

  it("creates inferenceConfig when absent", () => {
    const body: any = {};
    applyBedrockReasoning(body, { effort: "low" });
    expect(body.inferenceConfig.maxTokens).toBeGreaterThan(0);
  });
});

describe("applyGeminiReasoning", () => {
  it("sets thinkingConfig.thinkingBudget from the gemini budget table", () => {
    const cfg: any = {};
    applyGeminiReasoning(cfg, { effort: "high" });
    expect(cfg.thinkingConfig.thinkingBudget).toBe(GEMINI_EFFORT_BUDGET.high);
  });

  it("includes thoughts when requested", () => {
    const cfg: any = {};
    applyGeminiReasoning(cfg, { effort: "low", includeThoughts: true });
    expect(cfg.thinkingConfig.includeThoughts).toBe(true);
  });
});
