/**
 * Claude on Vertex AI takes image and document data inline only: URL sources (and the
 * Files API) are not supported there. A request that has one fails before anything is
 * sent, with a 400 ProviderError that names it and says base64 is needed. The SDK never
 * downloads the URL itself (that would be a server-side request to a caller-supplied
 * address), and nothing is sent or retried.
 */

import { describe, it, expect, vi } from "vitest";
import { VertexProvider } from "../../../src/providers/vertex.js";
import { VertexAnthropicProvider } from "../../../src/providers/vertexAnthropic.js";
import { AnthropicProvider } from "../../../src/providers/anthropic.js";
import { ProviderError, type ChatCompletionChunk, type UnifiedMessage } from "../../../src/providers/types.js";

const CLAUDE_OK = {
  id: "msg_1",
  type: "message",
  model: "claude-sonnet-4-6",
  content: [{ type: "text", text: "hello" }],
  stop_reason: "end_turn",
  usage: { input_tokens: 10, output_tokens: 20 },
};

type Call = { url: string; body: any };

function setup() {
  const calls: Call[] = [];
  const fetchImpl = (async (url: unknown, init: any) => {
    calls.push({ url: String(url), body: JSON.parse(init.body) });
    return new Response(JSON.stringify(CLAUDE_OK), { status: 200, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
  const provider = new VertexProvider({
    provider: "vertex",
    projectId: "proj",
    location: "us-east5",
    accessToken: "tok",
    fetch: fetchImpl,
    retry: { maxRetries: 3, baseDelayMs: 1, maxDelayMs: 2 },
  } as any);
  return { provider, calls };
}

async function drain(it: AsyncIterable<ChatCompletionChunk>): Promise<ChatCompletionChunk[]> {
  const out: ChatCompletionChunk[] = [];
  for await (const c of it) out.push(c);
  return out;
}

const MODEL = "claude-sonnet-4-6";
// The URL carries a signature: it must never be echoed in an error message.
const IMAGE_URL = "https://files.example.test/pic.png?sig=s3cr3t";
const PDF_URL = "https://files.example.test/a.pdf?sig=s3cr3t";

const urlImage = { type: "image" as const, source: { type: "url" as const, url: IMAGE_URL } };
const urlPdf = { type: "file" as const, source: { type: "url" as const, url: PDF_URL }, fileName: "a.pdf" };
const user = (...content: any[]): UnifiedMessage => ({ role: "user", content });

describe("Claude on Vertex AI refuses URL sources", () => {
  it("an image by URL: a non-retryable 400 that says what to do, sent nowhere", async () => {
    const { provider, calls } = setup();
    const err: any = await provider.complete({ model: MODEL, messages: [user({ type: "text", text: "what is this?" }, urlImage)] }).catch((e) => e);

    expect(err).toBeInstanceOf(ProviderError);
    expect(err.name).toBe("ProviderError");
    expect(err.statusCode).toBe(400);
    expect(err.provider).toBe("vertex");
    expect(err.message).toMatch(/does not accept URL sources/);
    expect(err.message).toMatch(/messages\[0\]\.content\[1\] \(image\)/);
    expect(err.message).toMatch(/base64/);
    // Never fetched, never sent, never retried.
    expect(calls).toHaveLength(0);
  });

  it("the message never echoes the URL (it may carry a signature)", async () => {
    const { provider } = setup();
    const err: any = await provider.complete({ model: MODEL, messages: [user(urlImage)] }).catch((e) => e);
    expect(err.message).not.toContain("files.example.test");
    expect(err.message).not.toContain("s3cr3t");
  });

  it("a document by URL is refused the same way", async () => {
    const { provider, calls } = setup();
    const err: any = await provider.complete({ model: MODEL, messages: [user(urlPdf)] }).catch((e) => e);
    expect(err.statusCode).toBe(400);
    expect(err.message).toMatch(/messages\[0\]\.content\[0\] \(document\)/);
    expect(calls).toHaveLength(0);
  });

  it("a URL inside a tool result is found too", async () => {
    const { provider, calls } = setup();
    const err: any = await provider
      .complete({
        model: MODEL,
        messages: [
          { role: "user", content: "go" },
          { role: "assistant", content: "", toolCalls: [{ id: "t1", name: "snap", arguments: "{}" }] },
          { role: "tool", toolCallId: "t1", content: [urlImage] },
        ],
      })
      .catch((e) => e);
    expect(err.statusCode).toBe(400);
    expect(err.message).toMatch(/messages\[2\]\.content\[0\]\.content\[0\] \(image\)/);
    expect(calls).toHaveLength(0);
  });

  it("says how many more there are", async () => {
    const { provider } = setup();
    const err: any = await provider.complete({ model: MODEL, messages: [user(urlImage, urlPdf)] }).catch((e) => e);
    expect(err.message).toMatch(/messages\[0\]\.content\[0\] \(image\) and 1 more/);
  });

  it("the streaming call is refused before the first chunk", async () => {
    const { provider, calls } = setup();
    await expect(drain(provider.completeStream({ model: MODEL, messages: [user(urlImage)] }))).rejects.toMatchObject({
      name: "ProviderError",
      statusCode: 400,
    });
    expect(calls).toHaveLength(0);
  });

  it("the refusal comes before any token work", async () => {
    const getAccessToken = vi.fn(async () => "tok");
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify(CLAUDE_OK), { status: 200 })) as unknown as typeof fetch;
    const p = new VertexAnthropicProvider({ projectId: "proj", location: "us-east5", getAccessToken, fetch: fetchImpl, retry: { maxRetries: 0 } });
    const err: any = await p.complete({ model: MODEL, messages: [user(urlImage)] }).catch((e) => e);
    expect(err.statusCode).toBe(400);
    expect(getAccessToken).not.toHaveBeenCalled();
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe("what still works", () => {
  it("base64 images and documents go through, inline", async () => {
    const { provider, calls } = setup();
    const res = await provider.complete({
      model: MODEL,
      messages: [
        user(
          { type: "image", source: { type: "base64", mediaType: "image/png", data: "AAAA" } },
          { type: "file", source: { type: "base64", mediaType: "application/pdf", data: "JVBER" }, fileName: "a.pdf" },
        ),
      ],
    });
    expect(res.content).toBe("hello");
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toMatch(/:rawPredict$/);
    expect(calls[0].body.messages[0].content).toEqual([
      { type: "image", source: { type: "base64", media_type: "image/png", data: "AAAA" } },
      { type: "document", source: { type: "base64", media_type: "application/pdf", data: "JVBER" }, title: "a.pdf" },
    ]);
  });

  it("text-only requests are not affected", async () => {
    const { provider, calls } = setup();
    await provider.complete({ model: MODEL, messages: [{ role: "user", content: "hi" }] });
    expect(calls).toHaveLength(1);
  });

  it("the direct Anthropic API still takes URL sources: only Vertex refuses them", async () => {
    let body: any;
    const fetchImpl = (async (_url: unknown, init: any) => {
      body = JSON.parse(init.body);
      return new Response(JSON.stringify(CLAUDE_OK), { status: 200 });
    }) as unknown as typeof fetch;
    const p = new AnthropicProvider({ provider: "anthropic", apiKey: "k", fetch: fetchImpl, retry: { maxRetries: 0 } });
    await p.complete({ model: "claude-sonnet-4-6", messages: [user(urlImage)] });
    expect(body.messages[0].content[0]).toEqual({ type: "image", source: { type: "url", url: IMAGE_URL } });
  });
});
