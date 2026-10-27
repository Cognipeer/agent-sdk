/**
 * Gemini thought signatures on text parts. The response parser keeps the signature
 * of a part that is not a function call on `reasoning.blocks` (a `thinking` block with
 * `thoughtSignature`, no `signature`, no text), and the next request puts it back on
 * the assistant turn's last text part. Function-call signatures keep riding on their
 * ToolCall.
 */

import { describe, it, expect } from "vitest";
import { VertexProvider } from "../../../src/providers/vertex.js";
import { AnthropicProvider } from "../../../src/providers/anthropic.js";
import { BedrockProvider } from "../../../src/providers/bedrock.js";
import { fromNativeProvider } from "../../../src/providers/adapter.js";

// ─── helpers ─────────────────────────────────────────────────────────────────

const json = (o: any, status = 200) => new Response(JSON.stringify(o), { status, headers: { "content-type": "application/json" } });
const gemini = (parts: any[], extra: Record<string, any> = {}) => ({
  candidates: [{ content: { parts }, finishReason: "STOP" }],
  usageMetadata: {},
  ...extra,
});
const sseOf = (...objs: any[]) =>
  new Response(objs.map((o) => `data: ${JSON.stringify(o)}\n\n`).join(""), { status: 200, headers: { "content-type": "text/event-stream" } });
const chunkOf = (parts: any[], finishReason?: string) => ({ candidates: [{ content: { parts }, ...(finishReason ? { finishReason } : {}) }] });
/** The block the parser keeps for a signature. */
const block = (thoughtSignature: string) => ({ type: "thinking", thoughtSignature });

async function collect<T>(it: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const x of it) out.push(x);
  return out;
}

/** A provider that answers with the given replies in order (the last repeats) and records each request body. */
function vertexWith(replies: Array<() => Response>) {
  const bodies: any[] = [];
  let i = 0;
  const fn = (async (_url: any, init: any) => {
    bodies.push(JSON.parse(init.body));
    return replies[Math.min(i++, replies.length - 1)]();
  }) as unknown as typeof fetch;
  const provider = new VertexProvider({ provider: "vertex", projectId: "proj", accessToken: "tok", fetch: fn, retry: { maxRetries: 0 } } as any);
  return { provider, bodies };
}

const MODEL = "gemini-3-flash-preview";
const user = (content: string) => ({ role: "user" as const, content });

// ─── the response parser keeps the signature of a text part ──────────────────

describe("response: signatures of parts that are not function calls", () => {
  it("a signed text part becomes one block next to the text", async () => {
    const { provider } = vertexWith([() => json(gemini([{ text: "answer", thoughtSignature: "SIG1" }]))]);
    const res = await provider.complete({ model: MODEL, messages: [user("hi")] });
    expect(res.content).toBe("answer");
    expect(res.reasoning).toEqual({ blocks: [block("SIG1")] });
  });

  it("a function-call signature stays on the tool call and makes no block", async () => {
    const { provider } = vertexWith([() => json(gemini([{ functionCall: { name: "f", args: { a: 1 } }, thoughtSignature: "TS" }]))]);
    const res = await provider.complete({ model: MODEL, messages: [user("go")] });
    expect(res.toolCalls[0].thoughtSignature).toBe("TS");
    expect(res.reasoning).toBeUndefined();
  });

  it("text with a signature next to a function call: each signature keeps to its own place", async () => {
    const { provider } = vertexWith([
      () => json(gemini([{ text: "let me check", thoughtSignature: "TXT" }, { functionCall: { name: "f", args: {} }, thoughtSignature: "FN" }])),
    ]);
    const res = await provider.complete({ model: MODEL, messages: [user("go")] });
    expect(res.content).toBe("let me check");
    expect(res.toolCalls[0].thoughtSignature).toBe("FN");
    expect(res.reasoning).toEqual({ blocks: [block("TXT")] });
  });

  it("an unsigned text response has no reasoning at all", async () => {
    const { provider } = vertexWith([() => json(gemini([{ text: "plain" }]))]);
    expect((await provider.complete({ model: MODEL, messages: [user("hi")] })).reasoning).toBeUndefined();
  });

  it("a thought summary and a signed answer: the summary stays a summary, the signature a block", async () => {
    const { provider } = vertexWith([() => json(gemini([{ text: "pondering", thought: true }, { text: "answer", thoughtSignature: "S" }]))]);
    const res = await provider.complete({ model: MODEL, messages: [user("hi")] });
    expect(res.content).toBe("answer");
    expect(res.reasoning).toEqual({ summary: "pondering", blocks: [block("S")] });
  });

  it("a signature on a thought-summary part is not kept", async () => {
    const { provider } = vertexWith([() => json(gemini([{ text: "pondering", thought: true, thoughtSignature: "ON_THOUGHT" }, { text: "answer" }]))]);
    const res = await provider.complete({ model: MODEL, messages: [user("hi")] });
    expect(res.reasoning).toEqual({ summary: "pondering" });
  });

  it("a signature on a part with empty text is kept (that is where a stream puts it)", async () => {
    const { provider } = vertexWith([() => json(gemini([{ text: "answer" }, { text: "", thoughtSignature: "EMPTY" }]))]);
    const res = await provider.complete({ model: MODEL, messages: [user("hi")] });
    expect(res.content).toBe("answer");
    expect(res.reasoning).toEqual({ blocks: [block("EMPTY")] });
  });

  it("several signatures are kept in order", async () => {
    const { provider } = vertexWith([() => json(gemini([{ text: "a", thoughtSignature: "s1" }, { text: "b", thoughtSignature: "s2" }]))]);
    const res = await provider.complete({ model: MODEL, messages: [user("hi")] });
    expect(res.content).toBe("ab");
    expect(res.reasoning?.blocks).toEqual([block("s1"), block("s2")]);
  });

  it("the block carries no Claude-style signature and no text", async () => {
    const { provider } = vertexWith([() => json(gemini([{ text: "answer", thoughtSignature: "SIG1" }]))]);
    const b: any = (await provider.complete({ model: MODEL, messages: [user("hi")] })).reasoning?.blocks?.[0];
    expect(b.type).toBe("thinking");
    expect(b.signature).toBeUndefined();
    expect(b.text).toBeUndefined();
  });
});

describe("stream: signatures of parts that are not function calls", () => {
  const stream = () =>
    sseOf(
      chunkOf([{ text: "Hel" }]),
      chunkOf([{ text: "lo", thoughtSignature: "SA" }]),
      chunkOf([{ text: "", thoughtSignature: "SB" }], "STOP"),
    );

  it("each chunk carries every signature seen so far (the consumer keeps the last blocks it gets)", async () => {
    const { provider } = vertexWith([stream]);
    const chunks = await collect(provider.completeStream({ model: MODEL, messages: [user("hi")] }));
    expect(chunks).toHaveLength(3);
    expect(chunks[0].delta.reasoning).toBeUndefined();
    expect(chunks[1].delta.content).toBe("lo");
    expect(chunks[1].delta.reasoning).toEqual({ blocks: [block("SA")] });
    expect(chunks[2].delta.content).toBeUndefined();
    expect(chunks[2].delta.reasoning).toEqual({ blocks: [block("SA"), block("SB")] });
  });

  it("a thought summary and a signature in one chunk keep both", async () => {
    const { provider } = vertexWith([
      () => sseOf(chunkOf([{ text: "a", thoughtSignature: "S" }, { text: "pondering", thought: true }]), chunkOf([{ text: "t2", thought: true }], "STOP")),
    ]);
    const chunks = await collect(provider.completeStream({ model: MODEL, messages: [user("hi")] }));
    expect(chunks[0].delta.content).toBe("a");
    expect(chunks[0].delta.reasoning).toEqual({ blocks: [block("S")], summary: "pondering" });
    expect(chunks[1].delta.reasoning).toEqual({ summary: "t2" });
  });

  it("a function-call signature in a stream makes no block", async () => {
    const { provider } = vertexWith([() => sseOf(chunkOf([{ functionCall: { name: "f", args: {} }, thoughtSignature: "TS" }], "STOP"))]);
    const chunks = await collect(provider.completeStream({ model: MODEL, messages: [user("go")] }));
    expect(chunks[0].delta.toolCalls?.[0].thoughtSignature).toBe("TS");
    expect(chunks[0].delta.reasoning).toBeUndefined();
  });

  it("state is per stream: a second stream starts with no signatures", async () => {
    const { provider } = vertexWith([stream, () => sseOf(chunkOf([{ text: "x", thoughtSignature: "ONLY" }], "STOP"))]);
    await collect(provider.completeStream({ model: MODEL, messages: [user("hi")] }));
    const second = await collect(provider.completeStream({ model: MODEL, messages: [user("hi")] }));
    expect(second[0].delta.reasoning).toEqual({ blocks: [block("ONLY")] });
  });
});

// ─── the request puts it back ────────────────────────────────────────────────

describe("request: the signature goes back on the assistant turn's text part", () => {
  async function turnsOf(messages: any[]) {
    const { provider, bodies } = vertexWith([() => json(gemini([{ text: "ok" }]))]);
    await provider.complete({ model: MODEL, messages });
    return bodies[0].contents;
  }

  it("a text turn", async () => {
    const contents = await turnsOf([user("hi"), { role: "assistant", content: "hello", reasoning: { blocks: [block("SIG")] } }, user("again")]);
    expect(contents[1]).toEqual({ role: "model", parts: [{ text: "hello", thoughtSignature: "SIG" }] });
  });

  it("no block, no signature property at all", async () => {
    const contents = await turnsOf([user("hi"), { role: "assistant", content: "hello" }, user("again")]);
    expect(contents[1]).toEqual({ role: "model", parts: [{ text: "hello" }] });
    expect("thoughtSignature" in contents[1].parts[0]).toBe(false);
  });

  it("a text turn that is also a tool-call turn: the text part and the call each get their own", async () => {
    const contents = await turnsOf([
      user("go"),
      {
        role: "assistant",
        content: "let me check",
        toolCalls: [{ id: "c1", name: "f", arguments: '{"a":1}', thoughtSignature: "FN" }],
        reasoning: { blocks: [block("TXT")] },
      },
      { role: "tool", content: "{}", toolCallId: "c1" },
    ]);
    expect(contents[1]).toEqual({
      role: "model",
      parts: [{ text: "let me check", thoughtSignature: "TXT" }, { functionCall: { name: "f", args: { a: 1 } }, thoughtSignature: "FN" }],
    });
  });

  it("a tool-call turn with no text: the function call keeps its signature, nothing is added", async () => {
    const contents = await turnsOf([
      user("go"),
      { role: "assistant", content: "", toolCalls: [{ id: "c1", name: "f", arguments: "{}", thoughtSignature: "FN" }], reasoning: { blocks: [block("LOST")] } },
      { role: "tool", content: "{}", toolCallId: "c1" },
    ]);
    expect(contents[1].parts).toEqual([{ functionCall: { name: "f", args: {} }, thoughtSignature: "FN" }]);
  });

  it("several signatures: the last one is put back", async () => {
    const contents = await turnsOf([user("hi"), { role: "assistant", content: "ab", reasoning: { blocks: [block("s1"), block("s2")] } }, user("again")]);
    expect(contents[1].parts).toEqual([{ text: "ab", thoughtSignature: "s2" }]);
  });

  it("content parts: the last text part carries it", async () => {
    const contents = await turnsOf([
      user("hi"),
      { role: "assistant", content: [{ type: "text", text: "a" }, { type: "text", text: "b" }], reasoning: { blocks: [block("SIG")] } },
      user("again"),
    ]);
    expect(contents[1].parts).toEqual([{ text: "a" }, { text: "b", thoughtSignature: "SIG" }]);
  });

  it("never on an empty text part: an empty turn gets no signature", async () => {
    const contents = await turnsOf([user("hi"), { role: "assistant", content: "", reasoning: { blocks: [block("SIG")] } }, user("again")]);
    expect(contents[1].parts.every((p: any) => !("thoughtSignature" in p))).toBe(true);
  });

  it("blocks that are not Gemini signatures are ignored", async () => {
    const contents = await turnsOf([
      user("hi"),
      {
        role: "assistant",
        content: "hello",
        reasoning: { blocks: [{ type: "thinking", text: "t", signature: "CLAUDE" }, { type: "redacted_thinking", data: "D" }, { type: "thinking", thoughtSignature: "" }] },
      },
      user("again"),
    ]);
    expect(contents[1].parts).toEqual([{ text: "hello" }]);
  });

  it("only assistant turns get one", async () => {
    const contents = await turnsOf([{ role: "user", content: "hi", reasoning: { blocks: [block("SIG")] } }]);
    expect(contents[0].parts).toEqual([{ text: "hi" }]);
  });

  it("a thinking summary on the turn is not sent back as content", async () => {
    const contents = await turnsOf([user("hi"), { role: "assistant", content: "hello", reasoning: { summary: "pondering", blocks: [block("SIG")] } }, user("again")]);
    expect(JSON.stringify(contents)).not.toContain("pondering");
  });
});

// ─── through the adapter, as an agent loop uses it ───────────────────────────

describe("round trip through the adapter", () => {
  it("invoke: the signature of the first answer is on the second request", async () => {
    const { provider, bodies } = vertexWith([() => json(gemini([{ text: "hello", thoughtSignature: "SIG" }])), () => json(gemini([{ text: "again!" }]))]);
    const model: any = fromNativeProvider(provider, { model: MODEL });
    const first = await model.invoke([{ role: "user", content: "hi" }]);
    expect(first.content).toBe("hello");
    expect(first.reasoning).toEqual({ blocks: [block("SIG")] });

    await model.invoke([{ role: "user", content: "hi" }, first, { role: "user", content: "again" }]);
    expect(bodies[1].contents[1]).toEqual({ role: "model", parts: [{ text: "hello", thoughtSignature: "SIG" }] });
  });

  it("stream: the last blocks of the stream are on the final message, and the last signature goes back", async () => {
    const { provider, bodies } = vertexWith([
      () => sseOf(chunkOf([{ text: "Hel" }]), chunkOf([{ text: "lo", thoughtSignature: "SA" }]), chunkOf([{ text: "", thoughtSignature: "SB" }], "STOP")),
      () => json(gemini([{ text: "ok" }])),
    ]);
    const model: any = fromNativeProvider(provider, { model: MODEL });
    const parts = await collect<any>(model.stream([{ role: "user", content: "hi" }]));
    const final = parts[parts.length - 1];
    expect(final.content).toBe("Hello");
    expect(final.reasoning).toEqual({ blocks: [block("SA"), block("SB")] });

    await model.invoke([{ role: "user", content: "hi" }, final, { role: "user", content: "again" }]);
    expect(bodies[1].contents[1].parts).toEqual([{ text: "Hello", thoughtSignature: "SB" }]);
  });

  it("with effort none MINIMAL is sent as asked, signed history or not", async () => {
    const signed = vertexWith([() => json(gemini([{ text: "hello", thoughtSignature: "SIG" }])), () => json(gemini([{ text: "ok" }]))]);
    const a: any = fromNativeProvider(signed.provider, { model: MODEL, reasoning: { effort: "none" } });
    const first = await a.invoke([{ role: "user", content: "hi" }]);
    await a.invoke([{ role: "user", content: "hi" }, first, { role: "user", content: "again" }]);
    expect(signed.bodies[0].generationConfig.thinkingConfig).toEqual({ thinkingLevel: "minimal" });
    expect(signed.bodies[1].generationConfig.thinkingConfig).toEqual({ thinkingLevel: "minimal" });

    const unsigned = vertexWith([() => json(gemini([{ text: "hello" }])), () => json(gemini([{ text: "ok" }]))]);
    const b: any = fromNativeProvider(unsigned.provider, { model: MODEL, reasoning: { effort: "none" } });
    const firstB = await b.invoke([{ role: "user", content: "hi" }]);
    await b.invoke([{ role: "user", content: "hi" }, firstB, { role: "user", content: "again" }]);
    expect(unsigned.bodies[0].generationConfig.thinkingConfig).toEqual({ thinkingLevel: "minimal" });
    expect(unsigned.bodies[1].generationConfig.thinkingConfig).toEqual({ thinkingLevel: "minimal" });
  });
});

// ─── a Gemini signature is not a Claude signature ────────────────────────────

describe("the signature block is skipped by the Claude providers", () => {
  const history = [
    user("hi"),
    { role: "assistant" as const, content: "hello", reasoning: { blocks: [block("GEMINI_SIG")] } },
    user("again"),
  ];

  it("Anthropic sends no thinking block for it", async () => {
    let body: any;
    const p = new AnthropicProvider({
      provider: "anthropic",
      apiKey: "k",
      retry: { maxRetries: 0 },
      fetch: (async (_u: any, init: any) => {
        body = JSON.parse(init.body);
        return json({ id: "m", model: "x", content: [{ type: "text", text: "hi" }], stop_reason: "end_turn", usage: { input_tokens: 1, output_tokens: 1 } });
      }) as any,
    } as any);
    await p.complete({ model: "claude-sonnet-4-5", messages: history });
    const sent = JSON.stringify(body.messages);
    expect(sent).toContain("hello");
    expect(sent).not.toContain("thinking");
    expect(sent).not.toContain("GEMINI_SIG");
  });

  it("Bedrock sends no reasoningContent for it", async () => {
    let body: any;
    const p = new BedrockProvider({
      provider: "bedrock",
      region: "us-east-1",
      accessKeyId: "AK",
      secretAccessKey: "SK",
      retry: { maxRetries: 0 },
      fetch: (async (_u: any, init: any) => {
        body = JSON.parse(init.body);
        return json({ output: { message: { role: "assistant", content: [{ text: "ok" }] } }, stopReason: "end_turn", usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } });
      }) as any,
    } as any);
    await p.complete({ model: "anthropic.claude-sonnet-4-20250514-v1:0", messages: history });
    const sent = JSON.stringify(body.messages);
    expect(sent).toContain("hello");
    expect(sent).not.toContain("reasoningContent");
    expect(sent).not.toContain("GEMINI_SIG");
  });
});
