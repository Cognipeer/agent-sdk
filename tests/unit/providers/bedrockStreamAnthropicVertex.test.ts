import { describe, it, expect } from "vitest";
import { BedrockProvider } from "../../../src/providers/bedrock.js";
import { AnthropicProvider } from "../../../src/providers/anthropic.js";
import { VertexProvider } from "../../../src/providers/vertex.js";
import { fromNativeProvider } from "../../../src/providers/adapter.js";
import { applyGeminiReasoning } from "../../../src/providers/utils/reasoning.js";
import {
  encodeFrame, decodeFrame, parseEventStream, crc32,
} from "../../../src/providers/utils/eventStream.js";
import type { ChatCompletionChunk } from "../../../src/providers/types.js";

const enc = new TextEncoder();
const evt = (type: string, payload: any) =>
  encodeFrame({ ":message-type": "event", ":event-type": type, ":content-type": "application/json" }, JSON.stringify(payload));

function streamOf(chunks: Uint8Array[]): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(c) { for (const ch of chunks) c.enqueue(ch); c.close(); },
  });
}
/** Splits bytes into awkward slices to prove reassembly across reads. */
function slices(all: Uint8Array, size: number): Uint8Array[] {
  const out: Uint8Array[] = [];
  for (let i = 0; i < all.length; i += size) out.push(all.slice(i, i + size));
  return out;
}
function concat(parts: Uint8Array[]): Uint8Array {
  const o = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let i = 0; for (const p of parts) { o.set(p, i); i += p.length; }
  return o;
}
async function collect<T>(it: AsyncIterable<T>): Promise<T[]> {
  const o: T[] = []; for await (const x of it) o.push(x); return o;
}

describe("event-stream codec", () => {
  it("crc32 matches the standard check value", () => {
    expect(crc32(enc.encode("123456789"))).toBe(0xcbf43926);
  });
  it("round-trips headers and payload", () => {
    const f = decodeFrame(evt("messageStart", { role: "assistant" }));
    expect(f.headers[":event-type"]).toBe("messageStart");
    expect(JSON.parse(new TextDecoder().decode(f.payload))).toEqual({ role: "assistant" });
  });
  it("rejects a corrupted frame", () => {
    const f = evt("messageStart", { role: "assistant" });
    f[f.length - 6] ^= 0xff;
    expect(() => decodeFrame(f)).toThrow(/CRC/);
  });
  it("reassembles frames split across reads, byte by byte", async () => {
    const all = concat([evt("a", { n: 1 }), evt("b", { n: 2 })]);
    const msgs = await collect(parseEventStream(streamOf(slices(all, 1))));
    expect(msgs.map((m) => m.headers[":event-type"])).toEqual(["a", "b"]);
  });
  it("errors on truncated input", async () => {
    const all = evt("a", { n: 1 });
    await expect(collect(parseEventStream(streamOf([all.slice(0, all.length - 3)])))).rejects.toThrow(/inside a frame/);
  });
});

function bedrock(fetchImpl: any, extra: any = {}) {
  return new BedrockProvider({
    provider: "bedrock", region: "us-east-1", accessKeyId: "AK", secretAccessKey: "SK",
    fetch: fetchImpl, retry: { maxRetries: 0 }, ...extra,
  } as any);
}

describe("Bedrock ConverseStream", () => {
  const frames = concat([
    evt("messageStart", { role: "assistant" }),
    evt("contentBlockDelta", { contentBlockIndex: 0, delta: { reasoningContent: { text: "hmm " } } }),
    evt("contentBlockDelta", { contentBlockIndex: 0, delta: { reasoningContent: { text: "ok" } } }),
    evt("contentBlockDelta", { contentBlockIndex: 0, delta: { reasoningContent: { signature: "SIG" } } }),
    evt("contentBlockStop", { contentBlockIndex: 0 }),
    evt("contentBlockDelta", { contentBlockIndex: 1, delta: { text: "Hel" } }),
    evt("contentBlockDelta", { contentBlockIndex: 1, delta: { text: "lo" } }),
    evt("contentBlockStop", { contentBlockIndex: 1 }),
    evt("contentBlockStart", { contentBlockIndex: 2, start: { toolUse: { toolUseId: "tu1", name: "get_w" } } }),
    evt("contentBlockDelta", { contentBlockIndex: 2, delta: { toolUse: { input: '{"ci' } } }),
    evt("contentBlockDelta", { contentBlockIndex: 2, delta: { toolUse: { input: 'ty":"X"}' } } }),
    evt("contentBlockStop", { contentBlockIndex: 2 }),
    evt("messageStop", { stopReason: "tool_use" }),
    evt("metadata", { usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15, cacheReadInputTokenCount: 3 }, metrics: {} }),
  ]);

  it("streams text, reasoning, tool calls, finish reason and usage; hits converse-stream signed", async () => {
    let seen: { url: string; init: any } | undefined;
    const p = bedrock(async (url: string, init: any) => {
      seen = { url, init };
      return new Response(streamOf(slices(frames, 7)), { status: 200, headers: { "x-amzn-requestid": "rid-1" } });
    });
    const chunks = await collect(p.completeStream({ model: "anthropic.claude-x", messages: [{ role: "user", content: "hi" }] }));

    expect(seen!.url).toContain("/model/anthropic.claude-x/converse-stream");
    expect(seen!.init.headers.Accept).toBe("application/vnd.amazon.eventstream");
    expect(seen!.init.headers.Authorization ?? seen!.init.headers.authorization).toMatch(/^AWS4-HMAC-SHA256/);

    expect(chunks.map((c) => c.delta.content).filter(Boolean).join("")).toBe("Hello");
    expect(chunks.map((c) => c.delta.reasoning?.summary).filter(Boolean).join("")).toBe("hmm ok");
    const tcs = chunks.flatMap((c) => c.delta.toolCalls ?? []);
    expect(tcs[0]).toMatchObject({ id: "tu1", name: "get_w" });
    expect(tcs.map((t) => t.arguments).join("")).toBe('{"city":"X"}');

    const last = chunks[chunks.length - 1];
    expect(last.finishReason).toBe("tool_calls");
    expect(last.usage).toMatchObject({ inputTokens: 10, outputTokens: 5, totalTokens: 15, cachedInputTokens: 3 });
    expect(last.delta.reasoning?.blocks).toEqual([{ type: "thinking", text: "hmm ok", signature: "SIG" }]);
    expect(chunks[0].id).toBe("rid-1");
  });

  it("raises a ProviderError with status on an in-stream exception", async () => {
    const bad = encodeFrame(
      { ":message-type": "exception", ":exception-type": "throttlingException", ":content-type": "application/json" },
      JSON.stringify({ message: "slow down" }),
    );
    const p = bedrock(async () => new Response(streamOf([evt("messageStart", {}), bad]), { status: 200 }));
    await expect(collect(p.completeStream({ model: "m", messages: [{ role: "user", content: "x" }] })))
      .rejects.toMatchObject({ name: "ProviderError", statusCode: 429 });
  });

  it("non-stream complete still uses /converse", async () => {
    let url = "";
    const p = bedrock(async (u: string) => {
      url = u;
      return new Response(JSON.stringify({ output: { message: { content: [{ text: "ok" }] } }, stopReason: "end_turn", usage: {} }), { status: 200 });
    });
    const r = await p.complete({ model: "m", messages: [{ role: "user", content: "x" }] });
    expect(url.endsWith("/converse")).toBe(true);
    expect(r.content).toBe("ok");
  });

  it("adapter advertises streaming and yields a reasoning part then a final message", async () => {
    const p = bedrock(async () => new Response(streamOf([frames]), { status: 200 }));
    const model: any = fromNativeProvider(p, { model: "m" });
    expect(model.capabilities.streaming).toBe(true);
    const parts = await collect<any>(model.stream([{ role: "user", content: "hi" }]));
    expect(parts.some((x) => x?.type === "reasoning")).toBe(true);
    const final = parts[parts.length - 1];
    expect(final.content).toBe("Hello");
    expect(final.tool_calls[0].function.arguments).toBe('{"city":"X"}');
    expect(final.reasoning.blocks[0].signature).toBe("SIG");
  });
});

function anthropic(extra?: Record<string, any>, req: any = {}) {
  let body: any;
  const p = new AnthropicProvider({
    provider: "anthropic", apiKey: "k",
    fetch: (async (_u: string, init: any) => {
      body = JSON.parse(init.body);
      return new Response(JSON.stringify({ id: "1", model: "m", content: [{ type: "text", text: "ok" }], stop_reason: "end_turn", usage: {} }), { status: 200 });
    }) as any,
  });
  return p.complete({ model: "claude-sonnet-4", messages: [{ role: "user", content: "x" }], extra, ...req }).then(() => body);
}

describe("Anthropic thinking and max_tokens", () => {
  it("explicit extra.thinking wins over derived reasoning", async () => {
    const body = await anthropic(
      { thinking: { type: "enabled", budget_tokens: 3000 } },
      { reasoning: { effort: "high" }, temperature: 0.3 },
    );
    expect(body.thinking).toEqual({ type: "enabled", budget_tokens: 3000 });
    expect(body.max_tokens).toBeGreaterThan(3000);
    expect(body.temperature).toBeUndefined();
  });
  it("explicit disabled thinking suppresses derived reasoning and keeps sampling", async () => {
    const body = await anthropic({ thinking: { type: "disabled" } }, { reasoning: { effort: "high" }, temperature: 0.3 });
    expect(body.thinking).toEqual({ type: "disabled" });
    expect(body.temperature).toBe(0.3);
  });
  it("keeps an explicit max_tokens that already exceeds the budget", async () => {
    const body = await anthropic({ thinking: { type: "enabled", budget_tokens: 2000 } }, { maxTokens: 9000 });
    expect(body.max_tokens).toBe(9000);
  });
  it("derives thinking from effort when no explicit block (existing tables)", async () => {
    const body = await anthropic(undefined, { reasoning: { effort: "medium" } });
    expect(body.thinking).toEqual({ type: "enabled", budget_tokens: 8192 });
    expect(body.max_tokens).toBeGreaterThan(8192);
  });
  it("always sends a positive max_tokens, even if extra nulls it", async () => {
    expect((await anthropic()).max_tokens).toBe(4096);
    expect((await anthropic({ max_tokens: null })).max_tokens).toBe(4096);
    expect((await anthropic(undefined, { maxTokens: 123 })).max_tokens).toBe(123);
  });
});

function vertexWith(responses: Array<() => Response>, retry: any = { maxRetries: 2, baseDelayMs: 1, maxDelayMs: 2 }) {
  const calls: any[] = [];
  let i = 0;
  const p = new VertexProvider({
    provider: "vertex", projectId: "p", accessToken: "tok", retry,
    fetch: (async (url: string, init: any) => {
      calls.push({ url, body: JSON.parse(init.body) });
      return responses[Math.min(i++, responses.length - 1)]();
    }) as any,
  });
  return { p, calls };
}
const ok = (parts: any[]) => () => new Response(JSON.stringify({ candidates: [{ content: { parts }, finishReason: "STOP" }] }), { status: 200 });

describe("Vertex retry, thoughtSignature, thinkingLevel", () => {
  it("retries 429 then 503 then succeeds", async () => {
    const { p, calls } = vertexWith([() => new Response("slow", { status: 429 }), () => new Response("down", { status: 503 }), ok([{ text: "hi" }])]);
    const r = await p.complete({ model: "gemini-2.5-pro", messages: [{ role: "user", content: "x" }] });
    expect(r.content).toBe("hi");
    expect(calls).toHaveLength(3);
  });
  it("surfaces ProviderError after retries are exhausted; does not retry 400", async () => {
    const a = vertexWith([() => new Response("x", { status: 500 })], { maxRetries: 1, baseDelayMs: 1, maxDelayMs: 1 });
    await expect(a.p.complete({ model: "m", messages: [{ role: "user", content: "x" }] })).rejects.toMatchObject({ statusCode: 500 });
    expect(a.calls).toHaveLength(2);
    const b = vertexWith([() => new Response("bad", { status: 400 })]);
    await expect(b.p.complete({ model: "m", messages: [{ role: "user", content: "x" }] })).rejects.toMatchObject({ statusCode: 400 });
    expect(b.calls).toHaveLength(1);
  });
  it("captures thoughtSignature on tool calls and echoes it on the next request (adapter round-trip)", async () => {
    const { p, calls } = vertexWith([
      ok([{ functionCall: { name: "f", args: { a: 1 } }, thoughtSignature: "TS1" }, { functionCall: { name: "g", args: {} } }]),
      ok([{ text: "done" }]),
    ]);
    const model: any = fromNativeProvider(p, { model: "gemini-3-pro" });
    const first = await model.invoke([{ role: "user", content: "go" }]);
    expect(first.tool_calls[0].thoughtSignature).toBe("TS1");
    expect(first.tool_calls[1].thoughtSignature).toBeUndefined();

    await model.invoke([
      { role: "user", content: "go" }, first,
      { role: "tool", content: "{}", tool_call_id: first.tool_calls[0].id, name: "f" },
    ]);
    const modelTurn = calls[1].body.contents.find((c: any) => c.role === "model");
    expect(modelTurn.parts[0]).toMatchObject({ functionCall: { name: "f" }, thoughtSignature: "TS1" });
    expect(modelTurn.parts[1].thoughtSignature).toBeUndefined();
  });
  it("stream: unique tool ids across chunks and signature kept through the adapter", async () => {
    const sse = (o: any) => `data: ${JSON.stringify(o)}\n\n`;
    const body = sse({ candidates: [{ content: { parts: [{ functionCall: { name: "f", args: { x: 1 } }, thoughtSignature: "S" }] } }] })
      + sse({ candidates: [{ content: { parts: [{ functionCall: { name: "g", args: { y: 2 } } }] }, finishReason: "STOP" }] });
    const { p } = vertexWith([() => new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } })]);
    const model: any = fromNativeProvider(p, { model: "gemini-3-pro" });
    const parts = await collect<any>(model.stream([{ role: "user", content: "go" }]));
    const final = parts[parts.length - 1];
    expect(final.tool_calls).toHaveLength(2);
    expect(final.tool_calls[0].thoughtSignature).toBe("S");
    expect(JSON.parse(final.tool_calls[0].function.arguments)).toEqual({ x: 1 });
    expect(JSON.parse(final.tool_calls[1].function.arguments)).toEqual({ y: 2 });
  });
  it("thinkingLevel is sent instead of the budget; none still wins", () => {
    const a: any = {}; applyGeminiReasoning(a, { effort: "high", thinkingLevel: "low", includeThoughts: true });
    expect(a.thinkingConfig).toEqual({ thinkingLevel: "low", includeThoughts: true });
    const b: any = {}; applyGeminiReasoning(b, { thinkingLevel: "high" });
    expect(b.thinkingConfig).toEqual({ thinkingLevel: "high" });
    const c: any = {}; applyGeminiReasoning(c, { effort: "none", thinkingLevel: "high" });
    expect(c.thinkingConfig).toEqual({ thinkingBudget: 0 });
    const d: any = {}; applyGeminiReasoning(d, { effort: "medium" });
    expect(d.thinkingConfig).toEqual({ thinkingBudget: 4096 });
  });
});
