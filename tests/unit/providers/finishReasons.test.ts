/**
 * Finish reasons across providers: what the vendor says (rawFinishReason) and
 * how it is normalised (finishReason), on the stream, the emulated stream and
 * the non-stream paths alike.
 *
 * Vendor facts: a Responses API limit hit is status "incomplete" with
 * incomplete_details.reason "max_output_tokens" (the enum also has
 * "content_filter", "max_messages", "steered"); Gemini reports its own reason
 * enum per candidate, and a prompt refused up front has only
 * promptFeedback.blockReason.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { OpenAIProvider, VertexProvider } from "../../../src/providers/index.js";
import type { ChatCompletionRequest } from "../../../src/providers/types.js";

afterEach(() => vi.unstubAllGlobals());

const messages: ChatCompletionRequest["messages"] = [{ role: "user", content: "hi" }];

function sseOf(events: any[]): string {
  return events.map((e) => `event: ${e.type ?? "message"}\ndata: ${JSON.stringify(e)}\n\n`).join("");
}

/** Stubs fetch with one reply: JSON, or an SSE body. */
function stubFetch(reply: { json?: any; sse?: string; contentType?: string }) {
  vi.stubGlobal("fetch", () => {
    const r: any = {
      ok: true,
      status: 200,
      headers: new Headers({ "content-type": reply.contentType ?? (reply.sse !== undefined ? "text/event-stream" : "application/json") }),
    };
    r.json = async () => reply.json;
    r.text = async () => JSON.stringify(reply.json ?? "");
    if (reply.sse !== undefined) {
      const enc = new TextEncoder();
      r.body = new ReadableStream<Uint8Array>({ start(c) { c.enqueue(enc.encode(reply.sse)); c.close(); } });
    }
    return Promise.resolve(r);
  });
}

async function collect<T>(gen: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const x of gen) out.push(x);
  return out;
}

// ── OpenAI Chat Completions / compatible servers ─────────────────────────────
describe("mapFinishReason (Chat Completions)", () => {
  const chat = () => new OpenAIProvider({ provider: "openai", apiKey: "k" });
  const reply = (finish: string) => ({
    json: { id: "c1", model: "m", choices: [{ message: { content: "x" }, finish_reason: finish }], usage: {} },
  });

  const cases: Array<[string, string]> = [
    ["stop", "stop"],
    ["tool_calls", "tool_calls"],
    ["length", "length"],
    ["max_tokens", "length"],
    ["model_length", "length"],
    ["max_output_tokens", "length"],
    ["content_filter", "content_filter"],
    ["insufficient_system_resource", "error"],
    ["something_new", "stop"],
  ];

  for (const [raw, mapped] of cases) {
    it(`maps "${raw}" to "${mapped}" and keeps the raw string`, async () => {
      stubFetch(reply(raw));
      const res = await chat().complete({ model: "gpt-4o", messages });
      expect(res.finishReason).toBe(mapped);
      expect(res.rawFinishReason).toBe(raw);
    });
  }

  it("maps the streamed final chunk the same way", async () => {
    stubFetch({
      sse: sseOf([{ id: "c1", model: "m", choices: [{ delta: { content: "x" }, finish_reason: "model_length" }] }]) + "data: [DONE]\n\n",
    });
    const chunks = await collect(chat().completeStream({ model: "gpt-4o", messages }));
    const last = chunks.find((c) => c.finishReason);
    expect(last?.finishReason).toBe("length");
    expect(last?.rawFinishReason).toBe("model_length");
  });
});

// ── OpenAI Responses API ─────────────────────────────────────────────────────
describe("Responses API finish reasons", () => {
  const MODEL = "gpt-6.1-sol";
  const provider = (streaming: boolean) =>
    new OpenAIProvider({ provider: "openai", apiKey: "k", baseURL: "https://res.openai.azure.com/openai/v1", responsesApiModels: [MODEL], responsesStreaming: streaming });

  const message = { type: "message", content: [{ type: "output_text", text: "partial" }] };
  const call = { type: "function_call", id: "fc_1", call_id: "call_1", name: "lookup", arguments: "{\"q\":" };
  const body = (status: string, reason?: string, output: any[] = [message]) => ({
    id: "resp_1",
    model: MODEL,
    status,
    ...(reason !== undefined ? { incomplete_details: { reason } } : status === "incomplete" ? { incomplete_details: null } : {}),
    output,
    usage: { input_tokens: 1, output_tokens: 2, total_tokens: 3 },
  });

  type Case = { name: string; response: any; finish: string; raw: string };
  const cases: Case[] = [
    { name: "completed", response: body("completed"), finish: "stop", raw: "completed" },
    { name: "completed with a tool call", response: body("completed", undefined, [call]), finish: "tool_calls", raw: "completed" },
    { name: "incomplete / max_output_tokens", response: body("incomplete", "max_output_tokens"), finish: "length", raw: "max_output_tokens" },
    { name: "incomplete / max_output_tokens with a cut-off call", response: body("incomplete", "max_output_tokens", [call]), finish: "length", raw: "max_output_tokens" },
    { name: "incomplete / content_filter", response: body("incomplete", "content_filter"), finish: "content_filter", raw: "content_filter" },
    { name: "incomplete / max_messages", response: body("incomplete", "max_messages"), finish: "stop", raw: "max_messages" },
    { name: "incomplete / steered", response: body("incomplete", "steered"), finish: "stop", raw: "steered" },
    { name: "incomplete without details", response: body("incomplete"), finish: "stop", raw: "incomplete" },
  ];

  for (const c of cases) {
    it(`non-stream: ${c.name}`, async () => {
      stubFetch({ json: c.response });
      const res = await provider(false).complete({ model: MODEL, messages });
      expect(res.finishReason).toBe(c.finish);
      expect(res.rawFinishReason).toBe(c.raw);
    });

    it(`emulated stream: ${c.name}`, async () => {
      stubFetch({ json: c.response });
      const chunks = await collect(provider(false).completeStream({ model: MODEL, messages }));
      expect(chunks).toHaveLength(1);
      expect(chunks[0].finishReason).toBe(c.finish);
      expect(chunks[0].rawFinishReason).toBe(c.raw);
    });

    it(`stream: ${c.name}`, async () => {
      const type = c.response.status === "incomplete" ? "response.incomplete" : "response.completed";
      stubFetch({ sse: sseOf([{ type: "response.created", response: { id: "resp_1", model: MODEL } }, { type, response: c.response }]) });
      const chunks = await collect(provider(true).completeStream({ model: MODEL, messages }));
      const last = chunks[chunks.length - 1];
      expect(last.finishReason).toBe(c.finish);
      expect(last.rawFinishReason).toBe(c.raw);
    });
  }

  it("stream that ends without a terminal event keeps the old fallback and no raw reason", async () => {
    stubFetch({ sse: sseOf([{ type: "response.created", response: { id: "resp_1", model: MODEL } }]) });
    const chunks = await collect(provider(true).completeStream({ model: MODEL, messages }));
    const last = chunks[chunks.length - 1];
    expect(last.finishReason).toBe("stop");
    expect(last.rawFinishReason).toBeUndefined();
  });
});

// ── Gemini / Vertex ──────────────────────────────────────────────────────────
describe("Gemini finish reasons", () => {
  const vertex = () => new VertexProvider({ provider: "vertex", projectId: "p", accessToken: "t" });
  const candidate = (finishReason?: string, text = "hi") => ({
    content: { role: "model", parts: [{ text }] },
    ...(finishReason ? { finishReason } : {}),
  });

  const cases: Array<[string, string]> = [
    ["STOP", "stop"],
    ["MAX_TOKENS", "length"],
    ["SAFETY", "content_filter"],
    ["RECITATION", "content_filter"],
    ["PROHIBITED_CONTENT", "content_filter"],
    ["BLOCKLIST", "content_filter"],
    ["SPII", "content_filter"],
    ["IMAGE_SAFETY", "content_filter"],
    ["MALFORMED_FUNCTION_CALL", "error"],
    ["UNEXPECTED_TOOL_CALL", "error"],
    ["OTHER", "stop"],
    ["LANGUAGE", "stop"],
  ];

  for (const [raw, mapped] of cases) {
    it(`maps ${raw} to "${mapped}" on both paths and keeps the raw string`, async () => {
      stubFetch({ json: { candidates: [candidate(raw)] } });
      const res = await vertex().complete({ model: "gemini-2.0-flash", messages });
      expect(res.finishReason).toBe(mapped);
      expect(res.rawFinishReason).toBe(raw);

      stubFetch({ sse: sseOf([{ candidates: [candidate(raw)] }]) });
      const chunks = await collect(vertex().completeStream({ model: "gemini-2.0-flash", messages }));
      expect(chunks[0].finishReason).toBe(mapped);
      expect(chunks[0].rawFinishReason).toBe(raw);
    });
  }

  it("non-stream falls back to stop when the candidate has no finishReason", async () => {
    stubFetch({ json: { candidates: [candidate()] } });
    const res = await vertex().complete({ model: "gemini-2.0-flash", messages });
    expect(res.finishReason).toBe("stop");
    expect(res.rawFinishReason).toBeUndefined();
  });

  it("a mid-stream chunk leaves finishReason undefined; only the last one carries it", async () => {
    stubFetch({
      sse: sseOf([
        { candidates: [candidate(undefined, "Hel")] },
        { candidates: [candidate(undefined, "lo")] },
        { candidates: [candidate("MAX_TOKENS", "!")], usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 3, totalTokenCount: 4 } },
      ]),
    });
    const chunks = await collect(vertex().completeStream({ model: "gemini-2.0-flash", messages }));
    expect(chunks).toHaveLength(3);
    expect(chunks[0].finishReason).toBeUndefined();
    expect(chunks[0].rawFinishReason).toBeUndefined();
    expect(chunks[1].finishReason).toBeUndefined();
    expect(chunks[2].finishReason).toBe("length");
    expect(chunks[2].rawFinishReason).toBe("MAX_TOKENS");
    expect(chunks.map((c) => c.delta.content).join("")).toBe("Hello!");
  });

  it("a prompt blocked before generation is a content_filter with the block reason", async () => {
    const blocked = { promptFeedback: { blockReason: "PROHIBITED_CONTENT" }, usageMetadata: { promptTokenCount: 4, totalTokenCount: 4 } };

    stubFetch({ json: blocked });
    const res = await vertex().complete({ model: "gemini-2.0-flash", messages });
    expect(res.finishReason).toBe("content_filter");
    expect(res.rawFinishReason).toBe("PROHIBITED_CONTENT");
    expect(res.content).toBeNull();
    expect(res.toolCalls).toEqual([]);

    stubFetch({ sse: sseOf([blocked]) });
    const chunks = await collect(vertex().completeStream({ model: "gemini-2.0-flash", messages }));
    expect(chunks).toHaveLength(1);
    expect(chunks[0].finishReason).toBe("content_filter");
    expect(chunks[0].rawFinishReason).toBe("PROHIBITED_CONTENT");
    expect(chunks[0].delta.content).toBeUndefined();
  });

  it("a candidate's own finishReason wins over promptFeedback", async () => {
    stubFetch({ json: { promptFeedback: { blockReason: "OTHER" }, candidates: [candidate("STOP")] } });
    const res = await vertex().complete({ model: "gemini-2.0-flash", messages });
    expect(res.finishReason).toBe("stop");
    expect(res.rawFinishReason).toBe("STOP");
  });
});
