/**
 * Sub-agent × other-feature intersections. These exercise the primitive
 * together with structured output, borrowed parent tools, guardrails, parallel
 * concurrency, multi-step sequencing, and child failure — the combinations the
 * happy-path suite does not cover.
 */
import { describe, it, expect } from "vitest";
import { z } from "zod";
import { createSmartAgent, createTool } from "../../src/index.js";
import type { Message, SubagentDef, ConversationGuardrail } from "../../src/types.js";
import { GuardrailPhase } from "../../src/types.js";

function leafModel(content: string) {
  return { modelName: "leaf", bindTools() { return this; }, async invoke() { return { role: "assistant", content }; } } as any;
}

/** Parent that calls `toolName` with `args` once, then finishes after a tool result. */
function callsToolThenDone(toolName: string, args: any, done = "parent-done") {
  return {
    modelName: "parent",
    bindTools() { return this; },
    async invoke(msgs: Message[]) {
      if (msgs.some((m) => m.role === "tool")) return { role: "assistant", content: done };
      return { role: "assistant", content: "", tool_calls: [{ id: `c_${Math.min(msgs.length, 9)}`, type: "function", function: { name: toolName, arguments: JSON.stringify(args) } }] };
    },
  } as any;
}

describe("subagents × intersections", () => {
  it("a structured-output child returns parsed output", async () => {
    const child: SubagentDef = {
      name: "extractor",
      header: "extracts structured data",
      outputSchema: z.object({ answer: z.string() }),
      // Returns JSON as content → SDK parses it via the from-text fallback.
      model: leafModel(JSON.stringify({ answer: "42" })),
    };
    const parent = createSmartAgent({
      name: "parent",
      model: callsToolThenDone("delegate_to", { subagent: "extractor", input: "extract" }),
      subagents: [child],
      summarization: false,
    });
    const res = await parent.invoke({ messages: [{ role: "user", content: "go" }] } as any);
    const parsed = JSON.parse((res.messages.find((m: any) => m.role === "tool") as any).content);
    expect(parsed.output).toEqual({ answer: "42" });
  });

  it("a sub-agent executes a borrowed parent tool", async () => {
    let executed = false;
    const lookup = createTool({
      name: "lookup",
      description: "look something up",
      schema: z.object({ q: z.string() }),
      func: async ({ q }) => { executed = true; return { found: `value:${q}` }; },
    });
    // The sub-agent has its OWN model that calls the borrowed tool, then answers.
    const childModel = {
      modelName: "child",
      bindTools() { return this; },
      async invoke(msgs: Message[]) {
        if (msgs.some((m) => m.role === "tool")) return { role: "assistant", content: "used the tool" };
        return { role: "assistant", content: "", tool_calls: [{ id: "t1", type: "function", function: { name: "lookup", arguments: JSON.stringify({ q: "x" }) } }] };
      },
    } as any;
    const looker: SubagentDef = { name: "looker", header: "looks things up", model: childModel, tools: ["lookup"] };

    const parent = createSmartAgent({
      name: "parent",
      model: callsToolThenDone("delegate_to", { subagent: "looker", input: "find x" }),
      tools: [lookup],
      subagents: [looker],
      summarization: false,
    });
    const res = await parent.invoke({ messages: [{ role: "user", content: "go" }] } as any);
    expect(executed).toBe(true);
    const parsed = JSON.parse((res.messages.find((m: any) => m.role === "tool") as any).content);
    expect(parsed.content).toBe("used the tool");
  });

  it("runs parallel children concurrently (bounded by maxParallel)", async () => {
    const slow = (name: string, content: string): SubagentDef => ({
      name,
      header: name,
      model: { modelName: name, bindTools() { return this; }, async invoke() { await new Promise((r) => setTimeout(r, 100)); return { role: "assistant", content }; } } as any,
    });
    const parent = createSmartAgent({
      name: "parent",
      model: callsToolThenDone("spawn_subagents_parallel", { tasks: [{ subagent: "a", input: "1" }, { subagent: "b", input: "2" }, { subagent: "c", input: "3" }] }),
      subagents: [slow("a", "A"), slow("b", "B"), slow("c", "C")],
      subagentPolicy: { mode: "registry_and_adhoc", maxDepth: 2, maxChildCalls: 8, maxParallel: 3, childContextPolicy: "minimal", allowAdhocTools: true },
      summarization: false,
    });
    const t0 = Date.now();
    const res = await parent.invoke({ messages: [{ role: "user", content: "go" }] } as any);
    const elapsed = Date.now() - t0;
    // 3 × 100ms concurrently should finish well under sequential 300ms.
    expect(elapsed).toBeLessThan(250);
    const parsed = JSON.parse((res.messages.find((m: any) => m.role === "tool") as any).content);
    expect(parsed.results.map((r: any) => r.content).sort()).toEqual(["A", "B", "C"]);
  });

  it("delegation works with a guardrail present (no regression)", async () => {
    const benign: ConversationGuardrail = {
      id: "benign",
      appliesTo: [GuardrailPhase.Request, GuardrailPhase.Response],
      rules: [{ id: "ok", evaluate: () => ({ passed: true }) }],
    };
    const child: SubagentDef = { name: "helper", header: "helps", model: leafModel("helped") };
    const parent = createSmartAgent({
      name: "parent",
      model: callsToolThenDone("delegate_to", { subagent: "helper", input: "help" }),
      subagents: [child],
      guardrails: [benign],
      summarization: false,
    });
    const res = await parent.invoke({ messages: [{ role: "user", content: "go" }] } as any);
    const parsed = JSON.parse((res.messages.find((m: any) => m.role === "tool") as any).content);
    expect(parsed.content).toBe("helped");
    expect(res.content).toBe("parent-done");
  });

  it("accumulates results across sequential delegations", async () => {
    const a: SubagentDef = { name: "a", header: "a", model: leafModel("RA") };
    const b: SubagentDef = { name: "b", header: "b", model: leafModel("RB") };
    // Parent delegates to a, then b, then finishes — keyed off how many tool results exist.
    const parent = createSmartAgent({
      name: "parent",
      model: {
        modelName: "p",
        bindTools() { return this; },
        async invoke(msgs: Message[]) {
          const step = msgs.filter((m) => m.role === "tool").length;
          if (step === 0) return { role: "assistant", content: "", tool_calls: [{ id: "c1", type: "function", function: { name: "delegate_to", arguments: JSON.stringify({ subagent: "a", input: "1" }) } }] };
          if (step === 1) return { role: "assistant", content: "", tool_calls: [{ id: "c2", type: "function", function: { name: "delegate_to", arguments: JSON.stringify({ subagent: "b", input: "2" }) } }] };
          return { role: "assistant", content: "both-done" };
        },
      } as any,
      subagents: [a, b],
      summarization: false,
    });
    const res = await parent.invoke({ messages: [{ role: "user", content: "go" }] } as any);
    const toolMsgs = res.messages.filter((m: any) => m.role === "tool");
    expect(toolMsgs).toHaveLength(2);
    const contents = toolMsgs.map((m: any) => JSON.parse(m.content).content);
    expect(contents).toEqual(["RA", "RB"]);
    expect(res.content).toBe("both-done");
  });

  it("surfaces a child error as an error result and lets the parent continue", async () => {
    const boom = createTool({ name: "boom", description: "explodes", schema: z.object({}), func: async () => { throw new Error("kaboom"); } });
    const childModel = {
      modelName: "child",
      bindTools() { return this; },
      async invoke(msgs: Message[]) {
        if (msgs.some((m) => m.role === "tool")) return { role: "assistant", content: "recovered" };
        return { role: "assistant", content: "", tool_calls: [{ id: "b1", type: "function", function: { name: "boom", arguments: "{}" } }] };
      },
    } as any;
    const child: SubagentDef = { name: "fragile", header: "fragile", model: childModel, tools: [boom] };
    const parent = createSmartAgent({
      name: "parent",
      model: callsToolThenDone("delegate_to", { subagent: "fragile", input: "try" }),
      subagents: [child],
      summarization: false,
    });
    // The tool error is handled inside the child loop; the parent still completes.
    const res = await parent.invoke({ messages: [{ role: "user", content: "go" }] } as any);
    expect(res.content).toBe("parent-done");
    const toolMsg = res.messages.find((m: any) => m.role === "tool");
    expect(toolMsg).toBeDefined();
  });
});
