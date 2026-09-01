/**
 * Handoffs on a smart agent.
 *
 * `handoffs` is a typed, documented option on BOTH agent factories, but only
 * `createAgent` ever honoured it: the smart loop rebuilds its tool set every
 * iteration and overwrites `state.agent.tools` with it, so anything the base
 * runtime carried was discarded before the model saw it. The option compiled,
 * validated, and did nothing.
 */

import { describe, it, expect, vi } from "vitest";
import { createAgent } from "../../src/agent.js";
import { createSmartAgent } from "../../src/smart/index.js";

/** Records the tool menu it was bound to on every call. */
function menuRecordingModel(menus: string[][], reply = "ok") {
  return {
    modelName: "menu-stub",
    bindTools(tools: Array<{ name: string }>) {
      menus.push(tools.map((tool) => tool.name));
      return this;
    },
    async invoke() {
      return { role: "assistant", content: reply };
    },
  } as never;
}

describe("createSmartAgent × handoffs", () => {
  it("exposes the handoff tool to the model, the way createAgent does", async () => {
    const plainMenus: string[][] = [];
    const smartMenus: string[][] = [];

    const child = createAgent({ name: "Child", model: menuRecordingModel([]) });
    const handoff = child.asHandoff({ toolName: "delegate_child" });

    const plain = createAgent({ name: "Plain", model: menuRecordingModel(plainMenus), handoffs: [handoff] });
    await plain.invoke({ messages: [{ role: "user", content: "hi" }] });

    const smart = createSmartAgent({ name: "Smart", model: menuRecordingModel(smartMenus), handoffs: [handoff] });
    await smart.invoke({ messages: [{ role: "user", content: "hi" }] });

    expect(plainMenus[0]).toContain("delegate_child");
    // The regression: this was an empty menu, so the model could never hand off.
    expect(smartMenus[0]).toContain("delegate_child");
  });

  it("keeps the handoff tool alongside the agent's own tools and the context tools", async () => {
    const menus: string[][] = [];
    const child = createAgent({ name: "Child", model: menuRecordingModel([]) });

    const smart = createSmartAgent({
      name: "Smart",
      model: menuRecordingModel(menus),
      tools: [
        {
          name: "lookup",
          description: "look something up",
          schema: undefined,
          invoke: async () => "x",
        } as never,
      ],
      handoffs: [child.asHandoff({ toolName: "delegate_child" })],
    });

    await smart.invoke({ messages: [{ role: "user", content: "hi" }] });

    expect(menus[0]).toContain("lookup");
    expect(menus[0]).toContain("delegate_child");
  });

  it("actually transfers control, and the target keeps its OWN tools", async () => {
    const childFunc = vi.fn(async () => "CHILD RAN");
    const childTool = {
      name: "child_only_tool",
      description: "only the child has this",
      schema: undefined,
      invoke: childFunc,
    } as never;

    // The child records into the SAME array: after the swap it is the child's
    // model that gets bound, and its menu is the thing under test.
    const menus: string[][] = [];
    const child = createAgent({
      name: "Child",
      model: menuRecordingModel(menus, "child answer"),
      tools: [childTool],
    });

    // Hands off on turn 1, then answers.
    let turn = 0;
    const parentModel = {
      modelName: "handoff-stub",
      bindTools(tools: Array<{ name: string }>) {
        menus.push(tools.map((t) => t.name));
        return this;
      },
      async invoke() {
        turn += 1;
        if (turn === 1) {
          return {
            role: "assistant",
            content: "",
            tool_calls: [
              {
                id: "call_handoff",
                type: "function",
                function: { name: "delegate_child", arguments: JSON.stringify({ reason: "needs the child" }) },
              },
            ],
          };
        }
        return { role: "assistant", content: "after handoff" };
      },
    } as never;

    const smart = createSmartAgent({
      name: "Parent",
      model: parentModel,
      handoffs: [child.asHandoff({ toolName: "delegate_child" })],
      limits: { maxToolCalls: 3 },
    });

    const result = await smart.invoke({ messages: [{ role: "user", content: "hand off please" }] });

    const handedOff = (result.state?.toolHistory ?? []).some((entry) => entry.status === "handoff");
    expect(handedOff).toBe(true);

    // The second menu is the one that matters: after the swap the runtime is
    // the CHILD's, and re-syncing the parent's tools onto it would hand the
    // child its parent's menu and undo the handoff.
    expect(menus.length).toBeGreaterThan(1);
    expect(menus[menus.length - 1]).toContain("child_only_tool");
    expect(menus[menus.length - 1]).not.toContain("delegate_child");
  });
  it("hands the target its OWN system prompt, not the persona of the agent that handed off", async () => {
    // The menu followed the handoff but the system message did not, so the
    // target ran under its predecessor's instructions: its own systemPrompt and
    // name never reached the model, and it ignored the tools it was just given.
    const prompts: string[] = [];
    const recordPrompt = (messages: Array<{ role: string; content: string }>) => {
      const system = messages.find((m) => m.role === "system");
      if (system) prompts.push(String(system.content));
    };

    const child = createAgent({
      name: "Child",
      systemPrompt: "You are the CHILD. Always call child_only_tool first.",
      model: {
        modelName: "child-stub",
        bindTools() {
          return this;
        },
        async invoke(messages: Array<{ role: string; content: string }>) {
          recordPrompt(messages);
          return { role: "assistant", content: "child answer" };
        },
      } as never,
    } as never);

    let turn = 0;
    const parentModel = {
      modelName: "parent-stub",
      bindTools() {
        return this;
      },
      async invoke(messages: Array<{ role: string; content: string }>) {
        recordPrompt(messages);
        turn += 1;
        if (turn === 1) {
          return {
            role: "assistant",
            content: "",
            tool_calls: [
              {
                id: "call_handoff",
                type: "function",
                function: { name: "delegate_child", arguments: JSON.stringify({ reason: "needs the child" }) },
              },
            ],
          };
        }
        return { role: "assistant", content: "after handoff" };
      },
    } as never;

    const smart = createSmartAgent({
      name: "Parent",
      systemPrompt: "You are the PARENT. Never answer directly.",
      model: parentModel,
      handoffs: [child.asHandoff({ toolName: "delegate_child" })],
      limits: { maxToolCalls: 3 },
    });

    await smart.invoke({ messages: [{ role: "user", content: "hand off please" }] });

    expect(prompts.length).toBeGreaterThan(1);
    expect(prompts[0]).toContain("You are the PARENT.");
    const afterHandoff = prompts[prompts.length - 1];
    expect(afterHandoff).toContain("Agent Name: Child");
    expect(afterHandoff).toContain("You are the CHILD.");
    // The predecessor's instructions must be GONE, not merely appended to.
    expect(afterHandoff).not.toContain("You are the PARENT.");
  });
});
