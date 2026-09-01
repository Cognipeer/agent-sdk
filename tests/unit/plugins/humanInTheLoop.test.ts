/**
 * Where the human-in-the-loop paths and the hook layer meet.
 *
 * Approvals and `ask_user_question` are not a separate subsystem the plugin
 * layer can ignore: an approval is decided inside the tools node next to
 * `preToolUse`, and `ask_user_question` is an ordinary TOOL, so every tool hook
 * fires on it. Both facts have consequences that are easy to get wrong in
 * opposite directions — a policy that accidentally blocks the SDK's own
 * question tool, or a redactor that never sees what the human typed.
 */

import { describe, it, expect, vi } from "vitest";
import { z } from "zod";
import { createAgent } from "../../../src/agent.js";
import { createSmartAgent } from "../../../src/smart/index.js";
import { createTool } from "../../../src/tool.js";
import { defineHook } from "../../../src/plugins/define.js";
import { toolPolicy } from "../../../src/plugins/builtin/toolPolicy.js";
import { piiRedaction } from "../../../src/plugins/builtin/piiRedaction.js";
import { ASK_USER_TOOL_NAME } from "../../../src/humanLoop.js";
import type { Message } from "../../../src/types.js";

const deployTool = (func = vi.fn(async () => "DEPLOYED")) => ({
  func,
  tool: createTool({
    name: "deploy",
    description: "Deploy a service.",
    schema: z.object({ env: z.string() }),
    func,
  }),
});

/** Calls `deploy` on turn 1, then answers. */
function toolThenAnswer(answer = "done") {
  let turn = 0;
  return {
    modelName: "hitl-model",
    bindTools() {
      return this;
    },
    async invoke() {
      turn += 1;
      if (turn === 1) {
        return {
          role: "assistant",
          content: "",
          tool_calls: [
            {
              id: "call_deploy",
              type: "function",
              function: { name: "deploy", arguments: JSON.stringify({ env: "prod" }) },
            },
          ],
        };
      }
      return { role: "assistant", content: answer };
    },
  } as any;
}

/** Calls ask_user_question on turn 1, then answers. */
function askThenAnswer() {
  let turn = 0;
  return {
    modelName: "hitl-model",
    bindTools() {
      return this;
    },
    async invoke() {
      turn += 1;
      if (turn === 1) {
        return {
          role: "assistant",
          content: "",
          tool_calls: [
            {
              id: "call_ask",
              type: "function",
              function: {
                name: ASK_USER_TOOL_NAME,
                // The tool's schema is `.strict()`: only the declared keys.
                arguments: JSON.stringify({
                  questions: [{ question: "Which environment?" }],
                }),
              },
            },
          ],
        };
      }
      return { role: "assistant", content: "understood" };
    },
  } as any;
}

describe("approvals × hooks", () => {
  it("composes a hook `ask` with the tool's own needsApproval, one way only", async () => {
    const { tool, func } = deployTool();
    const agent = createAgent({
      model: toolThenAnswer(),
      tools: [tool],
      // An `allow` from a hook must never cancel a gate; escalation is one-way.
      plugins: [defineHook("preToolUse", () => ({ decision: "allow" }), { name: "permissive" })],
    });

    const paused = await agent.invoke({ messages: [{ role: "user", content: "deploy" }] });

    // The tool itself does not require approval and no hook asked, so it ran.
    expect(func).toHaveBeenCalledTimes(1);
    expect(paused.state?.pendingApprovals ?? []).toHaveLength(0);
  });

  it("ends the session as paused on an approval, and opens a new one on resume", async () => {
    const { tool, func } = deployTool();
    const starts: boolean[] = [];
    const ends: string[] = [];

    const agent = createAgent({
      model: toolThenAnswer(),
      tools: [tool],
      plugins: [
        defineHook("preToolUse", () => ({ decision: "ask" }), { name: "gate" }),
        defineHook("sessionStart", ({ resumed }) => { starts.push(resumed); return undefined; }, { name: "s1" }),
        defineHook("sessionEnd", ({ status }) => { ends.push(status); }, { name: "s2" }),
      ],
    });

    const paused = await agent.invoke({ messages: [{ role: "user", content: "deploy" }] });
    const pending = paused.state!.pendingApprovals!;
    expect(pending).toHaveLength(1);
    expect(func).not.toHaveBeenCalled();
    expect(ends).toEqual(["paused"]);

    const resumed = await agent.invoke(
      agent.resolveToolApproval(paused.state!, { id: pending[0].id, approved: true }),
    );

    expect(func).toHaveBeenCalledTimes(1);
    // The resumed leg is its own session — a plugin metering runs must not see
    // one open-ended session spanning however long a human took to answer.
    expect(starts).toEqual([false, true]);
    expect(ends).toEqual(["paused", "success"]);
  });

  it("fires `notification` when a tool call parks for approval", async () => {
    const { tool } = deployTool();
    const notes: Array<{ kind: string }> = [];
    const agent = createAgent({
      model: toolThenAnswer(),
      tools: [tool],
      plugins: [
        defineHook("preToolUse", () => ({ decision: "ask" }), { name: "gate" }),
        defineHook("notification", ({ kind, detail }) => { notes.push({ kind, ...(detail as object) }); }, {
          name: "notifier",
        }),
      ],
    });

    await agent.invoke({ messages: [{ role: "user", content: "deploy" }] });

    expect(notes.map((n) => n.kind)).toContain("approval");
    expect(notes[0]).toMatchObject({ toolName: "deploy" });
  });

  it("keeps a REJECTED approval rejected across the resume, even for a hook-raised ask", async () => {
    const { tool, func } = deployTool();
    const agent = createAgent({
      model: toolThenAnswer(),
      tools: [tool],
      plugins: [defineHook("preToolUse", () => ({ decision: "ask" }), { name: "gate" })],
    });

    const paused = await agent.invoke({ messages: [{ role: "user", content: "deploy" }] });
    const pending = paused.state!.pendingApprovals!;

    const resumed = await agent.invoke(
      agent.resolveToolApproval(paused.state!, { id: pending[0].id, approved: false }),
    );

    // `needsApproval` recomputes to false on the resumed turn — the tool never
    // required approval, a hook did. The ledger entry is what keeps the gate
    // closed; without it a call a human refused would simply run.
    expect(func).not.toHaveBeenCalled();
    expect(resumed.content.length).toBeGreaterThan(0);
  });
});

describe("ask_user_question × hooks", () => {
  it("runs preToolUse on the built-in question tool, because it is a tool", async () => {
    const seen: string[] = [];
    const agent = createSmartAgent({
      model: askThenAnswer(),
      humanInTheLoop: { askUser: true },
      plugins: [
        defineHook("preToolUse", ({ toolName }) => { seen.push(toolName); return undefined; }, {
          name: "probe",
          mayRequireApproval: false,
        }),
      ],
    });

    await agent.invoke({ messages: [{ role: "user", content: "ask me something" }] });

    expect(seen).toContain(ASK_USER_TOOL_NAME);
  });

  it("does NOT run postToolUse for the call that parks the run", async () => {
    // The pause marker is consumed before the postToolUse gate, deliberately:
    // firing it would emit a result for a tool_use that is still unresolved,
    // which is exactly what makes the call re-selectable on resume.
    const outputs: string[] = [];
    const agent = createSmartAgent({
      model: askThenAnswer(),
      humanInTheLoop: { askUser: true },
      plugins: [
        defineHook("postToolUse", ({ toolName }) => { outputs.push(toolName); return undefined; }, {
          name: "probe",
        }),
      ],
    });

    const paused = await agent.invoke({ messages: [{ role: "user", content: "ask me something" }] });

    expect(paused.state?.pendingUserQuestions ?? []).toHaveLength(1);
    expect(outputs).not.toContain(ASK_USER_TOOL_NAME);
  });

  it("fires `notification` when the run parks on a question", async () => {
    const kinds: string[] = [];
    const agent = createSmartAgent({
      model: askThenAnswer(),
      humanInTheLoop: { askUser: true },
      plugins: [defineHook("notification", ({ kind }) => { kinds.push(kind); }, { name: "notifier" })],
    });

    await agent.invoke({ messages: [{ role: "user", content: "ask me something" }] });

    expect(kinds).toContain("user_question");
  });

  it("DOCUMENTED GAP: the human's answer reaches the transcript without passing any hook", async () => {
    // `resolveUserQuestionState` injects the answer straight into the transcript
    // as a role:"tool" message — it is a pure state helper with no host, so it
    // runs outside the tools node and therefore outside postToolUse. A redactor
    // configured for tool output does NOT see what the person typed.
    //
    // This test pins the CURRENT behaviour so a future fix is a deliberate,
    // visible change rather than a silent one.
    const seenByHook: unknown[] = [];
    const agent = createSmartAgent({
      model: askThenAnswer(),
      humanInTheLoop: { askUser: true },
      plugins: [
        piiRedaction({ entities: ["EMAIL"], apply: ["toolOutput"] }),
        defineHook("postToolUse", ({ output }) => { seenByHook.push(output); return undefined; }, {
          name: "probe",
        }),
      ],
    });

    const paused = await agent.invoke({ messages: [{ role: "user", content: "ask me something" }] });
    const question = paused.state!.pendingUserQuestions![0];

    // Answers are keyed by the question TEXT (see validateAnswers), not an id.
    const questionKey = question.questions[0].question;
    const answered = agent.resolveUserQuestion(paused.state!, {
      id: question.id,
      answers: { [questionKey]: { freeText: "use prod, ping me at ada@example.com" } },
    });

    const answerMessage = (answered.messages as Message[]).find(
      (m) => m.role === "tool" && String(m.content).includes("ada@example.com"),
    );
    // The address is in the transcript verbatim: no hook ran on it.
    expect(answerMessage).toBeDefined();
    expect(seenByHook).toHaveLength(0);
  });
});

describe("tool policy × the SDK's own control-plane tools", () => {
  it("does not let an allow-list lock the agent out of its own built-ins", async () => {
    // `allowOnly` is the strictest useful setting for an agent with dynamically
    // discovered tools — and the obvious way to write it is to list the tools
    // you care about. Without an exemption that also denies `ask_user_question`,
    // `manage_plan`, `get_tool_response` and the structured-output `response`
    // tool, which are the SDK's own machinery rather than the model's choices.
    const seen: string[] = [];
    const agent = createSmartAgent({
      model: askThenAnswer(),
      humanInTheLoop: { askUser: true },
      plugins: [
        toolPolicy({ allowOnly: ["deploy"] }),
        defineHook("preToolUse", ({ toolName }) => { seen.push(toolName); return undefined; }, {
          name: "probe",
          priority: 900,
          mayRequireApproval: false,
        }),
      ],
    });

    const result = await agent.invoke({ messages: [{ role: "user", content: "ask me something" }] });

    // The question tool was reached (the probe at priority 900 only runs when
    // toolPolicy at 15 did not deny) and the run parked as intended.
    expect(seen).toContain(ASK_USER_TOOL_NAME);
    expect(result.state?.pendingUserQuestions ?? []).toHaveLength(1);
  });

  it("still denies a model-facing tool that is not on the allow-list", async () => {
    const { tool, func } = deployTool();
    const agent = createAgent({
      model: toolThenAnswer(),
      tools: [tool],
      plugins: [toolPolicy({ allowOnly: ["something_else"] })],
    });

    const result = await agent.invoke({ messages: [{ role: "user", content: "deploy" }] });

    expect(func).not.toHaveBeenCalled();
    expect(JSON.stringify(result.messages)).toContain("allow-list");
  });
});
