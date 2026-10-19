/**
 * W3C trace context end to end: a caller's traceparent becomes the root's remote
 * parent, rides the continuation across a pause, can switch the OTLP export off
 * (sampled=0) without touching the other sinks, and reaches tools.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { createAgent, createSmartAgent, createTool, otlpSink, traceparentOf } from "../../../src/index.js";
import { customSink, readTraceContinuation } from "../../../src/utils/tracing.js";
import { captureSnapshot, restoreSnapshot } from "../../../src/utils/stateSnapshot.js";
import { resetOtlpWarnings } from "../../../src/utils/otlp/env.js";
import type { Message, TraceSessionFile } from "../../../src/types.js";
import { attrsOf, okResponse, spansOf } from "./helpers.js";

const TRACE = "0af7651916cd43dd8448eb211c80319c";
const PARENT = "b7ad6b7169203331";
const header = (flags = "01") => `00-${TRACE}-${PARENT}-${flags}`;

beforeEach(() => resetOtlpWarnings());
afterEach(() => {
  vi.restoreAllMocks();
});

const call = (id: string, name: string) => ({ id, type: "function", function: { name, arguments: "{}" } });

function scripted(name: string, script: Array<Partial<Message> & Record<string, any>>) {
  let turn = 0;
  const model: any = {
    modelName: name,
    bindTools() { return model; },
    async invoke() {
      return { role: "assistant", content: "", ...script[Math.min(turn++, script.length - 1)] };
    },
  };
  return model;
}

function collector() {
  const bodies: any[] = [];
  const fetch = vi.fn(async (_url: string, init: any) => {
    bodies.push(JSON.parse(init.body));
    return okResponse();
  });
  return { bodies, fetch };
}

const go = { messages: [{ role: "user", content: "go" }] } as any;
const echo = () => createTool({ name: "echo", description: "echoes", schema: z.object({}), func: async () => "echoed" });
const dangerous = () => createTool({ name: "dangerous", description: "needs approval", schema: z.object({}), needsApproval: true, func: async () => "executed" });
const roundTrip = (state: any) => restoreSnapshot(JSON.parse(JSON.stringify(captureSnapshot(state)))) as any;
const rootOf = (bodies: any[]) => bodies.flatMap(spansOf).find((s) => s.name.startsWith("invoke_agent"));

describe("the caller's traceparent", () => {
  it("TracingConfig.parent: the run joins the trace and the root hangs from the caller's span", async () => {
    const { bodies, fetch } = collector();
    await createAgent({
      name: "A",
      model: scripted("m", [{ tool_calls: [call("t1", "echo")] }, { content: "ok" }]),
      tools: [echo()],
      tracing: {
        enabled: true,
        parent: { traceparent: header(), tracestate: "vendor=x" },
        sink: otlpSink({ endpoint: "https://c.example.test/v1/traces", fetch }),
      },
    }).invoke(go);
    const spans = spansOf(bodies[0]);
    expect(spans.every((s) => s.traceId === TRACE)).toBe(true);
    expect(spans[0]).toMatchObject({ parentSpanId: PARENT, flags: 769 });
    expect(spans.slice(1).every((s) => s.flags === 257)).toBe(true);
    expect(spans.every((s) => s.traceState === "vendor=x")).toBe(true);
    // The root keeps its own span id; only its parent is the caller's.
    expect(spans[0].spanId).not.toBe(PARENT);
  });

  it("InvokeConfig.traceParent is per request and wins over the configured parent", async () => {
    const { bodies, fetch } = collector();
    const other = `00-${"c".repeat(32)}-${"d".repeat(16)}-01`;
    await createAgent({
      name: "A",
      model: scripted("m", [{ content: "ok" }]),
      tracing: { enabled: true, parent: header(), sink: otlpSink({ endpoint: "https://c.example.test/v1/traces", fetch }) },
    }).invoke(go, { traceParent: other });
    expect(rootOf(bodies)).toMatchObject({ traceId: "c".repeat(32), parentSpanId: "d".repeat(16) });
  });

  it("without any parent the root is local: no parent, flags 257", async () => {
    const { bodies, fetch } = collector();
    await createAgent({
      name: "A",
      model: scripted("m", [{ content: "ok" }]),
      tracing: { enabled: true, sink: otlpSink({ endpoint: "https://c.example.test/v1/traces", fetch }) },
    }).invoke(go);
    expect(rootOf(bodies)).toMatchObject({ parentSpanId: "", flags: 257 });
  });

  it("the incoming trace-flags byte is carried unchanged, not rewritten to 01", async () => {
    const { bodies, fetch } = collector();
    await createAgent({
      name: "A",
      model: scripted("m", [{ content: "ok" }]),
      tracing: { enabled: true, parent: header("03"), sink: otlpSink({ endpoint: "https://c.example.test/v1/traces", fetch }) },
    }).invoke(go);
    const spans = spansOf(bodies[0]);
    expect(spans[0].flags).toBe(0x103 | 0x200);
    expect(spans.slice(1).every((s) => s.flags === 0x103)).toBe(true);
  });

  it("a malformed value is ignored with exactly one warning and the run starts its own trace", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { bodies, fetch } = collector();
    const agent = createAgent({
      name: "A",
      model: scripted("m", [{ content: "ok" }]),
      tracing: { enabled: true, sink: otlpSink({ endpoint: "https://c.example.test/v1/traces", fetch }) },
    });
    await agent.invoke(go, { traceParent: "not-a-traceparent" });
    await agent.invoke(go, { traceParent: "still-not" });
    expect(warn.mock.calls.filter(([m]) => String(m).includes("traceparent"))).toHaveLength(1);
    expect(rootOf(bodies)).toMatchObject({ parentSpanId: "", flags: 257 });
    expect(rootOf(bodies)!.traceId).not.toBe(TRACE);
  });
});

describe("sampled=0", () => {
  it("makes no OTLP request, and the other sinks still record the run", async () => {
    const { fetch } = collector();
    const sessions: TraceSessionFile[] = [];
    const result = await createAgent({
      name: "A",
      model: scripted("m", [{ content: "ok" }]),
      plugins: [{ name: "p", traceExporters: [(await import("../../../src/index.js")).createOtlpExporter({ endpoint: "https://x/v1/traces", fetch })] }],
      tracing: { enabled: true, parent: header("00"), sink: customSink({ onSession: (s) => { sessions.push(s); } }) },
    }).invoke(go);
    expect(result.content).toBe("ok");
    expect(fetch).not.toHaveBeenCalled();
    expect(sessions).toHaveLength(1);
    expect(sessions[0].events.length).toBeGreaterThan(0);
    // It still joined the caller's trace, so the file and the caller's logs line up.
    expect(sessions[0].traceId).toBe(TRACE);
  });

  it("the otlp sink is skipped too, without failing the session", async () => {
    const { fetch } = collector();
    const agent = createAgent({
      name: "A",
      model: scripted("m", [{ content: "ok" }]),
      tracing: { enabled: true, sink: otlpSink({ endpoint: "https://c.example.test/v1/traces", fetch }) },
    });
    const result = await agent.invoke(go, { traceParent: header("00") });
    expect(result.content).toBe("ok");
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe("across a pause", () => {
  function pausing(fetch: any, extraTracing: Record<string, unknown> = {}) {
    return createSmartAgent({
      name: "Pauser",
      model: scripted("m", [{ tool_calls: [call("d1", "dangerous")] }, { content: "all done" }]),
      tools: [dangerous()],
      summarization: false,
      tracing: { enabled: true, sink: otlpSink({ endpoint: "https://c.example.test/v1/traces", fetch, headers: { authorization: "Bearer SECRET-TOKEN" } }), ...extraTracing },
    } as any);
  }
  const resume = async (agent: any, paused: any, config?: Record<string, unknown>) => {
    const state = roundTrip(paused.state);
    const pending = state.pendingApprovals.find((x: any) => x.status === "pending");
    return agent.invoke(agent.resolveToolApproval(state, { id: pending.id, approved: true, decidedBy: "ops" }) as any, config);
  };

  it("the continuation keeps the parent: the resume exports the root under it although it passes none", async () => {
    const { bodies, fetch } = collector();
    const agent = pausing(fetch);
    const paused: any = await agent.invoke(go, { traceParent: { traceparent: header("01"), tracestate: "vendor=x" } });
    await resume(agent, paused);
    const root = rootOf(bodies)!;
    expect(root).toMatchObject({ traceId: TRACE, parentSpanId: PARENT, flags: 769, traceState: "vendor=x" });
    expect(bodies.flatMap(spansOf).filter((s) => s.name.startsWith("invoke_agent"))).toHaveLength(1);
  });

  it("a different parent passed on the resume does not move a trace that is already out", async () => {
    const { bodies, fetch } = collector();
    const agent = pausing(fetch);
    const paused: any = await agent.invoke(go, { traceParent: header() });
    await resume(agent, paused, { traceParent: `00-${"e".repeat(32)}-${"f".repeat(16)}-01` });
    const spans = bodies.flatMap(spansOf);
    expect(new Set(spans.map((s) => s.traceId))).toEqual(new Set([TRACE]));
    expect(rootOf(bodies)).toMatchObject({ parentSpanId: PARENT });
  });

  it("sampled=0 on the first leg holds for the leg that resumes", async () => {
    const { fetch } = collector();
    const agent = pausing(fetch);
    const paused: any = await agent.invoke(go, { traceParent: header("00") });
    await resume(agent, paused);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("the persisted continuation holds the parent as plain data and never an auth header", async () => {
    const { fetch } = collector();
    const agent = pausing(fetch);
    const paused: any = await agent.invoke(go, { traceParent: { traceparent: header(), tracestate: "vendor=x" } });
    const continuation = paused.state.ctx.__traceContinuation;
    expect(readTraceContinuation(continuation)?.parent).toEqual({ spanId: PARENT, flags: 1, traceState: "vendor=x" });
    const persisted = JSON.stringify(captureSnapshot(paused.state));
    expect(persisted).not.toContain("SECRET-TOKEN");
    expect(persisted).not.toMatch(/authorization/i);
    // The traceId is the continuation's own: the parent record repeats nothing of it.
    expect(continuation.parent).not.toHaveProperty("traceId");
  });

  it("garbage in a persisted continuation's parent is dropped, not trusted", () => {
    const base = { v: 1, sessionId: "s", nextSequence: 3, startedAt: 1, part: 1, traceId: TRACE };
    expect(readTraceContinuation({ ...base, parent: { spanId: "zz", flags: 1 } })).not.toHaveProperty("parent");
    expect(readTraceContinuation({ ...base, parent: "x" })).not.toHaveProperty("parent");
    expect(readTraceContinuation({ ...base, parent: { spanId: PARENT, flags: 1 } })?.parent).toEqual({ spanId: PARENT, flags: 1 });
  });
});

describe("tools", () => {
  it("get the trace id and a parent span id: traceparentOf(ctx) names the tool call's span in the run's trace", async () => {
    let seen: any;
    const probe = createTool({ name: "probe", description: "d", schema: z.object({}), func: async (_a, ctx) => { seen = ctx; return "ok"; } });
    const sessions: TraceSessionFile[] = [];
    await createAgent({
      name: "A",
      model: scripted("m", [{ tool_calls: [call("t1", "probe")] }, { content: "ok" }]),
      tools: [probe],
      tracing: { enabled: true, sink: customSink({ onSession: (s) => { sessions.push(s); } }) },
    }).invoke(go);
    const toolSpan = sessions[0].events.find((e) => e.type === "tool_call")!.spanId;
    expect(seen.traceId).toBe(sessions[0].traceId);
    expect(seen.traceSpanId).toBe(toolSpan);
    expect(traceparentOf(seen)).toBe(`00-${sessions[0].traceId}-${toolSpan}-01`);
  });

  it("an upstream flags byte is passed on to what the tool calls", async () => {
    let seen: any;
    const probe = createTool({ name: "probe", description: "d", schema: z.object({}), func: async (_a, ctx) => { seen = ctx; return "ok"; } });
    await createAgent({
      name: "A",
      model: scripted("m", [{ tool_calls: [call("t1", "probe")] }, { content: "ok" }]),
      tools: [probe],
      tracing: { enabled: true, parent: header("03"), sink: customSink({}) },
    }).invoke(go);
    expect(traceparentOf(seen)).toBe(`00-${TRACE}-${seen.traceSpanId}-03`);
  });

  it("an untraced run has nothing to propagate", async () => {
    let seen: any;
    const probe = createTool({ name: "probe", description: "d", schema: z.object({}), func: async (_a, ctx) => { seen = ctx; return "ok"; } });
    await createAgent({ name: "A", model: scripted("m", [{ tool_calls: [call("t1", "probe")] }, { content: "ok" }]), tools: [probe] }).invoke(go);
    expect(traceparentOf(seen)).toBeUndefined();
  });
});
