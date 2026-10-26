import { describe, it, expect } from "vitest";
import { OpenAIProvider } from "../../../src/providers/openai.js";
import { OpenAICompatibleProvider } from "../../../src/providers/openaiCompatible.js";

const msgs = [{ role: "user" as const, content: "hi" }];

async function usageOf(body: any, compat = true) {
  const fn = (async () => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } })) as unknown as typeof fetch;
  const p = compat
    ? new OpenAICompatibleProvider({ provider: "openai-compatible", apiKey: "k", baseURL: "http://x/v1", fetch: fn })
    : new OpenAIProvider({ provider: "openai", apiKey: "k", fetch: fn });
  return (await p.complete({ model: "m", messages: msgs })).usage;
}

const chat = (usage: any) => ({ id: "1", model: "m", choices: [{ message: { content: "x" }, finish_reason: "stop" }], usage });

describe("OpenAI-compatible cache dialects (prompt_tokens is inclusive in all of them)", () => {
  it("OpenAI / Azure / OpenRouter: prompt_tokens_details.cached_tokens + cache_write_tokens", async () => {
    expect(
      await usageOf(chat({ prompt_tokens: 100, completion_tokens: 10, total_tokens: 110, prompt_tokens_details: { cached_tokens: 60, cache_write_tokens: 20 } })),
    ).toMatchObject({ inputTokens: 100, outputTokens: 10, totalTokens: 110, cachedInputTokens: 60, cachedWriteTokens: 20 });
  });

  it("DeepSeek: prompt_cache_hit_tokens / prompt_cache_miss_tokens (prompt_tokens = hit + miss)", async () => {
    expect(
      await usageOf(chat({ prompt_tokens: 100, completion_tokens: 10, total_tokens: 110, prompt_cache_hit_tokens: 70, prompt_cache_miss_tokens: 30 })),
    ).toMatchObject({ inputTokens: 100, cachedInputTokens: 70, cachedWriteTokens: 0 });
  });

  it("Moonshot: top-level cached_tokens", async () => {
    expect(await usageOf(chat({ prompt_tokens: 100, completion_tokens: 10, total_tokens: 110, cached_tokens: 40 }))).toMatchObject({
      inputTokens: 100,
      cachedInputTokens: 40,
    });
  });

  it("LiteLLM: cache_creation_input_tokens is the cache write", async () => {
    expect(
      await usageOf(chat({ prompt_tokens: 100, completion_tokens: 10, total_tokens: 110, prompt_tokens_details: { cached_tokens: 50 }, cache_creation_input_tokens: 30 })),
    ).toMatchObject({ inputTokens: 100, cachedInputTokens: 50, cachedWriteTokens: 30 });
  });

  it("the nested field wins over the top-level one", async () => {
    expect(
      await usageOf(chat({ prompt_tokens: 100, completion_tokens: 10, prompt_tokens_details: { cached_tokens: 60 }, cached_tokens: 5 })),
    ).toMatchObject({ cachedInputTokens: 60 });
  });

  it("guard: cache read + write above the prompt means the server left them out, so they are added back", async () => {
    const usage = await usageOf(chat({ prompt_tokens: 10, completion_tokens: 20, total_tokens: 30, prompt_tokens_details: { cached_tokens: 90, cache_write_tokens: 5 } }));
    expect(usage).toMatchObject({ inputTokens: 105, outputTokens: 20, totalTokens: 125, cachedInputTokens: 90, cachedWriteTokens: 5 });
  });

  it("reasoning tokens are reported as they are, 0 when absent, and never above the output", async () => {
    expect((await usageOf(chat({ prompt_tokens: 1, completion_tokens: 50, completion_tokens_details: { reasoning_tokens: 30 } }))).reasoningTokens).toBe(30);
    expect((await usageOf(chat({ prompt_tokens: 1, completion_tokens: 50 }))).reasoningTokens).toBe(0);
    expect((await usageOf(chat({ prompt_tokens: 1, completion_tokens: 5, completion_tokens_details: { reasoning_tokens: 30 } }))).reasoningTokens).toBe(5);
  });

  it("a response without usage is all zeros", async () => {
    expect(await usageOf({ id: "1", model: "m", choices: [{ message: { content: "x" }, finish_reason: "stop" }] })).toEqual({
      inputTokens: 0, outputTokens: 0, totalTokens: 0, cachedInputTokens: 0, cachedWriteTokens: 0, cachedOutputTokens: 0, reasoningTokens: 0,
    });
  });
});

describe("Responses API usage goes through the same reader", () => {
  it("input_tokens_details.cached_tokens (and a cache write when the server reports one)", async () => {
    const fn = (async () =>
      new Response(
        JSON.stringify({
          id: "r", model: "m", status: "completed", output: [{ type: "message", content: [{ type: "output_text", text: "x" }] }],
          usage: { input_tokens: 100, output_tokens: 10, total_tokens: 110, input_tokens_details: { cached_tokens: 64, cache_write_tokens: 6 }, output_tokens_details: { reasoning_tokens: 4 } },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      )) as unknown as typeof fetch;
    const p = new OpenAIProvider({ provider: "openai", apiKey: "k", fetch: fn, responsesApiModels: ["gpt-5"] });
    const res = await p.complete({ model: "gpt-5", messages: msgs });
    expect(res.usage).toMatchObject({ inputTokens: 100, outputTokens: 10, totalTokens: 110, cachedInputTokens: 64, cachedWriteTokens: 6, reasoningTokens: 4 });
  });
});
