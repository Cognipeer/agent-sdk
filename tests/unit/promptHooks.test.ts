/**
 * promptHooks coverage (previously untested):
 *  - #4/#8 the FUNCTION form of a toolDescriptions override for a sub-agent tool
 *          receives the real default string (not a stringified function) and is
 *          applied exactly once.
 *  - transformSystemPrompt rewrites the composed system prompt.
 *  - subagentCatalog rewrites the <available_subagents> block.
 *  - toolDescriptions string form overrides a built-in tool description.
 */
import { describe, it, expect } from "vitest";
import { createSmartAgent } from "../../src/index.js";
import type { Message, SubagentDef } from "../../src/types.js";

/** Captures the tool set + system prompt the model is invoked with. */
function capturingModel() {
  const captured: { toolDescriptions: Record<string, string>; systemPrompt: string } = { toolDescriptions: {}, systemPrompt: "" };
  const model: any = {
    modelName: "cap",
    bindTools(tools: any[]) {
      for (const t of tools) captured.toolDescriptions[t.name] = t.description;
      return this;
    },
    async invoke(msgs: Message[]) {
      const sys = msgs.find((m) => m.role === "system");
      if (sys && typeof sys.content === "string") captured.systemPrompt = sys.content;
      return { role: "assistant", content: "done" };
    },
  };
  return { model, captured };
}

const researcher: SubagentDef = { name: "researcher", header: "answers research questions" };

describe("promptHooks", () => {
  it("#4/#8 function-form toolDescriptions override for delegate_to gets the real default string", async () => {
    const { model, captured } = capturingModel();
    let receivedDefault = "";
    const agent = createSmartAgent({
      name: "p",
      model,
      subagents: [researcher],
      summarization: false,
      promptHooks: {
        toolDescriptions: {
          delegate_to: (def: string) => { receivedDefault = def; return def + "\nPrefer the researcher for facts."; },
        },
      },
    } as any);
    await agent.invoke({ messages: [{ role: "user", content: "hi" }] } as any);

    // The callback must have received the real default (a plain string mentioning delegation), not a function.
    expect(typeof receivedDefault).toBe("string");
    expect(receivedDefault).toContain("Delegate");
    expect(receivedDefault).not.toContain("function");
    expect(receivedDefault).not.toContain("=>");
    // The model-visible description = default + suffix, applied exactly once.
    const desc = captured.toolDescriptions["delegate_to"];
    expect(desc).toContain("Prefer the researcher for facts.");
    expect(desc.match(/Prefer the researcher for facts\./g)?.length).toBe(1);
    expect(desc).not.toContain("[object Function]");
  });

  it("string-form toolDescriptions override replaces a built-in description", async () => {
    const { model, captured } = capturingModel();
    const agent = createSmartAgent({
      name: "p", model, subagents: [researcher], summarization: false,
      promptHooks: { toolDescriptions: { delegate_to: "CUSTOM delegate description" } },
    } as any);
    await agent.invoke({ messages: [{ role: "user", content: "hi" }] } as any);
    expect(captured.toolDescriptions["delegate_to"]).toBe("CUSTOM delegate description");
  });

  it("transformSystemPrompt rewrites the composed system prompt", async () => {
    const { model, captured } = capturingModel();
    const agent = createSmartAgent({
      name: "p", model, summarization: false,
      promptHooks: { transformSystemPrompt: (prompt) => prompt + "\n<<SENTINEL>>" },
    } as any);
    await agent.invoke({ messages: [{ role: "user", content: "hi" }] } as any);
    expect(captured.systemPrompt).toContain("<<SENTINEL>>");
  });

  it("subagentCatalog rewrites the <available_subagents> block", async () => {
    const { model, captured } = capturingModel();
    const agent = createSmartAgent({
      name: "p", model, subagents: [researcher], summarization: false,
      promptHooks: { subagentCatalog: () => "<available_subagents>REPLACED</available_subagents>" },
    } as any);
    await agent.invoke({ messages: [{ role: "user", content: "hi" }] } as any);
    expect(captured.systemPrompt).toContain("<available_subagents>REPLACED</available_subagents>");
  });
});
