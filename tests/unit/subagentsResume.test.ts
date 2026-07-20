/**
 * Regression coverage for the sub-agent pause/resume + budget fixes:
 *  - #1  a delegating tool paused for HITL alongside a completing sibling tool
 *        resumes correctly (previously threw on resume).
 *  - #5/#6 two concurrent sub-agent question pauses drain iteratively.
 *  - #2  an ad-hoc (spawn_subagent) child keeps its borrowed tools on resume.
 *  - #10 the parallel spawn budget is not charged for invalid tasks.
 */
import { describe, it, expect } from "vitest";
import { z } from "zod";
import { createSmartAgent, createTool } from "../../src/index.js";
import type { Message, SubagentDef } from "../../src/types.js";

const question = "Proceed?";

function askerChild() {
  return {
    modelName: "child",
    bindTools() { return this; },
    async invoke(msgs: Message[]) {
      if (msgs.some((m) => m.role === "tool")) return { role: "assistant", content: "child-after-answer" };
      return { role: "assistant", content: "", tool_calls: [{ id: "q1", type: "function", function: { name: "ask_user_question", arguments: JSON.stringify({ questions: [{ question, options: [{ label: "Yes" }, { label: "No" }] }] }) } }] };
    },
  } as any;
}

describe("subagents × resume", () => {
  it("#1 resumes a delegating sub-agent even when a sibling tool completes in the same turn", async () => {
    const sibling = createTool({ name: "sibling_tool", description: "quick", schema: z.object({}), func: async () => "sibling-ok" });
    const asker: SubagentDef = { name: "asker", header: "asks", model: askerChild() };
    const parentModel = {
      modelName: "parent", bindTools() { return this; },
      async invoke(msgs: Message[]) {
        if (msgs.some((m: any) => m.role === "tool" && m.name === "delegate_to")) return { role: "assistant", content: "parent-done" };
        return { role: "assistant", content: "", tool_calls: [
          { id: "p1", type: "function", function: { name: "delegate_to", arguments: JSON.stringify({ subagent: "asker", input: "ask it" }) } },
          { id: "p2", type: "function", function: { name: "sibling_tool", arguments: "{}" } },
        ] };
      },
    } as any;
    const parent = createSmartAgent({ name: "parent", model: parentModel, tools: [sibling], subagents: [asker], humanInTheLoop: { askUser: true }, summarization: false, limits: { maxToolCalls: 20, maxParallelTools: 4 } as any });

    const paused = await parent.invoke({ messages: [{ role: "user", content: "go" }] } as any);
    const pend = (paused.state?.pendingUserQuestions || []).filter((q: any) => q.status === "pending");
    expect(pend.length).toBe(1);
    const done = await parent.invoke(parent.resolveUserQuestion(paused.state!, { id: pend[0].id, answers: { [question]: { values: ["Yes"] } } }) as any);
    const delegateMsg = done.messages.find((m: any) => m.role === "tool" && m.name === "delegate_to");
    expect(delegateMsg).toBeDefined();
    expect(JSON.parse((delegateMsg as any).content).content).toBe("child-after-answer");
    expect(done.content).toBe("parent-done");
  });

  it("#5/#6 two concurrent sub-agent question pauses drain iteratively", async () => {
    const a: SubagentDef = { name: "qa", header: "asks", model: askerChild() };
    const b: SubagentDef = { name: "qb", header: "asks", model: askerChild() };
    const parentModel = {
      modelName: "parent", bindTools() { return this; },
      async invoke(msgs: Message[]) {
        const done = msgs.filter((m: any) => m.role === "tool" && m.name === "delegate_to").length;
        if (done >= 2) return { role: "assistant", content: "parent-done" };
        if (done === 0 && !msgs.some((m: any) => m.role === "tool")) {
          return { role: "assistant", content: "", tool_calls: [
            { id: "d1", type: "function", function: { name: "delegate_to", arguments: JSON.stringify({ subagent: "qa", input: "ask a" }) } },
            { id: "d2", type: "function", function: { name: "delegate_to", arguments: JSON.stringify({ subagent: "qb", input: "ask b" }) } },
          ] };
        }
        return { role: "assistant", content: "parent-done" };
      },
    } as any;
    const parent = createSmartAgent({ name: "parent", model: parentModel, subagents: [a, b], humanInTheLoop: { askUser: true }, summarization: false, limits: { maxToolCalls: 20, maxParallelTools: 4 } as any });

    let res: any = await parent.invoke({ messages: [{ role: "user", content: "go" }] } as any);
    let guard = 0;
    while (guard++ < 6) {
      const pend = (res.state?.pendingUserQuestions || []).filter((q: any) => q.status === "pending");
      if (pend.length === 0) break;
      res = await parent.invoke(parent.resolveUserQuestion(res.state!, { id: pend[0].id, answers: { [question]: { values: ["Yes"] } } }) as any);
    }
    const delegateMsgs = res.messages.filter((m: any) => m.role === "tool" && m.name === "delegate_to");
    expect(delegateMsgs.length).toBe(2);
    for (const m of delegateMsgs) expect(JSON.parse(m.content).content).toBe("child-after-answer");
    expect(res.content).toBe("parent-done");
  });

  it("#2 an ad-hoc (spawn_subagent) child keeps its borrowed tools after a HITL resume", async () => {
    const runQuery = createTool({ name: "run_query", description: "runs a query", schema: z.object({}), func: async () => "query-result" });
    // One hybrid model serves both parent and ad-hoc child; the child is
    // identified by the "DBTASK" marker seeded into its input. The ad-hoc child
    // uses the PARENT model (model-agnostic), so this exercises specFromAdhoc's
    // resume path where borrowed tool names live on the durable record.
    const hybrid = {
      modelName: "m", bindTools() { return this; },
      async invoke(msgs: Message[]) {
        const isChild = msgs.some((m: any) => m.role === "user" && typeof m.content === "string" && m.content.includes("DBTASK"));
        if (isChild) {
          if (msgs.some((m: any) => m.role === "tool" && m.name === "run_query")) return { role: "assistant", content: "child-done-with-query" };
          if (msgs.some((m: any) => m.role === "tool" && m.name === "ask_user_question")) {
            return { role: "assistant", content: "", tool_calls: [{ id: "rq", type: "function", function: { name: "run_query", arguments: "{}" } }] };
          }
          return { role: "assistant", content: "", tool_calls: [{ id: "q1", type: "function", function: { name: "ask_user_question", arguments: JSON.stringify({ questions: [{ question, options: [{ label: "Yes" }, { label: "No" }] }] }) } }] };
        }
        if (msgs.some((m: any) => m.role === "tool" && m.name === "spawn_subagent")) return { role: "assistant", content: "parent-done" };
        return { role: "assistant", content: "", tool_calls: [{ id: "s1", type: "function", function: { name: "spawn_subagent", arguments: JSON.stringify({ role: "db", prompt: "you are a db analyst", input: "handle DBTASK", tools: ["run_query"] }) } }] };
      },
    } as any;
    const parent = createSmartAgent({ name: "parent", model: hybrid, tools: [runQuery], subagentPolicy: { mode: "registry_and_adhoc", maxDepth: 2, maxChildCalls: 8, maxParallel: 4, childContextPolicy: "scoped", allowAdhocTools: true }, humanInTheLoop: { askUser: true }, summarization: false });

    const paused = await parent.invoke({ messages: [{ role: "user", content: "go" }] } as any);
    const pend = (paused.state?.pendingUserQuestions || []).filter((q: any) => q.status === "pending");
    expect(pend.length).toBe(1);
    const done = await parent.invoke(parent.resolveUserQuestion(paused.state!, { id: pend[0].id, answers: { [question]: { values: ["Yes"] } } }) as any);
    const spawnMsg = done.messages.find((m: any) => m.role === "tool" && m.name === "spawn_subagent");
    expect(spawnMsg).toBeDefined();
    // The borrowed run_query must have executed after resume (not "Tool not found").
    expect(JSON.parse((spawnMsg as any).content).content).toBe("child-done-with-query");
  });

  it("#16 keeps parallel results index-aligned when children finish out of order", async () => {
    const leafDelay = (content: string, ms: number) => ({
      modelName: "leaf", bindTools() { return this; },
      async invoke() { await new Promise((r) => setTimeout(r, ms)); return { role: "assistant", content }; },
    } as any);
    // Task 0 (slow) finishes LAST; task 1 (fast) finishes first. Results must
    // still be ordered by task index, not completion order.
    const slow: SubagentDef = { name: "slow", header: "slow", model: leafDelay("SLOW", 40) };
    const fast: SubagentDef = { name: "fast", header: "fast", model: leafDelay("FAST", 1) };
    const parentModel = {
      modelName: "parent", bindTools() { return this; },
      async invoke(msgs: Message[]) {
        if (msgs.some((m: any) => m.role === "tool")) return { role: "assistant", content: "parent-done" };
        return { role: "assistant", content: "", tool_calls: [{ id: "par", type: "function", function: { name: "spawn_subagents_parallel", arguments: JSON.stringify({ tasks: [{ subagent: "slow", input: "a" }, { subagent: "fast", input: "b" }] }) } }] };
      },
    } as any;
    const parent = createSmartAgent({ name: "parent", model: parentModel, subagents: [slow, fast], summarization: false, limits: { maxToolCalls: 10, maxParallelTools: 2 } as any });
    const res = await parent.invoke({ messages: [{ role: "user", content: "go" }] } as any);
    const toolMsg = res.messages.find((m: any) => m.role === "tool" && m.name === "spawn_subagents_parallel");
    const parsed = JSON.parse((toolMsg as any).content);
    expect(parsed.results.map((r: any) => r.content)).toEqual(["SLOW", "FAST"]);
    expect(parsed.results.map((r: any) => r.name)).toEqual(["slow", "fast"]);
  });

  it("#10 does not charge the spawn budget for invalid parallel tasks", async () => {
    const valid: SubagentDef = { name: "valid", header: "ok", model: { modelName: "leaf", bindTools() { return this; }, async invoke() { return { role: "assistant", content: "V" }; } } as any };
    const parentModel = {
      modelName: "parent", bindTools() { return this; },
      async invoke(msgs: Message[]) {
        const delegated = msgs.some((m: any) => m.role === "tool" && m.name === "delegate_to");
        if (delegated) return { role: "assistant", content: "parent-done" };
        const ranParallel = msgs.some((m: any) => m.role === "tool" && m.name === "spawn_subagents_parallel");
        if (!ranParallel) {
          return { role: "assistant", content: "", tool_calls: [{ id: "par", type: "function", function: { name: "spawn_subagents_parallel", arguments: JSON.stringify({ tasks: [{ subagent: "valid", input: "a" }, { subagent: "does-not-exist", input: "b" }] }) } }] };
        }
        // Only ONE real child ran, so with maxChildCalls=2 a follow-up delegate must be allowed.
        return { role: "assistant", content: "", tool_calls: [{ id: "del", type: "function", function: { name: "delegate_to", arguments: JSON.stringify({ subagent: "valid", input: "c" }) } }] };
      },
    } as any;
    const parent = createSmartAgent({ name: "parent", model: parentModel, subagents: [valid], subagentPolicy: { mode: "registry_and_adhoc", maxDepth: 2, maxChildCalls: 2, maxParallel: 4, childContextPolicy: "minimal", allowAdhocTools: true }, summarization: false, limits: { maxToolCalls: 20, maxParallelTools: 2 } as any });

    const res = await parent.invoke({ messages: [{ role: "user", content: "go" }] } as any);
    const delegateMsg = res.messages.find((m: any) => m.role === "tool" && m.name === "delegate_to");
    expect(delegateMsg).toBeDefined();
    const parsed = JSON.parse((delegateMsg as any).content);
    // The follow-up delegate must have run (content "V"), not been refused for budget.
    expect(parsed.content).toBe("V");
    expect((delegateMsg as any).content).not.toContain("budget");
  });
});
