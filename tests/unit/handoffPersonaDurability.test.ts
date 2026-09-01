/**
 * Where a handoff persona must and must NOT appear.
 *
 * A handoff swaps the active runtime mid-run. The tool menu follows it, and the
 * system prompt has to follow it too — otherwise the target answers under its
 * predecessor's instructions and its own systemPrompt never reaches the model.
 *
 * The dangerous half is WHERE that swap is written. The first implementation
 * rewrote the transcript, which looked correct for one turn and was wrong
 * forever after: the target's persona rode out on the caller's returned
 * messages, and because the driver seeds no system message when one is already
 * present, the NEXT turn ran the originating agent's tools under the target's
 * instructions — the same mismatch the fix existed to remove, inverted and
 * permanent.
 *
 * So the persona is applied to the WIRE only. These tests pin both halves: the
 * target really gets its own persona, and nothing about it survives into the
 * caller's transcript.
 */

import { describe, it, expect } from "vitest";
import { createAgent } from "../../src/agent.js";
import { createSmartAgent } from "../../src/smart/index.js";

/** Records the system prompt each model was actually called with. */
function recordingModel(name: string, prompts: Array<[string, string]>, reply = "ok") {
  return {
    modelName: name,
    bindTools() {
      return this;
    },
    async invoke(messages: Array<{ role: string; content: string }>) {
      const system = messages.find((m) => m.role === "system");
      prompts.push([name, String(system?.content ?? "")]);
      return { role: "assistant", content: reply };
    },
  } as never;
}

/** Hands off on turn 1, then answers. */
function handingOffModel(name: string, prompts: Array<[string, string]>, menus: string[][] = []) {
  let turn = 0;
  return {
    modelName: name,
    bindTools(tools: Array<{ name: string }>) {
      menus.push(tools.map((t) => t.name));
      return this;
    },
    async invoke(messages: Array<{ role: string; content: string }>) {
      const system = messages.find((m) => m.role === "system");
      prompts.push([name, String(system?.content ?? "")]);
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
      return { role: "assistant", content: `${name} answer ${turn}` };
    },
  } as never;
}

describe("a handoff persona reaches the model but never the transcript", () => {
  it("does not write the target's persona into the returned messages", async () => {
    const prompts: Array<[string, string]> = [];
    const child = createAgent({
      name: "Billing",
      systemPrompt: "You are BILLING.",
      model: recordingModel("Billing", prompts, "billing answer"),
    } as never);

    const router = createSmartAgent({
      name: "Router",
      systemPrompt: "You are the ROUTER.",
      model: handingOffModel("Router", prompts),
      handoffs: [child.asHandoff({ toolName: "delegate_child" })],
      limits: { maxToolCalls: 3 },
    });

    const result = await router.invoke({ messages: [{ role: "user", content: "hi" }] });

    // The target really did get its own persona on the wire.
    const billingPrompt = prompts.find(([who]) => who === "Billing")?.[1] ?? "";
    expect(billingPrompt).toContain("Agent Name: Billing");
    expect(billingPrompt).toContain("You are BILLING.");
    expect(billingPrompt).not.toContain("You are the ROUTER.");

    // And none of it leaked into what the caller gets back.
    const leading = result.messages[0];
    expect(leading.role).toBe("system");
    expect(String(leading.content)).toContain("Agent Name: Router");
    expect(String(leading.content)).not.toContain("Agent Name: Billing");
    expect(JSON.stringify(result.state?.messages?.[0])).not.toContain("Agent Name: Billing");
  });

  it("runs the ORIGINATING agent on the next turn of an ordinary continuation", async () => {
    const prompts: Array<[string, string]> = [];
    const menus: string[][] = [];
    const child = createAgent({
      name: "Billing",
      systemPrompt: "You are BILLING.",
      model: recordingModel("Billing", prompts, "billing answer"),
    } as never);

    const router = createSmartAgent({
      name: "Router",
      systemPrompt: "You are the ROUTER.",
      model: handingOffModel("Router", prompts, menus),
      handoffs: [child.asHandoff({ toolName: "delegate_child" })],
      limits: { maxToolCalls: 3 },
    });

    const first = await router.invoke({ messages: [{ role: "user", content: "hi" }] });

    // The continuation shape a caller actually uses.
    await router.invoke({ messages: [...first.messages, { role: "user", content: "again" }] });

    const routerPrompts = prompts.filter(([who]) => who === "Router");
    const lastRouterPrompt = routerPrompts[routerPrompts.length - 1][1];
    // Turn 2 must be the Router under the Router's own instructions — not the
    // Router's menu under Billing's persona.
    expect(lastRouterPrompt).toContain("Agent Name: Router");
    expect(lastRouterPrompt).not.toContain("Agent Name: Billing");
    expect(menus[menus.length - 1]).toContain("delegate_child");
  });

  it("keeps a plugin's systemPrompt contribution across the handoff", async () => {
    // The plugin still governs the run after control moves, so a compliance line
    // it contributes has to survive a prompt the runtime rebuilds from scratch.
    // Note this plugin registers NO hooks — that shape has no run host at all,
    // which is exactly the case a host-based lookup would miss.
    const prompts: Array<[string, string]> = [];
    const child = createAgent({
      name: "Billing",
      systemPrompt: "You are BILLING.",
      model: recordingModel("Billing", prompts, "billing answer"),
    } as never);

    const router = createSmartAgent({
      name: "Router",
      systemPrompt: "You are the ROUTER.",
      model: handingOffModel("Router", prompts),
      plugins: [{ name: "compliance", systemPrompt: "NEVER-DISCLOSE-CARDS" } as never],
      handoffs: [child.asHandoff({ toolName: "delegate_child" })],
      limits: { maxToolCalls: 3 },
    });

    await router.invoke({ messages: [{ role: "user", content: "hi" }] });

    const billingPrompt = prompts.find(([who]) => who === "Billing")?.[1] ?? "";
    expect(billingPrompt).toContain("You are BILLING.");
    expect(billingPrompt).toContain("NEVER-DISCLOSE-CARDS");
  });

  it("leaves a state that can still be structured-cloned after a handoff", async () => {
    // The handoff tool's raw output used to be `{ __handoff: { runtime } }` — the
    // target's whole runtime, model closures and all. captureSnapshot does a
    // structuredClone of toolHistory, so ANY run that handed off could not be
    // snapshotted; a checkpointing plugin with failureMode "open" swallowed the
    // throw and silently wrote nothing for exactly the runs that needed it.
    const prompts: Array<[string, string]> = [];
    const child = createAgent({
      name: "Billing",
      systemPrompt: "You are BILLING.",
      model: recordingModel("Billing", prompts, "billing answer"),
    } as never);

    const router = createSmartAgent({
      name: "Router",
      systemPrompt: "You are the ROUTER.",
      model: handingOffModel("Router", prompts),
      handoffs: [child.asHandoff({ toolName: "delegate_child" })],
      limits: { maxToolCalls: 3 },
    });

    const result = await router.invoke({ messages: [{ role: "user", content: "hi" }] });

    const handoffEntry = (result.state?.toolHistory ?? []).find((h) => h.status === "handoff");
    expect(handoffEntry).toBeDefined();
    expect(() => structuredClone(result.state!.toolHistory)).not.toThrow();
  });
});
