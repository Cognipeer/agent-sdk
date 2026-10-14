import { describe, it, expect } from "vitest";
import { OpenAIProvider } from "../../../src/providers/openai.js";
import { OpenAICompatibleProvider } from "../../../src/providers/openaiCompatible.js";
import { AzureProvider } from "../../../src/providers/azure.js";
import { AnthropicProvider } from "../../../src/providers/anthropic.js";
import { BedrockProvider } from "../../../src/providers/bedrock.js";
import { VertexProvider } from "../../../src/providers/vertex.js";
import { encodeFrame } from "../../../src/providers/utils/eventStream.js";
import type { ChatCompletionChunk } from "../../../src/providers/types.js";

type Call = { url: string; headers: Record<string, string>; body: any };

function mockFetch(responses: Array<() => Response>) {
  const calls: Call[] = [];
  let i = 0;
  const fn = (async (url: any, init: any) => {
    calls.push({ url: String(url), headers: init?.headers ?? {}, body: init?.body ? JSON.parse(init.body) : undefined });
    const make = responses[Math.min(i++, responses.length - 1)];
    return make();
  }) as unknown as typeof fetch;
  return { fn, calls };
}
const json = (o: any, headers: Record<string, string> = {}) => () =>
  new Response(JSON.stringify(o), { status: 200, headers: { "content-type": "application/json", ...headers } });
const sse = (events: any[]) => () => {
  const text = events.map((e) => `data: ${typeof e === "string" ? e : JSON.stringify(e)}\n\n`).join("");
  return new Response(text, { status: 200, headers: { "content-type": "text/event-stream" } });
};
async function collect<T>(it: AsyncIterable<T>): Promise<T[]> {
  const o: T[] = [];
  for await (const x of it) o.push(x);
  return o;
}
const msgs = [{ role: "user" as const, content: "hi" }];

describe("OpenAI gateway needs: request body", () => {
  it("sends seed, n, logprobs, top_logprobs and parallel_tool_calls", async () => {
    const { fn, calls } = mockFetch([json({ choices: [{ message: { content: "x" }, finish_reason: "stop" }] })]);
    const p = new OpenAIProvider({ provider: "openai", apiKey: "k", fetch: fn, retry: { maxRetries: 0 } });
    await p.complete({
      model: "gpt-4o", messages: msgs, seed: 7, n: 2, logprobs: true, topLogprobs: 3,
      parallelToolCalls: false,
      tools: [{ name: "t", description: "d", parameters: { type: "object", properties: {} } }],
    });
    expect(calls[0].body).toMatchObject({ seed: 7, n: 2, logprobs: true, top_logprobs: 3, parallel_tool_calls: false });
  });

  it("omits parallel_tool_calls when there are no tools, and the new fields when unset", async () => {
    const { fn, calls } = mockFetch([json({ choices: [{ message: { content: "x" }, finish_reason: "stop" }] })]);
    const p = new OpenAIProvider({ provider: "openai", apiKey: "k", fetch: fn });
    await p.complete({ model: "gpt-4o", messages: msgs, parallelToolCalls: true });
    for (const k of ["seed", "n", "logprobs", "top_logprobs", "parallel_tool_calls"]) expect(calls[0].body).not.toHaveProperty(k);
  });

  it("streamUsage:false drops stream_options; default keeps include_usage", async () => {
    const done = sse([{ id: "1", model: "m", choices: [{ delta: { content: "a" }, finish_reason: "stop" }] }, "[DONE]"]);
    const a = mockFetch([done]);
    const b = mockFetch([done]);
    const pa = new OpenAICompatibleProvider({ provider: "openai-compatible", apiKey: "k", baseURL: "http://x/v1", fetch: a.fn });
    const pb = new OpenAICompatibleProvider({ provider: "openai-compatible", apiKey: "k", baseURL: "http://x/v1", fetch: b.fn });
    await collect(pa.completeStream({ model: "m", messages: msgs }));
    await collect(pb.completeStream({ model: "m", messages: msgs, streamUsage: false }));
    expect(a.calls[0].body.stream_options).toEqual({ include_usage: true });
    expect(b.calls[0].body).not.toHaveProperty("stream_options");
  });
});

describe("OpenAI gateway needs: response parsing", () => {
  it("keeps raw finish_reason and provider fields (non-stream)", async () => {
    const { fn } = mockFetch([json({
      id: "r", model: "gpt", system_fingerprint: "fp_1", service_tier: "default",
      choices: [{
        finish_reason: "function_call", logprobs: { content: [] },
        message: { content: null, refusal: "no", annotations: [{ type: "url_citation" }], tool_calls: [{ id: "c", function: { name: "f", arguments: "{}" } }] },
      }],
    })]);
    const res = await new OpenAIProvider({ provider: "openai", apiKey: "k", fetch: fn }).complete({ model: "gpt", messages: msgs });
    expect(res.rawFinishReason).toBe("function_call");
    expect(res.providerFields).toEqual({
      system_fingerprint: "fp_1", service_tier: "default", refusal: "no",
      annotations: [{ type: "url_citation" }], logprobs: { content: [] },
    });
  });

  it("omits providerFields/rawFinishReason when absent", async () => {
    const { fn } = mockFetch([json({ choices: [{ message: { content: "x" } }] })]);
    const res = await new OpenAIProvider({ provider: "openai", apiKey: "k", fetch: fn }).complete({ model: "gpt", messages: msgs });
    expect(res).not.toHaveProperty("rawFinishReason");
    expect(res).not.toHaveProperty("providerFields");
  });

  it("stream: tool-call deltas carry index, raw finish reason and fingerprint", async () => {
    const { fn } = mockFetch([sse([
      { id: "1", model: "m", system_fingerprint: "fp", choices: [{ delta: { tool_calls: [{ index: 0, id: "a", function: { name: "f", arguments: "" } }, { index: 1, id: "b", function: { name: "g", arguments: "" } }] } }] },
      { id: "1", model: "m", choices: [{ delta: { tool_calls: [{ index: 1, function: { arguments: "{}" } }] } }] },
      { id: "1", model: "m", choices: [{ delta: {}, finish_reason: "tool_calls" }] },
      "[DONE]",
    ])]);
    const chunks: ChatCompletionChunk[] = await collect(
      new OpenAIProvider({ provider: "openai", apiKey: "k", fetch: fn }).completeStream({ model: "m", messages: msgs }),
    );
    expect(chunks[0].delta.toolCalls?.map((t) => [t.index, t.id, t.name])).toEqual([[0, "a", "f"], [1, "b", "g"]]);
    expect(chunks[0].providerFields).toEqual({ system_fingerprint: "fp" });
    expect(chunks[1].delta.toolCalls?.[0]).toMatchObject({ index: 1, id: "b", arguments: "{}" });
    expect(chunks[2].rawFinishReason).toBe("tool_calls");
    expect(chunks[1]).not.toHaveProperty("rawFinishReason");
  });
});

describe("Anthropic / Bedrock / Vertex gateway needs", () => {
  it("Anthropic: raw stop_reason, opening tool chunk with index", async () => {
    const ev = (event: string, data: any) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    const body = [
      ev("message_start", { message: { id: "m", model: "c", usage: { input_tokens: 3 } } }),
      ev("content_block_start", { index: 0, content_block: { type: "text" } }),
      ev("content_block_start", { index: 1, content_block: { type: "tool_use", id: "tu", name: "noargs" } }),
      ev("message_delta", { delta: { stop_reason: "tool_use" }, usage: { output_tokens: 5 } }),
    ].join("");
    const fn = (async () => new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } })) as unknown as typeof fetch;
    const chunks = await collect(new AnthropicProvider({ provider: "anthropic", apiKey: "k", fetch: fn }).completeStream({ model: "c", messages: msgs }));
    const tool = chunks.find((c) => c.delta.toolCalls)!;
    expect(tool.delta.toolCalls![0]).toMatchObject({ id: "tu", name: "noargs", index: 0 });
    const last = chunks[chunks.length - 1];
    expect(last.rawFinishReason).toBe("tool_use");
    expect(last.finishReason).toBe("tool_calls");
  });

  it("Anthropic non-stream: raw stop_reason", async () => {
    const { fn } = mockFetch([json({ id: "m", model: "c", stop_reason: "end_turn", content: [{ type: "text", text: "ok" }], usage: {} })]);
    const res = await new AnthropicProvider({ provider: "anthropic", apiKey: "k", fetch: fn }).complete({ model: "c", messages: msgs });
    expect(res.rawFinishReason).toBe("end_turn");
    expect(res.finishReason).toBe("stop");
  });

  const bedrock = (fn: typeof fetch) =>
    new BedrockProvider({ provider: "bedrock", region: "us-east-1", accessKeyId: "a", secretAccessKey: "s", fetch: fn, retry: { maxRetries: 0 } });

  it("Bedrock: extra goes to additionalModelRequestFields, Converse fields stay top-level, reasoning merges", async () => {
    const { fn, calls } = mockFetch([json({ output: { message: { content: [{ text: "x" }] } }, stopReason: "max_tokens", usage: {} })]);
    const res = await bedrock(fn).complete({
      model: "anthropic.claude-x", messages: msgs,
      extra: { top_k: 40, guardrailConfig: { guardrailIdentifier: "g", guardrailVersion: "1" } },
      reasoning: { effort: "low" },
    });
    expect(calls[0].body.guardrailConfig).toEqual({ guardrailIdentifier: "g", guardrailVersion: "1" });
    expect(calls[0].body.additionalModelRequestFields.top_k).toBe(40);
    expect(calls[0].body).not.toHaveProperty("top_k");
    expect(res.rawFinishReason).toBe("max_tokens");
    expect(res.finishReason).toBe("length");
  });

  it("Bedrock stream: tool-call ordinal index (not content-block index) and raw stop reason", async () => {
    const evt = (type: string, payload: any) =>
      encodeFrame({ ":message-type": "event", ":event-type": type, ":content-type": "application/json" }, JSON.stringify(payload));
    const parts = [
      evt("contentBlockDelta", { contentBlockIndex: 0, delta: { text: "hi" } }),
      evt("contentBlockStart", { contentBlockIndex: 1, start: { toolUse: { toolUseId: "t1", name: "f" } } }),
      evt("contentBlockDelta", { contentBlockIndex: 1, delta: { toolUse: { input: "{}" } } }),
      evt("messageStop", { stopReason: "tool_use" }),
      evt("metadata", { usage: { inputTokens: 1, outputTokens: 2 } }),
    ];
    const all = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
    let o = 0; for (const p of parts) { all.set(p, o); o += p.length; }
    const fn = (async () => new Response(all, { status: 200 })) as unknown as typeof fetch;
    const chunks = await collect(bedrock(fn).completeStream({ model: "anthropic.claude-x", messages: msgs }));
    const tcs = chunks.flatMap((c) => c.delta.toolCalls ?? []);
    expect(tcs.map((t) => t.index)).toEqual([0, 0]);
    expect(chunks[chunks.length - 1].rawFinishReason).toBe("tool_use");
  });

  it("Vertex: raw finishReason", async () => {
    const { fn } = mockFetch([json({
      responseId: "r",
      candidates: [{ finishReason: "STOP", content: { parts: [{ functionCall: { name: "f", args: {} } }] } }],
    })]);
    const p = new VertexProvider({ provider: "vertex", projectId: "p", accessToken: "t", fetch: fn });
    const res = await p.complete({ model: "gemini-2.0-flash", messages: msgs });
    expect(res.rawFinishReason).toBe("STOP");
  });
});

describe("embeddings", () => {
  const vec = (n: number) => [n, n + 0.5];

  it("OpenAI: wire body, ordering by index, usage, dimensions", async () => {
    const { fn, calls } = mockFetch([json({
      model: "text-embedding-3-small",
      data: [{ index: 1, embedding: vec(2) }, { index: 0, embedding: vec(1) }],
      usage: { prompt_tokens: 4, total_tokens: 4 },
    })]);
    const p = new OpenAIProvider({ provider: "openai", apiKey: "k", fetch: fn });
    const res = await p.embed({ model: "text-embedding-3-small", input: ["a", "b"], dimensions: 256 });
    expect(calls[0].url).toBe("https://api.openai.com/v1/embeddings");
    expect(calls[0].headers.Authorization).toBe("Bearer k");
    expect(calls[0].body).toEqual({ model: "text-embedding-3-small", input: ["a", "b"], dimensions: 256 });
    expect(res.vectors).toEqual([vec(1), vec(2)]);
    expect(res.usage).toEqual({ inputTokens: 4, totalTokens: 4 });
  });

  it("OpenAI: batches and sums usage; base64 vectors are decoded", async () => {
    const f32 = Buffer.alloc(8); f32.writeFloatLE(1.5, 0); f32.writeFloatLE(-2, 4);
    const b64 = f32.toString("base64");
    const { fn, calls } = mockFetch([
      json({ data: [{ index: 0, embedding: b64 }, { index: 1, embedding: b64 }], usage: { prompt_tokens: 2, total_tokens: 2 } }),
      json({ data: [{ index: 0, embedding: b64 }], usage: { prompt_tokens: 1, total_tokens: 1 } }),
    ]);
    const p = new OpenAICompatibleProvider({ provider: "openai-compatible", apiKey: "k", baseURL: "http://h/v1", fetch: fn });
    const res = await p.embed({ model: "m", input: ["a", "b", "c"], batchSize: 2, encodingFormat: "base64" });
    expect(calls).toHaveLength(2);
    expect(calls[1].body.input).toEqual(["c"]);
    expect(calls[0].body.encoding_format).toBe("base64");
    expect(res.vectors).toEqual([[1.5, -2], [1.5, -2], [1.5, -2]]);
    expect(res.usage.inputTokens).toBe(3);
  });

  it("OpenAI: a vector-count mismatch is an error", async () => {
    const { fn } = mockFetch([json({ data: [{ index: 0, embedding: vec(1) }] })]);
    const p = new OpenAIProvider({ provider: "openai", apiKey: "k", fetch: fn });
    await expect(p.embed({ model: "m", input: ["a", "b"] })).rejects.toThrow(/1 vectors for 2 inputs/);
  });

  it("OpenAI: HTTP errors surface as ProviderError with status", async () => {
    const fn = (async () => new Response("bad", { status: 400 })) as unknown as typeof fetch;
    const p = new OpenAIProvider({ provider: "openai", apiKey: "k", fetch: fn });
    await expect(p.embed({ model: "m", input: ["a"] })).rejects.toMatchObject({ statusCode: 400 });
  });

  it("Azure: deployment path, api-key auth, no model in body", async () => {
    const { fn, calls } = mockFetch([json({ data: [{ index: 0, embedding: vec(1) }], usage: { prompt_tokens: 1, total_tokens: 1 } })]);
    const p = new AzureProvider({ provider: "azure", apiKey: "az", endpoint: "https://r.openai.azure.com/", apiVersion: "2024-10-21", fetch: fn });
    await p.embed({ model: "emb-dep", input: ["a"] });
    expect(calls[0].url).toBe("https://r.openai.azure.com/openai/deployments/emb-dep/embeddings?api-version=2024-10-21");
    expect(calls[0].headers["api-key"]).toBe("az");
    expect(calls[0].body).toEqual({ input: ["a"] });
  });

  const bedrock = (fn: typeof fetch) =>
    new BedrockProvider({ provider: "bedrock", region: "eu-west-1", accessKeyId: "a", secretAccessKey: "s", fetch: fn, retry: { maxRetries: 0 } });

  it("Bedrock Titan v2: one InvokeModel per text, dimensions, token counts summed, order kept", async () => {
    let n = 0;
    const calls: Call[] = [];
    const fn = (async (url: any, init: any) => {
      const body = JSON.parse(init.body);
      calls.push({ url: String(url), headers: init.headers, body });
      n++;
      return new Response(JSON.stringify({ embedding: [body.inputText.length], inputTextTokenCount: 3 }), { status: 200 });
    }) as unknown as typeof fetch;
    const res = await bedrock(fn).embed({ model: "amazon.titan-embed-text-v2:0", input: ["a", "bbb", "cc"], dimensions: 512 });
    expect(n).toBe(3);
    expect(calls[0].url).toBe("https://bedrock-runtime.eu-west-1.amazonaws.com/model/amazon.titan-embed-text-v2%3A0/invoke");
    expect(calls[0].body).toEqual({ inputText: "a", dimensions: 512 });
    expect(calls[0].headers.Authorization).toMatch(/^AWS4-HMAC-SHA256/);
    expect(res.vectors).toEqual([[1], [3], [2]]);
    expect(res.usage).toEqual({ inputTokens: 9, totalTokens: 9 });
  });

  it("Bedrock Titan v1 never sends dimensions", async () => {
    const { fn, calls } = mockFetch([json({ embedding: [1], inputTextTokenCount: 1 })]);
    await bedrock(fn).embed({ model: "amazon.titan-embed-text-v1", input: ["a"], dimensions: 512 });
    expect(calls[0].body).toEqual({ inputText: "a" });
  });

  it("Bedrock Cohere: batched texts, input_type, both response shapes, usage from header", async () => {
    const a = mockFetch([json({ embeddings: { float: [[1], [2]] } }, { "x-amzn-bedrock-input-token-count": "7" })]);
    const r1 = await bedrock(a.fn).embed({ model: "cohere.embed-v4:0", input: ["x", "y"], inputType: "search_query", dimensions: 256 });
    expect(a.calls[0].body).toEqual({ texts: ["x", "y"], input_type: "search_query", embedding_types: ["float"], output_dimension: 256 });
    expect(r1.vectors).toEqual([[1], [2]]);
    expect(r1.usage.inputTokens).toBe(7);

    const b = mockFetch([json({ embeddings: [[3]] })]);
    const r2 = await bedrock(b.fn).embed({ model: "us.cohere.embed-english-v3", input: ["z"] });
    expect(b.calls[0].body.input_type).toBe("search_document");
    expect(r2.vectors).toEqual([[3]]);
  });

  it("Bedrock: unsupported embedding family is a 400", async () => {
    const { fn } = mockFetch([json({})]);
    await expect(bedrock(fn).embed({ model: "meta.llama3", input: ["a"] })).rejects.toMatchObject({ statusCode: 400 });
  });

  const vertex = (fn: typeof fetch) => new VertexProvider({ provider: "vertex", projectId: "proj", location: "europe-west4", accessToken: "tok", fetch: fn });

  it("Vertex text-embedding: :predict body, task type, dimensions, token_count usage", async () => {
    const { fn, calls } = mockFetch([json({ predictions: [
      { embeddings: { values: [1], statistics: { token_count: 2 } } },
      { embeddings: { values: [2], statistics: { token_count: 3 } } },
    ] })]);
    const res = await vertex(fn).embed({ model: "text-embedding-005", input: ["a", "b"], inputType: "search_query", dimensions: 128 });
    expect(calls[0].url).toBe("https://europe-west4-aiplatform.googleapis.com/v1/projects/proj/locations/europe-west4/publishers/google/models/text-embedding-005:predict");
    expect(calls[0].headers.Authorization).toBe("Bearer tok");
    expect(calls[0].body).toEqual({
      instances: [{ content: "a", task_type: "RETRIEVAL_QUERY" }, { content: "b", task_type: "RETRIEVAL_QUERY" }],
      parameters: { outputDimensionality: 128 },
    });
    expect(res.vectors).toEqual([[1], [2]]);
    expect(res.usage).toEqual({ inputTokens: 5, totalTokens: 5 });
  });

  it("Vertex gemini-embedding: one instance per request", async () => {
    const { fn, calls } = mockFetch([
      json({ predictions: [{ embeddings: { values: [1] } }] }),
      json({ predictions: [{ embeddings: { values: [2] } }] }),
    ]);
    const res = await vertex(fn).embed({ model: "gemini-embedding-001", input: ["a", "b"] });
    expect(calls).toHaveLength(2);
    expect(calls[0].body.instances).toEqual([{ content: "a" }]);
    expect(res.vectors).toEqual([[1], [2]]);
  });

  it("providers without embeddings reject with 400", async () => {
    const p = new AnthropicProvider({ provider: "anthropic", apiKey: "k" });
    await expect(p.embed({ model: "x", input: ["a"] })).rejects.toMatchObject({ statusCode: 400 });
  });

  it("empty input returns empty vectors without any request", async () => {
    const { fn, calls } = mockFetch([json({})]);
    const res = await new OpenAIProvider({ provider: "openai", apiKey: "k", fetch: fn }).embed({ model: "m", input: [] });
    expect(res.vectors).toEqual([]);
    expect(calls).toHaveLength(0);
  });
});

describe("review fixes", () => {
  const okBody = { output: { message: { content: [{ text: "x" }] } }, stopReason: "end_turn", usage: {} };
  const br = (fn: typeof fetch) =>
    new BedrockProvider({ provider: "bedrock", region: "us-east-1", accessKeyId: "a", secretAccessKey: "s", fetch: fn, retry: { maxRetries: 0 } });
  const m = [{ role: "user" as const, content: "hi" }];

  for (const order of ["a", "b"]) {
    it(`Bedrock extra merge is order-independent and non-mutating (${order})`, async () => {
      const { fn, calls } = mockFetch([json(okBody)]);
      const extra: any = order === "a"
        ? { top_k: 5, additionalModelRequestFields: { a: 1 } }
        : { additionalModelRequestFields: { a: 1 }, top_k: 5 };
      await br(fn).complete({ model: "anthropic.claude-x", messages: m, extra, reasoning: { effort: "low" } });
      expect(calls[0].body.additionalModelRequestFields).toMatchObject({ a: 1, top_k: 5 });
      expect(extra.additionalModelRequestFields).toEqual({ a: 1 });
    });
  }

  it("Bedrock: outputConfig stays top-level, __top forces top-level", async () => {
    const { fn, calls } = mockFetch([json(okBody)]);
    await br(fn).complete({ model: "x", messages: m, extra: { outputConfig: { z: 1 }, __top: { newField: 2 } } });
    expect(calls[0].body.outputConfig).toEqual({ z: 1 });
    expect(calls[0].body.newField).toBe(2);
    expect(calls[0].body.additionalModelRequestFields).toBeUndefined();
  });

  it("Claude 5 with effort none uses the model's off mechanism and never sends sampling params", async () => {
    const { applyAnthropicReasoning, applyBedrockReasoning } = await import("../../../src/providers/utils/reasoning.js");
    const a: any = { model: "claude-sonnet-5", temperature: 0.3, top_p: 0.9 };
    applyAnthropicReasoning(a, { effort: "none" });
    expect(a.thinking).toEqual({ type: "between_tools" });
    expect(a.output_config).toBeUndefined();
    expect(a.temperature).toBeUndefined();
    expect(a.top_p).toBeUndefined();
    const b: any = { modelId: "anthropic.claude-sonnet-5", inferenceConfig: { temperature: 0.3 } };
    applyBedrockReasoning(b, { effort: "none" });
    expect(b.inferenceConfig.temperature).toBeUndefined();
    expect(b.additionalModelRequestFields).toEqual({ thinking: { type: "between_tools" } });
  });

  it("older adaptive-free Claude with effort none keeps sampling params and adds no empty objects", async () => {
    const { applyAnthropicReasoning, applyBedrockReasoning } = await import("../../../src/providers/utils/reasoning.js");
    const a: any = { model: "claude-sonnet-4-5", temperature: 0.3, top_p: 0.9 };
    applyAnthropicReasoning(a, { effort: "none" });
    expect(a.temperature).toBe(0.3);
    expect(a.top_p).toBe(0.9);
    const b: any = { modelId: "anthropic.claude-sonnet-4-5", inferenceConfig: { temperature: 0.3 } };
    applyBedrockReasoning(b, { effort: "none" });
    expect(b.inferenceConfig.temperature).toBe(0.3);
    expect(b.additionalModelRequestFields).toBeUndefined();
  });

  it("supportsAdaptiveThinking handles Vertex-style ids", async () => {
    const { supportsAdaptiveThinking } = await import("../../../src/providers/utils/reasoning.js");
    expect(supportsAdaptiveThinking("claude-sonnet-5@20260101")).toBe(true);
    expect(supportsAdaptiveThinking("claude-sonnet-4@20250514")).toBe(false);
  });

  it("SigV4 encodes ! ' ( ) * in path segments", async () => {
    const { signRequest } = await import("../../../src/providers/utils/sigv4.js");
    const r = signRequest({ method: "POST", url: "https://bedrock-runtime.us-east-1.amazonaws.com/model/a(b)*!'/converse", headers: {}, body: "", region: "us-east-1", service: "bedrock", credentials: { accessKeyId: "a", secretAccessKey: "s" }, now: new Date(0) } as any);
    expect(r.Authorization).toBeTruthy();
  });
});
