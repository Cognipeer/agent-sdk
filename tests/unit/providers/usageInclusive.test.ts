import { describe, it, expect } from "vitest";
import { fromNativeProvider, emptyUsage } from "../../../src/providers/index.js";
import { toMessageUsage } from "../../../src/providers/adapter.js";
import { wireInfoOf } from "../../../src/providers/wireInfo.js";
import { traceResponseFacts } from "../../../src/utils/traceFacts.js";
import { genAiUsageOf } from "../../../src/utils/otlp/semconv.js";
import type { ChatCompletionChunk, ChatCompletionResponse, TokenUsage } from "../../../src/providers/types.js";

/** Native Anthropic/Bedrock counters: 10 uncached input, 90 read, 5 written, 20 output. */
const native: TokenUsage = {
  ...emptyUsage(),
  inputTokens: 10,
  outputTokens: 20,
  totalTokens: 30,
  cachedInputTokens: 90,
  cachedWriteTokens: 5,
  reasoningTokens: 8,
};

function fakeProvider(providerName: string, usage: TokenUsage, extra: Record<string, unknown> = {}): any {
  return {
    providerName,
    ...extra,
    async complete(): Promise<ChatCompletionResponse> {
      return { id: "r1", model: "m", content: "hi", toolCalls: [], usage, finishReason: "stop", raw: {} };
    },
    async *completeStream(): AsyncGenerator<ChatCompletionChunk> {
      yield { id: "r1", model: "m", delta: { content: "hi" } };
      yield { id: "r1", model: "m", delta: {}, usage, finishReason: "stop" };
    },
  };
}

const user = [{ role: "user", content: "hello" }];

async function streamed(provider: any): Promise<any> {
  let last: any;
  for await (const part of fromNativeProvider(provider, { model: "m" }).stream!(user)) last = part;
  return last;
}

describe("fromNativeProvider converts the provider's usage to the inclusive MessageUsage", () => {
  it.each(["anthropic", "bedrock"])("%s: prompt includes cache read + write, total = prompt + completion", async (name) => {
    for (const message of [await fromNativeProvider(fakeProvider(name, native), { model: "m" }).invoke(user), await streamed(fakeProvider(name, native))]) {
      expect(message.usage).toEqual({
        prompt_tokens: 105,
        completion_tokens: 20,
        total_tokens: 125,
        // The details stay subsets of the inclusive prompt.
        prompt_tokens_details: { cached_tokens: 90, cache_write_tokens: 5 },
        completion_tokens_details: { reasoning_tokens: 8 },
      });
      expect(message.response_metadata.token_usage).toMatchObject({
        prompt_tokens: 105,
        completion_tokens: 20,
        total_tokens: 125,
        cached_tokens: 90,
        cache_write_tokens: 5,
      });
      // Converted: the message claims no exclusive basis any more.
      expect(wireInfoOf(message)).not.toHaveProperty("usageBasis");
    }
  });

  it("vertex: completion includes the thoughts, total = prompt + completion", async () => {
    const vertex: TokenUsage = { ...emptyUsage(), inputTokens: 40, outputTokens: 20, totalTokens: 0, cachedInputTokens: 10, reasoningTokens: 8 };
    const message = await fromNativeProvider(fakeProvider("vertex", vertex), { model: "m" }).invoke(user);
    expect(message.usage).toMatchObject({ prompt_tokens: 40, completion_tokens: 28, total_tokens: 68 });
    expect(message.usage.prompt_tokens_details.cached_tokens).toBe(10);
    expect(wireInfoOf(message)).not.toHaveProperty("usageBasis");
    expect((await streamed(fakeProvider("vertex", vertex))).usage).toMatchObject({ completion_tokens: 28, total_tokens: 68 });
  });

  it("an inclusive provider (openai) is copied as it is, provider total included", async () => {
    const openai: TokenUsage = { ...native, inputTokens: 105, totalTokens: 125 };
    const message = await fromNativeProvider(fakeProvider("openai", openai), { model: "m" }).invoke(user);
    expect(message.usage).toMatchObject({ prompt_tokens: 105, completion_tokens: 20, total_tokens: 125 });
  });

  it("provider.usageBasis = {} means already inclusive, even under an exclusive provider name", async () => {
    const canonical: TokenUsage = { ...native, inputTokens: 105, totalTokens: 125 };
    const message = await fromNativeProvider(fakeProvider("anthropic", canonical, { usageBasis: {} }), { model: "m" }).invoke(user);
    expect(message.usage).toMatchObject({ prompt_tokens: 105, total_tokens: 125 });
    expect((await streamed(fakeProvider("anthropic", canonical, { usageBasis: {} }))).usage.prompt_tokens).toBe(105);
  });

  it("an explicit exclusive usageBasis overrides the provider name", async () => {
    const message = await fromNativeProvider(fakeProvider("openai-compatible", native, { usageBasis: { inputExcludesCache: true } }), { model: "m" }).invoke(user);
    expect(message.usage).toMatchObject({ prompt_tokens: 105, completion_tokens: 20, total_tokens: 125 });
  });

  it("toMessageUsage: no basis = copy; each flag adjusts only its side", () => {
    expect(toMessageUsage(native)).toMatchObject({ prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 });
    expect(toMessageUsage(native, { outputExcludesReasoning: true })).toMatchObject({ prompt_tokens: 10, completion_tokens: 28, total_tokens: 38 });
    expect(toMessageUsage(native, { inputExcludesCache: true })).toMatchObject({ prompt_tokens: 105, completion_tokens: 20, total_tokens: 125 });
  });
});

describe("the trace and the OTLP export take the converted figure once", () => {
  it("adapter(anthropic input 10 + read 90 + write 5) => record input 105, cacheRead 90, cacheWrite 5, no basis, gen_ai input 105", async () => {
    const message = await fromNativeProvider(fakeProvider("anthropic", native), { model: "m" }).invoke(user);
    const facts = traceResponseFacts(undefined, message, message.usage);
    expect(facts).not.toHaveProperty("usageBasis");
    expect(facts.cacheWriteTokens).toBe(5);
    const record: any = {
      inputTokens: message.usage.prompt_tokens,
      outputTokens: message.usage.completion_tokens,
      cachedInputTokens: message.usage.prompt_tokens_details.cached_tokens,
      cacheWriteTokens: facts.cacheWriteTokens,
      reasoningTokens: message.usage.completion_tokens_details.reasoning_tokens,
      ...(facts as any).usageBasis ? { usageBasis: (facts as any).usageBasis } : {},
    };
    expect(genAiUsageOf(record)).toMatchObject({ input: 105, output: 20, cacheRead: 90, cacheWrite: 5, reasoning: 8 });
  });

  it("a hand-built message that declares an exclusive basis still folds in the exporter", () => {
    expect(genAiUsageOf({ inputTokens: 10, outputTokens: 20, cachedInputTokens: 90, cacheWriteTokens: 5, usageBasis: { inputExcludesCache: true } } as any)).toMatchObject({
      input: 105,
    });
  });
});
