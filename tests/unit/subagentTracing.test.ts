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
import { z } from "zod";
import { createAgent, createSmartAgent, createTool } from "../../src/index.js";
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

/** Every parent resolves, span ids and sequences are unique, sequences only rise. */
function assertTree({ events, sessions }: ReturnType<typeof capture>) {
  const rootSpanId = sessions[0]?.rootSpanId;
  const ids = new Set(events.map((e) => e.spanId));
  expect(ids.size).toBe(events.length);
  const sequences = events.map((e) => e.sequence);
  expect(new Set(sequences).size).toBe(sequences.length);
  expect([...sequences].sort((a, b) => a - b)).toEqual(sequences);
  for (const e of events) {
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

  it("3. a child paused for approval records one segment per leg, with the human steps once", async () => {
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

    const spans = agentSpans(events);
    expect(spans).toHaveLength(2);
    const [first, second] = spans;
    expect(first.status).toBe("pending");
    expect(second.status).toBe("success");
    const parentIterationIds = new Set(events.filter((e) => e.type === "agent_iteration" && e.actor?.name === "parent").map((e) => e.spanId));
    expect(parentIterationIds.has(first.parentSpanId!)).toBe(true);
    const delegates = events.filter((e) => e.type === "tool_call" && e.label?.startsWith("Tool Execution - delegate_to"));
    expect(delegates).toHaveLength(1);
    expect(second.parentSpanId).toBe(delegates[0].spanId);
    expect(first.spanId).not.toBe(second.spanId);
    expect(metaOf(first).id).toBe(metaOf(second).id);
    expect(metaOf(first).status).toBe("paused");
    expect(metaOf(second).status).toBe("ok");

    const lifecycle = live.filter((e) => e.type === "subagent");
    expect(lifecycle.map((e) => e.phase)).toEqual(["start", "paused", "result"]);
    expect(new Set(lifecycle.map((e) => e.id))).toEqual(new Set([metaOf(first).id]));

    const approvals = events.filter((e) => e.type === "tool_approval");
    expect(approvals).toHaveLength(2);
    expect(approvals.map((e) => e.status)).toEqual(["pending", "success"]);
    expect(ancestorsOf(approvals[0], events).some((e) => e.spanId === first.spanId)).toBe(true);
    expect(ancestorsOf(approvals[1], events).some((e) => e.spanId === second.spanId)).toBe(true);
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
