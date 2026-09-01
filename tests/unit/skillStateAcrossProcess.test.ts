/**
 * Skill state across a REBUILT runtime.
 *
 * The existing resume test approves on the same agent instance. That is not the
 * shape a host actually runs: a task that pauses for approval is resumed from a
 * new process, minutes or hours later, with the whole agent reconstructed. The
 * only thing that survives is the state the host persisted — so whatever the
 * model had opened has to travel in `ctx.__skillState` or the resumed run comes
 * back with an approved tool call and no tool to answer it.
 *
 * This pins the round trip against a genuinely fresh instance.
 */
import { describe, it, expect } from "vitest";
import { z } from "zod";
import { createSmartAgent, createTool } from "../../src/index.js";
import type { Message } from "../../src/types.js";
import type { Skill } from "../../src/smart/skills/types.js";

const call = (name: string, args: Record<string, unknown> = {}, id = `c_${name}`) => ({
  id,
  type: "function" as const,
  function: { name, arguments: JSON.stringify(args) },
});

function buildSkill(counter: { ran: number }): Skill {
  return {
    key: "integration:google",
    title: "Google",
    header: "sends mail",
    prompt: "Call send_email when asked.",
    listToolIndex: () => [{ name: "send_email" }],
    bindTools: () => [
      createTool({
        name: "send_email",
        description: "sends an email",
        schema: z.object({}).strict(),
        needsApproval: true,
        func: async () => {
          counter.ran += 1;
          return "sent";
        },
      }),
    ],
  };
}

/** A model driven by an externally owned turn counter, so a rebuilt agent continues the script. */
function scriptedModel(script: Array<{ content?: string; tool_calls?: any[] }>, cursor: { turn: number }) {
  return {
    bindTools() {
      return this;
    },
    async invoke(_msgs: Message[]) {
      const step = script[Math.min(cursor.turn, script.length - 1)];
      cursor.turn += 1;
      const msg: any = { role: "assistant", content: step.content ?? "" };
      if (step.tool_calls) msg.tool_calls = step.tool_calls;
      return msg as Message;
    },
  } as any;
}

describe("skills × resume on a rebuilt runtime", () => {
  it("carries opened skills through ctx.__skillState to a brand-new agent instance", async () => {
    const counter = { ran: 0 };
    const cursor = { turn: 0 };
    const script = [
      { tool_calls: [call("open_skill", { skillKey: "integration:google" })] },
      { tool_calls: [call("send_email")] },
      { content: "done" },
    ];

    // ── process 1 ────────────────────────────────────────────────────────
    const first = createSmartAgent({
      model: scriptedModel(script, cursor),
      skills: [buildSkill(counter)],
      summarization: false,
    } as never);

    const paused = await first.invoke({ messages: [{ role: "user", content: "send it" }] } as never);
    const pending = (paused.state?.pendingApprovals || []).filter((a: any) => a.status === "pending");
    expect(pending.length).toBe(1);
    expect(pending[0].toolName).toBe("send_email");

    // The host persists the state. This is the ONLY channel to the next process,
    // so the opened skill has to be in it.
    const persisted = JSON.parse(
      JSON.stringify({ ...paused.state, agent: undefined, ctx: { ...(paused.state as any).ctx } }),
    );
    expect((persisted.ctx as any).__skillState?.openedSkillKeys).toContain("integration:google");

    // ── process 2: everything rebuilt from scratch ───────────────────────
    const second = createSmartAgent({
      model: scriptedModel(script, cursor),
      skills: [buildSkill(counter)],
      summarization: false,
    } as never);

    const resolved = second.resolveToolApproval(persisted as never, { id: pending[0].id, approved: true });
    const done = await second.invoke(resolved as never);

    // The approved tool must actually run on the rebuilt runtime — not come back
    // as "Tool not found" with the model guessing at open_skill.
    expect(counter.ran).toBe(1);
    const toolMsg = done.messages.find((m: any) => m.role === "tool" && m.name === "send_email");
    expect(toolMsg).toBeDefined();
    expect(String((toolMsg as any).content)).not.toContain("Tool not found");
  });
});
