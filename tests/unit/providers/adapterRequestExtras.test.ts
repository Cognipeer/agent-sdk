/**
 * What `fromNativeProvider` carries from an agent's messages and call options onto
 * the unified request:
 *
 *  - a caller's prompt-cache breakpoint (`cacheControl` / Anthropic's `cache_control`)
 *    on a text part, which the adapter used to rebuild as a bare `{ type, text }`;
 *  - the error flag of a failed tool result (`isError`);
 *  - the `purpose` tag a side call (summarizer, reflection) sends in its invoke options.
 */

import { describe, it, expect } from "vitest";
import { fromNativeProvider } from "../../../src/providers/adapter.js";
import { AnthropicProvider, OpenAICompatibleProvider } from "../../../src/providers/index.js";
import type { ChatCompletionRequest } from "../../../src/providers/types.js";

const usage = { inputTokens: 1, outputTokens: 1, totalTokens: 2, cachedInputTokens: 0, cachedWriteTokens: 0, cachedOutputTokens: 0, reasoningTokens: 0 };

/** A native provider that records every request it receives. */
function fakeProvider() {
  const requests: ChatCompletionRequest[] = [];
  const provider: any = {
    providerName: "openai-compatible",
    defaultModel: "fake",
    async complete(req: ChatCompletionRequest) {
      requests.push(req);
      return { id: "r", model: "fake", content: "ok", toolCalls: [], usage, finishReason: "stop" };
    },
    async *completeStream(req: ChatCompletionRequest) {
      requests.push(req);
      yield { id: "r", model: "fake", delta: { content: "ok" }, usage, finishReason: "stop" };
    },
  };
  return { provider, requests };
}

async function drain(iterable: AsyncIterable<unknown>) {
  for await (const _ of iterable) { /* drain */ }
}

const user = (content: any) => ({ role: "user", content }) as any;

/** The messages of the request the provider saw, after an `invoke`. */
async function seen(messages: any[], options?: Record<string, any>) {
  const { provider, requests } = fakeProvider();
  await fromNativeProvider(provider, { model: "m" }).invoke(messages, options);
  return requests[0];
}

describe("cache breakpoints survive the adapter", () => {
  it("carries `cacheControl` on text parts, and only on those", async () => {
    const request = await seen([
      { role: "system", content: [{ type: "text", text: "rules", cacheControl: { type: "ephemeral", ttl: "1h" } }] },
      user([{ type: "text", text: "document", cacheControl: { type: "ephemeral" } }, { type: "text", text: "question" }]),
    ]);

    expect(request.messages[0].content).toEqual([{ type: "text", text: "rules", cacheControl: { type: "ephemeral", ttl: "1h" } }]);
    const parts = request.messages[1].content as any[];
    expect(parts[0]).toEqual({ type: "text", text: "document", cacheControl: { type: "ephemeral" } });
    expect(parts[1]).toEqual({ type: "text", text: "question" });
    expect(parts[1]).not.toHaveProperty("cacheControl");
  });

  it("reads Anthropic's own spelling, `cache_control`", async () => {
    const request = await seen([user([{ type: "text", text: "x", cache_control: { type: "ephemeral", ttl: "5m" } }])]);
    expect((request.messages[0].content as any[])[0]).toEqual({ type: "text", text: "x", cacheControl: { type: "ephemeral", ttl: "5m" } });
  });

  it("carries only a marker a provider can send", async () => {
    const request = await seen([
      user([
        { type: "text", text: "a", cacheControl: { type: "persistent" } },
        { type: "text", text: "b", cacheControl: "yes" },
        { type: "text", text: "c", cacheControl: null },
        // A lifetime that is not 5m or 1h is dropped; the breakpoint itself stays (the default lifetime).
        { type: "text", text: "d", cacheControl: { type: "ephemeral", ttl: "2h" } },
      ]),
    ]);
    const parts = request.messages[0].content as any[];
    expect(parts[0]).not.toHaveProperty("cacheControl");
    expect(parts[1]).not.toHaveProperty("cacheControl");
    expect(parts[2]).not.toHaveProperty("cacheControl");
    expect(parts[3].cacheControl).toEqual({ type: "ephemeral" });
  });

  it("carries it on a part that is only `{ text }` and on a tool result's parts", async () => {
    const request = await seen([
      user([{ text: "untyped", cacheControl: { type: "ephemeral" } }]),
      { role: "tool", tool_call_id: "c1", name: "t", content: [{ type: "text", text: "result", cacheControl: { type: "ephemeral", ttl: "1h" } }] },
    ]);
    expect((request.messages[0].content as any[])[0]).toEqual({ type: "text", text: "untyped", cacheControl: { type: "ephemeral" } });
    expect((request.messages[1].content as any[])[0]).toEqual({ type: "text", text: "result", cacheControl: { type: "ephemeral", ttl: "1h" } });
  });

  it("does the same on a streamed call", async () => {
    const { provider, requests } = fakeProvider();
    await drain(fromNativeProvider(provider, { model: "m" }).stream!([user([{ type: "text", text: "x", cacheControl: { type: "ephemeral" } }])]));
    expect((requests[0].messages[0].content as any[])[0].cacheControl).toEqual({ type: "ephemeral" });
  });

  it("leaves plain string content and unmarked parts exactly as they were", async () => {
    const request = await seen([user("plain"), user([{ type: "text", text: "part" }])]);
    expect(request.messages[0].content).toBe("plain");
    expect(request.messages[1].content).toEqual([{ type: "text", text: "part" }]);
  });

  it("reaches the wire of the OpenAI-compatible provider as `cache_control`", async () => {
    const bodies: any[] = [];
    const fetchImpl = (async (_u: any, init: any) => {
      bodies.push(JSON.parse(init.body));
      return new Response(JSON.stringify({ id: "c", model: "m", choices: [{ message: { role: "assistant", content: "ok" }, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }), { status: 200 });
    }) as typeof fetch;
    const provider = new OpenAICompatibleProvider({ provider: "openai-compatible", apiKey: "k", baseURL: "http://x/v1", fetch: fetchImpl, retry: { maxRetries: 0 } });

    await fromNativeProvider(provider, { model: "anthropic/claude-sonnet-4" }).invoke([
      user([{ type: "text", text: "document", cacheControl: { type: "ephemeral", ttl: "1h" } }, { type: "text", text: "question" }]),
    ]);

    expect(bodies[0].messages[0].content[0]).toEqual({ type: "text", text: "document", cache_control: { type: "ephemeral", ttl: "1h" } });
    expect(bodies[0].messages[0].content[1]).toEqual({ type: "text", text: "question" });
  });

  it("reaches the wire of the Anthropic provider as `cache_control`", async () => {
    const bodies: any[] = [];
    const fetchImpl = (async (_u: any, init: any) => {
      bodies.push(JSON.parse(init.body));
      return new Response(JSON.stringify({ id: "msg_1", type: "message", model: "claude-sonnet-4-6", content: [{ type: "text", text: "ok" }], stop_reason: "end_turn", usage: { input_tokens: 1, output_tokens: 1 } }), { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch;
    const provider = new AnthropicProvider({ provider: "anthropic", apiKey: "k", fetch: fetchImpl, retry: { maxRetries: 0 } });

    await fromNativeProvider(provider, { model: "claude-sonnet-4-6" }).invoke([
      user([{ type: "text", text: "document", cacheControl: { type: "ephemeral", ttl: "1h" } }, { type: "text", text: "question" }]),
    ]);

    expect(bodies[0].messages[0].content[0]).toEqual({ type: "text", text: "document", cache_control: { type: "ephemeral", ttl: "1h" } });
    expect(bodies[0].messages[0].content[1]).toEqual({ type: "text", text: "question" });
  });
});

describe("the error flag of a tool result", () => {
  const failed = (extra: Record<string, unknown>) => [
    user("go"),
    { role: "assistant", content: "", tool_calls: [{ id: "c1", type: "function", function: { name: "t", arguments: "{}" } }] },
    { role: "tool", tool_call_id: "c1", name: "t", content: "boom", ...extra },
  ];

  it("`isError` on a tool message becomes `isError` on the unified message", async () => {
    const request = await seen(failed({ isError: true }));
    expect(request.messages[2].isError).toBe(true);
  });

  it("so does Anthropic's spelling, `is_error`", async () => {
    const request = await seen(failed({ is_error: true }));
    expect(request.messages[2].isError).toBe(true);
  });

  it("a tool result that did not fail carries no flag at all", async () => {
    const request = await seen(failed({}));
    expect(request.messages[2]).not.toHaveProperty("isError");
    const falsy = await seen(failed({ isError: false, is_error: "yes" }));
    expect(falsy.messages[2]).not.toHaveProperty("isError");
  });

  it("only a tool message carries it", async () => {
    const request = await seen([user("go"), { role: "assistant", content: "x", isError: true }, { ...user("again"), isError: true }]);
    expect(request.messages[1]).not.toHaveProperty("isError");
    expect(request.messages[2]).not.toHaveProperty("isError");
  });

  it("reaches the Anthropic wire as `is_error` on the tool_result block", async () => {
    const bodies: any[] = [];
    const fetchImpl = (async (_u: any, init: any) => {
      bodies.push(JSON.parse(init.body));
      return new Response(JSON.stringify({ id: "msg_1", type: "message", model: "claude-sonnet-4-6", content: [{ type: "text", text: "ok" }], stop_reason: "end_turn", usage: { input_tokens: 1, output_tokens: 1 } }), { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch;
    const model = fromNativeProvider(new AnthropicProvider({ provider: "anthropic", apiKey: "k", fetch: fetchImpl, retry: { maxRetries: 0 } }), { model: "claude-sonnet-4-6" });

    await model.invoke(failed({ isError: true }));
    await model.invoke(failed({}));

    expect(bodies[0].messages[2].content[0]).toMatchObject({ type: "tool_result", tool_use_id: "c1", content: "boom", is_error: true });
    expect(bodies[1].messages[2].content[0]).not.toHaveProperty("is_error");
  });
});

describe("the purpose tag of a side call", () => {
  it("is copied from the invoke options to the request", async () => {
    expect((await seen([user("hi")], { purpose: "summarization" })).purpose).toBe("summarization");
    expect((await seen([user("hi")], { purpose: "reflection" })).purpose).toBe("reflection");
  });

  it("is copied on a streamed call too", async () => {
    const { provider, requests } = fakeProvider();
    await drain(fromNativeProvider(provider, { model: "m" }).stream!([user("hi")], { purpose: "summarization" }));
    expect(requests[0].purpose).toBe("summarization");
  });

  it("is absent when the call sets none, or sets something that is not a tag", async () => {
    expect(await seen([user("hi")])).not.toHaveProperty("purpose");
    expect(await seen([user("hi")], {})).not.toHaveProperty("purpose");
    expect(await seen([user("hi")], { purpose: "" })).not.toHaveProperty("purpose");
    expect(await seen([user("hi")], { purpose: 7 })).not.toHaveProperty("purpose");
    expect(await seen([user("hi")], { purpose: { a: 1 } })).not.toHaveProperty("purpose");
  });

  it("is never sent to the provider's API", async () => {
    const bodies: any[] = [];
    const compat = new OpenAICompatibleProvider({
      provider: "openai-compatible",
      apiKey: "k",
      baseURL: "http://x/v1",
      retry: { maxRetries: 0 },
      fetch: (async (_u: any, init: any) => {
        bodies.push(JSON.parse(init.body));
        return new Response(JSON.stringify({ id: "c", model: "m", choices: [{ message: { role: "assistant", content: "ok" }, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }), { status: 200 });
      }) as typeof fetch,
    });
    const anthropicBodies: any[] = [];
    const anthropic = new AnthropicProvider({
      provider: "anthropic",
      apiKey: "k",
      retry: { maxRetries: 0 },
      fetch: (async (_u: any, init: any) => {
        anthropicBodies.push(JSON.parse(init.body));
        return new Response(JSON.stringify({ id: "msg_1", type: "message", model: "claude-sonnet-4-6", content: [{ type: "text", text: "ok" }], stop_reason: "end_turn", usage: { input_tokens: 1, output_tokens: 1 } }), { status: 200, headers: { "content-type": "application/json" } });
      }) as typeof fetch,
    });

    await fromNativeProvider(compat, { model: "gpt-4.1" }).invoke([user("hi")], { purpose: "summarization" });
    await fromNativeProvider(anthropic, { model: "claude-sonnet-4-6" }).invoke([user("hi")], { purpose: "summarization" });

    expect(JSON.stringify(bodies[0])).not.toContain("purpose");
    expect(JSON.stringify(anthropicBodies[0])).not.toContain("purpose");
  });
});
