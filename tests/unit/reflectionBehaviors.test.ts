/**
 * Behavioral tests for the reflection redesign: the initial reflection point,
 * near-duplicate suppression, lifecycle hooks and feedTo routing.
 */

import { describe, it, expect } from "vitest";
import { z } from "zod";
import { createAgent, createTool } from "../../src/index.js";
import type { Message } from "../../src/types.js";

const noop = createTool({
  name: "noop",
  description: "",
  schema: z.object({}),
  func: async () => "ok",
});

function isReflectAsk(msgs: Message[]): boolean {
  const last: any = msgs[msgs.length - 1];
  if (last?.name === "agent_reflection_ask") return true;
  const lc = typeof last?.content === "string" ? last.content : "";
  return /Reflect briefly/.test(lc);
}

describe("initial reflection", () => {
  it("initial_then_after_tool fires once even when no tools run", async () => {
    const reflections: any[] = [];
    const model: any = {
      modelName: "m",
      bindTools() { return this; },
      async invoke(msgs: Message[]) {
        if (isReflectAsk(msgs)) return { role: "assistant", content: "planning note" };
        return { role: "assistant", content: "done" };
      },
    };
    const agent = createAgent({
      model,
      tools: [noop],
      reasoning: { enabled: true, level: "high", reflection: { cadence: "initial_then_after_tool" } },
    });
    await agent.invoke({ messages: [{ role: "user", content: "go" }] } as any, {
      onEvent: (e: any) => { if (e.type === "reflection") reflections.push(e); },
    });
    expect(reflections.length).toBeGreaterThanOrEqual(1);
    expect(reflections[0].trigger).toBe("initial_then_after_tool");
  });
});

describe("near-duplicate suppression", () => {
  it("stores only the first of repeated identical reflections", async () => {
    const reflections: any[] = [];
    let mainTurn = 0;
    const model: any = {
      modelName: "m",
      bindTools() { return this; },
      async invoke(msgs: Message[]) {
        if (isReflectAsk(msgs)) return { role: "assistant", content: "the same repeated note" };
        mainTurn++;
        if (mainTurn <= 3) {
          return {
            role: "assistant",
            content: "",
            tool_calls: [{ id: `t${mainTurn}`, type: "function", function: { name: "noop", arguments: "{}" } }],
          };
        }
        return { role: "assistant", content: "done" };
      },
    };
    const agent = createAgent({
      model,
      tools: [noop],
      limits: { maxToolCalls: 10 },
      reasoning: { enabled: true, level: "low", reflection: { cadence: "after_tool", everyNTurns: 1 } },
    });
    await agent.invoke({ messages: [{ role: "user", content: "go" }] } as any, {
      onEvent: (e: any) => { if (e.type === "reflection") reflections.push(e); },
    });
    expect(reflections.length).toBe(1);
  });
});

describe("reflection hooks and feedTo", () => {
  function toolThenDone() {
    let mainTurn = 0;
    return {
      modelName: "m",
      bindTools() { return this; },
      async invoke(msgs: Message[]) {
        if (isReflectAsk(msgs)) return { role: "assistant", content: "a useful reflection note" };
        mainTurn++;
        if (mainTurn === 1) {
          return {
            role: "assistant",
            content: "",
            tool_calls: [{ id: "t1", type: "function", function: { name: "noop", arguments: "{}" } }],
          };
        }
        return { role: "assistant", content: "done" };
      },
    } as any;
  }

  it("invokes onReflection and respects a custom shouldReflect predicate", async () => {
    const records: any[] = [];
    let predicateCalls = 0;
    const agent = createAgent({
      model: toolThenDone(),
      tools: [noop],
      reasoning: {
        enabled: true,
        level: "low",
        reflection: {
          cadence: "after_tool",
          onReflection: (rec) => { records.push(rec); },
          shouldReflect: () => { predicateCalls++; return true; },
        },
      },
    });
    await agent.invoke({ messages: [{ role: "user", content: "go" }] } as any);
    expect(predicateCalls).toBeGreaterThanOrEqual(1);
    expect(records.length).toBe(1);
    expect(records[0].text).toContain("reflection note");
  });

  it("feedTo:memory stores the reflection as a memory fact", async () => {
    const agent = createAgent({
      model: toolThenDone(),
      tools: [noop],
      reasoning: {
        enabled: true,
        level: "low",
        reflection: { cadence: "after_tool", feedTo: "memory" },
      },
    });
    const res = await agent.invoke({ messages: [{ role: "user", content: "go" }] } as any);
    const facts = (res.state as any).memoryFacts || [];
    expect(facts.some((f: any) => f.tags?.includes("reflection"))).toBe(true);
  });
});
