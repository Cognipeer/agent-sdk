/**
 * Observability plugins: langfuseTracing and otelTracing.
 *
 * Both are driven through a real `createPluginHost` run handle rather than by
 * calling the hook functions directly. That matters more here than elsewhere:
 * the whole claim these plugins make is that a hook-driven exporter sees things
 * a sink cannot — a tool call a later policy plugin denied, a run that ended
 * without a final answer — and that claim only holds if the composition rules
 * (priority order, deny short-circuiting the chain, per-run store lifetime) are
 * the ones actually running.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { createPluginHost, langfuseTracing, otelTracing } from "../../../src/plugins/index.js";
import type { AgentPlugin, PluginLogger, PluginRunHost } from "../../../src/plugins/index.js";
import type { SmartAgentEvent, SmartState, TraceSessionRuntime } from "../../../src/types.js";
import { attachWireInfo } from "../../../src/providers/wireInfo.js";
import { createSubagentTraceScope, createTraceSession, customSink, finalizeTraceSession, recordTraceEvent } from "../../../src/utils/tracing.js";

afterEach(() => {
  vi.restoreAllMocks();
  // `restoreAllMocks` does not undo `stubGlobal`, and the whole suite shares one
  // process — a leaked `fetch` would poison every later file.
  vi.unstubAllGlobals();
});

// ─── Harness ─────────────────────────────────────────────────────────────────

const silentLogger: PluginLogger = { debug: () => {}, warn: () => {}, error: () => {} };

type Harness = {
  host: ReturnType<typeof createPluginHost>;
  run: PluginRunHost;
  events: SmartAgentEvent[];
};

function harness(plugins: AgentPlugin[], state: Partial<SmartState> = {}): Harness {
  const events: SmartAgentEvent[] = [];
  const host = createPluginHost(plugins, { logger: silentLogger });
  const getState = () => ({ messages: [], ...state }) as SmartState;
  const run = host.beginRun({
    runId: "run-1",
    agentName: "test-agent",
    getState,
    emit: (event) => events.push(event),
  });
  return { host, run, events };
}

type FetchCall = [string, { method?: string; headers?: Record<string, string>; body?: string }];

function stubFetch(impl: (url: string, init: FetchCall[1]) => Promise<unknown>) {
  const mock = vi.fn(impl);
  vi.stubGlobal("fetch", mock as unknown as typeof fetch);
  return mock;
}

const okResponse = () => ({ ok: true, status: 200, statusText: "OK", text: async () => "" });

const errorResponse = (status: number, body = "") => ({
  ok: false,
  status,
  statusText: "Error",
  text: async () => body,
});

const metadataEvents = (events: SmartAgentEvent[]): Array<Record<string, unknown>> =>
  events.filter((event) => (event as { type?: string }).type === "metadata") as never;

const modelInput = (overrides: Record<string, unknown> = {}) => ({
  message: { role: "assistant" as const, content: "hi" },
  usage: { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 },
  durationMs: 250,
  iteration: 1,
  shortCircuited: false,
  ...overrides,
});

const toolInput = (toolName: string, toolCallId: string) => ({
  toolName,
  toolCallId,
  args: { path: "/tmp/x" },
  tool: { name: toolName } as never,
  executionCount: 0,
});

const sessionEndInput = (status: "success" | "error" | "paused" | "cancelled" = "success") => ({
  status,
  durationMs: 1234,
});

/** Every batch item POSTed across every call, flattened in send order. */
function batchItems(mock: ReturnType<typeof stubFetch>): Array<Record<string, any>> {
  return mock.mock.calls.flatMap((call) => JSON.parse((call[1] as FetchCall[1]).body!).batch);
}

const langfuseKeys = { publicKey: "pk-test", secretKey: "sk-test" };

// ─── langfuseTracing ─────────────────────────────────────────────────────────

describe("langfuseTracing", () => {
  it("touches the network neither at import nor at construction", async () => {
    const fetchMock = stubFetch(async () => okResponse());
    // A fresh module registry, so this really exercises module evaluation and
    // not the copy this file imported statically at the top.
    vi.resetModules();
    const fresh = await import("../../../src/plugins/builtin/langfuse.js");
    expect(fetchMock).not.toHaveBeenCalled();

    const plugin = fresh.langfuseTracing({ ...langfuseKeys, flushIntervalMs: 0 });
    const { host } = harness([plugin]);
    await host.setup({ model: null });

    expect(fetchMock).not.toHaveBeenCalled();
    await host.dispose();
  });

  it("refuses to construct without credentials rather than exporting nothing forever", () => {
    const saved = { pub: process.env.LANGFUSE_PUBLIC_KEY, sec: process.env.LANGFUSE_SECRET_KEY };
    delete process.env.LANGFUSE_PUBLIC_KEY;
    delete process.env.LANGFUSE_SECRET_KEY;
    try {
      expect(() => langfuseTracing()).toThrow(/requires publicKey and secretKey/);
    } finally {
      if (saved.pub === undefined) delete process.env.LANGFUSE_PUBLIC_KEY;
      else process.env.LANGFUSE_PUBLIC_KEY = saved.pub;
      if (saved.sec === undefined) delete process.env.LANGFUSE_SECRET_KEY;
      else process.env.LANGFUSE_SECRET_KEY = saved.sec;
    }
  });

  it("reads keys and host from the environment", async () => {
    const saved = {
      pub: process.env.LANGFUSE_PUBLIC_KEY,
      sec: process.env.LANGFUSE_SECRET_KEY,
      base: process.env.LANGFUSE_BASE_URL,
    };
    process.env.LANGFUSE_PUBLIC_KEY = "pk-env";
    process.env.LANGFUSE_SECRET_KEY = "sk-env";
    process.env.LANGFUSE_BASE_URL = "https://langfuse.internal/";
    try {
      const fetchMock = stubFetch(async () => okResponse());
      const { host, run } = harness([langfuseTracing({ flushAt: 1, flushIntervalMs: 0 })]);
      await host.setup({ model: null });
      await run.runGate("sessionStart", { messages: [], resumed: false });

      expect(fetchMock).toHaveBeenCalledTimes(1);
      // Trailing slash on the base URL must not produce a doubled path.
      expect(fetchMock.mock.calls[0][0]).toBe("https://langfuse.internal/api/public/ingestion");
      expect(fetchMock.mock.calls[0][1].headers?.Authorization).toBe(
        `Basic ${Buffer.from("pk-env:sk-env").toString("base64")}`,
      );
      await host.dispose();
    } finally {
      for (const [key, value] of [
        ["LANGFUSE_PUBLIC_KEY", saved.pub],
        ["LANGFUSE_SECRET_KEY", saved.sec],
        ["LANGFUSE_BASE_URL", saved.base],
      ] as const) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });

  it("buffers until flushAt and then sends one batch", async () => {
    const fetchMock = stubFetch(async () => okResponse());
    const { host, run } = harness([langfuseTracing({ ...langfuseKeys, flushAt: 3, flushIntervalMs: 0 })]);
    await host.setup({ model: null });

    await run.runGate("sessionStart", { messages: [], resumed: false });
    expect(fetchMock).not.toHaveBeenCalled();

    await run.runGate("postModelCall", modelInput());
    expect(fetchMock).not.toHaveBeenCalled();

    await run.runGate("postModelCall", modelInput({ iteration: 2 }));
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const body = JSON.parse(fetchMock.mock.calls[0][1].body!);
    expect(body.batch).toHaveLength(3);
    expect(body.batch.map((item: { type: string }) => item.type)).toEqual([
      "trace-create",
      "generation-create",
      "generation-create",
    ]);
    await host.dispose();
  });

  it("authenticates with HTTP Basic publicKey:secretKey", async () => {
    const fetchMock = stubFetch(async () => okResponse());
    const { host, run } = harness([langfuseTracing({ ...langfuseKeys, flushAt: 1, flushIntervalMs: 0 })]);
    await host.setup({ model: null });
    await run.runGate("sessionStart", { messages: [], resumed: false });

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://cloud.langfuse.com/api/public/ingestion");
    expect(init.method).toBe("POST");
    expect(init.headers?.["content-type"]).toBe("application/json");
    expect(init.headers?.Authorization).toBe(`Basic ${Buffer.from("pk-test:sk-test").toString("base64")}`);
    await host.dispose();
  });

  it("applies the declared usage basis like the OTLP export: a hand-built Anthropic-style message folds the cache in, an adapter message does not", async () => {
    const fetchMock = stubFetch(async () => okResponse());
    const { host, run } = harness([langfuseTracing({ ...langfuseKeys, flushAt: 1, flushIntervalMs: 0 })]);
    await host.setup({ model: null });
    const exclusive = { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30, prompt_tokens_details: { cached_tokens: 90, cache_write_tokens: 5 } };

    const declared = attachWireInfo({ role: "assistant", content: "hi" }, { provider: "anthropic" });
    await run.runGate("postModelCall", modelInput({ message: declared, usage: exclusive }));
    // The adapter converts first and declares no basis: its usage is already inclusive.
    const converted = attachWireInfo({ role: "assistant", content: "hi" }, { provider: "anthropic", usageBasis: {} });
    await run.runGate("postModelCall", modelInput({ message: converted, usage: { ...exclusive, prompt_tokens: 105, total_tokens: 125 } }));

    const [first, second] = batchItems(fetchMock);
    expect(first.body.usage).toMatchObject({ input: 105, output: 20, total: 125 });
    expect(second.body.usage).toMatchObject({ input: 105, output: 20, total: 125 });
    await host.dispose();
  });

  it("records model, latency and usage on the generation", async () => {
    const fetchMock = stubFetch(async () => okResponse());
    const { host, run } = harness([langfuseTracing({ ...langfuseKeys, flushAt: 1, flushIntervalMs: 0 })]);
    await host.setup({ model: null });

    await run.runGate("postModelCall", modelInput({ message: { role: "assistant", content: "hi", model: "gpt-4o-mini" } }));

    const [generation] = batchItems(fetchMock);
    expect(generation.type).toBe("generation-create");
    expect(generation.body.model).toBe("gpt-4o-mini");
    expect(generation.body.usage).toMatchObject({ input: 10, output: 4, total: 14, unit: "TOKENS" });
    expect(generation.body.metadata.latencyMs).toBe(250);
    expect(new Date(generation.body.endTime).getTime() - new Date(generation.body.startTime).getTime()).toBe(250);
    await host.dispose();
  });

  it("pairs preToolUse and postToolUse into one span", async () => {
    const fetchMock = stubFetch(async () => okResponse());
    const { host, run } = harness([langfuseTracing({ ...langfuseKeys, flushAt: 2, flushIntervalMs: 0 })]);
    await host.setup({ model: null });

    await run.runGate("preToolUse", toolInput("read_file", "call_1"));
    await run.runGate("postToolUse", {
      toolName: "read_file",
      toolCallId: "call_1",
      args: {},
      output: "contents",
      durationMs: 12,
      executionId: "exec_1",
    });

    const items = batchItems(fetchMock);
    expect(items.map((item) => item.type)).toEqual(["span-create", "span-update"]);
    // Both halves must address the SAME observation, or the pair is two spans.
    expect(items[1].body.id).toBe(items[0].body.id);
    expect(items[1].body.output).toEqual({ status: "success" });
    expect(items[1].body.level).toBe("DEFAULT");
    await host.dispose();
  });

  it("closes a span for a tool call a later plugin denied", async () => {
    const fetchMock = stubFetch(async () => okResponse());
    const denyTool: AgentPlugin = {
      name: "deny-everything",
      // Above langfuse's 2, so the deny lands after the span was opened.
      priority: 15,
      mayRequireApproval: false,
      hooks: { preToolUse: () => ({ decision: "deny", reason: "not allowed" }) },
    };
    const { host, run } = harness([langfuseTracing({ ...langfuseKeys, flushIntervalMs: 0 }), denyTool], {
      toolHistory: [{ executionId: "e1", toolName: "shell", args: {}, output: null, tool_call_id: "call_9", status: "rejected" }],
    });
    await host.setup({ model: null });

    const gate = await run.runGate("preToolUse", toolInput("shell", "call_9"));
    expect(gate.decision).toBe("deny");

    await run.runObservers("sessionEnd", sessionEndInput());

    const items = batchItems(fetchMock);
    const opened = items.find((item) => item.type === "span-create");
    const closed = items.find((item) => item.type === "span-update");
    expect(opened?.body.name).toBe("tool:shell");
    // The whole point of exporting from a hook: a sink never sees this call.
    expect(closed?.body.id).toBe(opened?.body.id);
    expect(closed?.body.level).toBe("WARNING");
    expect(closed?.body.output).toEqual({ status: "rejected" });
    await host.dispose();
  });

  it("flushes everything still buffered at sessionEnd", async () => {
    const fetchMock = stubFetch(async () => okResponse());
    const { host, run } = harness([langfuseTracing({ ...langfuseKeys, flushAt: 100, flushIntervalMs: 0 })], {
      usage: { perRequest: [], totals: { "gpt-4o": { input: 10, output: 4, total: 14 } } } as never,
    });
    await host.setup({ model: null });

    await run.runGate("sessionStart", { messages: [], resumed: false });
    await run.runGate("postModelCall", modelInput());
    expect(fetchMock).not.toHaveBeenCalled();

    await run.runObservers("sessionEnd", sessionEndInput());

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const items = batchItems(fetchMock);
    const closing = items.at(-1)!;
    expect(closing.type).toBe("trace-create");
    expect(closing.body.output).toEqual({ status: "success" });
    expect(closing.body.metadata.tokens).toEqual({ input: 10, output: 4, total: 14 });
    await host.dispose();
  });

  it("leaves sub-agent calls out of the trace's token total: each child reports its own trace", async () => {
    const fetchMock = stubFetch(async () => okResponse());
    const entry = (id: string, subagent?: object) => ({
      id, modelName: "gpt-4o", usage: { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 }, timestamp: "t", turn: 1, ...(subagent ? { subagent } : {}),
    });
    const { host, run } = harness([langfuseTracing({ ...langfuseKeys, flushAt: 100, flushIntervalMs: 0 })], {
      usage: {
        perRequest: [entry("own"), entry("child", { name: "c", id: "sa_1", mode: "registry" })],
        totals: { "gpt-4o": { input: 20, output: 8, total: 28, cachedInput: 0 } },
      } as never,
    });
    await host.setup({ model: null });
    await run.runGate("sessionStart", { messages: [], resumed: false });
    await run.runObservers("sessionEnd", sessionEndInput());
    expect(batchItems(fetchMock).at(-1)!.body.metadata.tokens).toEqual({ input: 10, output: 4, total: 14 });
    await host.dispose();
  });

  it("swallows a failing POST instead of failing the run", async () => {
    const fetchMock = stubFetch(async () => {
      throw new Error("langfuse is down");
    });
    const { host, run } = harness([langfuseTracing({ ...langfuseKeys, flushAt: 1, flushIntervalMs: 0 })]);
    await host.setup({ model: null });

    const gate = await run.runGate("sessionStart", { messages: [], resumed: false });
    await expect(run.runObservers("sessionEnd", sessionEndInput())).resolves.toBeUndefined();

    expect(gate.decision).toBe("allow");
    expect(fetchMock).toHaveBeenCalled();
    await host.dispose();
  });

  it("swallows a non-2xx ingestion response", async () => {
    const fetchMock = stubFetch(async () => errorResponse(401, "invalid credentials"));
    const { host, run } = harness([langfuseTracing({ ...langfuseKeys, flushAt: 1, flushIntervalMs: 0 })]);
    await host.setup({ model: null });

    await expect(run.runGate("sessionStart", { messages: [], resumed: false })).resolves.toMatchObject({
      decision: "allow",
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await host.dispose();
  });

  it("flushes the buffer on dispose", async () => {
    const fetchMock = stubFetch(async () => okResponse());
    const { host, run } = harness([langfuseTracing({ ...langfuseKeys, flushAt: 100, flushIntervalMs: 0 })]);
    await host.setup({ model: null });

    await run.runGate("sessionStart", { messages: [], resumed: false });
    expect(fetchMock).not.toHaveBeenCalled();

    await host.dispose();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(batchItems(fetchMock)).toHaveLength(1);
  });

  it("sends nothing when the buffer is already empty", async () => {
    const fetchMock = stubFetch(async () => okResponse());
    const { host } = harness([langfuseTracing({ ...langfuseKeys, flushIntervalMs: 0 })]);
    await host.setup({ model: null });
    await host.dispose();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("hands the whole wire body to an overriding buildPayload", async () => {
    const fetchMock = stubFetch(async () => okResponse());
    const buildPayload = vi.fn((events: Array<{ kind: string }>) => ({ mine: events.map((e) => e.kind) }));
    const { host, run } = harness([
      langfuseTracing({ ...langfuseKeys, flushAt: 1, flushIntervalMs: 0, buildPayload, release: "v9" }),
    ]);
    await host.setup({ model: null });

    await run.runGate("sessionStart", { messages: [], resumed: false });

    expect(JSON.parse(fetchMock.mock.calls[0][1].body!)).toEqual({ mine: ["trace-start"] });
    expect(buildPayload.mock.calls[0][1]).toMatchObject({ release: "v9", publicKey: "pk-test" });
    await host.dispose();
  });
});

// ─── otelTracing ─────────────────────────────────────────────────────────────

/**
 * A traced run, finalized the way the SDK finalizes one: the plugin's exporter
 * is handed to the session and `finalizeTraceSession` runs it. The plugin itself
 * sends nothing, so this is where the POST happens.
 */
async function finalizedSession(
  plugin: AgentPlugin,
  opts: { status?: "paused" | "success" | "error"; cancelled?: boolean; parentScope?: boolean } = {},
): Promise<TraceSessionRuntime> {
  const session = createTraceSession(
    { tracing: { enabled: true, sink: customSink(() => {}) } } as never,
    undefined,
    { exporters: plugin.traceExporters },
  )!;
  recordTraceEvent(session, { type: "ai_call", label: "Assistant Response", model: "gpt-4o", durationMs: 120, inputTokens: 10, outputTokens: 4, totalTokens: 14 });
  await finalizeTraceSession(session, { agentRuntime: { name: "test-agent" } as never, status: opts.status ?? "success", cancelled: opts.cancelled });
  return session;
}

describe("otelTracing", () => {
  it("rejects an empty endpoint at construction", () => {
    expect(() => otelTracing({ endpoint: "  " })).toThrow(/non-empty `endpoint`/);
  });

  it("rejects a missing endpoint when the environment names none", () => {
    expect(() => otelTracing({})).toThrow(/non-empty `endpoint`/);
  });

  it("contributes an exporter and no hook that sends", () => {
    const plugin = otelTracing({ endpoint: "https://collector.example.com/v1/traces" });
    expect(plugin.traceExporters).toHaveLength(1);
    expect(plugin.traceExporters![0].endpoint).toBe("https://collector.example.com/v1/traces");
    expect(plugin.name).toBe("otel-tracing");
    expect(plugin.priority).toBe(950);
    expect(plugin.failureMode).toBe("open");
  });

  it("posts an OTLP body with the configured headers when the session is finalized", async () => {
    const fetchMock = stubFetch(async () => okResponse());
    const plugin = otelTracing({ endpoint: "https://collector.example.com/v1/traces", headers: { "x-api-key": "k" }, serviceName: "billing-agent" });
    const session = await finalizedSession(plugin);
    const withSession = harness([plugin], { ctx: { __traceSession: session } });
    await withSession.host.setup({ model: null });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://collector.example.com/v1/traces");
    expect(init.headers?.["x-api-key"]).toBe("k");
    expect(init.headers?.["content-type"]).toBe("application/json");

    const body = JSON.parse(init.body as string);
    const spans = body.resourceSpans[0].scopeSpans[0].spans;
    // Root span plus one child per trace event.
    expect(spans).toHaveLength(2);
    const names = spans.map((span: { name: string }) => span.name);
    // The root is `invoke_agent <agent>` (serviceName only sets the resource), the call `chat <model>`.
    expect(names).toContain("invoke_agent test-agent");
    expect(names).toContain("chat gpt-4o");
    const chat = spans.find((span: { name: string }) => span.name === "chat gpt-4o");
    expect(chat.attributes.find((a: { key: string }) => a.key === "cognipeer.event.label").value.stringValue).toBe("Assistant Response #1");
    const serviceName = body.resourceSpans[0].resource.attributes.find((attr: { key: string }) => attr.key === "service.name");
    expect(serviceName.value.stringValue).toBe("billing-agent");

    await withSession.run.runObservers("sessionEnd", sessionEndInput());
    expect(metadataEvents(withSession.events)[0]).toMatchObject({
      otelTracing: { exported: true, endpoint: "https://collector.example.com/v1/traces", spans: 2, terminal: true },
    });
    await withSession.host.dispose();
  });

  it("exports a cancelled run's root as partial", async () => {
    const fetchMock = stubFetch(async () => okResponse());
    const plugin = otelTracing({ endpoint: "https://collector.example.com/v1/traces" });
    await finalizedSession(plugin, { cancelled: true });

    const body = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    const root = body.resourceSpans[0].scopeSpans[0].spans.find((span: { parentSpanId: string }) => !span.parentSpanId);
    const status = root.attributes.find((attr: { key: string }) => attr.key === "cognipeer.session.status");
    expect(status.value.stringValue).toBe("partial");
  });

  it("a paused leg exports its own spans without a root", async () => {
    const fetchMock = stubFetch(async () => okResponse());
    const plugin = otelTracing({ endpoint: "https://collector.example.com/v1/traces" });
    const session = await finalizedSession(plugin, { status: "paused" });

    const spans = JSON.parse(fetchMock.mock.calls[0][1].body as string).resourceSpans[0].scopeSpans[0].spans;
    expect(spans.map((span: { name: string }) => span.name)).toEqual(["chat gpt-4o"]);
    expect(session.exportReports?.[0]).toMatchObject({ terminal: false, result: { ok: true, spans: 1 } });
  });

  it("warns instead of silently no-opping when tracing is not enabled", async () => {
    const fetchMock = stubFetch(async () => okResponse());
    const { host, run, events } = harness([otelTracing({ endpoint: "https://collector.example.com/v1/traces" })]);
    await host.setup({ model: null });

    await run.runObservers("sessionEnd", sessionEndInput());

    expect(fetchMock).not.toHaveBeenCalled();
    const [warning] = metadataEvents(events);
    expect(warning).toBeDefined();
    expect((warning.otelTracing as { exported: boolean; reason: string }).exported).toBe(false);
    expect((warning.otelTracing as { reason: string }).reason).toMatch(/tracing: \{ enabled: true \}/);
  });

  it("swallows a failing POST instead of failing the run", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const fetchMock = stubFetch(async () => {
      throw new Error("collector unreachable");
    });
    const plugin = otelTracing({ endpoint: "https://collector.example.com/v1/traces", retry: false });
    const session = await finalizedSession(plugin);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(session.exportReports?.[0].result).toMatchObject({ ok: false, error: "collector unreachable" });

    const { host, run, events } = harness([plugin], { ctx: { __traceSession: session } });
    await host.setup({ model: null });
    await expect(run.runObservers("sessionEnd", sessionEndInput())).resolves.toBeUndefined();
    // No "exported: true" event, and no error escaped either.
    expect(metadataEvents(events)).toHaveLength(0);
  });

  it("swallows a non-2xx collector response (a 400 is final, not retried)", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const fetchMock = stubFetch(async () => errorResponse(400, "bad"));
    const plugin = otelTracing({ endpoint: "https://collector.example.com/v1/traces" });
    const session = await finalizedSession(plugin);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const { host, run, events } = harness([plugin], { ctx: { __traceSession: session } });
    await host.setup({ model: null });
    await expect(run.runObservers("sessionEnd", sessionEndInput())).resolves.toBeUndefined();
    expect(metadataEvents(events)).toHaveLength(0);
  });

  it("a sub-agent run that inherited the plugin does not report or export the parent's session", async () => {
    const fetchMock = stubFetch(async () => okResponse());
    const plugin = otelTracing({ endpoint: "https://collector.example.com/v1/traces" });
    // A parent that WAS exported: its exportReports hold this plugin's report, which
    // is exactly what the observer would announce if it forgot the child is not a root.
    const parent = await finalizedSession(plugin);
    expect(parent.exportReports?.some((report) => report.exporter === "otel-tracing" && report.result.ok)).toBe(true);
    fetchMock.mockClear();
    const scope = createSubagentTraceScope(parent, { agentSpanId: "abcdabcdabcdabcd", name: "helper" });

    const root = harness([plugin], { ctx: { __traceSession: parent } });
    await root.host.setup({ model: null });
    await root.run.runObservers("sessionEnd", sessionEndInput());
    // Control: the root session is reported.
    expect(metadataEvents(root.events)).toHaveLength(1);

    const child = harness([plugin], { ctx: { __traceSession: scope } });
    await child.host.setup({ model: null });

    await child.run.runObservers("sessionEnd", sessionEndInput());

    expect(fetchMock).not.toHaveBeenCalled();
    expect(metadataEvents(child.events)).toHaveLength(0);
  });

  it("a collector that refuses some spans of a 200 is reported: rejected count and message in the metadata event", async () => {
    stubFetch(async () => ({ ok: true, status: 200, statusText: "OK", text: async () => JSON.stringify({ partialSuccess: { rejectedSpans: 2, errorMessage: "bad span" } }), headers: { get: () => null } }));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const plugin = otelTracing({ endpoint: "https://collector.example.com/v1/traces" });
    const session = await finalizedSession(plugin);
    // The finalizer warns once per export, since nothing else would say so.
    expect(warn.mock.calls.some((call) => /rejected 2 span\(s\): bad span/.test(String(call[0])))).toBe(true);

    const { host, run, events } = harness([plugin], { ctx: { __traceSession: session } });
    await host.setup({ model: null });
    await run.runObservers("sessionEnd", sessionEndInput());
    expect(metadataEvents(events)[0].otelTracing).toMatchObject({ exported: true, rejectedSpans: 2, rejectionMessage: "bad span" });
  });
});
