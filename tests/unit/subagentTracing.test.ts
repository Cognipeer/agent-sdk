/**
 * Sub-agents record into the parent's trace session, nested under an agent span:
 *
 *   parent agent_iteration
 *     tool_call delegate_to
 *       span "Sub-agent <name>"
 *         agent_iteration
 *           ai_call / tool_call (the child's own)
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import { createAgent, createSmartAgent, createTool, fileSink, foldSupersededSpans, traceSessionToOtlp } from "../../src/index.js";
import { otelTracing } from "../../src/plugins/index.js";
import { customSink } from "../../src/utils/tracing.js";
import { captureSnapshot, restoreSnapshot } from "../../src/utils/stateSnapshot.js";
import type { Message, SubagentDef, TraceEventRecord, TraceSessionFile } from "../../src/types.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

function capture(extra: Record<string, unknown> = {}) {
  const events: TraceEventRecord[] = [];
  const sessions: TraceSessionFile[] = [];
  const tracing = {
    enabled: true,
    mode: "batched" as const,
    ...extra,
    sink: customSink({ onEvent: (e) => { events.push(e); }, onSession: (s) => { sessions.push(s); } }),
  };
  return { events, sessions, tracing };
}

const byId = (events: TraceEventRecord[]) => new Map(events.map((e) => [e.spanId!, e]));

/**
 * Sequences are unique and only rise. What a reader draws (the records after
 * `foldSupersededSpans`) has unique span ids and every parent resolves; a span id
 * may repeat in the file only as a `pending` record that a later one supersedes.
 */
function assertTree({ events, sessions }: ReturnType<typeof capture>) {
  const rootSpanId = sessions[0]?.rootSpanId;
  const sequences = events.map((e) => e.sequence);
  expect(new Set(sequences).size).toBe(sequences.length);
  expect([...sequences].sort((a, b) => a - b)).toEqual(sequences);
  const drawn = foldSupersededSpans(events);
  const ids = new Set(drawn.map((e) => e.spanId));
  expect(ids.size, "a span id repeats other than as a superseded pending record").toBe(drawn.length);
  for (const e of drawn) {
    expect(ids.has(e.parentSpanId!) || e.parentSpanId === rootSpanId, `${e.label} parent ${e.parentSpanId}`).toBe(true);
  }
}

const agentSpans = (events: TraceEventRecord[]) => events.filter((e) => e.type === "span" && e.actor?.role === "subagent");
const metaOf = (e: TraceEventRecord) => (e.data?.sections as any[]).find((s) => s.kind === "metadata" && s.label === "Sub-agent").data;
const ancestorsOf = (e: TraceEventRecord, events: TraceEventRecord[]) => {
  const map = byId(events);
  const out: TraceEventRecord[] = [];
  for (let cur = map.get(e.parentSpanId!); cur; cur = map.get(cur.parentSpanId!)) out.push(cur);
  return out;
};

const call = (id: string, name: string, args: Record<string, unknown> = {}) => ({
  id, type: "function", function: { name, arguments: JSON.stringify(args) },
});
const usage = (p: number, c: number) => ({ prompt_tokens: p, completion_tokens: c, total_tokens: p + c });

/** Replies from `script` in order (the last one repeats); `delayMs` makes models interleave. */
function scripted(name: string, script: Array<Partial<Message> & { usage?: unknown }>, delayMs = 0) {
  let turn = 0;
  const model: any = {
    modelName: name,
    bindTools() { return model; },
    async invoke() {
      if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
      const step = script[Math.min(turn++, script.length - 1)];
      return { role: "assistant", content: "", ...step };
    },
  };
  return model;
}

const childTool = () => createTool({ name: "child_tool", description: "does a thing", schema: z.object({}), func: async () => "tool-ok" });

describe("sub-agent tracing", () => {
  it("1. delegate_to records the child inside the parent's trace, under the delegate tool span", async () => {
    const cap = capture();
    const { events, sessions, tracing } = cap;
    const def: SubagentDef = {
      name: "worker", header: "works", metadata: { kind: "agent", agentKey: "w-1" },
      model: scripted("child", [
        { tool_calls: [call("c1", "child_tool")], usage: usage(7, 3) },
        { content: "child-done", usage: usage(11, 4) },
      ]),
      tools: [childTool()],
    };
    const parent = createSmartAgent({
      name: "parent",
      model: scripted("parent", [
        { tool_calls: [call("p1", "delegate_to", { subagent: "worker", input: "do it" })], usage: usage(20, 5) },
        { content: "parent-done", usage: usage(30, 6) },
      ]),
      subagents: [def],
      summarization: false,
      tracing,
    });

    const res = await parent.invoke({ messages: [{ role: "user", content: "go" }] } as any);
    expect(res.content).toBe("parent-done");

    expect(sessions).toHaveLength(1);
    const root = sessions[0].rootSpanId;
    assertTree(cap);
    expect(new Set(events.map((e) => e.sessionId)).size).toBe(1);
    expect(new Set(events.map((e) => e.traceId)).size).toBe(1);

    const [span] = agentSpans(events);
    expect(span).toBeDefined();
    expect(span.actor).toMatchObject({ scope: "agent", name: "worker", role: "subagent" });
    expect(span.status).toBe("success");
    expect(span.error).toBeUndefined();
    expect(span.inputTokens).toBeUndefined();

    const delegate = events.find((e) => e.type === "tool_call" && e.label?.startsWith("Tool Execution - delegate_to"))!;
    expect(span.parentSpanId).toBe(delegate.spanId);

    const iterations = events.filter((e) => e.type === "agent_iteration");
    const parentIterations = iterations.filter((e) => e.actor?.name === "parent");
    const childIterations = iterations.filter((e) => e.actor?.name === "worker");
    expect(parentIterations.map((e) => e.label?.replace(/ #\d+$/, ""))).toEqual(["Iteration 1", "Iteration 2"]);
    expect(childIterations.map((e) => e.label?.replace(/ #\d+$/, ""))).toEqual(["Iteration 1", "Iteration 2"]);
    for (const it of childIterations) expect(it.parentSpanId).toBe(span.spanId);
    for (const it of parentIterations) expect(it.parentSpanId).toBe(root);

    const childCalls = events.filter((e) => e.actor?.name === "worker" && (e.type === "ai_call" || e.type === "tool_call"));
    expect(childCalls.length).toBeGreaterThan(0);
    const childIterationIds = new Set(childIterations.map((e) => e.spanId));
    for (const e of childCalls) expect(childIterationIds.has(e.parentSpanId!)).toBe(true);

    // The parent's final model call belongs to the PARENT's second iteration,
    // not to whichever iteration the child opened last.
    const parentAiCalls = events.filter((e) => e.type === "ai_call" && !childCalls.includes(e));
    const lastParentCall = parentAiCalls[parentAiCalls.length - 1];
    expect(lastParentCall.parentSpanId).toBe(parentIterations[1].spanId);

    expect(sessions[0].summary.totalInputTokens).toBe(20 + 30 + 7 + 11);
    expect(sessions[0].summary.totalOutputTokens).toBe(5 + 6 + 3 + 4);

    expect(metaOf(span)).toMatchObject({
      name: "worker", mode: "registry", depth: 1, parentToolCallId: "p1", status: "ok",
      metadata: { kind: "agent", agentKey: "w-1" },
    });
    expect(metaOf(span).id).toMatch(/^sa_/);
    const sections = span.data?.sections as any[];
    expect(sections.find((s) => s.label === "Task")).toMatchObject({ role: "user", content: "do it" });
    expect(sections.find((s) => s.label === "Result")).toMatchObject({ role: "assistant", content: "child-done" });
  });

  it("2. parallel children each record under their own agent span, below the parallel tool span", async () => {
    const cap = capture();
    const { events, tracing } = cap;
    const defs: SubagentDef[] = [["a", 30], ["b", 5], ["c", 15]].map(([name, ms]) => ({
      name: name as string, header: "h",
      model: scripted(name as string, [
        { tool_calls: [call(`${name}1`, "child_tool")], usage: usage(1, 1) },
        { content: `${name}-done`, usage: usage(1, 1) },
      ], ms as number),
      tools: [childTool()],
    }));
    const parent = createSmartAgent({
      name: "parent",
      model: scripted("parent", [
        { tool_calls: [call("par", "spawn_subagents_parallel", { tasks: defs.map((d) => ({ subagent: d.name, input: "x" })) })] },
        { content: "parent-done" },
      ]),
      subagents: defs,
      summarization: false,
      tracing,
    });
    await parent.invoke({ messages: [{ role: "user", content: "go" }] } as any);

    assertTree(cap);
    const spans = agentSpans(events);
    expect(spans.map((s) => s.actor?.name).sort()).toEqual(["a", "b", "c"]);
    const tool = events.find((e) => e.type === "tool_call" && e.label?.startsWith("Tool Execution - spawn_subagents_parallel"))!;
    for (const s of spans) expect(s.parentSpanId).toBe(tool.spanId);
    for (const e of events.filter((x) => ["a", "b", "c"].includes(x.actor?.name ?? "") && x.type !== "span")) {
      const owner = ancestorsOf(e, events).find((x) => x.type === "span");
      expect(owner?.actor?.name, `${e.label} owner`).toBe(e.actor?.name);
    }
  });

  it("3. a child paused for approval is ONE span across its segments, with the human steps inside it", async () => {
    const cap = capture();
    const { events, sessions, tracing } = cap;
    const live: any[] = [];
    const dangerous = createTool({ name: "dangerous", description: "needs approval", schema: z.object({}), needsApproval: true, func: async () => "executed" });
    const def: SubagentDef = {
      name: "risky", header: "h", metadata: { kind: "agent" },
      model: scripted("child", [
        { tool_calls: [call("c1", "dangerous")] },
        { content: "child-final" },
      ]),
      tools: [dangerous],
    };
    const parent = createSmartAgent({
      name: "parent",
      model: scripted("parent", [
        { tool_calls: [call("p1", "delegate_to", { subagent: "risky", input: "do it" })] },
        { content: "parent-done" },
      ]),
      subagents: [def],
      summarization: false,
      tracing,
    });

    const paused = await parent.invoke({ messages: [{ role: "user", content: "go" }] } as any, { onEvent: (e: any) => live.push(e) } as any);
    const approval = paused.state!.pendingApprovals![0];
    const done = await parent.invoke(
      parent.resolveToolApproval(paused.state!, { id: approval.id, approved: true, decidedBy: "ops" }) as any,
      { onEvent: (e: any) => live.push(e) } as any,
    );
    expect(done.content).toBe("parent-done");

    assertTree(cap);
    expect(new Set(events.map((e) => e.sessionId)).size).toBe(1);
    expect(sessions.length).toBeGreaterThanOrEqual(2);

    // Two records, ONE span id: the pause recorded it pending, the run's end recorded it again.
    const spans = agentSpans(events);
    expect(spans.map((s) => s.status)).toEqual(["pending", "success"]);
    const [first, second] = spans;
    expect(first.spanId).toBe(second.spanId);
    const parentIterationIds = new Set(events.filter((e) => e.type === "agent_iteration" && e.actor?.name === "parent").map((e) => e.spanId));
    expect(parentIterationIds.has(first.parentSpanId!)).toBe(true);
    const delegates = events.filter((e) => e.type === "tool_call" && e.label?.startsWith("Tool Execution - delegate_to"));
    expect(delegates).toHaveLength(1);
    expect(second.parentSpanId).toBe(delegates[0].spanId);
    expect(metaOf(first).id).toBe(metaOf(second).id);
    expect(metaOf(first)).toMatchObject({ status: "paused", segments: 1 });
    expect(metaOf(second)).toMatchObject({ status: "ok", segments: 2 });
    // Both records describe the same run, so both are drawn from the same start.
    const startOf = (e: TraceEventRecord) => Date.parse(e.timestamp) - (e.durationMs ?? 0);
    expect(Math.abs(startOf(second) - startOf(first))).toBeLessThanOrEqual(5);

    // A reader draws one group.
    const drawn = foldSupersededSpans(events);
    expect(agentSpans(drawn)).toEqual([second]);

    // Every iteration of the child, from BOTH segments, is under that one span.
    const childIterations = events.filter((e) => e.type === "agent_iteration" && e.actor?.name === "risky");
    expect(childIterations.length).toBeGreaterThanOrEqual(2);
    for (const iteration of childIterations) expect(iteration.parentSpanId).toBe(second.spanId);

    // The request and the decision are both inside it, in order.
    const approvals = drawn.filter((e) => e.type === "tool_approval");
    expect(approvals.map((e) => e.status)).toEqual(["pending", "success"]);
    expect(approvals[0].sequence).toBeLessThan(approvals[1].sequence);
    for (const a of approvals) expect(ancestorsOf(a, drawn).some((e) => e.spanId === second.spanId)).toBe(true);

    const lifecycle = live.filter((e) => e.type === "subagent");
    expect(lifecycle.map((e) => e.phase)).toEqual(["start", "paused", "result"]);
    expect(new Set(lifecycle.map((e) => e.id))).toEqual(new Set([metaOf(first).id]));
  });

  it("4. asTool: a child without tracing records under an agent span; one with its own tracing keeps its session", async () => {
    const plain = capture();
    const child = createAgent({ name: "helper", model: scripted("helper", [{ content: "helped", usage: usage(2, 1) }]), tools: [] });
    const parentModel = () => scripted("parent", [
      { tool_calls: [call("t1", "ask_helper", { input: "hi" })], usage: usage(5, 1) },
      { content: "parent-done", usage: usage(5, 1) },
    ]);
    const parent = createAgent({ name: "parent", model: parentModel(), tools: [child.asTool({ toolName: "ask_helper" })], tracing: plain.tracing });
    await parent.invoke({ messages: [{ role: "user", content: "go" }] } as any);

    assertTree(plain);
    const [span] = agentSpans(plain.events);
    expect(span.actor?.name).toBe("helper");
    expect(metaOf(span)).toMatchObject({ mode: "asTool", name: "helper" });
    const tool = plain.events.find((e) => e.type === "tool_call" && e.label?.startsWith("Tool Execution - ask_helper"))!;
    expect(span.parentSpanId).toBe(tool.spanId);
    const childAi = plain.events.filter((e) => e.type === "ai_call" && e.actor?.name === "helper");
    expect(childAi).toHaveLength(1);
    expect(plain.sessions[0].summary.totalInputTokens).toBe(5 + 5 + 2);

    const outer = capture();
    const own = capture();
    const tracedChild = createAgent({ name: "helper", model: scripted("helper", [{ content: "helped", usage: usage(2, 1) }]), tools: [], tracing: own.tracing });
    const parent2 = createAgent({ name: "parent", model: parentModel(), tools: [tracedChild.asTool({ toolName: "ask_helper" })], tracing: outer.tracing });
    await parent2.invoke({ messages: [{ role: "user", content: "go" }] } as any);

    expect(own.sessions).toHaveLength(1);
    expect(own.sessions[0].sessionId).not.toBe(outer.sessions[0].sessionId);
    expect(own.events.some((e) => e.type === "ai_call")).toBe(true);
    expect(agentSpans(outer.events)).toHaveLength(1);
    expect(outer.events.some((e) => e.actor?.name === "helper" && e.type !== "span")).toBe(false);
    expect(outer.sessions[0].summary.totalInputTokens).toBe(5 + 5);
  });

  it("5. an otelTracing plugin the child inherits exports once, for the parent's whole tree", async () => {
    const cap = capture();
    const { events, tracing } = cap;
    const fetchMock = vi.fn(async () => ({ ok: true, status: 200, statusText: "OK", text: async () => "", headers: { get: () => null } }));
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);
    const parent = createSmartAgent({
      name: "parent",
      model: scripted("parent", [
        { tool_calls: [call("p1", "delegate_to", { subagent: "worker", input: "x" })] },
        { content: "parent-done" },
      ]),
      subagents: [{ name: "worker", header: "h", model: scripted("child", [{ content: "child-done" }]) }],
      plugins: [otelTracing({ endpoint: "https://collector.example.test/v1/traces" })],
      summarization: false,
      tracing,
    });
    await parent.invoke({ messages: [{ role: "user", content: "go" }] } as any);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const body = JSON.parse((fetchMock.mock.calls[0] as any)[1].body);
    const spans = body.resourceSpans[0].scopeSpans[0].spans;
    expect(spans).toHaveLength(events.length + 1);
  });

  it("6. with parent tracing off nothing is scoped or recorded, and results are unchanged", async () => {
    const def: SubagentDef = { name: "worker", header: "h", model: scripted("child", [{ content: "child-done" }]) };
    const parent = createSmartAgent({
      name: "parent",
      model: scripted("parent", [
        { tool_calls: [call("p1", "delegate_to", { subagent: "worker", input: "x" })] },
        { content: "parent-done" },
      ]),
      subagents: [def],
      summarization: false,
    });
    const res = await parent.invoke({ messages: [{ role: "user", content: "go" }] } as any);
    expect(res.content).toBe("parent-done");
    const toolMsg = res.messages.find((m: any) => m.role === "tool" && m.name === "delegate_to") as any;
    expect(JSON.parse(toolMsg.content).content).toBe("child-done");
    expect((res.state as any).ctx?.__traceSession).toBeUndefined();
  });

  it("7. a plugin hook outcome in the child lands under the child's spans", async () => {
    const cap = capture();
    const { events, tracing } = cap;
    const plugin = {
      name: "tool-gate",
      hooks: { preToolUse: (input: any) => (input.toolName === "child_tool" ? { decision: "deny", reason: "nope" } : undefined) },
    };
    const def: SubagentDef = {
      name: "worker", header: "h",
      model: scripted("child", [{ tool_calls: [call("c1", "child_tool")] }, { content: "child-done" }]),
      tools: [childTool()],
    };
    const parent = createSmartAgent({
      name: "parent",
      model: scripted("parent", [
        { tool_calls: [call("p1", "delegate_to", { subagent: "worker", input: "x" })] },
        { content: "parent-done" },
      ]),
      subagents: [def],
      plugins: [plugin as any],
      summarization: false,
      tracing,
    });
    await parent.invoke({ messages: [{ role: "user", content: "go" }] } as any);

    assertTree(cap);
    const [span] = agentSpans(events);
    const hooks = events.filter((e) => e.type === "hook" && e.label?.includes("preToolUse"));
    expect(hooks).toHaveLength(1);
    expect(ancestorsOf(hooks[0], events).some((e) => e.spanId === span.spanId)).toBe(true);
  });

  it("8. a blocked delegation records a skipped agent span and a throwing child an error one", async () => {
    const gate = { name: "gate", hooks: { subagentStart: (input: any) => (input.name === "blocked" ? { decision: "deny", reason: "not allowed" } : undefined) } };
    const boom: any = { modelName: "boom", bindTools() { return boom; }, async invoke() { throw new Error("child exploded"); } };
    const cap = capture();
    const { events, tracing } = cap;
    const parent = createSmartAgent({
      name: "parent",
      model: scripted("parent", [
        { tool_calls: [call("p1", "delegate_to", { subagent: "blocked", input: "x" }), call("p2", "delegate_to", { subagent: "broken", input: "y" })] },
        { content: "parent-done" },
      ]),
      subagents: [
        { name: "blocked", header: "h", model: scripted("c", [{ content: "never" }]) },
        { name: "broken", header: "h", model: boom },
      ],
      plugins: [gate as any],
      summarization: false,
      tracing,
    });
    await parent.invoke({ messages: [{ role: "user", content: "go" }] } as any);

    assertTree(cap);
    const spans = agentSpans(events);
    const blocked = spans.find((s) => s.actor?.name === "blocked")!;
    const broken = spans.find((s) => s.actor?.name === "broken")!;
    expect(blocked.status).toBe("skipped");
    expect(metaOf(blocked).status).toBe("blocked");
    expect(broken.status).toBe("error");
    expect(broken.error?.message).toContain("child exploded");
  });
});

describe("sub-agent tracing: review fixes", () => {
  const dangerous = () => createTool({ name: "dangerous", description: "needs approval", schema: z.object({}), needsApproval: true, func: async () => "executed" });
  const underSpan = (e: TraceEventRecord, events: TraceEventRecord[], spanId: string) => ancestorsOf(e, events).some((a) => a.spanId === spanId);
  const roundTrip = (state: any) => restoreSnapshot(JSON.parse(JSON.stringify(captureSnapshot(state)))) as any;

  it("keeps the Sub-agent metadata section when logData is off, and still drops Task and Result", async () => {
    const cap = capture({ logData: false });
    const def: SubagentDef = { name: "worker", header: "h", metadata: { kind: "agent", agentKey: "w-1" }, model: scripted("c", [{ content: "done" }]) };
    const parent = createSmartAgent({
      name: "parent",
      model: scripted("p", [{ tool_calls: [call("p1", "delegate_to", { subagent: "worker", input: "x" })] }, { content: "ok" }]),
      subagents: [def], summarization: false, tracing: cap.tracing,
    });
    await parent.invoke({ messages: [{ role: "user", content: "go" }] } as any);
    const [span] = agentSpans(cap.events);
    expect(metaOf(span).metadata).toEqual({ kind: "agent", agentKey: "w-1" });
    expect((span.data!.sections as any[]).map((x) => x.label)).toEqual(["Sub-agent"]);
  });

  it("does not count a delegated run's wall time more than once in totalDurationMs", async () => {
    const cap = capture();
    const slow = createTool({ name: "slow", description: "x", schema: z.object({}), func: async () => { await new Promise((r) => setTimeout(r, 120)); return "ok"; } });
    const def: SubagentDef = { name: "worker", header: "h", model: scripted("c", [{ tool_calls: [call("c1", "slow")] }, { content: "done" }]), tools: [slow] };
    const parent = createSmartAgent({
      name: "parent",
      model: scripted("p", [{ tool_calls: [call("p1", "delegate_to", { subagent: "worker", input: "x" })] }, { content: "ok" }]),
      subagents: [def], summarization: false, tracing: cap.tracing,
    });
    await parent.invoke({ messages: [{ role: "user", content: "go" }] } as any);
    const session = cap.sessions[0];
    expect(session.summary.totalDurationMs).toBeLessThanOrEqual(session.durationMs);
    expect(agentSpans(cap.events)[0].durationMs).toBeGreaterThan(100);
  });

  it("gives a tool call context without a traceSpanId key when tracing is off", async () => {
    let seen: Record<string, unknown> | undefined;
    const probe = createTool({ name: "probe", description: "d", schema: z.object({}), func: async (_args: any, ctx: any) => { seen = ctx; return "ok"; } });
    const agent = createAgent({ name: "a", model: scripted("m", [{ tool_calls: [call("t1", "probe")] }, { content: "done" }]), tools: [probe] });
    await agent.invoke({ messages: [{ role: "user", content: "go" }] } as any);
    expect(Object.keys(seen!).sort()).toEqual(["cancellationToken", "signal", "toolCallId"]);
  });

  it("records no undecidable approval for a parallel fan-out child that needs input", async () => {
    const cap = capture();
    const def: SubagentDef = { name: "risky", header: "h", model: scripted("c", [{ tool_calls: [call("c1", "dangerous")] }, { content: "x" }]), tools: [dangerous()] };
    const parent = createSmartAgent({
      name: "parent",
      model: scripted("p", [{ tool_calls: [call("pp", "spawn_subagents_parallel", { tasks: [{ subagent: "risky", input: "x" }] })] }, { content: "parent-done" }]),
      subagents: [def], summarization: false, tracing: cap.tracing,
    });
    const res = await parent.invoke({ messages: [{ role: "user", content: "go" }] } as any);
    expect(res.content).toBe("parent-done");
    const [span] = agentSpans(cap.events);
    expect(metaOf(span).status).toBe("needs_input");
    expect(span.status).toBe("error");
    expect(cap.sessions.at(-1)!.status).toBe("success");
    expect(cap.events.filter((e) => e.type === "tool_approval")).toEqual([]);
    expect((res.state?.pendingApprovals ?? []).filter((a: any) => a.status === "pending")).toHaveLength(0);
  });

  it("records no undecidable approval for an asTool child that needs one", async () => {
    const cap = capture();
    const child = createAgent({ name: "helper", model: scripted("h", [{ tool_calls: [call("c1", "dangerous")] }, { content: "x" }]), tools: [dangerous()] });
    const parent = createAgent({
      name: "parent",
      model: scripted("p", [{ tool_calls: [call("t1", "ask_helper", { input: "hi" })] }, { content: "parent-done" }]),
      tools: [child.asTool({ toolName: "ask_helper" })],
      tracing: cap.tracing,
    });
    await parent.invoke({ messages: [{ role: "user", content: "go" }] } as any);
    expect(cap.sessions.at(-1)!.status).toBe("success");
    expect(cap.events.filter((e) => e.type === "tool_approval")).toEqual([]);
  });

  it("records the reviewer's decision when the resumed child ends on its budget before an iteration opens", async () => {
    const cap = capture();
    const def: SubagentDef = {
      name: "capped", header: "h",
      limits: { maxTotalOutputTokens: 1 } as any,
      model: scripted("child", [{ tool_calls: [call("c1", "dangerous")], usage: usage(3, 9) }, { content: "final" }]),
      tools: [dangerous()],
    };
    const parent = createSmartAgent({
      name: "parent",
      model: scripted("parent", [{ tool_calls: [call("p1", "delegate_to", { subagent: "capped", input: "go" })] }, { content: "parent-done" }]),
      subagents: [def], summarization: false, tracing: cap.tracing,
    });
    const paused = await parent.invoke({ messages: [{ role: "user", content: "go" }] } as any);
    const pending = paused.state!.pendingApprovals![0];
    await parent.invoke(parent.resolveToolApproval(paused.state!, { id: pending.id, approved: true, decidedBy: "ops" }) as any);
    const approvals = cap.events.filter((e) => e.type === "tool_approval");
    expect(approvals.map((e) => e.status)).toEqual(["pending", "success"]);
    expect(underSpan(approvals[1], cap.events, agentSpans(cap.events)[1].spanId!)).toBe(true);
  });

  it("numbers a child's iterations on across a pause and resume", async () => {
    const cap = capture();
    const def: SubagentDef = {
      name: "twice", header: "h",
      model: scripted("child", [{ tool_calls: [call("c1", "dangerous")] }, { tool_calls: [call("c2", "dangerous")] }, { content: "final" }]),
      tools: [dangerous()],
    };
    const parent = createSmartAgent({
      name: "parent",
      model: scripted("parent", [{ tool_calls: [call("p1", "delegate_to", { subagent: "twice", input: "go" })] }, { content: "parent-done" }]),
      subagents: [def], summarization: false, tracing: cap.tracing,
    });
    let res: any = await parent.invoke({ messages: [{ role: "user", content: "go" }] } as any);
    for (let legs = 0; legs < 5; legs++) {
      const state = roundTrip(res.state);
      const pending = state.pendingApprovals.find((x: any) => x.status === "pending");
      if (!pending) break;
      res = await parent.invoke(parent.resolveToolApproval(state, { id: pending.id, approved: true, decidedBy: "ops" }) as any);
    }
    expect(res.content).toBe("parent-done");
    const labels = cap.events.filter((e) => e.type === "agent_iteration" && e.actor?.name === "twice").map((e) => e.label?.replace(/ #\d+$/, ""));
    expect(labels).toEqual(["Iteration 1", "Iteration 2", "Iteration 3", "Iteration 4", "Iteration 5"]);
    expect(cap.sessions.at(-1)!.summary.subagentIterations).toBe(5);
  });
});

describe("sub-agent tracing: one span across pauses", () => {
  const dangerous = () => createTool({ name: "dangerous", description: "needs approval", schema: z.object({}), needsApproval: true, func: async () => "executed" });
  const roundTrip = (state: any) => restoreSnapshot(JSON.parse(JSON.stringify(captureSnapshot(state)))) as any;
  const labelOf = (e: TraceEventRecord) => e.label?.replace(/ #\d+$/, "");
  const iterationsOf = (events: TraceEventRecord[], name: string) => events.filter((e) => e.type === "agent_iteration" && e.actor?.name === name);
  const startOf = (e: TraceEventRecord) => Date.parse(e.timestamp) - (e.durationMs ?? 0);

  /** Answers every pending approval in turn, through a JSON round trip between legs, until the run ends. */
  async function approveAll(parent: any, first: any, between?: (leg: number, state: any) => void) {
    let res = first;
    for (let leg = 0; leg < 8; leg++) {
      const state = roundTrip(res.state);
      const pending = (state.pendingApprovals ?? []).find((x: any) => x.status === "pending");
      if (!pending) break;
      between?.(leg, state);
      res = await parent.invoke(parent.resolveToolApproval(state, { id: pending.id, approved: true, decidedBy: "ops" }) as any);
    }
    return res;
  }
  const twice = (): SubagentDef => ({
    name: "twice", header: "h",
    model: scripted("child", [{ tool_calls: [call("c1", "dangerous")] }, { tool_calls: [call("c2", "dangerous")] }, { content: "final" }]),
    tools: [dangerous()],
  });
  const once = (): SubagentDef => ({
    name: "once", header: "h",
    model: scripted("child", [{ tool_calls: [call("c1", "dangerous")] }, { content: "final" }]),
    tools: [dangerous()],
  });
  const delegatingTo = (def: SubagentDef, tracing: any) => createSmartAgent({
    name: "parent",
    model: scripted("parent", [{ tool_calls: [call("p1", "delegate_to", { subagent: def.name, input: "go" })] }, { content: "parent-done" }]),
    subagents: [def], summarization: false, tracing,
  });
  const start = (agent: any) => agent.invoke({ messages: [{ role: "user", content: "go" }] } as any);

  it("a child that pauses twice is still one span: three records, one id, every iteration and human step inside it", async () => {
    const cap = capture();
    const parent = delegatingTo(twice(), cap.tracing);
    const res = await approveAll(parent, await start(parent));
    expect(res.content).toBe("parent-done");
    assertTree(cap);

    const spans = agentSpans(cap.events);
    expect(spans.map((s) => s.status)).toEqual(["pending", "pending", "success"]);
    expect(new Set(spans.map((s) => s.spanId)).size).toBe(1);
    expect(spans.map((s) => metaOf(s).segments)).toEqual([1, 2, 3]);
    expect(new Set(spans.map((s) => metaOf(s).id)).size).toBe(1);
    // Each pause hangs off the parent iteration of its own leg; the end hangs off the delegating tool call.
    const parentIterations = iterationsOf(cap.events, "parent").map((e) => e.spanId);
    expect(parentIterations).toContain(spans[0].parentSpanId);
    expect(parentIterations).toContain(spans[1].parentSpanId);
    expect(spans[0].parentSpanId).not.toBe(spans[1].parentSpanId);
    const delegate = cap.events.find((e) => e.type === "tool_call" && e.label?.startsWith("Tool Execution - delegate_to"))!;
    expect(spans[2].parentSpanId).toBe(delegate.spanId);

    // A reader draws one group...
    const drawn = foldSupersededSpans(cap.events);
    expect(agentSpans(drawn)).toEqual([spans[2]]);
    // ...holding all five iterations of the three segments, numbered on...
    const kids = iterationsOf(cap.events, "twice");
    expect(kids.map(labelOf)).toEqual(["Iteration 1", "Iteration 2", "Iteration 3", "Iteration 4", "Iteration 5"]);
    for (const kid of kids) expect(kid.parentSpanId).toBe(spans[2].spanId);
    // ...and the four human steps, in the order they happened.
    const humans = drawn.filter((e) => e.type === "tool_approval");
    expect(humans.map((e) => e.status)).toEqual(["pending", "success", "pending", "success"]);
    expect(humans.map((e) => e.sequence)).toEqual([...humans.map((e) => e.sequence)].sort((a, b) => a - b));
    for (const h of humans) expect(ancestorsOf(h, drawn).some((a) => a.spanId === spans[2].spanId)).toBe(true);
    // The file still holds, and counts, every record that was written.
    const summary = cap.sessions.at(-1)!.summary;
    expect(summary.eventCounts.span).toBe(3);
    expect(summary.subagentIterations).toBe(5);
  });

  it("reports the run's whole extent, so the span covers its children from every segment and the wait", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(new Date("2026-01-01T10:00:00.000Z"));
      const cap = capture();
      const parent = delegatingTo(once(), cap.tracing);
      const paused = await start(parent);
      vi.setSystemTime(new Date("2026-01-01T13:00:00.000Z")); // three hours at the approval prompt
      await approveAll(parent, paused);

      const [pending, final] = agentSpans(cap.events);
      expect(startOf(pending)).toBe(Date.parse("2026-01-01T10:00:00.000Z"));
      expect(startOf(final)).toBe(startOf(pending));
      expect(final.durationMs).toBe(3 * 3600 * 1000);
      expect(Date.parse(final.timestamp)).toBe(Date.parse("2026-01-01T13:00:00.000Z"));
      // The wait is the decision's own duration, and it is inside the span.
      const decision = cap.events.find((e) => e.type === "tool_approval" && e.status === "success")!;
      expect(decision.durationMs).toBe(3 * 3600 * 1000);
      // It does not leak into the session's summed time.
      expect(cap.sessions.at(-1)!.summary.totalDurationMs).toBeLessThan(60_000);
    } finally {
      vi.useRealTimers();
    }
  });

  it("clamps the extent at zero when the resuming host's clock is behind", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(new Date("2026-01-01T10:00:00.000Z"));
      const cap = capture();
      const parent = delegatingTo(once(), cap.tracing);
      const paused = await start(parent);
      vi.setSystemTime(new Date("2026-01-01T09:00:00.000Z"));
      await approveAll(parent, paused);
      const [, final] = agentSpans(cap.events);
      expect(final.durationMs).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("a question pause is one span too, with the question and its answer inside", async () => {
    const cap = capture();
    const question = "Proceed?";
    const asker: any = {
      modelName: "child", bindTools() { return this; },
      async invoke(msgs: Message[]) {
        if (msgs.some((m) => m.role === "tool")) return { role: "assistant", content: "child-after-answer" };
        return { role: "assistant", content: "", tool_calls: [call("q1", "ask_user_question", { questions: [{ question, options: [{ label: "Yes" }, { label: "No" }] }] })] };
      },
    };
    const parent = createSmartAgent({
      name: "parent",
      model: scripted("parent", [{ tool_calls: [call("p1", "delegate_to", { subagent: "asker", input: "ask" })] }, { content: "parent-done" }]),
      subagents: [{ name: "asker", header: "asks", model: asker }],
      humanInTheLoop: { askUser: true }, summarization: false, tracing: cap.tracing,
    });
    const paused: any = await start(parent);
    const pending = (paused.state.pendingUserQuestions ?? []).find((q: any) => q.status === "pending");
    const done: any = await parent.invoke(parent.resolveUserQuestion(roundTrip(paused.state), { id: pending.id, answers: { [question]: { values: ["Yes"] } } }) as any);
    expect(done.content).toBe("parent-done");

    assertTree(cap);
    const spans = agentSpans(cap.events);
    expect(spans.map((s) => s.status)).toEqual(["pending", "success"]);
    expect(spans[0].spanId).toBe(spans[1].spanId);
    const drawn = foldSupersededSpans(cap.events);
    expect(agentSpans(drawn)).toHaveLength(1);
    const questions = drawn.filter((e) => e.type === "user_question");
    expect(questions.map((e) => e.status)).toEqual(["pending", "success"]);
    for (const q of questions) expect(ancestorsOf(q, drawn).some((a) => a.spanId === spans[1].spanId)).toBe(true);
  });

  it("an ad-hoc spawn_subagent that pauses is one span, and keeps its borrowed tool", async () => {
    const cap = capture();
    const runQuery = createTool({ name: "run_query", description: "runs a query", schema: z.object({}), func: async () => "query-result" });
    const hybrid: any = {
      modelName: "m", bindTools() { return this; },
      async invoke(msgs: Message[]) {
        const isChild = msgs.some((m: any) => m.role === "user" && typeof m.content === "string" && m.content.includes("DBTASK"));
        if (isChild) {
          if (msgs.some((m: any) => m.role === "tool" && m.name === "dangerous")) return { role: "assistant", content: "child-done" };
          return { role: "assistant", content: "", tool_calls: [call("d1", "dangerous")] };
        }
        if (msgs.some((m: any) => m.role === "tool" && m.name === "spawn_subagent")) return { role: "assistant", content: "parent-done" };
        return { role: "assistant", content: "", tool_calls: [call("s1", "spawn_subagent", { role: "db", prompt: "you are a db analyst", input: "handle DBTASK", tools: ["dangerous", "run_query"] })] };
      },
    };
    const parent = createSmartAgent({
      name: "parent", model: hybrid, tools: [dangerous(), runQuery],
      subagentPolicy: { mode: "registry_and_adhoc", maxDepth: 2, maxChildCalls: 8, maxParallel: 4, childContextPolicy: "scoped", allowAdhocTools: true },
      summarization: false, tracing: cap.tracing,
    });
    const res = await approveAll(parent, await start(parent));
    expect(res.content).toBe("parent-done");
    assertTree(cap);
    const spans = agentSpans(cap.events);
    expect(spans.map((s) => s.status)).toEqual(["pending", "success"]);
    expect(spans[0].spanId).toBe(spans[1].spanId);
    expect(metaOf(spans[1])).toMatchObject({ mode: "adhoc", name: "db" });
    expect(agentSpans(foldSupersededSpans(cap.events))).toHaveLength(1);
  });

  it("a resumed child that fails ends the same span as an error", async () => {
    const cap = capture();
    let calls = 0;
    const flaky: any = {
      modelName: "flaky", bindTools() { return flaky; },
      async invoke() {
        if (calls++ === 0) return { role: "assistant", content: "", tool_calls: [call("c1", "dangerous")] };
        throw new Error("child exploded after approval");
      },
    };
    const parent = delegatingTo({ name: "flaky", header: "h", model: flaky, tools: [dangerous()] }, cap.tracing);
    await approveAll(parent, await start(parent));
    const spans = agentSpans(cap.events);
    expect(spans.map((s) => s.status)).toEqual(["pending", "error"]);
    expect(spans[0].spanId).toBe(spans[1].spanId);
    expect(spans[1].error?.message).toContain("child exploded after approval");
    expect(agentSpans(foldSupersededSpans(cap.events))).toEqual([spans[1]]);
  });

  it("two children paused in the same turn keep a span each, and neither takes the other's iterations", async () => {
    const cap = capture();
    const question = "Proceed?";
    const asker = (): any => ({
      modelName: "child", bindTools() { return this; },
      async invoke(msgs: Message[]) {
        if (msgs.some((m) => m.role === "tool")) return { role: "assistant", content: "child-after-answer" };
        return { role: "assistant", content: "", tool_calls: [call("q1", "ask_user_question", { questions: [{ question, options: [{ label: "Yes" }, { label: "No" }] }] })] };
      },
    });
    const parentModel: any = {
      modelName: "parent", bindTools() { return this; },
      async invoke(msgs: Message[]) {
        if (msgs.filter((m: any) => m.role === "tool" && m.name === "delegate_to").length >= 2) return { role: "assistant", content: "parent-done" };
        return { role: "assistant", content: "", tool_calls: [call("d1", "delegate_to", { subagent: "qa", input: "a" }), call("d2", "delegate_to", { subagent: "qb", input: "b" })] };
      },
    };
    const parent = createSmartAgent({
      name: "parent", model: parentModel,
      subagents: [{ name: "qa", header: "asks", model: asker() }, { name: "qb", header: "asks", model: asker() }],
      humanInTheLoop: { askUser: true }, summarization: false, tracing: cap.tracing,
    });
    let res: any = await start(parent);
    for (let leg = 0; leg < 6; leg++) {
      const state = roundTrip(res.state);
      const pending = (state.pendingUserQuestions ?? []).find((q: any) => q.status === "pending");
      if (!pending) break;
      res = await parent.invoke(parent.resolveUserQuestion(state, { id: pending.id, answers: { [question]: { values: ["Yes"] } } }) as any);
    }
    expect(res.content).toBe("parent-done");
    assertTree(cap);

    const spans = agentSpans(cap.events);
    const ids = new Set(spans.map((s) => s.spanId));
    expect(ids.size).toBe(2);
    const drawn = agentSpans(foldSupersededSpans(cap.events));
    expect(drawn.map((s) => s.status)).toEqual(["success", "success"]);
    for (const span of drawn) {
      const own = iterationsOf(cap.events, span.actor!.name!);
      expect(own.length).toBeGreaterThan(0);
      for (const iteration of own) expect(iteration.parentSpanId).toBe(span.spanId);
    }
  });

  it("a snapshot paused under 0.17.0 (no agentSpanId on its record) resumes with a fresh id and does not throw", async () => {
    const cap = capture();
    const parent = delegatingTo(once(), cap.tracing);
    const paused: any = await start(parent);
    const state = roundTrip(paused.state);
    const record = Object.values(state.ctx.__subagentPending)[0] as any;
    expect(record.agentSpanId).toBeTruthy();
    delete record.agentSpanId; delete record.startedAt; delete record.segments;
    const pending = state.pendingApprovals.find((x: any) => x.status === "pending");
    const done: any = await parent.invoke(parent.resolveToolApproval(state, { id: pending.id, approved: true, decidedBy: "ops" }) as any);
    expect(done.content).toBe("parent-done");
    const spans = agentSpans(cap.events);
    expect(spans.map((s) => s.status)).toEqual(["pending", "success"]);
    expect(spans[0].spanId).not.toBe(spans[1].spanId); // two groups, as 0.17.0 wrote them
    expect(metaOf(spans[1]).segments).toBeUndefined();
  });

  it("ignores a persisted startedAt / segments that are not finite numbers: the resumed span still gets a real duration", async () => {
    const cap = capture();
    const parent = delegatingTo(once(), cap.tracing);
    const paused: any = await start(parent);
    const state = roundTrip(paused.state);
    const record = Object.values(state.ctx.__subagentPending)[0] as any;
    record.startedAt = "yesterday"; record.segments = "one";
    const pending = state.pendingApprovals.find((x: any) => x.status === "pending");
    await parent.invoke(parent.resolveToolApproval(state, { id: pending.id, approved: true, decidedBy: "ops" }) as any);
    const final = agentSpans(cap.events).at(-1)!;
    expect(Number.isFinite(final.durationMs)).toBe(true);
    expect(final.durationMs).toBeGreaterThanOrEqual(0);
    expect(metaOf(final).segments).toBeUndefined();
  });

  it.each([["empty string", ""], ["a number", 42], ["not a span id", "abc"]])("ignores a persisted agentSpanId that is %s: the resumed run gets a real fresh id", async (_name, bad) => {
    const cap = capture();
    const parent = delegatingTo(once(), cap.tracing);
    const paused: any = await start(parent);
    const state = roundTrip(paused.state);
    (Object.values(state.ctx.__subagentPending)[0] as any).agentSpanId = bad;
    const pending = state.pendingApprovals.find((x: any) => x.status === "pending");
    await parent.invoke(parent.resolveToolApproval(state, { id: pending.id, approved: true, decidedBy: "ops" }) as any);
    const final = agentSpans(cap.events).at(-1)!;
    expect(final.spanId).toMatch(/^[0-9a-f]{16}$/);
    expect(final.spanId).not.toBe(bad);
    for (const e of cap.events) expect(e.spanId).toBeTruthy();
  });

  it.each([0, -5, 1.5e15])("ignores a persisted startedAt of %s: the span does not start in 1970 or the future", async (bad) => {
    const cap = capture();
    const parent = delegatingTo(once(), cap.tracing);
    const paused: any = await start(parent);
    const state = roundTrip(paused.state);
    (Object.values(state.ctx.__subagentPending)[0] as any).startedAt = bad;
    const pending = state.pendingApprovals.find((x: any) => x.status === "pending");
    await parent.invoke(parent.resolveToolApproval(state, { id: pending.id, approved: true, decidedBy: "ops" }) as any);
    const final = agentSpans(cap.events).at(-1)!;
    expect(final.durationMs!).toBeLessThan(60_000);
  });

  it.each([0, 1.5, 5000, -1])("ignores a persisted segments of %s", async (bad) => {
    const cap = capture();
    const parent = delegatingTo(once(), cap.tracing);
    const paused: any = await start(parent);
    const state = roundTrip(paused.state);
    (Object.values(state.ctx.__subagentPending)[0] as any).segments = bad;
    const pending = state.pendingApprovals.find((x: any) => x.status === "pending");
    await parent.invoke(parent.resolveToolApproval(state, { id: pending.id, approved: true, decidedBy: "ops" }) as any);
    expect(metaOf(agentSpans(cap.events).at(-1)!).segments).toBeUndefined();
  });

  it("a resume that opens a NEW trace session (no __traceContinuation) does not start the span before that session", async () => {
    const cap = capture();
    const parent = delegatingTo(once(), cap.tracing);
    const paused: any = await start(parent);
    const state = roundTrip(paused.state);
    delete state.ctx.__traceContinuation;
    await new Promise((r) => setTimeout(r, 60));
    const pending = state.pendingApprovals.find((x: any) => x.status === "pending");
    await parent.invoke(parent.resolveToolApproval(state, { id: pending.id, approved: true, decidedBy: "ops" }) as any);
    expect(cap.sessions.length).toBe(2);
    const second = cap.sessions[1];
    const final = agentSpans(cap.events).at(-1)!;
    expect(final.status).toBe("success");
    expect(startOf(final)).toBeGreaterThanOrEqual(Date.parse(second.startedAt) - 1);
  });

  it("parallel children and asTool children are never resumed: one record each, a fresh id each", async () => {
    const cap = capture();
    const def = (name: string): SubagentDef => ({ name, header: "h", model: scripted(name, [{ content: `${name}-done` }]) });
    const parent = createSmartAgent({
      name: "parent",
      model: scripted("parent", [{ tool_calls: [call("pp", "spawn_subagents_parallel", { tasks: [{ subagent: "a", input: "x" }, { subagent: "b", input: "y" }] })] }, { content: "parent-done" }]),
      subagents: [def("a"), def("b")], summarization: false, tracing: cap.tracing,
    });
    await start(parent);
    const spans = agentSpans(cap.events);
    expect(spans).toHaveLength(2);
    expect(new Set(spans.map((s) => s.spanId)).size).toBe(2);
    for (const s of spans) expect(metaOf(s).segments).toBeUndefined();

    const plain = capture();
    const helper = createAgent({ name: "helper", model: scripted("helper", [{ content: "helped" }]), tools: [] });
    const top = createAgent({
      name: "top",
      model: scripted("top", [{ tool_calls: [call("t1", "ask_helper", { input: "hi" }), call("t2", "ask_helper", { input: "again" })] }, { content: "top-done" }]),
      tools: [helper.asTool({ toolName: "ask_helper" })], tracing: plain.tracing,
    });
    await start(top);
    const asTool = agentSpans(plain.events);
    expect(asTool).toHaveLength(2);
    expect(new Set(asTool.map((s) => s.spanId)).size).toBe(2);
  });
});

describe("foldSupersededSpans", () => {
  const rec = (sequence: number, spanId: string | undefined, status = "success") => ({ sequence, spanId, status });

  it("keeps everything when no id repeats, in order, without touching its input", () => {
    const input = [rec(1, "a"), rec(2, "b", "pending"), rec(3, "c")];
    const snapshot = JSON.stringify(input);
    expect(foldSupersededSpans(input)).toEqual(input);
    expect(JSON.stringify(input)).toBe(snapshot);
    expect(foldSupersededSpans([])).toEqual([]);
  });

  it("drops a pending record once a later one has its id", () => {
    expect(foldSupersededSpans([rec(1, "a", "pending"), rec(2, "x"), rec(3, "a")])).toEqual([rec(2, "x"), rec(3, "a")]);
    expect(foldSupersededSpans([rec(1, "a", "pending"), rec(2, "a", "pending"), rec(3, "a", "error")])).toEqual([rec(3, "a", "error")]);
  });

  it("keeps the latest pending record while the run is still waiting", () => {
    expect(foldSupersededSpans([rec(1, "a", "pending"), rec(5, "a", "pending")])).toEqual([rec(5, "a", "pending")]);
  });

  it("never drops a record that is not pending, even when its id repeats", () => {
    const input = [rec(1, "a"), rec(2, "a"), rec(3, "a", "error")];
    expect(foldSupersededSpans(input)).toEqual(input);
  });

  it("does not let a pending record that precedes nothing hide an earlier finished one", () => {
    const input = [rec(1, "a"), rec(2, "a", "pending")];
    expect(foldSupersededSpans(input)).toEqual(input);
  });

  it("leaves records without a span id alone and falls back to array order without sequences", () => {
    const loose = [{ spanId: undefined, status: "pending" }, { spanId: "a", status: "pending" }, { spanId: "a", status: "success" }] as any[];
    expect(foldSupersededSpans(loose)).toEqual([loose[0], loose[2]]);
  });

  it("is decided by sequence, not by where the record sits in the array", () => {
    expect(foldSupersededSpans([rec(9, "a"), rec(2, "a", "pending")])).toEqual([rec(9, "a")]);
  });
});

describe("OTLP export of a sub-agent that paused", () => {
  const dangerous = () => createTool({ name: "dangerous", description: "needs approval", schema: z.object({}), needsApproval: true, func: async () => "executed" });
  const roundTrip = (state: any) => restoreSnapshot(JSON.parse(JSON.stringify(captureSnapshot(state)))) as any;
  const attr = (span: any, key: string) => span.attributes.find((a: any) => a.key === key)?.value?.stringValue;

  it("exports the span once, from the leg that ends the run, and never the pending record", async () => {
    const cap = capture();
    const bodies: any[] = [];
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init: any) => {
      bodies.push(JSON.parse(init.body));
      return { ok: true, status: 200, statusText: "OK", text: async () => "", headers: { get: () => null } };
    }) as unknown as typeof fetch);
    const def: SubagentDef = {
      name: "once", header: "h",
      model: scripted("child", [{ tool_calls: [call("c1", "dangerous")] }, { content: "final" }]),
      tools: [dangerous()],
    };
    const parent = createSmartAgent({
      name: "parent",
      model: scripted("parent", [{ tool_calls: [call("p1", "delegate_to", { subagent: "once", input: "go" })] }, { content: "parent-done" }]),
      subagents: [def], plugins: [otelTracing({ endpoint: "https://collector.example.test/v1/traces" })],
      summarization: false, tracing: cap.tracing,
    });
    const paused: any = await parent.invoke({ messages: [{ role: "user", content: "go" }] } as any);
    const state = roundTrip(paused.state);
    const pending = state.pendingApprovals.find((x: any) => x.status === "pending");
    await parent.invoke(parent.resolveToolApproval(state, { id: pending.id, approved: true, decidedBy: "ops" }) as any);

    const spansOf = (body: any) => body.resourceSpans[0].scopeSpans[0].spans as any[];
    const agentSpansOf = (body: any) => spansOf(body).filter((s) => attr(s, "cognipeer.event.type") === "span");
    expect(bodies.length).toBeGreaterThanOrEqual(1);
    const exported = bodies.flatMap(agentSpansOf);
    const [recorded] = agentSpans(cap.events).filter((e) => e.status === "success");
    // One agent span in all, and it is the finished one.
    expect(exported).toHaveLength(1);
    expect(exported[0].spanId).toBe(recorded.spanId);
    // UNSET, not OK: a finished span is not an assertion that the application vouches for it.
    expect(exported[0].status.code).toBe(0);
    // The children of both segments name it as their parent, so the backend can join them.
    const children = bodies.flatMap(spansOf).filter((s) => s.parentSpanId === recorded.spanId);
    expect(children.length).toBeGreaterThanOrEqual(2);
  });

  it("traceSessionToOtlp folds a pending record away and leaves a repeated non-pending id alone", () => {
    const base = (over: Partial<TraceEventRecord>): TraceEventRecord => ({
      id: `evt_${over.sequence}`, sessionId: "s", traceId: "t".repeat(32), type: "span", label: "Sub-agent x", status: "success",
      timestamp: "2026-01-01T00:00:00.000Z", durationMs: 5, ...over,
    } as TraceEventRecord);
    const session = {
      sessionId: "s", traceId: "t".repeat(32), rootSpanId: "r".repeat(16), startedAt: "2026-01-01T00:00:00.000Z", status: "success",
      errors: [], summary: { eventCounts: { span: 3 }, totalInputTokens: 0, totalOutputTokens: 0, totalCachedInputTokens: 0, totalBytesIn: 0, totalBytesOut: 0, totalDurationMs: 0 },
      events: [
        base({ sequence: 1, spanId: "a".repeat(16), status: "pending", parentSpanId: "r".repeat(16) }),
        base({ sequence: 2, spanId: "b".repeat(16), type: "tool_call", parentSpanId: "r".repeat(16) }),
        base({ sequence: 3, spanId: "a".repeat(16), parentSpanId: "b".repeat(16) }),
        base({ sequence: 4, spanId: "c".repeat(16), type: "tool_call", parentSpanId: "r".repeat(16) }),
        base({ sequence: 5, spanId: "c".repeat(16), type: "tool_call", parentSpanId: "r".repeat(16) }),
      ],
    } as unknown as TraceSessionFile;
    const spans = (traceSessionToOtlp(session) as any).resourceSpans[0].scopeSpans[0].spans as any[];
    expect(spans.map((s) => s.spanId).filter((id) => id === "a".repeat(16))).toHaveLength(1);
    expect(spans.find((s) => s.spanId === "a".repeat(16)).parentSpanId).toBe("b".repeat(16));
    expect(spans.filter((s) => s.spanId === "c".repeat(16))).toHaveLength(2);
    expect(spans).toHaveLength(1 + 4);
  });
});

describe("sub-agent tracing: sinks carry both records of a paused span", () => {
  const dangerous = () => createTool({ name: "dangerous", description: "needs approval", schema: z.object({}), needsApproval: true, func: async () => "executed" });
  const roundTrip = (state: any) => restoreSnapshot(JSON.parse(JSON.stringify(captureSnapshot(state)))) as any;
  const agentFor = (tracing: any) => createSmartAgent({
    name: "parent",
    model: scripted("parent", [{ tool_calls: [call("p1", "delegate_to", { subagent: "once", input: "go" })] }, { content: "parent-done" }]),
    subagents: [{ name: "once", header: "h", model: scripted("child", [{ tool_calls: [call("c1", "dangerous")] }, { content: "final" }]), tools: [dangerous()] }],
    summarization: false, tracing,
  });

  it("the file sink's continued file holds the pending and the final record, in sequence order, and the summary counts both", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "subagent-trace-"));
    try {
      const parent = agentFor({ enabled: true, sink: fileSink(dir) });
      const paused: any = await parent.invoke({ messages: [{ role: "user", content: "go" }] } as any);
      const state = roundTrip(paused.state);
      const pending = state.pendingApprovals.find((x: any) => x.status === "pending");
      await parent.invoke(parent.resolveToolApproval(state, { id: pending.id, approved: true, decidedBy: "ops" }) as any);
      const found: string[] = [];
      const walk = (d: string) => { for (const f of fs.readdirSync(d)) { const p = path.join(d, f); if (fs.statSync(p).isDirectory()) walk(p); else found.push(p); } };
      walk(dir);
      const file = found.filter((f) => f.endsWith("trace.session.json"));
      expect(file).toHaveLength(1);
      const session = JSON.parse(fs.readFileSync(file[0], "utf8")) as TraceSessionFile;
      const spans = session.events.filter((e) => e.type === "span");
      expect(spans.map((s) => s.status)).toEqual(["pending", "success"]);
      expect(spans[0].spanId).toBe(spans[1].spanId);
      expect(session.events.map((e) => e.sequence)).toEqual([...session.events.map((e) => e.sequence)].sort((a, b) => a - b));
      expect(session.summary.eventCounts.span).toBe(2);
      expect(foldSupersededSpans(session.events).filter((e) => e.type === "span")).toHaveLength(1);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("streaming mode delivers the pending record in the first leg and the final one, same id, in the last", async () => {
    const seen: Array<{ leg: number; event: TraceEventRecord }> = [];
    let leg = 1;
    const tracing = { enabled: true, mode: "streaming" as const, sink: customSink({ onEvent: (event) => { seen.push({ leg, event }); }, onSession: () => {} }) };
    const parent = agentFor(tracing);
    const paused: any = await parent.invoke({ messages: [{ role: "user", content: "go" }] } as any);
    leg = 2;
    const state = roundTrip(paused.state);
    const pending = state.pendingApprovals.find((x: any) => x.status === "pending");
    await parent.invoke(parent.resolveToolApproval(state, { id: pending.id, approved: true, decidedBy: "ops" }) as any);
    const spans = seen.filter((x) => x.event.type === "span");
    expect(spans.map((x) => [x.leg, x.event.status])).toEqual([[1, "pending"], [2, "success"]]);
    expect(spans[0].event.spanId).toBe(spans[1].event.spanId);
  });
});
