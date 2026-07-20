/**
 * Sub-agent resilience: snapshot serialize→resume round-trip across a nested
 * HITL pause, guard refusals, cancellation-token forwarding into children, and
 * partial failure inside a parallel fan-out.
 */
import { describe, it, expect } from "vitest";
import { z } from "zod";
import { createSmartAgent, createTool } from "../../src/index.js";
import type { Message, SubagentDef } from "../../src/types.js";

function leafModel(content: string) {
  return { modelName: "leaf", bindTools() { return this; }, async invoke() { return { role: "assistant", content }; } } as any;
}
function callsToolThenDone(toolName: string, args: any, done = "parent-done") {
  return {
    modelName: "parent",
    bindTools() { return this; },
    async invoke(msgs: Message[]) {
      if (msgs.some((m) => m.role === "tool")) return { role: "assistant", content: done };
      return { role: "assistant", content: "", tool_calls: [{ id: "p1", type: "function", function: { name: toolName, arguments: JSON.stringify(args) } }] };
    },
  } as any;
}

describe("subagents × resilience", () => {
  it("survives a snapshot serialize→deserialize→resume across a nested approval", async () => {
    const dangerous = createTool({ name: "danger", description: "needs approval", schema: z.object({}), needsApproval: true, func: async () => "ran" });
    const childModel = {
      modelName: "child",
      bindTools() { return this; },
      async invoke(msgs: Message[]) {
        if (msgs.some((m) => m.role === "tool")) return { role: "assistant", content: "child-final" };
        return { role: "assistant", content: "", tool_calls: [{ id: "c1", type: "function", function: { name: "danger", arguments: "{}" } }] };
      },
    } as any;
    const risky: SubagentDef = { name: "risky", header: "risky", model: childModel, tools: [dangerous] };
    const agent = createSmartAgent({
      name: "parent",
      model: callsToolThenDone("delegate_to", { subagent: "risky", input: "do it" }),
      subagents: [risky],
      summarization: false,
    });

    const paused = await agent.invoke({ messages: [{ role: "user", content: "go" }] } as any);
    expect(paused.state?.pendingApprovals?.length).toBeGreaterThan(0);

    // Serialize the paused state the way a host would persist it between turns.
    const snapshot = agent.snapshot(paused.state!);
    const roundTripped = JSON.parse(JSON.stringify(snapshot));
    expect(roundTripped.state.ctx.__subagentPending).toBeDefined();

    // Restore, approve at the parent level, and resume.
    const { restoreSnapshot } = await import("../../src/index.js");
    const restored = restoreSnapshot(roundTripped);
    const approvalId = restored.pendingApprovals![0].id;
    const resolved = agent.resolveToolApproval(restored, { id: approvalId, approved: true });
    const done = await agent.invoke(resolved as any);
    const toolMsg = done.messages.find((m: any) => m.role === "tool" && m.name === "delegate_to");
    expect(JSON.parse((toolMsg as any).content).content).toBe("child-final");
  });

  it("refuses delegation past maxDepth", async () => {
    const child: SubagentDef = { name: "deep", header: "deep", model: leafModel("nope") };
    const agent = createSmartAgent({
      name: "parent",
      model: callsToolThenDone("delegate_to", { subagent: "deep", input: "x" }),
      subagents: [child],
      subagentPolicy: { mode: "registry_and_adhoc", maxDepth: 0, maxChildCalls: 8, maxParallel: 4, childContextPolicy: "minimal", allowAdhocTools: true },
      summarization: false,
    });
    const res = await agent.invoke({ messages: [{ role: "user", content: "go" }] } as any);
    expect((res.messages.find((m: any) => m.role === "tool") as any).content).toContain("depth");
  });

  it("rejects an unknown sub-agent name (schema-constrained to the registry)", async () => {
    const child: SubagentDef = { name: "known", header: "known", model: leafModel("ok") };
    const agent = createSmartAgent({
      name: "parent",
      model: callsToolThenDone("delegate_to", { subagent: "ghost", input: "x" }),
      subagents: [child],
      summarization: false,
    });
    const res = await agent.invoke({ messages: [{ role: "user", content: "go" }] } as any);
    // The `subagent` arg is a z.enum over registered names, so an unknown name is
    // rejected at the schema layer before the tool body runs.
    const toolMsg = (res.messages.find((m: any) => m.role === "tool") as any).content;
    expect(toolMsg).toMatch(/validation failed|Unknown sub-agent/i);
  });

  it("forwards the parent cancellation token into the child", async () => {
    let childSawToken = false;
    const childModel = {
      modelName: "child",
      bindTools() { return this; },
      async invoke(_msgs: Message[], opts?: any) {
        if (opts?.cancellationToken || opts?.signal) childSawToken = true;
        return { role: "assistant", content: "ok" };
      },
    } as any;
    const child: SubagentDef = { name: "c", header: "c", model: childModel };
    const agent = createSmartAgent({
      name: "parent",
      model: callsToolThenDone("delegate_to", { subagent: "c", input: "x" }),
      subagents: [child],
      summarization: false,
    });
    const token = { isCancellationRequested: false };
    await agent.invoke({ messages: [{ role: "user", content: "go" }] } as any, { cancellationToken: token as any });
    expect(childSawToken).toBe(true);
  });

  it("isolates a failing task in a parallel fan-out", async () => {
    const ok: SubagentDef = { name: "ok", header: "ok", model: leafModel("OK") };
    const agent = createSmartAgent({
      name: "parent",
      model: callsToolThenDone("spawn_subagents_parallel", { tasks: [{ subagent: "ok", input: "1" }, { subagent: "missing", input: "2" }] }),
      subagents: [ok],
      summarization: false,
    });
    const res = await agent.invoke({ messages: [{ role: "user", content: "go" }] } as any);
    const parsed = JSON.parse((res.messages.find((m: any) => m.role === "tool") as any).content);
    expect(parsed.results).toHaveLength(2);
    expect(parsed.results[0].content).toBe("OK");
    expect(parsed.results[1].error).toContain("Unknown sub-agent");
  });
});
