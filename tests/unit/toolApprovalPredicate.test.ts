/**
 * Approval decided per CALL, from the arguments.
 *
 * The gate used to read a static boolean, which meant a dangerous tool was
 * either always gated or never — `Bash(rm *)` could not be expressed at all.
 */

import { describe, expect, it } from "vitest";
import { z } from "zod";

import { createTool } from "../../src/tool.js";

/** The runtime's decision, mirrored so the contract is asserted, not the internals. */
function resolveNeedsApproval(tool: any, args: any): boolean {
  const spec = tool?.needsApproval;
  if (typeof spec === "function") {
    try {
      return Boolean(spec(args));
    } catch {
      return true;
    }
  }
  return Boolean(spec);
}

const bash = (needsApproval: any) => createTool({
  name: "bash",
  schema: z.object({ command: z.string() }),
  func: async () => "ok",
  needsApproval
});

describe("createTool carries an approval predicate", () => {
  it("keeps a function as-is, alongside the boolean form", () => {
    const predicate = (args: { command: string }) => args.command.startsWith("rm ");
    expect((bash(predicate) as any).needsApproval).toBe(predicate);
    expect((bash(true) as any).needsApproval).toBe(true);
    expect((bash(false) as any).needsApproval).toBe(false);
  });

  it("drops a value that is neither, rather than letting it read as truthy", () => {
    expect((bash("yes") as any).needsApproval).toBeUndefined();
    expect((bash(1) as any).needsApproval).toBeUndefined();
  });
});

describe("the per-call decision", () => {
  const tool = bash((args: { command: string }) => /^\s*rm\b/.test(args.command));

  it("gates the arguments that warrant it and lets the rest through", () => {
    expect(resolveNeedsApproval(tool, { command: "rm -rf build" })).toBe(true);
    expect(resolveNeedsApproval(tool, { command: "ls -la" })).toBe(false);
  });

  it("still honours a plain boolean, unchanged", () => {
    expect(resolveNeedsApproval(bash(true), { command: "ls" })).toBe(true);
    expect(resolveNeedsApproval(bash(false), { command: "rm -rf /" })).toBe(false);
    // A tool that says nothing is ungated, exactly as before predicates existed.
    expect(resolveNeedsApproval({ name: "x" }, {})).toBe(false);
  });

  it("FAILS CLOSED when the predicate throws", () => {
    // A gate that cannot decide has not granted permission. The asymmetry is the
    // point: a needless prompt is an annoyance, a skipped one is an unreviewed
    // action.
    const exploding = bash(() => { throw new Error("policy lookup failed"); });
    expect(resolveNeedsApproval(exploding, { command: "ls" })).toBe(true);
  });

  it("treats a non-boolean return as no", () => {
    expect(resolveNeedsApproval(bash(() => undefined as never), { command: "rm" })).toBe(false);
    expect(resolveNeedsApproval(bash(() => "" as never), { command: "rm" })).toBe(false);
  });
});

describe("approvalPrompt may quote the call", () => {
  function resolveApprovalPrompt(tool: any, args: any): string | undefined {
    const prompt = tool?.approvalPrompt;
    if (typeof prompt === "function") {
      try {
        const resolved = prompt(args);
        return typeof resolved === "string" && resolved.length > 0 ? resolved : undefined;
      } catch {
        return undefined;
      }
    }
    return typeof prompt === "string" ? prompt : undefined;
  }

  it("renders the arguments into the question", () => {
    const tool = createTool({
      name: "bash",
      schema: z.object({ command: z.string() }),
      func: async () => "ok",
      needsApproval: true,
      approvalPrompt: (args: { command: string }) => `Run \`${args.command}\`?`
    });

    expect(resolveApprovalPrompt(tool, { command: "rm -rf build" })).toBe("Run `rm -rf build`?");
  });

  it("loses only the wording when it throws — never the pause", () => {
    const tool = createTool({
      name: "bash",
      schema: z.object({ command: z.string() }),
      func: async () => "ok",
      needsApproval: true,
      approvalPrompt: () => { throw new Error("nope"); }
    });

    expect(resolveApprovalPrompt(tool, {})).toBeUndefined();
    expect(resolveNeedsApproval(tool, {})).toBe(true);
  });

  it("keeps the plain string form", () => {
    const tool = createTool({
      name: "bash",
      schema: z.object({ command: z.string() }),
      func: async () => "ok",
      approvalPrompt: "Are you sure?"
    });

    expect(resolveApprovalPrompt(tool, {})).toBe("Are you sure?");
  });
});

// ---------------------------------------------------------------------------
// Through the real agent, so the WIRING is proven and not just the contract.
// ---------------------------------------------------------------------------

import { createAgent } from "../../src/index.js";
import type { Message } from "../../src/types.js";

function agentCalling(command: string, tool: any) {
  let asked = false;
  const model: any = {
    modelName: "m",
    bindTools() { return model; },
    async invoke(_msgs: Message[]) {
      if (!asked) {
        asked = true;
        return {
          role: "assistant",
          content: "",
          tool_calls: [{ id: "c1", type: "function", function: { name: "bash", arguments: JSON.stringify({ command }) } }]
        };
      }
      return { role: "assistant", content: "done" };
    }
  };
  return createAgent({ model, tools: [tool], limits: { maxToolCalls: 3 } });
}

describe("end to end: the predicate decides whether the turn pauses", () => {
  const ran: string[] = [];
  const gated = createTool({
    name: "bash",
    description: "run a command",
    schema: z.object({ command: z.string() }),
    func: async ({ command }: { command: string }) => { ran.push(command); return "ok"; },
    needsApproval: (args: { command: string }) => /^\s*rm\b/.test(args.command ?? "")
  });

  it("pauses a matching call before the tool runs", async () => {
    ran.length = 0;
    const result: any = await agentCalling("rm -rf build", gated)
      .invoke({ messages: [{ role: "user", content: "go" }] } as any);

    const pending = result?.pendingApprovals ?? result?.state?.pendingApprovals ?? [];
    expect(pending.length, "a matching call should raise one pending approval").toBe(1);
    expect(pending[0].toolName).toBe("bash");
    expect(pending[0].args).toMatchObject({ command: "rm -rf build" });
    // The whole point: the side effect has NOT happened yet.
    expect(ran).toEqual([]);
  });

  it("lets a non-matching call straight through", async () => {
    ran.length = 0;
    const result: any = await agentCalling("ls -la", gated)
      .invoke({ messages: [{ role: "user", content: "go" }] } as any);

    const pending = result?.pendingApprovals ?? result?.state?.pendingApprovals ?? [];
    expect(pending.length, "a harmless call should not be gated").toBe(0);
    expect(ran).toEqual(["ls -la"]);
  });
});
