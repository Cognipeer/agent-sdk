/**
 * Unknown models / rule drift: provider 400s are parsed, the request is fixed
 * and retried (at most 3 adjustments), the fix is remembered per (provider,
 * model), and what cannot be fixed surfaces as a typed ModelRequestError.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { OpenAIProvider } from "../../../src/providers/openai.js";
import { OpenAICompatibleProvider } from "../../../src/providers/openaiCompatible.js";
import { AnthropicProvider } from "../../../src/providers/anthropic.js";
import { BedrockProvider } from "../../../src/providers/bedrock.js";
import { VertexProvider } from "../../../src/providers/vertex.js";
import { ProviderError } from "../../../src/providers/types.js";
import { ModelRequestError, parseModelError, clearLearnedModelRules, listLearnedModelRules, resolveModelRule, type ModelRuleLearnedEvent } from "../../../src/index.js";

beforeEach(() => clearLearnedModelRules());

type Reply = { status: number; body: any };
const NO_RETRY = { maxRetries: 0 } as any;

function mock(replies: Reply[]) {
  const bodies: any[] = [];
  const fn = (async (_u: any, init: any) => {
    bodies.push(JSON.parse(init.body));
    const r = replies[Math.min(bodies.length - 1, replies.length - 1)];
    return new Response(typeof r.body === "string" ? r.body : JSON.stringify(r.body), { status: r.status });
  }) as typeof fetch;
  return { fn, bodies };
}
const oaiErr = (message: string, param?: string, code?: string) => ({ status: 400, body: { error: { message, type: "invalid_request_error", param: param ?? null, code: code ?? null } } });
const OAI_OK = { status: 200, body: { id: "c", model: "m", choices: [{ message: { role: "assistant", content: "hi" }, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } } };
const ANT_OK = { status: 200, body: { id: "m", model: "x", content: [{ type: "text", text: "hi" }], stop_reason: "end_turn", usage: { input_tokens: 1, output_tokens: 1 } } };
const antErr = (message: string) => ({ status: 400, body: { type: "error", error: { type: "invalid_request_error", message } } });
const msgs = [{ role: "user" as const, content: "hi" }];
const tool = { name: "lookup", description: "d", parameters: { type: "object", properties: {} } };

function oai(replies: Reply[], extra: Record<string, any> = {}) {
  const m = mock(replies);
  const events: ModelRuleLearnedEvent[] = [];
  const p = new OpenAICompatibleProvider({ provider: "openai-compatible", apiKey: "k", baseURL: "http://x/v1", fetch: m.fn, retry: NO_RETRY, onModelRuleLearned: (e) => events.push(e), ...extra });
  return { p, events, ...m };
}

describe("OpenAI-wire 400 shapes -> corrected retry", () => {
  it("Unsupported parameter: drops the field", async () => {
    const { p, bodies, events } = oai([oaiErr("Unsupported parameter: 'temperature' is not supported with this model.", "temperature", "unsupported_parameter"), OAI_OK]);
    const r = await p.complete({ model: "acme-x1", messages: msgs, temperature: 0.3, topP: 0.5 });
    expect(r.content).toBe("hi");
    expect(bodies).toHaveLength(2);
    expect(bodies[0].temperature).toBe(0.3);
    expect(bodies[1].temperature).toBeUndefined();
    expect(bodies[1].top_p).toBe(0.5);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ provider: "openai-compatible", model: "acme-x1", adjustment: "drop:temperature" });
  });
  it("Use 'max_completion_tokens' instead: renames the limit", async () => {
    const { p, bodies } = oai([oaiErr("Unsupported parameter: 'max_tokens' is not supported with this model. Use 'max_completion_tokens' instead.", "max_tokens", "unsupported_parameter"), OAI_OK]);
    await p.complete({ model: "acme-x1", messages: msgs, maxTokens: 7 });
    expect(bodies[0].max_tokens).toBe(7);
    expect(bodies[1].max_completion_tokens).toBe(7);
    expect(bodies[1].max_tokens).toBeUndefined();
  });
  it("the reverse rename works for servers that only know max_tokens", async () => {
    const { p, bodies } = oai([oaiErr("Unsupported parameter: 'max_completion_tokens'. Use 'max_tokens' instead."), OAI_OK]);
    await p.complete({ model: "gpt-6", messages: msgs, maxTokens: 7 });
    expect(bodies[1].max_tokens).toBe(7);
  });
  it("Only the default (1) value is supported: stops sending temperature", async () => {
    const { p, bodies } = oai([oaiErr("Unsupported value: 'temperature' does not support 0.2 with this model. Only the default (1) value is supported.", "temperature", "unsupported_value"), OAI_OK]);
    await p.complete({ model: "acme-x1", messages: msgs, temperature: 0.2 });
    expect(bodies[1].temperature).toBeUndefined();
  });
  it("Unsupported value + Supported values: picks the nearest supported effort", async () => {
    const { p, bodies } = oai([
      oaiErr("Unsupported value: 'reasoning_effort' does not support 'minimal' with this model. Supported values are: 'none', 'low', 'medium', and 'high'.", "reasoning_effort", "unsupported_value"),
      OAI_OK,
    ]);
    await p.complete({ model: "acme-x1", messages: msgs, reasoning: { effort: "minimal" } });
    expect(bodies[0].reasoning_effort).toBe("minimal");
    expect(bodies[1].reasoning_effort).toBe("low");
    const again = await p.complete({ model: "acme-x1", messages: msgs, reasoning: { effort: "xhigh" } });
    expect(again.content).toBe("hi");
    expect(bodies[2].reasoning_effort).toBe("high");
  });
  it("Function tools with reasoning_effort: sends effort none on the retry", async () => {
    const { p, bodies } = oai([oaiErr("Function tools with reasoning_effort are not supported for acme-x1 in /v1/chat/completions. To use function tools, use /v1/responses or set reasoning_effort to 'none'."), OAI_OK]);
    await p.complete({ model: "acme-x1", messages: msgs, tools: [tool], reasoning: { effort: "high" } });
    expect(bodies[0].reasoning_effort).toBe("high");
    expect(bodies[1].reasoning_effort).toBe("none");
  });
  it("Responses API: a value error teaches the responses effort list only", async () => {
    const m = mock([
      oaiErr("Unsupported value: 'reasoning.effort' does not support 'max' with this model. Supported values are: 'low', 'medium', and 'high'.", "reasoning.effort", "unsupported_value"),
      { status: 200, body: { id: "r", model: "m", output: [{ type: "message", content: [{ type: "output_text", text: "ok" }] }], usage: { input_tokens: 1, output_tokens: 1 } } },
    ]);
    const p = new OpenAIProvider({ provider: "openai", apiKey: "k", api: "responses", baseURL: "http://x/v1", fetch: m.fn, retry: NO_RETRY });
    const r = await p.complete({ model: "acme-r1", messages: msgs, reasoning: { effort: "max" } });
    expect(r.content).toBe("ok");
    expect(m.bodies[0].reasoning.effort).toBe("max");
    expect(m.bodies[1].reasoning.effort).toBe("high");
    expect(resolveModelRule({ provider: "openai", model: "acme-r1" }).reasoning.efforts).toContain("max");
  });
});

describe("learned cache", () => {
  it("second call is right first time and the learned rule is visible", async () => {
    const { p, bodies } = oai([oaiErr("Unsupported parameter: 'temperature' is not supported with this model.", "temperature"), OAI_OK, OAI_OK]);
    await p.complete({ model: "acme-x1", messages: msgs, temperature: 0.3 });
    expect(bodies).toHaveLength(2);
    await p.complete({ model: "acme-x1", messages: msgs, temperature: 0.3 });
    expect(bodies).toHaveLength(3);
    expect(bodies[2].temperature).toBeUndefined();
    const learned = listLearnedModelRules();
    expect(learned).toHaveLength(1);
    expect(learned[0]).toMatchObject({ provider: "openai-compatible", model: "acme-x1" });
    expect(resolveModelRule({ provider: "openai-compatible", model: "acme-x1" })).toMatchObject({ learned: true, isDefault: true });
    // another model is unaffected
    await p.complete({ model: "acme-x2", messages: msgs, temperature: 0.3 });
    expect(bodies[3].temperature).toBe(0.3);
  });
  it("is not committed when the call never succeeds", async () => {
    const { p } = oai([oaiErr("Unsupported parameter: 'temperature'.", "temperature"), oaiErr("bad request, unrelated")]);
    await expect(p.complete({ model: "acme-x1", messages: msgs, temperature: 0.3 })).rejects.toBeInstanceOf(ModelRequestError);
    expect(listLearnedModelRules()).toHaveLength(0);
  });
  it("a throwing onModelRuleLearned callback does not break the call", async () => {
    const { p } = oai([oaiErr("Unsupported parameter: 'temperature'."), OAI_OK], { onModelRuleLearned: () => { throw new Error("host bug"); } });
    await expect(p.complete({ model: "acme-x1", messages: msgs, temperature: 0.3 })).resolves.toMatchObject({ content: "hi" });
  });
});

describe("ModelRequestError", () => {
  it("is thrown after 3 adjustments are exhausted (4 requests), with the last parameter", async () => {
    const replies = ["seed", "frequency_penalty", "n", "top_logprobs"].map((x) => oaiErr(`Unsupported parameter: '${x}' is not supported with this model.`, x, "unsupported_parameter"));
    const { p, bodies } = oai(replies);
    const err: any = await p.complete({ model: "acme-x1", messages: msgs, seed: 1, frequencyPenalty: 0.1, n: 2, topLogprobs: 2, logprobs: true }).catch((e) => e);
    expect(err).toBeInstanceOf(ModelRequestError);
    expect(err).toBeInstanceOf(ProviderError);
    expect(bodies).toHaveLength(4);
    expect(err).toMatchObject({ status: 400, code: "unsupported_parameter", param: "top_logprobs", provider: "openai-compatible", model: "acme-x1" });
    expect(err.message).toContain("top_logprobs");
  });
  it("carries value and supportedValues for value errors", async () => {
    const { p } = oai([oaiErr("Unsupported value: 'service_tier' does not support 'flex' with this model. Supported values are: 'auto' and 'default'.", "service_tier")]);
    // service_tier is dropped on retry; the retry keeps failing with the same error -> typed error
    const err: any = await p.complete({ model: "acme-x1", messages: msgs, extra: { service_tier: "flex" } }).catch((e) => e);
    expect(err).toBeInstanceOf(ModelRequestError);
    expect(err).toMatchObject({ code: "unsupported_value", param: "service_tier", value: "flex", supportedValues: ["auto", "default"] });
  });
  it("an unparseable 400 is typed model_request_invalid and is not retried", async () => {
    const { p, bodies } = oai([{ status: 400, body: { error: { message: "context length exceeded" } } }]);
    const err: any = await p.complete({ model: "acme-x1", messages: msgs }).catch((e) => e);
    expect(err).toBeInstanceOf(ModelRequestError);
    expect(err.code).toBe("model_request_invalid");
    expect(bodies).toHaveLength(1);
  });
  it("a retry that would send the identical body ends with the typed error", async () => {
    // `extra` is the caller's word: the sampling rule does not touch it, so the fix changes nothing.
    const { p, bodies } = oai([oaiErr("Unsupported parameter: 'temperature'.", "temperature")]);
    const err: any = await p.complete({ model: "acme-x1", messages: msgs, extra: { temperature: 0.4 } }).catch((e) => e);
    expect(err).toBeInstanceOf(ModelRequestError);
    expect(bodies).toHaveLength(1);
  });
  it("other statuses stay plain ProviderErrors", async () => {
    const { p } = oai([{ status: 401, body: { error: { message: "no" } } }]);
    const err: any = await p.complete({ model: "acme-x1", messages: msgs }).catch((e) => e);
    expect(err).toBeInstanceOf(ProviderError);
    expect(err).not.toBeInstanceOf(ModelRequestError);
  });
});

describe("no retry once the stream has started", () => {
  const enc = new TextEncoder();
  function sseResponse(events: any[]) {
    return new Response(new ReadableStream({ start(c) { for (const e of events) c.enqueue(enc.encode(`data: ${typeof e === "string" ? e : JSON.stringify(e)}\n\n`)); c.close(); } }), { status: 200 });
  }
  it("a 400-looking error event inside an open Responses stream is thrown, not retried", async () => {
    let calls = 0;
    const fn = (async () => {
      calls++;
      return sseResponse([
        { type: "response.created", response: { id: "r", model: "m" } },
        { type: "response.output_text.delta", delta: "hel" },
        { type: "error", error: { message: "Unsupported parameter: 'temperature'" } },
      ]);
    }) as typeof fetch;
    const p = new OpenAIProvider({ provider: "openai", apiKey: "k", api: "responses", responsesStreaming: true, baseURL: "http://x/v1", fetch: fn, retry: NO_RETRY });
    const seen: string[] = [];
    await expect((async () => {
      for await (const c of p.completeStream({ model: "acme-r1", messages: msgs, temperature: 0.2 })) if (c.delta.content) seen.push(c.delta.content);
    })()).rejects.toThrow(/Unsupported parameter/);
    expect(seen).toEqual(["hel"]);
    expect(calls).toBe(1);
  });
  it("chat stream: a 400 before the first byte is corrected and the stream then flows", async () => {
    let calls = 0;
    const fn = (async (_u: any, init: any) => {
      calls++;
      if (calls === 1) return new Response(JSON.stringify({ error: { message: "Unsupported parameter: 'top_p'." } }), { status: 400 });
      expect(JSON.parse(init.body).top_p).toBeUndefined();
      return sseResponse([{ id: "s", model: "m", choices: [{ delta: { content: "ok" } }] }, { id: "s", model: "m", choices: [{ delta: {}, finish_reason: "stop" }] }, "[DONE]"]);
    }) as typeof fetch;
    const p = new OpenAICompatibleProvider({ provider: "openai-compatible", apiKey: "k", baseURL: "http://x/v1", fetch: fn, retry: NO_RETRY });
    const out: string[] = [];
    for await (const c of p.completeStream({ model: "acme-x1", messages: msgs, topP: 0.5 })) if (c.delta.content) out.push(c.delta.content);
    expect(out).toEqual(["ok"]);
    expect(calls).toBe(2);
  });
});

describe("Anthropic 400 shapes", () => {
  function ant(model: string, replies: Reply[]) {
    const m = mock(replies);
    const events: ModelRuleLearnedEvent[] = [];
    return { p: new AnthropicProvider({ provider: "anthropic", apiKey: "k", defaultModel: model, fetch: m.fn, retry: NO_RETRY, onModelRuleLearned: (e) => events.push(e) }), events, ...m };
  }
  it("`temperature` is deprecated for this model (backticks): drops it", async () => {
    const { p, bodies } = ant("claude-zeta-1", [antErr("`temperature` is deprecated for this model."), ANT_OK, ANT_OK]);
    await p.complete({ messages: msgs, temperature: 0.4 });
    expect(bodies[0].temperature).toBe(0.4);
    expect(bodies[1].temperature).toBeUndefined();
    await p.complete({ messages: msgs, temperature: 0.4 });
    expect(bodies[2].temperature).toBeUndefined();
  });
  it("top_p deprecated: drops top_p only", async () => {
    const { p, bodies } = ant("claude-zeta-1", [antErr("`top_p` is deprecated for this model."), ANT_OK]);
    await p.complete({ messages: msgs, temperature: 0.4, topP: 0.9 });
    expect(bodies[1]).toMatchObject({ temperature: 0.4 });
    expect(bodies[1].top_p).toBeUndefined();
  });
  it("may only be set to 1 when thinking is enabled: drops temperature", async () => {
    const { p, bodies } = ant("claude-zeta-1", [antErr("`temperature` may only be set to 1 when thinking is enabled."), ANT_OK]);
    await p.complete({ messages: msgs, temperature: 0.4 });
    expect(bodies[1].temperature).toBeUndefined();
  });
  it("thinking.type.enabled not supported: switches to adaptive + effort", async () => {
    const { p, bodies } = ant("claude-zeta-1", [antErr('"thinking.type.enabled" is not supported for this model. Use "thinking.type.adaptive" and "output_config.effort"'), ANT_OK]);
    await p.complete({ messages: msgs, reasoning: { effort: "high" } });
    expect(bodies[0].thinking.type).toBe("enabled");
    expect(bodies[1].thinking.type).toBe("adaptive");
    expect(bodies[1].output_config.effort).toBe("high");
  });
  it("thinking.type.adaptive not supported: switches to budget", async () => {
    const { p, bodies } = ant("claude-fable-9", [antErr("thinking.type.adaptive is not supported for this model"), ANT_OK]);
    await p.complete({ messages: msgs, reasoning: { effort: "low" } });
    expect(bodies[0].thinking.type).toBe("adaptive");
    expect(bodies[1].thinking.type).toBe("enabled");
  });
  it("To turn thinking off ... between_tools: uses that off mechanism", async () => {
    const { p, bodies } = ant("claude-fable-9", [antErr("To turn thinking off on this model, send thinking:{type:'between_tools'}"), ANT_OK]);
    await p.complete({ messages: msgs, reasoning: { effort: "none" } });
    expect(bodies[0].thinking.type).toBe("adaptive");
    expect(bodies[0].output_config.effort).toBe("low");
    expect(bodies[1].thinking).toEqual({ type: "between_tools" });
  });
  it("thinking.type.disabled not supported: falls back to the lowest effort", async () => {
    const { p, bodies } = ant("claude-haiku-5-5", [antErr("thinking.type.disabled is not supported for this model"), ANT_OK]);
    await p.complete({ messages: msgs, reasoning: { effort: "none" } });
    expect(bodies[0].thinking).toEqual({ type: "disabled" });
    expect(bodies[1].thinking.type).toBe("adaptive");
    expect(bodies[1].output_config.effort).toBe("low");
  });
  it("explicit extra.thinking is the caller's word: the typed error, one request", async () => {
    const { p, bodies } = ant("claude-zeta-1", [antErr('"thinking.type.enabled" is not supported for this model. Use "thinking.type.adaptive"')]);
    const err: any = await p.complete({ messages: msgs, extra: { thinking: { type: "enabled", budget_tokens: 2000 } } }).catch((e) => e);
    expect(err).toBeInstanceOf(ModelRequestError);
    expect(bodies).toHaveLength(1);
  });
});

describe("Bedrock and Vertex", () => {
  it("Bedrock: a deprecated sampling param is dropped from inferenceConfig and retried", async () => {
    const m = mock([
      { status: 400, body: { message: "The model returned the following errors: `temperature` is deprecated for this model." } },
      { status: 200, body: { output: { message: { role: "assistant", content: [{ text: "hi" }] } }, stopReason: "end_turn", usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } } },
    ]);
    const p = new BedrockProvider({ provider: "bedrock", region: "us-east-1", accessKeyId: "a", secretAccessKey: "s", fetch: m.fn, retry: NO_RETRY });
    const r = await p.complete({ model: "anthropic.claude-zeta-1-v1:0", messages: msgs, temperature: 0.3, maxTokens: 10 });
    expect(r.content).toBe("hi");
    expect(m.bodies[0].inferenceConfig.temperature).toBe(0.3);
    expect(m.bodies[1].inferenceConfig).toEqual({ maxTokens: 10 });
  });
  it("Bedrock: an unfixable 400 is a ModelRequestError", async () => {
    const m = mock([{ status: 400, body: { message: "Malformed input request" } }]);
    const p = new BedrockProvider({ provider: "bedrock", region: "us-east-1", accessKeyId: "a", secretAccessKey: "s", fetch: m.fn, retry: NO_RETRY });
    await expect(p.complete({ model: "anthropic.claude-zeta-1-v1:0", messages: msgs })).rejects.toBeInstanceOf(ModelRequestError);
  });
  it("Vertex: a 400 surfaces as a ModelRequestError", async () => {
    const m = mock([{ status: 400, body: { error: { message: "Unsupported parameter: 'topP' for this model" } } }]);
    const p = new VertexProvider({ provider: "vertex", projectId: "p", location: "l", accessToken: "t", fetch: m.fn, retry: NO_RETRY } as any);
    const err: any = await p.complete({ model: "gemini-x", messages: msgs }).catch((e) => e);
    expect(err).toBeInstanceOf(ModelRequestError);
    expect(err).toMatchObject({ provider: "vertex", model: "gemini-x", code: "unsupported_parameter", param: "topP" });
  });
});

describe("parseModelError", () => {
  it("returns undefined for unrelated text and parses JSON or plain bodies", () => {
    expect(parseModelError("boom")).toBeUndefined();
    expect(parseModelError(JSON.stringify({ error: { message: "Unsupported parameter: 'seed'" } }))).toMatchObject({ kind: "unsupported_parameter", param: "seed" });
    expect(parseModelError("Unsupported parameter: 'seed'")).toMatchObject({ kind: "unsupported_parameter", param: "seed" });
  });
});
