/**
 * Byte-for-byte regression guard for the OpenAI-shaped providers.
 *
 * The snapshots in this file were recorded BEFORE `responsesApiModels` and
 * `responsesStreaming` existed. Every case here is a configuration that does
 * not use those options, so each recorded URL, payload string and streamed
 * chunk sequence must stay exactly as it was: a diff here means an existing
 * consumer's wire traffic changed.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import {
  OpenAIProvider,
  AzureProvider,
  OpenAICompatibleProvider,
} from "../../../src/providers/index.js";
import type { BaseProvider } from "../../../src/providers/base.js";
import type { ChatCompletionRequest } from "../../../src/providers/types.js";

afterEach(() => vi.unstubAllGlobals());

const CHAT_JSON = {
  id: "chatcmpl-1",
  model: "m",
  choices: [{ message: { content: "hi", tool_calls: [] }, finish_reason: "stop" }],
  usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 },
};
const CHAT_SSE =
  'data: {"id":"c1","model":"m","choices":[{"delta":{"content":"He"}}]}\n\n' +
  'data: {"id":"c1","model":"m","choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","function":{"name":"lookup","arguments":"{\\"q\\":"}}]}}]}\n\n' +
  'data: {"id":"c1","model":"m","choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"1}"}}]},"finish_reason":"tool_calls"}]}\n\n' +
  'data: {"id":"c1","model":"m","choices":[],"usage":{"prompt_tokens":3,"completion_tokens":2,"total_tokens":5}}\n\n' +
  "data: [DONE]\n\n";
const RESPONSES_JSON = {
  id: "resp_1",
  model: "m",
  status: "completed",
  output: [
    { type: "reasoning", summary: [{ type: "summary_text", text: "thought" }] },
    { type: "message", content: [{ type: "output_text", text: "hi" }] },
    { type: "function_call", call_id: "call_1", name: "lookup", arguments: "{\"q\":1}" },
  ],
  usage: { input_tokens: 3, output_tokens: 2, total_tokens: 5, output_tokens_details: { reasoning_tokens: 1 } },
};

/** Stubs fetch; answers like the endpoint the URL names and records every call. */
function stubEndpoints() {
  const calls: Array<{ url: string; payload: string }> = [];
  vi.stubGlobal("fetch", (url: string, init: any) => {
    calls.push({ url, payload: init.body });
    const body = JSON.parse(init.body);
    const enc = new TextEncoder();
    const isResponses = url.includes("/responses");
    const json = isResponses ? RESPONSES_JSON : CHAT_JSON;
    const r: any = { ok: true, status: 200, headers: { get: () => null } };
    r.json = async () => json;
    r.text = async () => JSON.stringify(json);
    if (!isResponses && body.stream) {
      r.body = new ReadableStream<Uint8Array>({
        start(c) { c.enqueue(enc.encode(CHAT_SSE)); c.close(); },
      });
    }
    return Promise.resolve(r);
  });
  return calls;
}

async function run(provider: BaseProvider, request: ChatCompletionRequest, stream: boolean) {
  const calls = stubEndpoints();
  let output: any;
  if (stream) {
    output = [];
    for await (const chunk of provider.completeStream(request)) output.push(chunk);
  } else {
    output = await provider.complete(request);
    delete output.raw;
  }
  return { calls, output };
}

const tools = [
  {
    name: "lookup",
    description: "Look something up",
    parameters: { type: "object", properties: { q: { type: "number" } }, required: ["q"] },
  },
];
const strictTools = [{ ...tools[0], strict: true }];
const history: ChatCompletionRequest["messages"] = [
  { role: "system", content: "Be brief." },
  { role: "user", content: "Find 1" },
  { role: "assistant", content: "", toolCalls: [{ id: "call_0", name: "lookup", arguments: "{\"q\":1}" }] },
  { role: "tool", content: "found", toolCallId: "call_0" },
  { role: "user", content: [{ type: "text", text: "and now?" }] },
];

/** Requests the cases below send, each to several provider configs. */
const REQUESTS: Record<string, ChatCompletionRequest> = {
  plain: { model: "gpt-4o", messages: [{ role: "user", content: "hi" }] },
  everything: {
    model: "gpt-4o",
    messages: history,
    temperature: 0.2,
    maxTokens: 64,
    topP: 0.9,
    stop: ["END"],
    tools: strictTools,
    toolChoice: { name: "lookup" },
    responseFormat: { type: "json_schema", name: "out", schema: { type: "object" } },
    extra: { reasoning_effort: "low", parallel_tool_calls: false },
  },
  reasoningOnChatModel: { model: "gpt-4o", messages: history, tools, reasoning: { effort: "high" } },
  reasoningOnGpt5: {
    model: "gpt-5.6-terra",
    messages: history,
    tools,
    reasoning: { effort: "medium", includeThoughts: true },
  },
  gpt5NoReasoning: { model: "gpt-5.6-terra", messages: history, tools, extra: { reasoning_effort: "medium" } },
  // Not migrated: a gpt-6 name gets the same routing as any other unknown name.
  gpt6NoReasoning: { model: "gpt-6.1-sol", messages: history, tools, extra: { reasoning_effort: "medium" } },
  gpt6Reasoning: { model: "gpt-6.1-sol", messages: history, tools, reasoning: { effort: "high" } },
};

const PROVIDERS: Record<string, () => BaseProvider> = {
  openaiDefault: () => new OpenAIProvider({ provider: "openai", apiKey: "k" }),
  openaiAzureV1: () =>
    new OpenAIProvider({ provider: "openai", apiKey: "k", baseURL: "https://res.openai.azure.com/openai/v1" }),
  openaiNever: () => new OpenAIProvider({ provider: "openai", apiKey: "k", responsesApi: "never" }),
  openaiAlways: () => new OpenAIProvider({ provider: "openai", apiKey: "k", responsesApi: "always" }),
  azure: () =>
    new AzureProvider({ provider: "azure", apiKey: "k", endpoint: "https://res.openai.azure.com" }),
  compatible: () =>
    new OpenAICompatibleProvider({ provider: "openai-compatible", apiKey: "k", baseURL: "http://localhost:8000/v1" }),
};

describe("OpenAI-shaped providers: wire traffic for configs without the new options", () => {
  for (const [providerName, make] of Object.entries(PROVIDERS)) {
    for (const [requestName, request] of Object.entries(REQUESTS)) {
      for (const stream of [false, true]) {
        it(`${providerName} / ${requestName} / ${stream ? "stream" : "complete"}`, async () => {
          const { calls, output } = await run(make(), structuredClone(request), stream);
          expect(calls).toMatchSnapshot("http");
          expect(output).toMatchSnapshot("output");
        });
      }
    }
  }
});
