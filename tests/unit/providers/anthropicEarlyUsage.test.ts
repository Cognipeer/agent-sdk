import { describe, it, expect } from "vitest";
import { AnthropicProvider } from "../../../src/providers/anthropic.js";
import { fromNativeProvider } from "../../../src/providers/adapter.js";
import type { ChatCompletionChunk } from "../../../src/providers/types.js";

const ev = (event: string, data: any) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
const msgs = [{ role: "user" as const, content: "hi" }];

function provider(events: string[]) {
  const fn = (async () => new Response(events.join(""), { status: 200, headers: { "content-type": "text/event-stream" } })) as unknown as typeof fetch;
  return new AnthropicProvider({ provider: "anthropic", apiKey: "k", fetch: fn });
}

async function collect(p: AnthropicProvider): Promise<ChatCompletionChunk[]> {
  const out: ChatCompletionChunk[] = [];
  for await (const c of p.completeStream({ model: "c", messages: msgs })) out.push(c);
  return out;
}

const start = ev("message_start", {
  message: { id: "m1", model: "c", usage: { input_tokens: 3, cache_read_input_tokens: 100, cache_creation_input_tokens: 5, output_tokens: 1 } },
});

describe("Anthropic stream usage is reported early and cumulatively", () => {
  it("a stream cut after message_start still carries the input and cache counters (no finish reason), then fails as truncated", async () => {
    // Deliberate change (truncated-stream rule): the cut is a retryable error after the early usage chunk.
    const chunks: ChatCompletionChunk[] = [];
    const error: any = await (async () => {
      try {
        for await (const c of provider([start, ev("content_block_start", { index: 0, content_block: { type: "text" } })]).completeStream({ model: "c", messages: msgs })) chunks.push(c);
      } catch (e) {
        return e;
      }
    })();
    expect(error).toMatchObject({ message: "Anthropic stream ended before the message finished", statusCode: 502 });
    const usage = chunks.filter((c) => c.usage);
    expect(usage).toHaveLength(1);
    expect(usage[0].usage).toMatchObject({ inputTokens: 3, cachedInputTokens: 100, cachedWriteTokens: 5, outputTokens: 1, totalTokens: 4 });
    expect(usage[0].finishReason).toBeUndefined();
    expect(usage[0].delta).toEqual({});
  });

  it("message_delta supersedes it with the final cumulative usage (the last chunk wins, nothing is added)", async () => {
    const chunks = await collect(
      provider([start, ev("message_delta", { delta: { stop_reason: "end_turn" }, usage: { output_tokens: 42 } })]),
    );
    const usage = chunks.filter((c) => c.usage);
    expect(usage).toHaveLength(2);
    expect(usage.at(-1)!.usage).toMatchObject({ inputTokens: 3, cachedInputTokens: 100, cachedWriteTokens: 5, outputTokens: 42, totalTokens: 45 });
    expect(usage.at(-1)!.finishReason).toBe("stop");
  });

  it("message_delta that repeats the input side replaces the message_start values", async () => {
    const chunks = await collect(
      provider([
        start,
        ev("message_delta", {
          delta: { stop_reason: "end_turn" },
          usage: { input_tokens: 4, cache_read_input_tokens: 110, cache_creation_input_tokens: 0, output_tokens: 9 },
        }),
      ]),
    );
    expect(chunks.at(-1)!.usage).toMatchObject({ inputTokens: 4, cachedInputTokens: 110, cachedWriteTokens: 0, outputTokens: 9 });
  });

  it("reasoning tokens are the reported count, 0 when not reported (never estimated)", async () => {
    const thinking = [
      ev("content_block_start", { index: 0, content_block: { type: "thinking", thinking: "" } }),
      ev("content_block_delta", { index: 0, delta: { type: "thinking_delta", thinking: "a long chain of thought here" } }),
      ev("content_block_stop", { index: 0 }),
    ];
    const without = await collect(provider([start, ...thinking, ev("message_delta", { delta: { stop_reason: "end_turn" }, usage: { output_tokens: 30 } })]));
    expect(without.at(-1)!.usage!.reasoningTokens).toBe(0);
    const reported = await collect(
      provider([start, ...thinking, ev("message_delta", { delta: { stop_reason: "end_turn" }, usage: { output_tokens: 30, output_tokens_details: { thinking_tokens: 12 } } })]),
    );
    expect(reported.at(-1)!.usage!.reasoningTokens).toBe(12);
  });

  it("through the adapter the final message is inclusive: prompt = input + read + write", async () => {
    const model = fromNativeProvider(
      provider([start, ev("content_block_start", { index: 0, content_block: { type: "text" } }), ev("content_block_delta", { index: 0, delta: { type: "text_delta", text: "ok" } }), ev("message_delta", { delta: { stop_reason: "end_turn" }, usage: { output_tokens: 42 } })]),
      { model: "c" },
    );
    let last: any;
    for await (const part of model.stream!(msgs)) last = part;
    expect(last.usage).toMatchObject({ prompt_tokens: 108, completion_tokens: 42, total_tokens: 150 });
  });
});
