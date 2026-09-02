/**
 * Plugin layer × serialization / delegation boundaries.
 *
 * The plugin host is the first thing the SDK puts on `state.ctx` that holds
 * live closures AND a circular reference back into the state. Two existing
 * mechanisms have to keep working in its presence:
 *
 *   1. snapshot/resume   `captureSnapshot` structuredClones the state, so every
 *                        plugin marker must be filtered out first, and a resumed
 *                        run must open a session of its own.
 *   2. sub-agents        a child inherits the parent's plugins unless the plugin
 *                        opted out, and the child state a parent stores while a
 *                        nested HITL pause is outstanding must stay serializable.
 *
 * These are regression boundaries, not new features: the assertions below fail
 * loudly if the plugin layer leaks a function into something that gets cloned.
 */

import { describe, it, expect, vi } from "vitest";
import { z } from "zod";

import { createAgent } from "../../../src/agent.js";
import { createSmartAgent } from "../../../src/smart/index.js";
import { createTool } from "../../../src/tool.js";
import { captureSnapshot, restoreSnapshot } from "../../../src/utils/stateSnapshot.js";
import type { AgentPlugin } from "../../../src/plugins/types.js";
import type { Message, SmartState } from "../../../src/types.js";

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * A stand-in for the object `agent.ts` parks on `ctx.__plugins`. It carries real
 * functions on purpose: `structuredClone` throws DataCloneError on a function,
 * so if the key ever stopped being filtered these tests fail instead of silently
 * snapshotting a dead host.
 */
function fakeRunHost() {
  return {
    has: (_hook: string) => true,
    maxModelRetries: 2,
    maxContinuations: 2,
    mayPauseOnToolUse: false,
    runGate: async () => ({ decision: "allow", input: {}, mutated: false, collected: {}, flags: {} }),
    runObservers: async () => {},
    end: () => {},
  };
}

/** Same trick for `ctx.__contextPilot` — an existing entry on the exclusion list. */
function fakeContextPilot() {
  return { store: new Map<string, unknown>(), compress: (text: string) => text.slice(0, 8) };
}

/** Parent that calls one tool on the first turn, then finishes once a tool result exists. */
function callsToolThenDone(toolName: string, args: unknown, done = "parent-done") {
  return {
    modelName: "parent",
    bindTools() { return this; },
    async invoke(msgs: Message[]) {
      if (msgs.some((m) => m.role === "tool")) return { role: "assistant", content: done };
      return {
        role: "assistant",
        content: "",
        tool_calls: [{ id: "p1", type: "function", function: { name: toolName, arguments: JSON.stringify(args) } }],
      };
    },
  } as any;
}

/** Child that calls `toolName` once and then reports what came back. */
function childCallsThenReports(toolName: string) {
  return {
    modelName: "child",
    bindTools() { return this; },
    async invoke(msgs: Message[]) {
      const toolMsg = msgs.find((m) => m.role === "tool");
      if (toolMsg) return { role: "assistant", content: `child-saw:${String((toolMsg as any).content)}` };
      return {
        role: "assistant",
        content: "",
        tool_calls: [{ id: "c1", type: "function", function: { name: toolName, arguments: "{}" } }],
      };
    },
  } as any;
}

const PLUGIN_CTX_KEYS = ["__plugins", "__pluginState", "__pluginRunStarted", "__pluginRunEnded"] as const;

// ─── captureSnapshot ─────────────────────────────────────────────────────────

describe("captureSnapshot × plugin ctx", () => {
  it("strips every plugin marker and does not throw on a host holding live functions", () => {
    const host = fakeRunHost();
    const pilot = fakeContextPilot();
    const onEvent = vi.fn();

    const state = {
      messages: [{ role: "user", content: "hi" }],
      toolCallCount: 2,
      toolHistory: [],
      ctx: {
        threadId: "t-1",
        __runId: "run_abc",
        __plugins: host,
        // The real holder is `{ value: state }` — a cycle back into the state
        // being cloned, which is exactly why it cannot ride along.
        __pluginState: { value: undefined as unknown },
        __pluginRunStarted: true,
        __pluginRunEnded: true,
        __contextPilot: pilot,
        __onEvent: onEvent,
      },
    } as unknown as SmartState;
    (state.ctx as any).__pluginState.value = state;

    // Canary: the fixture really is unclonable, so `not.toThrow()` below proves
    // the keys were filtered rather than the fixture being harmless.
    expect(() => structuredClone({ ...(state.ctx as Record<string, unknown>) })).toThrow();

    expect(() => captureSnapshot(state)).not.toThrow();

    const snapshot = captureSnapshot(state);
    for (const key of PLUGIN_CTX_KEYS) {
      expect(snapshot.state.ctx).not.toHaveProperty(key);
    }
    // Regression guard on the pre-existing entries of DISALLOWED_CTX_KEYS: the
    // plugin additions must not have displaced them.
    expect(snapshot.state.ctx).not.toHaveProperty("__contextPilot");
    expect(snapshot.state.ctx).not.toHaveProperty("__onEvent");

    // Plain data survives, and nothing was mutated on the caller's state.
    expect(snapshot.state.ctx).toEqual({ threadId: "t-1", __runId: "run_abc" });
    expect(snapshot.state.toolCallCount).toBe(2);
    expect((state.ctx as any).__plugins).toBe(host);
    expect((state.ctx as any).__contextPilot).toBe(pilot);

    // The whole point of stripping: the snapshot has to reach a wire format.
    expect(() => JSON.stringify(snapshot)).not.toThrow();
  });

  it("drops the ctx entirely when only plugin/runtime keys were present", () => {
    const state = {
      messages: [{ role: "user", content: "hi" }],
      ctx: {
        __plugins: fakeRunHost(),
        __pluginState: { value: null },
        __pluginRunStarted: true,
        __pluginRunEnded: true,
      },
    } as unknown as SmartState;

    const snapshot = captureSnapshot(state);
    expect(snapshot.state.ctx).toBeUndefined();
  });
});

// ─── restoreSnapshot ─────────────────────────────────────────────────────────

describe("restoreSnapshot × caller-supplied ctx", () => {
  const baseSnapshot = () =>
    captureSnapshot({
      messages: [{ role: "user", content: "hi" }],
      ctx: { threadId: "t-1" },
    } as unknown as SmartState);

  it("re-filters an incoming ctx so a host cannot be re-injected on resume", () => {
    const restored = restoreSnapshot(baseSnapshot(), {
      ctx: {
        __plugins: fakeRunHost(),
        __pluginState: { value: 1 },
        __pluginRunStarted: true,
        __pluginRunEnded: true,
        __contextPilot: fakeContextPilot(),
        __onEvent: vi.fn(),
        resumedBy: "host",
      },
    });

    for (const key of PLUGIN_CTX_KEYS) {
      expect(restored.ctx).not.toHaveProperty(key);
    }
    expect(restored.ctx).not.toHaveProperty("__contextPilot");
    expect(restored.ctx).not.toHaveProperty("__onEvent");

    // Legitimate caller data and the snapshot's own ctx both survive.
    expect(restored.ctx?.resumedBy).toBe("host");
    expect(restored.ctx?.threadId).toBe("t-1");
    expect(restored.ctx?.__restoredFromSnapshot).toBe(true);
  });

  it("filters the incoming ctx on the mergeCtx:false path too", () => {
    const restored = restoreSnapshot(baseSnapshot(), {
      mergeCtx: false,
      ctx: { __plugins: fakeRunHost(), __pluginRunStarted: true, only: "this" },
    });

    for (const key of PLUGIN_CTX_KEYS) {
      expect(restored.ctx).not.toHaveProperty(key);
    }
    expect(restored.ctx?.only).toBe("this");
    // mergeCtx:false replaces the snapshot ctx rather than merging into it.
    expect(restored.ctx).not.toHaveProperty("threadId");
    expect(restored.ctx?.__restoredFromSnapshot).toBe(true);
  });
});

// ─── End-to-end pause → snapshot → resume ────────────────────────────────────

describe("plugins × pause/resume round trip", () => {
  type StartRecord = { resumed: boolean; messageCount: number };

  const buildPausableAgent = () => {
    const starts: StartRecord[] = [];
    const ends: string[] = [];
    const plugin: AgentPlugin = {
      name: "session-tracker",
      hooks: {
        sessionStart: (input) => {
          starts.push({ resumed: input.resumed, messageCount: input.messages.length });
        },
        sessionEnd: (input) => {
          ends.push(input.status);
        },
      },
    };
    const model = {
      modelName: "resumable",
      bindTools() { return this; },
      async invoke() { return { role: "assistant", content: "final-answer" }; },
    } as any;
    const agent = createAgent({ name: "pausable", model, plugins: [plugin] });
    return { agent, starts, ends };
  };

  it("survives snapshot→resume and opens a fresh plugin session on the resumed invoke", async () => {
    const { agent, starts, ends } = buildPausableAgent();

    let pauseOnce = true;
    const paused = await agent.invoke(
      { messages: [{ role: "user", content: "go" }] } as SmartState,
      {
        checkpointReason: "user_requested",
        onStateChange: () => {
          if (!pauseOnce) return false;
          pauseOnce = false;
          return true;
        },
      },
    );

    expect(paused.state?.ctx?.__paused).toBeDefined();
    expect(starts).toHaveLength(1);
    expect(starts[0].resumed).toBe(false);
    expect(ends).toEqual(["paused"]);

    // A live host with closures is sitting on ctx right now; snapshotting it is
    // the operation that used to be impossible.
    expect(paused.state?.ctx?.__plugins).toBeDefined();
    const snapshot = agent.snapshot(paused.state!);
    const overWire = JSON.parse(JSON.stringify(snapshot));

    for (const key of PLUGIN_CTX_KEYS) {
      expect(overWire.state.ctx).not.toHaveProperty(key);
    }
    expect(overWire.state.ctx).not.toHaveProperty("__paused");
    // The pause itself is preserved as metadata, not as a live ctx marker.
    expect(overWire.metadata.paused).toBeTruthy();

    const done = await agent.resume(overWire);

    // The run really finished — the markers did not survive to suppress it.
    expect(done.content).toBe("final-answer");
    expect(starts).toHaveLength(2);
    expect(starts[1].messageCount).toBeGreaterThan(0);
    expect(ends).toEqual(["paused", "success"]);
    // The marker is CONSUMED by the resumed invoke, not carried on. Left on ctx
    // it would ride out on `done.state`, flag every later `invoke({ ...done.state })`
    // as a resume, and be re-persisted by the next snapshot.
    expect(done.state?.ctx).not.toHaveProperty("__restoredFromSnapshot");
  });

  // `resumed` has to read `__restoredFromSnapshot`, which is the only marker
  // that survives a snapshot — captureSnapshot strips __paused, __resumeStage
  // and the __awaiting* pair. Without it a snapshot-based resume would report
  // resumed:false and a hydrating plugin would re-load history it already has.
  it("reports resumed:true to sessionStart on a snapshot-based resume", async () => {
    const { agent, starts } = buildPausableAgent();

    let pauseOnce = true;
    const paused = await agent.invoke(
      { messages: [{ role: "user", content: "go" }] } as SmartState,
      { onStateChange: () => (pauseOnce ? ((pauseOnce = false), true) : false) },
    );

    const overWire = JSON.parse(JSON.stringify(agent.snapshot(paused.state!)));
    await agent.resume(overWire);

    expect(starts).toHaveLength(2);
    expect(starts[1].resumed).toBe(true);
  });
});

// ─── Snapshot restore × the input guardrail ──────────────────────────────────

/**
 * `__restoredFromSnapshot` used to be sticky: nothing deleted it and the
 * snapshot filter did not strip it, so ONE restore turned every later turn of
 * the conversation into a "resume" — and `userPromptSubmit` is skipped on a
 * resume. The input guardrail was silently off for every snapshot-backed
 * conversation from that point on.
 */
describe("userPromptSubmit after a snapshot restore", () => {
  const buildGuardedAgent = () => {
    const promptsSeen: string[] = [];
    const sessionStarts: boolean[] = [];
    let modelCalls = 0;
    const guard: AgentPlugin = {
      name: "forbidden-word",
      hooks: {
        sessionStart: (input) => {
          sessionStarts.push(input.resumed);
        },
        userPromptSubmit: ({ text }) => {
          promptsSeen.push(text);
          return text.includes("forbidden") ? { decision: "deny", reason: "that word is not allowed" } : undefined;
        },
      },
    };
    const model = {
      modelName: "counting",
      bindTools() { return this; },
      async invoke() {
        modelCalls += 1;
        return { role: "assistant", content: `answer-${modelCalls}` };
      },
    } as any;
    const agent = createAgent({ name: "guarded", model, plugins: [guard] });
    return { agent, promptsSeen, sessionStarts, modelCalls: () => modelCalls };
  };

  it("runs the guardrail on a NEW user turn appended to a restored state, and a deny halts before the provider", async () => {
    const { agent, promptsSeen, sessionStarts, modelCalls } = buildGuardedAgent();

    const first = await agent.invoke({ messages: [{ role: "user", content: "hello" }] } as SmartState);
    expect(first.content).toBe("answer-1");
    expect(promptsSeen).toEqual(["hello"]);

    // The host persists the conversation and restores it — once.
    const overWire = JSON.parse(JSON.stringify(agent.snapshot(first.state!)));
    const restored = restoreSnapshot(overWire);
    expect(restored.ctx?.__restoredFromSnapshot).toBe(true);
    // The marker never travels INSIDE a snapshot, only out of a restore.
    expect(agent.snapshot(restored).state.ctx ?? {}).not.toHaveProperty("__restoredFromSnapshot");

    // ...then continues it the ordinary way: the restored state plus a new turn.
    const second = await agent.invoke({
      ...restored,
      messages: [...restored.messages, { role: "user", content: "say something forbidden" }],
    } as SmartState);

    // Before the fix the guardrail was skipped here (resumed:true), the prompt
    // reached the model and the turn came back as an ordinary answer.
    expect(promptsSeen).toEqual(["hello", "say something forbidden"]);
    expect(modelCalls()).toBe(1);
    expect(second.content).toContain("that word is not allowed");
    expect((second.state?.ctx as any)?.__guardrailBlocked?.phase).toBe("request");
    // sessionStart still learns that this invoke continued a restored state.
    expect(sessionStarts).toEqual([false, true]);
    // ...and the marker is consumed, so the NEXT turn is not a "resume" either.
    expect(second.state?.ctx).not.toHaveProperty("__restoredFromSnapshot");

    const third = await agent.invoke({
      ...second.state,
      messages: [...second.messages, { role: "user", content: "and now something fine" }],
    } as SmartState);
    expect(third.content).toBe("answer-2");
    expect(promptsSeen).toHaveLength(3);
    expect(sessionStarts).toEqual([false, true, false]);
  });

  // The first checkpoint ("before_guardrails") precedes the first model call,
  // so a checkpoint pause can leave a USER tail on a genuinely mid-turn run.
  // In process, the live `__paused` marker still says so and the already-gated
  // turn is not gated twice.
  it("does not re-run the guardrail on an in-process checkpoint resume of an already-gated user turn", async () => {
    const { agent, promptsSeen, sessionStarts, modelCalls } = buildGuardedAgent();

    let pauseOnce = true;
    const paused = await agent.invoke(
      { messages: [{ role: "user", content: "hello" }] } as SmartState,
      { onStateChange: () => (pauseOnce ? ((pauseOnce = false), true) : false) },
    );
    expect(paused.state?.ctx?.__paused).toBeDefined();
    expect(modelCalls()).toBe(0);
    expect(promptsSeen).toEqual(["hello"]);

    const done = await agent.invoke(paused.state!);

    expect(done.content).toBe("answer-1");
    expect(modelCalls()).toBe(1);
    expect(promptsSeen).toEqual(["hello"]);
    expect(sessionStarts).toEqual([false, true]);
  });

  // Across a snapshot the live marker is gone (captureSnapshot keeps it as
  // metadata only) and `__restoredFromSnapshot` is all that is left — the same
  // thing a "restore, then append a new user turn" continuation carries. The
  // two cannot be told apart, so the paused turn is gated once more on its way
  // to the model: the harmless direction, pinned here so a future change to it
  // is a visible one.
  it("gates the user tail again when that pause is resumed from a snapshot (the marker cannot tell it from a new turn)", async () => {
    const { agent, promptsSeen, sessionStarts, modelCalls } = buildGuardedAgent();

    let pauseOnce = true;
    const paused = await agent.invoke(
      { messages: [{ role: "user", content: "hello" }] } as SmartState,
      { onStateChange: () => (pauseOnce ? ((pauseOnce = false), true) : false) },
    );
    const overWire = JSON.parse(JSON.stringify(agent.snapshot(paused.state!)));
    expect(overWire.state.ctx).not.toHaveProperty("__paused");

    const done = await agent.resume(overWire);

    expect(done.content).toBe("answer-1");
    expect(modelCalls()).toBe(1);
    expect(promptsSeen).toEqual(["hello", "hello"]);
    expect(sessionStarts).toEqual([false, true]);
    expect(done.state?.ctx).not.toHaveProperty("__restoredFromSnapshot");
  });

  it("still skips the guardrail on a resume whose transcript tail is a tool result", async () => {
    // A tool that needs approval parks the run with an assistant tool-call
    // turn as the tail; the resume runs the tool and answers — no user turn
    // is entering the transcript anywhere on that path.
    let asks = 0;
    const promptsSeen: string[] = [];
    const guard: AgentPlugin = {
      name: "prompt-counter",
      hooks: {
        userPromptSubmit: ({ text }) => {
          promptsSeen.push(text);
          return undefined;
        },
        preToolUse: () => {
          asks += 1;
          return asks === 1 ? { decision: "ask" } : undefined;
        },
      },
    };
    const model = {
      modelName: "tool-then-done",
      bindTools() { return this; },
      async invoke(msgs: Message[]) {
        if (msgs.some((m) => m.role === "tool")) return { role: "assistant", content: "finished" };
        return {
          role: "assistant",
          content: "",
          tool_calls: [{ id: "tc_1", type: "function", function: { name: "deploy", arguments: JSON.stringify({}) } }],
        };
      },
    } as any;
    const deploy = createTool({ name: "deploy", description: "deploys", schema: z.object({}), func: async () => "DEPLOYED" });
    const agent = createAgent({ name: "tool-resume", model, tools: [deploy], plugins: [guard] });

    const paused = await agent.invoke({ messages: [{ role: "user", content: "ship it" }] } as SmartState);
    expect(paused.state?.pendingApprovals?.[0]?.status).toBe("pending");
    expect(promptsSeen).toEqual(["ship it"]);

    const overWire = JSON.parse(JSON.stringify(agent.snapshot(paused.state!)));
    const approved = agent.resolveToolApproval(overWire.state, { id: overWire.state.pendingApprovals[0].id, approved: true });
    const done = await agent.resume({ ...overWire, state: approved });

    expect(done.content).toBe("finished");
    expect(promptsSeen).toEqual(["ship it"]);
  });
});

// ─── Sub-agent inheritance ───────────────────────────────────────────────────

describe("plugins × sub-agent inheritance", () => {
  const buildDelegation = (plugin: AgentPlugin) => {
    let childToolRuns = 0;
    const childTool = createTool({
      name: "child_tool",
      description: "a tool only the child can call",
      schema: z.object({}),
      func: async () => {
        childToolRuns += 1;
        return "child-tool-ran";
      },
    });

    const agent = createSmartAgent({
      name: "parent",
      model: callsToolThenDone("delegate_to", { subagent: "worker", input: "do it" }),
      subagents: [
        { name: "worker", header: "runs the child tool", model: childCallsThenReports("child_tool"), tools: [childTool] },
      ],
      plugins: [plugin],
      summarization: false,
    });

    return { agent, runs: () => childToolRuns };
  };

  const delegateResult = (messages: Message[]) => {
    const toolMsg = messages.find((m: any) => m.role === "tool" && m.name === "delegate_to") as any;
    expect(toolMsg).toBeDefined();
    return JSON.parse(toolMsg.content);
  };

  it("inherits a preToolUse deny into a spawned sub-agent", async () => {
    const seen: string[] = [];
    const denyChildTool: AgentPlugin = {
      name: "child-tool-blocker",
      hooks: {
        preToolUse: ({ toolName }) => {
          seen.push(toolName);
          return toolName === "child_tool" ? { decision: "deny", reason: "child_tool is blocked by policy" } : undefined;
        },
      },
    };

    const { agent, runs } = buildDelegation(denyChildTool);
    const res = await agent.invoke({ messages: [{ role: "user", content: "go" }] } as SmartState);

    // The gate ran inside the child, not only in the parent.
    expect(seen).toContain("delegate_to");
    expect(seen).toContain("child_tool");
    expect(runs()).toBe(0);

    const parsed = delegateResult(res.messages);
    expect(parsed.content).toContain("child_tool is blocked by policy");
    // The reason is attributed to the plugin that produced it.
    expect(parsed.content).toContain("child-tool-blocker");
    expect(res.content).toBe("parent-done");
  });

  it("does NOT inherit a plugin that declared inheritToSubagents: false", async () => {
    const seen: string[] = [];
    const parentOnlyDeny: AgentPlugin = {
      name: "parent-only-blocker",
      inheritToSubagents: false,
      hooks: {
        preToolUse: ({ toolName }) => {
          seen.push(toolName);
          return toolName === "child_tool" ? { decision: "deny", reason: "child_tool is blocked by policy" } : undefined;
        },
      },
    };

    const { agent, runs } = buildDelegation(parentOnlyDeny);
    const res = await agent.invoke({ messages: [{ role: "user", content: "go" }] } as SmartState);

    // The parent still gates its own delegate_to call; the child never sees it.
    expect(seen).toEqual(["delegate_to"]);
    expect(runs()).toBe(1);

    const parsed = delegateResult(res.messages);
    expect(parsed.content).toBe("child-saw:child-tool-ran");
    expect(parsed.content).not.toContain("blocked by policy");
    expect(res.content).toBe("parent-done");
  });
});

// ─── cleanChildState ─────────────────────────────────────────────────────────

describe("cleanChildState × plugin ctx", () => {
  it("strips the plugin host from the child state a parent parks during a nested pause", async () => {
    const dangerous = createTool({
      name: "danger",
      description: "needs approval",
      schema: z.object({}),
      needsApproval: true,
      func: async () => "ran",
    });

    const sawAgents: Array<string | undefined> = [];
    const observer: AgentPlugin = {
      name: "session-observer",
      hooks: {
        sessionStart: (_input, hookCtx) => {
          sawAgents.push(hookCtx.agentName);
        },
      },
    };

    const agent = createSmartAgent({
      name: "parent",
      model: callsToolThenDone("delegate_to", { subagent: "risky", input: "do it" }),
      subagents: [
        {
          name: "risky",
          header: "does risky things",
          model: childCallsThenReports("danger"),
          tools: [dangerous],
        },
      ],
      plugins: [observer],
      summarization: false,
    });

    const paused = await agent.invoke({ messages: [{ role: "user", content: "go" }] } as SmartState);
    expect(paused.state?.pendingApprovals?.length).toBeGreaterThan(0);

    // The plugin really was inherited, so the child state below really did carry
    // a live host before cleanChildState ran.
    expect(sawAgents).toContain("parent");
    expect(sawAgents).toContain("risky");

    const pendingStore = (paused.state!.ctx as any).__subagentPending as Record<string, any>;
    expect(pendingStore).toBeDefined();
    const record = Object.values(pendingStore)[0];
    expect(record).toBeDefined();
    expect(record.childState).toBeDefined();

    const childCtx = record.childState.ctx as Record<string, unknown>;
    expect(childCtx).toBeDefined();
    expect(childCtx).not.toHaveProperty("__plugins");
    expect(childCtx).not.toHaveProperty("__pluginState");
    expect(childCtx).not.toHaveProperty("__contextPilot");
    expect(childCtx).not.toHaveProperty("__onEvent");
    // The child's own pause markers are data and must survive for the resume.
    expect(childCtx.__awaitingApproval).toBeDefined();

    // The reason all of the above matters: the parent snapshot embeds the child
    // state, so a leaked closure would blow up here.
    expect(() => agent.snapshot(paused.state!)).not.toThrow();
    const overWire = JSON.parse(JSON.stringify(agent.snapshot(paused.state!)));
    expect(overWire.state.ctx.__subagentPending).toBeDefined();
    for (const key of PLUGIN_CTX_KEYS) {
      expect(overWire.state.ctx).not.toHaveProperty(key);
    }
  });
});
