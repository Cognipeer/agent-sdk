/**
 * #3 regression: bound skill tools must survive a pause/resume. Previously the
 * per-invoke skill registry was rebuilt empty on resume, so an approval-gated
 * skill tool vanished from the runtime tool set ("Tool not found") and any
 * previously bound skill tool disappeared after any pause.
 */
import { describe, it, expect } from "vitest";
import { z } from "zod";
import { createSmartAgent, createTool } from "../../src/index.js";
import type { Message } from "../../src/types.js";
import type { Skill } from "../../src/smart/skills/types.js";

const call = (name: string, args: Record<string, unknown> = {}, id = `c_${name}`) => ({
  id, type: "function" as const, function: { name, arguments: JSON.stringify(args) },
});

describe("skills × resume", () => {
  it("keeps an approval-gated skill tool bound across an approval pause/resume", async () => {
    let ran = 0;
    const dangerSkill: Skill = {
      key: "builtin:danger",
      title: "Danger",
      header: "runs a privileged action",
      prompt: "Call danger_run when asked.",
      listToolIndex: () => [{ name: "danger_run" }],
      bindTools: () => [
        createTool({
          name: "danger_run",
          description: "privileged",
          schema: z.object({}).strict(),
          needsApproval: true,
          func: async () => { ran += 1; return "ran"; },
        }),
      ],
    };

    // turn 0: open the skill; turn 1: call the (approval-gated) bound tool → pause;
    // (resume approves) → turn 2: finish.
    const script: Array<{ content?: string; tool_calls?: any[] }> = [
      { tool_calls: [call("open_skill", { skillKey: "builtin:danger" })] },
      { tool_calls: [call("danger_run")] },
      { content: "done" },
    ];
    let turn = 0;
    const model: any = {
      bindTools() { return this; },
      async invoke(_msgs: Message[]) {
        const r = script[Math.min(turn, script.length - 1)];
        turn += 1;
        const msg: any = { role: "assistant", content: r.content ?? "" };
        if (r.tool_calls) msg.tool_calls = r.tool_calls;
        return msg as Message;
      },
    };

    const agent = createSmartAgent({ model, skills: [dangerSkill], summarization: false } as any);

    const paused = await agent.invoke({ messages: [{ role: "user", content: "go" }] } as any);
    const pending = (paused.state?.pendingApprovals || []).filter((a: any) => a.status === "pending");
    expect(pending.length).toBe(1);
    expect(pending[0].toolName).toBe("danger_run");

    const resolved = agent.resolveToolApproval(paused.state!, { id: pending[0].id, approved: true });
    const done = await agent.invoke(resolved as any);

    // The approved skill tool must actually run (not become "Tool not found").
    expect(ran).toBe(1);
    const toolMsg = done.messages.find((m: any) => m.role === "tool" && m.name === "danger_run");
    expect(toolMsg).toBeDefined();
    expect(String((toolMsg as any).content)).not.toContain("Tool not found");
    expect(done.content).toBe("done");
  });
});
