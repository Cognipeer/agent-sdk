/**
 * OpenAI provider: what the Responses body carries (temperature, parallel_tool_calls),
 * the Responses stream that is cut off before `response.completed`, the chat stream's
 * finish reason, and cache writes in the usage of both wire shapes.
 * Every test uses a mock fetch.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { OpenAIProvider } from "../../../src/providers/index.js";
import { ProviderError } from "../../../src/providers/types.js";
import type { ChatCompletionRequest } from "../../../src/providers/types.js";
import { clearLearnedModelRules } from "../../../src/index.js";

beforeEach(() => clearLearnedModelRules());

type Call = { url: string; body: any };

function recorder(respond: (n: number) => Response) {
  const calls: Call[] = [];
  const fn = (async (url: any, init: any = {}) => {
    calls.push({ url: String(url), body: init.body ? JSON.parse(init.body) : undefined });
    return respond(calls.length);
  }) as unknown as typeof fetch;
  return { fn, calls };
}
const json = (d: any, status = 200) => new Response(JSON.stringify(d), { status, headers: { "content-type": "application/json" } });
const enc = new TextEncoder();
const sseStream = (frames: string[]): Response =>
  new Response(
    new ReadableStream({
      start(c) {
        for (const f of frames) c.enqueue(enc.encode(f));
        c.close();
      },
    }),
    { status: 200, headers: { "content-type": "text/event-stream" } },
  );
/** Responses SSE: `event:` + `data:` per event. */
const responsesSse = (events: any[]): Response => sseStream(events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`));
/** Chat Completions SSE: bare `data:` lines, closed with [DONE]. */
const chatSse = (chunks: any[]): Response => sseStream([...chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`), "data: [DONE]\n\n"]);
async function collect<T>(g: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const x of g) out.push(x);
  return out;
}

const NO_RETRY = { maxRetries: 0 };
const msgs = [{ role: "user" as const, content: "hi" }];
const TOOL = { name: "lookup", description: "d", parameters: { type: "object", properties: {} } };
const RESP_OK = { id: "r", model: "m", status: "completed", output: [{ type: "message", content: [{ type: "output_text", text: "ok" }] }], usage: {} };

const responses = (fn: typeof fetch, extra: Record<string, any> = {}) =>
  new OpenAIProvider({ provider: "openai", apiKey: "k", api: "responses", fetch: fn, retry: NO_RETRY, ...extra });
const chat = (fn: typeof fetch) => new OpenAIProvider({ provider: "openai", apiKey: "k", api: "chat", fetch: fn, retry: NO_RETRY });

// ─── OA-14: chat stream finish reason ────────────────────────────────────────

describe("chat stream: finishReason is set only by a chunk that carries one", () => {
  const chunk = (delta: any, finish?: string | null, extra: Record<string, any> = {}) => ({
    id: "c1", model: "gpt-4o", choices: [{ index: 0, delta, ...(finish !== undefined ? { finish_reason: finish } : {}) }], ...extra,
  });
  const stream = async (chunks: any[]) => collect(chat(recorder(() => chatSse(chunks)).fn).completeStream({ model: "gpt-4o", messages: msgs }));

  it("a null or absent finish_reason leaves it unset (still generating, not a stop)", async () => {
    const out = await stream([chunk({ role: "assistant", content: "He" }, null), chunk({ content: "llo" })]);
    expect(out.map((c) => c.delta.content)).toEqual(["He", "llo"]);
    for (const c of out) {
      expect("finishReason" in c).toBe(false);
      expect("rawFinishReason" in c).toBe(false);
    }
  });

  it("the chunk with the reason carries it, with the raw string; a usage-only chunk after it does not", async () => {
    const out = await stream([
      chunk({ role: "assistant", content: "He" }, null),
      chunk({ content: "llo" }, null),
      chunk({}, "stop"),
      { id: "c1", model: "gpt-4o", choices: [], usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 } },
    ]);
    expect(out.map((c) => c.finishReason)).toEqual([undefined, undefined, "stop", undefined]);
    expect(out[2].rawFinishReason).toBe("stop");
    expect(out[3].usage).toMatchObject({ inputTokens: 3, outputTokens: 2, totalTokens: 5 });
    expect("finishReason" in out[3]).toBe(false);
  });

  it.each([
    ["stop", "stop"],
    ["tool_calls", "tool_calls"],
    ["length", "length"],
    ["content_filter", "content_filter"],
    ["some_new_reason", "stop"],
  ])("finish_reason %s maps to %s and is kept raw", async (raw, mapped) => {
    const out = await stream([chunk({ content: "x" }, null), chunk({}, raw)]);
    expect(out[0].finishReason).toBeUndefined();
    expect(out[1].finishReason).toBe(mapped);
    expect(out[1].rawFinishReason).toBe(raw);
  });

  it("a tool-call chunk that is not the last keeps no finish reason either", async () => {
    const out = await stream([
      chunk({ tool_calls: [{ index: 0, id: "call_1", function: { name: "lookup", arguments: "" } }] }, null),
      chunk({ tool_calls: [{ index: 0, function: { arguments: "{}" } }] }, null),
      chunk({}, "tool_calls"),
    ]);
    expect(out.map((c) => c.finishReason)).toEqual([undefined, undefined, "tool_calls"]);
  });
});

// ─── OA-M1: Responses body ───────────────────────────────────────────────────

describe("Responses body: temperature and parallel_tool_calls", () => {
  async function bodyOf(req: Partial<ChatCompletionRequest>, model = "gpt-4o"): Promise<any> {
    const r = recorder(() => json(RESP_OK));
    await responses(r.fn).complete({ model, messages: msgs, ...req });
    return r.calls[0].body;
  }

  it("temperature and top_p go when the model's rule takes sampling", async () => {
    const body = await bodyOf({ temperature: 0.2, topP: 0.9 });
    expect(body.temperature).toBe(0.2);
    expect(body.top_p).toBe(0.9);
    const oss = await bodyOf({ temperature: 0.2, topP: 0.9 }, "gpt-oss-120b");
    expect(oss.temperature).toBe(0.2);
    expect(oss.top_p).toBe(0.9);
  });

  it("neither goes to a reasoning model", async () => {
    const body = await bodyOf({ temperature: 0.2, topP: 0.9 }, "gpt-5.6-terra");
    expect(body).not.toHaveProperty("temperature");
    expect(body).not.toHaveProperty("top_p");
  });

  it("a temperature the server refuses is dropped on the retry and remembered", async () => {
    const events: any[] = [];
    const r = recorder((n) => (n === 1
      ? json({ error: { message: "Unsupported parameter: 'temperature' is not supported with this model.", type: "invalid_request_error", param: "temperature", code: "unsupported_parameter" } }, 400)
      : json(RESP_OK)));
    const p = responses(r.fn, { onModelRuleLearned: (e: any) => events.push(e) });
    await p.complete({ model: "acme-x1", messages: msgs, temperature: 0.3 });
    expect(r.calls[0].body.temperature).toBe(0.3);
    expect(r.calls[1].body).not.toHaveProperty("temperature");
    expect(events.map((e) => e.adjustment)).toEqual(["drop:temperature"]);
    await p.complete({ model: "acme-x1", messages: msgs, temperature: 0.3 });
    expect(r.calls[2].body).not.toHaveProperty("temperature");
  });

  it("parallel_tool_calls goes with tools, when the caller set it", async () => {
    expect((await bodyOf({ tools: [TOOL], parallelToolCalls: false })).parallel_tool_calls).toBe(false);
    expect((await bodyOf({ tools: [TOOL], parallelToolCalls: true })).parallel_tool_calls).toBe(true);
    expect((await bodyOf({ tools: [TOOL], parallelToolCalls: false }, "gpt-5.6-terra")).parallel_tool_calls).toBe(false);
  });

  it("parallel_tool_calls stays out when the caller did not set it, or there are no tools", async () => {
    expect(await bodyOf({ tools: [TOOL] })).not.toHaveProperty("parallel_tool_calls");
    expect(await bodyOf({ parallelToolCalls: false })).not.toHaveProperty("parallel_tool_calls");
  });

  it("seed, stop, penalties, logprobs and n have no Responses equivalent here and stay out", async () => {
    const body = await bodyOf({ seed: 7, stop: ["END"], presencePenalty: 0.1, frequencyPenalty: 0.2, logprobs: true, topLogprobs: 2, n: 2, maxTokens: 64 });
    for (const key of ["seed", "stop", "presence_penalty", "frequency_penalty", "logprobs", "top_logprobs", "n"]) {
      expect(body).not.toHaveProperty(key);
    }
    expect(body.max_output_tokens).toBe(64);
  });

  it("the streaming Responses call carries them too", async () => {
    const r = recorder(() => responsesSse([
      { type: "response.completed", response: { id: "r", model: "gpt-4o", status: "completed", output: [], usage: {} } },
    ]));
    await collect(responses(r.fn).completeStream({ model: "gpt-4o", messages: msgs, temperature: 0.4, tools: [TOOL], parallelToolCalls: false }));
    expect(r.calls[0].body).toMatchObject({ stream: true, temperature: 0.4, parallel_tool_calls: false });
  });
});

// ─── OA-M2: a Responses stream cut off before response.completed ─────────────

describe("Responses stream that ends before response.completed", () => {
  const created = { type: "response.created", response: { id: "r1", model: "gpt-x" } };
  const delta = (text: string) => ({ type: "response.output_text.delta", item_id: "m", delta: text });
  const completed = { type: "response.completed", response: { id: "r1", model: "gpt-x", status: "completed", output: [], usage: {} } };

  async function drain(p: OpenAIProvider, req: Partial<ChatCompletionRequest> = {}) {
    const seen: any[] = [];
    let error: unknown;
    try {
      for await (const c of p.completeStream({ model: "gpt-x", messages: msgs, ...req })) seen.push(c);
    } catch (e) {
      error = e;
    }
    return { seen, error };
  }

  it("is an error, after the deltas that did arrive: a retryable 502 ProviderError", async () => {
    const r = recorder(() => responsesSse([created, delta("Hel"), delta("lo")]));
    const { seen, error } = await drain(responses(r.fn));
    expect(seen.map((c) => c.delta)).toEqual([{ content: "Hel" }, { content: "lo" }]);
    expect(error).toBeInstanceOf(ProviderError);
    expect((error as ProviderError).message).toBe("Responses stream ended before response.completed");
    expect((error as ProviderError).statusCode).toBe(502);
    expect((error as ProviderError).provider).toBe("openai");
  });

  it("an empty body is the same error", async () => {
    const r = recorder(() => responsesSse([]));
    const { seen, error } = await drain(responses(r.fn));
    expect(seen).toEqual([]);
    expect((error as ProviderError).statusCode).toBe(502);
  });

  it("a [DONE] without the terminal event is the same error", async () => {
    const r = recorder(() => sseStream([`event: response.created\ndata: ${JSON.stringify(created)}\n\n`, "data: [DONE]\n\n"]));
    const { error } = await drain(responses(r.fn));
    expect((error as ProviderError).message).toBe("Responses stream ended before response.completed");
  });

  it("response.completed ends it cleanly", async () => {
    const r = recorder(() => responsesSse([created, delta("Hi"), completed]));
    const { seen, error } = await drain(responses(r.fn));
    expect(error).toBeUndefined();
    expect(seen[seen.length - 1].finishReason).toBe("stop");
  });

  it("response.incomplete is a terminal event too (a limit hit, not a cut-off)", async () => {
    const r = recorder(() => responsesSse([
      created,
      delta("Hi"),
      { type: "response.incomplete", response: { id: "r1", model: "gpt-x", status: "incomplete", incomplete_details: { reason: "max_output_tokens" }, output: [], usage: {} } },
    ]));
    const { seen, error } = await drain(responses(r.fn));
    expect(error).toBeUndefined();
    expect(seen[seen.length - 1].finishReason).toBe("length");
  });

  it("a call the caller cancelled is not reported as a cut-off stream", async () => {
    const ac = new AbortController();
    let close!: () => void;
    const fn = (async () =>
      new Response(
        new ReadableStream({
          start(c) {
            c.enqueue(enc.encode(`event: response.created\ndata: ${JSON.stringify(created)}\n\n`));
            c.enqueue(enc.encode(`event: response.output_text.delta\ndata: ${JSON.stringify(delta("Hel"))}\n\n`));
            close = () => c.close();
          },
        }),
        { status: 200, headers: { "content-type": "text/event-stream" } },
      )) as unknown as typeof fetch;
    const gen = responses(fn).completeStream({ model: "gpt-x", messages: msgs, signal: ac.signal });
    const first = await gen.next();
    expect(first.value.delta).toEqual({ content: "Hel" });
    // The generator is now waiting on the body; the call is cancelled, then the body closes.
    const second = gen.next();
    await new Promise((resolve) => setTimeout(resolve, 0));
    ac.abort();
    close();
    let error: unknown;
    try {
      let step = await second;
      while (!step.done) step = await gen.next();
    } catch (e) {
      error = e;
    }
    // Whatever the generator does with a cancelled call, it does not claim the upstream cut it off.
    expect(error instanceof ProviderError && /before response\.completed/.test(error.message)).toBe(false);
  });

  it("the non-streaming Responses call is unaffected", async () => {
    const r = recorder(() => json({ id: "r", model: "gpt-x", status: "completed", output: [{ type: "message", content: [{ type: "output_text", text: "ok" }] }], usage: {} }));
    expect((await responses(r.fn).complete({ model: "gpt-x", messages: msgs })).content).toBe("ok");
  });
});

// ─── USAGE-OA: cache writes, inclusive basis ─────────────────────────────────

describe("usage: cache_write_tokens is a cache write, input_tokens stays inclusive", () => {
  const responsesUsage = {
    input_tokens: 1000,
    output_tokens: 50,
    total_tokens: 1050,
    input_tokens_details: { cached_tokens: 600, cache_write_tokens: 200 },
    output_tokens_details: { reasoning_tokens: 20 },
  };
  const EXPECTED = { inputTokens: 1000, outputTokens: 50, totalTokens: 1050, cachedInputTokens: 600, cachedWriteTokens: 200, reasoningTokens: 20 };

  it("Responses, complete", async () => {
    const r = recorder(() => json({ ...RESP_OK, usage: responsesUsage }));
    expect((await responses(r.fn).complete({ model: "gpt-5.6-terra", messages: msgs })).usage).toMatchObject(EXPECTED);
  });

  it("Responses, stream: the final chunk", async () => {
    const r = recorder(() => responsesSse([
      { type: "response.created", response: { id: "r1", model: "gpt-5.6-terra" } },
      { type: "response.completed", response: { id: "r1", model: "gpt-5.6-terra", status: "completed", output: [], usage: responsesUsage } },
    ]));
    const chunks = await collect(responses(r.fn).completeStream({ model: "gpt-5.6-terra", messages: msgs }));
    expect(chunks[chunks.length - 1].usage).toMatchObject(EXPECTED);
  });

  it("Chat Completions, complete and stream (prompt_tokens_details.cache_write_tokens)", async () => {
    const usage = {
      prompt_tokens: 1000,
      completion_tokens: 50,
      total_tokens: 1050,
      prompt_tokens_details: { cached_tokens: 600, cache_write_tokens: 200 },
      completion_tokens_details: { reasoning_tokens: 20 },
    };
    const done = await chat(recorder(() => json({ id: "c", model: "m", choices: [{ message: { role: "assistant", content: "ok" }, finish_reason: "stop" }], usage })).fn)
      .complete({ model: "gpt-4o", messages: msgs });
    expect(done.usage).toMatchObject(EXPECTED);
    const out = await collect(chat(recorder(() => chatSse([
      { id: "c", model: "m", choices: [{ index: 0, delta: { content: "ok" }, finish_reason: "stop" }] },
      { id: "c", model: "m", choices: [], usage },
    ])).fn).completeStream({ model: "gpt-4o", messages: msgs }));
    expect(out[out.length - 1].usage).toMatchObject(EXPECTED);
  });

  it("a cache write is not added to an input that already counts it", async () => {
    const r = recorder(() => json({ ...RESP_OK, usage: { ...responsesUsage, input_tokens: 800, total_tokens: 850 } }));
    const usage = (await responses(r.fn).complete({ model: "gpt-5.6-terra", messages: msgs })).usage;
    // 600 read + 200 written = 800 = the whole input: nothing is added back.
    expect(usage).toMatchObject({ inputTokens: 800, cachedInputTokens: 600, cachedWriteTokens: 200 });
  });

  it("a server that leaves the cache out of the input has it added back", async () => {
    const r = recorder(() => json({ ...RESP_OK, usage: { input_tokens: 100, output_tokens: 10, input_tokens_details: { cached_tokens: 90, cache_write_tokens: 20 } } }));
    const usage = (await responses(r.fn).complete({ model: "gpt-5.6-terra", messages: msgs })).usage;
    expect(usage).toMatchObject({ inputTokens: 210, cachedInputTokens: 90, cachedWriteTokens: 20 });
  });

  it("no cache_write_tokens means no cache write", async () => {
    const r = recorder(() => json({ ...RESP_OK, usage: { input_tokens: 10, output_tokens: 2, input_tokens_details: { cached_tokens: 4 } } }));
    const usage = (await responses(r.fn).complete({ model: "gpt-5.6-terra", messages: msgs })).usage;
    expect(usage).toMatchObject({ inputTokens: 10, cachedInputTokens: 4, cachedWriteTokens: 0 });
  });
});
