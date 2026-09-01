/**
 * Plugin hooks driven END TO END through `createAgent` / `createSmartAgent`.
 *
 * The composition rules (R1-R8) are unit-tested against the host elsewhere;
 * what this file protects is the WIRING — that a hook's verdict actually
 * reaches the transcript, the tool executor, the approval ledger, the bound
 * tool menu and the usage ledger, and that a run with no plugins is byte-for
 * byte the run it was before the plugin layer existed.
 *
 * Two invariants are worth naming because they are invisible from the hook's
 * own point of view:
 *   - a `preToolUse` deny must resolve the tool_use exactly like a rejected
 *     approval (one tool message, a "rejected" history row, one toolCallCount
 *     tick) or the next provider call sees a dangling tool_call;
 *   - `sessionStart`/`sessionEnd` are per LOGICAL run, not per `base.invoke()`
 *     — createSmartAgent's driver loop re-enters the base agent whenever it
 *     has to compact, and a plugin must not be told the run started twice.
 */

import { describe, it, expect, vi } from "vitest";
import { z } from "zod";

import { createAgent, createSmartAgent, createTool } from "../../../src/index.js";
import type { AgentPlugin } from "../../../src/plugins/types.js";
import type { Message } from "../../../src/types.js";

// ─── Fakes ───────────────────────────────────────────────────────────────────

type ScriptTurn =
  | { text: string }
  | { tool: string; args: Record<string, unknown>; id?: string };

/**
 * The newer inline model fake: an object literal cast to `any`, so a test can
 * capture the bound tool menu (`bindTools`) and the exact wire messages /
 * invoke options (`invoke`). The last scripted turn repeats forever, which is
 * what keeps a loop that runs one extra iteration from throwing.
 */
function scriptedModel(turns: ScriptTurn[]) {
  const seen: Array<{ messages: Message[]; params: any }> = [];
  const boundMenus: string[][] = [];
  let index = 0;

  const model: any = {
    modelName: "scripted-model",
    bindTools(tools: any[]) {
      boundMenus.push(tools.map((tool: any) => tool?.name));
      return this;
    },
    async invoke(messages: Message[], params?: any) {
      seen.push({ messages: [...messages], params });
      const turn = turns[Math.min(index, turns.length - 1)];
      index += 1;
      if ("text" in turn) return { role: "assistant", content: turn.text };
      return {
        role: "assistant",
        content: "",
        tool_calls: [
          {
            id: turn.id ?? `call_${index}`,
            type: "function",
            function: { name: turn.tool, arguments: JSON.stringify(turn.args) },
          },
        ],
      };
    },
  };

  return { model, seen, boundMenus };
}

/** A tool whose execution is observable, with a `{ message: string }` schema. */
function spyTool(name: string, output: unknown = "TOOL_RAN") {
  const func = vi.fn(async (_args: any) => output);
  const tool = createTool({
    name,
    description: `${name} (test tool)`,
    schema: z.object({ message: z.string() }),
    func,
  });
  return { tool, func };
}

const toolMessages = (messages: Message[]) => messages.filter((m: any) => m?.role === "tool");
const assistantMessages = (messages: Message[]) => messages.filter((m: any) => m?.role === "assistant");

// ─── preToolUse: deny ────────────────────────────────────────────────────────

describe("preToolUse deny", () => {
  it("resolves the tool_use without executing it, and the model sees the denial", async () => {
    const { tool, func } = spyTool("danger");
    const { model, seen } = scriptedModel([
      { tool: "danger", args: { message: "drop everything" }, id: "tc_1" },
      { text: "understood, I stopped" },
    ]);

    const denyPlugin: AgentPlugin = {
      name: "deny-danger",
      hooks: {
        preToolUse: ({ toolName }) =>
          toolName === "danger" ? { decision: "deny", reason: "danger is off limits" } : undefined,
      },
    };

    const agent = createAgent({
      name: "denier",
      model,
      tools: [tool],
      limits: { maxToolCalls: 3 },
      plugins: [denyPlugin],
    });

    const result = await agent.invoke({ messages: [{ role: "user", content: "go" }] } as any);

    // The whole point: the side effect never happened.
    expect(func).not.toHaveBeenCalled();

    // Exactly ONE tool message, carrying the reason. Two would double-answer a
    // single tool_use; zero would leave it dangling.
    const tools = toolMessages(result.messages);
    expect(tools).toHaveLength(1);
    expect(tools[0].tool_call_id).toBe("tc_1");
    expect(String(tools[0].content)).toContain("danger is off limits");

    // Bookkeeping is the rejected-approval shape: a "rejected" row (so the
    // per-run execution budget is not consumed) and exactly one tick.
    const history = result.state?.toolHistory ?? [];
    expect(history).toHaveLength(1);
    expect(history[0].status).toBe("rejected");
    expect(history[0].toolName).toBe("danger");
    expect(result.state?.toolCallCount).toBe(1);

    // The denial is fed back to the model rather than swallowed.
    expect(seen.length).toBeGreaterThanOrEqual(2);
    const secondCall = seen[1].messages;
    expect(
      secondCall.some((m: any) => m?.role === "tool" && String(m.content).includes("danger is off limits")),
    ).toBe(true);
    expect(result.content).toBe("understood, I stopped");
  });
});

// ─── preToolUse: argument rewriting ──────────────────────────────────────────

describe("preToolUse argument rewriting", () => {
  it("executes and records the REWRITTEN arguments, not the model's", async () => {
    const received: any[] = [];
    const tool = createTool({
      name: "writer",
      description: "writes a message",
      schema: z.object({ message: z.string() }),
      func: async (args: any) => {
        received.push(args);
        return `wrote ${args.message}`;
      },
    });
    const { model } = scriptedModel([
      { tool: "writer", args: { message: "raw-from-model" }, id: "tc_1" },
      { text: "done" },
    ]);

    const rewrite: AgentPlugin = {
      name: "arg-rewriter",
      hooks: {
        preToolUse: ({ args }) => ({ args: { ...(args as any), message: "rewritten-by-plugin" } }),
      },
    };

    const agent = createAgent({
      name: "rewriter",
      model,
      tools: [tool],
      limits: { maxToolCalls: 3 },
      plugins: [rewrite],
    });

    const result = await agent.invoke({ messages: [{ role: "user", content: "go" }] } as any);

    expect(received).toHaveLength(1);
    expect(received[0].message).toBe("rewritten-by-plugin");

    // The history has to agree with what actually ran, or an audit of the run
    // describes a call that never happened.
    const history = result.state?.toolHistory ?? [];
    expect(history).toHaveLength(1);
    expect((history[0].args as any).message).toBe("rewritten-by-plugin");
    expect(String(toolMessages(result.messages)[0].content)).toContain("rewritten-by-plugin");
  });

  it("REFUSES a rewrite that violates the tool's schema instead of running it", async () => {
    const { tool, func } = spyTool("strict_tool");
    const { model } = scriptedModel([
      { tool: "strict_tool", args: { message: "valid" }, id: "tc_1" },
      { text: "done" },
    ]);

    const badRewrite: AgentPlugin = {
      name: "bad-rewriter",
      // `message` is required and cannot be repaired out of thin air, so the
      // rewrite is unrunnable rather than merely odd.
      hooks: { preToolUse: () => ({ args: { notMessage: "oops" } }) },
    };

    const agent = createAgent({
      name: "strict",
      model,
      tools: [tool],
      limits: { maxToolCalls: 3 },
      plugins: [badRewrite],
    });

    const result = await agent.invoke({ messages: [{ role: "user", content: "go" }] } as any);

    expect(func).not.toHaveBeenCalled();
    const tools = toolMessages(result.messages);
    expect(tools).toHaveLength(1);
    expect(String(tools[0].content)).toContain("validation failed after a plugin rewrite");
    expect(result.state?.toolCallCount).toBe(1);
  });
});

// ─── preToolUse: result short-circuit ────────────────────────────────────────

describe("preToolUse result short-circuit", () => {
  it("serves the plugin's result without calling the tool, and does not claim a cache hit", async () => {
    const { tool, func } = spyTool("lookup");
    const { model } = scriptedModel([
      { tool: "lookup", args: { message: "who?" }, id: "tc_1" },
      { text: "answered" },
    ]);

    const stub: AgentPlugin = {
      name: "stub-lookup",
      hooks: { preToolUse: () => ({ result: { served: "by-plugin" } }) },
    };

    const agent = createAgent({
      name: "stubbed",
      model,
      tools: [tool],
      limits: { maxToolCalls: 3 },
      plugins: [stub],
    });

    const result = await agent.invoke({ messages: [{ role: "user", content: "go" }] } as any);

    expect(func).not.toHaveBeenCalled();

    // The transcript and the ledger still look like a completed tool call —
    // the model must not be able to tell the difference.
    const tools = toolMessages(result.messages);
    expect(tools).toHaveLength(1);
    expect(String(tools[0].content)).toContain("by-plugin");

    const history = result.state?.toolHistory ?? [];
    expect(history).toHaveLength(1);
    expect(history[0].status).toBe("success");
    expect(history[0].output).toEqual({ served: "by-plugin" });
    // Provenance matters: a plugin-served result is NOT a cache hit, and
    // reporting it as one would corrupt every cache-effectiveness metric.
    expect(history[0].fromCache).not.toBe(true);
    expect(result.state?.toolCallCount).toBe(1);
  });
});

// ─── preToolUse: decision "ask" ──────────────────────────────────────────────

/**
 * The tool itself declares NO `needsApproval`, so on the resume turn the static
 * gate recomputes to false. Only the ledger entry keeps the gate closed — hence
 * a hook that asks exactly ONCE, which is what makes the resume turn honest.
 */
function askOnceAgent() {
  const { tool, func } = spyTool("deploy", "DEPLOYED");
  const { model } = scriptedModel([
    { tool: "deploy", args: { message: "v2" }, id: "tc_1" },
    { text: "finished" },
  ]);

  let asks = 0;
  const asker: AgentPlugin = {
    name: "ask-once",
    hooks: {
      preToolUse: () => {
        asks += 1;
        return asks === 1 ? { decision: "ask", approvalPrompt: "Deploy v2 to production?" } : undefined;
      },
    },
  };

  const agent = createAgent({
    name: "asker",
    model,
    tools: [tool],
    limits: { maxToolCalls: 3 },
    plugins: [asker],
  });

  return { agent, func, askCount: () => asks };
}

describe('preToolUse decision "ask" on a tool with no static needsApproval', () => {
  it("pauses the run, then executes the tool once a human approves", async () => {
    const { agent, func } = askOnceAgent();

    const paused = await agent.invoke({ messages: [{ role: "user", content: "ship it" }] } as any);

    expect(func).not.toHaveBeenCalled();
    expect(paused.state?.ctx?.__awaitingApproval).toBeTruthy();
    const pending = paused.state?.pendingApprovals ?? [];
    expect(pending).toHaveLength(1);
    expect(pending[0].toolName).toBe("deploy");
    expect(pending[0].status).toBe("pending");
    // The tool asked for no wording, so the hook's is what the human sees.
    expect(pending[0].metadata?.prompt).toBe("Deploy v2 to production?");

    const approved = agent.resolveToolApproval(paused.state!, { id: pending[0].id, approved: true });
    const resumed = await agent.invoke(approved as any);

    expect(func).toHaveBeenCalledTimes(1);
    const history = resumed.state?.toolHistory ?? [];
    expect(history.filter((entry) => entry.status === "success")).toHaveLength(1);
    expect(resumed.content).toBe("finished");
  });

  it("still does NOT execute the tool when the human rejects it", async () => {
    // The invariant: the hook does not ask again on the resume turn and the
    // tool never required approval statically, so without the ledger entry the
    // gate would silently reopen and run a call a human just refused.
    const { agent, func, askCount } = askOnceAgent();

    const paused = await agent.invoke({ messages: [{ role: "user", content: "ship it" }] } as any);
    const pending = paused.state?.pendingApprovals ?? [];
    expect(pending).toHaveLength(1);

    const rejected = agent.resolveToolApproval(paused.state!, {
      id: pending[0].id,
      approved: false,
      comment: "not today",
    });
    const resumed = await agent.invoke(rejected as any);

    expect(func).not.toHaveBeenCalled();
    expect(askCount()).toBeGreaterThanOrEqual(2); // the hook DID run again, and did not ask
    const tools = toolMessages(resumed.messages);
    expect(tools).toHaveLength(1);
    expect(String(tools[0].content)).toContain("rejected");
    const history = resumed.state?.toolHistory ?? [];
    expect(history).toHaveLength(1);
    expect(history[0].status).toBe("rejected");
  });

  // Session ownership is carried by an explicit handle (InvokeConfig
  // .__pluginSession), never by a marker on ctx. A ctx marker would ride out on
  // `result.state.ctx`, so resuming the documented way —
  // `agent.invoke(agent.resolveToolApproval(result.state, …))` — would hand it
  // straight back and the leg that ACTUALLY EXECUTES the tool would run with no
  // session bracket at all. Guards the contract that sessionStart "fires once
  // per invoke(), including on resume".
  it("fires a fresh sessionStart/sessionEnd for a leg resumed via invoke(state)", async () => {
    const events: string[] = [];
    const { tool, func } = spyTool("deploy", "DEPLOYED");
    const { model } = scriptedModel([
      { tool: "deploy", args: { message: "v2" }, id: "tc_1" },
      { text: "finished" },
    ]);

    let asks = 0;
    const plugin: AgentPlugin = {
      name: "resume-lifecycle",
      hooks: {
        sessionStart: (input) => {
          events.push(`start:${input.resumed}`);
          return undefined;
        },
        sessionEnd: (input) => {
          events.push(`end:${input.status}`);
        },
        preToolUse: () => {
          asks += 1;
          return asks === 1 ? { decision: "ask" } : undefined;
        },
      },
    };

    const agent = createAgent({ name: "resumer", model, tools: [tool], plugins: [plugin] });
    const paused = await agent.invoke({ messages: [{ role: "user", content: "ship it" }] } as any);
    const approved = agent.resolveToolApproval(paused.state!, {
      id: paused.state!.pendingApprovals![0].id,
      approved: true,
    });
    await agent.invoke(approved as any);

    expect(func).toHaveBeenCalledTimes(1);
    // Actual today: ["start:false", "end:paused"] — the resumed leg is silent.
    expect(events).toEqual(["start:false", "end:paused", "start:true", "end:success"]);
  });
});

// ─── postToolUse: output rewriting ───────────────────────────────────────────

describe("postToolUse rewrite", () => {
  it("puts the rewritten output in the transcript and the history, and the raw output never reaches the model", async () => {
    const { tool, func } = spyTool("secrets", "RAW_SECRET_VALUE");
    const { model, seen } = scriptedModel([
      { tool: "secrets", args: { message: "fetch" }, id: "tc_1" },
      { text: "ok" },
    ]);

    const redact: AgentPlugin = {
      name: "redactor",
      hooks: { postToolUse: () => ({ output: "REDACTED" }) },
    };

    const agent = createAgent({
      name: "redacting",
      model,
      tools: [tool],
      limits: { maxToolCalls: 3 },
      plugins: [redact],
    });

    const result = await agent.invoke({ messages: [{ role: "user", content: "go" }] } as any);

    expect(func).toHaveBeenCalledTimes(1);

    const tools = toolMessages(result.messages);
    expect(tools).toHaveLength(1);
    expect(String(tools[0].content)).toBe("REDACTED");

    const history = result.state?.toolHistory ?? [];
    expect(history).toHaveLength(1);
    expect(history[0].output).toBe("REDACTED");

    // The redaction is worthless if the provider saw the payload anyway.
    expect(seen.length).toBeGreaterThanOrEqual(2);
    expect(JSON.stringify(seen[1].messages)).not.toContain("RAW_SECRET_VALUE");
    expect(JSON.stringify(result.messages)).not.toContain("RAW_SECRET_VALUE");
  });
});

// ─── preModelCall ────────────────────────────────────────────────────────────

describe("preModelCall shortCircuit", () => {
  it("skips the provider entirely: one assistant turn, no invoke, no phantom usage row", async () => {
    const { model, seen } = scriptedModel([{ text: "the model should never speak" }]);

    const canned: AgentPlugin = {
      name: "canned-answer",
      hooks: {
        preModelCall: () => ({
          shortCircuit: { role: "assistant", content: "SHORT_CIRCUITED" } as any,
        }),
      },
    };

    const agent = createAgent({
      name: "short",
      model,
      tools: [],
      limits: { maxToolCalls: 3 },
      plugins: [canned],
    });

    const result = await agent.invoke({ messages: [{ role: "user", content: "hi" }] } as any);

    expect(seen).toHaveLength(0);
    expect(result.messages).toHaveLength(2); // user + exactly one assistant turn
    expect(assistantMessages(result.messages)).toHaveLength(1);
    expect(result.content).toBe("SHORT_CIRCUITED");

    // A call that never happened must not be billed.
    expect(result.state?.usage?.perRequest ?? []).toHaveLength(0);
    expect(Object.keys(result.state?.usage?.totals ?? {})).toHaveLength(0);
  });
});

describe("preModelCall tool narrowing", () => {
  it("shrinks the tool menu the provider is actually bound to", async () => {
    const { tool: alpha } = spyTool("alpha");
    const { tool: beta } = spyTool("beta");

    const wide = scriptedModel([{ text: "done" }]);
    const wideAgent = createAgent({ name: "wide", model: wide.model, tools: [alpha, beta] });
    await wideAgent.invoke({ messages: [{ role: "user", content: "hi" }] } as any);
    expect(wide.boundMenus.at(-1)).toEqual(["alpha", "beta"]);

    const narrow = scriptedModel([{ text: "done" }]);
    const narrowing: AgentPlugin = {
      name: "narrower",
      hooks: {
        preModelCall: ({ tools }) => ({ tools: tools.filter((t: any) => t.name === "alpha") }),
      },
    };
    const narrowAgent = createAgent({
      name: "narrow",
      model: narrow.model,
      tools: [alpha, beta],
      plugins: [narrowing],
    });
    await narrowAgent.invoke({ messages: [{ role: "user", content: "hi" }] } as any);

    const bound = narrow.boundMenus.at(-1) ?? [];
    expect(bound).toEqual(["alpha"]);
    expect(bound.length).toBeLessThan((wide.boundMenus.at(-1) ?? []).length);
  });
});

describe("postModelCall deny", () => {
  it("REPLACES the offending assistant turn instead of appending a second one", async () => {
    const { model } = scriptedModel([{ text: "ORIGINAL_UNSAFE_ANSWER" }]);

    const blocker: AgentPlugin = {
      name: "response-blocker",
      hooks: { postModelCall: () => ({ decision: "deny", reason: "unsafe response" }) },
    };

    const agent = createAgent({
      name: "blocking",
      model,
      tools: [],
      limits: { maxToolCalls: 3 },
      plugins: [blocker],
    });

    const result = await agent.invoke({ messages: [{ role: "user", content: "hi" }] } as any);

    // user + ONE assistant turn. An append would give three messages and leave
    // the unsafe turn in the transcript for the next provider call.
    expect(result.messages).toHaveLength(2);
    expect(assistantMessages(result.messages)).toHaveLength(1);
    expect(JSON.stringify(result.messages)).not.toContain("ORIGINAL_UNSAFE_ANSWER");
    expect(result.content).toContain("unsafe response");
    expect((result.state?.ctx as any)?.__guardrailBlocked?.incident?.hook).toBe("postModelCall");
  });
});

// ─── Session lifecycle across the smart driver loop ──────────────────────────

describe("session lifecycle on createSmartAgent", () => {
  it("fires sessionStart and sessionEnd EXACTLY ONCE even though the driver re-enters base.invoke()", async () => {
    // The driver loop re-enters the base agent when the base bails out to
    // signal "compact before the next model call". That is one logical run, and
    // a plugin that opened a span / a transaction on sessionStart must not be
    // told the run started twice.
    const counts = { start: 0, end: 0 };
    const startedResumed: boolean[] = [];
    const endStatuses: string[] = [];
    const iterations: number[] = [];

    // One huge tool payload: it pushes the transcript over the summarization
    // threshold, and because it belongs to the LATEST assistant turn the
    // summarizer legitimately declines to compact it. The base agent therefore
    // bails out once, the driver re-enters it once, and the run terminates —
    // deterministically two base.invoke() calls.
    const bulky = createTool({
      name: "bulk_fetch",
      description: "returns a very large payload",
      schema: z.object({ topic: z.string() }),
      func: async () => `PAYLOAD_LINE `.repeat(1200),
    });

    const { model, seen } = scriptedModel([
      { tool: "bulk_fetch", args: { topic: "orbit" }, id: "tc_1" },
      { text: "here is the summary you asked for" },
    ]);

    const lifecycle: AgentPlugin = {
      name: "lifecycle-counter",
      hooks: {
        sessionStart: (input) => {
          counts.start += 1;
          startedResumed.push(input.resumed);
          return undefined;
        },
        sessionEnd: (input) => {
          counts.end += 1;
          endStatuses.push(input.status);
        },
        // `iteration` restarts at 1 inside every base.invoke(), so seeing 1
        // twice is the proof that the driver really did re-enter the base loop.
        preModelCall: ({ iteration }) => {
          iterations.push(iteration);
          return undefined;
        },
      },
    };

    const agent = createSmartAgent({
      name: "smart-lifecycle",
      model,
      tools: [bulky],
      summarization: { enable: true, maxTokens: 300, summaryPromptMaxTokens: 2000 },
      limits: { maxToolCalls: 4 },
      plugins: [lifecycle],
    });

    const result = await agent.invoke({ messages: [{ role: "user", content: "fetch orbit and summarize" }] } as any);

    // The premise of the test, asserted rather than assumed: two model calls,
    // each of them the FIRST iteration of its own base.invoke().
    expect(iterations).toEqual([1, 1]);
    expect(seen).toHaveLength(2);

    expect(counts.start).toBe(1);
    expect(counts.end).toBe(1);
    expect(startedResumed).toEqual([false]);
    expect(endStatuses).toEqual(["success"]);
    expect(result.content).toContain("here is the summary");
  });

  // The session clock starts with the leg, not with whatever ctx carried in. A
  // start timestamp parked on ctx would survive a snapshot, so a run that sat
  // paused in a store for an hour would report that hour as agent latency to
  // every plugin metering runs.
  it("reports the resumed leg's own duration, not the time the snapshot sat paused", async () => {
    const durations: number[] = [];
    const { tool } = spyTool("deploy", "DEPLOYED");
    const { model } = scriptedModel([
      { tool: "deploy", args: { message: "v2" }, id: "tc_1" },
      { text: "finished" },
    ]);

    let asks = 0;
    const plugin: AgentPlugin = {
      name: "duration-watch",
      hooks: {
        sessionEnd: (input) => {
          durations.push(input.durationMs);
        },
        preToolUse: () => {
          asks += 1;
          return asks === 1 ? { decision: "ask" } : undefined;
        },
      },
    };

    const agent = createAgent({ name: "durations", model, tools: [tool], plugins: [plugin] });
    const paused = await agent.invoke({ messages: [{ role: "user", content: "ship it" }] } as any);
    const snapshot = agent.snapshot(paused.state!);

    // The host persisted the snapshot and a human took their time.
    await new Promise((resolve) => setTimeout(resolve, 200));

    const approved = agent.resolveToolApproval(snapshot.state as any, {
      id: (snapshot.state as any).pendingApprovals[0].id,
      approved: true,
    });
    await agent.resume({ ...snapshot, state: approved } as any);

    expect(durations).toHaveLength(2);
    // Actual today: ~200ms+, because startedAt was restored from the snapshot.
    expect(durations[1]).toBeLessThan(150);
  });
});

// ─── Inline hooks, and the no-plugin regression guard ────────────────────────

describe("inline hooks on the options", () => {
  it("works without declaring a plugin at all", async () => {
    const { tool, func } = spyTool("inline_target");
    const { model } = scriptedModel([
      { tool: "inline_target", args: { message: "x" }, id: "tc_1" },
      { text: "stopped" },
    ]);

    const agent = createAgent({
      name: "inline",
      model,
      tools: [tool],
      limits: { maxToolCalls: 3 },
      hooks: {
        preToolUse: ({ toolName }) =>
          toolName === "inline_target" ? { decision: "deny", reason: "inline says no" } : undefined,
      },
    });

    const result = await agent.invoke({ messages: [{ role: "user", content: "go" }] } as any);

    expect(func).not.toHaveBeenCalled();
    const tools = toolMessages(result.messages);
    expect(tools).toHaveLength(1);
    expect(String(tools[0].content)).toContain("inline says no");
    expect(result.content).toBe("stopped");
  });
});

describe("regression guard: an agent with no plugins", () => {
  it("produces exactly the same message sequence as the same agent without the plugins option", async () => {
    const shape = (messages: Message[]) =>
      messages.map((m: any) => ({
        role: m.role,
        name: m.name,
        content: m.content,
        tool_call_id: m.tool_call_id,
        tool_calls: (m.tool_calls ?? []).map((tc: any) => ({ id: tc.id, name: tc.function?.name })),
      }));

    const script: ScriptTurn[] = [
      { tool: "echoish", args: { message: "hello" }, id: "tc_1" },
      { text: "all done" },
    ];

    const run = async (withPluginsOption: boolean) => {
      const { tool } = spyTool("echoish", "echoed");
      const { model } = scriptedModel(script);
      const base = { name: "guard", model, tools: [tool], limits: { maxToolCalls: 3 } };
      const agent = createAgent(withPluginsOption ? ({ ...base, plugins: [] } as any) : (base as any));
      return agent.invoke({ messages: [{ role: "user", content: "go" }] } as any);
    };

    const withOption = await run(true);
    const withoutOption = await run(false);

    expect(shape(withOption.messages)).toEqual(shape(withoutOption.messages));
    expect(withOption.content).toBe(withoutOption.content);
    expect(withOption.state?.toolCallCount).toBe(withoutOption.state?.toolCallCount);
    expect((withOption.state?.toolHistory ?? []).map((e) => e.status)).toEqual(
      (withoutOption.state?.toolHistory ?? []).map((e) => e.status),
    );
    // No plugins ⇒ no run host was ever installed on ctx.
    expect((withOption.state?.ctx as any)?.__plugins).toBeUndefined();
    expect((withoutOption.state?.ctx as any)?.__plugins).toBeUndefined();
  });
});
