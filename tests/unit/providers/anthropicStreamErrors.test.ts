/**
 * Anthropic Messages stop reasons and stream failures (also Claude on Vertex AI, which
 * shares the parser):
 *  - `refusal` is a content filter, `pause_turn` stays "stop", and the raw value is
 *    always kept in `rawFinishReason`;
 *  - an SSE `error` event is a ProviderError whose status comes from the error type, so
 *    the same retry rule applies as for the HTTP answer (429 and 5xx);
 *  - a body that ends before the message finished is a retryable 502, not a quiet end,
 *    unless the caller cancelled the call.
 */

import { describe, it, expect } from "vitest";
import { AnthropicProvider, anthropicErrorStatus } from "../../../src/providers/anthropic.js";
import { VertexAnthropicProvider } from "../../../src/providers/vertexAnthropic.js";
import { ProviderError, type ChatCompletionChunk, type ChatCompletionRequest } from "../../../src/providers/types.js";

const msgs = [{ role: "user" as const, content: "hi" }];

const ev = (event: string, data: Record<string, unknown>) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
const start = ev("message_start", {
  type: "message_start",
  message: { id: "m1", model: "c", usage: { input_tokens: 3, output_tokens: 1 } },
});
const text = (t: string) =>
  ev("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: t } });
const stop = ev("message_stop", { type: "message_stop" });
const delta = (stopReason: string) =>
  ev("message_delta", { type: "message_delta", delta: { stop_reason: stopReason }, usage: { output_tokens: 5 } });
const errorEvent = (type: string, message?: string) =>
  ev("error", { type: "error", error: { type, ...(message ? { message } : {}) } });

const sse = (body: BodyInit) => new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });

function direct(body: BodyInit): AnthropicProvider {
  const fetchImpl = (async () => sse(body)) as unknown as typeof fetch;
  return new AnthropicProvider({ provider: "anthropic", apiKey: "k", fetch: fetchImpl, retry: { maxRetries: 0 } });
}

function onVertex(body: BodyInit): VertexAnthropicProvider {
  const fetchImpl = (async () => sse(body)) as unknown as typeof fetch;
  return new VertexAnthropicProvider({
    projectId: "p",
    location: "us-east5",
    getAccessToken: async () => "tok",
    fetch: fetchImpl,
    retry: { maxRetries: 0 },
  });
}

/** Drains a stream; the chunks that came before a failure are kept next to it. */
async function run(
  provider: { completeStream(request: ChatCompletionRequest): AsyncGenerator<ChatCompletionChunk, void, unknown> },
  request: Partial<ChatCompletionRequest> = {},
): Promise<{ chunks: ChatCompletionChunk[]; error: any }> {
  const chunks: ChatCompletionChunk[] = [];
  let error: any;
  try {
    for await (const c of provider.completeStream({ model: "c", messages: msgs, ...request })) chunks.push(c);
  } catch (e) {
    error = e;
  }
  return { chunks, error };
}

const streamedText = (chunks: ChatCompletionChunk[]) => chunks.map((c) => c.delta.content).filter(Boolean);

/** The SDK's own retry rule for an HTTP answer (`doFetchWithRetry`): 429 and 5xx. */
const retryable = (status: number | undefined) => status === 429 || (status !== undefined && status >= 500 && status < 600);

describe("Anthropic stop reasons", () => {
  const cases: Array<[string, string]> = [
    ["end_turn", "stop"],
    ["stop_sequence", "stop"],
    // The turn is NOT finished (a server tool hit its iteration limit), but there is no
    // unified "paused" reason: it stays "stop" and the raw value says what happened.
    ["pause_turn", "stop"],
    ["tool_use", "tool_calls"],
    ["max_tokens", "length"],
    ["model_context_window_exceeded", "length"],
    ["refusal", "content_filter"],
    ["a_reason_added_later", "stop"],
  ];

  it.each(cases)("complete(): %s maps to %s and the raw value is kept", async (raw, unified) => {
    const reply = { id: "m", model: "c", content: [{ type: "text", text: "x" }], stop_reason: raw, usage: { input_tokens: 1, output_tokens: 1 } };
    const fetchImpl = (async () => new Response(JSON.stringify(reply), { status: 200 })) as unknown as typeof fetch;
    const p = new AnthropicProvider({ provider: "anthropic", apiKey: "k", fetch: fetchImpl, retry: { maxRetries: 0 } });
    const res = await p.complete({ model: "c", messages: msgs });
    expect(res.finishReason).toBe(unified);
    expect(res.rawFinishReason).toBe(raw);
  });

  it.each(cases)("completeStream(): %s maps to %s and the raw value is kept", async (raw, unified) => {
    const { chunks, error } = await run(direct(start + text("x") + delta(raw) + stop));
    expect(error).toBeUndefined();
    const last = chunks.find((c) => c.finishReason);
    expect(last?.finishReason).toBe(unified);
    expect(last?.rawFinishReason).toBe(raw);
  });

  it("complete(): no raw value when the response names no stop reason", async () => {
    const reply = { id: "m", model: "c", content: [{ type: "text", text: "x" }], usage: { input_tokens: 1, output_tokens: 1 } };
    const fetchImpl = (async () => new Response(JSON.stringify(reply), { status: 200 })) as unknown as typeof fetch;
    const p = new AnthropicProvider({ provider: "anthropic", apiKey: "k", fetch: fetchImpl, retry: { maxRetries: 0 } });
    const res = await p.complete({ model: "c", messages: msgs });
    expect("rawFinishReason" in res).toBe(false);
  });
});

describe("anthropicErrorStatus", () => {
  it.each([
    ["invalid_request_error", 400],
    ["authentication_error", 401],
    ["billing_error", 402],
    ["permission_error", 403],
    ["not_found_error", 404],
    ["conflict_error", 409],
    ["request_too_large", 413],
    ["rate_limit_error", 429],
    ["api_error", 500],
    ["timeout_error", 504],
    ["overloaded_error", 529],
  ])("%s is HTTP %s", (type, status) => {
    expect(anthropicErrorStatus(type)).toBe(status);
  });

  it("an error type it does not know has no status rather than a guessed one", () => {
    expect(anthropicErrorStatus("some_new_error")).toBeUndefined();
    expect(anthropicErrorStatus(undefined)).toBeUndefined();
    expect(anthropicErrorStatus(500)).toBeUndefined();
  });
});

describe("Anthropic stream error events", () => {
  it.each([
    ["invalid_request_error", 400],
    ["authentication_error", 401],
    ["billing_error", 402],
    ["permission_error", 403],
    ["not_found_error", 404],
    ["conflict_error", 409],
    ["request_too_large", 413],
    ["rate_limit_error", 429],
    ["api_error", 500],
    ["timeout_error", 504],
    ["overloaded_error", 529],
  ])("%s becomes a ProviderError with HTTP %s and the message kept", async (type, status) => {
    const { error } = await run(direct(start + errorEvent(type, "the upstream message")));
    expect(error).toBeInstanceOf(ProviderError);
    expect(error.provider).toBe("anthropic");
    expect(error.statusCode).toBe(status);
    expect(error.message).toBe("the upstream message");
    // Retried like the HTTP answer would be: only 429 and 5xx.
    expect(retryable(error.statusCode)).toBe(status === 429 || status >= 500);
  });

  it("keeps the raw event as the response body, as the response text is on an HTTP error", async () => {
    const payload = { type: "error", error: { type: "overloaded_error", message: "Overloaded" } };
    const { error } = await run(direct(start + ev("error", payload)));
    expect(error.responseBody).toBe(JSON.stringify(payload));
  });

  it("an unknown error type has no status, and a missing message gets a fallback", async () => {
    const { error } = await run(direct(start + errorEvent("some_new_error")));
    expect(error).toBeInstanceOf(ProviderError);
    expect(error.statusCode).toBeUndefined();
    expect(error.message).toBe("Unknown Anthropic streaming error");
  });

  it("what streamed before the error is still delivered", async () => {
    const { chunks, error } = await run(direct(start + text("Hel") + errorEvent("overloaded_error", "busy")));
    expect(streamedText(chunks)).toEqual(["Hel"]);
    expect(error.statusCode).toBe(529);
    expect(chunks.some((c) => c.finishReason)).toBe(false);
  });
});

describe("Anthropic stream that ends before the message finished", () => {
  it("is a retryable 502 after what streamed, not a quiet end", async () => {
    const { chunks, error } = await run(direct(start + text("Hel")));
    expect(error).toBeInstanceOf(ProviderError);
    expect(error.statusCode).toBe(502);
    expect(retryable(error.statusCode)).toBe(true);
    expect(error.message).toBe("Anthropic stream ended before the message finished");
    expect(streamedText(chunks)).toEqual(["Hel"]);
    // The early usage chunk went out before the cut, so a host can still bill the input.
    expect(chunks.find((c) => c.usage)?.usage).toMatchObject({ inputTokens: 3 });
    expect(chunks.some((c) => c.finishReason)).toBe(false);
  });

  it("a tool call cut halfway is not passed off as a finished one", async () => {
    const open = ev("content_block_start", {
      type: "content_block_start",
      index: 1,
      content_block: { type: "tool_use", id: "tu1", name: "get_weather", input: {} },
    });
    const partial = ev("content_block_delta", {
      type: "content_block_delta",
      index: 1,
      delta: { type: "input_json_delta", partial_json: '{"city":' },
    });
    const { chunks, error } = await run(direct(start + open + partial));
    expect(error.statusCode).toBe(502);
    expect(chunks.flatMap((c) => c.delta.toolCalls ?? []).map((t) => t.arguments).join("")).toBe('{"city":');
    expect(chunks.some((c) => c.finishReason)).toBe(false);
  });

  it("a message_delta with a stop reason finishes the message even when message_stop never arrives", async () => {
    const { chunks, error } = await run(direct(start + text("ok") + delta("end_turn")));
    expect(error).toBeUndefined();
    expect(chunks.find((c) => c.finishReason)?.finishReason).toBe("stop");
  });

  it("message_stop alone finishes it too", async () => {
    const { error } = await run(direct(start + text("ok") + stop));
    expect(error).toBeUndefined();
  });

  it("names the API it came from: Claude on Vertex AI says so", async () => {
    const { chunks, error } = await run(onVertex(start + text("Hel")), { model: "claude-sonnet-4-6" });
    expect(error).toBeInstanceOf(ProviderError);
    expect(error.provider).toBe("vertex");
    expect(error.statusCode).toBe(502);
    expect(error.message).toBe("Vertex AI stream ended before the message finished");
    expect(streamedText(chunks)).toEqual(["Hel"]);
  });

  it("an error event on Vertex is mapped the same way", async () => {
    const { error } = await run(onVertex(start + errorEvent("overloaded_error", "busy")), { model: "claude-sonnet-4-6" });
    expect(error.provider).toBe("vertex");
    expect(error.statusCode).toBe(529);
  });

  it("a call the caller cancelled ends quietly: that is not a failure of the stream", async () => {
    const ac = new AbortController();
    const encoder = new TextEncoder();
    let pulls = 0;
    // highWaterMark 0: a chunk is produced only when a read is waiting for it, so the
    // body closes while the next read is pending, after the caller has given up.
    const body = new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          pulls += 1;
          if (pulls === 1) {
            controller.enqueue(encoder.encode(start + text("Hel")));
            return;
          }
          ac.abort();
          controller.close();
        },
      },
      { highWaterMark: 0 },
    );
    const { chunks, error } = await run(direct(body), { signal: ac.signal });
    expect(error).toBeUndefined();
    expect(streamedText(chunks)).toEqual(["Hel"]);
    expect(chunks.some((c) => c.finishReason)).toBe(false);
  });
});
