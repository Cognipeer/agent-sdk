import { describe, expect, it } from "vitest";
import { z } from "zod";

import { createSmartAgent } from "../../../../src/smart/index.js";
import { createTool } from "../../../../src/tool.js";
import { preopenToolCallId } from "../../../../src/smart/skills/preopen.js";
import type { Message, SmartAgentEvent } from "../../../../src/types.js";
import type { Skill } from "../../../../src/smart/skills/types.js";

type Resp = { content?: string; tool_calls?: Array<{ id: string; type: "function"; function: { name: string; arguments: string } }> };

/** Scripted model that records the messages and tool sets it is handed. */
function scriptedModel(script: Resp[]) {
  let turn = 0;
  const seenToolSets: string[][] = [];
  const seenMessages: Message[][] = [];
  const next = (messages?: Message[]): Message => {
    seenMessages.push([...(messages || [])]);
    const r = script[Math.min(turn, script.length - 1)];
    turn++;
    const msg: any = { role: "assistant", content: r.content ?? "" };
    if (r.tool_calls?.length) msg.tool_calls = r.tool_calls;
    return msg as Message;
  };
  const model: any = {
    bindTools: (tools: any[]) => {
      seenToolSets.push(tools.map((t) => t.name));
      return { invoke: async (messages: Message[]) => next(messages) };
    },
    invoke: async (messages: Message[]) => next(messages),
  };
  return { model, seenToolSets, seenMessages };
}

const call = (name: string, args: Record<string, unknown> = {}) => ({
  id: `c_${name}`,
  type: "function" as const,
  function: { name, arguments: JSON.stringify(args) },
});

function makeSkill(key: string, toolNames: string[], onRun?: (name: string) => void): Skill {
  return {
    key,
    title: key,
    header: `${key} header`,
    prompt: `${key} guidance body`,
    listToolIndex: () => toolNames.map((name) => ({ name })),
    bindTools: (names) =>
      (names && names.length > 0 ? names : toolNames).map((name) =>
        createTool({
          name,
          schema: z.object({}).strict(),
          func: async () => {
            onRun?.(name);
            return { ok: true, from: name };
          },
        }),
      ),
  };
}

describe("preopenedSkills — synthetic open_skill exchange", () => {
  it("injects an assistant tool call + tool result after the user message", async () => {
    const { model, seenMessages } = scriptedModel([{ content: "done" }]);
    const agent = createSmartAgent({ model, skills: [makeSkill("builtin:pdf", ["pdf_read"])] } as any);

    await agent.invoke(
      { messages: [{ role: "user", content: "summarize my pdf" }] as Message[] },
      { preopenedSkills: ["builtin:pdf"] } as any,
    );

    const first = seenMessages[0]!;
    expect(first.map((m) => m.role)).toEqual(["system", "user", "assistant", "tool"]);

    const assistant: any = first[2];
    expect(assistant.tool_calls).toHaveLength(1);
    expect(assistant.tool_calls[0].function.name).toBe("open_skill");
    expect(JSON.parse(assistant.tool_calls[0].function.arguments)).toEqual({ skillKey: "builtin:pdf" });

    const toolMessage: any = first[3];
    expect(toolMessage.name).toBe("open_skill");
    expect(toolMessage.tool_call_id).toBe(assistant.tool_calls[0].id);
    // The result is the real open_skill payload, so the guidance reaches the model.
    expect(String(toolMessage.content)).toContain("builtin:pdf guidance body");
    expect(String(toolMessage.content)).toContain("pdf_read");
  });

  it("binds the skill's tools before the first model call", async () => {
    const { model, seenToolSets } = scriptedModel([{ content: "done" }]);
    const agent = createSmartAgent({ model, skills: [makeSkill("builtin:pdf", ["pdf_read", "pdf_write"])] } as any);

    await agent.invoke(
      { messages: [{ role: "user", content: "hi" }] as Message[] },
      { preopenedSkills: ["builtin:pdf"] } as any,
    );

    expect(seenToolSets[0]).toContain("pdf_read");
    expect(seenToolSets[0]).toContain("pdf_write");
    // Discovery stays available so the model can still widen the surface.
    expect(seenToolSets[0]).toContain("bind_skill_tools");
  });

  it("lets the model call a pre-opened tool without ever calling open_skill", async () => {
    const ran: string[] = [];
    const { model } = scriptedModel([{ tool_calls: [call("pdf_read")] }, { content: "done" }]);
    const agent = createSmartAgent({ model, skills: [makeSkill("builtin:pdf", ["pdf_read"], (n) => ran.push(n))] } as any);

    await agent.invoke(
      { messages: [{ role: "user", content: "hi" }] as Message[] },
      { preopenedSkills: ["builtin:pdf"] } as any,
    );

    expect(ran).toEqual(["pdf_read"]);
  });

  it("emits start and success tool_call events for the synthetic call", async () => {
    const events: SmartAgentEvent[] = [];
    const { model } = scriptedModel([{ content: "done" }]);
    const agent = createSmartAgent({ model, skills: [makeSkill("builtin:pdf", ["pdf_read"])] } as any);

    await agent.invoke(
      { messages: [{ role: "user", content: "hi" }] as Message[] },
      { preopenedSkills: ["builtin:pdf"], onEvent: (event) => events.push(event) } as any,
    );

    const openEvents = events.filter((e: any) => e.type === "tool_call" && e.name === "open_skill") as any[];
    expect(openEvents.map((e) => e.phase)).toEqual(["start", "success"]);
    expect(openEvents[0].id).toBe(preopenToolCallId("builtin:pdf"));
    expect(openEvents[1].result.skillKey).toBe("builtin:pdf");
  });

  it("records the synthetic call in toolHistory", async () => {
    const { model } = scriptedModel([{ content: "done" }]);
    const agent = createSmartAgent({ model, skills: [makeSkill("builtin:pdf", ["pdf_read"])] } as any);

    const result = await agent.invoke(
      { messages: [{ role: "user", content: "hi" }] as Message[] },
      { preopenedSkills: ["builtin:pdf"] } as any,
    );

    const entry = (result.state.toolHistory || []).find((e) => e.toolName === "open_skill");
    expect(entry).toBeTruthy();
    expect(entry!.tool_call_id).toBe(preopenToolCallId("builtin:pdf"));
    expect(entry!.status).toBe("success");
  });

  it("groups several skills into one assistant message with one tool result each", async () => {
    const { model, seenMessages } = scriptedModel([{ content: "done" }]);
    const agent = createSmartAgent({
      model,
      skills: [makeSkill("builtin:pdf", ["pdf_read"]), makeSkill("integration:m365", ["m365_search"])],
    } as any);

    await agent.invoke(
      { messages: [{ role: "user", content: "hi" }] as Message[] },
      { preopenedSkills: ["builtin:pdf", "integration:m365"] } as any,
    );

    const first = seenMessages[0]!;
    expect(first.map((m) => m.role)).toEqual(["system", "user", "assistant", "tool", "tool"]);
    expect((first[2] as any).tool_calls).toHaveLength(2);
    // Every tool message answers one of the assistant's calls — the pairing rule
    // every provider enforces.
    const callIds = (first[2] as any).tool_calls.map((c: any) => c.id);
    expect([(first[3] as any).tool_call_id, (first[4] as any).tool_call_id]).toEqual(callIds);
  });

  it("produces byte-identical messages across runs so the prompt prefix stays cacheable", async () => {
    const run = async () => {
      const { model, seenMessages } = scriptedModel([{ content: "done" }]);
      const agent = createSmartAgent({ model, skills: [makeSkill("builtin:pdf", ["pdf_read"])] } as any);
      await agent.invoke(
        { messages: [{ role: "user", content: "hi" }] as Message[] },
        { preopenedSkills: ["builtin:pdf"] } as any,
      );
      return seenMessages[0]!.slice(2);
    };

    expect(JSON.stringify(await run())).toBe(JSON.stringify(await run()));
  });

  it("skips an unknown key without injecting a broken exchange", async () => {
    const { model, seenMessages } = scriptedModel([{ content: "done" }]);
    const agent = createSmartAgent({ model, skills: [makeSkill("builtin:pdf", ["pdf_read"])] } as any);

    await agent.invoke(
      { messages: [{ role: "user", content: "hi" }] as Message[] },
      { preopenedSkills: ["builtin:nope"] } as any,
    );

    expect(seenMessages[0]!.map((m) => m.role)).toEqual(["system", "user"]);
  });

  it("skips an unavailable skill", async () => {
    const skill = { ...makeSkill("mcp:crm", ["crm_search"]), isAvailable: () => false };
    const { model, seenMessages, seenToolSets } = scriptedModel([{ content: "done" }]);
    const agent = createSmartAgent({ model, skills: [skill] } as any);

    await agent.invoke(
      { messages: [{ role: "user", content: "hi" }] as Message[] },
      { preopenedSkills: ["mcp:crm"] } as any,
    );

    expect(seenMessages[0]!.map((m) => m.role)).toEqual(["system", "user"]);
    expect(seenToolSets[0]).not.toContain("crm_search");
  });

  it("does not re-inject on a resumed run that already opened the skill", async () => {
    const skills = [makeSkill("builtin:pdf", ["pdf_read"])];
    const { model: firstModel } = scriptedModel([{ content: "done" }]);
    const first = await createSmartAgent({ model: firstModel, skills } as any).invoke(
      { messages: [{ role: "user", content: "hi" }] as Message[] },
      { preopenedSkills: ["builtin:pdf"] } as any,
    );

    const { model: secondModel, seenMessages, seenToolSets } = scriptedModel([{ content: "done" }]);
    // Resume the way a persisted run does: the live `agent` runtime is dropped.
    const { agent: _dropped, ...resumable } = first.state as any;
    await createSmartAgent({ model: secondModel, skills } as any).invoke(
      { ...resumable, messages: [...first.state.messages, { role: "user", content: "and now this" }] } as any,
      { preopenedSkills: ["builtin:pdf"] } as any,
    );

    const openCalls = seenMessages[0]!.filter((m: any) =>
      Array.isArray(m.tool_calls) && m.tool_calls.some((c: any) => c.function?.name === "open_skill"),
    );
    expect(openCalls).toHaveLength(1);
    // Rehydration still restored the bound tools without a second exchange.
    expect(seenToolSets[0]).toContain("pdf_read");
  });

  it("is inert when the agent has no skills", async () => {
    const { model, seenMessages } = scriptedModel([{ content: "ok" }]);
    const agent = createSmartAgent({ model } as any);

    await agent.invoke(
      { messages: [{ role: "user", content: "hi" }] as Message[] },
      { preopenedSkills: ["builtin:pdf"] } as any,
    );

    expect(seenMessages[0]!.map((m) => m.role)).toEqual(["system", "user"]);
  });

  it("is inert when no keys are requested", async () => {
    const { model, seenMessages } = scriptedModel([{ content: "ok" }]);
    const agent = createSmartAgent({ model, skills: [makeSkill("builtin:pdf", ["pdf_read"])] } as any);

    await agent.invoke({ messages: [{ role: "user", content: "hi" }] as Message[] });

    expect(seenMessages[0]!.map((m) => m.role)).toEqual(["system", "user"]);
  });
});
