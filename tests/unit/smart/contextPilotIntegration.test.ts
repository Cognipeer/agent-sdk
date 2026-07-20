/**
 * ContextPilot end-to-end integration test: exercises the real wiring
 * through createSmartAgent -> tools node -> toolHistory, using only default
 * ContextPilot configuration (nothing explicitly enabled by the caller).
 */

import { describe, it, expect } from "vitest";
import { createSmartAgent, createTool } from "../../../src/index.js";
import { z } from "zod";
import type { Message } from "../../../src/types.js";

function buildLargeSearchResults(): Array<{ id: number; title: string }> {
  return Array.from({ length: 25 }, (_, i) => ({
    id: i,
    title: i === 12 ? "target-widget-42 exact match" : `unrelated filler product ${i}`,
  }));
}

type DeterministicModel = {
  modelName: string;
  bindTools: () => DeterministicModel;
  invoke: (messages: Message[]) => Promise<Message>;
};

function createDeterministicModel(): DeterministicModel {
  let turn = 0;
  const model: DeterministicModel = {
    modelName: "deterministic-context-pilot-model",
    bindTools() {
      return model;
    },
    async invoke(): Promise<Message> {
      turn += 1;
      if (turn === 1) {
        return {
          role: "assistant",
          content: "",
          tool_calls: [{
            id: "call_search",
            type: "function",
            name: "search_items",
            args: { query: "target-widget-42" },
            function: { name: "search_items", arguments: JSON.stringify({ query: "target-widget-42" }) },
          }],
        };
      }
      return { role: "assistant", content: "Found target-widget-42." };
    },
  };
  return model;
}

describe("ContextPilot end-to-end wiring", () => {
  it("compresses a large tool output by default and keeps it recoverable via the CCR store", async () => {
    const searchItems = createTool({
      name: "search_items",
      description: "Search a large product catalog.",
      schema: z.object({ query: z.string() }),
      func: async () => buildLargeSearchResults(),
    });

    const model = createDeterministicModel();
    const agent = createSmartAgent({
      name: "ContextPilotAgent",
      model,
      tools: [searchItems],
      limits: { maxToolCalls: 4 },
    });

    const result = await agent.invoke({
      messages: [{ role: "user", content: "Find target-widget-42 in the catalog." }],
    });

    const toolHistory = result.state?.toolHistory || [];
    expect(toolHistory.length).toBe(1);
    const entry = toolHistory[0];

    expect(entry.contextPilot?.applied).toBe(true);
    expect(entry.contextPilot?.compressorUsed).toBe("jsonCrusher");
    expect(Array.isArray(entry.rawOutput)).toBe(true);
    expect((entry.rawOutput as any[]).length).toBe(25);
    expect(Array.isArray(entry.output)).toBe(true);
    expect((entry.output as any[]).length).toBeLessThan(25);

    // The relevant item (matching the user's query) should survive compression.
    const compressedHasTarget = (entry.output as any[]).some((item: any) => item?.title?.includes("target-widget-42"));
    expect(compressedHasTarget).toBe(true);

    // The dropped items must remain fully recoverable via the CCR store.
    const ccrHash = entry.contextPilot?.ccrHash;
    expect(ccrHash).toBeTruthy();
    const ccrStore = (result.state?.ctx as any)?.__contextPilot?.ccrStore;
    expect(ccrStore).toBeTruthy();
    const recovered = ccrStore.retrieve(ccrHash);
    expect(recovered).toEqual(entry.rawOutput);
  });

  it("can be disabled entirely via contextPilot: { enabled: false }", async () => {
    const searchItems = createTool({
      name: "search_items",
      description: "Search a large product catalog.",
      schema: z.object({ query: z.string() }),
      func: async () => buildLargeSearchResults(),
    });

    const model = createDeterministicModel();
    const agent = createSmartAgent({
      name: "ContextPilotDisabledAgent",
      model,
      tools: [searchItems],
      limits: { maxToolCalls: 4 },
      contextPilot: { enabled: false },
    });

    const result = await agent.invoke({
      messages: [{ role: "user", content: "Find target-widget-42 in the catalog." }],
    });

    const entry = (result.state?.toolHistory || [])[0];
    expect(entry.contextPilot).toBeUndefined();
    expect((entry.output as any[]).length).toBe(25);
  });
});
