/**
 * xhigh / max effort levels: model detection (gpt-6+), per-model clamping and
 * Claude pass-through / legacy budget scaling.
 */
import { describe, it, expect } from "vitest";
import { OpenAIProvider, isReasoningModel } from "../../../src/providers/openai.js";
import {
  applyOpenAIReasoning,
  applyAnthropicReasoning,
  applyBedrockReasoning,
  applyGeminiReasoning,
  clampOpenAIEffort,
  ANTHROPIC_EFFORT_BUDGET,
  GEMINI_EFFORT_BUDGET,
} from "../../../src/providers/utils/reasoning.js";

describe("isReasoningModel for gpt-N", () => {
  it.each(["gpt-6", "gpt-6-luna", "gpt-7", "openai/gpt-6", "global.openai.gpt-6-luna", "gpt-5.6-terra", "gpt-5-mini"])(
    "%s is a reasoning model",
    (m) => expect(isReasoningModel(m)).toBe(true),
  );
  it.each(["gpt-4o", "gpt-4.1", "gpt-3.5-turbo", "claude-sonnet-5-5"])("%s is not", (m) =>
    expect(isReasoningModel(m)).toBe(false),
  );
});

describe("gpt-6 chat body", () => {
  const provider = new OpenAIProvider({ provider: "openai", apiKey: "k" }) as any;
  it("uses max_completion_tokens, drops sampling, sends effort", () => {
    const body = provider.buildRequestBody(
      { model: "gpt-6-luna", messages: [], maxTokens: 100, temperature: 0.2, topP: 0.5, reasoning: { effort: "max" } },
      false,
    );
    expect(body.max_completion_tokens).toBe(100);
    expect(body.max_tokens).toBeUndefined();
    expect(body.temperature).toBeUndefined();
    expect(body.top_p).toBeUndefined();
    expect(body.reasoning_effort).toBe("xhigh");
  });
  it("responses path clamps too", () => {
    const body = provider.buildResponsesBody({ model: "gpt-6", messages: [], reasoning: { effort: "max" } });
    expect(body.reasoning.effort).toBe("xhigh");
  });
});

describe("clampOpenAIEffort", () => {
  it("gpt5x: max->xhigh, minimal->low, others kept", () => {
    expect(clampOpenAIEffort("gpt-5.6-terra", "max")).toBe("xhigh");
    expect(clampOpenAIEffort("openai/gpt-6", "minimal")).toBe("low");
    expect(clampOpenAIEffort("gpt-6-luna", "xhigh")).toBe("xhigh");
    expect(clampOpenAIEffort("gpt-5.1", "none")).toBe("none");
  });
  it("gpt5base: xhigh/max->high, minimal kept", () => {
    for (const m of ["gpt-5", "gpt-5-mini", "gpt-5-nano", "gpt-5-codex"]) {
      expect(clampOpenAIEffort(m, "xhigh")).toBe("high");
      expect(clampOpenAIEffort(m, "max")).toBe("high");
      expect(clampOpenAIEffort(m, "minimal")).toBe("minimal");
      expect(clampOpenAIEffort(m, "none")).toBe("none");
    }
  });
  it("o-series / gpt-oss: xhigh/max->high", () => {
    for (const m of ["o3", "o4-mini", "openai/gpt-oss-120b"]) {
      expect(clampOpenAIEffort(m, "max")).toBe("high");
      expect(clampOpenAIEffort(m, "xhigh")).toBe("high");
    }
  });
  it("unknown and -chat models pass through", () => {
    expect(clampOpenAIEffort("gpt-6-chat", "max")).toBe("max");
    expect(clampOpenAIEffort(undefined, "xhigh")).toBe("xhigh");
  });
  it("applyOpenAIReasoning clamps with the body model", () => {
    const body: any = { model: "gpt-5-mini" };
    applyOpenAIReasoning(body, { effort: "max" }, "legacy_effort");
    expect(body.reasoning_effort).toBe("high");
  });
});

describe("Claude xhigh/max", () => {
  it("adaptive passes xhigh/max and maps minimal to low", () => {
    for (const [effort, want] of [["xhigh", "xhigh"], ["max", "max"], ["minimal", "low"]] as const) {
      const body: any = { model: "claude-opus-5-5", max_tokens: 1000 };
      applyAnthropicReasoning(body, { effort });
      expect(body.thinking.type).toBe("adaptive");
      expect(body.output_config.effort).toBe(want);
    }
  });
  it("bedrock adaptive passes max", () => {
    const body: any = { modelId: "global.anthropic.claude-sonnet-5-5" };
    applyBedrockReasoning(body, { effort: "max" });
    expect(body.additionalModelRequestFields.output_config.effort).toBe("max");
  });
  it("legacy budget models scale beyond high", () => {
    expect(ANTHROPIC_EFFORT_BUDGET.xhigh).toBeGreaterThan(ANTHROPIC_EFFORT_BUDGET.high);
    expect(ANTHROPIC_EFFORT_BUDGET.max).toBeGreaterThan(ANTHROPIC_EFFORT_BUDGET.xhigh);
    const body: any = { model: "claude-sonnet-4-5", max_tokens: 1000 };
    applyAnthropicReasoning(body, { effort: "max" });
    expect(body.thinking).toEqual({ type: "enabled", budget_tokens: ANTHROPIC_EFFORT_BUDGET.max });
    expect(body.max_tokens).toBeGreaterThan(ANTHROPIC_EFFORT_BUDGET.max);
    const br: any = { modelId: "anthropic.claude-sonnet-4-5" };
    applyBedrockReasoning(br, { effort: "xhigh" });
    expect(br.additionalModelRequestFields.thinking.budget_tokens).toBe(ANTHROPIC_EFFORT_BUDGET.xhigh);
  });
  it("gemini xhigh/max use the largest budget", () => {
    const gc: any = {};
    applyGeminiReasoning(gc, { effort: "max" });
    expect(gc.thinkingConfig.thinkingBudget).toBe(GEMINI_EFFORT_BUDGET.max);
    expect(GEMINI_EFFORT_BUDGET.xhigh).toBeGreaterThan(GEMINI_EFFORT_BUDGET.high);
  });
});
