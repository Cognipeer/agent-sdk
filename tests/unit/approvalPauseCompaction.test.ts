/**
 * A run that pauses for a human must not be compacted on top of the open call.
 *
 * The model asks for two tools in one turn: `fetch`, which runs, and `publish`,
 * which needs an approval. The leg pauses with `publish` unanswered. If the
 * context is over the summarization threshold at that point, the driver used to
 * run its post-tools pass anyway. The pass appends its `summarize_context`
 * exchange AFTER the assistant turn that owns `publish`, and that BURIES the
 * call: on the approval resume `selectPendingToolCalls` walks back only to the
 * most recent assistant turn, finds the synthetic summary turn fully resolved,
 * and reports nothing pending. The loop breaks having made zero model calls, the
 * approved tool never runs, and the dangling-tool-response guard reports it as
 * "a model provider error or exhausted iteration budget", neither of which
 * happened. (Same class as the preopen-skills case in preopenSkillsOnResume.)
 *
 * Two fixes, two groups below:
 *  - the driver does not compact while the transcript ends inside an unfinished
 *    tool exchange (pause, or a resume about to run the approved call);
 *  - a transcript persisted in the buried shape by an earlier version is
 *    repaired when the run resumes, so paused conversations already stored that
 *    way do not fail on approve.
 */
import { describe, it, expect } from "vitest";
import { z } from "zod";
import { createSmartAgent, createTool } from "../../src/index.js";
import { hasUnresolvedToolCalls, unburyPendingToolCalls } from "../../src/utils/pendingToolCalls.js";
import type { Message } from "../../src/types.js";

const BIG = "Detailed archived payload ".repeat(160);
const SUMMARY_JSON = JSON.stringify({
  user_directives: [],
  stable_facts: [],
  active_goals: ["publish the release"],
  open_questions: [],
  discarded_obsolete: [],
  rawSummary: "fetched a, b and c",
});

const call = (name: string, args: Record<string, unknown> = {}, id = `c_${name}`) => ({
  id,
  type: "function" as const,
  function: { name, arguments: JSON.stringify(args) },
});

const isSummarizerCall = (messages: Message[]) => {
  const first = messages[0];
  return first?.role === "system" && typeof first.content === "string"
    && first.content.includes("summarizes conversation history efficiently");
};

/** Agent turns follow `script`; summarizer calls are answered with SUMMARY_JSON and counted apart. */
function scriptedModel(script: Array<{ content?: string; tool_calls?: any[] }>, log: { agentCalls: Message[][]; summaryCalls: number }) {
  const model: any = {
    modelName: "scripted",
    bindTools() {
      return model;
    },
    async invoke(messages: Message[]) {
      if (isSummarizerCall(messages)) {
        log.summaryCalls += 1;
        return { role: "assistant", content: SUMMARY_JSON };
      }
      const step = script[Math.min(log.agentCalls.length, script.length - 1)];
      log.agentCalls.push(JSON.parse(JSON.stringify(messages)));
      const msg: any = { role: "assistant", content: step.content ?? "" };
      if (step.tool_calls) msg.tool_calls = step.tool_calls;
      return msg as Message;
    },
  };
  return model;
}

function tools(counter: { published: number; statusSet: number }) {
  return [
    createTool({
      name: "fetch",
      description: "Fetch a document.",
      schema: z.object({ id: z.string() }),
      func: async ({ id }) => `${id}: ${BIG}`,
    }),
    createTool({
      name: "set_status",
      description: "Set a document's status.",
      schema: z.object({}).strict(),
      needsApproval: true,
      func: async () => {
        counter.statusSet += 1;
        return `status set: ${BIG}`;
      },
    }),
    createTool({
      name: "publish",
      description: "Publish the release.",
      schema: z.object({}).strict(),
      needsApproval: true,
      func: async () => {
        counter.published += 1;
        return "published";
      },
    }),
  ];
}

/** Every assistant turn with tool_calls is followed directly by exactly its results (what providers require). */
function expectWellPaired(messages: Message[]) {
  messages.forEach((m: any, index) => {
    const calls = Array.isArray(m.tool_calls) ? m.tool_calls : [];
    if (m.role !== "assistant" || calls.length === 0) return;
    const open = new Set(calls.map((c: any) => String(c.id)));
    let next = index + 1;
    while ((messages[next] as any)?.role === "tool") {
      expect(open.has(String((messages[next] as any).tool_call_id))).toBe(true);
      open.delete(String((messages[next] as any).tool_call_id));
      next += 1;
    }
    expect([...open]).toEqual([]);
  });
}

const pendingOf = (state: any) => (state?.pendingApprovals || []).filter((a: any) => a.status === "pending");
const persist = (state: any) => JSON.parse(JSON.stringify({ ...state, agent: undefined }));

describe("summarization while a run waits for an approval", () => {
  const summarization = { enable: true, maxTokens: 350, summaryPromptMaxTokens: 2000 };
  const history = [
    { tool_calls: [call("fetch", { id: "a" }, "c_a")] },
    { tool_calls: [call("fetch", { id: "b" }, "c_b")] },
  ];

  /** Approves every pending call, one resume at a time, and records how each paused transcript ends. */
  async function approveUntilDone(agent: any, first: any) {
    let result = first;
    const pauses: Array<{ tail: any; open: boolean }> = [];
    for (let guard = 0; guard < 5; guard += 1) {
      const pending = pendingOf(result.state);
      if (pending.length === 0) break;
      const persisted = persist(result.state);
      pauses.push({ tail: persisted.messages.at(-1), open: hasUnresolvedToolCalls(persisted.messages) });
      const resolved = agent.resolveToolApproval(persisted, { id: pending[0].id, approved: true });
      result = await agent.invoke(resolved);
    }
    return { result, pauses };
  }

  function setup(script: Array<{ content?: string; tool_calls?: any[] }>) {
    const counter = { published: 0, statusSet: 0 };
    const log = { agentCalls: [] as Message[][], summaryCalls: 0 };
    const agent = createSmartAgent({
      model: scriptedModel(script, log),
      tools: tools(counter),
      summarization,
      limits: { maxToolCalls: 10 },
    } as never);
    return { agent, counter, log };
  }

  it("the open call is the paused turn itself: it runs on resume", async () => {
    const { agent, counter, log } = setup([
      ...history,
      { tool_calls: [call("fetch", { id: "c" }, "c_c"), call("publish", {}, "c_publish")] },
      { content: "published" },
    ]);

    const paused = await agent.invoke({ messages: [{ role: "user", content: "Fetch a, b and c, then publish." }] } as never);
    const { result, pauses } = await approveUntilDone(agent, paused);

    expect(pauses).toHaveLength(1);
    // Nothing was appended after the open turn while it waited.
    expect(pauses[0].open).toBe(true);
    expect(pauses[0].tail.tool_calls?.map((c: any) => c.id)).toEqual(["c_c", "c_publish"]);
    expect(counter.published).toBe(1);
    expect(result.content).toBe("published");
    for (const sent of log.agentCalls) expectWellPaired(sent);
  });

  it("a sibling ran first (the production shape): the second approved call still runs", async () => {
    // Both calls ask first. The first is approved and runs, its large result
    // puts the context over the threshold, and the leg pauses again on the
    // second with the transcript ending on the sibling's tool result.
    const { agent, counter, log } = setup([
      ...history,
      { tool_calls: [call("set_status", {}, "c_status"), call("publish", {}, "c_publish")] },
      { content: "published" },
    ]);

    const paused = await agent.invoke({ messages: [{ role: "user", content: "Fetch a and b, set the status, then publish." }] } as never);
    const { result, pauses } = await approveUntilDone(agent, paused);

    expect(pauses.length).toBeGreaterThanOrEqual(2);
    const last = pauses.at(-1)!;
    expect(last.open).toBe(true);
    expect(last.tail).toMatchObject({ role: "tool", tool_call_id: "c_status" });
    expect(counter.statusSet).toBe(1);
    expect(counter.published).toBe(1);
    expect(result.content).toBe("published");
    for (const sent of log.agentCalls) expectWellPaired(sent);
  });

  it("still compacts once the open exchange is finished", async () => {
    // The guard is about WHERE the pass lands, not about turning it off: with
    // the approved call answered the next pass runs as before.
    const { agent, log } = setup([
      ...history,
      { tool_calls: [call("set_status", {}, "c_status")] },
      { tool_calls: [call("fetch", { id: "c" }, "c_c")] },
      { content: "done" },
    ]);

    const paused = await agent.invoke({ messages: [{ role: "user", content: "Fetch a and b, set the status, fetch c." }] } as never);
    const summariesBeforeResume = log.summaryCalls;
    const { result } = await approveUntilDone(agent, paused);

    expect(summariesBeforeResume).toBeGreaterThanOrEqual(1);
    expect(log.summaryCalls).toBeGreaterThan(summariesBeforeResume);
    expect(result.content).toBe("done");
  });
});

describe("a transcript stored in the buried shape by an earlier version", () => {
  it("is repaired on resume: the approved tool runs and the provider sees valid pairs", async () => {
    const counter = { published: 0, statusSet: 0 };
    const log = { agentCalls: [] as Message[][], summaryCalls: 0 };
    const script = [
      { tool_calls: [call("fetch", { id: "c" }, "c_c"), call("publish", {}, "c_publish")] },
      { content: "published" },
    ];
    const agent = createSmartAgent({
      model: scriptedModel(script, log),
      tools: tools(counter),
      summarization: false,
    } as never);

    const paused = await agent.invoke({ messages: [{ role: "user", content: "Fetch c, then publish." }] } as never);
    const persisted = persist(paused.state);
    // What 0.22 and earlier stored: the summary exchange appended after the open turn.
    persisted.messages.push(
      { role: "assistant", content: "Context limit reached. Summarizing conversation history to reduce token usage.", tool_calls: [{ id: "sum_1", type: "function", function: { name: "summarize_context", arguments: "{}" } }] },
      { role: "tool", tool_call_id: "sum_1", name: "summarize_context", content: "fetched c" },
    );

    const resolved = agent.resolveToolApproval(persisted as never, { id: pendingOf(paused.state)[0].id, approved: true });
    const done = await agent.invoke(resolved as never);

    expect(counter.published).toBe(1);
    expect(done.content).toBe("published");
    for (const sent of log.agentCalls) expectWellPaired(sent);
    // The summary exchange is kept, ahead of the turn it had buried.
    const order = done.messages.map((m: any) => m.tool_call_id || m.tool_calls?.map((c: any) => c.id).join(",") || m.role);
    expect(order.indexOf("sum_1")).toBeLessThan(order.indexOf("c_c,c_publish"));
  });
});

describe("unburyPendingToolCalls", () => {
  const summaryPair = [
    { role: "assistant", content: "", tool_calls: [{ id: "sum_1", type: "function", function: { name: "summarize_context", arguments: "{}" } }] },
    { role: "tool", tool_call_id: "sum_1", name: "summarize_context", content: "s" },
  ];

  it("leaves a transcript alone when nothing is open behind the summary", () => {
    const messages = [
      { role: "user", content: "hi" },
      { role: "assistant", content: "", tool_calls: [{ id: "c1", type: "function", function: { name: "fetch", arguments: "{}" } }] },
      { role: "tool", tool_call_id: "c1", name: "fetch", content: "x" },
      ...summaryPair,
    ];
    expect(unburyPendingToolCalls(messages)).toBe(messages);
  });

  it("leaves a transcript alone when it does not end on a summary exchange", () => {
    const messages = [
      { role: "user", content: "hi" },
      { role: "assistant", content: "", tool_calls: [{ id: "c1", type: "function", function: { name: "publish", arguments: "{}" } }] },
    ];
    expect(unburyPendingToolCalls(messages)).toBe(messages);
  });

  it("moves trailing summary exchanges in front of the turn whose calls are still open", () => {
    const open = { role: "assistant", content: "", tool_calls: [{ id: "c1", type: "function", function: { name: "fetch", arguments: "{}" } }, { id: "c2", type: "function", function: { name: "publish", arguments: "{}" } }] };
    const done = { role: "tool", tool_call_id: "c1", name: "fetch", content: "x" };
    const second = [
      { role: "assistant", content: "", tool_calls: [{ id: "sum_2", type: "function", function: { name: "summarize_context", arguments: "{}" } }] },
      { role: "tool", tool_call_id: "sum_2", name: "summarize_context", content: "s2" },
    ];
    const user = { role: "user", content: "go" };
    const repaired = unburyPendingToolCalls([user, open, done, ...summaryPair, ...second]);
    expect(repaired).toEqual([user, ...summaryPair, ...second, open, done]);
  });

  it("hasUnresolvedToolCalls ignores open calls a newer user turn has moved past", () => {
    const messages = [
      { role: "assistant", content: "", tool_calls: [{ id: "c1", type: "function", function: { name: "publish", arguments: "{}" } }] },
      { role: "user", content: "never mind" },
    ];
    expect(hasUnresolvedToolCalls(messages)).toBe(false);
  });
});
