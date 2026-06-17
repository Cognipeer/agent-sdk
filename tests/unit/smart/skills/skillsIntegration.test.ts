import { describe, expect, it } from "vitest";
import { z } from "zod";

import { createSmartAgent } from "../../../../src/smart/index.js";
import { createTool } from "../../../../src/tool.js";
import type { Message } from "../../../../src/types.js";
import type { Skill } from "../../../../src/smart/skills/types.js";

type Resp = { content?: string; tool_calls?: Array<{ id: string; type: "function"; function: { name: string; arguments: string } }> };

/** A scripted model that records the tool set it is bound with on every turn. */
function scriptedSkillModel(script: Resp[]) {
  let turn = 0;
  const seenToolSets: string[][] = [];
  const next = (): Message => {
    const r = script[Math.min(turn, script.length - 1)];
    turn++;
    const msg: any = { role: "assistant", content: r.content ?? "" };
    if (r.tool_calls?.length) msg.tool_calls = r.tool_calls;
    return msg as Message;
  };
  const model: any = {
    bindTools: (tools: any[]) => {
      seenToolSets.push(tools.map((t) => t.name));
      return { invoke: async () => next() };
    },
    invoke: async () => next(),
  };
  return { model, seenToolSets };
}

const call = (name: string, args: Record<string, unknown> = {}) => ({
  id: `c_${name}`,
  type: "function" as const,
  function: { name, arguments: JSON.stringify(args) },
});

describe("createSmartAgent + skills (progressive disclosure end-to-end)", () => {
  it("opens a skill, then its bound tool becomes available and actually runs", async () => {
    const readCalls: number[] = [];
    const pdfSkill: Skill = {
      key: "builtin:pdf",
      title: "PDF",
      header: "read & summarize PDF files",
      prompt: "First call pdf_read, then pdf_write.",
      listToolIndex: () => [{ name: "pdf_read" }, { name: "pdf_write" }],
      bindTools: () => [
        createTool({
          name: "pdf_read",
          schema: z.object({}).strict(),
          func: async () => {
            readCalls.push(1);
            return { ok: true, text: "pdf content" };
          },
        }),
        createTool({ name: "pdf_write", schema: z.object({}).strict(), func: async () => ({ ok: true }) }),
      ],
    };

    const { model, seenToolSets } = scriptedSkillModel([
      { tool_calls: [call("open_skill", { skillKey: "builtin:pdf" })] }, // turn 0
      { tool_calls: [call("pdf_read")] }, // turn 1 — bound tool now available
      { content: "done" }, // turn 2 — terminal
    ]);

    const agent = createSmartAgent({
      model,
      skills: [pdfSkill],
    } as any);

    await agent.invoke({ messages: [{ role: "user", content: "summarize my pdf" }] as Message[] });

    // The first turn sees the skill meta-tools but NOT the not-yet-bound tools.
    expect(seenToolSets[0]).toContain("open_skill");
    expect(seenToolSets[0]).toContain("bind_skill_tools");
    expect(seenToolSets[0]).not.toContain("pdf_read");

    // After open_skill, some later turn is bound with the skill's tools...
    const boundLater = seenToolSets.some((set) => set.includes("pdf_read") && set.includes("pdf_write"));
    expect(boundLater, `pdf_read never appeared in any tool set: ${JSON.stringify(seenToolSets)}`).toBe(true);

    // ...and the bound tool actually executed (end-to-end proof).
    expect(readCalls).toHaveLength(1);
  });

  it("hides an unavailable skill from the catalog but the agent still runs", async () => {
    const offSkill: Skill = {
      key: "mcp:crm",
      title: "CRM",
      header: "search CRM deals",
      prompt: "p",
      isAvailable: () => false,
      listToolIndex: () => [{ name: "crm_search" }],
      bindTools: () => [createTool({ name: "crm_search", schema: z.object({}).strict(), func: async () => ({}) })],
    };
    const { model } = scriptedSkillModel([{ content: "nothing to do" }]);
    const agent = createSmartAgent({ model, skills: [offSkill] } as any);
    const result = await agent.invoke({ messages: [{ role: "user", content: "hi" }] as Message[] });
    expect(result).toBeTruthy();
  });

  it("does not change behavior when no skills are supplied", async () => {
    const { model, seenToolSets } = scriptedSkillModel([{ content: "ok" }]);
    const agent = createSmartAgent({ model } as any);
    await agent.invoke({ messages: [{ role: "user", content: "hi" }] as Message[] });
    expect(seenToolSets[0]).not.toContain("open_skill");
  });
});
