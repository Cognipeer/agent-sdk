/**
 * Bedrock Converse stop reasons and truncated streams:
 *  - a malformed model output or tool call is an "error" finish, a guardrail or content
 *    filter is "content_filter", and the raw stop reason is always kept;
 *  - an event stream that ends without `messageStop` is a retryable 502, not a quiet
 *    "stop" with half a message, unless the caller cancelled the call.
 */

import { describe, it, expect } from "vitest";
import { BedrockProvider } from "../../../src/providers/bedrock.js";
import { encodeFrame } from "../../../src/providers/utils/eventStream.js";
import { ProviderError, type ChatCompletionChunk, type ChatCompletionRequest } from "../../../src/providers/types.js";

const msgs = [{ role: "user" as const, content: "hi" }];

const evt = (type: string, payload: unknown) =>
  encodeFrame({ ":message-type": "event", ":event-type": type, ":content-type": "application/json" }, JSON.stringify(payload));

const messageStart = () => evt("messageStart", { role: "assistant" });
const textDelta = (t: string) => evt("contentBlockDelta", { contentBlockIndex: 0, delta: { text: t } });
const messageStop = (stopReason: string) => evt("messageStop", { stopReason });
const metadata = () => evt("metadata", { usage: { inputTokens: 4, outputTokens: 2 }, metrics: {} });

function streamOf(frames: Uint8Array[]): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(c) {
      for (const f of frames) c.enqueue(f);
      c.close();
    },
  });
}

function bedrock(fetchImpl: unknown): BedrockProvider {
  return new BedrockProvider({
    provider: "bedrock",
    region: "us-east-1",
    accessKeyId: "AK",
    secretAccessKey: "SK",
    fetch: fetchImpl as typeof fetch,
    retry: { maxRetries: 0 },
  });
}

const streaming = (body: ReadableStream<Uint8Array>) => bedrock(async () => new Response(body, { status: 200 }));

/** Drains a stream; the chunks that came before a failure are kept next to it. */
async function run(
  provider: BedrockProvider,
  request: Partial<ChatCompletionRequest> = {},
): Promise<{ chunks: ChatCompletionChunk[]; error: any }> {
  const chunks: ChatCompletionChunk[] = [];
  let error: any;
  try {
    for await (const c of provider.completeStream({ model: "anthropic.claude-x", messages: msgs, ...request })) chunks.push(c);
  } catch (e) {
    error = e;
  }
  return { chunks, error };
}

const streamedText = (chunks: ChatCompletionChunk[]) => chunks.map((c) => c.delta.content).filter(Boolean);

/** The SDK's own retry rule for an HTTP answer (`doFetchWithRetry`): 429 and 5xx. */
const retryable = (status: number | undefined) => status === 429 || (status !== undefined && status >= 500 && status < 600);

describe("Bedrock stop reasons", () => {
  const cases: Array<[string, string]> = [
    ["end_turn", "stop"],
    ["stop_sequence", "stop"],
    ["tool_use", "tool_calls"],
    ["max_tokens", "length"],
    ["model_context_window_exceeded", "length"],
    // A guardrail or content filter withheld the answer: an HTTP 200, not an error.
    ["guardrail_intervened", "content_filter"],
    ["content_filtered", "content_filter"],
    // The model's own output or tool call came out malformed: the turn did not finish.
    ["malformed_model_output", "error"],
    ["malformed_tool_use", "error"],
    ["a_reason_added_later", "stop"],
  ];

  it.each(cases)("converse: %s maps to %s and the raw value is kept", async (raw, unified) => {
    const reply = {
      output: { message: { role: "assistant", content: [{ text: "x" }] } },
      stopReason: raw,
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
    };
    const p = bedrock(async () => new Response(JSON.stringify(reply), { status: 200 }));
    const res = await p.complete({ model: "anthropic.claude-x", messages: msgs });
    expect(res.finishReason).toBe(unified);
    expect(res.rawFinishReason).toBe(raw);
  });

  it.each(cases)("converse-stream: %s maps to %s and the raw value is kept", async (raw, unified) => {
    const { chunks, error } = await run(streaming(streamOf([messageStart(), textDelta("x"), messageStop(raw), metadata()])));
    expect(error).toBeUndefined();
    const last = chunks[chunks.length - 1];
    expect(last.finishReason).toBe(unified);
    expect(last.rawFinishReason).toBe(raw);
    expect(last.usage).toMatchObject({ inputTokens: 4, outputTokens: 2 });
  });
});

describe("Bedrock stream that ends before the message finished", () => {
  it("is a retryable 502 after what streamed, not a quiet stop", async () => {
    const { chunks, error } = await run(streaming(streamOf([messageStart(), textDelta("Hel")])));
    expect(error).toBeInstanceOf(ProviderError);
    expect(error.provider).toBe("bedrock");
    expect(error.statusCode).toBe(502);
    expect(retryable(error.statusCode)).toBe(true);
    expect(error.message).toBe("Bedrock stream ended before the message finished");
    expect(streamedText(chunks)).toEqual(["Hel"]);
    // No closing chunk with a finish reason: the message did not finish.
    expect(chunks.some((c) => c.finishReason)).toBe(false);
  });

  it("a tool call cut halfway is not passed off as a finished one", async () => {
    const open = evt("contentBlockStart", { contentBlockIndex: 1, start: { toolUse: { toolUseId: "tu1", name: "get_weather" } } });
    const partial = evt("contentBlockDelta", { contentBlockIndex: 1, delta: { toolUse: { input: '{"city":' } } });
    const { chunks, error } = await run(streaming(streamOf([messageStart(), open, partial])));
    expect(error.statusCode).toBe(502);
    expect(chunks.flatMap((c) => c.delta.toolCalls ?? []).map((t) => t.arguments).join("")).toBe('{"city":');
    expect(chunks.some((c) => c.finishReason)).toBe(false);
  });

  it("an empty body is the same failure", async () => {
    const { chunks, error } = await run(streaming(streamOf([])));
    expect(error.statusCode).toBe(502);
    expect(chunks).toEqual([]);
  });

  it("messageStop without the usage event still finishes the message", async () => {
    const { chunks, error } = await run(streaming(streamOf([messageStart(), textDelta("ok"), messageStop("end_turn")])));
    expect(error).toBeUndefined();
    const last = chunks[chunks.length - 1];
    expect(last.finishReason).toBe("stop");
    expect(last.usage).toBeUndefined();
  });

  it("an in-stream exception keeps its own status", async () => {
    const bad = encodeFrame(
      { ":message-type": "exception", ":exception-type": "throttlingException", ":content-type": "application/json" },
      JSON.stringify({ message: "slow down" }),
    );
    const { error } = await run(streaming(streamOf([messageStart(), bad])));
    expect(error.statusCode).toBe(429);
  });

  it("a call the caller cancelled ends quietly: that is not a failure of the stream", async () => {
    const ac = new AbortController();
    let pulls = 0;
    // highWaterMark 0: a chunk is produced only when a read is waiting for it, so the
    // body closes while the next read is pending, after the caller has given up.
    const body = new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          pulls += 1;
          if (pulls === 1) {
            controller.enqueue(messageStart());
            return;
          }
          ac.abort();
          controller.close();
        },
      },
      { highWaterMark: 0 },
    );
    const { chunks, error } = await run(streaming(body), { signal: ac.signal });
    expect(error).toBeUndefined();
    // Nothing is handed over as if it were a finished message.
    expect(chunks.some((c) => c.finishReason)).toBe(false);
  });
});
