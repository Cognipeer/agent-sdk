/**
 * Bedrock reasoning is Claude's: `additionalModelRequestFields.thinking` is Anthropic's
 * field. A model id that names another family (Nova, Llama, gpt-oss, Mistral, ...) gets
 * no reasoning fields at all, whatever `thinkingMode` says, and its own sampling
 * params are not stripped as if it were thinking. An id that hides the model (no id,
 * an application inference profile ARN) is treated as Claude, as before.
 */

import { describe, it, expect } from "vitest";
import { applyBedrockReasoning, ANTHROPIC_EFFORT_BUDGET } from "../../../src/providers/utils/reasoning.js";
import { bedrockModelFamily, isClaudeModelId, resolveModelRule } from "../../../src/models/rules.js";
import { BedrockProvider } from "../../../src/providers/bedrock.js";

// ─── helpers ─────────────────────────────────────────────────────────────────

/** Claude on Bedrock: bare ids, every geography prefix, ARNs. All of them are budget-style models. */
const CLAUDE = [
  "anthropic.claude-sonnet-4-20250514-v1:0",
  "anthropic.claude-v2:1",
  "anthropic.claude-3-haiku-20240307-v1:0",
  "us.anthropic.claude-sonnet-4-20250514-v1:0",
  "eu.anthropic.claude-haiku-4-5-20251001-v1:0",
  "apac.anthropic.claude-3-5-sonnet-20241022-v2:0",
  "jp.anthropic.claude-sonnet-4-5-20250929-v1:0",
  "au.anthropic.claude-sonnet-4-5-20250929-v1:0",
  "us-gov.anthropic.claude-3-5-sonnet-20240620-v1:0",
  // A geography prefix AWS added later (`in`), and one that does not exist yet: the vendor namespace is what counts.
  "in.anthropic.claude-sonnet-4-20250514-v1:0",
  "zz.anthropic.claude-sonnet-4-20250514-v1:0",
  "ANTHROPIC.CLAUDE-3-HAIKU-20240307-V1:0",
  "  us.anthropic.claude-3-haiku-20240307-v1:0  ",
  "arn:aws:bedrock:us-east-1::foundation-model/anthropic.claude-3-5-sonnet-20240620-v1:0",
  "arn:aws:bedrock:us-east-1:123456789012:inference-profile/us.anthropic.claude-sonnet-4-20250514-v1:0",
];

/** Every other family on Bedrock. */
const OTHER = [
  "amazon.nova-pro-v1:0",
  "us.amazon.nova-lite-v1:0",
  "amazon.titan-text-premier-v1:0",
  "meta.llama3-70b-instruct-v1:0",
  "us.meta.llama3-3-70b-instruct-v1:0",
  "mistral.mistral-large-2407-v1:0",
  "openai.gpt-oss-120b-1:0",
  "cohere.command-r-plus-v1:0",
  "ai21.jamba-1-5-large-v1:0",
  "us.deepseek.r1-v1:0",
  "qwen.qwen3-32b-v1:0",
  "arn:aws:bedrock:us-east-1:123456789012:inference-profile/eu.amazon.nova-pro-v1:0",
  "arn:aws:bedrock:us-east-1::foundation-model/meta.llama3-70b-instruct-v1:0",
];

const OPAQUE_ARNS = [
  "arn:aws:bedrock:us-east-1:123456789012:application-inference-profile/a1b2c3d4e5f6",
  "arn:aws:bedrock:us-east-1:123456789012:provisioned-model/a1b2c3d4e5f6",
];
/** Ids that do not say which model they are. */
const UNKNOWN: Array<string | undefined> = [undefined, "", "   ", ...OPAQUE_ARNS];

const CONVERSE_OK = {
  output: { message: { role: "assistant", content: [{ text: "ok" }] } },
  stopReason: "end_turn",
  usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
};

/** A fake fetch that records every Converse body. */
function recorder() {
  const calls: Array<{ url: string; body: any }> = [];
  const fn = (async (url: any, init: any) => {
    calls.push({ url: String(url), body: JSON.parse(init.body) });
    return new Response(JSON.stringify(CONVERSE_OK), { status: 200, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
  return { fn, calls };
}
const bedrock = (fn: typeof fetch, extra: Record<string, any> = {}) =>
  new BedrockProvider({ provider: "bedrock", region: "us-east-1", accessKeyId: "AK", secretAccessKey: "SK", fetch: fn, retry: { maxRetries: 0 }, ...extra } as any);

const msgs = [{ role: "user" as const, content: "hi" }];

// ─── classification ──────────────────────────────────────────────────────────

describe("isClaudeModelId", () => {
  it.each([
    ...CLAUDE,
    // Not Bedrock-shaped, but Claude: a direct API id, a gateway id, a Vertex path.
    "claude-sonnet-5-5",
    "claude-3-7-sonnet-20250219",
    "anthropic/claude-haiku-5-5",
    "publishers/anthropic/models/claude-opus-5-5",
  ])("%s is Claude", (id) => {
    expect(isClaudeModelId(id)).toBe(true);
  });

  it.each([...OTHER, ...UNKNOWN])("%s is not (the id does not name Claude)", (id) => {
    expect(isClaudeModelId(id)).toBe(false);
  });
});

describe("bedrockModelFamily", () => {
  it.each(CLAUDE)("%s -> claude", (id) => {
    expect(bedrockModelFamily(id)).toBe("claude");
  });

  it.each(OTHER)("%s -> other", (id) => {
    expect(bedrockModelFamily(id)).toBe("other");
  });

  it.each(UNKNOWN)("%s -> unknown", (id) => {
    expect(bedrockModelFamily(id)).toBe("unknown");
  });
});

// ─── rule resolution ─────────────────────────────────────────────────────────

describe("resolveModelRule for Bedrock", () => {
  const rule = (model?: string) => resolveModelRule({ provider: "bedrock", model });

  it.each([
    "amazon.nova-pro-v1:0",
    "us.amazon.nova-lite-v1:0",
    "amazon.titan-text-premier-v1:0",
    "meta.llama3-70b-instruct-v1:0",
    "mistral.mistral-large-2407-v1:0",
    "cohere.command-r-plus-v1:0",
    "us.deepseek.r1-v1:0",
  ])("%s has no rule of its own and takes the generic default, not Claude's", (model) => {
    const r = rule(model);
    expect(r.matchedRuleId).toBe("other-default");
    expect(r.isDefault).toBe(true);
    // Claude's default would say temperature is restricted while thinking.
    expect(r.sampling.temperature).toBe("any");
    expect(r.reasoning.style).toBe("effort");
  });

  it("a non-Claude model with a rule keeps it (gpt-oss)", () => {
    const r = rule("openai.gpt-oss-120b-1:0");
    expect(r.matchedRuleId).toBe("openai-gpt-oss");
    expect(r.isDefault).toBe(false);
  });

  it.each([
    // A Claude no rule knows yet.
    "us.anthropic.claude-unreleased-9-v1:0",
    // Ids that do not say which model they are.
    ...OPAQUE_ARNS,
    undefined,
  ])("%s falls back to the Anthropic default, as before", (model) => {
    const r = rule(model);
    expect(r.matchedRuleId).toBe("anthropic-default");
    expect(r.isDefault).toBe(true);
  });

  it("a Claude with a rule keeps it", () => {
    expect(rule("us.anthropic.claude-sonnet-5-5-20260101-v1:0").matchedRuleId).toBe("claude-sonnet-5");
    expect(rule("anthropic.claude-3-7-sonnet-20250219-v1:0").matchedRuleId).toBe("claude-legacy-budget");
  });
});

// ─── the mapper ──────────────────────────────────────────────────────────────

describe("applyBedrockReasoning on a model that is not Claude", () => {
  const ASKS: Array<[string, any]> = [
    ["an effort", { effort: "high" }],
    ["effort none", { effort: "none" }],
    ["a budget", { budgetTokens: 4000 }],
    ["includeThoughts", { includeThoughts: true }],
    ["everything", { effort: "high", budgetTokens: 4000, includeThoughts: true, providerExtras: { display: "summarized" } }],
  ];

  it.each(OTHER)("%s: no reasoning fields, and the inference config is untouched", (modelId) => {
    for (const [name, reasoning] of ASKS) {
      const body: any = { modelId, inferenceConfig: { maxTokens: 500, temperature: 0.4, topP: 0.9 } };
      applyBedrockReasoning(body, reasoning);
      expect(body, `${modelId} / ${name}`).toEqual({ modelId, inferenceConfig: { maxTokens: 500, temperature: 0.4, topP: 0.9 } });
    }
  });

  it("creates no inferenceConfig (a Claude thinking budget would need one)", () => {
    const body: any = { modelId: "amazon.nova-pro-v1:0" };
    applyBedrockReasoning(body, { effort: "high" });
    expect(body).toEqual({ modelId: "amazon.nova-pro-v1:0" });
  });

  it("thinkingMode does not change that: it is a setting about Claude models", () => {
    for (const mode of ["auto", "budget", "adaptive"] as const) {
      const body: any = { modelId: "meta.llama3-70b-instruct-v1:0", inferenceConfig: { maxTokens: 500 } };
      applyBedrockReasoning(body, { effort: "high" }, { mode });
      expect(body.additionalModelRequestFields, mode).toBeUndefined();
      expect(body.inferenceConfig, mode).toEqual({ maxTokens: 500 });
    }
  });

  it("the model can come from the options instead of body.modelId", () => {
    const body: any = { inferenceConfig: { maxTokens: 500, temperature: 0.4 } };
    applyBedrockReasoning(body, { effort: "high" }, { model: "amazon.nova-pro-v1:0" });
    expect(body).toEqual({ inferenceConfig: { maxTokens: 500, temperature: 0.4 } });
  });

  it("fields that came in through request.extra stay as they are", () => {
    const body: any = { modelId: "amazon.nova-pro-v1:0", additionalModelRequestFields: { top_k: 40 } };
    applyBedrockReasoning(body, { effort: "high" });
    expect(body.additionalModelRequestFields).toEqual({ top_k: 40 });
  });

  it("no reasoning config: nothing changes either", () => {
    const body: any = { modelId: "amazon.nova-pro-v1:0", inferenceConfig: { temperature: 0.4 } };
    applyBedrockReasoning(body, undefined);
    expect(body).toEqual({ modelId: "amazon.nova-pro-v1:0", inferenceConfig: { temperature: 0.4 } });
  });
});

describe("applyBedrockReasoning on Claude ids", () => {
  it.each(CLAUDE)("%s still gets thinking, and loses the sampling params thinking forbids", (modelId) => {
    const body: any = { modelId, inferenceConfig: { temperature: 0.4 } };
    applyBedrockReasoning(body, { effort: "high" });
    expect(body.additionalModelRequestFields.thinking).toEqual({ type: "enabled", budget_tokens: ANTHROPIC_EFFORT_BUDGET.high });
    expect(body.inferenceConfig.temperature).toBeUndefined();
    expect(body.inferenceConfig.maxTokens).toBe(ANTHROPIC_EFFORT_BUDGET.high + 1024);
  });

  it("a Claude 5.x profile gets the adaptive form", () => {
    const body: any = { modelId: "us.anthropic.claude-opus-5-v1:0" };
    applyBedrockReasoning(body, { effort: "high" });
    expect(body.additionalModelRequestFields).toEqual({
      thinking: { type: "adaptive", display: "summarized" },
      output_config: { effort: "high" },
    });
  });

  it("no id and an opaque ARN are treated as Claude, as before", () => {
    for (const body of [{}, { modelId: OPAQUE_ARNS[0] }, { modelId: OPAQUE_ARNS[1] }] as any[]) {
      applyBedrockReasoning(body, { effort: "low" });
      expect(body.additionalModelRequestFields.thinking).toEqual({ type: "enabled", budget_tokens: ANTHROPIC_EFFORT_BUDGET.low });
      expect(body.inferenceConfig.maxTokens).toBeGreaterThan(0);
    }
  });
});

// ─── through the provider ────────────────────────────────────────────────────

describe("BedrockProvider", () => {
  const request = { messages: msgs, maxTokens: 300, temperature: 0.4, topP: 0.9, reasoning: { effort: "high" as const, includeThoughts: true } };

  it("a Nova model keeps its sampling params and gets no additionalModelRequestFields", async () => {
    const { fn, calls } = recorder();
    await bedrock(fn).complete({ ...request, model: "amazon.nova-pro-v1:0" });
    expect(calls[0].body.inferenceConfig).toEqual({ maxTokens: 300, temperature: 0.4, topP: 0.9 });
    expect(calls[0].body.additionalModelRequestFields).toBeUndefined();
  });

  it("a Llama model through a cross-region profile is the same", async () => {
    const { fn, calls } = recorder();
    await bedrock(fn).complete({ ...request, model: "us.meta.llama3-3-70b-instruct-v1:0" });
    expect(calls[0].body.inferenceConfig).toEqual({ maxTokens: 300, temperature: 0.4, topP: 0.9 });
    expect(calls[0].body.additionalModelRequestFields).toBeUndefined();
  });

  it("gpt-oss gets no reasoning field invented for it", async () => {
    const { fn, calls } = recorder();
    await bedrock(fn).complete({ ...request, model: "openai.gpt-oss-120b-1:0" });
    expect(calls[0].body.additionalModelRequestFields).toBeUndefined();
    expect(JSON.stringify(calls[0].body)).not.toContain("reasoning");
    expect(calls[0].body.inferenceConfig.temperature).toBe(0.4);
  });

  it("thinkingMode 'adaptive' in the config does not make a non-Claude model think", async () => {
    const { fn, calls } = recorder();
    await bedrock(fn, { thinkingMode: "adaptive" }).complete({ ...request, model: "amazon.nova-pro-v1:0" });
    expect(calls[0].body.additionalModelRequestFields).toBeUndefined();
  });

  it("the same request on a Claude model gets thinking, a raised cap and no temperature", async () => {
    const { fn, calls } = recorder();
    await bedrock(fn).complete({ ...request, model: "anthropic.claude-sonnet-4-20250514-v1:0" });
    expect(calls[0].body.additionalModelRequestFields.thinking.type).toBe("enabled");
    expect(calls[0].body.inferenceConfig.temperature).toBeUndefined();
    expect(calls[0].body.inferenceConfig.maxTokens).toBe(ANTHROPIC_EFFORT_BUDGET.high + 1024);
  });

  it("a Claude profile behind a new geography prefix gets thinking too", async () => {
    const { fn, calls } = recorder();
    await bedrock(fn).complete({ ...request, model: "in.anthropic.claude-sonnet-4-20250514-v1:0" });
    expect(calls[0].body.additionalModelRequestFields.thinking.type).toBe("enabled");
    expect(calls[0].body.inferenceConfig.temperature).toBeUndefined();
  });

  it("request.extra still reaches a non-Claude model", async () => {
    const { fn, calls } = recorder();
    await bedrock(fn).complete({ model: "meta.llama3-70b-instruct-v1:0", messages: msgs, extra: { top_k: 40 }, reasoning: { effort: "high" } });
    expect(calls[0].body.additionalModelRequestFields).toEqual({ top_k: 40 });
  });
});
