/**
 * Responses API reasoning replay. A reasoning model's output carries reasoning
 * items with `encrypted_content`; a tool loop hands them back, right before the
 * item they preceded, so the model keeps its chain of thought across the calls
 * of one run. OpenAI and OpenAI-compatible servers get the item without its `id`
 * (self-contained); Azure gets it with the `id`, and the function call it preceded
 * with its `fc_...` id. An endpoint that refuses a replayed item costs one extra
 * request, never the call. Every test uses a mock fetch.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { AzureProvider, OpenAIProvider } from "../../../src/providers/index.js";
import { fromNativeProvider } from "../../../src/providers/adapter.js";
import { ProviderError, type ChatCompletionRequest, type UnifiedMessage } from "../../../src/providers/types.js";
import { ModelRequestError, clearLearnedModelRules, listLearnedModelRules } from "../../../src/index.js";

beforeEach(() => clearLearnedModelRules());

type Call = { url: string; body: any; headers: Record<string, string> };

function recorder(respond: (n: number) => Response) {
  const calls: Call[] = [];
  const fn = (async (url: any, init: any = {}) => {
    calls.push({ url: String(url), body: init.body ? JSON.parse(init.body) : undefined, headers: init.headers ?? {} });
    return respond(calls.length);
  }) as unknown as typeof fetch;
  return { fn, calls };
}
const json = (d: any, status = 200) => new Response(JSON.stringify(d), { status, headers: { "content-type": "application/json" } });
const badRequest = (message: string, param: string | null = null, status = 400) =>
  json({ error: { message, type: "invalid_request_error", param, code: null } }, status);
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
async function collect<T>(g: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const x of g) out.push(x);
  return out;
}

const MODEL = "gpt-5.6-terra";
const NO_RETRY = { maxRetries: 0 };
const OPENAI_ORIGIN = `openai|https://api.openai.com/v1|${MODEL}`;
const AZURE_ORIGIN = `azure|https://res.openai.azure.com|${MODEL}`;

function openai(fn: typeof fetch, extra: Record<string, any> = {}): OpenAIProvider {
  return new OpenAIProvider({ provider: "openai", apiKey: "k", api: "responses", fetch: fn, retry: NO_RETRY, ...extra });
}
function azure(fn: typeof fetch, extra: Record<string, any> = {}): OpenAIProvider {
  return new AzureProvider({ provider: "azure", apiKey: "k", endpoint: "https://res.openai.azure.com", api: "responses", fetch: fn, retry: NO_RETRY, ...extra });
}

// ─── Wire fixtures ───────────────────────────────────────────────────────────

const ENC = "enc-blob-1";
const SUMMARY = [{ type: "summary_text", text: "thought" }];
/** A reasoning output item as the API returns it; `enc: null` is one without `encrypted_content`. */
const reasoningItem = (id: string, enc: string | null = ENC, extra: Record<string, any> = {}) => ({
  type: "reasoning", id, status: "completed", summary: SUMMARY, ...(enc ? { encrypted_content: enc } : {}), ...extra,
});
const messageItem = (text: string) => ({ type: "message", id: "msg_1", status: "completed", role: "assistant", content: [{ type: "output_text", text }] });
const callItem = (n: number, args = "{}") => ({ type: "function_call", id: `fc_${n}`, call_id: `call_${n}`, name: "lookup", arguments: args, status: "completed" });
const response = (output: any[]) => ({
  id: "resp_1", model: MODEL, status: "completed", output, usage: { input_tokens: 5, output_tokens: 6, total_tokens: 11 },
});
const created = { type: "response.created", response: { id: "resp_1", model: MODEL } };
const completed = (output: any[]) => ({ type: "response.completed", response: response(output) });

// ─── Unified-side fixtures ───────────────────────────────────────────────────

const TOOL = { name: "lookup", description: "d", parameters: { type: "object", properties: { q: { type: "number" } } } };
const USER: UnifiedMessage = { role: "user", content: "find it" };
/** A `thinking` block as `captureReasoningBlocks` leaves it on `reasoning.blocks`. */
const block = (next: string, item: any, nextId?: string, origin = OPENAI_ORIGIN) => ({
  type: "thinking" as const,
  text: "thought",
  openaiResponses: { item, origin, next, ...(nextId ? { nextId } : {}) },
});
const assistantCall = (n: number, blocks: any[], text = ""): UnifiedMessage => ({
  role: "assistant",
  content: text,
  toolCalls: [{ id: `call_${n}`, name: "lookup", arguments: "{\"q\":1}" }],
  ...(blocks.length > 0 ? { reasoning: { blocks } } : {}),
});
const toolResult = (n: number): UnifiedMessage => ({ role: "tool", toolCallId: `call_${n}`, content: `result ${n}` });

// What goes on the wire for the pieces above.
const userInput = { role: "user", content: [{ type: "input_text", text: "find it" }] };
const callInput = (n: number) => ({ type: "function_call", call_id: `call_${n}`, name: "lookup", arguments: "{\"q\":1}" });
const outputInput = (n: number) => ({ type: "function_call_output", call_id: `call_${n}`, output: `result ${n}` });
/** The replayed reasoning item for OpenAI: no `id`, no `status`. */
const replayed = (enc = ENC) => ({ type: "reasoning", summary: SUMMARY, encrypted_content: enc });

/** The first request body a call sends, answered with a plain message. */
async function sent(
  messages: UnifiedMessage[],
  make: (fn: typeof fetch) => OpenAIProvider = openai,
  req: Partial<ChatCompletionRequest> = {},
): Promise<any> {
  const r = recorder(() => json(response([messageItem("ok")])));
  await make(r.fn).complete({ model: MODEL, messages, tools: [TOOL], ...req });
  return r.calls[0].body;
}

// ─── include ─────────────────────────────────────────────────────────────────

describe("include: reasoning.encrypted_content", () => {
  it("is asked for on a reasoning model, tools or not", async () => {
    expect((await sent([USER])).include).toEqual(["reasoning.encrypted_content"]);
    expect((await sent([USER], openai, { tools: undefined })).include).toEqual(["reasoning.encrypted_content"]);
  });

  it("is asked for on Azure from api-version 2025-04-01-preview and on the v1 route", async () => {
    for (const apiVersion of ["2025-04-01-preview", "2025-06-01", "v1", "preview"]) {
      const make = (fn: typeof fetch) => azure(fn, { apiVersion });
      expect((await sent([USER], make)).include, apiVersion).toEqual(["reasoning.encrypted_content"]);
    }
  });

  it("is left out on Azure's earlier dated api-versions, where encrypted reasoning does not exist", async () => {
    for (const apiVersion of ["2025-03-01-preview", "2024-10-21"]) {
      const make = (fn: typeof fetch) => azure(fn, { apiVersion });
      expect((await sent([USER], make)).include, apiVersion).toBeUndefined();
    }
  });

  it("keeps the caller's own include and adds ours once", async () => {
    const merged = await sent([USER], openai, { extra: { include: ["message.output_text.logprobs"] } });
    expect(merged.include).toEqual(["message.output_text.logprobs", "reasoning.encrypted_content"]);
    const dup = await sent([USER], openai, { extra: { include: ["reasoning.encrypted_content"] } });
    expect(dup.include).toEqual(["reasoning.encrypted_content"]);
  });

  it("extra.include: null opts out", async () => {
    const body = await sent([USER], openai, { extra: { include: null } });
    expect(body.include).toBeNull();
  });

  it.each(["gpt-4o", "gpt-5-chat-latest", "gpt-oss-120b", "acme-x1"])("is not sent for %s (not a reasoning model)", async (model) => {
    expect((await sent([USER], openai, { model })).include).toBeUndefined();
  });

  it("a 400 'Encrypted content is not supported with this model' drops it, and the model is remembered", async () => {
    const events: any[] = [];
    const r = recorder((n) => (n === 1
      ? badRequest("Encrypted content is not supported with this model.", "include")
      : json(response([messageItem("ok")]))));
    const p = openai(r.fn, { onModelRuleLearned: (e: any) => events.push(e) });
    const res = await p.complete({ model: MODEL, messages: [USER] });
    expect(res.content).toBe("ok");
    expect(r.calls).toHaveLength(2);
    expect(r.calls[0].body.include).toEqual(["reasoning.encrypted_content"]);
    expect(r.calls[1].body.include).toBeUndefined();
    expect(events.map((e) => e.adjustment)).toEqual(["drop:include"]);
    // The next call is right first time.
    await p.complete({ model: MODEL, messages: [USER] });
    expect(r.calls).toHaveLength(3);
    expect(r.calls[2].body.include).toBeUndefined();
  });

  it("an include the caller set is corrected for that call and never learned", async () => {
    const r = recorder((n) => (n === 1
      ? badRequest("Encrypted content is not supported with this model.", "include")
      : json(response([messageItem("ok")]))));
    const res = await openai(r.fn).complete({ model: MODEL, messages: [USER], extra: { include: ["reasoning.encrypted_content"] } });
    expect(res.content).toBe("ok");
    expect(r.calls[1].body.include).toBeUndefined();
    expect(listLearnedModelRules()).toEqual([]);
  });
});

// ─── capture ─────────────────────────────────────────────────────────────────

describe("capture: reasoning items kept on reasoning.blocks", () => {
  const complete = async (output: any[], make: (fn: typeof fetch) => OpenAIProvider = openai) => {
    const r = recorder(() => json(response(output)));
    return make(r.fn).complete({ model: MODEL, messages: [USER], tools: [TOOL] });
  };

  it("a reasoning item followed by a function call is kept as it came, with the call it preceded", async () => {
    const res = await complete([reasoningItem("rs_1"), callItem(1)]);
    expect(res.toolCalls).toEqual([{ id: "call_1", name: "lookup", arguments: "{}" }]);
    expect(res.reasoning?.summary).toBe("thought");
    expect(res.reasoning?.blocks).toEqual([block("call:call_1", reasoningItem("rs_1"), "fc_1")]);
  });

  it("followed by a message: next is the message, there is no call id to keep", async () => {
    const res = await complete([reasoningItem("rs_1"), messageItem("Let me check."), callItem(1)]);
    expect(res.reasoning?.blocks).toEqual([block("message", reasoningItem("rs_1"))]);
  });

  it("consecutive items stay together, in order, each on the call that follows them", async () => {
    const res = await complete([reasoningItem("rs_1", "enc-a"), reasoningItem("rs_2", "enc-b"), callItem(1), callItem(2)]);
    expect(res.reasoning?.blocks?.map((b: any) => [b.openaiResponses.item.id, b.openaiResponses.next, b.openaiResponses.nextId])).toEqual([
      ["rs_1", "call:call_1", "fc_1"],
      ["rs_2", "call:call_1", "fc_1"],
    ]);
  });

  it("interleaved items each point at their own call", async () => {
    const res = await complete([reasoningItem("rs_1", "enc-a"), callItem(1), reasoningItem("rs_2", "enc-b"), callItem(2)]);
    expect(res.reasoning?.blocks?.map((b: any) => [b.openaiResponses.item.id, b.openaiResponses.next])).toEqual([
      ["rs_1", "call:call_1"],
      ["rs_2", "call:call_2"],
    ]);
  });

  it("only an item with encrypted_content is kept (the summary still shows)", async () => {
    const res = await complete([reasoningItem("rs_1", null), callItem(1)]);
    expect(res.reasoning?.blocks).toBeUndefined();
    expect(res.reasoning?.summary).toBe("thought");
    const empty = await complete([reasoningItem("rs_1", null, { encrypted_content: "" }), callItem(1)]);
    expect(empty.reasoning?.blocks).toBeUndefined();
  });

  it("a final answer has nothing to hand back", async () => {
    const res = await complete([reasoningItem("rs_1"), messageItem("The answer.")]);
    expect(res.content).toBe("The answer.");
    expect(res.reasoning?.blocks).toBeUndefined();
  });

  it("an item with nothing after it cannot go back and is left out", async () => {
    const res = await complete([callItem(1), reasoningItem("rs_1")]);
    expect(res.reasoning?.blocks).toBeUndefined();
  });

  it("the origin is provider, endpoint and model; Azure names the resource, not the OpenAI base URL", async () => {
    const o = await complete([reasoningItem("rs_1"), callItem(1)]);
    expect((o.reasoning?.blocks?.[0] as any).openaiResponses.origin).toBe(OPENAI_ORIGIN);
    const a = await complete([reasoningItem("rs_1"), callItem(1)], azure);
    expect((a.reasoning?.blocks?.[0] as any).openaiResponses).toEqual({
      item: reasoningItem("rs_1"), origin: AZURE_ORIGIN, next: "call:call_1", nextId: "fc_1",
    });
  });

  it("streaming: the blocks come from the completed response", async () => {
    const r = recorder(() => sse([
      created,
      { type: "response.output_item.added", item: { type: "function_call", id: "fc_1", call_id: "call_1", name: "lookup", arguments: "" } },
      { type: "response.function_call_arguments.delta", item_id: "fc_1", delta: "{}" },
      completed([reasoningItem("rs_1"), callItem(1)]),
    ]));
    const chunks = await collect(openai(r.fn).completeStream({ model: MODEL, messages: [USER], tools: [TOOL] }));
    const last = chunks[chunks.length - 1];
    expect(last.finishReason).toBe("tool_calls");
    expect(last.delta.reasoning?.blocks).toEqual([block("call:call_1", reasoningItem("rs_1"), "fc_1")]);
    expect(last.delta.reasoning?.summary).toBe("thought");
    expect(chunks.flatMap((c) => c.delta.toolCalls ?? []).map((t) => t.id)).toEqual(["call_1", "call_1"]);
  });

  it("streaming: a completed event without output falls back to the finished items", async () => {
    const r = recorder(() => sse([
      created,
      { type: "response.output_item.done", item: reasoningItem("rs_1") },
      { type: "response.output_item.done", item: callItem(1) },
      completed([]),
    ]));
    const chunks = await collect(openai(r.fn).completeStream({ model: MODEL, messages: [USER], tools: [TOOL] }));
    const last = chunks[chunks.length - 1];
    expect(last.delta.reasoning?.blocks).toEqual([block("call:call_1", reasoningItem("rs_1"), "fc_1")]);
  });

  it("streaming: a summary that already went out as deltas is not repeated beside the blocks", async () => {
    const r = recorder(() => sse([
      created,
      { type: "response.reasoning_summary_text.delta", item_id: "rs_1", delta: "thought" },
      completed([reasoningItem("rs_1"), callItem(1)]),
    ]));
    const chunks = await collect(openai(r.fn).completeStream({ model: MODEL, messages: [USER], tools: [TOOL] }));
    expect(chunks[0].delta).toEqual({ reasoning: { summary: "thought" } });
    expect(chunks[chunks.length - 1].delta).toEqual({ reasoning: { blocks: [block("call:call_1", reasoningItem("rs_1"), "fc_1")] } });
  });
});

// ─── replay ──────────────────────────────────────────────────────────────────

describe("replay: reasoning items of the tool loop in progress go back", () => {
  it("before the function call they preceded, without id or status", async () => {
    const body = await sent([USER, assistantCall(1, [block("call:call_1", reasoningItem("rs_1"), "fc_1")]), toolResult(1)]);
    expect(body.input).toEqual([userInput, replayed(), callInput(1), outputInput(1)]);
    expect(body.input[1]).not.toHaveProperty("id");
    expect(body.input[1]).not.toHaveProperty("status");
    expect(body.input[2]).not.toHaveProperty("id");
  });

  it("before the message they preceded when text came first", async () => {
    const body = await sent([USER, assistantCall(1, [block("message", reasoningItem("rs_1"))], "Let me check."), toolResult(1)]);
    expect(body.input).toEqual([
      userInput,
      replayed(),
      { role: "assistant", content: [{ type: "output_text", text: "Let me check." }] },
      callInput(1),
      outputInput(1),
    ]);
  });

  it("reasoning text the server gave is kept; an empty one is not sent", async () => {
    const content = [{ type: "reasoning_text", text: "raw thought" }];
    const withContent = await sent([USER, assistantCall(1, [block("call:call_1", reasoningItem("rs_1", ENC, { content }))]), toolResult(1)]);
    expect(withContent.input[1]).toEqual({ ...replayed(), content });
    const empty = await sent([USER, assistantCall(1, [block("call:call_1", reasoningItem("rs_1", ENC, { content: [] }))]), toolResult(1)]);
    expect(empty.input[1]).toEqual(replayed());
  });

  it("a call with several reasoning items before it gets all of them, in order", async () => {
    const body = await sent([
      USER,
      assistantCall(1, [block("call:call_1", reasoningItem("rs_1", "enc-a")), block("call:call_1", reasoningItem("rs_2", "enc-b"))]),
      toolResult(1),
    ]);
    expect(body.input).toEqual([userInput, replayed("enc-a"), replayed("enc-b"), callInput(1), outputInput(1)]);
  });

  it("every turn of the loop in progress goes back, each before its own call", async () => {
    const body = await sent([
      USER,
      assistantCall(1, [block("call:call_1", reasoningItem("rs_1", "enc-a"))]),
      toolResult(1),
      assistantCall(2, [block("call:call_2", reasoningItem("rs_2", "enc-b"))]),
      toolResult(2),
    ]);
    expect(body.input).toEqual([userInput, replayed("enc-a"), callInput(1), outputInput(1), replayed("enc-b"), callInput(2), outputInput(2)]);
  });

  it("only the assistant turns after the last user message", async () => {
    const body = await sent([
      { role: "user", content: "earlier question" },
      assistantCall(1, [block("call:call_1", reasoningItem("rs_old", "enc-old"))]),
      toolResult(1),
      { role: "assistant", content: "earlier answer" },
      USER,
      assistantCall(2, [block("call:call_2", reasoningItem("rs_new", "enc-new"))]),
      toolResult(2),
    ]);
    const reasoning = body.input.filter((i: any) => i.type === "reasoning");
    expect(reasoning).toEqual([replayed("enc-new")]);
    expect(JSON.stringify(body)).not.toContain("enc-old");
  });

  it("an item whose follower is not in the turn is left out, never sent without it", async () => {
    const stranded = await sent([USER, assistantCall(1, [block("call:call_9", reasoningItem("rs_1"))]), toolResult(1)]);
    expect(stranded.input.some((i: any) => i.type === "reasoning")).toBe(false);
    const noText = await sent([USER, assistantCall(1, [block("message", reasoningItem("rs_1"))]), toolResult(1)]);
    expect(noText.input.some((i: any) => i.type === "reasoning")).toBe(false);
  });

  it("a block of another origin is ignored: other model, other base URL, other provider", async () => {
    for (const origin of [
      `openai|https://api.openai.com/v1|gpt-5.5-sol`,
      `openai|https://proxy.example/v1|${MODEL}`,
      AZURE_ORIGIN,
    ]) {
      const body = await sent([USER, assistantCall(1, [block("call:call_1", reasoningItem("rs_1"), "fc_1", origin)]), toolResult(1)]);
      expect(body.input).toEqual([userInput, callInput(1), outputInput(1)]);
    }
  });

  it("blocks of other providers are ignored", async () => {
    const body = await sent([
      USER,
      assistantCall(1, [
        { type: "thinking", text: "claude thought", signature: "sig" },
        { type: "redacted_thinking", data: "opaque" },
        { type: "thinking", thoughtSignature: "ts" },
      ]),
      toolResult(1),
    ]);
    expect(body.input).toEqual([userInput, callInput(1), outputInput(1)]);
  });

  it("an item without encrypted_content, or a block without its position, is ignored", async () => {
    const body = await sent([
      USER,
      assistantCall(1, [
        block("call:call_1", reasoningItem("rs_1", null)),
        block("call:call_1", reasoningItem("rs_2", null, { encrypted_content: "" })),
        { ...block("call:call_1", reasoningItem("rs_3")), openaiResponses: { item: reasoningItem("rs_3"), origin: OPENAI_ORIGIN } },
      ]),
      toolResult(1),
    ]);
    expect(body.input).toEqual([userInput, callInput(1), outputInput(1)]);
  });

  it("a turn without reasoning blocks is sent exactly as before", async () => {
    const body = await sent([USER, assistantCall(1, []), toolResult(1)]);
    expect(body.input).toEqual([userInput, callInput(1), outputInput(1)]);
  });
});

// ─── an endpoint that refuses the replay ─────────────────────────────────────

describe("an endpoint that refuses a replayed reasoning item", () => {
  const LOOP = [USER, assistantCall(1, [block("call:call_1", reasoningItem("rs_1"), "fc_1")]), toolResult(1)];
  const hasReasoning = (body: any) => body.input.some((i: any) => i.type === "reasoning");
  const REFUSAL = "Item 'rs_1' of type 'reasoning' was provided without its required following item.";

  it.each([400, 422])("a %i that no adjustment explains: once more without the items, and remembered", async (status) => {
    const r = recorder((n) => (n === 1 ? badRequest(REFUSAL, "input", status) : json(response([messageItem("done")]))));
    const p = openai(r.fn);
    const res = await p.complete({ model: MODEL, messages: LOOP, tools: [TOOL] });
    expect(res.content).toBe("done");
    expect(r.calls).toHaveLength(2);
    expect(hasReasoning(r.calls[0].body)).toBe(true);
    expect(hasReasoning(r.calls[1].body)).toBe(false);
    expect(r.calls[1].body.input).toEqual([userInput, callInput(1), outputInput(1)]);
    // Not tried again for that endpoint and model.
    await p.complete({ model: MODEL, messages: LOOP, tools: [TOOL] });
    expect(r.calls).toHaveLength(3);
    expect(hasReasoning(r.calls[2].body)).toBe(false);
  });

  it("another model on the same instance is not affected", async () => {
    const r = recorder((n) => (n === 1 ? badRequest(REFUSAL, "input") : json(response([messageItem("done")]))));
    const p = openai(r.fn);
    await p.complete({ model: MODEL, messages: LOOP, tools: [TOOL] });
    const other = LOOP.map((m, i) => (i === 1 ? assistantCall(1, [block("call:call_1", reasoningItem("rs_1"), "fc_1", `openai|https://api.openai.com/v1|gpt-6.1-sol`)]) : m));
    await p.complete({ model: "gpt-6.1-sol", messages: other, tools: [TOOL] });
    expect(hasReasoning(r.calls[2].body)).toBe(true);
  });

  it("a 400 an adjustment explains is not blamed on the reasoning items", async () => {
    const r = recorder((n) => (n === 1 ? badRequest("Unsupported parameter: 'service_tier' is not supported.", "service_tier") : json(response([messageItem("done")]))));
    const p = openai(r.fn);
    await p.complete({ model: MODEL, messages: LOOP, tools: [TOOL], extra: { service_tier: "flex" } });
    expect(r.calls).toHaveLength(2);
    expect(r.calls[1].body.service_tier).toBeUndefined();
    expect(hasReasoning(r.calls[1].body)).toBe(true);
    await p.complete({ model: MODEL, messages: LOOP, tools: [TOOL] });
    expect(hasReasoning(r.calls[2].body)).toBe(true);
  });

  it("not remembered when the request fails without the items as well", async () => {
    const r = recorder((n) => (n <= 2 ? badRequest("Invalid schema for function 'lookup'.", "tools") : json(response([messageItem("done")]))));
    const p = openai(r.fn);
    await expect(p.complete({ model: MODEL, messages: LOOP, tools: [TOOL] })).rejects.toBeInstanceOf(ModelRequestError);
    expect(r.calls).toHaveLength(2);
    expect(hasReasoning(r.calls[0].body)).toBe(true);
    expect(hasReasoning(r.calls[1].body)).toBe(false);
    await p.complete({ model: MODEL, messages: LOOP, tools: [TOOL] });
    expect(hasReasoning(r.calls[2].body)).toBe(true);
  });

  it("a 5xx is not a refusal: no second request", async () => {
    const r = recorder(() => json({ error: { message: "overloaded" } }, 500));
    const err: any = await openai(r.fn).complete({ model: MODEL, messages: LOOP, tools: [TOOL] }).catch((e) => e);
    expect(err).toBeInstanceOf(ProviderError);
    expect(err.statusCode).toBe(500);
    expect(r.calls).toHaveLength(1);
  });

  it("a request that carried no reasoning items fails as it always did", async () => {
    const r = recorder(() => badRequest(REFUSAL, "input"));
    await expect(openai(r.fn).complete({ model: MODEL, messages: [USER], tools: [TOOL] })).rejects.toBeInstanceOf(ModelRequestError);
    expect(r.calls).toHaveLength(1);
  });

  it("streaming takes the same way out", async () => {
    const r = recorder((n) => (n === 1 ? badRequest(REFUSAL, "input") : sse([created, { type: "response.output_text.delta", item_id: "msg_1", delta: "done" }, completed([messageItem("done")])])));
    const chunks = await collect(openai(r.fn).completeStream({ model: MODEL, messages: LOOP, tools: [TOOL] }));
    expect(chunks.map((c) => c.delta.content).filter(Boolean)).toEqual(["done"]);
    expect(r.calls).toHaveLength(2);
    expect(hasReasoning(r.calls[0].body)).toBe(true);
    expect(hasReasoning(r.calls[1].body)).toBe(false);
    expect(r.calls[1].body.stream).toBe(true);
  });
});

// ─── Azure ───────────────────────────────────────────────────────────────────

describe("Azure replays the pair with its ids", () => {
  const azureBlock = (item: any, nextId?: string, next = "call:call_1") => block(next, item, nextId, AZURE_ORIGIN);

  it("the reasoning item keeps its id and the function call it preceded gets its fc_ id back", async () => {
    const body = await sent([USER, assistantCall(1, [azureBlock(reasoningItem("rs_1"), "fc_1")]), toolResult(1)], azure);
    expect(body.input).toEqual([
      userInput,
      { type: "reasoning", id: "rs_1", summary: SUMMARY, encrypted_content: ENC },
      { ...callInput(1), id: "fc_1" },
      outputInput(1),
    ]);
    expect(body.input[1]).not.toHaveProperty("status");
  });

  it("two items before one call: each with its id, the call once", async () => {
    const body = await sent([
      USER,
      assistantCall(1, [azureBlock(reasoningItem("rs_1", "enc-a"), "fc_1"), azureBlock(reasoningItem("rs_2", "enc-b"), "fc_1")]),
      toolResult(1),
    ], azure);
    expect(body.input).toEqual([
      userInput,
      { type: "reasoning", id: "rs_1", summary: SUMMARY, encrypted_content: "enc-a" },
      { type: "reasoning", id: "rs_2", summary: SUMMARY, encrypted_content: "enc-b" },
      { ...callInput(1), id: "fc_1" },
      outputInput(1),
    ]);
  });

  it("an item without an id cannot go back to Azure and is left out", async () => {
    const { id: _id, ...noId } = reasoningItem("rs_1");
    const body = await sent([USER, assistantCall(1, [azureBlock(noId, "fc_1")]), toolResult(1)], azure);
    expect(body.input).toEqual([userInput, callInput(1), outputInput(1)]);
  });

  it("a block minted by OpenAI, or by another Azure resource, is not replayed", async () => {
    const fromOpenAI = await sent([USER, assistantCall(1, [block("call:call_1", reasoningItem("rs_1"), "fc_1", OPENAI_ORIGIN)]), toolResult(1)], azure);
    expect(fromOpenAI.input).toEqual([userInput, callInput(1), outputInput(1)]);
    const otherResource = await sent(
      [USER, assistantCall(1, [block("call:call_1", reasoningItem("rs_1"), "fc_1", `azure|https://other.openai.azure.com|${MODEL}`)]), toolResult(1)],
      azure,
    );
    expect(otherResource.input).toEqual([userInput, callInput(1), outputInput(1)]);
  });

  it("and an Azure block is not replayed to OpenAI", async () => {
    const body = await sent([USER, assistantCall(1, [azureBlock(reasoningItem("rs_1"), "fc_1")]), toolResult(1)], openai);
    expect(body.input).toEqual([userInput, callInput(1), outputInput(1)]);
  });

  it("the api-version does not scope the item: the same resource replays across routes", async () => {
    const messages = [USER, assistantCall(1, [azureBlock(reasoningItem("rs_1"), "fc_1")]), toolResult(1)];
    for (const apiVersion of ["v1", "2025-04-01-preview"]) {
      const body = await sent(messages, (fn) => azure(fn, { apiVersion }));
      expect(body.input.some((i: any) => i.type === "reasoning" && i.id === "rs_1")).toBe(true);
    }
  });

  it("a refused replay falls back the same way", async () => {
    const r = recorder((n) => (n === 1 ? badRequest("The provided data does not match the expected schema.", "input") : json(response([messageItem("done")]))));
    const res = await azure(r.fn).complete({
      model: MODEL,
      messages: [USER, assistantCall(1, [azureBlock(reasoningItem("rs_1"), "fc_1")]), toolResult(1)],
      tools: [TOOL],
    });
    expect(res.content).toBe("done");
    expect(r.calls).toHaveLength(2);
    expect(r.calls[1].body.input).toEqual([userInput, callInput(1), outputInput(1)]);
  });
});

// ─── through the model adapter ───────────────────────────────────────────────

describe("a tool loop through fromNativeProvider", () => {
  const lookup = { name: "lookup", description: "d", parameters: { type: "object", properties: { q: { type: "number" } } } };

  async function loop(make: (fn: typeof fetch) => OpenAIProvider, first: any[]) {
    const r = recorder((n) => json(response(n === 1 ? first : [messageItem("done")])));
    const model = fromNativeProvider(make(r.fn), { model: MODEL }).bindTools([lookup]);
    const turn1 = await model.invoke([{ role: "user", content: "find it" }]);
    const toolCall = (turn1 as any).tool_calls[0];
    const turn2 = await model.invoke([
      { role: "user", content: "find it" },
      turn1,
      { role: "tool", tool_call_id: toolCall.id, content: "found" },
    ] as any);
    return { r, turn1, turn2 };
  }

  it("the reasoning of the first turn goes back on the second (OpenAI shape)", async () => {
    const { r, turn1, turn2 } = await loop(openai, [reasoningItem("rs_1"), callItem(1, "{\"q\":1}")]);
    expect((turn1 as any).reasoning.blocks).toHaveLength(1);
    expect(turn2.content).toBe("done");
    expect(r.calls[1].body.input).toEqual([
      userInput,
      replayed(),
      { type: "function_call", call_id: "call_1", name: "lookup", arguments: "{\"q\":1}" },
      { type: "function_call_output", call_id: "call_1", output: "found" },
    ]);
  });

  it("and with its ids on Azure", async () => {
    const { r } = await loop(azure, [reasoningItem("rs_1"), callItem(1, "{\"q\":1}")]);
    expect(r.calls[1].body.input).toEqual([
      userInput,
      { type: "reasoning", id: "rs_1", summary: SUMMARY, encrypted_content: ENC },
      { type: "function_call", id: "fc_1", call_id: "call_1", name: "lookup", arguments: "{\"q\":1}" },
      { type: "function_call_output", call_id: "call_1", output: "found" },
    ]);
  });
});
