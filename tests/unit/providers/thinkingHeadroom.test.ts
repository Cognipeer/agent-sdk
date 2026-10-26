/**
 * Output headroom when thinking is on: adaptive thinking shares max_tokens with
 * the visible answer, Gemini counts thinking against maxOutputTokens. Adaptive
 * thinking raises only the provider's own default (a caller's max_tokens is a hard
 * cap); a thinking budget raises any cap too small for it. Nothing is ever lowered.
 */

import { describe, it, expect } from "vitest";
import {
  applyAnthropicReasoning,
  applyBedrockReasoning,
  applyGeminiReasoning,
  ANTHROPIC_ADAPTIVE_MAX_TOKENS,
  ANTHROPIC_EFFORT_BUDGET,
} from "../../../src/providers/utils/reasoning.js";

const ADAPTIVE = "claude-sonnet-5-5";
const BEDROCK_ADAPTIVE = "anthropic.claude-sonnet-5-5-v1:0";

describe("adaptiveMaxTokens table", () => {
  it("carries the documented floors", () => {
    expect(ANTHROPIC_ADAPTIVE_MAX_TOKENS).toEqual({
      minimal: 4096,
      low: 8192,
      medium: 16384,
      high: 32768,
      xhigh: 64000,
      max: 64000,
    });
  });
});

describe("applyAnthropicReasoning adaptive headroom", () => {
  const DEFAULTED = { defaultedMaxTokens: true };

  it("raises the provider's default max_tokens for effort high", () => {
    const body: any = { model: ADAPTIVE, max_tokens: 4096 };
    applyAnthropicReasoning(body, { effort: "high" }, DEFAULTED);
    expect(body.thinking.type).toBe("adaptive");
    expect(body.max_tokens).toBe(32768);
  });

  it("raises the default to 64K for xhigh and max", () => {
    for (const effort of ["xhigh", "max"] as const) {
      const body: any = { model: ADAPTIVE, max_tokens: 16384 };
      applyAnthropicReasoning(body, { effort }, DEFAULTED);
      expect(body.max_tokens).toBe(64000);
    }
  });

  it("keeps a caller's max_tokens: it is a hard cap", () => {
    const body: any = { model: ADAPTIVE, max_tokens: 1024 };
    applyAnthropicReasoning(body, { effort: "max" });
    expect(body.thinking.type).toBe("adaptive");
    expect(body.max_tokens).toBe(1024);
  });

  it("keeps an already larger default", () => {
    const body: any = { model: ADAPTIVE, max_tokens: 100000 };
    applyAnthropicReasoning(body, { effort: "xhigh" }, DEFAULTED);
    expect(body.max_tokens).toBe(100000);
  });

  it("uses the mapped effort (minimal -> low)", () => {
    const body: any = { model: ADAPTIVE, max_tokens: 1024 };
    applyAnthropicReasoning(body, { effort: "minimal" }, DEFAULTED);
    expect(body.output_config.effort).toBe("low");
    expect(body.max_tokens).toBe(8192);
  });

  it("does not invent max_tokens when it is not set yet", () => {
    const body: any = { model: ADAPTIVE };
    applyAnthropicReasoning(body, { effort: "high" }, DEFAULTED);
    expect(body.max_tokens).toBeUndefined();
  });

  it("leaves max_tokens alone when thinking is off", () => {
    const body: any = { model: "claude-haiku-5-5", max_tokens: 1000 };
    applyAnthropicReasoning(body, { effort: "none" }, DEFAULTED);
    expect(body.thinking).toEqual({ type: "disabled" });
    expect(body.max_tokens).toBe(1000);
  });

  it("leaves the budget style unchanged", () => {
    const body: any = { model: "claude-sonnet-4-20250514", max_tokens: 1000 };
    applyAnthropicReasoning(body, { effort: "high" });
    expect(body.max_tokens).toBe(ANTHROPIC_EFFORT_BUDGET.high + 1024);
    expect(body.thinking.type).toBe("enabled");
  });
});

describe("applyBedrockReasoning adaptive headroom", () => {
  it("keeps a set maxTokens: it is the caller's cap", () => {
    const body: any = { modelId: BEDROCK_ADAPTIVE, inferenceConfig: { maxTokens: 2048 } };
    applyBedrockReasoning(body, { effort: "high" });
    expect(body.additionalModelRequestFields.thinking.type).toBe("adaptive");
    expect(body.inferenceConfig.maxTokens).toBe(2048);
  });

  it("keeps an already larger maxTokens", () => {
    const body: any = { modelId: BEDROCK_ADAPTIVE, inferenceConfig: { maxTokens: 90000 } };
    applyBedrockReasoning(body, { effort: "xhigh" });
    expect(body.inferenceConfig.maxTokens).toBe(90000);
  });

  it("leaves an unset maxTokens unset (model maximum)", () => {
    const body: any = { modelId: BEDROCK_ADAPTIVE, inferenceConfig: { temperature: 1 } };
    applyBedrockReasoning(body, { effort: "high" });
    expect(body.inferenceConfig.maxTokens).toBeUndefined();

    const noConfig: any = { modelId: BEDROCK_ADAPTIVE };
    applyBedrockReasoning(noConfig, { effort: "high" });
    expect(noConfig.inferenceConfig).toBeUndefined();
  });

  it("leaves maxTokens alone when thinking is off", () => {
    const body: any = { modelId: "anthropic.claude-haiku-5-5-v1:0", inferenceConfig: { maxTokens: 500 } };
    applyBedrockReasoning(body, { effort: "none" });
    expect(body.inferenceConfig.maxTokens).toBe(500);
  });

  it("leaves the budget style unchanged", () => {
    const body: any = { modelId: "anthropic.claude-sonnet-4-20250514-v1:0", inferenceConfig: { maxTokens: 1000 } };
    applyBedrockReasoning(body, { effort: "high" });
    expect(body.inferenceConfig.maxTokens).toBe(ANTHROPIC_EFFORT_BUDGET.high + 1024);
  });
});

describe("applyGeminiReasoning headroom", () => {
  it("raises maxOutputTokens below budget + 2048", () => {
    const cfg: any = { maxOutputTokens: 1000 };
    applyGeminiReasoning(cfg, { budgetTokens: 4000 });
    expect(cfg.thinkingConfig.thinkingBudget).toBe(4000);
    expect(cfg.maxOutputTokens).toBe(6048);
  });

  it("keeps a maxOutputTokens that already has room", () => {
    const cfg: any = { maxOutputTokens: 20000 };
    applyGeminiReasoning(cfg, { budgetTokens: 4000 });
    expect(cfg.maxOutputTokens).toBe(20000);
  });

  it("does not create maxOutputTokens when unset", () => {
    const cfg: any = {};
    applyGeminiReasoning(cfg, { budgetTokens: 4000 });
    expect(cfg.maxOutputTokens).toBeUndefined();
  });

  it("leaves it alone for a dynamic budget, zero and a thinking level", () => {
    const dynamic: any = { maxOutputTokens: 100 };
    applyGeminiReasoning(dynamic, { providerExtras: { thinkingBudget: -1 }, effort: "low" });
    expect(dynamic.thinkingConfig.thinkingBudget).toBe(-1);
    expect(dynamic.maxOutputTokens).toBe(100);

    const off: any = { maxOutputTokens: 100 };
    applyGeminiReasoning(off, { effort: "none" });
    expect(off.thinkingConfig.thinkingBudget).toBe(0);
    expect(off.maxOutputTokens).toBe(100);

    const level: any = { maxOutputTokens: 100 };
    applyGeminiReasoning(level, { thinkingLevel: "high" });
    expect(level.thinkingConfig.thinkingLevel).toBe("high");
    expect(level.maxOutputTokens).toBe(100);
  });
});
