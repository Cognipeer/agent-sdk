/**
 * A cancelled turn must hang up on the model, not just stop listening to it.
 *
 * Until now the signal / cancellation token stopped at the agent loop: the
 * native provider adapter dropped it, `fetch` never saw it, and the HTTP
 * response kept streaming (and billing) until the model had finished. These
 * tests use a REAL local HTTP server so "hung up" is observed on the server's
 * side of the socket, not inferred from a mock.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  AnthropicProvider,
  AzureProvider,
  BedrockProvider,
  OpenAIProvider,
  VertexProvider,
  createProvider,
  fromNativeProvider,
} from "../../../src/providers/index.js";
import { parseSSEStream } from "../../../src/providers/utils/sse.js";
import { fromLangchainModel } from "../../../src/model.js";
import { startSlowModelServer, until, type SlowModelServer } from "../../setup/mocks/slowModelServer.js";

const CHUNKS = 60;

let server: SlowModelServer;

beforeAll(async () => {
  server = await startSlowModelServer({ chunks: CHUNKS, chunkGapMs: 25 });
});

afterAll(async () => {
  await server.close();
});

afterEach(() => {
  server.reset();
  vi.restoreAllMocks();
});

const msgs = [{ role: "user", content: "go" }];

function openaiModel(path = "") {
  const provider = createProvider({ provider: "openai", apiKey: "k", baseURL: `${server.baseURL}${path}` });
  return fromNativeProvider(provider, { model: "m" });
}

describe("fromNativeProvider hangs up on cancellation", () => {
  it("stream: aborting the signal closes the connection while the model is still generating", async () => {
    const controller = new AbortController();
    const model = openaiModel();
    const seen: string[] = [];
    let failure: any;
    try {
      for await (const chunk of model.stream!(msgs, { signal: controller.signal })) {
        seen.push(String(chunk));
        if (seen.length === 3) controller.abort();
      }
    } catch (err) {
      failure = err;
    }

    expect(failure?.name).toBe("AbortError");
    // The truncated stream was not passed off as a finished message.
    expect(seen.every((s) => typeof s === "string" && s !== "[object Object]")).toBe(true);
    await until(() => server.hits[0]?.closedEarly === true);
    expect(server.hits[0].finished).toBe(false);
    expect(server.hits[0].written).toBeLessThan(CHUNKS);
  });

  it("stream: a cancellationToken that only exposes a flag hangs up too", async () => {
    const token = { isCancellationRequested: false };
    const model = openaiModel();
    let count = 0;
    let failure: any;
    try {
      for await (const _chunk of model.stream!(msgs, { cancellationToken: token })) {
        count += 1;
        if (count === 3) token.isCancellationRequested = true;
      }
    } catch (err) {
      failure = err;
    }
    expect(failure?.name).toBe("AbortError");
    await until(() => server.hits[0]?.closedEarly === true);
    expect(server.hits[0].written).toBeLessThan(CHUNKS);
  });

  it("stream: a consumer that simply stops reading also closes the connection", async () => {
    const model = openaiModel();
    let count = 0;
    for await (const _chunk of model.stream!(msgs)) {
      count += 1;
      if (count === 3) break;
    }
    await until(() => server.hits[0]?.closedEarly === true);
    expect(server.hits[0].written).toBeLessThan(CHUNKS);
  });

  it("invoke: aborting the signal rejects at once and closes the connection", async () => {
    const controller = new AbortController();
    const model = openaiModel("/slow-json");
    const started = Date.now();
    const pending = model.invoke(msgs, { signal: controller.signal });
    setTimeout(() => controller.abort(), 100);
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(Date.now() - started).toBeLessThan(1_500);
    await until(() => server.hits[0]?.closedEarly === true);
    expect(server.hits[0].finished).toBe(false);
  });

  it("invoke: a flag-only token flipped mid-call rejects and closes the connection", async () => {
    const token = { isCancellationRequested: false };
    const model = openaiModel("/slow-json");
    const pending = model.invoke(msgs, { cancellationToken: token });
    setTimeout(() => { token.isCancellationRequested = true; }, 100);
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    await until(() => server.hits[0]?.closedEarly === true);
  });

  it("an already-cancelled call never reaches the provider", async () => {
    const controller = new AbortController();
    controller.abort();
    const model = openaiModel();
    await expect(model.invoke(msgs, { signal: controller.signal })).rejects.toMatchObject({ name: "AbortError" });
    await expect(model.invoke(msgs, { cancellationToken: { isCancellationRequested: true } })).rejects.toBeDefined();
    expect(server.hits).toHaveLength(0);
  });

  it("a call nobody cancels is unaffected", async () => {
    const model = openaiModel();
    const chunks: any[] = [];
    for await (const chunk of model.stream!(msgs, { signal: new AbortController().signal })) chunks.push(chunk);
    expect(chunks.length).toBe(CHUNKS + 1);
    expect(chunks.at(-1)).toMatchObject({ role: "assistant" });
    expect(String(chunks.at(-1).content).startsWith("w0 w1 ")).toBe(true);
    expect(server.hits[0].finished).toBe(true);
  });

  it("does not sit out a retry backoff once cancelled", async () => {
    const controller = new AbortController();
    const provider = new OpenAIProvider({
      provider: "openai",
      apiKey: "k",
      baseURL: `${server.baseURL}/overloaded`,
      retry: { maxRetries: 3, baseDelayMs: 60_000, maxDelayMs: 60_000 },
    });
    const model = fromNativeProvider(provider, { model: "m" });
    const started = Date.now();
    const pending = model.invoke(msgs, { signal: controller.signal });
    setTimeout(() => controller.abort(), 150);
    await expect(pending).rejects.toBeDefined();
    expect(Date.now() - started).toBeLessThan(3_000);
    // One attempt only: no second request after the cancel.
    expect(server.hits).toHaveLength(1);
  });
});

describe("every provider hands the request's signal to fetch", () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  const jsonResponse = (body: unknown) => ({
    ok: true,
    status: 200,
    json: async () => body,
    text: async () => JSON.stringify(body),
    headers: new Headers({ "content-type": "application/json" }),
    body: null,
  });

  const openAIBody = { id: "1", model: "m", choices: [{ message: { role: "assistant", content: "hi" }, finish_reason: "stop" }] };

  const cases: Array<[string, () => any, unknown]> = [
    ["openai", () => new OpenAIProvider({ provider: "openai", apiKey: "k" }), openAIBody],
    ["openai (Responses API)", () => new OpenAIProvider({ provider: "openai", apiKey: "k", responsesApi: "always" }), { id: "r", model: "m", output: [{ type: "message", content: [{ type: "output_text", text: "hi" }] }], status: "completed" }],
    ["anthropic", () => new AnthropicProvider({ provider: "anthropic", apiKey: "k" }), { id: "1", model: "m", content: [{ type: "text", text: "hi" }], stop_reason: "end_turn", usage: { input_tokens: 1, output_tokens: 1 } }],
    ["azure", () => new AzureProvider({ provider: "azure", apiKey: "k", endpoint: "https://x.openai.azure.com", deploymentName: "d" }), openAIBody],
    ["azure (Responses API)", () => new AzureProvider({ provider: "azure", apiKey: "k", endpoint: "https://x.openai.azure.com", deploymentName: "d", responsesApi: "always" }), { id: "r", model: "m", output: [{ type: "message", content: [{ type: "output_text", text: "hi" }] }], status: "completed" }],
    ["bedrock", () => new BedrockProvider({ provider: "bedrock", region: "us-east-1", accessKeyId: "a", secretAccessKey: "s" }), { output: { message: { role: "assistant", content: [{ text: "hi" }] } }, stopReason: "end_turn", usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } }],
    ["vertex", () => new VertexProvider({ provider: "vertex", projectId: "p", location: "l", accessToken: "t" }), { candidates: [{ content: { parts: [{ text: "hi" }] }, finishReason: "STOP" }], usageMetadata: {} }],
  ];

  for (const [name, make, body] of cases) {
    it(`${name}: complete() passes request.signal to fetch`, async () => {
      const fetchMock = vi.fn().mockResolvedValue(jsonResponse(body) as any);
      globalThis.fetch = fetchMock as any;
      const controller = new AbortController();
      const request: any = { model: "m", messages: [{ role: "user", content: "hi" }], signal: controller.signal };
      if (name.includes("Responses")) request.reasoning = { effort: "low" };
      await make().complete(request);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect((fetchMock.mock.calls[0][1] as any).signal).toBe(controller.signal);
    });

    it(`${name}: omits the signal when the request has none`, async () => {
      const fetchMock = vi.fn().mockResolvedValue(jsonResponse(body) as any);
      globalThis.fetch = fetchMock as any;
      await make().complete({ model: "m", messages: [{ role: "user", content: "hi" }] } as any);
      expect((fetchMock.mock.calls[0][1] as any).signal).toBeUndefined();
    });
  }

  it("the signal is never serialised into the request body", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(openAIBody) as any);
    globalThis.fetch = fetchMock as any;
    const controller = new AbortController();
    await new OpenAIProvider({ provider: "openai", apiKey: "k" }).complete({
      model: "m",
      messages: [{ role: "user", content: "hi" }],
      signal: controller.signal,
    });
    const sent = (fetchMock.mock.calls[0][1] as any).body as string;
    expect(sent).not.toContain("signal");
  });
});

describe("parseSSEStream", () => {
  function controlledStream() {
    const cancelled = vi.fn();
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(encoder.encode("data: one\n\ndata: two\n\ndata: three\n\n"));
      },
      cancel: cancelled,
    });
    return { stream, cancelled };
  }

  it("cancels the underlying body when the consumer stops early", async () => {
    const { stream, cancelled } = controlledStream();
    for await (const event of parseSSEStream(stream)) {
      expect(event.data).toBe("one");
      break;
    }
    expect(cancelled).toHaveBeenCalledTimes(1);
  });

  it("throws on an aborted signal instead of ending as if the body were complete", async () => {
    const { stream, cancelled } = controlledStream();
    const controller = new AbortController();
    const seen: string[] = [];
    await expect(async () => {
      for await (const event of parseSSEStream(stream, controller.signal)) {
        seen.push(event.data);
        controller.abort();
      }
    }).rejects.toMatchObject({ name: "AbortError" });
    expect(seen).toEqual(["one", "two", "three"]);
    expect(cancelled).toHaveBeenCalled();
  });
});

describe("fromLangchainModel passes a real signal", () => {
  function lcModel() {
    const calls: Array<{ options: any }> = [];
    const model = {
      modelName: "lc",
      async invoke(_messages: unknown, options: any) {
        calls.push({ options });
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(resolve, 2_000);
          options?.signal?.addEventListener("abort", () => {
            clearTimeout(timer);
            reject(Object.assign(new Error("Aborted"), { name: "AbortError" }));
          });
        });
        return { role: "assistant", content: "done" };
      },
      async *stream(_messages: unknown, options: any) {
        calls.push({ options });
        yield { role: "assistant", content: "a" };
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, 2_000);
          options?.signal?.addEventListener("abort", () => { clearTimeout(timer); resolve(); });
        });
        if (options?.signal?.aborted) throw Object.assign(new Error("Aborted"), { name: "AbortError" });
        yield { role: "assistant", content: "b" };
      },
    };
    return { model, calls };
  }

  it("forwards the caller's own AbortSignal as is", async () => {
    const { model, calls } = lcModel();
    const adapted = fromLangchainModel(model);
    const controller = new AbortController();
    const pending = adapted.invoke([{ role: "user", content: "hi" }], { signal: controller.signal });
    setTimeout(() => controller.abort(), 50);
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(calls[0].options.signal).toBe(controller.signal);
  });

  it("turns a flag-only cancellation token into a signal LangChain can act on", async () => {
    const { model, calls } = lcModel();
    const adapted = fromLangchainModel(model);
    const token = { isCancellationRequested: false };
    const pending = adapted.invoke([{ role: "user", content: "hi" }], { cancellationToken: token });
    setTimeout(() => { token.isCancellationRequested = true; }, 50);
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(calls[0].options.signal).toBeInstanceOf(AbortSignal);
    expect(calls[0].options.cancellationToken).toBe(token);
  });

  it("stream: the same, and a stream that is cut surfaces the abort", async () => {
    const { model, calls } = lcModel();
    const adapted = fromLangchainModel(model);
    const token = { isCancellationRequested: false };
    const seen: string[] = [];
    let failure: any;
    setTimeout(() => { token.isCancellationRequested = true; }, 80);
    try {
      for await (const chunk of adapted.stream!([{ role: "user", content: "hi" }], { cancellationToken: token })) {
        seen.push((chunk as any).content);
      }
    } catch (err) {
      failure = err;
    }
    expect(seen).toEqual(["a"]);
    expect(failure?.name).toBe("AbortError");
    expect(calls[0].options.signal).toBeInstanceOf(AbortSignal);
  });

  it("leaves the options alone when nothing can cancel the call", async () => {
    const calls: any[] = [];
    const adapted = fromLangchainModel({
      async invoke(_m: unknown, options: any) { calls.push(options); return { role: "assistant", content: "ok" }; },
    });
    await adapted.invoke([{ role: "user", content: "hi" }]);
    await adapted.invoke([{ role: "user", content: "hi" }], { tool_choice: "none" } as any);
    expect(calls[0]).toBeUndefined();
    expect(calls[1]).toEqual({ tool_choice: "none" });
  });
});
