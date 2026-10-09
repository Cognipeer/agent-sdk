/**
 * `$ref` inlining at the request level: a schema with a reused sub-schema must
 * reach /responses with no `$ref` in it, on every way into `text.format`, while
 * Chat Completions keeps sending the schema exactly as built and a schema
 * without refs reaches /responses byte-for-byte as before.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { z } from "zod";

import {
  OpenAIProvider,
  AzureProvider,
  OpenAICompatibleProvider,
  fromNativeProvider,
} from "../../../src/providers/index.js";
import type { BaseProvider } from "../../../src/providers/base.js";
import type { ChatCompletionRequest } from "../../../src/providers/types.js";
import { NativeJsonSchemaStrategy } from "../../../src/structuredOutput/nativeStrategy.js";
import { inlineJsonSchemaRefs } from "../../../src/providers/utils/jsonSchemaRefs.js";

afterEach(() => vi.unstubAllGlobals());

const strategy = new NativeJsonSchemaStrategy();
const item = z.object({ text: z.string(), weight: z.number().optional() });
const REUSED = z.object({ summary: z.string(), goals: z.array(item), durableFacts: z.array(item) });
const PLAIN = z.object({ summary: z.string(), goals: z.array(item) });
const schemaOf = (s: z.ZodTypeAny) => strategy.buildResponseFormat(s).response_format.json_schema.schema;

const COMPLETED = {
  id: "resp_1",
  model: "m",
  status: "completed",
  output: [{ type: "message", content: [{ type: "output_text", text: "{}" }] }],
  usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
};
const SSE = [
  { type: "response.created", response: { id: "resp_1", model: "m" } },
  { type: "response.output_text.delta", delta: "{}" },
  { type: "response.completed", response: COMPLETED },
].map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join("");
const CHAT_JSON = { id: "c", model: "m", choices: [{ message: { content: "{}" }, finish_reason: "stop" }] };
const CHAT_SSE = 'data: {"id":"c","model":"m","choices":[{"delta":{"content":"{}"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n';

/** Records each request's URL and raw payload; answers like the endpoint named. */
function stubEndpoints() {
  const calls: Array<{ url: string; payload: string }> = [];
  vi.stubGlobal("fetch", (url: string, init: any) => {
    calls.push({ url, payload: init.body });
    const stream = JSON.parse(init.body).stream === true;
    const responses = url.includes("/responses");
    const r: any = { ok: true, status: 200, headers: { get: () => null } };
    r.json = async () => (responses ? COMPLETED : CHAT_JSON);
    r.text = async () => JSON.stringify(r.json());
    if (stream) {
      const enc = new TextEncoder();
      const sse = responses ? SSE : CHAT_SSE;
      r.body = new ReadableStream<Uint8Array>({ start(c) { c.enqueue(enc.encode(sse)); c.close(); } });
    }
    return Promise.resolve(r);
  });
  return calls;
}

async function send(provider: BaseProvider, request: ChatCompletionRequest, stream: boolean) {
  const calls = stubEndpoints();
  if (stream) {
    for await (const _ of provider.completeStream(request)) { /* drain */ }
  } else {
    await provider.complete(request);
  }
  expect(calls).toHaveLength(1);
  return { url: calls[0].url, payload: calls[0].payload, body: JSON.parse(calls[0].payload) };
}

const messages: ChatCompletionRequest["messages"] = [{ role: "user", content: "Summarize." }];
const key = { provider: "openai" as const, apiKey: "k" };

/** Every way a request reaches /responses with a json_schema, by name. */
const RESPONSES_ROUTES: Record<string, { provider: () => BaseProvider; request: (schema: any) => ChatCompletionRequest; viaExtra?: boolean }> = {
  "always + responseFormat": {
    provider: () => new OpenAIProvider({ ...key, responsesApi: "always" }),
    request: (schema) => ({ model: "gpt-4o", messages, responseFormat: { type: "json_schema", name: "structured_response", schema } }),
  },
  "auto gpt-5 + reasoning + responseFormat": {
    provider: () => new OpenAIProvider(key),
    request: (schema) => ({
      model: "gpt-5.6-terra",
      messages,
      reasoning: { effort: "low" },
      responseFormat: { type: "json_schema", name: "structured_response", schema },
    }),
  },
  "listed model + responseFormat": {
    provider: () => new OpenAIProvider({ ...key, responsesApiModels: ["gpt-6-luna"], responsesStreaming: true }),
    request: (schema) => ({ model: "gpt-6-luna", messages, responseFormat: { type: "json_schema", name: "structured_response", schema } }),
  },
  "listed model + extra.response_format (translated)": {
    provider: () => new OpenAIProvider({ ...key, responsesApiModels: ["gpt-6-luna"], responsesStreaming: true }),
    request: (schema) => ({
      model: "gpt-6-luna",
      messages,
      extra: { response_format: { type: "json_schema", json_schema: { name: "structured_response", schema, strict: true } } },
    }),
    viaExtra: true,
  },
  "azure auto gpt-5 + reasoning + responseFormat": {
    provider: () => new AzureProvider({ provider: "azure", apiKey: "k", endpoint: "https://r.openai.azure.com" }),
    request: (schema) => ({
      model: "gpt-5.6-terra",
      messages,
      reasoning: { effort: "low" },
      responseFormat: { type: "json_schema", name: "structured_response", schema },
    }),
  },
};

describe("Responses text.format: a reused sub-schema is sent with no $ref", () => {
  for (const [name, route] of Object.entries(RESPONSES_ROUTES)) {
    for (const stream of [false, true]) {
      it(`${name} / ${stream ? "stream" : "complete"}`, async () => {
        const schema = schemaOf(REUSED);
        const before = JSON.stringify(schema);
        const { url, payload, body } = await send(route.provider(), route.request(schema), stream);

        expect(url).toContain("/responses");
        expect(payload).not.toContain("$ref");
        expect(payload).not.toContain('"definitions"');
        expect(body.text.format).toEqual({
          type: "json_schema",
          name: "structured_response",
          schema: inlineJsonSchemaRefs(schema),
          strict: true,
        });
        expect(body.text.format.schema.properties.durableFacts.items).toEqual(schema.properties.goals.items);
        if (route.viaExtra) expect(body).not.toHaveProperty("response_format");
        // The caller's (cached, reused) schema object is untouched.
        expect(JSON.stringify(schema)).toBe(before);
      });
    }
  }
});

describe("Responses text.format: a schema without $ref is sent byte-for-byte as before", () => {
  for (const [name, route] of Object.entries(RESPONSES_ROUTES)) {
    for (const stream of [false, true]) {
      it(`${name} / ${stream ? "stream" : "complete"}`, async () => {
        const schema = schemaOf(PLAIN);
        expect(JSON.stringify(schema)).not.toContain("$ref");
        const { payload } = await send(route.provider(), route.request(schema), stream);
        // The serialisation the previous build produced for this text.format
        // (key order included); the differential run in the PR proves it too.
        const format = { type: "json_schema", name: "structured_response", schema, strict: true };
        expect(payload).toContain(`"text":${JSON.stringify({ format })}`);
      });
    }
  }
});

describe("Chat Completions response_format is untouched, refs and all", () => {
  const CHAT_ROUTES: Record<string, () => BaseProvider> = {
    "openai default": () => new OpenAIProvider(key),
    "openai never + listed model": () => new OpenAIProvider({ ...key, responsesApi: "never", responsesApiModels: ["gpt-6-luna"] }),
    azure: () => new AzureProvider({ provider: "azure", apiKey: "k", endpoint: "https://r.openai.azure.com" }),
    compatible: () => new OpenAICompatibleProvider({ provider: "openai-compatible", apiKey: "k", baseURL: "http://x/v1" }),
  };
  for (const [name, make] of Object.entries(CHAT_ROUTES)) {
    for (const stream of [false, true]) {
      it(`${name} / ${stream ? "stream" : "complete"}`, async () => {
        const schema = schemaOf(REUSED);
        const { url, payload, body } = await send(
          make(),
          { model: "gpt-6-luna", messages, responseFormat: { type: "json_schema", name: "structured_response", schema } },
          stream,
        );
        expect(url).toContain("/chat/completions");
        expect(body.response_format.json_schema.schema).toEqual(schema);
        expect(payload).toContain(`"schema":${JSON.stringify(schema)}`);
        expect(payload).toContain("#/definitions/structured_response/properties/goals/items");
      });
    }
  }
});

describe("through the adapter, as an agent's structured output reaches the provider", () => {
  it("inlines on /responses and leaves chat alone, from the same cached response_format", async () => {
    const responseFormat = strategy.buildResponseFormat(REUSED, "structured_response").response_format;
    const before = JSON.stringify(responseFormat);

    const calls = stubEndpoints();
    const responses = fromNativeProvider(
      new OpenAIProvider({ ...key, responsesApiModels: ["gpt-6-luna"] }),
      { model: "gpt-6-luna" },
    );
    const chat = fromNativeProvider(new OpenAIProvider({ ...key, responsesApi: "never" }), { model: "gpt-5.6-terra" });
    await responses.invoke([{ role: "user", content: "x" }] as any, { response_format: responseFormat });
    await chat.invoke([{ role: "user", content: "x" }] as any, { response_format: responseFormat });

    expect(calls[0].url).toContain("/responses");
    expect(calls[0].payload).not.toContain("$ref");
    expect(calls[1].url).toContain("/chat/completions");
    expect(calls[1].payload).toContain('"$ref"');
    expect(JSON.stringify(responseFormat)).toBe(before);
  });
});
