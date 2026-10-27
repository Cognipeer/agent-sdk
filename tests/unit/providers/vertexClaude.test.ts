import { describe, it, expect } from "vitest";
import { VertexProvider } from "../../../src/providers/vertex.js";
import { fromNativeProvider } from "../../../src/providers/adapter.js";
import { wireInfoOf } from "../../../src/providers/wireInfo.js";
import { vertexClaudeHost, vertexClaudeModelId } from "../../../src/providers/vertexAnthropic.js";
import type { ChatCompletionChunk, ChatCompletionRequest } from "../../../src/providers/types.js";

// Claude models on Vertex AI: the Anthropic Messages body and stream, over the
// `publishers/anthropic/models/{model}:rawPredict` / `:streamRawPredict` transport.

type Call = { url: string; headers: Record<string, string>; body: any };

const CLAUDE_OK = {
  id: "msg_1",
  type: "message",
  model: "claude-sonnet-4-6",
  content: [{ type: "text", text: "hello" }],
  stop_reason: "end_turn",
  usage: { input_tokens: 10, output_tokens: 20, cache_read_input_tokens: 100, cache_creation_input_tokens: 50 },
};

const GEMINI_OK = {
  candidates: [{ content: { parts: [{ text: "ok" }] }, finishReason: "STOP" }],
  usageMetadata: { promptTokenCount: 40, candidatesTokenCount: 20, thoughtsTokenCount: 8, cachedContentTokenCount: 10, totalTokenCount: 68 },
};

const json = (o: any, status = 200) => new Response(JSON.stringify(o), { status, headers: { "content-type": "application/json" } });
const sse = (events: Array<[string, any]>) =>
  new Response(events.map(([name, data]) => `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`).join(""), {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });

function fakeFetch(reply: () => Response) {
  const calls: Call[] = [];
  const fn = (async (url: any, init: any) => {
    calls.push({ url: String(url), headers: init?.headers ?? {}, body: JSON.parse(init.body) });
    return reply();
  }) as unknown as typeof fetch;
  return { fn, calls };
}

function vertex(fn: typeof fetch, extra: Record<string, any> = {}) {
  return new VertexProvider({
    provider: "vertex",
    projectId: "proj",
    location: "us-east5",
    accessToken: "tok-abc",
    fetch: fn,
    retry: { maxRetries: 0 },
    ...extra,
  } as any);
}

const msgs = [{ role: "user" as const, content: "hi" }];
const req = (model: string, extra: Partial<ChatCompletionRequest> = {}): ChatCompletionRequest => ({ model, messages: msgs, ...extra });

async function collect<T>(it: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const x of it) out.push(x);
  return out;
}

const STREAM_EVENTS: Array<[string, any]> = [
  [
    "message_start",
    {
      type: "message_start",
      message: {
        id: "msg_s",
        model: "claude-sonnet-4-6",
        usage: { input_tokens: 10, cache_read_input_tokens: 100, cache_creation_input_tokens: 50, output_tokens: 1 },
      },
    },
  ],
  ["content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }],
  ["content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hel" } }],
  ["content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "lo" } }],
  ["content_block_stop", { type: "content_block_stop", index: 0 }],
  ["content_block_start", { type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "tu_1", name: "get_weather", input: {} } }],
  ["content_block_delta", { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: '{"city":' } }],
  ["content_block_delta", { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: '"Paris"}' } }],
  ["content_block_stop", { type: "content_block_stop", index: 1 }],
  ["message_delta", { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 20 } }],
  ["message_stop", { type: "message_stop" }],
];

describe("model id routing", () => {
  it("recognises Claude ids, with or without the publisher path", () => {
    expect(vertexClaudeModelId("claude-sonnet-4-6")).toBe("claude-sonnet-4-6");
    expect(vertexClaudeModelId("publishers/anthropic/models/claude-opus-5-5")).toBe("claude-opus-5-5");
    expect(vertexClaudeModelId("claude-sonnet-4@20250514")).toBe("claude-sonnet-4@20250514");
  });

  it("writes a dated snapshot the way Vertex spells it", () => {
    expect(vertexClaudeModelId("claude-haiku-4-5-20251001")).toBe("claude-haiku-4-5@20251001");
    expect(vertexClaudeModelId("claude-3-5-haiku-20241022")).toBe("claude-3-5-haiku@20241022");
  });

  it("leaves everything else to the Gemini path", () => {
    expect(vertexClaudeModelId("gemini-2.0-flash")).toBeUndefined();
    expect(vertexClaudeModelId("publishers/google/models/gemini-2.5-pro")).toBeUndefined();
    expect(vertexClaudeModelId("text-embedding-005")).toBeUndefined();
    expect(vertexClaudeModelId(undefined)).toBeUndefined();
    expect(vertexClaudeModelId("")).toBeUndefined();
  });

  it("picks the host by location", () => {
    expect(vertexClaudeHost("global")).toBe("aiplatform.googleapis.com");
    expect(vertexClaudeHost("us")).toBe("aiplatform.us.rep.googleapis.com");
    expect(vertexClaudeHost("eu")).toBe("aiplatform.eu.rep.googleapis.com");
    expect(vertexClaudeHost("us-east5")).toBe("us-east5-aiplatform.googleapis.com");
    expect(vertexClaudeHost("europe-west1")).toBe("europe-west1-aiplatform.googleapis.com");
  });
});

describe("Claude on Vertex: URL", () => {
  it("non-streaming goes to :rawPredict on the regional host", async () => {
    const { fn, calls } = fakeFetch(() => json(CLAUDE_OK));
    await vertex(fn).complete(req("claude-sonnet-4-6"));
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(
      "https://us-east5-aiplatform.googleapis.com/v1/projects/proj/locations/us-east5/publishers/anthropic/models/claude-sonnet-4-6:rawPredict",
    );
  });

  it("streaming goes to :streamRawPredict", async () => {
    const { fn, calls } = fakeFetch(() => sse(STREAM_EVENTS));
    await collect(vertex(fn).completeStream(req("claude-sonnet-4-6")));
    expect(calls[0].url).toBe(
      "https://us-east5-aiplatform.googleapis.com/v1/projects/proj/locations/us-east5/publishers/anthropic/models/claude-sonnet-4-6:streamRawPredict",
    );
    expect(calls[0].body.stream).toBe(true);
  });

  it("location global uses the plain host for both modes", async () => {
    const { fn, calls } = fakeFetch(() => json(CLAUDE_OK));
    const p = vertex(fn, { location: "global" });
    await p.complete(req("claude-opus-5-5"));
    expect(calls[0].url).toBe("https://aiplatform.googleapis.com/v1/projects/proj/locations/global/publishers/anthropic/models/claude-opus-5-5:rawPredict");

    const s = fakeFetch(() => sse(STREAM_EVENTS));
    await collect(vertex(s.fn, { location: "global" }).completeStream(req("claude-opus-5-5")));
    expect(s.calls[0].url).toBe("https://aiplatform.googleapis.com/v1/projects/proj/locations/global/publishers/anthropic/models/claude-opus-5-5:streamRawPredict");
  });

  it("a multi-region location uses its rep host", async () => {
    const { fn, calls } = fakeFetch(() => json(CLAUDE_OK));
    await vertex(fn, { location: "eu" }).complete(req("claude-opus-5-5"));
    expect(calls[0].url).toBe("https://aiplatform.eu.rep.googleapis.com/v1/projects/proj/locations/eu/publishers/anthropic/models/claude-opus-5-5:rawPredict");
  });

  it("the publisher path and a dated id reach the URL in Vertex's spelling", async () => {
    const { fn, calls } = fakeFetch(() => json(CLAUDE_OK));
    const p = vertex(fn);
    await p.complete(req("publishers/anthropic/models/claude-haiku-4-5-20251001"));
    expect(calls[0].url).toContain("/publishers/anthropic/models/claude-haiku-4-5@20251001:rawPredict");
  });

  it("the default model is routed too", async () => {
    const { fn, calls } = fakeFetch(() => json(CLAUDE_OK));
    await vertex(fn, { defaultModel: "claude-sonnet-4-6" }).complete({ messages: msgs } as any);
    expect(calls[0].url).toContain("/publishers/anthropic/models/claude-sonnet-4-6:rawPredict");
  });
});

describe("Claude on Vertex: request", () => {
  it("has no model field and carries anthropic_version", async () => {
    const { fn, calls } = fakeFetch(() => json(CLAUDE_OK));
    await vertex(fn).complete(req("claude-sonnet-4-6", { maxTokens: 321 }));
    const body = calls[0].body;
    expect(body).not.toHaveProperty("model");
    expect(body.anthropic_version).toBe("vertex-2023-10-16");
    expect(body.max_tokens).toBe(321);
    expect(body.stream).toBe(false);
    expect(body.messages).toEqual([{ role: "user", content: "hi" }]);
  });

  it("authenticates with the Google bearer token, not Anthropic headers", async () => {
    const { fn, calls } = fakeFetch(() => json(CLAUDE_OK));
    await vertex(fn, { defaultHeaders: { "x-goog-user-project": "billing" } }).complete(req("claude-sonnet-4-6"));
    const h = calls[0].headers;
    expect(h["Authorization"]).toBe("Bearer tok-abc");
    expect(h["Content-Type"]).toBe("application/json");
    expect(h["x-goog-user-project"]).toBe("billing");
    expect(h).not.toHaveProperty("x-api-key");
    expect(h).not.toHaveProperty("anthropic-version");
  });

  it("maps system, tools and tool results with the Anthropic body building", async () => {
    const { fn, calls } = fakeFetch(() => json(CLAUDE_OK));
    await vertex(fn).complete({
      model: "claude-sonnet-4-6",
      messages: [
        { role: "system", content: "be brief" },
        { role: "user", content: "weather?" },
        { role: "assistant", content: "", toolCalls: [{ id: "tu_1", name: "get_weather", arguments: '{"city":"Paris"}' }] },
        { role: "tool", toolCallId: "tu_1", content: "sunny" },
      ],
      tools: [{ name: "get_weather", description: "weather", parameters: { type: "object", properties: { city: { type: "string" } } } }],
      temperature: 0.2,
    });
    const body = calls[0].body;
    expect(body.system).toBe("be brief");
    expect(body.tools).toEqual([{ name: "get_weather", description: "weather", input_schema: { type: "object", properties: { city: { type: "string" } } } }]);
    expect(body.messages[1]).toEqual({ role: "assistant", content: [{ type: "tool_use", id: "tu_1", name: "get_weather", input: { city: "Paris" } }] });
    expect(body.messages[2]).toEqual({ role: "user", content: [{ type: "tool_result", tool_use_id: "tu_1", content: "sunny" }] });
    expect(body.temperature).toBe(0.2);
    // Nothing Gemini-shaped.
    expect(body).not.toHaveProperty("contents");
    expect(body).not.toHaveProperty("generationConfig");
  });

  it("keeps an explicit thinking block from extra", async () => {
    const { fn, calls } = fakeFetch(() => json(CLAUDE_OK));
    await vertex(fn).complete(req("claude-sonnet-4-6", { extra: { thinking: { type: "enabled", budget_tokens: 2048 } } }));
    expect(calls[0].body.thinking).toEqual({ type: "enabled", budget_tokens: 2048 });
    expect(calls[0].body).not.toHaveProperty("temperature");
  });

  it("a caller's anthropic_version in extra wins", async () => {
    const { fn, calls } = fakeFetch(() => json(CLAUDE_OK));
    await vertex(fn).complete(req("claude-sonnet-4-6", { extra: { anthropic_version: "2026-10-21" } }));
    expect(calls[0].body.anthropic_version).toBe("2026-10-21");
  });

  it("an error response is a ProviderError that names Vertex AI", async () => {
    const { fn } = fakeFetch(() => json({ error: { message: "quota" } }, 500));
    await expect(vertex(fn).complete(req("claude-sonnet-4-6"))).rejects.toMatchObject({
      name: "ProviderError",
      provider: "vertex",
      statusCode: 500,
      message: expect.stringContaining("Vertex AI API error 500"),
    });
  });
});

describe("Claude on Vertex: prompt caching", () => {
  const tools = [
    { name: "t1", description: "a", parameters: { type: "object", properties: {} } },
    { name: "t2", description: "b", parameters: { type: "object", properties: {} } },
  ];
  const withSystem: Partial<ChatCompletionRequest> = {
    messages: [{ role: "system", content: "sys" }, { role: "user", content: "hi" }],
    tools,
  };

  it("is off by default: no markers", async () => {
    const { fn, calls } = fakeFetch(() => json(CLAUDE_OK));
    await vertex(fn).complete(req("claude-sonnet-4-6", withSystem));
    expect(JSON.stringify(calls[0].body)).not.toContain("cache_control");
  });

  it("auto: breakpoints on system and the last tool, plus top-level automatic caching", async () => {
    const { fn, calls } = fakeFetch(() => json(CLAUDE_OK));
    await vertex(fn, { prompt_caching: { enabled: true } }).complete(req("claude-sonnet-4-6", withSystem));
    const body = calls[0].body;
    expect(body.system).toEqual([{ type: "text", text: "sys", cache_control: { type: "ephemeral" } }]);
    expect(body.tools[0]).not.toHaveProperty("cache_control");
    expect(body.tools[1].cache_control).toEqual({ type: "ephemeral" });
    expect(body.cache_control).toEqual({ type: "ephemeral" });
  });

  it("static: no top-level marker; ttl 1h is sent on every marker", async () => {
    const { fn, calls } = fakeFetch(() => json(CLAUDE_OK));
    await vertex(fn, { prompt_caching: { enabled: true, strategy: "static", ttl: "1h" } }).complete(req("claude-sonnet-4-6", withSystem));
    const body = calls[0].body;
    expect(body).not.toHaveProperty("cache_control");
    expect(body.system[0].cache_control).toEqual({ type: "ephemeral", ttl: "1h" });
    expect(body.tools[1].cache_control).toEqual({ type: "ephemeral", ttl: "1h" });
  });

  it("does not touch Gemini requests", async () => {
    const { fn, calls } = fakeFetch(() => json(GEMINI_OK));
    await vertex(fn, { prompt_caching: { enabled: true } }).complete(req("gemini-2.0-flash", withSystem));
    expect(JSON.stringify(calls[0].body)).not.toContain("cache_control");
  });
});

describe("Claude on Vertex: responses", () => {
  it("parses a non-streaming response with the Anthropic parser", async () => {
    const reply = {
      ...CLAUDE_OK,
      content: [{ type: "text", text: "calling" }, { type: "tool_use", id: "tu_9", name: "get_weather", input: { city: "Rome" } }],
      stop_reason: "tool_use",
    };
    const { fn } = fakeFetch(() => json(reply));
    const res = await vertex(fn).complete(req("claude-sonnet-4-6"));
    expect(res.content).toBe("calling");
    expect(res.toolCalls).toEqual([{ id: "tu_9", name: "get_weather", arguments: '{"city":"Rome"}' }]);
    expect(res.finishReason).toBe("tool_calls");
    expect(res.rawFinishReason).toBe("tool_use");
    expect(res.id).toBe("msg_1");
  });

  it("maps max_tokens to length", async () => {
    const { fn } = fakeFetch(() => json({ ...CLAUDE_OK, stop_reason: "max_tokens" }));
    expect((await vertex(fn).complete(req("claude-sonnet-4-6"))).finishReason).toBe("length");
  });

  it("parses the SSE stream with the Anthropic stream parser", async () => {
    const { fn } = fakeFetch(() => sse(STREAM_EVENTS));
    const chunks: ChatCompletionChunk[] = await collect(vertex(fn).completeStream(req("claude-sonnet-4-6")));
    expect(chunks.map((c) => c.delta.content ?? "").join("")).toBe("Hello");
    const calls = chunks.flatMap((c) => c.delta.toolCalls ?? []);
    expect(calls[0]).toMatchObject({ id: "tu_1", name: "get_weather" });
    expect(calls.map((c) => c.arguments).join("")).toBe('{"city":"Paris"}');
    const last = chunks[chunks.length - 1];
    expect(last.finishReason).toBe("tool_calls");
    expect(last.rawFinishReason).toBe("tool_use");
    expect(last.model).toBe("claude-sonnet-4-6");
  });
});

describe("Claude on Vertex: usage basis", () => {
  const user = [{ role: "user", content: "hello" }];

  it("a response with cache read 100 / write 50 / input 10 folds to an inclusive prompt of 160", async () => {
    const { fn } = fakeFetch(() => json(CLAUDE_OK));
    const model = fromNativeProvider(vertex(fn), { model: "claude-sonnet-4-6" });
    const message: any = await model.invoke(user as any);
    expect(message.usage).toEqual({
      prompt_tokens: 160,
      completion_tokens: 20,
      total_tokens: 180,
      prompt_tokens_details: { cached_tokens: 100, cache_write_tokens: 50 },
      completion_tokens_details: { reasoning_tokens: 0 },
    });
    expect(wireInfoOf(message)?.provider).toBe("vertex");
    expect(wireInfoOf(message)).not.toHaveProperty("usageBasis");
  });

  it("a stream folds the same way (early usage chunk included)", async () => {
    const { fn } = fakeFetch(() => sse(STREAM_EVENTS));
    const model = fromNativeProvider(vertex(fn), { model: "claude-sonnet-4-6" });
    let last: any;
    for await (const part of model.stream!(user as any)) last = part;
    expect(last.usage).toEqual({
      prompt_tokens: 160,
      completion_tokens: 20,
      total_tokens: 180,
      prompt_tokens_details: { cached_tokens: 100, cache_write_tokens: 50 },
      completion_tokens_details: { reasoning_tokens: 0 },
    });
  });

  it("thinking tokens are counted once: completion stays the API's output_tokens", async () => {
    const reply = { ...CLAUDE_OK, usage: { ...CLAUDE_OK.usage, output_tokens_details: { thinking_tokens: 8 } } };
    const { fn } = fakeFetch(() => json(reply));
    const message: any = await fromNativeProvider(vertex(fn), { model: "claude-sonnet-4-6" }).invoke(user as any);
    expect(message.usage).toMatchObject({ prompt_tokens: 160, completion_tokens: 20, total_tokens: 180 });
    expect(message.usage.completion_tokens_details.reasoning_tokens).toBe(8);
  });

  it("the provider's own TokenUsage is on the Vertex basis (cache in the input, reasoning out of the output)", async () => {
    const reply = { ...CLAUDE_OK, usage: { ...CLAUDE_OK.usage, output_tokens_details: { thinking_tokens: 8 } } };
    const { fn } = fakeFetch(() => json(reply));
    const res = await vertex(fn).complete(req("claude-sonnet-4-6"));
    expect(res.usage).toMatchObject({
      inputTokens: 160,
      outputTokens: 12,
      reasoningTokens: 8,
      totalTokens: 180,
      cachedInputTokens: 100,
      cachedWriteTokens: 50,
    });
  });

  it("a direct Anthropic provider is unchanged (cache stays outside inputTokens)", async () => {
    const { AnthropicProvider } = await import("../../../src/providers/anthropic.js");
    const { fn } = fakeFetch(() => json(CLAUDE_OK));
    const p = new AnthropicProvider({ provider: "anthropic", apiKey: "k", fetch: fn, retry: { maxRetries: 0 } } as any);
    const res = await p.complete(req("claude-sonnet-4-6"));
    expect(res.usage).toMatchObject({ inputTokens: 10, outputTokens: 20, totalTokens: 30, cachedInputTokens: 100, cachedWriteTokens: 50 });
    const message: any = await fromNativeProvider(p, { model: "claude-sonnet-4-6" }).invoke(user as any);
    expect(message.usage.prompt_tokens).toBe(160);
  });
});

describe("Gemini models on the same provider are unaffected", () => {
  it("keep the publishers/google URL, the Gemini body and the Vertex usage basis", async () => {
    const { fn, calls } = fakeFetch(() => json(GEMINI_OK));
    const model = fromNativeProvider(vertex(fn, { prompt_caching: { enabled: true } }), { model: "gemini-2.0-flash" });
    const message: any = await model.invoke([{ role: "user", content: "hello" }] as any);
    expect(calls[0].url).toBe(
      "https://us-east5-aiplatform.googleapis.com/v1/projects/proj/locations/us-east5/publishers/google/models/gemini-2.0-flash:generateContent",
    );
    expect(calls[0].headers["Authorization"]).toBe("Bearer tok-abc");
    expect(calls[0].body.contents).toBeDefined();
    expect(calls[0].body).not.toHaveProperty("anthropic_version");
    // Vertex basis: input as reported, completion = candidates + thoughts.
    expect(message.usage).toMatchObject({ prompt_tokens: 40, completion_tokens: 28, total_tokens: 68 });
    expect(message.usage.prompt_tokens_details.cached_tokens).toBe(10);
  });

  it("streams Gemini through streamGenerateContent", async () => {
    const { fn, calls } = fakeFetch(() => sse([["message", { candidates: [{ content: { parts: [{ text: "x" }] }, finishReason: "STOP" }] }]]));
    await collect(vertex(fn).completeStream(req("gemini-2.0-flash")));
    expect(calls[0].url).toContain("/publishers/google/models/gemini-2.0-flash:streamGenerateContent?alt=sse");
  });
});
