/**
 * Explicit upstream API selection (`api: "chat" | "responses"`), Claude visible
 * thinking, Bedrock usage / stop-reason / SigV4 details and Vertex embeddings.
 * Every test uses a mock fetch.
 */
import { describe, expect, it } from "vitest";
import {
  AnthropicProvider,
  AzureProvider,
  BedrockProvider,
  OpenAICompatibleProvider,
  OpenAIProvider,
  VertexProvider,
} from "../../../src/providers/index.js";
import { signRequest } from "../../../src/providers/utils/sigv4.js";
import { applyBedrockReasoning } from "../../../src/providers/utils/reasoning.js";

type Call = { url: string; body: any; headers: Record<string, string> };

function recorder(respond: (n: number) => Response) {
  const calls: Call[] = [];
  const fn = (async (url: any, init: any = {}) => {
    calls.push({ url: String(url), body: init.body ? JSON.parse(init.body) : undefined, headers: init.headers ?? {} });
    return respond(calls.length);
  }) as unknown as typeof fetch;
  return { fn, calls };
}
const json = (d: any) => new Response(JSON.stringify(d), { status: 200, headers: { "content-type": "application/json" } });
function sse(events: any[]): Response {
  const enc = new TextEncoder();
  return new Response(
    new ReadableStream({
      start(c) {
        for (const e of events) c.enqueue(enc.encode(`event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`));
        c.close();
      },
    }),
    { status: 200, headers: { "content-type": "text/event-stream" } },
  );
}
const msgs = [{ role: "user" as const, content: "hi" }];
const CHAT_OK = { id: "c", model: "m", choices: [{ message: { role: "assistant", content: "ok" }, finish_reason: "stop" }], usage: {} };
const RESP_OK = { id: "r", model: "m", status: "completed", output: [{ type: "message", content: [{ type: "output_text", text: "ok" }] }], usage: {} };

const STREAM = [
  { type: "response.created", response: { id: "r1", model: "gpt-x" } },
  { type: "response.reasoning_summary_text.delta", item_id: "rs", delta: "Think " },
  { type: "response.reasoning_summary_text.delta", item_id: "rs", delta: "hard." },
  { type: "response.output_text.delta", item_id: "m", delta: "Hello" },
  {
    type: "response.completed",
    response: {
      id: "r1", model: "gpt-x", status: "completed",
      output: [
        { type: "reasoning", summary: [{ type: "summary_text", text: "Think hard." }] },
        { type: "message", content: [{ type: "output_text", text: "Hello" }] },
      ],
      usage: { input_tokens: 3, output_tokens: 4, total_tokens: 7, output_tokens_details: { reasoning_tokens: 2 } },
    },
  },
];

async function collect<T>(g: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const x of g) out.push(x);
  return out;
}

describe("upstream API selection", () => {
  it("api defaults to 'auto' (the 0.11 behaviour): OpenAI and Azure route gpt-5 + reasoning to Responses, compatible stays on chat", async () => {
    const mk: Array<[string, (f: typeof fetch) => any, RegExp]> = [
      ["openai", (f) => new OpenAIProvider({ provider: "openai", apiKey: "k", fetch: f }), /\/responses$/],
      ["azure", (f) => new AzureProvider({ provider: "azure", apiKey: "k", endpoint: "http://az", deploymentName: "d", fetch: f }), /\/responses/],
      ["compatible", (f) => new OpenAICompatibleProvider({ provider: "openai-compatible", apiKey: "k", baseURL: "http://x/v1", fetch: f }), /chat\/completions/],
    ];
    for (const [, make, want] of mk) {
      const r = recorder(() => json(want.source.includes("chat") ? CHAT_OK : RESP_OK));
      await make(r.fn).complete({ model: "gpt-5.6-terra", messages: msgs, reasoning: { effort: "high" } });
      expect(r.calls[0].url).toMatch(want);
    }
  });

  it("api:'auto' is the same as unset, and no reasoning or a non-reasoning model stays on chat", async () => {
    const r = recorder(() => json(CHAT_OK));
    await new OpenAIProvider({ provider: "openai", apiKey: "k", api: "auto", fetch: r.fn }).complete({ model: "gpt-4o", messages: msgs, reasoning: { effort: "high" } });
    expect(r.calls[0].url).toMatch(/chat\/completions/);
    const q = recorder(() => json(RESP_OK));
    await new OpenAIProvider({ provider: "openai", apiKey: "k", api: "auto", fetch: q.fn }).complete({ model: "gpt-5", messages: msgs, reasoning: { effort: "low" } });
    expect(q.calls[0].url).toMatch(/\/responses$/);
  });

  it("api:'chat' forces Chat Completions even for gpt-5 + reasoning", async () => {
    const r = recorder(() => json(CHAT_OK));
    await new OpenAIProvider({ provider: "openai", apiKey: "k", api: "chat", fetch: r.fn }).complete({ model: "gpt-5", messages: msgs, reasoning: { effort: "low" } });
    expect(r.calls[0].url).toMatch(/chat\/completions/);
  });

  it("responsesApi:'auto' opts a compatible provider into the heuristic", async () => {
    const r = recorder(() => json(RESP_OK));
    await new OpenAICompatibleProvider({ provider: "openai-compatible", apiKey: "k", baseURL: "http://x/v1", responsesApi: "auto", fetch: r.fn }).complete({ model: "gpt-5", messages: msgs, reasoning: { effort: "low" } });
    expect(r.calls[0].url).toMatch(/\/responses$/);
  });

  it("responsesApi:'auto' keeps the heuristic", async () => {
    const r = recorder(() => json(RESP_OK));
    await new OpenAIProvider({ provider: "openai", apiKey: "k", responsesApi: "auto", fetch: r.fn }).complete({ model: "gpt-5.6-terra", messages: msgs, reasoning: { effort: "low" } });
    expect(r.calls[0].url).toMatch(/\/responses$/);
  });

  it("legacy aliases: never -> chat, always -> responses; api wins over responsesApi", async () => {
    const a = recorder(() => json(CHAT_OK));
    await new OpenAIProvider({ provider: "openai", apiKey: "k", responsesApi: "never", fetch: a.fn }).complete({ model: "gpt-5", messages: msgs, reasoning: { effort: "low" } });
    expect(a.calls[0].url).toMatch(/chat\/completions/);
    const b = recorder(() => json(RESP_OK));
    await new OpenAIProvider({ provider: "openai", apiKey: "k", responsesApi: "always", fetch: b.fn }).complete({ model: "gpt-4o", messages: msgs });
    expect(b.calls[0].url).toMatch(/\/responses$/);
    const c = recorder(() => json(CHAT_OK));
    await new OpenAIProvider({ provider: "openai", apiKey: "k", api: "chat", responsesApi: "always", fetch: c.fn }).complete({ model: "gpt-4o", messages: msgs });
    expect(c.calls[0].url).toMatch(/chat\/completions/);
  });

  it("OpenAICompatibleProvider api:'responses' really streams over SSE incl. reasoning summary deltas", async () => {
    const r = recorder(() => sse(STREAM));
    const p = new OpenAICompatibleProvider({ provider: "openai-compatible", apiKey: "k", baseURL: "http://x/v1", api: "responses", fetch: r.fn });
    const chunks = await collect(p.completeStream({ model: "gpt-x", messages: msgs, reasoning: { effort: "high" } }));
    expect(r.calls[0].url).toBe("http://x/v1/responses");
    expect(r.calls[0].body.stream).toBe(true);
    expect(chunks.map((c) => c.delta)).toEqual([
      { reasoning: { summary: "Think " } },
      { reasoning: { summary: "hard." } },
      { content: "Hello" },
      {},
    ]);
    const last = chunks[chunks.length - 1];
    expect(last.usage?.reasoningTokens).toBe(2);
    expect(last.finishReason).toBe("stop");
  });

  it("AzureProvider api:'responses' streams from /openai/responses with api-key auth", async () => {
    const r = recorder(() => sse(STREAM));
    const p = new AzureProvider({ provider: "azure", apiKey: "secret", endpoint: "http://az", deploymentName: "dep", api: "responses", fetch: r.fn });
    const chunks = await collect(p.completeStream({ model: "gpt-x", messages: msgs }));
    expect(r.calls[0].url).toContain("http://az/openai/responses?api-version=");
    expect(r.calls[0].body.stream).toBe(true);
    expect(r.calls[0].body.model).toBe("dep");
    expect((r.calls[0].headers as any)["api-key"]).toBe("secret");
    expect(chunks.some((c) => c.delta.content === "Hello")).toBe(true);
  });

  it("responsesStreaming:false with api:'responses' makes one non-streaming call", async () => {
    const r = recorder(() => json(RESP_OK));
    const p = new OpenAIProvider({ provider: "openai", apiKey: "k", api: "responses", responsesStreaming: false, fetch: r.fn });
    const chunks = await collect(p.completeStream({ model: "gpt-x", messages: msgs }));
    expect(r.calls[0].body.stream).toBeUndefined();
    expect(chunks).toHaveLength(1);
    expect(chunks[0].delta.content).toBe("ok");
  });
});

describe("Claude visible thinking", () => {
  const OK = { id: "m", model: "x", content: [{ type: "text", text: "hi" }], stop_reason: "end_turn", usage: { input_tokens: 5, output_tokens: 20, output_tokens_details: { thinking_tokens: 12 } } };
  const run = async (reasoning: any, extra?: any) => {
    const r = recorder(() => json(OK));
    const p = new AnthropicProvider({ provider: "anthropic", apiKey: "k", fetch: r.fn });
    const res = await p.complete({ model: "claude-sonnet-5-5", messages: msgs, reasoning, ...(extra ? { extra } : {}) });
    return { body: r.calls[0].body, res };
  };

  it("sets thinking.display=summarized by default and when includeThoughts is true", async () => {
    expect((await run({ effort: "medium" })).body.thinking).toEqual({ type: "adaptive", display: "summarized" });
    expect((await run({ effort: "medium", includeThoughts: true })).body.thinking.display).toBe("summarized");
  });

  it("omits display when includeThoughts is false", async () => {
    expect((await run({ effort: "medium", includeThoughts: false })).body.thinking).toEqual({ type: "adaptive" });
  });

  it("never touches an explicit extra.thinking", async () => {
    const { body } = await run({ effort: "high", includeThoughts: true }, { thinking: { type: "adaptive" } });
    expect(body.thinking).toEqual({ type: "adaptive" });
  });

  it("parses output_tokens_details.thinking_tokens into reasoningTokens", async () => {
    expect((await run({ effort: "medium" })).res.usage.reasoningTokens).toBe(12);
  });

  it("parses thinking_tokens from the stream's message_delta usage", async () => {
    const r = recorder(() => sse([
      { type: "message_start", message: { id: "m", model: "x", usage: { input_tokens: 5 } } },
      { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 20, output_tokens_details: { thinking_tokens: 9 } } },
      { type: "message_stop" },
    ]));
    const p = new AnthropicProvider({ provider: "anthropic", apiKey: "k", fetch: r.fn });
    const chunks = await collect(p.completeStream({ model: "claude-sonnet-5-5", messages: msgs }));
    expect(chunks[chunks.length - 1].usage?.reasoningTokens).toBe(9);
  });

  it("Bedrock-Claude mapper adds display too, and respects includeThoughts:false", () => {
    const a: any = { modelId: "anthropic.claude-sonnet-5-5-v1:0" };
    applyBedrockReasoning(a, { effort: "high" }, { model: a.modelId });
    expect(a.additionalModelRequestFields.thinking).toEqual({ type: "adaptive", display: "summarized" });
    const b: any = { modelId: "anthropic.claude-sonnet-5-5-v1:0" };
    applyBedrockReasoning(b, { effort: "high", includeThoughts: false }, { model: b.modelId });
    expect(b.additionalModelRequestFields.thinking).toEqual({ type: "adaptive" });
  });
});

describe("Bedrock usage and stop reasons", () => {
  const make = (resp: any) => {
    const r = recorder(() => json(resp));
    return new BedrockProvider({ provider: "bedrock", region: "us-east-1", accessKeyId: "a", secretAccessKey: "s", fetch: r.fn, retry: { maxRetries: 0 } });
  };
  const base = (extra: any) => ({ output: { message: { role: "assistant", content: [{ text: "x" }] } }, stopReason: "end_turn", usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 }, ...extra });

  it("reads cacheReadInputTokens / cacheWriteInputTokens first, ...TokenCount as fallback", async () => {
    const a = await make(base({ usage: { inputTokens: 1, outputTokens: 1, cacheReadInputTokens: 7, cacheWriteInputTokens: 3 } })).complete({ model: "m", messages: msgs });
    expect(a.usage.cachedInputTokens).toBe(7);
    expect(a.usage.cachedWriteTokens).toBe(3);
    const b = await make(base({ usage: { inputTokens: 1, outputTokens: 1, cacheReadInputTokenCount: 5, cacheWriteInputTokenCount: 2 } })).complete({ model: "m", messages: msgs });
    expect(b.usage.cachedInputTokens).toBe(5);
    expect(b.usage.cachedWriteTokens).toBe(2);
  });

  it("maps guardrail_intervened -> content_filter, model_context_window_exceeded -> length, keeps guardrail", async () => {
    const reason = async (stopReason: string) => (await make(base({ stopReason })).complete({ model: "m", messages: msgs })).finishReason;
    expect(await reason("guardrail_intervened")).toBe("content_filter");
    expect(await reason("guardrail")).toBe("content_filter");
    expect(await reason("model_context_window_exceeded")).toBe("length");
    expect(await reason("max_tokens")).toBe("length");
  });
});

describe("SigV4 canonical URI", () => {
  it("double-encodes path segments and matches @smithy/signature-v4 for the same request", () => {
    // Reference signature produced by @smithy/signature-v4 (SignatureV4, service
    // "bedrock", uriEscapePath default) for this exact request and instant.
    const body = '{"a":1}';
    const headers = signRequest({
      method: "POST",
      url: "https://bedrock-runtime.us-east-1.amazonaws.com/model/anthropic.claude-3-5-sonnet-20241022-v2%3A0/converse",
      headers: {
        "content-type": "application/json",
        "x-amz-content-sha256": "015abd7f5cc57a2dd94b7590f04ad8084273905ee33ec5cebeae62276a97f862",
      },
      body,
      region: "us-east-1",
      service: "bedrock",
      credentials: { accessKeyId: "AKIDEXAMPLE", secretAccessKey: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY" },
      now: new Date("2026-01-02T03:04:05Z"),
    });
    expect(headers["x-amz-date"]).toBe("20260102T030405Z");
    expect(headers.Authorization).toContain("Signature=f993ebfdb3f6d4ac7c41fb9d8b03452594af27e6631db2186e3ba9084caa2dc7");
  });
});

describe("Vertex embeddings", () => {
  const make = (resp: any) => {
    const r = recorder(() => json(resp));
    const p = new VertexProvider({ provider: "vertex", projectId: "p", location: "l", accessToken: "t", fetch: r.fn });
    return { p, r };
  };
  const ok = { predictions: [{ embeddings: { values: [0.1, 0.2], statistics: { token_count: 3 } } }] };

  it("merges extra.parameters with outputDimensionality instead of clobbering it", async () => {
    const { p, r } = make(ok);
    await p.embed({ model: "gemini-embedding-001", input: ["a"], dimensions: 256, extra: { parameters: { autoTruncate: false } } });
    expect(r.calls[0].body.parameters).toEqual({ outputDimensionality: 256, autoTruncate: false });
  });

  it("works with extra.parameters alone and with other extra keys", async () => {
    const { p, r } = make(ok);
    await p.embed({ model: "text-embedding-005", input: ["a"], extra: { parameters: { autoTruncate: true }, foo: 1 } });
    expect(r.calls[0].body.parameters).toEqual({ autoTruncate: true });
    expect(r.calls[0].body.foo).toBe(1);
  });

  it("maps task type aliases", async () => {
    for (const [t, want] of [["semantic_similarity", "SEMANTIC_SIMILARITY"], ["question_answering", "QUESTION_ANSWERING"], ["fact_verification", "FACT_VERIFICATION"], ["code_retrieval_query", "CODE_RETRIEVAL_QUERY"], ["search_query", "RETRIEVAL_QUERY"]] as const) {
      const { p, r } = make(ok);
      await p.embed({ model: "gemini-embedding-001", input: ["a"], inputType: t });
      expect(r.calls[0].body.instances[0].task_type).toBe(want);
    }
  });

  it("rejects a prediction whose values are not an array", async () => {
    const { p } = make({ predictions: [{ embeddings: { values: null } }] });
    await expect(p.embed({ model: "gemini-embedding-001", input: ["a"] })).rejects.toThrow(/embeddings\.values/);
  });
});
