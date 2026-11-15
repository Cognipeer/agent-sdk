import { describe, it, expect } from "vitest";
import { OpenAIProvider } from "../../../src/providers/openai.js";
import { OpenAICompatibleProvider } from "../../../src/providers/openaiCompatible.js";
import { AzureProvider } from "../../../src/providers/azure.js";
import type { TokenUsage, UsageCounting } from "../../../src/providers/types.js";

const msgs = [{ role: "user" as const, content: "hi" }];

const jsonFetch = (body: unknown) =>
  (async () => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } })) as unknown as typeof fetch;

const sseFetch = (events: unknown[]) =>
  (async () =>
    new Response(events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join("") + "data: [DONE]\n\n", {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    })) as unknown as typeof fetch;

const chat = (usage: unknown) => ({ id: "1", model: "m", choices: [{ message: { content: "x" }, finish_reason: "stop" }], usage });

function compatible(fetchFn: typeof fetch, usageCounting?: UsageCounting) {
  return new OpenAICompatibleProvider({
    provider: "openai-compatible",
    apiKey: "k",
    baseURL: "http://x/v1",
    fetch: fetchFn,
    ...(usageCounting ? { usageCounting } : {}),
  });
}

async function usageOf(usage: unknown, usageCounting?: UsageCounting): Promise<TokenUsage> {
  return (await compatible(jsonFetch(chat(usage)), usageCounting).complete({ model: "m", messages: msgs })).usage;
}

async function streamedUsageOf(usage: unknown, usageCounting?: UsageCounting): Promise<TokenUsage | undefined> {
  const p = compatible(
    sseFetch([
      { id: "1", model: "m", choices: [{ index: 0, delta: { content: "x" } }] },
      { id: "1", model: "m", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
      { id: "1", model: "m", choices: [], usage },
    ]),
    usageCounting,
  );
  let last: TokenUsage | undefined;
  for await (const chunk of p.completeStream({ model: "m", messages: msgs })) if (chunk.usage) last = chunk.usage;
  return last;
}

/** An Anthropic-style usage forwarded by a proxy: 10000 uncached, 100000 read, 50000 written, 10000 out. */
const HEAVY_CACHE = {
  prompt_tokens: 10_000,
  completion_tokens: 10_000,
  total_tokens: 20_000,
  prompt_tokens_details: { cached_tokens: 100_000, cache_write_tokens: 50_000 },
};

/** Same proxy, cache smaller than the uncached part: 10000 uncached, 2000 read. */
const SMALL_CACHE = { prompt_tokens: 10_000, completion_tokens: 100, total_tokens: 10_100, prompt_tokens_details: { cached_tokens: 2_000 } };

/** No prompt count at all, only the cache counters. */
const NO_PROMPT = { completion_tokens: 500, prompt_tokens_details: { cached_tokens: 1_000, cache_write_tokens: 500 } };

describe("usageCounting: exclusive", () => {
  it("adds the cache read + write to the prompt once (10000 + 100000 + 50000 = 160000)", async () => {
    expect(await usageOf(HEAVY_CACHE, "exclusive")).toEqual({
      inputTokens: 160_000,
      outputTokens: 10_000,
      totalTokens: 170_000,
      cachedInputTokens: 100_000,
      cachedWriteTokens: 50_000,
      cachedOutputTokens: 0,
      reasoningTokens: 0,
      inputTokensReported: true,
      outputTokensReported: true,
    });
  });

  it("adds a cache that is smaller than the prompt too (auto under-counts it)", async () => {
    expect(await usageOf(SMALL_CACHE, "exclusive")).toMatchObject({ inputTokens: 12_000, totalTokens: 12_100, cachedInputTokens: 2_000 });
    expect(await usageOf(SMALL_CACHE)).toMatchObject({ inputTokens: 10_000, totalTokens: 10_100 });
  });

  it("leaves a usage without cache counters as it is, the reported total included", async () => {
    expect(await usageOf({ prompt_tokens: 300, completion_tokens: 20, total_tokens: 321 }, "exclusive")).toMatchObject({
      inputTokens: 300,
      totalTokens: 321,
      inputTokensReported: true,
    });
  });

  it("applies to the streamed usage chunk", async () => {
    expect(await streamedUsageOf(HEAVY_CACHE, "exclusive")).toMatchObject({ inputTokens: 160_000, totalTokens: 170_000, inputTokensReported: true });
    expect(await streamedUsageOf(SMALL_CACHE, "exclusive")).toMatchObject({ inputTokens: 12_000 });
  });

  it("applies to the Responses API usage", async () => {
    const p = new OpenAICompatibleProvider({
      provider: "openai-compatible",
      apiKey: "k",
      baseURL: "http://x/v1",
      api: "responses",
      responsesStreaming: false,
      usageCounting: "exclusive",
      fetch: jsonFetch({
        id: "r",
        model: "m",
        status: "completed",
        output: [{ type: "message", content: [{ type: "output_text", text: "x" }] }],
        usage: { input_tokens: 10_000, output_tokens: 100, total_tokens: 10_100, input_tokens_details: { cached_tokens: 2_000 } },
      }),
    });
    expect((await p.complete({ model: "m", messages: msgs })).usage).toMatchObject({ inputTokens: 12_000, totalTokens: 12_100, inputTokensReported: true });
  });

  it("is passed through by AzureProvider", async () => {
    const p = new AzureProvider({
      provider: "azure",
      apiKey: "k",
      endpoint: "https://x.openai.azure.com",
      deploymentName: "d",
      usageCounting: "exclusive",
      fetch: jsonFetch(chat(SMALL_CACHE)),
    });
    expect((await p.complete({ model: "d", messages: msgs })).usage).toMatchObject({ inputTokens: 12_000 });
  });
});

describe("usageCounting: inclusive", () => {
  it("keeps the prompt as reported when the cache fits in it", async () => {
    expect(await usageOf(SMALL_CACHE, "inclusive")).toMatchObject({ inputTokens: 10_000, totalTokens: 10_100, cachedInputTokens: 2_000 });
  });

  it("never adds the cache: a prompt below read + write is raised to them, not summed", async () => {
    expect(await usageOf(HEAVY_CACHE, "inclusive")).toMatchObject({ inputTokens: 150_000, totalTokens: 160_000, inputTokensReported: true });
  });

  it("is passed through by OpenAIProvider", async () => {
    const p = new OpenAIProvider({ provider: "openai", apiKey: "k", usageCounting: "inclusive", fetch: jsonFetch(chat(HEAVY_CACHE)) });
    expect((await p.complete({ model: "gpt-4o", messages: msgs })).usage).toMatchObject({ inputTokens: 150_000 });
  });
});

describe("usageCounting: auto (default) keeps the 0.22 heuristic", () => {
  it("adds the cache only when read + write exceed the prompt", async () => {
    expect(await usageOf(HEAVY_CACHE)).toMatchObject({ inputTokens: 160_000, totalTokens: 170_000 });
    expect(await usageOf(HEAVY_CACHE, "auto")).toMatchObject({ inputTokens: 160_000, totalTokens: 170_000 });
    expect(await usageOf(SMALL_CACHE, "auto")).toMatchObject({ inputTokens: 10_000, totalTokens: 10_100 });
  });

  it("an unknown value (e.g. from untyped JSON config) is treated as auto", async () => {
    const p = compatible(jsonFetch(chat(SMALL_CACHE)), "bogus" as UsageCounting);
    expect((await p.complete({ model: "m", messages: msgs })).usage).toMatchObject({ inputTokens: 10_000 });
  });
});

describe("inputTokensReported", () => {
  it("is false when the usage has no prompt count, in every mode (the input is the cache alone, not a measurement)", async () => {
    for (const mode of [undefined, "auto", "inclusive", "exclusive"] as const) {
      expect(await usageOf(NO_PROMPT, mode)).toMatchObject({
        inputTokens: 1_500,
        outputTokens: 500,
        cachedInputTokens: 1_000,
        cachedWriteTokens: 500,
        inputTokensReported: false,
      });
    }
    expect(await streamedUsageOf(NO_PROMPT, "exclusive")).toMatchObject({ inputTokens: 1_500, inputTokensReported: false });
  });

  it("is true for an explicit 0 prompt", async () => {
    expect(await usageOf({ prompt_tokens: 0, completion_tokens: 500, prompt_tokens_details: { cached_tokens: 1_000, cache_write_tokens: 500 } }, "exclusive")).toMatchObject({
      inputTokens: 1_500,
      inputTokensReported: true,
    });
    expect(await usageOf({ prompt_tokens: 0, completion_tokens: 5 })).toMatchObject({ inputTokens: 0, inputTokensReported: true });
  });

  it("is false for a prompt count that is not a finite number >= 0", async () => {
    for (const prompt_tokens of [null, "100", -1, Number.NaN]) {
      expect(await usageOf({ prompt_tokens, completion_tokens: 5 })).toMatchObject({ inputTokens: 0, inputTokensReported: false });
    }
  });

  it("reads input_tokens (Responses spelling) too", async () => {
    expect(await usageOf({ input_tokens: 42, output_tokens: 1 })).toMatchObject({ inputTokens: 42, inputTokensReported: true });
  });

  it("is false when the response carries no usage object", async () => {
    expect(await usageOf(undefined)).toMatchObject({ inputTokens: 0, totalTokens: 0, inputTokensReported: false });
  });
});

/** A prompt count and a total, but no completion count (an incomplete upstream usage). */
const NO_COMPLETION = { prompt_tokens: 10_000, total_tokens: 20_000 };

describe("outputTokensReported", () => {
  it("is false when the usage has no completion count: the output is 0, not a measurement, and the reported total is kept", async () => {
    for (const mode of [undefined, "auto", "inclusive", "exclusive"] as const) {
      expect(await usageOf(NO_COMPLETION, mode)).toMatchObject({
        inputTokens: 10_000,
        outputTokens: 0,
        totalTokens: 20_000,
        inputTokensReported: true,
        outputTokensReported: false,
      });
    }
  });

  it("is false on the streamed usage chunk too", async () => {
    expect(await streamedUsageOf(NO_COMPLETION)).toMatchObject({ inputTokens: 10_000, outputTokens: 0, totalTokens: 20_000, outputTokensReported: false });
  });

  // The review fixture: a 40000-character answer (about 10000 tokens) billed by the upstream, whose usage says
  // prompt 10000, total 20000 and nothing about the completion. The SDK must not turn that into a measured 0: the
  // host gets the flag, the upstream's total and the whole answer, so it can bill the completion either way.
  const ANSWER = "y".repeat(40_000);
  const EXPECTED = { inputTokens: 10_000, outputTokens: 0, totalTokens: 20_000, inputTokensReported: true, outputTokensReported: false };

  it("review fixture, non-streamed: a 40000-character answer with no completion count is flagged, total and content intact", async () => {
    const body = { id: "1", model: "m", choices: [{ message: { content: ANSWER }, finish_reason: "stop" }], usage: NO_COMPLETION };
    const res = await compatible(jsonFetch(body), "exclusive").complete({ model: "m", messages: msgs });
    expect(res.usage).toMatchObject(EXPECTED);
    expect(res.content).toBe(ANSWER);
  });

  it("review fixture, streamed: a 40000-character answer with no completion count is flagged, total and content intact", async () => {
    const p = compatible(
      sseFetch([
        ...Array.from({ length: 4 }, (_, i) => ({
          id: "1",
          model: "m",
          choices: [{ index: 0, delta: { content: ANSWER.slice(i * 10_000, (i + 1) * 10_000) } }],
        })),
        { id: "1", model: "m", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
        { id: "1", model: "m", choices: [], usage: NO_COMPLETION },
      ]),
      "exclusive",
    );
    let text = "";
    let last: TokenUsage | undefined;
    for await (const chunk of p.completeStream({ model: "m", messages: msgs })) {
      if (chunk.delta.content) text += chunk.delta.content;
      if (chunk.usage) last = chunk.usage;
    }
    expect(last).toMatchObject(EXPECTED);
    expect(text).toBe(ANSWER);
  });

  it("is true for an explicit 0 completion", async () => {
    expect(await usageOf({ prompt_tokens: 10_000, completion_tokens: 0, total_tokens: 10_000 })).toMatchObject({
      outputTokens: 0,
      outputTokensReported: true,
    });
  });

  it("is false for a completion count that is not a finite number >= 0", async () => {
    for (const completion_tokens of [null, "100", -1]) {
      expect(await usageOf({ prompt_tokens: 5, completion_tokens })).toMatchObject({ outputTokens: 0, outputTokensReported: false });
    }
  });

  it("reads output_tokens (Responses spelling), on the Responses API too", async () => {
    expect(await usageOf({ input_tokens: 42, output_tokens: 7 })).toMatchObject({ outputTokens: 7, outputTokensReported: true });
    const p = new OpenAICompatibleProvider({
      provider: "openai-compatible",
      apiKey: "k",
      baseURL: "http://x/v1",
      api: "responses",
      responsesStreaming: false,
      fetch: jsonFetch({
        id: "r",
        model: "m",
        status: "completed",
        output: [{ type: "message", content: [{ type: "output_text", text: "x" }] }],
        usage: { input_tokens: 10_000, total_tokens: 20_000 },
      }),
    });
    expect((await p.complete({ model: "m", messages: msgs })).usage).toMatchObject({
      inputTokens: 10_000,
      outputTokens: 0,
      inputTokensReported: true,
      outputTokensReported: false,
    });
  });

  it("is independent of inputTokensReported", async () => {
    expect(await usageOf(NO_PROMPT)).toMatchObject({ inputTokensReported: false, outputTokensReported: true });
    expect(await usageOf(undefined)).toMatchObject({ inputTokensReported: false, outputTokensReported: false });
  });
});
