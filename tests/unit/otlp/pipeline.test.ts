/**
 * The export path inside finalizeTraceSession: the `otlp` sink and exporters a
 * plugin contributes share it. Real agents, scripted models, an injected fetch.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
  closeTraceContinuation,
  createAgent,
  createOtlpExporter,
  createSmartAgent,
  createTool,
  otlpSink,
  readTraceContinuation,
} from "../../../src/index.js";
import { createPluginHost } from "../../../src/plugins/index.js";
import type { AgentPlugin } from "../../../src/plugins/types.js";
import { createTraceSession, customSink, finalizeTraceSession, recordTraceEvent } from "../../../src/utils/tracing.js";
import { captureSnapshot, restoreSnapshot } from "../../../src/utils/stateSnapshot.js";
import type { Message, SubagentDef, TraceSessionFile } from "../../../src/types.js";
import { attrsOf, okResponse, spansOf } from "./helpers.js";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const call = (id: string, name: string, args: Record<string, unknown> = {}) => ({
  id, type: "function", function: { name, arguments: JSON.stringify(args) },
});

function scripted(name: string, script: Array<Partial<Message> & { usage?: unknown }>) {
  let turn = 0;
  const model: any = {
    modelName: name,
    bindTools() { return model; },
    async invoke() {
      const step = script[Math.min(turn++, script.length - 1)];
      return { role: "assistant", content: "", ...step };
    },
  };
  return model;
}

/** An injectable fetch that records every request body. */
function collector(endpointLabel = "collector") {
  const bodies: any[] = [];
  const fetch = vi.fn(async (_url: string, init: any) => {
    bodies.push(JSON.parse(init.body));
    return okResponse();
  });
  return { bodies, fetch, label: endpointLabel };
}

const allSpans = (bodies: any[]) => bodies.flatMap(spansOf);
const rootsOf = (bodies: any[]) => allSpans(bodies).filter((s) => s.parentSpanId === "" && s.name.startsWith("invoke_agent"));
const echo = () => createTool({ name: "echo", description: "echoes", schema: z.object({}), func: async () => "echoed" });
const dangerous = () => createTool({ name: "dangerous", description: "needs approval", schema: z.object({}), needsApproval: true, func: async () => "executed" });
const roundTrip = (state: any) => restoreSnapshot(JSON.parse(JSON.stringify(captureSnapshot(state)))) as any;

describe("otlp sink", () => {
  it("one run, one request: root first, GenAI spans, nothing but UNSET", async () => {
    const { bodies, fetch } = collector();
    const agent = createAgent({
      name: "Echoer",
      model: scripted("m", [{ tool_calls: [call("t1", "echo")] }, { content: "done" }]),
      tools: [echo()],
      tracing: { enabled: true, sink: otlpSink({ endpoint: "https://c.example.test/v1/traces", fetch }) },
    });
    await agent.invoke({ messages: [{ role: "user", content: "go" }] } as any);

    expect(bodies).toHaveLength(1);
    const spans = spansOf(bodies[0]);
    expect(spans[0].name).toBe("invoke_agent Echoer");
    expect(spans.map((s) => s.name)).toEqual(expect.arrayContaining(["chat m", "execute_tool echo"]));
    expect(spans.every((s) => s.status.code === 0)).toBe(true);
    const ids = new Set(spans.map((s) => s.spanId));
    for (const s of spans.slice(1)) expect(ids.has(s.parentSpanId), s.name).toBe(true);
    // Honest timing: nothing starts before the root or ends after it.
    for (const s of spans.slice(1)) {
      expect(BigInt(s.startTimeUnixNano) >= BigInt(spans[0].startTimeUnixNano)).toBe(true);
      expect(BigInt(s.endTimeUnixNano) <= BigInt(spans[0].endTimeUnixNano)).toBe(true);
    }
  });

  it("otlpSink(endpoint, headers) still posts the same headers through the shared exporter", async () => {
    const calls: any[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string, init: any) => {
      calls.push({ url, init });
      return okResponse();
    }));
    const agent = createAgent({
      name: "A",
      model: scripted("m", [{ content: "hi" }]),
      tracing: { enabled: true, sink: otlpSink("https://c.example.test/v1/traces", { authorization: "Bearer t" }) },
    });
    await agent.invoke({ messages: [{ role: "user", content: "go" }] } as any);
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("https://c.example.test/v1/traces");
    expect(calls[0].init.headers).toMatchObject({ authorization: "Bearer t", "content-type": "application/json" });
  });

  it("a failing sink fails the session's delivery: the file status is partial and a 'sink' error is recorded (as before)", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const fetch = vi.fn(async () => ({ ok: false, status: 400, statusText: "Bad Request", text: async () => "nope", headers: { get: () => null } }));
    const session = createTraceSession({
      tracing: { enabled: true, sink: otlpSink({ endpoint: "https://c.example.test/v1/traces", fetch }) },
    } as any)!;
    recordTraceEvent(session, { type: "ai_call", label: "Assistant Response", model: "m", durationMs: 5 });
    const file = await finalizeTraceSession(session, { agentRuntime: { name: "A" } as any });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(file?.status).toBe("partial");
    expect(file?.errors).toEqual([expect.objectContaining({ eventId: "sink", type: "sink", message: "HTTP 400 Bad Request - nope" })]);
    expect(session.exportReports).toEqual([
      expect.objectContaining({ sink: true, terminal: true, result: expect.objectContaining({ ok: false, status: 400 }) }),
    ]);
  });
});

describe("legs", () => {
  it("an approval pause exports leg 1 without a root; the resume exports the root once, over both", async () => {
    const { bodies, fetch } = collector();
    const agent = createSmartAgent({
      name: "Pauser",
      model: scripted("m", [{ tool_calls: [call("d1", "dangerous")] }, { content: "all done" }]),
      tools: [dangerous()],
      summarization: false,
      tracing: { enabled: true, sink: otlpSink({ endpoint: "https://c.example.test/v1/traces", fetch }) },
    } as any);
    const paused: any = await agent.invoke({ messages: [{ role: "user", content: "go" }] } as any);
    expect(bodies).toHaveLength(1);
    expect(rootsOf(bodies)).toHaveLength(0);
    const pendingSpans = spansOf(bodies[0]).filter((s) => attrsOf(s)["cognipeer.event.status"] === "pending");
    expect(pendingSpans.length).toBeGreaterThan(0);

    const state = roundTrip(paused.state);
    const pending = state.pendingApprovals.find((x: any) => x.status === "pending");
    await agent.invoke(agent.resolveToolApproval(state, { id: pending.id, approved: true, decidedBy: "ops" }) as any);

    expect(bodies).toHaveLength(2);
    const roots = rootsOf(bodies);
    expect(roots).toHaveLength(1);
    const keys = allSpans(bodies).map((s) => `${s.traceId}/${s.spanId}`);
    expect(new Set(keys).size).toBe(keys.length);
    // One trace, and every span of the first leg is inside the root's time range.
    expect(new Set(allSpans(bodies).map((s) => s.traceId)).size).toBe(1);
    for (const s of allSpans(bodies)) {
      expect(BigInt(s.startTimeUnixNano) >= BigInt(roots[0].startTimeUnixNano)).toBe(true);
      expect(BigInt(s.endTimeUnixNano) <= BigInt(roots[0].endTimeUnixNano)).toBe(true);
    }
    // Resolving the approval exports an approval span and, later, the executed tool.
    expect(allSpans(bodies).map((s) => s.name)).toContain("execute_tool dangerous");
  });

  it("a sub-agent that pauses and resumes is ONE invoke_agent span; every child's parent resolves in what was exported", async () => {
    const { bodies, fetch } = collector();
    const def: SubagentDef = {
      name: "once", header: "h",
      model: scripted("child", [{ tool_calls: [call("c1", "dangerous")] }, { content: "final" }]),
      tools: [dangerous()],
    };
    const parent = createSmartAgent({
      name: "parent",
      model: scripted("parent", [{ tool_calls: [call("p1", "delegate_to", { subagent: "once", input: "go" })] }, { content: "parent-done" }]),
      subagents: [def], summarization: false,
      tracing: { enabled: true, sink: otlpSink({ endpoint: "https://c.example.test/v1/traces", fetch }) },
    } as any);
    const paused: any = await parent.invoke({ messages: [{ role: "user", content: "go" }] } as any);
    // Leg 1: the agent span is pending, so it is withheld; its children are exported.
    expect(allSpans(bodies).filter((s) => s.name === "invoke_agent once")).toHaveLength(0);

    const state = roundTrip(paused.state);
    const pending = state.pendingApprovals.find((x: any) => x.status === "pending");
    await parent.invoke(parent.resolveToolApproval(state, { id: pending.id, approved: true, decidedBy: "ops" }) as any);

    const agentSpans = allSpans(bodies).filter((s) => s.name === "invoke_agent once");
    expect(agentSpans).toHaveLength(1);
    const exported = new Set(allSpans(bodies).map((s) => s.spanId));
    const root = rootsOf(bodies)[0];
    for (const s of allSpans(bodies)) {
      if (s === root) continue;
      expect(exported.has(s.parentSpanId), `${s.name} -> ${s.parentSpanId}`).toBe(true);
    }
    const children = allSpans(bodies).filter((s) => s.parentSpanId === agentSpans[0].spanId);
    expect(children.length).toBeGreaterThanOrEqual(2);
    for (const child of children) {
      expect(BigInt(child.startTimeUnixNano) >= BigInt(agentSpans[0].startTimeUnixNano), child.name).toBe(true);
      expect(BigInt(child.endTimeUnixNano) <= BigInt(agentSpans[0].endTimeUnixNano), child.name).toBe(true);
    }
  });
});

describe("plugin-contributed exporters", () => {
  it("run next to the sink: both receive the run, the plugin's exporter gets the same root", async () => {
    const sinkSide = collector();
    const pluginSide = collector();
    const plugin: AgentPlugin = {
      name: "collector-plugin",
      traceExporters: [createOtlpExporter({ endpoint: "https://plugin.example.test/v1/traces", fetch: pluginSide.fetch, name: "plugin-otlp" })],
    };
    const agent = createAgent({
      name: "Both",
      model: scripted("m", [{ content: "hi" }]),
      plugins: [plugin],
      tracing: { enabled: true, sink: otlpSink({ endpoint: "https://sink.example.test/v1/traces", fetch: sinkSide.fetch }) },
    });
    await agent.invoke({ messages: [{ role: "user", content: "go" }] } as any);
    expect(sinkSide.bodies).toHaveLength(1);
    expect(pluginSide.bodies).toHaveLength(1);
    expect(rootsOf(pluginSide.bodies)[0].spanId).toBe(rootsOf(sinkSide.bodies)[0].spanId);
  });

  it("the plugin host collects traceExporters in plugin priority order", async () => {
    const make = (name: string, priority: number): AgentPlugin => ({
      name, priority, traceExporters: [createOtlpExporter({ endpoint: "https://x/v1/traces", name })],
    });
    const host = createPluginHost([make("late", 200), make("early", 10)]);
    await host.setup({ model: null });
    expect(host.contributions.traceExporters.map((e) => e.name)).toEqual(["early", "late"]);
  });

  it("a plugin exporter works without an otlp sink (the file sink is untouched) and a failing one never changes the result", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const sessions: TraceSessionFile[] = [];
    const failing = collector();
    failing.fetch.mockImplementation((async () => ({ ok: false, status: 400, statusText: "Bad", text: async () => "", headers: { get: () => null } })) as any);
    const agent = createAgent({
      name: "Quiet",
      model: scripted("m", [{ content: "hi" }]),
      plugins: [{ name: "p", traceExporters: [createOtlpExporter({ endpoint: "https://x/v1/traces", fetch: failing.fetch })] }],
      tracing: { enabled: true, sink: customSink({ onSession: (s) => { sessions.push(s); } }) },
    });
    const result = await agent.invoke({ messages: [{ role: "user", content: "go" }] } as any);
    expect(result.content).toBe("hi");
    expect(failing.fetch).toHaveBeenCalledTimes(1);
    expect(sessions).toHaveLength(1);
    // Observability fails open: the session is not marked partial by a plugin exporter.
    expect(sessions[0].status).toBe("success");
    expect(sessions[0].errors).toEqual([]);
  });

  it("a sub-agent that inherits the exporter's plugin does not export on its own: one request for the parent's whole tree", async () => {
    const pluginSide = collector();
    const plugin: AgentPlugin = {
      name: "inherited",
      traceExporters: [createOtlpExporter({ endpoint: "https://x/v1/traces", fetch: pluginSide.fetch })],
    };
    const def: SubagentDef = { name: "kid", header: "h", model: scripted("child", [{ content: "kid-done" }]) };
    const parent = createSmartAgent({
      name: "parent",
      model: scripted("parent", [{ tool_calls: [call("p1", "delegate_to", { subagent: "kid", input: "go" })] }, { content: "parent-done" }]),
      subagents: [def], plugins: [plugin], summarization: false,
      tracing: { enabled: true, sink: customSink({}) },
    } as any);
    await parent.invoke({ messages: [{ role: "user", content: "go" }] } as any);
    expect(pluginSide.bodies).toHaveLength(1);
    const names = spansOf(pluginSide.bodies[0]).map((s) => s.name);
    expect(names).toContain("invoke_agent kid");
    expect(rootsOf(pluginSide.bodies)).toHaveLength(1);
  });
});

describe("closeTraceContinuation", () => {
  it("exports the held root of an abandoned pause as partial, through the OTLP exporters only", async () => {
    const sink = collector();
    const pluginSide = collector();
    const tracing = {
      enabled: true,
      sink: otlpSink({ endpoint: "https://sink.example.test/v1/traces", fetch: sink.fetch }),
    };
    const agent = createSmartAgent({
      name: "Abandoned",
      model: scripted("m", [{ tool_calls: [call("d1", "dangerous")] }, { content: "x" }]),
      tools: [dangerous()], summarization: false, tracing,
    } as any);
    const paused: any = await agent.invoke({ messages: [{ role: "user", content: "go" }] } as any);
    const continuation = paused.state.ctx.__traceContinuation;
    expect(continuation).toBeDefined();
    expect(rootsOf(sink.bodies)).toHaveLength(0);

    const exporter = createOtlpExporter({ endpoint: "https://plugin.example.test/v1/traces", fetch: pluginSide.fetch });
    const file = await closeTraceContinuation(continuation, { tracing, exporters: [exporter], agentRuntime: { name: "Abandoned" } as any });

    expect(file?.events).toEqual([]);
    // The sink saw leg 1 (no root) and now the close; the plugin's exporter only the close.
    expect(sink.bodies).toHaveLength(2);
    expect(pluginSide.bodies).toHaveLength(1);
    for (const body of [sink.bodies[1], pluginSide.bodies[0]]) {
      const spans = spansOf(body);
      expect(spans).toHaveLength(1);
      expect(spans[0].name).toBe("invoke_agent Abandoned");
      expect(spans[0].spanId).toBe(continuation.rootSpanId);
      expect(attrsOf(spans[0])["cognipeer.session.status"]).toBe("partial");
      expect(spans[0].status.code).toBe(0);
    }
  });

  it("does not hand the close to the file, cognipeer, http or custom sinks", async () => {
    const sessions: TraceSessionFile[] = [];
    const exporter = collector();
    const tracing = { enabled: true, sink: customSink({ onSession: (s) => { sessions.push(s); } }) };
    const agent = createSmartAgent({
      name: "A", model: scripted("m", [{ tool_calls: [call("d1", "dangerous")] }]), tools: [dangerous()], summarization: false, tracing,
    } as any);
    const paused: any = await agent.invoke({ messages: [{ role: "user", content: "go" }] } as any);
    const before = sessions.length;
    await closeTraceContinuation(paused.state.ctx.__traceContinuation, {
      tracing,
      exporters: [createOtlpExporter({ endpoint: "https://x/v1/traces", fetch: exporter.fetch })],
      status: "error",
      error: { message: "driver failed", name: "TypeError", stack: "TypeError: driver failed" },
    });
    expect(sessions).toHaveLength(before);
    const [root] = spansOf(exporter.bodies[0]);
    expect(root.status).toMatchObject({ code: 2, message: "driver failed" });
    expect(attrsOf(root)["error.type"]).toBe("TypeError");
  });

  it("an abandoned sub-agent pause: the withheld agent span is exported by the close, so no exported parent is missing", async () => {
    const { bodies, fetch } = collector();
    const tracing = { enabled: true, sink: otlpSink({ endpoint: "https://c.example.test/v1/traces", fetch }) };
    const def: SubagentDef = {
      name: "once", header: "h",
      model: scripted("child", [{ tool_calls: [call("c1", "dangerous")] }, { content: "final" }]),
      tools: [dangerous()],
    };
    const parent = createSmartAgent({
      name: "parent",
      model: scripted("parent", [{ tool_calls: [call("p1", "delegate_to", { subagent: "once", input: "go" })] }, { content: "parent-done" }]),
      subagents: [def], summarization: false, tracing,
    } as any);
    const paused: any = await parent.invoke({ messages: [{ role: "user", content: "go" }] } as any);
    // Leg 1 exported the child's spans under a parent that is withheld while it is pending.
    expect(allSpans(bodies).filter((s) => s.name === "invoke_agent once")).toHaveLength(0);

    // The continuation survives being persisted, then the host abandons the approval.
    const continuation = roundTrip(paused.state).ctx.__traceContinuation;
    expect(continuation.pendingSpans).toHaveLength(1);
    await closeTraceContinuation(continuation, { tracing, agentRuntime: { name: "parent" } as any });

    const spans = allSpans(bodies);
    const exported = new Set(spans.map((s) => s.spanId));
    const roots = rootsOf(bodies);
    expect(roots).toHaveLength(1);
    for (const span of spans) {
      if (span === roots[0]) continue;
      expect(exported.has(span.parentSpanId), `${span.name} -> ${span.parentSpanId}`).toBe(true);
    }
    // Exported once, as it stood: not an error, not finished.
    const agentSpans = spans.filter((s) => s.name === "invoke_agent once");
    expect(agentSpans).toHaveLength(1);
    expect(agentSpans[0].status.code).toBe(0);
    expect(attrsOf(agentSpans[0])["cognipeer.event.status"]).toBe("pending");
    expect(agentSpans[0].parentSpanId).not.toBe("");
  });

  it("a resumed sub-agent that finishes supersedes the carried pending span: exported once, as the finished one", async () => {
    const { bodies, fetch } = collector();
    const tracing = { enabled: true, sink: otlpSink({ endpoint: "https://c.example.test/v1/traces", fetch }) };
    const def: SubagentDef = {
      name: "once", header: "h",
      model: scripted("child", [{ tool_calls: [call("c1", "dangerous")] }, { content: "final" }]),
      tools: [dangerous()],
    };
    const parent = createSmartAgent({
      name: "parent",
      model: scripted("parent", [{ tool_calls: [call("p1", "delegate_to", { subagent: "once", input: "go" })] }, { content: "parent-done" }]),
      subagents: [def], summarization: false, tracing,
    } as any);
    const paused: any = await parent.invoke({ messages: [{ role: "user", content: "go" }] } as any);
    const state = roundTrip(paused.state);
    const pending = state.pendingApprovals.find((x: any) => x.status === "pending");
    await parent.invoke(parent.resolveToolApproval(state, { id: pending.id, approved: true, decidedBy: "ops" }) as any);
    const agentSpans = allSpans(bodies).filter((s) => s.name === "invoke_agent once");
    expect(agentSpans).toHaveLength(1);
    expect(attrsOf(agentSpans[0])["cognipeer.event.status"]).toBe("success");
  });

  it("a continuation's pendingSpans are read defensively: only well-formed pending sub-agent spans survive", () => {
    const good = { sessionId: "s", id: "evt_1", type: "span", label: "Sub-agent x #1", sequence: 3, timestamp: "2026-10-19T12:00:00.000Z", spanId: "a".repeat(16), parentSpanId: "b".repeat(16), status: "pending", actor: { role: "subagent", name: "x" }, durationMs: 4, data: { sections: [{ kind: "message", label: "Task", role: "user", content: "SECRET-BRIEF" }] } };
    const read = readTraceContinuation({
      v: 1, sessionId: "s", startedAt: 1, nextSequence: 4, part: 1,
      pendingSpans: [good, { ...good, spanId: "" }, { ...good, status: "success" }, { ...good, type: "tool_call" }, { ...good, sequence: "x" }, { ...good, timestamp: "nope" }, null, 7],
    });
    expect(read?.pendingSpans).toHaveLength(1);
    // The brief is payload: it is not carried.
    expect(JSON.stringify(read?.pendingSpans)).not.toContain("SECRET-BRIEF");
    expect(readTraceContinuation({ v: 1, sessionId: "s", startedAt: 1, nextSequence: 1, part: 1, pendingSpans: "x" })?.pendingSpans).toBeUndefined();
  });

  it("returns undefined for something that is not a continuation, or when nothing would export it", async () => {
    expect(await closeTraceContinuation({ nope: true }, { tracing: { enabled: true } })).toBeUndefined();
    const sessions: TraceSessionFile[] = [];
    const agent = createSmartAgent({
      name: "A", model: scripted("m", [{ tool_calls: [call("d1", "dangerous")] }]), tools: [dangerous()], summarization: false,
      tracing: { enabled: true, sink: customSink({ onSession: (s) => { sessions.push(s); } }) },
    } as any);
    const paused: any = await agent.invoke({ messages: [{ role: "user", content: "go" }] } as any);
    expect(await closeTraceContinuation(paused.state.ctx.__traceContinuation, { tracing: { enabled: true } })).toBeUndefined();
  });
});

describe("smart driver", () => {
  it("exports the root once when a summarization-bounced turn runs several legs", async () => {
    const { bodies, fetch } = collector();
    const BIG = "x".repeat(2400);
    let turn = 0;
    const model: any = {
      modelName: "scripted-model",
      bindTools() { return model; },
      async invoke(messages: Message[]) {
        const first = messages[0];
        const text = typeof first?.content === "string" ? first.content : "";
        if (first?.role === "system" && text.includes("summarizes conversation history efficiently")) {
          return {
            role: "assistant",
            content: JSON.stringify({ stable_facts: [], active_goals: [], open_questions: [], discarded_obsolete: [], rawSummary: "s" }),
            usage: { prompt_tokens: 1200, completion_tokens: 80, total_tokens: 1280 },
          };
        }
        const id = ["a", "b", "c"][turn++];
        if (id) return { role: "assistant", content: "", tool_calls: [call(`call_${id}`, "fetch", { id })] };
        return { role: "assistant", content: "done" };
      },
    };
    const agent = createSmartAgent({
      name: "Bouncer",
      model,
      tools: [createTool({ name: "fetch", description: "big", schema: z.object({ id: z.string() }), func: async ({ id }) => `${id}: ${BIG}` })],
      summarization: { enable: true, maxTokens: 350, summaryPromptMaxTokens: 2000 },
      limits: { maxToolCalls: 5 },
      tracing: { enabled: true, sink: otlpSink({ endpoint: "https://c.example.test/v1/traces", fetch }) },
    } as any);
    await agent.invoke({ messages: [{ role: "user", content: "Fetch a, b and c." }] } as any);

    expect(bodies.length).toBeGreaterThan(1);
    expect(rootsOf(bodies)).toHaveLength(1);
    const keys = allSpans(bodies).map((s) => `${s.traceId}/${s.spanId}`);
    expect(new Set(keys).size).toBe(keys.length);
    expect(allSpans(bodies).some((s) => attrsOf(s)["cognipeer.event.type"] === "summarization")).toBe(true);
  });

  it("a driver failure between legs closes the held trace: the root is exported with status ERROR", async () => {
    const { bodies, fetch } = collector();
    const BIG = "x".repeat(2400);
    let turn = 0;
    const model: any = {
      modelName: "scripted-model",
      bindTools() { return model; },
      async invoke(messages: Message[]) {
        const first = messages[0];
        const text = typeof first?.content === "string" ? first.content : "";
        if (first?.role === "system" && text.includes("summarizes conversation history efficiently")) {
          return { role: "assistant", content: JSON.stringify({ stable_facts: [], active_goals: [], open_questions: [], discarded_obsolete: [], rawSummary: "s" }) };
        }
        const id = ["a", "b", "c"][turn++];
        return id ? { role: "assistant", content: "", tool_calls: [call(`call_${id}`, "fetch", { id })] } : { role: "assistant", content: "done" };
      },
    };
    let reads = 0;
    const memory = {
      async get() { if (++reads >= 2) throw new Error("memory store down"); return []; },
      async upsert() {}, async markObsolete() {},
    };
    const agent = createSmartAgent({
      name: "Crasher",
      model,
      tools: [createTool({ name: "fetch", description: "big", schema: z.object({ id: z.string() }), func: async ({ id }) => `${id}: ${BIG}` })],
      summarization: { enable: true, maxTokens: 350, summaryPromptMaxTokens: 2000 },
      memory: { store: memory },
      limits: { maxToolCalls: 5 },
      tracing: { enabled: true, sink: otlpSink({ endpoint: "https://c.example.test/v1/traces", fetch }) },
    } as any);
    await expect(agent.invoke({ messages: [{ role: "user", content: "Fetch a, b and c." }] } as any)).rejects.toThrow(/memory store down/);

    const roots = rootsOf(bodies);
    expect(roots).toHaveLength(1);
    expect(roots[0].status).toMatchObject({ code: 2, message: "memory store down" });
    expect(attrsOf(roots[0])["error.type"]).toBe("Error");
  });
});

describe("approval and question pairing does not depend on logData", () => {
  const secretTool = () => createTool({
    name: "wire", description: "moves money", schema: z.object({ account: z.string() }), needsApproval: true, func: async () => "SECRET-RESULT",
  });

  async function run(logData: boolean, content = false) {
    const sessions: TraceSessionFile[] = [];
    const { bodies, fetch } = collector();
    const agent = createSmartAgent({
      name: "Approver",
      model: scripted("m", [{ tool_calls: [call("w1", "wire", { account: "SECRET-ARG" })] }, { content: "done" }]),
      tools: [secretTool()], summarization: false,
      plugins: [{ name: "p", traceExporters: [createOtlpExporter({ endpoint: "https://x/v1/traces", fetch, content })] }],
      tracing: { enabled: true, logData, sink: customSink({ onSession: (s) => { sessions.push(s); } }) },
    } as any);
    const paused: any = await agent.invoke({ messages: [{ role: "user", content: "pay SECRET-PROMPT" }] } as any);
    const state = roundTrip(paused.state);
    const pending = state.pendingApprovals.find((x: any) => x.status === "pending");
    await agent.invoke(agent.resolveToolApproval(state, { id: pending.id, approved: true, decidedBy: "ops", comment: "SECRET-COMMENT" }) as any);
    return { sessions, bodies, approvalId: pending.id as string };
  }

  const identitySections = (file: TraceSessionFile, type: string) =>
    (file.events.find((e) => e.type === type)?.data?.sections ?? []).filter((x: any) => x.identity === true) as any[];

  it("logData off: the JSON record keeps the ids, status and timestamps of the request and the decision, and no payload", async () => {
    const { sessions, approvalId } = await run(false);
    const [requested] = identitySections(sessions[0], "tool_approval");
    expect(requested).toMatchObject({ kind: "metadata", label: "Approval ids", data: { approvalId, toolCallId: "w1", status: "pending" } });
    expect(typeof requested.data.requestedAt).toBe("string");
    const [decided] = identitySections(sessions[1], "tool_approval");
    expect(decided.data).toMatchObject({ approvalId, toolCallId: "w1", decision: "approved" });
    expect(typeof decided.data.decidedAt).toBe("string");
    // Only the ids: the arguments, the prompt and the comment are logData payload.
    expect(JSON.stringify(sessions)).not.toContain("SECRET-ARG");
    expect(JSON.stringify(sessions)).not.toContain("SECRET-COMMENT");
    for (const session of sessions) for (const event of session.events.filter((e) => e.type === "tool_approval")) {
      expect((event.data?.sections ?? []).every((section: any) => section.identity === true)).toBe(true);
    }
  });

  it("logData off, content off: the OTLP export pairs the two halves by id and carries no payload", async () => {
    const { bodies, approvalId } = await run(false);
    const spans = allSpans(bodies).filter((s) => attrsOf(s)["cognipeer.event.type"] === "tool_approval");
    expect(spans).toHaveLength(2);
    const parsed = spans.map((s) => JSON.parse(attrsOf(s)["cognipeer.sections"]) as any[]);
    expect(parsed.map((list) => list[0].data.approvalId)).toEqual([approvalId, approvalId]);
    expect(parsed.map((list) => list[0].data.status ?? list[0].data.decision)).toEqual(["pending", "approved"]);
    for (const secret of ["SECRET-PROMPT", "SECRET-ARG", "SECRET-RESULT", "SECRET-COMMENT"]) expect(JSON.stringify(bodies)).not.toContain(secret);
  });

  it("logData on, content off: the ids still go out; the arguments and the comment do not", async () => {
    const { bodies, approvalId } = await run(true);
    const spans = allSpans(bodies).filter((s) => attrsOf(s)["cognipeer.event.type"] === "tool_approval");
    const parsed = spans.map((s) => JSON.parse(attrsOf(s)["cognipeer.sections"]) as any[]);
    expect(parsed.every((list) => list.length === 1 && list[0].data.approvalId === approvalId)).toBe(true);
    for (const secret of ["SECRET-ARG", "SECRET-RESULT", "SECRET-COMMENT"]) expect(JSON.stringify(bodies)).not.toContain(secret);
  });
});
