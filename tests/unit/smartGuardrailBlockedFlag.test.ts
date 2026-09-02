/**
 * `state.ctx.__guardrailBlocked` on a smart agent's `userPromptSubmit` denial.
 *
 * This flag is the SDK's own documented signal that a turn was BLOCKED, not
 * answered — the point of it is to let a caller tell the two apart without
 * parsing the assistant's text. `createAgent`'s equivalent denial path sets it;
 * `createSmartAgent`'s did not, because it runs through its own copy of the
 * session-open/denial branch (src/smart/index.ts) rather than through
 * `createAgent`'s. A caller checking this flag on a smart agent saw nothing and
 * treated a blocked turn as an ordinary completed answer — indistinguishable
 * from a real one, and liable to be shown to the end user and recorded in
 * history as such.
 */
import { describe, it, expect } from "vitest";
import { createAgent } from "../../src/agent.js";
import { createSmartAgent } from "../../src/smart/index.js";
import { defineHook } from "../../src/plugins/define.js";

const denyOnPrompt = defineHook(
  "userPromptSubmit",
  () => ({ decision: "deny", reason: "blocked by policy" }),
  { name: "deny-plugin" },
);

function neverCalledModel() {
  return {
    modelName: "never-called",
    bindTools() {
      return this;
    },
    async invoke() {
      throw new Error("the model must not be called on a denied turn");
    },
  } as never;
}

describe("userPromptSubmit deny sets ctx.__guardrailBlocked on both factories", () => {
  it("createAgent", async () => {
    const agent = createAgent({ model: neverCalledModel(), plugins: [denyOnPrompt] });
    const result = await agent.invoke({ messages: [{ role: "user", content: "hi" }] });

    expect(result.content).toContain("blocked by policy");
    expect((result.state?.ctx as any)?.__guardrailBlocked).toBeDefined();
    expect((result.state?.ctx as any)?.__guardrailBlocked.incident.reason).toContain("blocked by policy");
  });

  it("createSmartAgent — the regression", async () => {
    const agent = createSmartAgent({ model: neverCalledModel(), plugins: [denyOnPrompt] });
    const result = await agent.invoke({ messages: [{ role: "user", content: "hi" }] });

    expect(result.content).toContain("blocked by policy");
    // This is what was missing: a smart agent resolved exactly like a normal
    // completed turn, with no signal a caller could check for "this was blocked".
    expect((result.state?.ctx as any)?.__guardrailBlocked).toBeDefined();
    expect((result.state?.ctx as any)?.__guardrailBlocked.incident.reason).toContain("blocked by policy");
    expect((result.state?.ctx as any)?.__guardrailBlocked.incident.hook).toBe("userPromptSubmit");
  });

  it("the transcript still carries the visible guardrail message either way", async () => {
    const agent = createSmartAgent({ model: neverCalledModel(), plugins: [denyOnPrompt] });
    const result = await agent.invoke({ messages: [{ role: "user", content: "hi" }] });

    const guardrailMsg = result.messages.find((m: any) => m.role === "assistant" && m.name === "guardrail");
    expect(guardrailMsg).toBeDefined();
  });
});
