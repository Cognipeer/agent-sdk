/**
 * `SubagentDef.dispatch`: a host that runs a sub-agent's task itself (for example
 * in the background) instead of the SDK running a child in process.
 */

import { describe, it, expect } from "vitest";
import { createSmartAgent } from "../../src/index.js";
import type { SubagentDef, SubagentDispatchCall } from "../../src/index.js";
import type { Message, SmartAgentEvent } from "../../src/types.js";

function leafModel(content: string, calls?: { count: number }) {
  return {
    modelName: "leaf",
    bindTools() { return this; },
    async invoke(_msgs: Message[]) {
      if (calls) calls.count += 1;
      return { role: "assistant", content };
    },
  } as any;
}

/** Parent that calls one tool on the first turn, then finishes once a tool result exists. */
function callsToolThenDone(toolName: string, args: any, seen?: { system?: string }) {
  return {
    modelName: "parent",
    bindTools() { return this; },
    async invoke(msgs: Message[]) {
      if (seen) {
        const system = msgs.find((m) => m.role === "system");
        if (system && typeof system.content === "string") seen.system = system.content;
      }
      if (msgs.some((m) => m.role === "tool")) return { role: "assistant", content: "parent-done" };
      return {
        role: "assistant",
        content: "",
        tool_calls: [{ id: "p1", type: "function", function: { name: toolName, arguments: JSON.stringify(args) } }],
      };
    },
  } as any;
}

function toolResult(res: any): any {
  const toolMsg = res.messages.find((m: any) => m.role === "tool");
  expect(toolMsg).toBeDefined();
  return JSON.parse((toolMsg as any).content);
}

describe("subagent dispatch", () => {
  it("delegate_to hands the task to dispatch and returns what it reports, without running a child", async () => {
    const childCalls = { count: 0 };
    const calls: SubagentDispatchCall[] = [];
    const researcher: SubagentDef = {
      name: "researcher",
      header: "answers research questions",
      model: leafModel("in-process-result", childCalls),
      metadata: { kind: "ref", agentKey: "research-agent" },
      dispatch: async (call) => {
        calls.push(call);
        return { status: "started", content: "Started in the background (task bg_1)." };
      },
    };
    const events: SmartAgentEvent[] = [];
    const seen: { system?: string } = {};
    const parent = createSmartAgent({
      name: "parent",
      model: callsToolThenDone("delegate_to", { subagent: "researcher", input: "find X" }, seen),
      subagents: [researcher],
      summarization: false,
    });

    const res = await parent.invoke({ messages: [{ role: "user", content: "go" }] } as any, { onEvent: (e) => events.push(e) });
    const parsed = toolResult(res);
    expect(parsed.status).toBe("started");
    expect(parsed.content).toBe("Started in the background (task bg_1).");
    expect(childCalls.count).toBe(0);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ name: "researcher", input: "find X", parentToolCallId: "p1", parallel: false, depth: 1, metadata: { kind: "ref", agentKey: "research-agent" } });
    expect(calls[0].spawnId).toMatch(/^sa_/);
    // One start and one terminal event, so a host never sees a start that never ends.
    const lifecycle = events.filter((e: any) => e.type === "subagent").map((e: any) => `${e.phase}:${e.status ?? ""}`);
    expect(lifecycle).toEqual(["start:", "result:started"]);
    // The model is told what "started" means only when a sub-agent can be dispatched.
    expect(seen.system).toContain('status "started"');
    expect(res.content).toBe("parent-done");
  });

  it("runs the child in process when dispatch returns null", async () => {
    const researcher: SubagentDef = {
      name: "researcher",
      header: "answers research questions",
      model: leafModel("in-process-result"),
      dispatch: () => null,
    };
    const parent = createSmartAgent({
      name: "parent",
      model: callsToolThenDone("delegate_to", { subagent: "researcher", input: "find X" }),
      subagents: [researcher],
      summarization: false,
    });

    const parsed = toolResult(await parent.invoke({ messages: [{ role: "user", content: "go" }] } as any));
    expect(parsed.status).toBe("ok");
    expect(parsed.content).toBe("in-process-result");
  });

  it("ends the task as error when dispatch throws", async () => {
    const researcher: SubagentDef = {
      name: "researcher",
      header: "answers research questions",
      model: leafModel("in-process-result"),
      dispatch: async () => { throw new Error("queue unavailable"); },
    };
    const parent = createSmartAgent({
      name: "parent",
      model: callsToolThenDone("delegate_to", { subagent: "researcher", input: "find X" }),
      subagents: [researcher],
      summarization: false,
    });

    const parsed = toolResult(await parent.invoke({ messages: [{ role: "user", content: "go" }] } as any));
    expect(parsed.status).toBe("error");
    expect(parsed.error).toContain("queue unavailable");
  });

  it("dispatches each task of a parallel fan-out on its own", async () => {
    const calls: SubagentDispatchCall[] = [];
    const dispatched: SubagentDef = {
      name: "writer",
      header: "writes",
      model: leafModel("never"),
      dispatch: (call) => {
        calls.push(call);
        return { status: "started", content: `started ${call.input}` };
      },
    };
    const local: SubagentDef = { name: "checker", header: "checks", model: leafModel("checked") };
    const parent = createSmartAgent({
      name: "parent",
      model: callsToolThenDone("spawn_subagents_parallel", {
        tasks: [
          { subagent: "writer", input: "a" },
          { subagent: "checker", input: "b" },
          { subagent: "writer", input: "c" },
        ],
      }),
      subagents: [dispatched, local],
      summarization: false,
    });

    const parsed = toolResult(await parent.invoke({ messages: [{ role: "user", content: "go" }] } as any));
    expect(parsed.results.map((r: any) => r.status)).toEqual(["started", "ok", "started"]);
    expect(parsed.results[1].content).toBe("checked");
    expect(calls.map((c) => [c.input, c.parallel, c.parentToolCallId])).toEqual([
      ["a", true, "p1#0"],
      ["c", true, "p1#2"],
    ]);
  });

  it("does not mention the started status when no sub-agent can be dispatched", async () => {
    const seen: { system?: string } = {};
    const parent = createSmartAgent({
      name: "parent",
      model: callsToolThenDone("delegate_to", { subagent: "researcher", input: "find X" }, seen),
      subagents: [{ name: "researcher", header: "answers", model: leafModel("r") }],
      summarization: false,
    });
    await parent.invoke({ messages: [{ role: "user", content: "go" }] } as any);
    expect(seen.system).toBeDefined();
    expect(seen.system).not.toContain('status "started"');
  });
});
