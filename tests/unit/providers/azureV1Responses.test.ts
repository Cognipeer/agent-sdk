/**
 * Azure OpenAI `apiVersion: "v1"`: the Responses API goes to Azure's versionless
 * v1 route (`{endpoint}/openai/v1/responses`, no `api-version`); chat and embeddings
 * keep their dated deployment routes, so under "v1" v1 is Responses-only. Dated
 * versions behave as before. Every test uses a mock fetch.
 */
import { describe, expect, it } from "vitest";
import { AzureProvider } from "../../../src/providers/index.js";
import { ProviderError } from "../../../src/providers/types.js";

type Call = { url: string; body: any; headers: Record<string, string> };

function recorder(respond: (n: number) => Response) {
  const calls: Call[] = [];
  const fn = (async (url: any, init: any = {}) => {
    calls.push({ url: String(url), body: init.body ? JSON.parse(init.body) : undefined, headers: init.headers ?? {} });
    return respond(calls.length);
  }) as unknown as typeof fetch;
  return { fn, calls };
}
const json = (d: any, status = 200) => new Response(JSON.stringify(d), { status, headers: { "content-type": "application/json" } });
function sse(events: any[]): Response {
  const enc = new TextEncoder();
  return new Response(
    new ReadableStream({
      start(c) {
        for (const e of events) c.enqueue(enc.encode(`event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`));
        c.close();
      },
    }),
    { status: 200, headers: { "content-type": "text/event-stream" } },
  );
}
async function collect<T>(g: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const x of g) out.push(x);
  return out;
}

const ENDPOINT = "https://res.openai.azure.com";
const NO_RETRY = { maxRetries: 0 };
const msgs = [{ role: "user" as const, content: "hi" }];
const RESP_OK = { id: "r", model: "m", status: "completed", output: [{ type: "message", content: [{ type: "output_text", text: "ok" }] }], usage: {} };
const CHAT_OK = { id: "c", model: "m", choices: [{ message: { role: "assistant", content: "ok" }, finish_reason: "stop" }], usage: {} };
const EMBED_OK = { data: [{ index: 0, embedding: [0.1, 0.2] }], model: "emb-1", usage: { prompt_tokens: 1, total_tokens: 1 } };

function azure(fn: typeof fetch, extra: Record<string, any> = {}) {
  return new AzureProvider({ provider: "azure", apiKey: "k", endpoint: ENDPOINT, deploymentName: "dep-1", fetch: fn, retry: NO_RETRY, ...extra });
}

describe("Azure apiVersion: 'v1'", () => {
  it.each(["v1", "V1"])("Responses goes to /openai/v1/responses with no api-version (apiVersion %s)", async (apiVersion) => {
    const r = recorder(() => json(RESP_OK));
    const res = await azure(r.fn, { apiVersion, api: "responses" }).complete({ model: "gpt-5.6-terra", messages: msgs });
    expect(res.content).toBe("ok");
    expect(r.calls[0].url).toBe(`${ENDPOINT}/openai/v1/responses`);
    expect(r.calls[0].url).not.toContain("api-version");
  });

  it("api-key auth, the deployment as the body's model, and no bearer token", async () => {
    const r = recorder(() => json(RESP_OK));
    await azure(r.fn, { apiVersion: "v1", api: "responses" }).complete({ model: "gpt-5.6-terra", messages: msgs });
    expect(r.calls[0].headers["api-key"]).toBe("k");
    expect(r.calls[0].headers).not.toHaveProperty("Authorization");
    expect(r.calls[0].body.model).toBe("dep-1");
  });

  it("without a configured deployment the request's model is the deployment", async () => {
    const r = recorder(() => json(RESP_OK));
    await azure(r.fn, { apiVersion: "v1", api: "responses", deploymentName: undefined }).complete({ model: "my-gpt", messages: msgs });
    expect(r.calls[0].url).toBe(`${ENDPOINT}/openai/v1/responses`);
    expect(r.calls[0].body.model).toBe("my-gpt");
  });

  it("a trailing slash on the endpoint is trimmed", async () => {
    const r = recorder(() => json(RESP_OK));
    await azure(r.fn, { apiVersion: "v1", api: "responses", endpoint: `${ENDPOINT}/` }).complete({ model: "m", messages: msgs });
    expect(r.calls[0].url).toBe(`${ENDPOINT}/openai/v1/responses`);
  });

  it("the streaming Responses call takes the v1 route too", async () => {
    const r = recorder(() => sse([
      { type: "response.created", response: { id: "r1", model: "m" } },
      { type: "response.output_text.delta", item_id: "m", delta: "ok" },
      { type: "response.completed", response: { id: "r1", model: "m", status: "completed", output: [], usage: {} } },
    ]));
    const chunks = await collect(azure(r.fn, { apiVersion: "v1", api: "responses" }).completeStream({ model: "gpt-5.6-terra", messages: msgs }));
    expect(chunks.map((c) => c.delta.content).filter(Boolean)).toEqual(["ok"]);
    expect(r.calls[0].url).toBe(`${ENDPOINT}/openai/v1/responses`);
    expect(r.calls[0].body.stream).toBe(true);
  });

  it("the default API selection still sends a reasoning request to Responses (v1 route) and a plain one to chat", async () => {
    const r = recorder((n) => json(n === 1 ? RESP_OK : CHAT_OK));
    const p = azure(r.fn, { apiVersion: "v1" });
    await p.complete({ model: "gpt-5.6-terra", messages: msgs, reasoning: { effort: "low" } });
    await p.complete({ model: "gpt-4o", messages: msgs });
    expect(r.calls[0].url).toBe(`${ENDPOINT}/openai/v1/responses`);
    expect(r.calls[1].url).toBe(`${ENDPOINT}/openai/deployments/dep-1/chat/completions?api-version=2024-10-21`);
  });

  it("chat keeps the dated deployment route, with a dated api-version standing in for v1", async () => {
    const r = recorder(() => json(CHAT_OK));
    await azure(r.fn, { apiVersion: "v1", api: "chat" }).complete({ model: "gpt-4o", messages: msgs });
    expect(r.calls[0].url).toBe(`${ENDPOINT}/openai/deployments/dep-1/chat/completions?api-version=2024-10-21`);
    expect(r.calls[0].url).not.toContain("/openai/v1/");
    expect(r.calls[0].body).not.toHaveProperty("model");
  });

  it("chat streaming too", async () => {
    const r = recorder(() => new Response(
      new ReadableStream({
        start(c) {
          const enc = new TextEncoder();
          c.enqueue(enc.encode(`data: ${JSON.stringify({ id: "c", model: "m", choices: [{ index: 0, delta: { content: "ok" }, finish_reason: "stop" }] })}\n\n`));
          c.enqueue(enc.encode("data: [DONE]\n\n"));
          c.close();
        },
      }),
      { status: 200, headers: { "content-type": "text/event-stream" } },
    ));
    const chunks = await collect(azure(r.fn, { apiVersion: "v1", api: "chat" }).completeStream({ model: "gpt-4o", messages: msgs }));
    expect(chunks[0].delta.content).toBe("ok");
    expect(r.calls[0].url).toBe(`${ENDPOINT}/openai/deployments/dep-1/chat/completions?api-version=2024-10-21`);
  });

  it("embeddings keep the dated deployment route", async () => {
    const r = recorder(() => json(EMBED_OK));
    const res = await azure(r.fn, { apiVersion: "v1" }).embed({ model: "emb-1", input: ["a"] });
    expect(res.vectors).toEqual([[0.1, 0.2]]);
    expect(r.calls[0].url).toBe(`${ENDPOINT}/openai/deployments/emb-1/embeddings?api-version=2024-10-21`);
  });

  it("an error from the v1 route is an Azure Responses ProviderError with the status and body", async () => {
    const r = recorder(() => json({ error: { code: "DeploymentNotFound", message: "no such deployment" } }, 404));
    const err = await azure(r.fn, { apiVersion: "v1", api: "responses" }).complete({ model: "m", messages: msgs }).catch((e) => e);
    expect(err).toBeInstanceOf(ProviderError);
    expect(err.provider).toBe("azure");
    expect(err.statusCode).toBe(404);
    expect(err.message).toContain("Azure OpenAI Responses API error 404");
    expect(String(err.responseBody)).toContain("DeploymentNotFound");
  });
});

describe("Azure dated apiVersion: unchanged", () => {
  it.each([
    ["2025-04-01-preview", "2025-04-01-preview"],
    ["preview", "preview"],
    [undefined, "2024-10-21"],
  ])("apiVersion %s: Responses on /openai/responses?api-version=%s", async (apiVersion, expected) => {
    const r = recorder(() => json(RESP_OK));
    await azure(r.fn, { api: "responses", ...(apiVersion ? { apiVersion } : {}) }).complete({ model: "m", messages: msgs });
    expect(r.calls[0].url).toBe(`${ENDPOINT}/openai/responses?api-version=${expected}`);
  });

  it("chat and embeddings carry the configured version", async () => {
    const c = recorder(() => json(CHAT_OK));
    await azure(c.fn, { apiVersion: "2025-01-01-preview", api: "chat" }).complete({ model: "gpt-4o", messages: msgs });
    expect(c.calls[0].url).toBe(`${ENDPOINT}/openai/deployments/dep-1/chat/completions?api-version=2025-01-01-preview`);
    const e = recorder(() => json(EMBED_OK));
    await azure(e.fn, { apiVersion: "2025-01-01-preview" }).embed({ model: "emb-1", input: ["a"] });
    expect(e.calls[0].url).toBe(`${ENDPOINT}/openai/deployments/emb-1/embeddings?api-version=2025-01-01-preview`);
  });
});
