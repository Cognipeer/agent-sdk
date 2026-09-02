/**
 * Pre-opening skills on a leg that is RESUMING mid-tool-execution.
 *
 * `preopenedSkills` opens skills deterministically before the first model call
 * and records the opening as a real tool exchange in the transcript. On a fresh
 * run the transcript ends with the user message, so appending that exchange is
 * right.
 *
 * On an approval resume it is not. There the transcript ends with the assistant
 * turn whose tool_call is approved but still unanswered, and appending an
 * assistant turn after it BURIES that call: `selectPendingToolCalls` walks back
 * only to the most recent assistant turn, finds the synthetic preopen turn fully
 * resolved, and reports nothing pending. The loop then breaks having made zero
 * model calls, the approved tool never runs, and the dangling-tool-response
 * guard reports it as "a model provider error or exhausted iteration budget" —
 * neither of which happened.
 *
 * From outside, the host sees `open_skill` tool-call events the model never
 * asked for, and a run that dies in milliseconds nowhere near any budget.
 *
 * The bindings must still happen; only the transcript injection is withheld.
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

function mkSkill(key: string, toolName: string, counter: { ran: number }, needsApproval = false): Skill {
  return {
    key,
    title: key,
    header: `${key} header`,
    prompt: `Use ${toolName}.`,
    listToolIndex: () => [{ name: toolName }],
    bindTools: () => [
      createTool({
        name: toolName,
        description: `${toolName} tool`,
        schema: z.object({}).strict(),
        needsApproval,
        func: async () => {
          counter.ran += 1;
          return "sent";
        },
      }),
    ],
  };
}

function scriptedModel(script: Array<{ content?: string; tool_calls?: any[] }>, cursor: { turn: number; calls: number }) {
  return {
    bindTools() {
      return this;
    },
    async invoke(_msgs: Message[]) {
      cursor.calls += 1;
      const step = script[Math.min(cursor.turn, script.length - 1)];
      cursor.turn += 1;
      const msg: any = { role: "assistant", content: step.content ?? "" };
      if (step.tool_calls) msg.tool_calls = step.tool_calls;
      return msg as Message;
    },
  } as any;
}

describe("preopenedSkills on an approval-resume leg", () => {
  it("runs the approved tool instead of stranding it behind a synthetic open_skill turn", async () => {
    const counter = { ran: 0 };
    const cursor = { turn: 0, calls: 0 };
    const script = [
      { tool_calls: [call("open_skill", { skillKey: "integration:google" })] },
      { tool_calls: [call("send_email")] },
      { content: "ok, the mail is sent" },
    ];

    // Leg 1: no preopen — the model opens the skill itself, then parks on approval.
    const first = createSmartAgent({
      model: scriptedModel(script, cursor),
      skills: [mkSkill("integration:google", "send_email", counter, true)],
      summarization: false,
    } as never);

    const paused = await first.invoke({ messages: [{ role: "user", content: "send it" }] } as never);
    const pending = (paused.state?.pendingApprovals || []).filter((a: any) => a.status === "pending");
    expect(pending.length).toBe(1);

    const persisted = JSON.parse(JSON.stringify({ ...paused.state, agent: undefined }));
    // The transcript really does end on the unanswered call — that is the shape
    // this test exists for.
    const tail = persisted.messages[persisted.messages.length - 1];
    expect(tail.role).toBe("assistant");
    expect(tail.tool_calls?.[0]?.function?.name).toBe("send_email");

    // Leg 2: rebuilt agent, and the host passes preopenedSkills as it always does.
    const second = createSmartAgent({
      model: scriptedModel(script, cursor),
      skills: [
        mkSkill("integration:google", "send_email", counter, true),
        mkSkill("builtin:rules", "rules_lookup", { ran: 0 }),
      ],
      summarization: false,
    } as never);

    const callsBefore = cursor.calls;
    const resolved = second.resolveToolApproval(persisted as never, { id: pending[0].id, approved: true });
    const done = await second.invoke({ ...(resolved as any), preopenedSkills: ["builtin:rules"] } as never, {
      preopenedSkills: ["builtin:rules"],
    } as never);

    // The three things the production failure got wrong.
    expect(counter.ran).toBe(1);
    expect(cursor.calls).toBeGreaterThan(callsBefore);
    const toolMsg = done.messages.find((m: any) => m.role === "tool" && m.name === "send_email");
    expect(toolMsg).toBeDefined();
  });

  it("still injects the preopen exchange on a fresh run", async () => {
    // The withholding must be narrow: with nothing pending, the transcript
    // record of the opening is what tells the model the skill is available.
    const cursor = { turn: 0, calls: 0 };
    const agent = createSmartAgent({
      model: scriptedModel([{ content: "done" }], cursor),
      skills: [mkSkill("builtin:rules", "rules_lookup", { ran: 0 })],
      summarization: false,
    } as never);

    const result = await agent.invoke({ messages: [{ role: "user", content: "hi" }] } as never, {
      preopenedSkills: ["builtin:rules"],
    } as never);

    const opened = result.messages.some(
      (m: any) => m.role === "tool" && m.name === "open_skill",
    );
    expect(opened).toBe(true);
  });
});
