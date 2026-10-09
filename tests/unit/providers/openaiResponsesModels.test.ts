/**
 * `responsesApiModels` / `responsesStreaming`: the explicit, per-model opt-in
 * to the Responses API on a plain OpenAIProvider.
 *
 * The case it exists for: a model family that reasons by default (gpt-6.1-sol
 * on an Azure `/openai/v1` endpoint) rejects function tools on Chat
 * Completions whether or not a reasoning field is sent, and cannot turn
 * reasoning off. Nothing here is inferred from a model name — what is not
 * listed routes exactly as before (see openaiTransportRegression.test.ts).
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import {
  OpenAIProvider,
  AzureProvider,
  OpenAICompatibleProvider,
  ProviderError,
  fromNativeProvider,
} from "../../../src/providers/index.js";
import type { ChatCompletionRequest, OpenAIProviderConfig } from "../../../src/providers/types.js";

afterEach(() => vi.unstubAllGlobals());

const AZURE_V1 = "https://res.openai.azure.com/openai/v1";

function openai(extra: Partial<OpenAIProviderConfig> = {}) {
  return new OpenAIProvider({ provider: "openai", apiKey: "k", baseURL: AZURE_V1, ...extra });
}

function routes(provider: any, request: Partial<ChatCompletionRequest>): boolean {
  return provider.useResponsesApi({ messages: [], ...request });
}

const tools = [
  {
    name: "lookup",
    description: "Look something up",
    parameters: { type: "object", properties: { q: { type: "number" } }, required: ["q"] },
  },
];

// ── routing ──────────────────────────────────────────────────────────────────
describe("responsesApiModels routing", () => {
  it("routes a listed model to Responses with no reasoning config at all", () => {
    expect(routes(openai({ responsesApiModels: ["gpt-6.1-sol"] }), { model: "gpt-6.1-sol", tools })).toBe(true);
  });

  it("matches strings exactly — no prefix, case or family guessing", () => {
    const p = openai({ responsesApiModels: ["gpt-6.1-sol"] });
    expect(routes(p, { model: "gpt-6.1-sol-2" })).toBe(false);
    expect(routes(p, { model: "GPT-6.1-SOL" })).toBe(false);
    expect(routes(p, { model: "gpt-6-luna" })).toBe(false);
  });

  it("leaves unlisted models on today's rule, including the gpt-5 name check", () => {
    const p = openai({ responsesApiModels: ["gpt-6.1-sol"] });
    expect(routes(p, { model: "gpt-4o" })).toBe(false);
    expect(routes(p, { model: "gpt-5.6-terra" })).toBe(false);
    expect(routes(p, { model: "gpt-5.6-terra", reasoning: { effort: "low" } })).toBe(true);
    expect(routes(p, { model: "gpt-4o", reasoning: { effort: "low" } })).toBe(false);
  });

  it("tests RegExp entries, and a /g pattern gives the same answer every call", () => {
    const p = openai({ responsesApiModels: [/^gpt-6/g] });
    for (let i = 0; i < 3; i++) {
      expect(routes(p, { model: "gpt-6-luna" })).toBe(true);
      expect(routes(p, { model: "gpt-5.5" })).toBe(false);
    }
  });

  it("falls back to defaultModel when the request names none", () => {
    expect(routes(openai({ defaultModel: "gpt-6-luna", responsesApiModels: ["gpt-6-luna"] }), {})).toBe(true);
  });

  it("never beats the list", () => {
    const p = openai({ responsesApiModels: ["gpt-6.1-sol"], responsesApi: "never" });
    expect(routes(p, { model: "gpt-6.1-sol", tools, reasoning: { effort: "high" } })).toBe(false);
  });

  it("always is unchanged with or without the list", () => {
    expect(routes(openai({ responsesApi: "always", responsesApiModels: ["x"] }), { model: "gpt-4o" })).toBe(true);
    expect(routes(openai({ responsesApi: "always" }), { model: "gpt-4o" })).toBe(true);
  });

  it("an empty list behaves as no list", () => {
    expect(routes(openai({ responsesApiModels: [] }), { model: "gpt-6.1-sol", tools })).toBe(false);
  });
});

// ── subclasses ───────────────────────────────────────────────────────────────
describe("responsesApiModels does not reach subclasses", () => {
  const optIn = { responsesApiModels: ["gpt-6.1-sol"], responsesStreaming: true } as any;

  it("AzureProvider ignores it even when handed the fields", () => {
    const p = new AzureProvider({ provider: "azure", apiKey: "k", endpoint: "https://r.openai.azure.com", ...optIn });
    expect(routes(p, { model: "gpt-6.1-sol", tools })).toBe(false);
  });

  it("OpenAICompatibleProvider ignores it even when handed the fields", () => {
    const p = new OpenAICompatibleProvider({ provider: "openai-compatible", apiKey: "k", baseURL: "http://x/v1", ...optIn });
    expect(routes(p, { model: "gpt-6.1-sol", tools })).toBe(false);
  });

  it("a user subclass of OpenAIProvider that forwards the config ignores it too", () => {
    class Custom extends OpenAIProvider {}
    const p = new Custom({ provider: "openai", apiKey: "k", ...optIn });
    expect(routes(p, { model: "gpt-6.1-sol", tools })).toBe(false);
  });
});

// ── HTTP helpers ─────────────────────────────────────────────────────────────
function sseOf(events: any[]): string {
  return events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join("");
}

/** Stubs fetch. Each call takes the next scripted reply; records url + parsed body. */
function stubFetch(replies: Array<{ json?: any; sse?: string; status?: number }>) {
  const calls: Array<{ url: string; body: any }> = [];
  let i = 0;
  vi.stubGlobal("fetch", (url: string, init: any) => {
    calls.push({ url, body: JSON.parse(init.body) });
    const reply = replies[Math.min(i++, replies.length - 1)];
    const status = reply.status ?? 200;
    const r: any = { ok: status < 400, status, headers: { get: () => null } };
    r.json = async () => reply.json;
    r.text = async () => JSON.stringify(reply.json ?? "");
    if (reply.sse !== undefined) {
      const enc = new TextEncoder();
      r.body = new ReadableStream<Uint8Array>({ start(c) { c.enqueue(enc.encode(reply.sse)); c.close(); } });
    }
    return Promise.resolve(r);
  });
  return calls;
}

async function collect<T>(gen: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const x of gen) out.push(x);
  return out;
}

const COMPLETED = {
  id: "resp_1",
  model: "gpt-6.1-sol",
  status: "completed",
  output: [
    { type: "reasoning", id: "rs_1", summary: [{ type: "summary_text", text: "Need a lookup." }] },
    { type: "message", content: [{ type: "output_text", text: "Looking it up." }] },
    { type: "function_call", id: "fc_1", call_id: "call_1", name: "lookup", arguments: "{\"q\":42}" },
  ],
  usage: {
    input_tokens: 10,
    output_tokens: 20,
    total_tokens: 30,
    input_tokens_details: { cached_tokens: 2 },
    output_tokens_details: { reasoning_tokens: 7 },
  },
};

/** The same response as COMPLETED, as a Responses event stream. */
const STREAM_EVENTS = [
  { type: "response.created", response: { id: "resp_1", model: "gpt-6.1-sol", status: "in_progress" } },
  { type: "response.output_item.added", output_index: 0, item: { type: "reasoning", id: "rs_1", summary: [] } },
  { type: "response.reasoning_summary_text.delta", item_id: "rs_1", delta: "Need a lookup." },
  { type: "response.output_item.added", output_index: 1, item: { type: "message", id: "msg_1", content: [] } },
  { type: "response.output_text.delta", item_id: "msg_1", delta: "Looking " },
  { type: "response.output_text.delta", item_id: "msg_1", delta: "it up." },
  { type: "response.output_text.done", item_id: "msg_1", text: "Looking it up." },
  {
    type: "response.output_item.added",
    output_index: 2,
    item: { type: "function_call", id: "fc_1", call_id: "call_1", name: "lookup", arguments: "" },
  },
  { type: "response.function_call_arguments.delta", item_id: "fc_1", delta: "{\"q\":" },
  { type: "response.function_call_arguments.delta", item_id: "fc_1", delta: "42}" },
  {
    type: "response.output_item.done",
    output_index: 2,
    item: { type: "function_call", id: "fc_1", call_id: "call_1", name: "lookup", arguments: "{\"q\":42}" },
  },
  { type: "response.completed", response: COMPLETED },
];

const history: ChatCompletionRequest["messages"] = [
  { role: "user", content: "Find 42" },
  { role: "assistant", content: "", toolCalls: [{ id: "call_0", name: "lookup", arguments: "{\"q\":1}" }] },
  { role: "tool", content: "found 1", toolCallId: "call_0" },
];

// ── reasoning translation ────────────────────────────────────────────────────
describe("extra.reasoning_effort on a listed model", () => {
  it("goes to the Azure v1 /responses route as reasoning.effort, value passed through", async () => {
    const calls = stubFetch([{ json: COMPLETED }]);
    const p = openai({ responsesApiModels: ["gpt-6.1-sol"] });
    const res = await p.complete({
      model: "gpt-6.1-sol",
      messages: history,
      tools,
      extra: { reasoning_effort: "xhigh", parallel_tool_calls: false },
    });

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(`${AZURE_V1}/responses`);
    expect(calls[0].body.reasoning).toEqual({ effort: "xhigh" });
    expect(calls[0].body).not.toHaveProperty("reasoning_effort");
    expect(calls[0].body.parallel_tool_calls).toBe(false);
    expect(calls[0].body.tools[0]).toMatchObject({ type: "function", name: "lookup" });
    expect(calls[0].body.input).toEqual([
      { role: "user", content: [{ type: "input_text", text: "Find 42" }] },
      { type: "function_call", call_id: "call_0", name: "lookup", arguments: "{\"q\":1}" },
      { type: "function_call_output", call_id: "call_0", output: "found 1" },
    ]);
    expect(res.toolCalls).toEqual([{ id: "call_1", name: "lookup", arguments: "{\"q\":42}" }]);
    expect(res.finishReason).toBe("tool_calls");
  });

  it("loses to an effort from the request's reasoning config", async () => {
    const calls = stubFetch([{ json: COMPLETED }]);
    await openai({ responsesApiModels: ["gpt-6.1-sol"] }).complete({
      model: "gpt-6.1-sol",
      messages: history,
      extra: { reasoning_effort: "low" },
      reasoning: { effort: "high" },
    });
    expect(calls[0].body.reasoning).toEqual({ effort: "high" });
    expect(calls[0].body).not.toHaveProperty("reasoning_effort");
  });

  it("merges into a reasoning object that carries no effort", async () => {
    const calls = stubFetch([{ json: COMPLETED }]);
    await openai({ responsesApiModels: ["gpt-6.1-sol"] }).complete({
      model: "gpt-6.1-sol",
      messages: history,
      extra: { reasoning_effort: "medium" },
      reasoning: { includeThoughts: true },
    });
    expect(calls[0].body.reasoning).toEqual({ summary: "auto", effort: "medium" });
  });

  it("sends no reasoning field when none was given", async () => {
    const calls = stubFetch([{ json: COMPLETED }]);
    await openai({ responsesApiModels: ["gpt-6.1-sol"] }).complete({ model: "gpt-6.1-sol", messages: history, tools });
    expect(calls[0].body).not.toHaveProperty("reasoning");
    expect(calls[0].body).not.toHaveProperty("reasoning_effort");
  });

  it("re-spells the other chat-only extras /responses rejects", async () => {
    const calls = stubFetch([{ json: COMPLETED }]);
    await openai({ responsesApiModels: ["gpt-6.1-sol"] }).complete({
      model: "gpt-6.1-sol",
      messages: history,
      maxTokens: 100,
      responseFormat: { type: "json_object" },
      extra: {
        max_completion_tokens: 900,
        response_format: { type: "json_schema", json_schema: { name: "o", schema: { type: "object" }, strict: true } },
        stream_options: { include_usage: true },
        store: true,
        prompt_cache_key: "k1",
        parallel_tool_calls: true,
        guided_json: { type: "object" },
      },
    });
    const body = calls[0].body;
    expect(body.max_output_tokens).toBe(900);
    expect(body.text).toEqual({ format: { type: "json_schema", name: "o", schema: { type: "object" }, strict: true } });
    for (const k of ["max_completion_tokens", "max_tokens", "response_format", "stream_options"]) {
      expect(body).not.toHaveProperty(k);
    }
    // Accepted by /responses, or not ours to judge: passed through as given.
    expect(body).toMatchObject({ store: true, prompt_cache_key: "k1", parallel_tool_calls: true, guided_json: { type: "object" } });
  });

  it("maps max_tokens and json_object, and keeps the request's values when extra has none", async () => {
    const calls = stubFetch([{ json: COMPLETED }, { json: COMPLETED }]);
    const p = openai({ responsesApiModels: ["gpt-6.1-sol"] });
    await p.complete({ model: "gpt-6.1-sol", messages: history, extra: { max_tokens: 50, response_format: { type: "json_object" } } });
    expect(calls[0].body).toMatchObject({ max_output_tokens: 50, text: { format: { type: "json_object" } } });

    await p.complete({ model: "gpt-6.1-sol", messages: history, maxTokens: 70, responseFormat: { type: "json_object" } });
    expect(calls[1].body).toMatchObject({ max_output_tokens: 70, text: { format: { type: "json_object" } } });
  });

  it("lets Responses-native fields in extra win over a translated chat spelling", async () => {
    const calls = stubFetch([{ json: COMPLETED }]);
    await openai({ responsesApiModels: ["gpt-6.1-sol"] }).complete({
      model: "gpt-6.1-sol",
      messages: history,
      extra: {
        max_output_tokens: 10,
        max_completion_tokens: 999,
        text: { format: { type: "text" } },
        response_format: { type: "json_object" },
      },
    });
    expect(calls[0].body.max_output_tokens).toBe(10);
    expect(calls[0].body.text).toEqual({ format: { type: "text" } });
    expect(calls[0].body).not.toHaveProperty("max_completion_tokens");
    expect(calls[0].body).not.toHaveProperty("response_format");
  });

  it("drops a response_format: undefined placeholder without touching text", async () => {
    const calls = stubFetch([{ json: COMPLETED }]);
    await openai({ responsesApiModels: ["gpt-6.1-sol"] }).complete({
      model: "gpt-6.1-sol",
      messages: history,
      extra: { response_format: undefined, stream_options: { include_usage: true, include_obfuscation: false } },
    });
    expect(calls[0].body).not.toHaveProperty("text");
    expect(calls[0].body.stream_options).toEqual({ include_obfuscation: false });
  });

  it("is not applied to an unlisted model under responsesApi: always", async () => {
    const calls = stubFetch([{ json: COMPLETED }]);
    await openai({ responsesApi: "always", responsesApiModels: ["gpt-6.1-sol"] }).complete({
      model: "gpt-6-luna",
      messages: history,
      extra: { reasoning_effort: "low" },
    });
    expect(calls[0].body.reasoning_effort).toBe("low");
    expect(calls[0].body).not.toHaveProperty("reasoning");
  });

  it("an unlisted model on the same provider still goes to Chat Completions unchanged", async () => {
    const calls = stubFetch([
      { json: { id: "c", model: "gpt-6-luna", choices: [{ message: { content: "ok" }, finish_reason: "stop" }] } },
    ]);
    await openai({ responsesApiModels: ["gpt-6.1-sol"] }).complete({
      model: "gpt-6-luna",
      messages: history,
      tools,
      extra: { reasoning_effort: "none" },
    });
    expect(calls[0].url).toBe(`${AZURE_V1}/chat/completions`);
    expect(calls[0].body.reasoning_effort).toBe("none");
  });
});

// ── streaming ────────────────────────────────────────────────────────────────
describe("responsesStreaming on a listed model", () => {
  const streamingProvider = () => openai({ responsesApiModels: ["gpt-6.1-sol"], responsesStreaming: true });

  it("asks for a stream and emits deltas as they arrive", async () => {
    const calls = stubFetch([{ sse: sseOf(STREAM_EVENTS) }]);
    const chunks = await collect(
      streamingProvider().completeStream({ model: "gpt-6.1-sol", messages: history, tools, extra: { reasoning_effort: "high" } }),
    );

    expect(calls[0].url).toBe(`${AZURE_V1}/responses`);
    expect(calls[0].body.stream).toBe(true);
    expect(calls[0].body.reasoning).toEqual({ effort: "high" });
    expect(calls[0].body).not.toHaveProperty("reasoning_effort");
    expect(calls[0].body).not.toHaveProperty("stream_options");

    expect(chunks.map((c) => c.delta)).toEqual([
      { content: "Looking " },
      { content: "it up." },
      { toolCalls: [{ id: "call_1", name: "lookup", arguments: "" }] },
      { toolCalls: [{ id: "call_1", arguments: "{\"q\":" }] },
      { toolCalls: [{ id: "call_1", arguments: "42}" }] },
      { reasoning: { summary: "Need a lookup." } },
    ]);
    const last = chunks[chunks.length - 1];
    expect(last).toMatchObject({ id: "resp_1", model: "gpt-6.1-sol", finishReason: "tool_calls" });
    expect(last.usage).toEqual({
      inputTokens: 10,
      outputTokens: 20,
      totalTokens: 30,
      cachedInputTokens: 2,
      cachedWriteTokens: 0,
      cachedOutputTokens: 0,
      reasoningTokens: 7,
    });
  });

  it("assembles, through the adapter, the same message the non-streaming path returns", async () => {
    const model = fromNativeProvider(streamingProvider(), { model: "gpt-6.1-sol" }).bindTools!([
      { name: "lookup", description: "Look something up", schema: tools[0].parameters },
    ] as any);
    const messages = [{ role: "user", content: "Find 42" }] as any[];

    stubFetch([{ sse: sseOf(STREAM_EVENTS) }]);
    const streamed = await collect(model.stream!(messages) as AsyncIterable<any>);
    const textDeltas = streamed.filter((x) => typeof x === "string");
    const assembled = streamed[streamed.length - 1];

    stubFetch([{ json: COMPLETED }]);
    const direct = await model.invoke(messages);

    expect(textDeltas).toEqual(["Looking ", "it up."]);
    expect(assembled.content).toBe(direct.content);
    expect(assembled.tool_calls).toEqual(direct.tool_calls);
    expect(assembled.usage).toEqual(direct.usage);
  });

  it("takes arguments sent only on output_item.done", async () => {
    stubFetch([{
      sse: sseOf([
        { type: "response.created", response: { id: "r", model: "gpt-6.1-sol" } },
        {
          type: "response.output_item.done",
          item: { type: "function_call", id: "fc_9", call_id: "call_9", name: "lookup", arguments: "{\"q\":9}" },
        },
        { type: "response.completed", response: { id: "r", status: "completed", output: [
          { type: "function_call", id: "fc_9", call_id: "call_9", name: "lookup", arguments: "{\"q\":9}" },
        ] } },
      ]),
    }]);
    const chunks = await collect(streamingProvider().completeStream({ model: "gpt-6.1-sol", messages: history, tools }));
    expect(chunks[0].delta.toolCalls).toEqual([{ id: "call_9", name: "lookup", arguments: "{\"q\":9}" }]);
    expect(chunks[chunks.length - 1].finishReason).toBe("tool_calls");
  });

  it("completes the arguments when the deltas stopped short of output_item.done", async () => {
    stubFetch([{
      sse: sseOf([
        { type: "response.output_item.added", item: { type: "function_call", id: "fc_1", call_id: "call_1", name: "lookup", arguments: "" } },
        { type: "response.function_call_arguments.delta", item_id: "fc_1", delta: "{\"q\":" },
        { type: "response.output_item.done", item: { type: "function_call", id: "fc_1", call_id: "call_1", name: "lookup", arguments: "{\"q\":5}" } },
      ]),
    }]);
    const chunks = await collect(streamingProvider().completeStream({ model: "gpt-6.1-sol", messages: history, tools }));
    const args = chunks.flatMap((c) => c.delta.toolCalls ?? []).map((t) => t.arguments).join("");
    expect(args).toBe("{\"q\":5}");
  });

  it("reports an incomplete response as length", async () => {
    stubFetch([{
      sse: sseOf([
        { type: "response.output_text.delta", delta: "partial" },
        { type: "response.incomplete", response: { id: "r", status: "incomplete", output: [
          { type: "message", content: [{ type: "output_text", text: "partial" }] },
        ] } },
      ]),
    }]);
    const chunks = await collect(streamingProvider().completeStream({ model: "gpt-6.1-sol", messages: history }));
    expect(chunks[chunks.length - 1].finishReason).toBe("length");
  });

  it("throws a ProviderError on a stream error event", async () => {
    stubFetch([{ sse: sseOf([{ type: "error", code: "server_error", message: "boom" }]) }]);
    await expect(
      collect(streamingProvider().completeStream({ model: "gpt-6.1-sol", messages: history })),
    ).rejects.toThrow(ProviderError);
  });

  it("throws a ProviderError on response.failed", async () => {
    stubFetch([{ sse: sseOf([{ type: "response.failed", response: { error: { message: "bad" } } }]) }]);
    await expect(
      collect(streamingProvider().completeStream({ model: "gpt-6.1-sol", messages: history })),
    ).rejects.toThrow(/bad/);
  });

  it("surfaces an HTTP error from /responses as before", async () => {
    stubFetch([{ status: 400, json: { error: { message: "nope" } } }]);
    await expect(
      collect(streamingProvider().completeStream({ model: "gpt-6.1-sol", messages: history })),
    ).rejects.toMatchObject({ statusCode: 400 });
  });
});

// ── configuration recipes: future model families without SDK changes ────────
describe("routing GPT-6 and later by pattern, with per-model exceptions", () => {
  /** "gpt-" + a major version of 6 or more (6..9, or any two-plus-digit major),
   * not followed by another digit. Caller configuration, not SDK code. */
  const GPT6_AND_LATER = /^gpt-(?:[6-9]|[1-9]\d+)(?!\d)/i;

  const later = ["gpt-6.1-sol", "gpt-6-luna", "gpt-6", "gpt-6o", "gpt-7", "gpt-7.2-mini", "gpt-8-pro", "gpt-10", "GPT-6.1-SOL"];
  const earlier = ["gpt-5.6-terra", "gpt-5.6-sol", "gpt-5.5", "gpt-5", "gpt-4o", "gpt-4.1-mini", "gpt-oss-120b", "o3-mini", "gpt-3.5-turbo", "my-gpt-6"];

  it("the pattern matches GPT-6 and later and nothing earlier", () => {
    for (const m of later) expect(GPT6_AND_LATER.test(m), m).toBe(true);
    for (const m of earlier) expect(GPT6_AND_LATER.test(m), m).toBe(false);
  });

  it("SDK-only form: auto + patterns, exceptions by lookahead and exact names", () => {
    const p = openai({
      responsesApiModels: [/^(?!gpt-6-luna$)gpt-(?:[6-9]|[1-9]\d+)(?!\d)/i, "my-self-hosted-model"],
    });
    for (const m of later.filter((x) => x !== "gpt-6-luna")) expect(routes(p, { model: m, tools }), m).toBe(true);
    expect(routes(p, { model: "gpt-6-luna", tools })).toBe(false); // forced to Chat Completions
    expect(routes(p, { model: "my-self-hosted-model" })).toBe(true); // forced to Responses
    for (const m of earlier) expect(routes(p, { model: m, tools }), m).toBe(false);
  });

  /** The per-model form: the caller resolves a transport per model (exact
   * override first, then patterns, else Chat Completions) and states it with
   * `always`/`never`. A model resolved to Chat is pinned by `never`, so no
   * later change to patterns, the SDK's `auto` rule or `request.reasoning` can
   * move it. */
  type Transport = "chat" | "responses";
  function resolveTransport(
    model: string,
    cfg: { patterns: Array<string | RegExp>; overrides: Record<string, Transport> },
  ): Transport {
    if (cfg.overrides[model]) return cfg.overrides[model];
    return cfg.patterns.some((p) => (typeof p === "string" ? p === model : p.test(model))) ? "responses" : "chat";
  }
  function providerFor(model: string, cfg: Parameters<typeof resolveTransport>[1]) {
    const responses = resolveTransport(model, cfg) === "responses";
    return openai({
      responsesApi: responses ? "always" : "never",
      responsesApiModels: responses ? [model] : [],
      responsesStreaming: true,
    });
  }
  const cfg = {
    patterns: [GPT6_AND_LATER],
    overrides: { "gpt-6-luna": "chat", "my-self-hosted-model": "responses" } as Record<string, Transport>,
  };

  it("per-model form: routing follows patterns and overrides", () => {
    for (const m of later.filter((x) => x !== "gpt-6-luna")) {
      expect(routes(providerFor(m, cfg), { model: m, tools }), m).toBe(true);
    }
    expect(routes(providerFor("gpt-6-luna", cfg), { model: "gpt-6-luna", tools })).toBe(false);
    expect(routes(providerFor("my-self-hosted-model", cfg), { model: "my-self-hosted-model" })).toBe(true);
  });

  it("per-model form: earlier models stay on Chat even with a reasoning config the auto rule would act on", () => {
    for (const m of earlier) {
      expect(routes(providerFor(m, cfg), { model: m, tools, reasoning: { effort: "high" } }), m).toBe(false);
    }
  });

  it("per-model form: an earlier model's chat body is byte-identical to a plain never provider's", async () => {
    const request: ChatCompletionRequest = {
      model: "gpt-5.6-terra",
      messages: history,
      tools,
      extra: { reasoning_effort: "medium", store: true, parallel_tool_calls: true, max_completion_tokens: 900 },
    };
    const chatJson = { id: "c", model: "m", choices: [{ message: { content: "ok" }, finish_reason: "stop" }] };
    const raw: string[] = [];
    vi.stubGlobal("fetch", (url: string, init: any) => {
      raw.push(`${url} ${init.body}`);
      return Promise.resolve({ ok: true, status: 200, headers: { get: () => null }, json: async () => chatJson });
    });
    await providerFor("gpt-5.6-terra", cfg).complete(structuredClone(request));
    await openai({ responsesApi: "never" }).complete(structuredClone(request));
    expect(raw[0]).toBe(raw[1]);
    expect(raw[0]).toContain("/chat/completions");
  });

  it("per-model form: a future model gets the opt-in path, with effort values passed through unvalidated", async () => {
    const calls = stubFetch([{ json: COMPLETED }]);
    await providerFor("gpt-8-pro", cfg).complete({
      model: "gpt-8-pro",
      messages: history,
      tools,
      // A value no model supports today: the SDK neither validates nor maps it.
      extra: { reasoning_effort: "ultra", max_completion_tokens: 500 },
    });
    expect(calls[0].url).toBe(`${AZURE_V1}/responses`);
    expect(calls[0].body.reasoning).toEqual({ effort: "ultra" });
    expect(calls[0].body.max_output_tokens).toBe(500);
  });
});

describe("without responsesStreaming, or for unlisted models", () => {
  it("a listed model keeps the single-chunk Responses stream", async () => {
    const calls = stubFetch([{ json: COMPLETED }]);
    const chunks = await collect(
      openai({ responsesApiModels: ["gpt-6.1-sol"] }).completeStream({
        model: "gpt-6.1-sol",
        messages: history,
        tools,
        extra: { reasoning_effort: "high" },
      }),
    );
    expect(calls).toHaveLength(1);
    expect(calls[0].body).not.toHaveProperty("stream");
    expect(calls[0].body.reasoning).toEqual({ effort: "high" });
    expect(chunks).toHaveLength(1);
    expect(chunks[0].delta.toolCalls).toEqual([{ id: "call_1", name: "lookup", arguments: "{\"q\":42}" }]);
  });

  it("responsesStreaming alone streams nothing new: always keeps its single chunk", async () => {
    const calls = stubFetch([{ json: COMPLETED }]);
    const chunks = await collect(
      openai({ responsesApi: "always", responsesStreaming: true }).completeStream({ model: "gpt-6.1-sol", messages: history }),
    );
    expect(calls[0].body).not.toHaveProperty("stream");
    expect(chunks).toHaveLength(1);
  });

  it("an unlisted model on a streaming-enabled provider streams Chat Completions as before", async () => {
    const calls = stubFetch([{ sse: 'data: {"id":"c","model":"m","choices":[{"delta":{"content":"hi"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n' }]);
    const chunks = await collect(
      openai({ responsesApiModels: ["gpt-6.1-sol"], responsesStreaming: true }).completeStream({ model: "gpt-4o", messages: history }),
    );
    expect(calls[0].url).toBe(`${AZURE_V1}/chat/completions`);
    expect(calls[0].body.stream).toBe(true);
    expect(chunks[0].delta.content).toBe("hi");
  });
});
