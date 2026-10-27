/**
 * Claude models that think by default (the 5.x family: Haiku, Sonnet, Opus, Fable and
 * Mythos) return the thinking text empty unless `display` is asked for. Their rules
 * carry `reasoning.defaultOn`, and `includeThoughts: true` with no effort and no
 * budget then sends `thinking: { type: "adaptive", display: "summarized" }` alone:
 * thinking stays at the model's own default, so there is no `output_config` and no
 * `max_tokens` raise. Every other model is unchanged.
 */

import { describe, it, expect, afterEach } from "vitest";
import {
  applyAnthropicReasoning,
  applyBedrockReasoning,
  ANTHROPIC_ADAPTIVE_MAX_TOKENS,
} from "../../../src/providers/utils/reasoning.js";
import { MODEL_RULES, resolveModelRule, rememberModelRulePatch, clearLearnedModelRules } from "../../../src/models/rules.js";
import { AnthropicProvider } from "../../../src/providers/anthropic.js";
import { BedrockProvider } from "../../../src/providers/bedrock.js";
import { VertexProvider } from "../../../src/providers/vertex.js";

// ─── helpers ─────────────────────────────────────────────────────────────────

const SUMMARIZED = { type: "adaptive", display: "summarized" };

/** Claude ids that think by default. */
const DEFAULT_ON = [
  "claude-haiku-5",
  "claude-haiku-5-5",
  "claude-sonnet-5",
  "claude-sonnet-5-5",
  "claude-opus-5",
  "claude-opus-5-5",
  "claude-fable-5",
  "claude-fable-5-1",
  "claude-mythos-5",
  "claude-mythos-5-1",
];
/** The same family as Bedrock ids and cross-region profiles. */
const BEDROCK_DEFAULT_ON = [
  "anthropic.claude-haiku-5-5-v1:0",
  "anthropic.claude-sonnet-5-5-v1:0",
  "us.anthropic.claude-opus-5-v1:0",
  "eu.anthropic.claude-fable-5-1-v1:0",
  "global.anthropic.claude-mythos-5-v1:0",
];
/** Claude models where thinking is opt-in: `includeThoughts` alone must send nothing. */
const OPT_IN = [
  "claude-opus-4-8",
  "claude-opus-4-7",
  "claude-sonnet-4-6",
  "claude-sonnet-4-5",
  "claude-haiku-4-5",
  "claude-3-7-sonnet-20250219",
  "claude-mythos-preview",
];
const BEDROCK_OPT_IN = [
  "anthropic.claude-sonnet-4-20250514-v1:0",
  "us.anthropic.claude-opus-4-1-20250805-v1:0",
  "anthropic.claude-3-7-sonnet-20250219-v1:0",
];

const json = (o: any, status = 200) => new Response(JSON.stringify(o), { status, headers: { "content-type": "application/json" } });
const sse = (events: Array<[string, any]>) =>
  new Response(events.map(([name, data]) => `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`).join(""), {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });

const MESSAGE_OK = {
  id: "msg_1",
  type: "message",
  model: "claude-sonnet-5-5",
  content: [{ type: "text", text: "hello" }],
  stop_reason: "end_turn",
  usage: { input_tokens: 1, output_tokens: 1 },
};
const MESSAGE_STREAM: Array<[string, any]> = [
  ["message_start", { type: "message_start", message: { id: "msg_s", model: "claude-sonnet-5-5", usage: { input_tokens: 10, output_tokens: 1 } } }],
  ["content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }],
  ["content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hi" } }],
  ["content_block_stop", { type: "content_block_stop", index: 0 }],
  ["message_delta", { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 2 } }],
  ["message_stop", { type: "message_stop" }],
];
const CONVERSE_OK = {
  output: { message: { role: "assistant", content: [{ text: "ok" }] } },
  stopReason: "end_turn",
  usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
};

/** A fake fetch that records every request body. */
function recorder(reply: () => Response) {
  const calls: Array<{ url: string; body: any }> = [];
  const fn = (async (url: any, init: any) => {
    calls.push({ url: String(url), body: JSON.parse(init.body) });
    return reply();
  }) as unknown as typeof fetch;
  return { fn, calls };
}

const msgs = [{ role: "user" as const, content: "hi" }];
const anthropic = (fn: typeof fetch, extra: Record<string, any> = {}) =>
  new AnthropicProvider({ provider: "anthropic", apiKey: "k", fetch: fn, retry: { maxRetries: 0 }, ...extra } as any);
const bedrock = (fn: typeof fetch, extra: Record<string, any> = {}) =>
  new BedrockProvider({ provider: "bedrock", region: "us-east-1", accessKeyId: "AK", secretAccessKey: "SK", fetch: fn, retry: { maxRetries: 0 }, ...extra } as any);
const vertex = (fn: typeof fetch) => new VertexProvider({ provider: "vertex", projectId: "proj", accessToken: "tok", fetch: fn, retry: { maxRetries: 0 } } as any);

afterEach(() => {
  clearLearnedModelRules();
});

// ─── the rule flag ───────────────────────────────────────────────────────────

describe("reasoning.defaultOn in model-rules.json", () => {
  it("is set on the Claude 5.x rules and nowhere else", () => {
    const flagged = MODEL_RULES.rules.filter((r) => r.reasoning.defaultOn).map((r) => r.id).sort();
    expect(flagged).toEqual(["claude-fable", "claude-haiku-5", "claude-opus-5", "claude-sonnet-5"]);
  });

  it("only sits on adaptive Anthropic rules (the flag is about the adaptive form)", () => {
    for (const r of MODEL_RULES.rules.filter((x) => x.reasoning.defaultOn)) {
      expect(r.family, r.id).toBe("anthropic");
      expect(r.reasoning.style, r.id).toBe("adaptive");
    }
  });

  it.each(DEFAULT_ON)("%s resolves to a default-on rule", (model) => {
    expect(resolveModelRule({ provider: "anthropic", model }).reasoning.defaultOn).toBe(true);
  });

  it.each(BEDROCK_DEFAULT_ON)("%s (Bedrock) resolves to a default-on rule", (model) => {
    expect(resolveModelRule({ provider: "bedrock", model }).reasoning.defaultOn).toBe(true);
  });

  it.each(OPT_IN)("%s does not", (model) => {
    expect(resolveModelRule({ provider: "anthropic", model }).reasoning.defaultOn).toBeFalsy();
  });

  it("the Fable rule covers Mythos 5 and 5.1; Mythos Preview has its own rule", () => {
    expect(resolveModelRule({ provider: "anthropic", model: "claude-mythos-5-1" }).matchedRuleId).toBe("claude-fable");
    expect(resolveModelRule({ provider: "anthropic", model: "claude-mythos-preview" }).matchedRuleId).toBe("claude-mythos-preview");
  });
});

// ─── the mapper, Messages API ────────────────────────────────────────────────

describe("applyAnthropicReasoning: includeThoughts alone", () => {
  it.each(DEFAULT_ON)("%s asks for a summarized display and nothing else", (model) => {
    const body: any = { model, max_tokens: 4096 };
    applyAnthropicReasoning(body, { includeThoughts: true }, { defaultedMaxTokens: true });
    expect(body.thinking).toEqual(SUMMARIZED);
    expect(body.output_config).toBeUndefined();
    expect(body.max_tokens).toBe(4096);
  });

  it("the max_tokens the provider defaulted is not raised (an effort would raise it)", () => {
    const withEffort: any = { model: "claude-sonnet-5-5", max_tokens: 4096 };
    applyAnthropicReasoning(withEffort, { effort: "high" }, { defaultedMaxTokens: true });
    expect(withEffort.output_config).toEqual({ effort: "high" });
    expect(withEffort.max_tokens).toBe(ANTHROPIC_ADAPTIVE_MAX_TOKENS.high);

    const thoughtsOnly: any = { model: "claude-sonnet-5-5", max_tokens: 4096 };
    applyAnthropicReasoning(thoughtsOnly, { includeThoughts: true }, { defaultedMaxTokens: true });
    expect(thoughtsOnly.max_tokens).toBe(4096);
  });

  it("still drops the sampling params Claude 5.x does not take", () => {
    const body: any = { model: "claude-opus-5-5", temperature: 0.4, top_p: 0.9, top_k: 5 };
    applyAnthropicReasoning(body, { includeThoughts: true });
    expect(body.temperature).toBeUndefined();
    expect(body.top_p).toBeUndefined();
    expect(body.top_k).toBeUndefined();
    expect(body.thinking).toEqual(SUMMARIZED);
  });

  it("providerExtras ride on the thinking block, so a caller can still choose another display", () => {
    const body: any = { model: "claude-sonnet-5-5" };
    applyAnthropicReasoning(body, { includeThoughts: true, providerExtras: { display: "omitted" } });
    expect(body.thinking).toEqual({ type: "adaptive", display: "omitted" });
  });

  it.each([
    ["includeThoughts: false", { includeThoughts: false }],
    ["an empty config", {}],
    ["providerExtras without includeThoughts", { providerExtras: { display: "summarized" } }],
  ])("%s sends nothing", (_name, reasoning) => {
    const body: any = { model: "claude-sonnet-5-5", max_tokens: 4096 };
    applyAnthropicReasoning(body, reasoning as any);
    expect(body.thinking).toBeUndefined();
    expect(body.output_config).toBeUndefined();
    expect(body.max_tokens).toBe(4096);
  });
});

describe("applyAnthropicReasoning: an explicit request still wins over includeThoughts", () => {
  it("an effort goes through the effort path (output_config, raised default max_tokens)", () => {
    const body: any = { model: "claude-opus-5-5", max_tokens: 4096 };
    applyAnthropicReasoning(body, { effort: "medium", includeThoughts: true }, { defaultedMaxTokens: true });
    expect(body.thinking).toEqual(SUMMARIZED);
    expect(body.output_config).toEqual({ effort: "medium" });
    expect(body.max_tokens).toBe(ANTHROPIC_ADAPTIVE_MAX_TOKENS.medium);
  });

  it("a token budget picks an effort, as before", () => {
    const body: any = { model: "claude-opus-5-5" };
    applyAnthropicReasoning(body, { budgetTokens: 4000, includeThoughts: true });
    expect(body.thinking).toEqual(SUMMARIZED);
    expect(body.output_config).toEqual({ effort: "medium" });
  });

  it("effort none uses the model's off mechanism, not the summarized display", () => {
    const body: any = { model: "claude-haiku-5-5" };
    applyAnthropicReasoning(body, { effort: "none", includeThoughts: true });
    expect(body.thinking).toEqual({ type: "disabled" });
    expect(body.output_config).toBeUndefined();
  });
});

describe("applyAnthropicReasoning: models where thinking is opt-in", () => {
  it.each(OPT_IN)("%s: includeThoughts alone sends nothing", (model) => {
    const body: any = { model, max_tokens: 4096, temperature: 0.4 };
    applyAnthropicReasoning(body, { includeThoughts: true }, { defaultedMaxTokens: true });
    expect(body).toEqual({ model, max_tokens: 4096, temperature: 0.4 });
  });

  it("a model the rules do not know, or no model at all, sends nothing", () => {
    for (const body of [{ model: "my-finetune" }, {}] as any[]) {
      applyAnthropicReasoning(body, { includeThoughts: true });
      expect(body.thinking).toBeUndefined();
      expect(body.output_config).toBeUndefined();
    }
  });
});

describe("applyAnthropicReasoning: thinkingMode", () => {
  it("'budget' keeps the budget form: with no effort and no budget there is nothing to send", () => {
    const body: any = { model: "claude-sonnet-5-5", max_tokens: 4096 };
    applyAnthropicReasoning(body, { includeThoughts: true }, { mode: "budget" });
    expect(body.thinking).toBeUndefined();
    expect(body.max_tokens).toBe(4096);
  });

  it("'adaptive' on a model that is not default-on sends nothing either", () => {
    const body: any = { model: "claude-sonnet-4-5", max_tokens: 4096 };
    applyAnthropicReasoning(body, { includeThoughts: true }, { mode: "adaptive" });
    expect(body.thinking).toBeUndefined();
  });

  it("'adaptive' on a default-on model is the same as auto", () => {
    const body: any = { model: "claude-sonnet-5-5" };
    applyAnthropicReasoning(body, { includeThoughts: true }, { mode: "adaptive" });
    expect(body.thinking).toEqual(SUMMARIZED);
  });
});

describe("the flag is data: a learned patch can turn it off, or on", () => {
  it("defaultOn: false stops the summarized display for that model", () => {
    rememberModelRulePatch("anthropic", "claude-sonnet-5-5", { reasoning: { defaultOn: false } });
    const body: any = { model: "claude-sonnet-5-5" };
    applyAnthropicReasoning(body, { includeThoughts: true });
    expect(body.thinking).toBeUndefined();
    // Another model of the family is not affected.
    const other: any = { model: "claude-opus-5-5" };
    applyAnthropicReasoning(other, { includeThoughts: true });
    expect(other.thinking).toEqual(SUMMARIZED);
  });

  it("defaultOn: true on an adaptive model that is not flagged turns it on", () => {
    rememberModelRulePatch("anthropic", "claude-opus-4-7", { reasoning: { defaultOn: true } });
    const body: any = { model: "claude-opus-4-7" };
    applyAnthropicReasoning(body, { includeThoughts: true });
    expect(body.thinking).toEqual(SUMMARIZED);
  });
});

// ─── the mapper, Bedrock Converse ────────────────────────────────────────────

describe("applyBedrockReasoning: includeThoughts alone", () => {
  it.each(BEDROCK_DEFAULT_ON)("%s asks for a summarized display and nothing else", (modelId) => {
    const body: any = { modelId, inferenceConfig: { maxTokens: 2000, temperature: 0.4, topP: 0.9 } };
    applyBedrockReasoning(body, { includeThoughts: true });
    expect(body.additionalModelRequestFields).toEqual({ thinking: SUMMARIZED });
    // No output_config; the caller's cap stands, and the sampling params the model rejects are gone.
    expect(body.inferenceConfig).toEqual({ maxTokens: 2000 });
  });

  it("keeps fields that came in through request.extra", () => {
    const body: any = { modelId: "anthropic.claude-sonnet-5-5-v1:0", additionalModelRequestFields: { top_k: 40 } };
    applyBedrockReasoning(body, { includeThoughts: true });
    expect(body.additionalModelRequestFields).toEqual({ top_k: 40, thinking: SUMMARIZED });
  });

  it("an effort still takes the effort path", () => {
    const body: any = { modelId: "anthropic.claude-sonnet-5-5-v1:0", inferenceConfig: { maxTokens: 2000 } };
    applyBedrockReasoning(body, { effort: "high", includeThoughts: true });
    expect(body.additionalModelRequestFields).toEqual({ thinking: SUMMARIZED, output_config: { effort: "high" } });
    expect(body.inferenceConfig.maxTokens).toBe(2000);
  });

  it.each(BEDROCK_OPT_IN)("%s: thinking is opt-in, so nothing is sent", (modelId) => {
    const body: any = { modelId, inferenceConfig: { maxTokens: 500, temperature: 0.4 } };
    applyBedrockReasoning(body, { includeThoughts: true });
    expect(body).toEqual({ modelId, inferenceConfig: { maxTokens: 500, temperature: 0.4 } });
  });

  it.each([
    ["includeThoughts: false", { includeThoughts: false }],
    ["an empty config", {}],
  ])("%s sends nothing", (_name, reasoning) => {
    const body: any = { modelId: "anthropic.claude-sonnet-5-5-v1:0" };
    applyBedrockReasoning(body, reasoning as any);
    expect(body.additionalModelRequestFields).toBeUndefined();
  });

  it("thinkingMode 'budget' sends nothing without an effort or a budget", () => {
    const body: any = { modelId: "anthropic.claude-sonnet-5-5-v1:0" };
    applyBedrockReasoning(body, { includeThoughts: true }, { mode: "budget" });
    expect(body.additionalModelRequestFields).toBeUndefined();
  });
});

// ─── through the providers ───────────────────────────────────────────────────

describe("AnthropicProvider", () => {
  it("sends the summarized display with the provider's own max_tokens and no output_config", async () => {
    const { fn, calls } = recorder(() => json(MESSAGE_OK));
    await anthropic(fn).complete({ model: "claude-sonnet-5-5", messages: msgs, reasoning: { includeThoughts: true } });
    expect(calls[0].body.thinking).toEqual(SUMMARIZED);
    expect(calls[0].body.output_config).toBeUndefined();
    // The adaptive default, not an effort's floor.
    expect(calls[0].body.max_tokens).toBe(16384);
  });

  it("an effort in the same request still raises the default, so the two paths stay apart", async () => {
    const { fn, calls } = recorder(() => json(MESSAGE_OK));
    await anthropic(fn).complete({ model: "claude-sonnet-5-5", messages: msgs, reasoning: { effort: "high", includeThoughts: true } });
    expect(calls[0].body.output_config).toEqual({ effort: "high" });
    expect(calls[0].body.max_tokens).toBe(ANTHROPIC_ADAPTIVE_MAX_TOKENS.high);
  });

  it("a caller's own maxTokens is a hard cap and stays", async () => {
    const { fn, calls } = recorder(() => json(MESSAGE_OK));
    await anthropic(fn).complete({ model: "claude-sonnet-5-5", messages: msgs, maxTokens: 2000, reasoning: { includeThoughts: true } });
    expect(calls[0].body.thinking).toEqual(SUMMARIZED);
    expect(calls[0].body.max_tokens).toBe(2000);
  });

  it("streams the same body", async () => {
    const { fn, calls } = recorder(() => sse(MESSAGE_STREAM));
    for await (const _ of anthropic(fn).completeStream({ model: "claude-opus-5-5", messages: msgs, reasoning: { includeThoughts: true } })) void _;
    expect(calls[0].body.stream).toBe(true);
    expect(calls[0].body.thinking).toEqual(SUMMARIZED);
    expect(calls[0].body.output_config).toBeUndefined();
  });

  it("an explicit extra.thinking is the caller's final word", async () => {
    const { fn, calls } = recorder(() => json(MESSAGE_OK));
    await anthropic(fn).complete({
      model: "claude-sonnet-5-5",
      messages: msgs,
      reasoning: { includeThoughts: true },
      extra: { thinking: { type: "adaptive" } },
    });
    expect(calls[0].body.thinking).toEqual({ type: "adaptive" });
  });

  it("a model where thinking is opt-in gets no thinking block", async () => {
    const { fn, calls } = recorder(() => json(MESSAGE_OK));
    await anthropic(fn).complete({ model: "claude-sonnet-4-5", messages: msgs, reasoning: { includeThoughts: true } });
    expect(calls[0].body.thinking).toBeUndefined();
    expect(calls[0].body.max_tokens).toBe(4096);
  });

  it("thinkingMode 'budget' in the config sends nothing for includeThoughts alone", async () => {
    const { fn, calls } = recorder(() => json(MESSAGE_OK));
    await anthropic(fn, { thinkingMode: "budget" }).complete({ model: "claude-sonnet-5-5", messages: msgs, reasoning: { includeThoughts: true } });
    expect(calls[0].body.thinking).toBeUndefined();
  });

  it("a learned defaultOn: false is honoured by the provider", async () => {
    rememberModelRulePatch("anthropic", "claude-sonnet-5-5", { reasoning: { defaultOn: false } });
    const { fn, calls } = recorder(() => json(MESSAGE_OK));
    await anthropic(fn).complete({ model: "claude-sonnet-5-5", messages: msgs, reasoning: { includeThoughts: true } });
    expect(calls[0].body.thinking).toBeUndefined();
  });
});

describe("Claude on Vertex AI", () => {
  it("sends the summarized display in the rawPredict body", async () => {
    const { fn, calls } = recorder(() => json(MESSAGE_OK));
    await vertex(fn).complete({ model: "claude-sonnet-5-5", messages: msgs, reasoning: { includeThoughts: true } });
    expect(calls[0].url).toContain("/publishers/anthropic/models/claude-sonnet-5-5:rawPredict");
    expect(calls[0].body.thinking).toEqual(SUMMARIZED);
    expect(calls[0].body.output_config).toBeUndefined();
    expect(calls[0].body.model).toBeUndefined();
  });

  it("a Claude model where thinking is opt-in gets nothing", async () => {
    const { fn, calls } = recorder(() => json(MESSAGE_OK));
    await vertex(fn).complete({ model: "claude-sonnet-4-5", messages: msgs, reasoning: { includeThoughts: true } });
    expect(calls[0].body.thinking).toBeUndefined();
  });
});

describe("BedrockProvider", () => {
  it("sends the summarized display in additionalModelRequestFields and drops sampling", async () => {
    const { fn, calls } = recorder(() => json(CONVERSE_OK));
    await bedrock(fn).complete({ model: "anthropic.claude-sonnet-5-5-v1:0", messages: msgs, temperature: 0.3, reasoning: { includeThoughts: true } });
    expect(calls[0].body.additionalModelRequestFields).toEqual({ thinking: SUMMARIZED });
    expect(calls[0].body.inferenceConfig?.temperature).toBeUndefined();
  });

  it("works for a cross-region profile id", async () => {
    const { fn, calls } = recorder(() => json(CONVERSE_OK));
    await bedrock(fn).complete({ model: "us.anthropic.claude-opus-5-v1:0", messages: msgs, reasoning: { includeThoughts: true } });
    expect(calls[0].body.additionalModelRequestFields).toEqual({ thinking: SUMMARIZED });
  });

  it("a Claude model where thinking is opt-in gets nothing", async () => {
    const { fn, calls } = recorder(() => json(CONVERSE_OK));
    await bedrock(fn).complete({ model: "anthropic.claude-sonnet-4-20250514-v1:0", messages: msgs, temperature: 0.3, reasoning: { includeThoughts: true } });
    expect(calls[0].body.additionalModelRequestFields).toBeUndefined();
    expect(calls[0].body.inferenceConfig.temperature).toBe(0.3);
  });
});
