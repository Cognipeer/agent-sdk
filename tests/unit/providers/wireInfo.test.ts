import { afterEach, describe, expect, it } from "vitest";
import { fromNativeProvider, VertexProvider } from "../../../src/providers/index.js";
import { fromLangchainModel } from "../../../src/model.js";
import { WIRE_INFO, attachWireInfo, usageBasisOf, wireInfoOf } from "../../../src/providers/wireInfo.js";
import type { ChatCompletionChunk, ChatCompletionResponse } from "../../../src/providers/types.js";
import { emptyUsage } from "../../../src/providers/index.js";

const usage = { ...emptyUsage(), inputTokens: 10, outputTokens: 5, totalTokens: 15 };

function fakeProvider(providerName: string, response: Partial<ChatCompletionResponse>, chunks: ChatCompletionChunk[] = []): any {
  return {
    providerName,
    async complete(): Promise<ChatCompletionResponse> {
      return { id: "resp_1", model: "model-v1", content: "hi", toolCalls: [], usage, finishReason: "stop", raw: {}, ...response };
    },
    async *completeStream() {
      for (const chunk of chunks) yield chunk;
    },
  };
}

const user = [{ role: "user", content: "hello" }];

describe("native adapters attach wire info", () => {
  it.each([
    ["anthropic", { inputExcludesCache: true }],
    ["bedrock", { inputExcludesCache: true }],
    ["vertex", { outputExcludesReasoning: true }],
    ["openai", undefined],
    ["azure", undefined],
    ["openai-compatible", undefined],
    ["jev", undefined],
  ])("invoke on %s: provider, response id, response model, raw stop reason, usage basis", async (providerName, basis) => {
    const model = fromNativeProvider(fakeProvider(providerName, { rawFinishReason: "end_turn" }), { model: "model-v1" });
    const message = await model.invoke(user);
    expect(wireInfoOf(message)).toEqual({
      provider: providerName,
      responseId: "resp_1",
      responseModel: "model-v1",
      rawFinishReason: "end_turn",
      ...(basis ? { usageBasis: basis } : {}),
    });
  });

  it("stream: the assembled message carries the facts the chunks gave, and says it was streamed", async () => {
    const chunks: ChatCompletionChunk[] = [
      { id: "resp_s", model: "model-s", delta: { content: "he" } },
      { id: "resp_s", model: "model-s", delta: { content: "llo" }, usage, finishReason: "stop", rawFinishReason: "STOP" },
    ];
    const model = fromNativeProvider(fakeProvider("vertex", {}, chunks), { model: "model-s" });
    let last: any;
    for await (const part of model.stream!(user)) last = part;
    expect(last.content).toBe("hello");
    expect(wireInfoOf(last)).toEqual({
      provider: "vertex",
      responseId: "resp_s",
      responseModel: "model-s",
      rawFinishReason: "STOP",
      streaming: true,
      usageBasis: { outputExcludesReasoning: true },
    });
  });

  it("an empty response id (Vertex sends none) is omitted, not recorded as empty", async () => {
    const model = fromNativeProvider(fakeProvider("vertex", { id: "" }), { model: "m" });
    expect(wireInfoOf(await model.invoke(user))).not.toHaveProperty("responseId");
  });

  it("is invisible to JSON, so it never reaches a wire payload, a transcript or a sink", async () => {
    const model = fromNativeProvider(fakeProvider("anthropic", {}), { model: "m" });
    const message = await model.invoke(user);
    expect(JSON.stringify(message)).not.toContain("resp_1");
    expect(Object.keys(message)).not.toContain(String(WIRE_INFO));
    expect(JSON.parse(JSON.stringify(message))[WIRE_INFO]).toBeUndefined();
  });

  it("survives the object spreads a LangChain wrapper and the plugin hooks make", async () => {
    const message = attachWireInfo({ role: "assistant", content: "x" }, { provider: "bedrock", responseId: "r1" });
    expect(wireInfoOf({ ...message, content: "y" })).toMatchObject({ provider: "bedrock", responseId: "r1" });

    const wrapped = fromLangchainModel({ invoke: async () => message, modelName: "lc" });
    expect(wireInfoOf(await wrapped.invoke(user))).toMatchObject({ provider: "bedrock", responseId: "r1" });
  });

  it("usageBasisOf knows each provider's counting", () => {
    expect(usageBasisOf("anthropic")).toEqual({ inputExcludesCache: true });
    expect(usageBasisOf("bedrock")).toEqual({ inputExcludesCache: true });
    expect(usageBasisOf("vertex")).toEqual({ outputExcludesReasoning: true });
    expect(usageBasisOf("openai")).toBeUndefined();
    expect(usageBasisOf(undefined)).toBeUndefined();
  });
});

describe("Vertex tool call ids", () => {
  const provider = new VertexProvider({ provider: "vertex", projectId: "p", location: "l", accessToken: "t", defaultModel: "gemini-2.0-flash" });
  const parse = (json: unknown) => (provider as any).parseResponse(json, "gemini-2.0-flash") as ChatCompletionResponse;
  const parseChunk = (json: unknown, counter = { next: 0 }) => (provider as any).parseStreamChunk(json, "gemini-2.0-flash", counter) as ChatCompletionChunk;

  const reply = (parts: unknown[], extra: Record<string, unknown> = {}) => ({
    candidates: [{ content: { role: "model", parts }, finishReason: "STOP" }],
    usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1, totalTokenCount: 2 },
    ...extra,
  });

  afterEach(() => undefined);

  it("an id Gemini supplies is used and not marked; one made up here is marked", () => {
    const response = parse(reply([
      { functionCall: { id: "gm_abc", name: "lookup", args: {} } },
      { functionCall: { name: "other", args: {} } },
    ]));
    expect(response.toolCalls[0]).toMatchObject({ id: "gm_abc", name: "lookup" });
    expect(response.toolCalls[0].idSynthesized).toBeUndefined();
    expect(response.toolCalls[1]).toMatchObject({ id: "call_1", name: "other", idSynthesized: true });
  });

  it("the same holds for streamed chunks", () => {
    const counter = { next: 0 };
    const supplied = parseChunk(reply([{ functionCall: { id: "gm_s", name: "lookup", args: {} } }]), counter);
    const made = parseChunk(reply([{ functionCall: { name: "other", args: {} } }]), counter);
    expect(supplied.delta.toolCalls![0]).toMatchObject({ id: "gm_s", index: 0 });
    expect(supplied.delta.toolCalls![0].idSynthesized).toBeUndefined();
    expect(made.delta.toolCalls![0]).toMatchObject({ id: "call_1", index: 1, idSynthesized: true });
  });

  it("the marker travels on the message the adapter builds, for invoke and stream", async () => {
    const synthetic = { id: "call_0", name: "lookup", arguments: "{}", idSynthesized: true };
    const invoked = await fromNativeProvider(fakeProvider("vertex", { toolCalls: [synthetic] }), { model: "m" }).invoke(user);
    expect((invoked.tool_calls as any[])[0]).toMatchObject({ id: "call_0", idSynthesized: true });

    const streamed = fromNativeProvider(
      fakeProvider("vertex", {}, [{ id: "", model: "m", delta: { toolCalls: [{ ...synthetic, index: 0 }] }, finishReason: "tool_calls" }]),
      { model: "m" },
    );
    let last: any;
    for await (const part of streamed.stream!(user)) last = part;
    expect(last.tool_calls[0]).toMatchObject({ id: "call_0", idSynthesized: true });
  });

  it("an empty response id comes through as empty and is dropped by the adapter", () => {
    expect(parse(reply([{ text: "hi" }])).id).toBe("");
  });
});
