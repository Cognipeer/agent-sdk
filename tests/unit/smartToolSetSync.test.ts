/**
 * The smart driver's per-iteration tool-set sync, around runtimes it does not own.
 *
 * `syncRuntimeTools` writes this agent's tool set onto the active runtime every
 * iteration. That is right for its own runtime and wrong for a HANDOFF target,
 * which must keep the tools it was handed — so the loop skips a runtime it did
 * not produce.
 *
 * The trap is how "did not produce" is decided. Object identity is not enough:
 * when a skill injects tools (`__runtimeToolsDelta`) the tools node CLONES the
 * runtime, and a clone fails an identity check exactly like a foreign runtime
 * does. The loop then stops syncing for the rest of the run — so once a tool
 * response is archived, `get_tool_response` can never be bound, while the system
 * prompt keeps telling the model to call it. The model asks for a tool that is
 * not on its menu, every time.
 *
 * Ownership is therefore carried on the runtime itself, so a clone stays ours.
 */

import { describe, it, expect } from "vitest";
import { z } from "zod";
import { createSmartAgent } from "../../src/smart/index.js";
import { createTool } from "../../src/tool.js";

/** Big enough to push the run over the summarization trigger below. */
const BIG = "x".repeat(4000);

function buildAgent(menus: string[][]) {
  const inject = createTool({
    name: "inject",
    description: "injects a runtime tool, the way open_skill does",
    schema: z.object({}),
    func: async () => ({
      note: BIG,
      __runtimeToolsDelta: [
        createTool({
          name: "injected_tool",
          description: "injected at runtime",
          schema: z.object({}),
          func: async () => "x",
        }),
      ],
    }),
  });

  const emitMarker = createTool({
    name: "emit_marker",
    description: "returns an archived-response marker",
    schema: z.object({}),
    // What the runtime writes when it archives a large tool response; it is the
    // signal that makes the loop swap `get_tool_response` onto the menu.
    func: async () =>
      `ARCHIVED_TOOL_RESPONSE [toolName=big, executionId=exec_1] Use get_tool_response with executionId="exec_1" ${BIG}`,
  });

  let turn = 0;
  const model = {
    modelName: "sync-stub",
    bindTools(tools: Array<{ name: string }>) {
      menus.push(tools.map((t) => t.name));
      return this;
    },
    async invoke() {
      turn += 1;
      const call = (name: string) => ({
        role: "assistant",
        content: "",
        tool_calls: [{ id: `c${turn}`, type: "function", function: { name, arguments: "{}" } }],
      });
      if (turn === 1) return call("inject");
      if (turn === 2) return call("emit_marker");
      if (turn < 6) return { role: "assistant", content: "summary of the conversation so far" };
      return { role: "assistant", content: "done" };
    },
  } as never;

  return createSmartAgent({
    name: "Sync",
    model,
    tools: [inject, emitMarker],
    limits: { maxToolCalls: 6 },
    // A tiny trigger makes the base agent hand control back mid-turn, which is
    // what gives the driver a second iteration to re-sync the tool set in.
    summarization: { enable: true, summaryTriggerTokens: 100, maxTokens: 100 },
  });
}

describe("syncRuntimeTools after a runtime-tools delta", () => {
  it("can still bind get_tool_response once a response is archived", async () => {
    const menus: string[][] = [];
    await buildAgent(menus).invoke({ messages: [{ role: "user", content: "go" }] });

    // Without this, the tool set is frozen from the delta onward and the
    // recovery tool never reaches the model, though the prompt demands it.
    expect(menus.some((menu) => menu.includes("get_tool_response"))).toBe(true);
  });

  it("still hands the injected tool to the model on the turns that follow it", async () => {
    const menus: string[][] = [];
    await buildAgent(menus).invoke({ messages: [{ role: "user", content: "go" }] });

    const injectIndex = menus.findIndex((menu) => menu.includes("inject"));
    expect(injectIndex).toBeGreaterThanOrEqual(0);
    // The delta has to reach the wire at least once, or injecting tools would
    // be pointless — this is the half the freeze accidentally got right.
    expect(menus.some((menu) => menu.includes("injected_tool"))).toBe(true);
  });
});
