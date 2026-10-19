/**
 * Record enrichment: what the trace records say about the provider's answer, why
 * a call never ran, what failed, and which ids belong to the provider - and how
 * the exported spans read it. Real agents, scripted models, an injected fetch.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { createAgent, createOtlpExporter, createSmartAgent, createTool } from "../../../src/index.js";
import { defineHook } from "../../../src/plugins/define.js";
import type { AgentPlugin } from "../../../src/plugins/types.js";
import { customSink } from "../../../src/utils/tracing.js";
import { attachWireInfo } from "../../../src/providers/wireInfo.js";
import { captureSnapshot, restoreSnapshot } from "../../../src/utils/stateSnapshot.js";
import { providerHintOf, traceResponseFacts } from "../../../src/utils/traceFacts.js";
import { cacheWriteTokensOf } from "../../../src/utils/usage.js";
import { genAiProviderName } from "../../../src/utils/otlp/semconv.js";
import type { Message, TraceEventRecord, TraceSessionFile } from "../../../src/types.js";
import { attrsOf, okResponse, spansOf } from "./helpers.js";

afterEach(() => {
  vi.restoreAllMocks();
});

const call = (id: string, name: string, args: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) => ({
  id, type: "function", function: { name, arguments: JSON.stringify(args) }, ...extra,
});

function scripted(name: string, script: Array<Partial<Message> & Record<string, any> | (() => any)>) {
  let turn = 0;
  const model: any = {
    modelName: name,
    bindTools() { return model; },
    async invoke() {
      const step = script[Math.min(turn++, script.length - 1)];
      if (typeof step === "function") return step();
      return { role: "assistant", content: "", ...step };
    },
  };
  return model;
}

/** An OTLP exporter plus a custom sink, so both the exported spans and the session file can be read. */
function harness(content?: Parameters<typeof createOtlpExporter>[0]["content"], extraPlugins: AgentPlugin[] = []) {
  const bodies: any[] = [];
  const fetch = vi.fn(async (_url: string, init: any) => {
    bodies.push(JSON.parse(init.body));
    return okResponse();
  });
  const sessions: TraceSessionFile[] = [];
  const events: TraceEventRecord[] = [];
  const plugin: AgentPlugin = {
    name: "otlp",
    traceExporters: [createOtlpExporter({ endpoint: "https://c.example.test/v1/traces", fetch, content })],
  };
  return {
    bodies,
    sessions,
    events,
    options: {
      plugins: [plugin, ...extraPlugins],
      tracing: {
        enabled: true,
        sink: customSink({ onEvent: (e) => { events.push(e); }, onSession: (s) => { sessions.push(s); } }),
      },
    },
    spans: () => bodies.flatMap(spansOf),
    spanNamed: (name: string) => bodies.flatMap(spansOf).find((s) => s.name === name),
    records: () => sessions.flatMap((s) => s.events),
  };
}

const go = { messages: [{ role: "user", content: "go" }] } as any;
const echo = () => createTool({ name: "echo", description: "echoes", schema: z.object({}), func: async () => "echoed" });
const wire = (message: object, info: Parameters<typeof attachWireInfo>[1]) => attachWireInfo(message, info);

describe("wire facts become record fields", () => {
  it("responseId, responseModel, rawFinishReason, cacheWriteTokens, usageBasis and the provider reach the record and the span", async () => {
    const h = harness();
    const message = wire(
      {
        role: "assistant",
        content: "hello",
        usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30, prompt_tokens_details: { cached_tokens: 90, cache_write_tokens: 5 } },
        response_metadata: { finish_reason: "stop" },
      },
      { provider: "anthropic", responseId: "msg_01", responseModel: "claude-sonnet-4-20250514", rawFinishReason: "end_turn" },
    );
    await createAgent({ name: "A", model: scripted("claude-sonnet-4", [() => message]), ...h.options }).invoke(go);

    const record = h.records().find((r) => r.type === "ai_call")!;
    expect(record).toMatchObject({
      provider: "anthropic",
      responseId: "msg_01",
      responseModel: "claude-sonnet-4-20250514",
      rawFinishReason: "end_turn",
      finishReason: "stop",
      cacheWriteTokens: 5,
      usageBasis: { inputExcludesCache: true },
      outputType: "text",
      inputTokens: 10,
      cachedInputTokens: 90,
    });
    // Nothing of the symbol survives in what sinks are handed.
    expect(JSON.stringify(record)).not.toContain("wireInfo");

    const chat = h.spanNamed("chat claude-sonnet-4")!;
    expect(attrsOf(chat)).toMatchObject({
      "gen_ai.provider.name": "anthropic",
      "gen_ai.response.id": "msg_01",
      "gen_ai.response.model": "claude-sonnet-4-20250514",
      "gen_ai.response.finish_reasons": ["end_turn"],
      // Anthropic's input excludes the cache; gen_ai counts it in.
      "gen_ai.usage.input_tokens": 105,
      "gen_ai.usage.output_tokens": 20,
      "gen_ai.usage.cache_read.input_tokens": 90,
      "gen_ai.usage.cache_write.input_tokens": 5,
      // cognipeer.* keeps what it always said.
      "cognipeer.tokens.input": 10,
    });
  });

  it("a streamed call says so", async () => {
    const h = harness();
    const model: any = {
      modelName: "m",
      bindTools() { return model; },
      async invoke() { throw new Error("not used"); },
      async *stream() {
        yield "he";
        yield attachWireInfo({ role: "assistant", content: "hello", usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 } }, { provider: "openai", responseId: "chatcmpl-1", streaming: true });
      },
    };
    await createAgent({ name: "A", model, ...h.options }).invoke(go, { stream: true });
    expect(h.records().find((r) => r.type === "ai_call")).toMatchObject({ streaming: true, responseId: "chatcmpl-1", provider: "openai" });
    expect(attrsOf(h.spanNamed("chat m")!)["gen_ai.request.stream"]).toBe(true);
  });

  it("a LangChain-style response is read from response_metadata; a run id is not a response id", async () => {
    const h = harness();
    class ChatOpenAI {}
    const lc: any = new ChatOpenAI();
    lc.modelName = "gpt-4o";
    lc.bindTools = () => lc;
    lc.invoke = async () => ({
      role: "assistant",
      content: "x",
      id: "run-7c1d1f64-1111-2222-3333-444455556666",
      response_metadata: { model_name: "gpt-4o-2024-08-06", finish_reason: "stop", id: "chatcmpl-9" },
    });
    await createAgent({ name: "A", model: lc, ...h.options }).invoke(go);
    expect(h.records().find((r) => r.type === "ai_call")).toMatchObject({
      provider: "ChatOpenAI",
      responseId: "chatcmpl-9",
      responseModel: "gpt-4o-2024-08-06",
      rawFinishReason: "stop",
    });
    expect(attrsOf(h.spanNamed("chat gpt-4o")!)["gen_ai.provider.name"]).toBe("openai");

    const noId: any = { role: "assistant", content: "x", id: "run-abc", response_metadata: {} };
    expect(traceResponseFacts(undefined, noId, undefined)).not.toHaveProperty("responseId");
  });

  it("facts the provider did not give are left off, never zeroed or emptied", () => {
    const facts = traceResponseFacts(undefined, { role: "assistant", content: "x" }, { prompt_tokens: 1 });
    expect(facts).toEqual({});
    expect(traceResponseFacts(undefined, attachWireInfo({ role: "assistant" }, { responseId: "", rawFinishReason: "" }), undefined)).toEqual({});
  });

  it("a hook that returns a rebuilt message does not lose them", async () => {
    const h = harness(undefined, [
      defineHook("postModelCall", ({ message }) => ({ message: { ...(message as any), content: "rewritten" } }), { name: "rewriter" }),
    ]);
    const message = wire({ role: "assistant", content: "orig" }, { provider: "openai", responseId: "chatcmpl-keep", responseModel: "m-1" });
    await createAgent({ name: "A", model: scripted("m", [() => message]), ...h.options }).invoke(go);
    expect(h.records().find((r) => r.type === "ai_call")).toMatchObject({ responseId: "chatcmpl-keep", responseModel: "m-1" });
  });

  it("cacheWriteTokensOf reads every shape the SDK meets", () => {
    expect(cacheWriteTokensOf({ prompt_tokens_details: { cache_write_tokens: 7 } })).toBe(7);
    expect(cacheWriteTokensOf({ cache_write_tokens: 6 })).toBe(6);
    expect(cacheWriteTokensOf({ cache_creation_input_tokens: 5 })).toBe(5);
    expect(cacheWriteTokensOf({ cacheWriteInputTokens: 4 })).toBe(4);
    expect(cacheWriteTokensOf({ prompt_tokens_details: { cache_write_tokens: 0 } })).toBeUndefined();
    expect(cacheWriteTokensOf(undefined)).toBeUndefined();
  });
});

describe("provider names", () => {
  it("come from the registry only: unknown hints are omitted", () => {
    expect(genAiProviderName("openai")).toBe("openai");
    expect(genAiProviderName("azure")).toBe("azure.ai.openai");
    expect(genAiProviderName("anthropic")).toBe("anthropic");
    expect(genAiProviderName("bedrock")).toBe("aws.bedrock");
    expect(genAiProviderName("vertex")).toBe("gcp.vertex_ai");
    expect(genAiProviderName("gemini")).toBe("gcp.gemini");
    expect(genAiProviderName("google")).toBe("gcp.gen_ai");
    expect(genAiProviderName("openai-compatible")).toBeUndefined();
    expect(genAiProviderName("jev")).toBeUndefined();
    expect(genAiProviderName("some-gateway")).toBeUndefined();
  });

  it("providerHintOf: the model's own name, then the wire info, then the capability detector (LangChain)", () => {
    class ChatAnthropic {}
    expect(providerHintOf(new ChatAnthropic())).toBe("ChatAnthropic");
    expect(providerHintOf({ modelName: "x" }, attachWireInfo({ role: "assistant" }, { provider: "vertex" }))).toBe("vertex");
    expect(providerHintOf({ capabilities: { provider: "google" } })).toBe("google");
    expect(providerHintOf({ modelName: "claude-3-5-sonnet" })).toBe("anthropic");
    expect(providerHintOf({})).toBeUndefined();
    expect(genAiProviderName(providerHintOf({ capabilities: { provider: "google" } }))).toBe("gcp.gen_ai");
    expect(genAiProviderName(providerHintOf({}, attachWireInfo({ role: "assistant" }, { provider: "vertex" })))).toBe("gcp.vertex_ai");
  });
});

describe("calls that never ran are plain INTERNAL spans", () => {
  const operation = (span: any) => attrsOf(span)["gen_ai.operation.name"];

  it("a model call a plugin blocked: skipReason blocked, no chat, no usage", async () => {
    const h = harness(undefined, [defineHook("preModelCall", () => ({ decision: "deny", reason: "nope" }), { name: "gate" })]);
    await createAgent({ name: "A", model: scripted("m", [{ content: "never" }]), ...h.options }).invoke(go);
    const record = h.records().find((r) => r.type === "ai_call")!;
    expect(record).toMatchObject({ status: "skipped", skipReason: "blocked" });
    const span = h.spans().find((s) => attrsOf(s)["cognipeer.event.id"] === record.id)!;
    expect(operation(span)).toBeUndefined();
    expect(span.kind).toBe(1);
    expect(span.status.code).toBe(0);
    expect(Object.keys(attrsOf(span)).filter((k) => k.startsWith("gen_ai.usage"))).toEqual([]);
  });

  it("a model call a plugin answered: skipReason short_circuit", async () => {
    const h = harness(undefined, [defineHook("preModelCall", () => ({ shortCircuit: { role: "assistant", content: "canned" } }), { name: "canned" })]);
    const result = await createAgent({ name: "A", model: scripted("m", [{ content: "never" }]), ...h.options }).invoke(go);
    expect(result.content).toBe("canned");
    const record = h.records().find((r) => r.type === "ai_call")!;
    expect(record).toMatchObject({ status: "skipped", skipReason: "short_circuit" });
    expect(operation(h.spans().find((s) => attrsOf(s)["cognipeer.event.id"] === record.id)!)).toBeUndefined();
  });

  it("a call cancelled while the provider was answering stays a chat span: UNSET status, finish_reasons [error]", async () => {
    const h = harness();
    const controller = new AbortController();
    const model: any = {
      modelName: "m",
      bindTools() { return model; },
      invoke: (_m: unknown, options: { signal?: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          options.signal?.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })));
          setTimeout(() => controller.abort(), 5);
        }),
    };
    const result = await createAgent({ name: "A", model, ...h.options }).invoke(go, { cancellationToken: controller.signal });
    expect((result.state as any).ctx.__cancelled).toBeDefined();
    const record = h.records().find((r) => r.type === "ai_call")!;
    expect(record).toMatchObject({ status: "skipped", skipReason: "cancelled" });
    const chat = h.spans().find((s) => attrsOf(s)["cognipeer.event.id"] === record.id)!;
    expect(chat.name).toBe("chat m");
    expect(chat.kind).toBe(3);
    expect(chat.status.code).toBe(0);
    expect(attrsOf(chat)["gen_ai.response.finish_reasons"]).toEqual(["error"]);
  });

  it("a tool a policy denied, a tool skipped by its run limit: skipReason, no execute_tool", async () => {
    const h = harness(undefined, [defineHook("preToolUse", ({ toolName }) => (toolName === "echo" ? { decision: "deny", reason: "policy" } : undefined), { name: "tool-gate", mayRequireApproval: false })]);
    await createAgent({
      name: "A",
      model: scripted("m", [{ tool_calls: [call("t1", "echo")] }, { content: "done" }]),
      tools: [echo()],
      ...h.options,
    }).invoke(go);
    const denied = h.records().find((r) => r.type === "tool_call")!;
    expect(denied).toMatchObject({ status: "skipped", skipReason: "denied" });
    const span = h.spans().find((s) => attrsOf(s)["cognipeer.event.id"] === denied.id)!;
    expect(operation(span)).toBeUndefined();
    expect(span.name).not.toMatch(/^execute_tool/);

    const limited = harness();
    const once = createTool({ name: "once", description: "d", schema: z.object({}), maxExecutionsPerRun: 1, func: async () => "ok" });
    await createAgent({
      name: "A",
      model: scripted("m", [{ tool_calls: [call("t1", "once")] }, { tool_calls: [call("t2", "once")] }, { content: "done" }]),
      tools: [once],
      ...limited.options,
    }).invoke(go);
    const skipped = limited.records().filter((r) => r.type === "tool_call" && r.skipReason === "skipped");
    expect(skipped).toHaveLength(1);
    const skippedSpan = limited.spans().find((s) => attrsOf(s)["cognipeer.event.id"] === skipped[0].id)!;
    expect(operation(skippedSpan)).toBeUndefined();
    expect(limited.spans().filter((s) => s.name === "execute_tool once")).toHaveLength(1);
  });

  it("a cache hit and a plugin-supplied result are short_circuit INTERNAL spans, not execute_tool", async () => {
    const cached = harness();
    const lookup = createTool({ name: "lookup", description: "d", schema: z.object({}), cache: { scope: "run" }, func: async () => "fresh" } as any);
    await createAgent({
      name: "A",
      model: scripted("m", [{ tool_calls: [call("t1", "lookup")] }, { tool_calls: [call("t2", "lookup")] }, { content: "done" }]),
      tools: [lookup],
      ...cached.options,
    }).invoke(go);
    const toolRecords = cached.records().filter((r) => r.type === "tool_call");
    expect(toolRecords.map((r) => r.skipReason)).toEqual([undefined, "short_circuit"]);
    expect(cached.spans().filter((s) => s.name === "execute_tool lookup")).toHaveLength(1);

    const stubbed = harness(undefined, [defineHook("preToolUse", () => ({ result: "stub" }), { name: "stub", mayRequireApproval: false })]);
    await createAgent({
      name: "A",
      model: scripted("m", [{ tool_calls: [call("t1", "echo")] }, { content: "done" }]),
      tools: [echo()],
      ...stubbed.options,
    }).invoke(go);
    expect(stubbed.records().find((r) => r.type === "tool_call")).toMatchObject({ skipReason: "short_circuit" });
    expect(stubbed.spans().some((s) => s.name === "execute_tool echo")).toBe(false);
  });

  it("an open circuit breaker is a skipped tool with its error", async () => {
    const h = harness();
    const flaky = createTool({
      name: "flaky", description: "d", schema: z.object({}),
      retry: { circuitBreakerThreshold: 1 },
      func: async () => { throw new Error("down"); },
    } as any);
    await createAgent({
      name: "A",
      model: scripted("m", [{ tool_calls: [call("t1", "flaky")] }, { tool_calls: [call("t2", "flaky")] }, { content: "done" }]),
      tools: [flaky],
      ...h.options,
    }).invoke(go);
    const records = h.records().filter((r) => r.type === "tool_call");
    expect(records).toHaveLength(2);
    expect(records[0]).toMatchObject({ status: "error" });
    expect(records[0].skipReason).toBeUndefined();
    expect(records[1]).toMatchObject({ status: "error", skipReason: "skipped", error: { type: "circuit_breaker_open" } });
    const breakerSpan = h.spans().find((s) => attrsOf(s)["cognipeer.event.id"] === records[1].id)!;
    expect(operation(breakerSpan)).toBeUndefined();
    expect(breakerSpan.status.code).toBe(2);
    expect(attrsOf(breakerSpan)["error.type"]).toBe("circuit_breaker_open");
  });
});

describe("failures carry their class name", () => {
  it("a model error: record error.type, span error.type, finish_reasons [error], one exception event", async () => {
    const h = harness();
    class RateLimitError extends Error { constructor(m: string) { super(m); this.name = "RateLimitError"; } }
    const model = scripted("m", [() => { throw new RateLimitError("429 slow down"); }]);
    await expect(createAgent({ name: "A", model, ...h.options }).invoke(go)).rejects.toThrow("429");
    const record = h.records().find((r) => r.type === "ai_call")!;
    expect(record.error).toMatchObject({ message: "429 slow down", type: "RateLimitError" });
    const chat = h.spanNamed("chat m")!;
    expect(chat.status.code).toBe(2);
    expect(attrsOf(chat)["error.type"]).toBe("RateLimitError");
    expect(attrsOf(chat)["gen_ai.response.finish_reasons"]).toEqual(["error"]);
    expect(chat.events).toHaveLength(1);
    expect(attrsOf({ attributes: chat.events![0].attributes })["exception.type"]).toBe("RateLimitError");
  });

  it("a tool that throws, and a tool that reports its own failure", async () => {
    const h = harness();
    const boom = createTool({ name: "boom", description: "d", schema: z.object({}), func: async () => { throw new TypeError("bad shape"); } });
    await createAgent({
      name: "A",
      model: scripted("m", [{ tool_calls: [call("t1", "boom")] }, { content: "done" }]),
      tools: [boom],
      ...h.options,
    }).invoke(go);
    const record = h.records().find((r) => r.type === "tool_call")!;
    expect(record.error).toMatchObject({ message: "bad shape", type: "TypeError" });
    expect(attrsOf(h.spanNamed("execute_tool boom")!)["error.type"]).toBe("TypeError");
  });

  it("a thrown value that is not an Error has no class: the span says _OTHER", async () => {
    const h = harness();
    const model = scripted("m", [() => { throw "plain string"; }]);
    await expect(createAgent({ name: "A", model, ...h.options }).invoke(go)).rejects.toBe("plain string");
    expect(h.records().find((r) => r.type === "ai_call")!.error).not.toHaveProperty("type");
    expect(attrsOf(h.spanNamed("chat m")!)["error.type"]).toBe("_OTHER");
  });
});

describe("gen_ai.tool.call.id: the provider's id or nothing", () => {
  const idOf = (h: ReturnType<typeof harness>, tool: string) => attrsOf(h.spanNamed(`execute_tool ${tool}`)!)["gen_ai.tool.call.id"];

  it("a provider-supplied id is on the span and the record", async () => {
    const h = harness();
    await createAgent({ name: "A", model: scripted("m", [{ tool_calls: [call("call_real_1", "echo")] }, { content: "ok" }]), tools: [echo()], ...h.options }).invoke(go);
    expect(idOf(h, "echo")).toBe("call_real_1");
    expect(h.records().find((r) => r.type === "tool_call")!.toolCallId).toBe("call_real_1");
  });

  it("a call with no id (the tools node invents echo_N for the transcript) has none on the span", async () => {
    const h = harness();
    const result = await createAgent({ name: "A", model: scripted("m", [{ tool_calls: [call("", "echo")] }, { content: "ok" }]), tools: [echo()], ...h.options }).invoke(go);
    expect(JSON.stringify(result.messages)).toMatch(/"tool_call_id":"echo_\d"/);
    expect(idOf(h, "echo")).toBeUndefined();
    expect(h.records().find((r) => r.type === "tool_call")).not.toHaveProperty("toolCallId");
  });

  it("an id an adapter made up (Vertex call_0) is marked on the call and never exported", async () => {
    const h = harness();
    await createAgent({
      name: "A",
      model: scripted("m", [{ tool_calls: [call("call_0", "echo", {}, { idSynthesized: true })] }, { content: "ok" }]),
      tools: [echo()],
      ...h.options,
    }).invoke(go);
    expect(idOf(h, "echo")).toBeUndefined();
  });

  it("holds after a pause and resume, where the model's turn is replayed from persisted messages", async () => {
    const dangerous = createTool({ name: "dangerous", description: "d", schema: z.object({}), needsApproval: true, func: async () => "executed" });
    const run = async (tc: ReturnType<typeof call>) => {
      const h = harness();
      const agent = createSmartAgent({
        name: "A",
        model: scripted("m", [{ tool_calls: [tc] }, { content: "done" }]),
        tools: [dangerous],
        summarization: false,
        ...h.options,
      } as any);
      const paused: any = await agent.invoke(go);
      const state = restoreSnapshot(JSON.parse(JSON.stringify(captureSnapshot(paused.state)))) as any;
      const pending = state.pendingApprovals.find((x: any) => x.status === "pending");
      await agent.invoke(agent.resolveToolApproval(state, { id: pending.id, approved: true, decidedBy: "ops" }) as any);
      return idOf(h, "dangerous");
    };
    expect(await run(call("call_vertex_0", "dangerous", {}, { idSynthesized: true }))).toBeUndefined();
    expect(await run(call("call_openai_77", "dangerous"))).toBe("call_openai_77");
  });
});

describe("the tool's context", () => {
  it("carries traceId, and no trace flags when the run has no parent", async () => {
    const h = harness();
    let seen: any;
    const probe = createTool({ name: "probe", description: "d", schema: z.object({}), func: async (_a, ctx) => { seen = ctx; return "ok"; } });
    await createAgent({ name: "A", model: scripted("m", [{ tool_calls: [call("t1", "probe")] }, { content: "ok" }]), tools: [probe], ...h.options }).invoke(go);
    expect(seen.traceId).toBe(h.sessions[0].traceId);
    expect(seen.traceSpanId).toMatch(/^[0-9a-f]{16}$/);
    expect(seen.traceFlags).toBeUndefined();
  });

  it("an untraced run hands the tool no trace identity", async () => {
    let seen: any;
    const probe = createTool({ name: "probe", description: "d", schema: z.object({}), func: async (_a, ctx) => { seen = ctx; return "ok"; } });
    await createAgent({ name: "A", model: scripted("m", [{ tool_calls: [call("t1", "probe")] }, { content: "ok" }]), tools: [probe] }).invoke(go);
    expect(seen.traceId).toBeUndefined();
    expect(seen.traceSpanId).toBeUndefined();
  });
});
