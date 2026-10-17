/**
 * What a handoff tells the models on either side of it.
 *
 * A handoff gives the conversation away. The source has to be told that, the
 * tool result has to say who has it and why, and the target has to be told it
 * was handed the conversation — otherwise it reads a bare tool call and may
 * answer "Handoff done" instead of doing the work. The scope is one invoke():
 * nothing about it survives into the next turn.
 */

import { describe, it, expect } from "vitest";
import { z } from "zod";
import { createAgent } from "../../src/agent.js";
import { createSmartAgent } from "../../src/smart/index.js";

type Seen = { name: string; system: string; messages: any[]; tools: string[] };

function recording(name: string, seen: Seen[], script: (turn: number) => any) {
  let turn = 0;
  let tools: string[] = [];
  return {
    modelName: name,
    bindTools(bound: Array<{ name: string }>) {
      tools = bound.map((t) => t.name);
      return this;
    },
    async invoke(messages: any[]) {
      turn += 1;
      seen.push({ name, system: String(messages.find((m) => m.role === "system")?.content ?? ""), messages, tools });
      return script(turn);
    },
  } as never;
}

const handoffCall = (toolName: string, args: any) => ({
  role: "assistant",
  content: "",
  tool_calls: [{ id: "h1", type: "function", function: { name: toolName, arguments: JSON.stringify(args) } }],
});

describe("handoff semantics", () => {
  it("tells the target who handed over and why, and the source's tool result says control moved", async () => {
    const seen: Seen[] = [];
    const coder = createAgent({
      name: "Coder",
      systemPrompt: "You are the CODER.",
      model: recording("Coder", seen, () => ({ role: "assistant", content: "here is the code" })),
    } as never);
    const root = createSmartAgent({
      name: "Root",
      systemPrompt: "You are ROOT.",
      model: recording("Root", seen, () => handoffCall("handoff_to_coder", { reason: "needs a parser written" })),
      handoffs: [coder.asHandoff({ toolName: "handoff_to_coder" })],
      limits: { maxToolCalls: 3 },
    });

    const res = await root.invoke({ messages: [{ role: "user", content: "write a parser" }] });

    const toolMsg = res.messages.find((m: any) => m.role === "tool") as any;
    expect(toolMsg.content).toBe("Handoff complete: control transferred to Coder. Reason: needs a parser written. Coder now answers the user.");

    const coderCall = seen.find((s) => s.name === "Coder")!;
    expect(coderCall.system).toContain("You are the CODER.");
    expect(coderCall.system).toContain("This conversation was handed to you by Root.");
    expect(coderCall.system).toContain("Their stated reason: needs a parser written.");
    expect(coderCall.system).toContain("answer the user directly");
    // The target saw the same tool result the transcript holds.
    expect(JSON.stringify(coderCall.messages)).toContain("Handoff complete: control transferred to Coder");
    // Wire only: the returned transcript keeps the source's own system message.
    expect(JSON.stringify(res.messages[0])).not.toContain("handed to you");
  });

  it("omits the reason sentence when the handoff schema carries none", async () => {
    const seen: Seen[] = [];
    const coder = createAgent({
      name: "Coder",
      systemPrompt: "You are the CODER.",
      model: recording("Coder", seen, () => ({ role: "assistant", content: "ok" })),
    } as never);
    const root = createSmartAgent({
      name: "Root",
      systemPrompt: "You are ROOT.",
      model: recording("Root", seen, () => handoffCall("handoff_to_coder", {})),
      handoffs: [coder.asHandoff({ toolName: "handoff_to_coder", schema: z.object({}) })],
      limits: { maxToolCalls: 3 },
    });
    const res = await root.invoke({ messages: [{ role: "user", content: "x" }] } as never);
    const toolMsg = res.messages.find((m: any) => m.role === "tool") as any;
    expect(toolMsg.content).toBe("Handoff complete: control transferred to Coder. Coder now answers the user.");
    const system = seen.find((s) => s.name === "Coder")!.system;
    expect(system).toContain("This conversation was handed to you by Root.");
    expect(system).not.toContain("Their stated reason");
  });

  it("gives asHandoff and the handoffs option the same default description, saying control transfers", () => {
    const seen: Seen[] = [];
    const billing = createAgent({ name: "Billing", model: recording("Billing", seen, () => ({ role: "assistant", content: "ok" })) } as never);
    const descriptor = billing.asHandoff({ toolName: "handoff_to_billing" }) as any;
    expect(descriptor.description).toContain("Transfer this conversation to Billing and STOP");
    expect(descriptor.description).toContain("takes over and answers the user");
    expect(descriptor.description).toContain("use a delegation tool");

    const menus: Array<{ name: string; description: string }> = [];
    const root = createAgent({
      name: "Root",
      model: {
        modelName: "Root",
        bindTools(tools: any[]) { menus.push(...tools.map((t) => ({ name: t.name, description: t.description }))); return this; },
        async invoke() { return { role: "assistant", content: "ok" }; },
      } as never,
      handoffs: [descriptor],
    } as never);
    return root.invoke({ messages: [{ role: "user", content: "x" }] } as never).then(() => {
      expect(menus.find((m) => m.name === "handoff_to_billing")?.description).toBe(descriptor.description);
    });
  });

  it("an explicit description still wins", () => {
    const billing = createAgent({ name: "Billing", model: recording("Billing", [], () => ({ role: "assistant", content: "ok" })) } as never);
    expect((billing.asHandoff({ toolName: "t", description: "custom" }) as any).description).toBe("custom");
  });

  it("is scoped to one invoke: the next turn starts at the source, with no handoff preamble or state", async () => {
    const seen: Seen[] = [];
    const coder = createAgent({
      name: "Coder",
      systemPrompt: "You are the CODER.",
      model: recording("Coder", seen, () => ({ role: "assistant", content: "code" })),
    } as never);
    const root = createSmartAgent({
      name: "Root",
      systemPrompt: "You are ROOT.",
      model: recording("Root", seen, (turn) => (turn === 1 ? handoffCall("handoff_to_coder", { reason: "needs code" }) : { role: "assistant", content: "root again" })),
      handoffs: [coder.asHandoff({ toolName: "handoff_to_coder" })],
      limits: { maxToolCalls: 3 },
    });

    const first = await root.invoke({ messages: [{ role: "user", content: "write code" }] });
    expect((first.state as any).ctx.__handoffActive).toBe(true);

    const second = await root.invoke({ messages: [...first.messages, { role: "user", content: "thanks, and?" }], ctx: (first.state as any).ctx });
    const rootCalls = seen.filter((s) => s.name === "Root");
    const lastRoot = rootCalls[rootCalls.length - 1];
    expect(lastRoot.system).toContain("You are ROOT.");
    expect(lastRoot.system).not.toContain("handed to you");
    expect((second.state as any).ctx?.__handoffActive).toBeUndefined();
    expect((second.state as any).ctx?.__handoffInfo).toBeUndefined();
    expect(second.content).toBe("root again");
  });
});
