/**
 * Request building from the rules: what each provider puts on the wire for the
 * verified model families.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { OpenAIProvider } from "../../../src/providers/openai.js";
import { AzureProvider } from "../../../src/providers/azure.js";
import { AnthropicProvider } from "../../../src/providers/anthropic.js";
import { BedrockProvider } from "../../../src/providers/bedrock.js";
import { applyOpenAIReasoning, applyAnthropicReasoning, applyBedrockReasoning, applyGeminiReasoning, ANTHROPIC_EFFORT_BUDGET, GEMINI_EFFORT_BUDGET } from "../../../src/providers/utils/reasoning.js";
import { clearLearnedModelRules } from "../../../src/models/index.js";

beforeEach(() => clearLearnedModelRules());

const tool = { name: "lookup", description: "d", parameters: { type: "object", properties: {} } };
const chat = new OpenAIProvider({ provider: "openai", apiKey: "k", api: "chat" }) as any;
const auto = new OpenAIProvider({ provider: "openai", apiKey: "k" }) as any;

describe("gpt-6 / gpt-5.x wire", () => {
  it("gpt-6-luna chat: max_completion_tokens, no sampling, effort mapped to the chat list", () => {
    const body = chat.buildRequestBody(
      { model: "gpt-6-luna", messages: [], maxTokens: 100, temperature: 0.2, topP: 0.5, presencePenalty: 0.1, logprobs: true, reasoning: { effort: "max" } },
      false,
    );
    expect(body.max_completion_tokens).toBe(100);
    expect(body.max_tokens).toBeUndefined();
    for (const k of ["temperature", "top_p", "presence_penalty", "logprobs"]) expect(body[k], k).toBeUndefined();
    expect(body.reasoning_effort).toBe("xhigh");
  });
  it("responses path keeps max (verified: /v1/responses takes it)", () => {
    const body = auto.buildResponsesBody({ model: "gpt-6", messages: [], reasoning: { effort: "max" } });
    expect(body.reasoning.effort).toBe("max");
    const minimal = auto.buildResponsesBody({ model: "gpt-6", messages: [], reasoning: { effort: "minimal" } });
    expect(minimal.reasoning.effort).toBe("low");
  });
  it("function tools on chat send reasoning_effort none, whatever was asked", () => {
    for (const model of ["gpt-6-luna", "gpt-5.6-terra"]) {
      const withTools = chat.buildRequestBody({ model, messages: [], tools: [tool], reasoning: { effort: "high" } }, false);
      expect(withTools.reasoning_effort, model).toBe("none");
      const viaExtra = chat.buildRequestBody({ model, messages: [], tools: [tool], extra: { reasoning_effort: "medium" } }, false);
      expect(viaExtra.reasoning_effort, model).toBe("none");
      const noTools = chat.buildRequestBody({ model, messages: [], reasoning: { effort: "high" } }, false);
      expect(noTools.reasoning_effort, model).toBe("high");
    }
  });
  it("auto routing sends reasoning gpt-6 requests (with tools) to /responses", async () => {
    expect(auto.useResponsesApi({ model: "gpt-6-luna", messages: [], tools: [tool], reasoning: { effort: "high" } })).toBe(true);
    expect(auto.useResponsesApi({ model: "gpt-4o", messages: [], reasoning: { effort: "high" } })).toBe(false);
  });
  it("gpt-5 base keeps minimal and clamps xhigh; o-series clamps; reasoning dropped for gpt-4o", () => {
    expect(chat.buildRequestBody({ model: "gpt-5-mini", messages: [], reasoning: { effort: "xhigh" } }, false).reasoning_effort).toBe("high");
    expect(chat.buildRequestBody({ model: "gpt-5-mini", messages: [], reasoning: { effort: "minimal" } }, false).reasoning_effort).toBe("minimal");
    expect(chat.buildRequestBody({ model: "o3", messages: [], reasoning: { effort: "max" } }, false).reasoning_effort).toBe("high");
    const legacy = chat.buildRequestBody({ model: "gpt-4o", messages: [], temperature: 0.3, maxTokens: 9, reasoning: { effort: "high" } }, false);
    expect(legacy.reasoning_effort).toBeUndefined();
    expect(legacy.temperature).toBe(0.3);
    expect(legacy.max_tokens).toBe(9);
  });
  it("explicit maxTokensParam still wins over the rule", () => {
    const p = new OpenAIProvider({ provider: "openai", apiKey: "k", api: "chat", maxTokensParam: "max_tokens" }) as any;
    expect(p.buildRequestBody({ model: "gpt-6", messages: [], maxTokens: 5 }, false).max_tokens).toBe(5);
  });
  it("azure uses the same rules", () => {
    const az = new AzureProvider({ provider: "azure", apiKey: "k", endpoint: "http://az", deploymentName: "d", api: "chat" }) as any;
    const body = az.buildRequestBody({ model: "gpt-6-luna", messages: [], maxTokens: 1, temperature: 0.1 }, false);
    expect(body.max_completion_tokens).toBe(1);
    expect(body.temperature).toBeUndefined();
  });
  it("unknown models get the permissive default: everything the caller asked is sent", () => {
    const body = chat.buildRequestBody({ model: "acme-large-1", messages: [], maxTokens: 5, temperature: 0.4, topP: 0.8, reasoning: { effort: "xhigh" } }, false);
    expect(body).toMatchObject({ max_tokens: 5, temperature: 0.4, top_p: 0.8, reasoning_effort: "xhigh" });
  });
  it("applyOpenAIReasoning maps with the body model", () => {
    const body: any = { model: "gpt-5-mini" };
    applyOpenAIReasoning(body, { effort: "max" }, "legacy_effort");
    expect(body.reasoning_effort).toBe("high");
  });
});

function anthropicSpy(model: string) {
  const bodies: any[] = [];
  const fetchMock = (async (_u: any, init: any) => {
    bodies.push(JSON.parse(init.body));
    return new Response(JSON.stringify({ id: "m", model, content: [{ type: "text", text: "hi" }], stop_reason: "end_turn", usage: { input_tokens: 1, output_tokens: 1 } }), { status: 200 });
  }) as typeof fetch;
  return { bodies, p: new AnthropicProvider({ provider: "anthropic", apiKey: "k", defaultModel: model, fetch: fetchMock }) };
}
const msgs = [{ role: "user" as const, content: "hi" }];

describe("Claude 5.x wire", () => {
  it.each(["claude-haiku-5-5", "claude-sonnet-5-5", "claude-opus-5-5"])("%s: no sampling params, adaptive + effort", async (model) => {
    const { p, bodies } = anthropicSpy(model);
    await p.complete({ messages: msgs, temperature: 0.2, topP: 0.9, reasoning: { effort: "max" }, extra: { top_k: 5 } });
    expect(bodies[0].thinking).toEqual({ type: "adaptive", display: "summarized" });
    expect(bodies[0].output_config).toEqual({ effort: "max" });
    for (const k of ["temperature", "top_p", "top_k"]) expect(bodies[0][k], k).toBeUndefined();
  });
  it("no sampling params even without reasoning", async () => {
    const { p, bodies } = anthropicSpy("claude-sonnet-5-5");
    await p.complete({ messages: msgs, temperature: 0.2, topP: 0.9 });
    expect(bodies[0].temperature).toBeUndefined();
    expect(bodies[0].top_p).toBeUndefined();
    expect(bodies[0].thinking).toBeUndefined();
  });
  it("older Claude keeps sampling when thinking is off and strips it when on", async () => {
    const { p, bodies } = anthropicSpy("claude-sonnet-4-5");
    await p.complete({ messages: msgs, temperature: 0.2, topP: 0.9 });
    await p.complete({ messages: msgs, temperature: 0.2, topP: 0.9, reasoning: { effort: "medium" } });
    expect(bodies[0]).toMatchObject({ temperature: 0.2, top_p: 0.9 });
    expect(bodies[1].thinking.type).toBe("enabled");
    expect(bodies[1].temperature).toBeUndefined();
    expect(bodies[1].top_p).toBeUndefined();
  });
  it("4.6 maps xhigh to high; 4.7 passes it", async () => {
    const a = anthropicSpy("claude-opus-4-6");
    await a.p.complete({ messages: msgs, reasoning: { effort: "xhigh" } });
    expect(a.bodies[0].output_config.effort).toBe("high");
    const b = anthropicSpy("claude-opus-4-7");
    await b.p.complete({ messages: msgs, reasoning: { effort: "xhigh" } });
    expect(b.bodies[0].output_config.effort).toBe("xhigh");
  });
  it("legacy budget models scale the budget to xhigh / max", () => {
    expect(ANTHROPIC_EFFORT_BUDGET.max).toBeGreaterThan(ANTHROPIC_EFFORT_BUDGET.xhigh);
    const body: any = { model: "claude-sonnet-4-5", max_tokens: 1000 };
    applyAnthropicReasoning(body, { effort: "max" });
    expect(body.thinking).toEqual({ type: "enabled", budget_tokens: ANTHROPIC_EFFORT_BUDGET.max });
    expect(body.max_tokens).toBeGreaterThan(ANTHROPIC_EFFORT_BUDGET.max);
    const br: any = { modelId: "anthropic.claude-sonnet-4-5" };
    applyBedrockReasoning(br, { effort: "xhigh" });
    expect(br.additionalModelRequestFields.thinking.budget_tokens).toBe(ANTHROPIC_EFFORT_BUDGET.xhigh);
  });
  it("gemini xhigh / max use the largest budget", () => {
    const gc: any = {};
    applyGeminiReasoning(gc, { effort: "max" });
    expect(gc.thinkingConfig.thinkingBudget).toBe(GEMINI_EFFORT_BUDGET.max);
  });
});

describe("Bedrock Claude 5.x", () => {
  it("adaptive + effort in additionalModelRequestFields, no sampling in inferenceConfig", async () => {
    const bodies: any[] = [];
    const fetchMock = (async (_u: any, init: any) => {
      bodies.push(JSON.parse(init.body));
      return new Response(JSON.stringify({ output: { message: { role: "assistant", content: [{ text: "hi" }] } }, stopReason: "end_turn", usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } }), { status: 200 });
    }) as typeof fetch;
    const p = new BedrockProvider({ provider: "bedrock", region: "us-east-1", accessKeyId: "a", secretAccessKey: "s", fetch: fetchMock });
    await p.complete({ model: "global.anthropic.claude-sonnet-5-5-v1:0", messages: msgs, maxTokens: 50, temperature: 0.3, topP: 0.9, reasoning: { effort: "max" } });
    expect(bodies[0].additionalModelRequestFields.thinking.type).toBe("adaptive");
    expect(bodies[0].additionalModelRequestFields.output_config).toEqual({ effort: "max" });
    expect(bodies[0].inferenceConfig).toEqual({ maxTokens: 50 });
  });
});
