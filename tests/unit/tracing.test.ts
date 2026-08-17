import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { createAgent, createTool } from "../../src/index.js";
import { createTraceSession, customSink, finalizeTraceSession, sanitizeTracePayload, startStreamingSession } from "../../src/utils/tracing.js";
import type { AgentRuntimeConfig, Message, SmartAgentOptions, TracingConfig } from "../../src/types.js";

function makeAgentOptions(tracing: TracingConfig): SmartAgentOptions {
  return {
    model: { id: "test-model", provider: "test-provider" },
    tracing,
  };
}

function makeRuntime(): AgentRuntimeConfig {
  return {
    model: { id: "test-model", provider: "test-provider" },
    tools: [],
    name: "trace-unit-agent",
    version: "1.0.0",
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

const okResponse = () => ({
  ok: true,
  status: 200,
  statusText: "OK",
  text: async () => "",
  headers: { get: () => null },
});

const httpTracing = (extra: Partial<TracingConfig> = {}): TracingConfig => ({
  enabled: true,
  mode: "streaming",
  sink: { type: "http", url: "https://trace.example.test/sessions" },
  ...extra,
});

describe("tracing degraded session handling", () => {
  it("degrades to a batched upload when streaming start keeps failing after retries", async () => {
    // /start fails on every attempt; the batched /sessions upload succeeds.
    const fetchMock = vi.fn(async (url: any) => {
      const u = String(url);
      if (u.includes("/stream/") && u.endsWith("/start")) {
        throw new Error("stream start offline");
      }
      return okResponse();
    });

    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);

    const session = createTraceSession(makeAgentOptions(httpTracing()));
    expect(session).toBeDefined();

    await startStreamingSession(session, makeRuntime());

    expect(session?.sessionStarted).toBe(false);
    expect(session?.errors.some((error) => error.type === "sink")).toBe(true);

    const result = await finalizeTraceSession(session, { agentRuntime: makeRuntime() });

    expect(result?.status).toBe("partial");
    // Start was retried the full budget before giving up…
    const startCalls = fetchMock.mock.calls.filter((c) => String(c[0]).endsWith("/start"));
    expect(startCalls.length).toBe(4);
    // …then finalize fell back to the batched full-session upload.
    expect(fetchMock.mock.calls.some((c) => String(c[0]) === "https://trace.example.test/sessions")).toBe(true);
  });

  it("recovers a transient streaming start failure via retry (no degradation)", async () => {
    const fetchMock = vi.fn()
      .mockRejectedValueOnce(new Error("stream start offline"))
      .mockResolvedValue(okResponse());

    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);

    const session = createTraceSession(makeAgentOptions(httpTracing()));
    await startStreamingSession(session, makeRuntime());

    expect(session?.sessionStarted).toBe(true);
    expect(session?.errors.some((error) => error.type === "sink")).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(2); // 1 fail + 1 success
  });
});

describe("tracing caller-supplied identifiers", () => {
  it("uses a caller-supplied sessionId instead of generating one", () => {
    const session = createTraceSession(makeAgentOptions(httpTracing({ sessionId: "task-run-123" })));
    expect(session?.sessionId).toBe("task-run-123");
  });

  it("generates a sess_ sessionId when none is supplied", () => {
    const session = createTraceSession(makeAgentOptions(httpTracing()));
    expect(session?.sessionId).toMatch(/^sess_/);
  });

  it("applies the agentName override in the start payload", async () => {
    const fetchMock = vi.fn(async () => okResponse());
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);

    const session = createTraceSession(makeAgentOptions(httpTracing({ agentName: "Pulse Worker Agent" })));
    await startStreamingSession(session, makeRuntime());

    const startCall = fetchMock.mock.calls.find((c) => String(c[0]).endsWith("/start"));
    expect(startCall).toBeDefined();
    const body = JSON.parse((startCall![1] as any).body as string);
    expect(body.agent.name).toBe("Pulse Worker Agent");
  });
});

describe("tool observability tracing", () => {
  it("emits tool details, arguments, and full result sections", async () => {
    const traceEvents: any[] = [];
    let turn = 0;
    const model = {
      modelName: "trace-model",
      bindTools() { return this; },
      async invoke(_messages: Message[]) {
        turn += 1;
        if (turn === 1) {
          return {
            role: "assistant",
            content: "",
            tool_calls: [{
              id: "call_lookup",
              type: "function",
              function: {
                name: "lookup_customer",
                arguments: JSON.stringify({ customerId: "cus_123" }),
              },
            }],
          };
        }
        return { role: "assistant", content: "done" };
      },
    } as any;
    const tool = createTool({
      name: "lookup_customer",
      description: "Fetch customer profile details",
      schema: z.object({ customerId: z.string() }),
      func: async ({ customerId }) => ({
        customerId,
        plan: "pro",
        items: [{ title: "Profile", snippet: "Active customer" }],
      }),
      cache: true,
      retry: { maxRetries: 2, backoffMs: 1 },
    });
    const agent = createAgent({
      model,
      tools: [tool],
      limits: { maxToolCalls: 3 },
      tracing: {
        enabled: true,
        logData: true,
        sink: customSink((event) => traceEvents.push(event)),
      },
    });

    await agent.invoke({ messages: [{ role: "user", content: "look it up" }] } as any);

    const toolEvent = traceEvents.find((event) => event.type === "tool_call" && event.actor?.name === "lookup_customer");
    expect(toolEvent).toBeDefined();
    expect(toolEvent.toolDetails).toEqual(expect.objectContaining({
      name: "lookup_customer",
      description: "Fetch customer profile details",
      cache: expect.objectContaining({ enabled: true }),
      retry: expect.objectContaining({ maxRetries: 2 }),
    }));
    expect(toolEvent.toolDetails.inputSchema).toEqual(expect.objectContaining({ definitions: expect.any(Object) }));

    const sections = toolEvent.data?.sections || [];
    expect(sections).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: "tool_call",
        tool: "lookup_customer",
        arguments: { customerId: "cus_123" },
        toolDetails: expect.objectContaining({ name: "lookup_customer" }),
      }),
      expect.objectContaining({
        kind: "tool_result",
        tool: "lookup_customer",
        output: expect.objectContaining({ customerId: "cus_123", plan: "pro" }),
        execution: expect.objectContaining({ status: "success" }),
        toolDetails: expect.objectContaining({ name: "lookup_customer" }),
      }),
    ]));
  });
});

describe("sanitizeTracePayload", () => {
  it("keeps undefined absent instead of turning it into the string \"undefined\"", () => {
    // JSON.stringify(undefined) returns the real `undefined`, and
    // JSON.parse(undefined) throws (its argument coerces to the string
    // "undefined" first) — the old catch-all fallback then did
    // String(undefined), handing callers the literal string "undefined"
    // instead of an absent value. A caller that spreads that string as a
    // record splits it into single-character indexed keys.
    expect(sanitizeTracePayload(undefined)).toBeUndefined();
  });

  it("still serializes real values, including ones that need the fallback path", () => {
    expect(sanitizeTracePayload({ a: 1 })).toEqual({ a: 1 });
    expect(sanitizeTracePayload("plain string")).toBe("plain string");
    expect(sanitizeTracePayload(null)).toBeNull();
  });
});