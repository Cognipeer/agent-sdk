/**
 * Native-model groundwork: injected fetch + timeout on every provider call
 * site, OpenAI-family token/sampling rules, reasoning_content parsing,
 * compatible/azure forwarding, adapter forwarding and the unified usage shape.
 * All tests use a mock fetch and assert the wire request / parsed output.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AnthropicProvider,
  AzureProvider,
  BedrockProvider,
  JevProvider,
  OpenAICompatibleProvider,
  OpenAIProvider,
  VertexProvider,
  ProviderError,
  fromNativeProvider,
} from "../../../src/providers/index.js";

type Call = { url: string; init: RequestInit; body: any };

function json(data: any, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });
}

function sse(events: any[]): Response {
  const enc = new TextEncoder();
  const body = new ReadableStream({
    start(c) {
      for (const e of events) c.enqueue(enc.encode(`data: ${typeof e === "string" ? e : JSON.stringify(e)}\n\n`));
      c.close();
    },
  });
  return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

function mockFetch(respond: (call: Call, n: number) => Response | Promise<Response>) {
  const calls: Call[] = [];
  const fn = vi.fn(async (url: any, init: any = {}) => {
    let body: any;
    try { body = init.body ? JSON.parse(init.body) : undefined; } catch { body = init.body; }
    const call = { url: String(url), init, body };
    calls.push(call);
    return respond(call, calls.length);
  });
  return { fn: fn as unknown as typeof fetch, calls };
}

const chatOk = (extra: any = {}) =>
  json({
    id: "c1", model: "m",
    choices: [{ message: { role: "assistant", content: "hi", ...extra }, finish_reason: "stop" }],
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15,
      prompt_tokens_details: { cached_tokens: 4 }, completion_tokens_details: { reasoning_tokens: 3 } },
  });

const msgs = [{ role: "user" as const, content: "go" }];

afterEach(() => vi.restoreAllMocks());

describe("injected fetch is used at every call site", () => {
  it("openai / compatible / azure (chat + responses)", async () => {
    const globalSpy = vi.spyOn(globalThis, "fetch");
    const m = mockFetch((c) =>
      c.url.endsWith("/responses") || c.url.includes("/openai/responses")
        ? json({ id: "r", model: "m", output: [{ type: "message", content: [{ type: "output_text", text: "x" }] }], usage: {} })
        : chatOk());
    await new OpenAIProvider({ provider: "openai", apiKey: "k", fetch: m.fn }).complete({ model: "gpt-4o", messages: msgs });
    await new OpenAICompatibleProvider({ provider: "openai-compatible", apiKey: "k", baseURL: "http://x/v1", fetch: m.fn }).complete({ model: "q", messages: msgs });
    const az = new AzureProvider({ provider: "azure", apiKey: "k", endpoint: "http://az", deploymentName: "d", fetch: m.fn });
    await az.complete({ model: "d", messages: msgs });
    await az.complete({ model: "d", messages: msgs, reasoning: { effort: "low" } }); // responses route (default model d? name-guess) 
    expect(m.calls.length).toBeGreaterThanOrEqual(3);
    expect(globalSpy).not.toHaveBeenCalled();
  });

  it("azure responses route uses the injected fetch", async () => {
    const globalSpy = vi.spyOn(globalThis, "fetch");
    const m = mockFetch(() => json({ id: "r", model: "o3", output: [], usage: {} }));
    const az = new AzureProvider({ provider: "azure", apiKey: "k", endpoint: "http://az", deploymentName: "o3", fetch: m.fn, api: "responses" });
    await az.complete({ model: "o3", messages: msgs, reasoning: { effort: "low" } });
    expect(m.calls[0].url).toContain("/openai/responses");
    expect(globalSpy).not.toHaveBeenCalled();
  });

  it("anthropic", async () => {
    const globalSpy = vi.spyOn(globalThis, "fetch");
    const m = mockFetch(() => json({ id: "a", model: "c", content: [{ type: "text", text: "ok" }], stop_reason: "end_turn", usage: { input_tokens: 1, output_tokens: 1 } }));
    const r = await new AnthropicProvider({ provider: "anthropic", apiKey: "k", fetch: m.fn }).complete({ model: "c", messages: msgs });
    expect(r.content).toBe("ok");
    expect(m.calls).toHaveLength(1);
    expect(globalSpy).not.toHaveBeenCalled();
  });

  it("bedrock", async () => {
    const globalSpy = vi.spyOn(globalThis, "fetch");
    const m = mockFetch(() => json({ output: { message: { role: "assistant", content: [{ text: "ok" }] } }, stopReason: "end_turn", usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } }));
    const r = await new BedrockProvider({ provider: "bedrock", region: "us-east-1", accessKeyId: "a", secretAccessKey: "s", fetch: m.fn }).complete({ model: "anthropic.x", messages: msgs });
    expect(r.content).toBe("ok");
    expect(m.calls[0].url).toContain("bedrock-runtime");
    expect(globalSpy).not.toHaveBeenCalled();
  });

  it("vertex", async () => {
    const globalSpy = vi.spyOn(globalThis, "fetch");
    const m = mockFetch(() => json({ candidates: [{ content: { parts: [{ text: "ok" }] }, finishReason: "STOP" }], usageMetadata: {} }));
    const r = await new VertexProvider({ provider: "vertex", projectId: "p", accessToken: "t", fetch: m.fn }).complete({ model: "gemini-2.0-flash", messages: msgs });
    expect(r.content).toBe("ok");
    expect(globalSpy).not.toHaveBeenCalled();
  });

  it("vertex service-account token exchange uses the injected fetch", async () => {
    const globalSpy = vi.spyOn(globalThis, "fetch");
    const { generateKeyPairSync } = await import("node:crypto");
    const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const pem = privateKey.export({ type: "pkcs8", format: "pem" }) as string;
    const m = mockFetch((c) =>
      c.url.includes("oauth2")
        ? json({ access_token: "tok", expires_in: 3600 })
        : json({ candidates: [{ content: { parts: [{ text: "ok" }] }, finishReason: "STOP" }], usageMetadata: {} }));
    const p = new VertexProvider({
      provider: "vertex", projectId: "p", fetch: m.fn,
      serviceAccountJson: { client_email: "a@b.c", private_key: pem, token_uri: "https://oauth2.googleapis.com/token" },
    });
    await p.complete({ model: "gemini-2.0-flash", messages: msgs });
    expect(m.calls.some((c) => c.url.includes("oauth2"))).toBe(true);
    expect(globalSpy).not.toHaveBeenCalled();
  });

  it("jev", async () => {
    const globalSpy = vi.spyOn(globalThis, "fetch");
    const m = mockFetch(() => json({ answers: [] }));
    await new JevProvider({ provider: "jev", apiKey: "k", fetch: m.fn }).systemOne({ state: {}, questions: [] } as any);
    expect(m.calls).toHaveLength(1);
    expect(globalSpy).not.toHaveBeenCalled();
  });
});

describe("timeoutMs", () => {
  const hanging = (): typeof fetch =>
    ((_u: any, init: any) =>
      new Promise((_res, rej) => {
        init.signal?.addEventListener("abort", () => rej(init.signal.reason ?? new Error("aborted")));
      })) as any;

  it("aborts a request that never answers with a 408 ProviderError", async () => {
    const p = new OpenAIProvider({ provider: "openai", apiKey: "k", fetch: hanging(), timeoutMs: 30, retry: { maxRetries: 0 } });
    const err: any = await p.complete({ model: "gpt-4o", messages: msgs }).catch((e) => e);
    expect(err).toBeInstanceOf(ProviderError);
    expect(err.statusCode).toBe(408);
    expect(err.message).toMatch(/timed out after 30ms/);
  });

  it("applies to anthropic, vertex and azure call sites too", async () => {
    const mk = [
      new AnthropicProvider({ provider: "anthropic", apiKey: "k", fetch: hanging(), timeoutMs: 20, retry: { maxRetries: 0 } }),
      new VertexProvider({ provider: "vertex", projectId: "p", accessToken: "t", fetch: hanging(), timeoutMs: 20 }),
      new AzureProvider({ provider: "azure", apiKey: "k", endpoint: "http://a", deploymentName: "d", fetch: hanging(), timeoutMs: 20, retry: { maxRetries: 0 } }),
    ];
    for (const p of mk) {
      const err: any = await p.complete({ model: "m", messages: msgs }).catch((e) => e);
      expect(err.statusCode).toBe(408);
    }
  });

  it("does not cut a stream once headers arrived", async () => {
    const enc = new TextEncoder();
    const slow = (async () => new Response(new ReadableStream({
      async start(c) {
        c.enqueue(enc.encode(`data: ${JSON.stringify({ id: "1", model: "m", choices: [{ delta: { content: "a" } }] })}\n\n`));
        await new Promise((r) => setTimeout(r, 80));
        c.enqueue(enc.encode(`data: ${JSON.stringify({ id: "1", model: "m", choices: [{ delta: { content: "b" }, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`));
        c.close();
      },
    }), { status: 200 })) as unknown as typeof fetch;
    const p = new OpenAIProvider({ provider: "openai", apiKey: "k", fetch: slow, timeoutMs: 30 });
    let text = "";
    for await (const ch of p.completeStream({ model: "gpt-4o", messages: msgs })) text += ch.delta.content ?? "";
    expect(text).toBe("ab");
  });

  it("the caller's signal still aborts when a timeout is configured", async () => {
    const ac = new AbortController();
    const p = new OpenAIProvider({ provider: "openai", apiKey: "k", fetch: hanging(), timeoutMs: 5000, retry: { maxRetries: 0 } });
    const pr = p.complete({ model: "gpt-4o", messages: msgs, signal: ac.signal }).catch((e) => e);
    setTimeout(() => ac.abort(), 10);
    const err: any = await pr;
    expect(err).not.toBeInstanceOf(ProviderError);
  });
});

describe("OpenAI-family token parameter and reasoning-model rules", () => {
  const run = async (model: string, extraCfg: any = {}, req: any = {}) => {
    const m = mockFetch(() => chatOk());
    await new OpenAIProvider({ provider: "openai", apiKey: "k", fetch: m.fn, ...extraCfg })
      .complete({ model, messages: msgs, maxTokens: 100, temperature: 0.2, topP: 0.9, ...req });
    return m.calls[0].body;
  };

  it("o-series and gpt-5 get max_completion_tokens and no sampling params", async () => {
    for (const model of ["o3", "o4-mini", "gpt-5", "gpt-5.1-mini"]) {
      const b = await run(model);
      expect(b.max_completion_tokens, model).toBe(100);
      expect(b).not.toHaveProperty("max_tokens");
      expect(b).not.toHaveProperty("temperature");
      expect(b).not.toHaveProperty("top_p");
    }
  });

  it("classic models keep max_tokens, temperature and top_p", async () => {
    const b = await run("gpt-4o");
    expect(b.max_tokens).toBe(100);
    expect(b.temperature).toBe(0.2);
    expect(b.top_p).toBe(0.9);
    expect(b).not.toHaveProperty("max_completion_tokens");
  });

  it("gpt-5-chat keeps sampling params", async () => {
    const b = await run("gpt-5-chat-latest");
    expect(b.temperature).toBe(0.2);
  });

  it("maxTokensParam overrides the name guess (both directions)", async () => {
    expect((await run("my-azure-deployment", { maxTokensParam: "max_completion_tokens" })).max_completion_tokens).toBe(100);
    const b = await run("o3", { maxTokensParam: "max_tokens" });
    expect(b.max_tokens).toBe(100);
    expect(b).not.toHaveProperty("max_completion_tokens");
  });

  it("azure honours maxTokensParam and the reasoning rules", async () => {
    const m = mockFetch(() => chatOk());
    const az = new AzureProvider({ provider: "azure", apiKey: "k", endpoint: "http://az", deploymentName: "dep", defaultModel: "gpt-5", maxTokensParam: "max_completion_tokens", fetch: m.fn });
    await az.complete({ model: "gpt-5", messages: msgs, maxTokens: 50, temperature: 1 });
    expect(m.calls[0].body.max_completion_tokens).toBe(50);
    expect(m.calls[0].body).not.toHaveProperty("temperature");
    expect(m.calls[0].url).toContain("/deployments/dep/");
  });

  it("presence / frequency penalties reach the wire", async () => {
    const b = await run("gpt-4o", {}, { presencePenalty: 0.5, frequencyPenalty: 0.25 });
    expect(b.presence_penalty).toBe(0.5);
    expect(b.frequency_penalty).toBe(0.25);
  });
});

describe("reasoning_content parsing", () => {
  it("non-stream: reasoning_content and reasoning both land on response.reasoning.summary", async () => {
    for (const key of ["reasoning_content", "reasoning"]) {
      const m = mockFetch(() => chatOk({ [key]: "because" }));
      const r = await new OpenAIProvider({ provider: "openai", apiKey: "k", fetch: m.fn }).complete({ model: "gpt-4o", messages: msgs });
      expect(r.reasoning?.summary, key).toBe("because");
      expect(r.content).toBe("hi");
    }
  });

  it("no reasoning field -> response.reasoning undefined", async () => {
    const m = mockFetch(() => chatOk());
    const r = await new OpenAIProvider({ provider: "openai", apiKey: "k", fetch: m.fn }).complete({ model: "gpt-4o", messages: msgs });
    expect(r.reasoning).toBeUndefined();
  });

  it("stream: delta.reasoning_content / delta.reasoning become reasoning deltas, last finishReason is the real one", async () => {
    const m = mockFetch(() => sse([
      { id: "s", model: "m", choices: [{ delta: { reasoning_content: "th" } }] },
      { id: "s", model: "m", choices: [{ delta: { reasoning: "ink" } }] },
      { id: "s", model: "m", choices: [{ delta: { content: "ans" } }] },
      { id: "s", model: "m", choices: [{ delta: {}, finish_reason: "length" }] },
      "[DONE]",
    ]));
    const p = new OpenAICompatibleProvider({ provider: "openai-compatible", apiKey: "k", baseURL: "http://x/v1", fetch: m.fn });
    const chunks: any[] = [];
    for await (const c of p.completeStream({ model: "q", messages: msgs })) chunks.push(c);
    expect(chunks.map((c) => c.delta.reasoning?.summary).filter(Boolean).join("")).toBe("think");
    expect(chunks.map((c) => c.delta.content).filter(Boolean).join("")).toBe("ans");
    expect(chunks.filter((c) => c.finishReason).pop()?.finishReason).toBe("length");
  });
});

describe("compatible / azure forwarding", () => {
  it("compatible forwards organization", async () => {
    const m = mockFetch(() => chatOk());
    await new OpenAICompatibleProvider({ provider: "openai-compatible", apiKey: "k", baseURL: "http://x/v1", organization: "org-1", fetch: m.fn })
      .complete({ model: "q", messages: msgs });
    expect((m.calls[0].init.headers as any)["OpenAI-Organization"]).toBe("org-1");
  });

  it("compatible retries 5xx with its retry config", async () => {
    const m = mockFetch((_c, n) => (n < 3 ? json({ error: "busy" }, 503) : chatOk()));
    const r = await new OpenAICompatibleProvider({ provider: "openai-compatible", apiKey: "k", baseURL: "http://x/v1", retry: { maxRetries: 3, baseDelayMs: 1, maxDelayMs: 2 }, fetch: m.fn })
      .complete({ model: "q", messages: msgs });
    expect(r.content).toBe("hi");
    expect(m.calls).toHaveLength(3);
  });

  it("azure retries 429 and honours retry.maxRetries = 0", async () => {
    const m = mockFetch((_c, n) => (n < 2 ? json({ error: "slow" }, 429) : chatOk()));
    const az = new AzureProvider({ provider: "azure", apiKey: "k", endpoint: "http://az", deploymentName: "d", retry: { baseDelayMs: 1, maxDelayMs: 2 }, fetch: m.fn });
    expect((await az.complete({ model: "d", messages: msgs })).content).toBe("hi");
    expect(m.calls).toHaveLength(2);

    const m2 = mockFetch(() => json({ error: "slow" }, 429));
    const az2 = new AzureProvider({ provider: "azure", apiKey: "k", endpoint: "http://az", deploymentName: "d", retry: { maxRetries: 0 }, fetch: m2.fn });
    await expect(az2.complete({ model: "d", messages: msgs })).rejects.toBeInstanceOf(ProviderError);
    expect(m2.calls).toHaveLength(1);
  });

  it("compatible defaults responsesApi to never (a reasoning model name stays on /chat/completions)", async () => {
    const m = mockFetch(() => chatOk());
    await new OpenAICompatibleProvider({ provider: "openai-compatible", apiKey: "k", baseURL: "http://x/v1", fetch: m.fn })
      .complete({ model: "o3", messages: msgs, reasoning: { effort: "low" } });
    expect(m.calls[0].url).toBe("http://x/v1/chat/completions");
    expect(m.calls[0].body.reasoning_effort).toBe("low");
  });

  it("compatible responsesApi:'always' goes to /responses", async () => {
    const m = mockFetch(() => json({ id: "r", model: "m", output: [], usage: {} }));
    await new OpenAICompatibleProvider({ provider: "openai-compatible", apiKey: "k", baseURL: "http://x/v1", responsesApi: "always", fetch: m.fn })
      .complete({ model: "q", messages: msgs });
    expect(m.calls[0].url).toBe("http://x/v1/responses");
  });
});

describe("adapter forwarding", () => {
  it("topP, stop, penalties reach the wire", async () => {
    const m = mockFetch(() => chatOk());
    const model = fromNativeProvider(new OpenAIProvider({ provider: "openai", apiKey: "k", fetch: m.fn }), {
      model: "gpt-4o", topP: 0.8, stop: ["END"], presencePenalty: 0.1, frequencyPenalty: 0.2, temperature: 0.3, maxTokens: 77,
    });
    await model.invoke([{ role: "user", content: "x" }]);
    const b = m.calls[0].body;
    expect(b).toMatchObject({ top_p: 0.8, stop: ["END"], presence_penalty: 0.1, frequency_penalty: 0.2, temperature: 0.3, max_tokens: 77 });
  });

  it("transformRequest sees tools and its result is what is sent", async () => {
    const m = mockFetch(() => chatOk());
    let seenTools: any;
    const model = fromNativeProvider(new OpenAIProvider({ provider: "openai", apiKey: "k", fetch: m.fn }), {
      model: "gpt-4o",
      reasoning: { effort: "high" },
      transformRequest: (req) => {
        seenTools = req.tools?.map((t) => t.name);
        if (req.tools?.length) req.reasoning = { effort: "none" };
      },
    });
    const bound = model.bindTools!([{ name: "lookup", description: "d", schema: { type: "object", properties: {} } }]);
    await bound.invoke([{ role: "user", content: "x" }]);
    expect(seenTools).toEqual(["lookup"]);
    expect(m.calls[0].body.reasoning_effort).toBe("none");
  });

  it("transformRequest may return a replacement (async)", async () => {
    const m = mockFetch(() => chatOk());
    const model = fromNativeProvider(new OpenAIProvider({ provider: "openai", apiKey: "k", fetch: m.fn }), {
      model: "gpt-4o",
      transformRequest: async (req) => ({ ...req, maxTokens: 1 }),
    });
    await model.invoke([{ role: "user", content: "x" }]);
    expect(m.calls[0].body.max_tokens).toBe(1);
  });

  it("non-stream message: finish_reason, model_name, reasoning and the unified usage shape", async () => {
    const m = mockFetch(() => chatOk({ reasoning_content: "why" }));
    const model = fromNativeProvider(new OpenAIProvider({ provider: "openai", apiKey: "k", fetch: m.fn }), { model: "gpt-4o" });
    const msg: any = await model.invoke([{ role: "user", content: "x" }]);
    expect(msg.reasoning).toEqual({ summary: "why" });
    expect(msg.response_metadata.finish_reason).toBe("stop");
    expect(msg.response_metadata.model_name).toBe("m");
    expect(msg.usage).toEqual({
      prompt_tokens: 10, completion_tokens: 5, total_tokens: 15,
      prompt_tokens_details: { cached_tokens: 4, cache_write_tokens: 0 },
      completion_tokens_details: { reasoning_tokens: 3 },
    });
    expect(msg.response_metadata.token_usage).toMatchObject({ ...msg.usage, cached_tokens: 4, cache_write_tokens: 0 });
  });

  it("stream: reasoning parts, final message keeps reasoning text, finish_reason, model_name and usage", async () => {
    const m = mockFetch(() => sse([
      { id: "s", model: "m-stream", choices: [{ delta: { reasoning_content: "a" } }] },
      { id: "s", model: "m-stream", choices: [{ delta: { reasoning_content: "b" } }] },
      { id: "s", model: "m-stream", choices: [{ delta: { content: "hello" } }] },
      { id: "s", model: "m-stream", choices: [{ delta: {}, finish_reason: "stop" }] },
      { id: "s", model: "m-stream", choices: [], usage: { prompt_tokens: 7, completion_tokens: 9, total_tokens: 16, completion_tokens_details: { reasoning_tokens: 6 }, prompt_tokens_details: { cached_tokens: 2 } } },
      "[DONE]",
    ]));
    const model = fromNativeProvider(new OpenAIProvider({ provider: "openai", apiKey: "k", fetch: m.fn }), { model: "gpt-4o" });
    const parts: any[] = [];
    for await (const p of model.stream!([{ role: "user", content: "x" }])) parts.push(p);
    const reasoningParts = parts.filter((p) => p && typeof p === "object" && p.type === "reasoning");
    expect(reasoningParts.map((p) => p.reasoning_content).join("")).toBe("ab");
    expect(parts.filter((p) => typeof p === "string").join("")).toBe("hello");
    const final = parts[parts.length - 1];
    expect(final.role).toBe("assistant");
    expect(final.content).toBe("hello");
    expect(final.reasoning).toEqual({ summary: "ab" });
    expect(final.response_metadata.finish_reason).toBe("stop");
    expect(final.response_metadata.model_name).toBe("m-stream");
    expect(final.usage.completion_tokens_details.reasoning_tokens).toBe(6);
    expect(final.usage.prompt_tokens_details.cached_tokens).toBe(2);
  });
});
