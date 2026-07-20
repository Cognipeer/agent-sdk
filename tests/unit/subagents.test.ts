/**
 * Sub-agent primitive: registry delegation, ad-hoc spawn, parallel fan-out,
 * event emission, spawn-budget guards, and nested tool-approval pause/resume.
 */

import { describe, it, expect } from "vitest";
import { z } from "zod";
import { createSmartAgent, createTool } from "../../src/index.js";
import type { Message, SmartAgentEvent, SubagentDef } from "../../src/types.js";

function leafModel(content: string) {
  return {
    modelName: "leaf",
    bindTools() { return this; },
    async invoke(_msgs: Message[]) {
      return { role: "assistant", content };
    },
  } as any;
}

/** Parent that calls one tool on the first turn, then finishes once a tool result exists. */
function callsToolThenDone(toolName: string, args: any, done = "parent-done") {
  return {
    modelName: "parent",
    bindTools() { return this; },
    async invoke(msgs: Message[]) {
      if (msgs.some((m) => m.role === "tool")) return { role: "assistant", content: done };
      return {
        role: "assistant",
        content: "",
        tool_calls: [{ id: "p1", type: "function", function: { name: toolName, arguments: JSON.stringify(args) } }],
      };
    },
  } as any;
}

describe("subagents", () => {
  it("delegate_to runs a registry sub-agent and surfaces its result", async () => {
    const researcher: SubagentDef = {
      name: "researcher",
      header: "answers research questions",
      model: leafModel("research-result"),
    };
    const parent = createSmartAgent({
      name: "parent",
      model: callsToolThenDone("delegate_to", { subagent: "researcher", input: "find X" }),
      subagents: [researcher],
      summarization: false,
    });

    const res = await parent.invoke({ messages: [{ role: "user", content: "go" }] } as any);
    const toolMsg = res.messages.find((m: any) => m.role === "tool");
    expect(toolMsg).toBeDefined();
    const parsed = JSON.parse((toolMsg as any).content);
    expect(parsed.content).toBe("research-result");
    expect(parsed.mode).toBe("registry");
    expect(res.content).toBe("parent-done");
  });

  it("spawn_subagent creates an ad-hoc child using the parent model", async () => {
    // One model serves both roles: it branches on message content.
    const hybrid = {
      modelName: "m",
      bindTools() { return this; },
      async invoke(msgs: Message[]) {
        if (msgs.some((m) => m.role === "tool")) return { role: "assistant", content: "parent-done" };
        const lastUser = [...msgs].reverse().find((m) => m.role === "user");
        const text = typeof lastUser?.content === "string" ? lastUser.content : "";
        if (text.includes("SUBTASK")) return { role: "assistant", content: "child-answer" };
        return {
          role: "assistant",
          content: "",
          tool_calls: [{ id: "p1", type: "function", function: { name: "spawn_subagent", arguments: JSON.stringify({ role: "helper", prompt: "be helpful", input: "do SUBTASK" }) } }],
        };
      },
    } as any;

    // Ad-hoc spawning is opt-in: enable it explicitly (no registry sub-agents).
    const parent = createSmartAgent({
      name: "parent",
      model: hybrid,
      subagentPolicy: { mode: "registry_and_adhoc", maxDepth: 2, maxChildCalls: 8, maxParallel: 4, childContextPolicy: "scoped", allowAdhocTools: true },
      summarization: false,
    });
    const res = await parent.invoke({ messages: [{ role: "user", content: "go" }] } as any);
    const toolMsg = res.messages.find((m: any) => m.role === "tool");
    const parsed = JSON.parse((toolMsg as any).content);
    expect(parsed.content).toBe("child-answer");
    expect(parsed.mode).toBe("adhoc");
  });

  it("spawn_subagents_parallel fans out and returns one result per task", async () => {
    const a: SubagentDef = { name: "a", header: "a", model: leafModel("A") };
    const b: SubagentDef = { name: "b", header: "b", model: leafModel("B") };
    const parent = createSmartAgent({
      name: "parent",
      model: callsToolThenDone("spawn_subagents_parallel", { tasks: [{ subagent: "a", input: "ta" }, { subagent: "b", input: "tb" }] }),
      subagents: [a, b],
      summarization: false,
    });

    const res = await parent.invoke({ messages: [{ role: "user", content: "go" }] } as any);
    const toolMsg = res.messages.find((m: any) => m.role === "tool");
    const parsed = JSON.parse((toolMsg as any).content);
    expect(parsed.results).toHaveLength(2);
    expect(parsed.results.map((r: any) => r.content).sort()).toEqual(["A", "B"]);
  });

  it("emits subagent lifecycle events", async () => {
    const child: SubagentDef = { name: "c", header: "c", model: leafModel("ok") };
    const parent = createSmartAgent({
      name: "parent",
      model: callsToolThenDone("delegate_to", { subagent: "c", input: "t" }),
      subagents: [child],
      summarization: false,
    });

    const events: SmartAgentEvent[] = [];
    await parent.invoke({ messages: [{ role: "user", content: "go" }] } as any, { onEvent: (e) => events.push(e) });
    const subEvents = events.filter((e) => e.type === "subagent") as any[];
    expect(subEvents.some((e) => e.phase === "start" && e.name === "c")).toBe(true);
    expect(subEvents.some((e) => e.phase === "result" && e.content === "ok")).toBe(true);
  });

  it("enforces the spawn budget (maxChildCalls)", async () => {
    const a: SubagentDef = { name: "a", header: "a", model: leafModel("A") };
    const b: SubagentDef = { name: "b", header: "b", model: leafModel("B") };
    const parent = createSmartAgent({
      name: "parent",
      model: callsToolThenDone("spawn_subagents_parallel", { tasks: [{ subagent: "a", input: "x" }, { subagent: "b", input: "y" }] }),
      subagents: [a, b],
      subagentPolicy: { mode: "registry_and_adhoc", maxDepth: 2, maxChildCalls: 1, maxParallel: 4, childContextPolicy: "minimal", allowAdhocTools: true },
      summarization: false,
    });

    const res = await parent.invoke({ messages: [{ role: "user", content: "go" }] } as any);
    const toolMsg = res.messages.find((m: any) => m.role === "tool");
    expect((toolMsg as any).content).toContain("budget");
  });

  it("propagates a child tool-approval pause to the parent and resumes after approval", async () => {
    const dangerous = createTool({
      name: "dangerous",
      description: "needs approval",
      schema: z.object({}),
      needsApproval: true,
      func: async () => "executed",
    });
    // Child calls the approval-gated tool first, then answers once it ran.
    const childModel = {
      modelName: "child",
      bindTools() { return this; },
      async invoke(msgs: Message[]) {
        const ranTool = msgs.some((m) => m.role === "tool");
        if (ranTool) return { role: "assistant", content: "child-final" };
        return { role: "assistant", content: "", tool_calls: [{ id: "c1", type: "function", function: { name: "dangerous", arguments: "{}" } }] };
      },
    } as any;

    const risky: SubagentDef = { name: "risky", header: "does risky things", model: childModel, tools: [dangerous] };
    const parent = createSmartAgent({
      name: "parent",
      model: callsToolThenDone("delegate_to", { subagent: "risky", input: "do it" }),
      subagents: [risky],
      summarization: false,
    });

    // First invoke pauses on the child's approval, surfaced at the parent level.
    const paused = await parent.invoke({ messages: [{ role: "user", content: "go" }] } as any);
    expect(paused.state?.pendingApprovals?.length).toBeGreaterThan(0);
    const approval = paused.state!.pendingApprovals![0];
    expect((approval.metadata as any)?.__subagent?.name).toBe("risky");

    // Approve and resume.
    const resolved = parent.resolveToolApproval(paused.state!, { id: approval.id, approved: true });
    const done = await parent.invoke(resolved as any);
    const toolMsg = done.messages.find((m: any) => m.role === "tool" && m.name === "delegate_to");
    expect(toolMsg).toBeDefined();
    const parsed = JSON.parse((toolMsg as any).content);
    expect(parsed.content).toBe("child-final");
  });

  it("propagates a child ask_user_question pause to the parent and resumes after the answer", async () => {
    const question = "Proceed?";
    const childModel = {
      modelName: "child",
      bindTools() { return this; },
      async invoke(msgs: Message[]) {
        const answered = msgs.some((m) => m.role === "tool");
        if (answered) return { role: "assistant", content: "child-after-answer" };
        return { role: "assistant", content: "", tool_calls: [{ id: "q1", type: "function", function: { name: "ask_user_question", arguments: JSON.stringify({ questions: [{ question, options: [{ label: "Yes" }, { label: "No" }] }] }) } }] };
      },
    } as any;

    const asker: SubagentDef = { name: "asker", header: "asks the user", model: childModel };
    const parent = createSmartAgent({
      name: "parent",
      model: callsToolThenDone("delegate_to", { subagent: "asker", input: "ask it" }),
      subagents: [asker],
      humanInTheLoop: { askUser: true },
      summarization: false,
    });

    const paused = await parent.invoke({ messages: [{ role: "user", content: "go" }] } as any);
    expect(paused.state?.pendingUserQuestions?.length).toBeGreaterThan(0);
    const q = paused.state!.pendingUserQuestions![0];
    expect((q.metadata as any)?.__subagent?.name).toBe("asker");

    const resolved = parent.resolveUserQuestion(paused.state!, { id: q.id, answers: { [question]: { values: ["Yes"] } } });
    const done = await parent.invoke(resolved as any);
    const toolMsg = done.messages.find((m: any) => m.role === "tool" && m.name === "delegate_to");
    expect(toolMsg).toBeDefined();
    expect(JSON.parse((toolMsg as any).content).content).toBe("child-after-answer");
  });
});
