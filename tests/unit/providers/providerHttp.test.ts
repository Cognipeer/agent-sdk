/**
 * Provider HTTP round-trips via a stubbed global `fetch`: non-streaming
 * `complete()`, streaming `completeStream()` (SSE delta accumulation), and
 * error paths — plus SSE parser edge cases and the adapter's streaming bridge.
 * No network, no API keys.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import {
  OpenAIProvider,
  AnthropicProvider,
  AzureProvider,
  BedrockProvider,
  VertexProvider,
  ProviderError,
  fromNativeProvider,
  emptyUsage,
} from "../../../src/providers/index.js";
import { parseSSEStream } from "../../../src/providers/utils/sse.js";

afterEach(() => vi.unstubAllGlobals());

// ── helpers ──────────────────────────────────────────────────────────────────
type MockOpts = { json?: any; sse?: string; ok?: boolean; status?: number };
function mockResponse({ json, sse, ok = true, status = 200 }: MockOpts) {
  const r: any = { ok, status, headers: { get: () => null } };
  if (sse !== undefined) {
    const enc = new TextEncoder();
    r.body = new ReadableStream<Uint8Array>({
      start(c) { c.enqueue(enc.encode(sse)); c.close(); },
    });
  }
  r.json = async () => json;
  r.text = async () => (typeof json === "string" ? json : JSON.stringify(json ?? ""));
  return r;
}
function stubFetch(resp: any) {
  const calls: Array<{ url: string; init: any }> = [];
  vi.stubGlobal("fetch", (url: string, init: any) => { calls.push({ url, init }); return Promise.resolve(resp); });
  return calls;
}
async function readableFrom(chunks: string[]): Promise<ReadableStream<Uint8Array>> {
  const enc = new TextEncoder();
  return new ReadableStream<Uint8Array>({ start(c) { for (const ch of chunks) c.enqueue(enc.encode(ch)); c.close(); } });
}
async function collect<T>(gen: AsyncGenerator<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const x of gen) out.push(x);
  return out;
}

// ── SSE parser ─────────────────────────────────────────────────────────────--
describe("providers/sse parser", () => {
  it("joins multi-line data, parses fields, skips comments, and flushes the tail", async () => {
    const stream = await readableFrom([
      ": a comment\n",
      "event: msg\nid: 7\nretry: 1000\ndata: line1\ndata: line2\n\n",
      "data: tail-no-trailing-newline",
    ]);
    const events = await collect(parseSSEStream(stream));
    expect(events[0]).toMatchObject({ event: "msg", id: "7", retry: 1000, data: "line1\nline2" });
    expect(events[1].data).toBe("tail-no-trailing-newline");
  });

  it("treats a field without a colon as an empty-valued field and drops data-less blocks", async () => {
    const stream = await readableFrom(["event\n\n", "data: real\n\n"]);
    const events = await collect(parseSSEStream(stream));
    expect(events).toHaveLength(1);
    expect(events[0].data).toBe("real");
  });
});

// ── OpenAI ─────────────────────────────────────────────────────────────────--
describe("providers/openai HTTP", () => {
  const provider = new OpenAIProvider({ provider: "openai", apiKey: "sk-test", defaultModel: "gpt-4o-mini" } as any);

  it("complete() posts to chat/completions and parses content/tools/usage", async () => {
    const calls = stubFetch(mockResponse({ json: {
      id: "cmpl-1", model: "gpt-4o-mini",
      choices: [{ message: { content: "hello", tool_calls: [{ id: "t1", function: { name: "add", arguments: "{\"a\":1}" } }] }, finish_reason: "tool_calls" }],
      usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8, prompt_tokens_details: { cached_tokens: 2 } },
    } }));
    const res = await provider.complete({ model: "gpt-4o-mini", messages: [{ role: "user", content: "hi" }] } as any);

    expect(calls[0].url).toContain("/chat/completions");
    expect(calls[0].init.headers.Authorization).toBe("Bearer sk-test");
    expect(JSON.parse(calls[0].init.body)).toMatchObject({ model: "gpt-4o-mini", stream: false });
    expect(res.content).toBe("hello");
    expect(res.toolCalls[0]).toMatchObject({ id: "t1", name: "add" });
    expect(res.usage).toMatchObject({ inputTokens: 5, outputTokens: 3, cachedInputTokens: 2 });
    expect(res.finishReason).toBe("tool_calls");
  });

  it("completeStream() accumulates content + tool-call deltas and final usage", async () => {
    const sse =
      'data: {"id":"c1","model":"gpt-4o-mini","choices":[{"delta":{"content":"Hel"}}]}\n\n' +
      'data: {"choices":[{"delta":{"content":"lo"}}]}\n\n' +
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"t1","function":{"name":"add","arguments":"{\\"a\\":"}}]}}]}\n\n' +
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"1}"}}]}}]}\n\n' +
      'data: {"choices":[{"finish_reason":"stop","delta":{}}],"usage":{"prompt_tokens":5,"completion_tokens":3,"total_tokens":8}}\n\n' +
      "data: [DONE]\n\n";
    stubFetch(mockResponse({ sse }));
    const chunks = await collect(provider.completeStream({ model: "gpt-4o-mini", messages: [{ role: "user", content: "hi" }] } as any));

    const text = chunks.map((c) => c.delta.content ?? "").join("");
    expect(text).toBe("Hello");
    const toolArgs = chunks.flatMap((c) => c.delta.toolCalls ?? []).map((t: any) => t.arguments).join("");
    expect(toolArgs).toBe("{\"a\":1}");
    expect(chunks.some((c) => c.usage?.inputTokens === 5)).toBe(true);
  });

  it("complete() throws ProviderError on a non-retryable error status", async () => {
    stubFetch(mockResponse({ ok: false, status: 400, json: "bad request" }));
    await expect(provider.complete({ model: "gpt-4o-mini", messages: [{ role: "user", content: "hi" }] } as any))
      .rejects.toMatchObject({ name: "ProviderError", statusCode: 400 });
  });
});

// ── Anthropic ──────────────────────────────────────────────────────────────--
describe("providers/anthropic HTTP", () => {
  const provider = new AnthropicProvider({ provider: "anthropic", apiKey: "sk-ant", defaultModel: "claude-x" } as any);

  it("complete() posts to /v1/messages with x-api-key and parses content/tools/usage", async () => {
    const calls = stubFetch(mockResponse({ json: {
      id: "msg-1", model: "claude-x", stop_reason: "tool_use",
      content: [
        { type: "text", text: "sure" },
        { type: "tool_use", id: "tu1", name: "add", input: { a: 1 } },
      ],
      usage: { input_tokens: 10, output_tokens: 4, cache_read_input_tokens: 3 },
    } }));
    const res = await provider.complete({ model: "claude-x", messages: [{ role: "user", content: "hi" }] } as any);

    expect(calls[0].url).toContain("/v1/messages");
    expect(calls[0].init.headers["x-api-key"]).toBe("sk-ant");
    expect(calls[0].init.headers["anthropic-version"]).toBeTruthy();
    expect(res.content).toBe("sure");
    expect(res.toolCalls[0]).toMatchObject({ id: "tu1", name: "add", arguments: "{\"a\":1}" });
    expect(res.usage).toMatchObject({ inputTokens: 10, outputTokens: 4, cachedInputTokens: 3 });
  });

  it("completeStream() emits text deltas and a final usage chunk", async () => {
    const sse =
      'event: message_start\ndata: {"type":"message_start","message":{"id":"m1","model":"claude-x","usage":{"input_tokens":10}}}\n\n' +
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hi"}}\n\n' +
      'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":4}}\n\n';
    stubFetch(mockResponse({ sse }));
    const chunks = await collect(provider.completeStream({ model: "claude-x", messages: [{ role: "user", content: "hi" }] } as any));

    expect(chunks.map((c) => c.delta.content ?? "").join("")).toBe("Hi");
    const last = chunks[chunks.length - 1];
    expect(last.finishReason).toBe("stop");
    expect(last.usage).toMatchObject({ inputTokens: 10, outputTokens: 4 });
  });

  it("completeStream() surfaces an error event as a ProviderError", async () => {
    const sse = 'event: error\ndata: {"type":"error","error":{"message":"overloaded"}}\n\n';
    stubFetch(mockResponse({ sse }));
    await expect(collect(provider.completeStream({ model: "claude-x", messages: [{ role: "user", content: "hi" }] } as any)))
      .rejects.toThrow(/overloaded/);
  });

  it("complete() throws ProviderError on 401", async () => {
    stubFetch(mockResponse({ ok: false, status: 401, json: "unauthorized" }));
    await expect(provider.complete({ model: "claude-x", messages: [{ role: "user", content: "hi" }] } as any))
      .rejects.toBeInstanceOf(ProviderError);
  });
});

// ── Azure (extends OpenAI) ─────────────────────────────────────────────────--
describe("providers/azure HTTP", () => {
  const provider = new AzureProvider({ provider: "azure", apiKey: "az-key", endpoint: "https://r.openai.azure.com", deploymentName: "gpt4o", apiVersion: "2024-10-21" } as any);

  it("complete() routes through the deployment path with api-key auth and no model in body", async () => {
    const calls = stubFetch(mockResponse({ json: {
      id: "az-1", model: "gpt4o",
      choices: [{ message: { content: "azure says hi" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6 },
    } }));
    const res = await provider.complete({ messages: [{ role: "user", content: "hi" }] } as any);

    expect(calls[0].url).toContain("/openai/deployments/gpt4o/chat/completions?api-version=2024-10-21");
    expect(calls[0].init.headers["api-key"]).toBe("az-key");
    expect(JSON.parse(calls[0].init.body).model).toBeUndefined();
    expect(res.content).toBe("azure says hi");
    expect(res.usage.inputTokens).toBe(4);
  });

  it("complete() throws ProviderError on error status", async () => {
    stubFetch(mockResponse({ ok: false, status: 403, json: "forbidden" }));
    await expect(provider.complete({ messages: [{ role: "user", content: "x" }] } as any))
      .rejects.toMatchObject({ name: "ProviderError", statusCode: 403 });
  });
});

// ── Vertex (Gemini) ────────────────────────────────────────────────────────--
describe("providers/vertex HTTP", () => {
  const provider = new VertexProvider({ provider: "vertex", projectId: "proj", location: "us-central1", accessToken: "ya29.tok", defaultModel: "gemini-2.0-flash" } as any);

  it("complete() calls generateContent with a bearer token and parses Gemini parts", async () => {
    const calls = stubFetch(mockResponse({ json: {
      responseId: "g1",
      candidates: [{ content: { parts: [{ text: "bonjour" }, { functionCall: { name: "add", args: { a: 1 } } }] }, finishReason: "STOP" }],
      usageMetadata: { promptTokenCount: 7, candidatesTokenCount: 2, totalTokenCount: 9 },
    } }));
    const res = await provider.complete({ model: "gemini-2.0-flash", messages: [{ role: "user", content: "hi" }] } as any);

    expect(calls[0].url).toContain("generateContent");
    expect(calls[0].init.headers.Authorization).toBe("Bearer ya29.tok");
    expect(res.content).toBe("bonjour");
    expect(res.toolCalls[0]).toMatchObject({ name: "add", arguments: "{\"a\":1}" });
    expect(res.usage).toMatchObject({ inputTokens: 7, outputTokens: 2, totalTokens: 9 });
  });
});

// ── Bedrock (Converse + SigV4) ─────────────────────────────────────────────--
describe("providers/bedrock HTTP", () => {
  const provider = new BedrockProvider({ provider: "bedrock", region: "us-east-1", accessKeyId: "AKIATEST", secretAccessKey: "secret", defaultModel: "anthropic.claude-3-5-haiku-20241022-v1:0" } as any);

  it("complete() signs a Converse request and parses output/usage", async () => {
    const calls = stubFetch(mockResponse({ json: {
      output: { message: { content: [{ text: "hola" }, { toolUse: { toolUseId: "tu1", name: "add", input: { a: 1 } } }] } },
      usage: { inputTokens: 6, outputTokens: 3, totalTokens: 9 },
      stopReason: "end_turn",
    } }));
    const res = await provider.complete({ messages: [{ role: "user", content: "hi" }] } as any);

    expect(calls[0].url).toContain("/converse");
    // SigV4 puts the signature in the Authorization header.
    expect(String(calls[0].init.headers.Authorization || calls[0].init.headers.authorization)).toContain("AWS4-HMAC-SHA256");
    expect(res.content).toBe("hola");
    expect(res.toolCalls[0]).toMatchObject({ id: "tu1", name: "add" });
    expect(res.usage).toMatchObject({ inputTokens: 6, outputTokens: 3 });
  });
});

// ── adapter streaming bridge ───────────────────────────────────────────────--
describe("providers/adapter streaming", () => {
  it("fromNativeProvider().stream yields text deltas then a final message", async () => {
    const fake: any = {
      providerName: "openai",
      defaultModel: "fake-1",
      async complete() { return { id: "1", model: "fake-1", content: "done", toolCalls: [], usage: emptyUsage(), finishReason: "stop" }; },
      async *completeStream() {
        yield { id: "1", model: "fake-1", delta: { content: "Hel" } };
        yield { id: "1", model: "fake-1", delta: { content: "lo" } };
        yield { id: "1", model: "fake-1", delta: {}, finishReason: "stop", usage: emptyUsage() };
      },
    };
    const model: any = fromNativeProvider(fake, { model: "fake-1" });

    const pieces: string[] = [];
    let finalMessage: any;
    for await (const chunk of model.stream([{ role: "user", content: "hi" }])) {
      if (typeof chunk === "string") pieces.push(chunk);
      else if (chunk && typeof chunk === "object" && (chunk as any).role) finalMessage = chunk;
    }
    expect(pieces.join("")).toBe("Hello");
    expect(finalMessage?.content).toBe("Hello");
  });
});
