/**
 * Steering: `InvokeConfig.drainPendingInputs` lets a host feed input that
 * arrived while a run was working (a person writing from chat or a channel)
 * into the SAME run.
 *
 * What must hold:
 * - An injected item becomes a real user message in the transcript (it reaches
 *   the next model call AND `result.messages`), not a wire-only addition.
 * - It never lands between an assistant tool_call and its tool result.
 * - Input that arrives while the model writes its final answer is answered in
 *   the same run.
 * - Only the agent's own loop drains; a child agent used as a tool does not.
 * - A throwing callback does not fail the run.
 */
import { describe, it, expect, vi } from "vitest";
import { z } from "zod";
import { createAgent } from "../../src/agent.js";
import { createSmartAgent } from "../../src/smart/index.js";
import { createTool } from "../../src/tool.js";
import { createRegexGuardrail } from "../../src/guardrails/index.js";
import { GuardrailPhase } from "../../src/types.js";
import type { Message, PendingInput } from "../../src/types.js";

const call = (name: string, args: Record<string, unknown> = {}, id = `c_${name}`) => ({
  id,
  type: "function" as const,
  function: { name, arguments: JSON.stringify(args) },
});

type Step = { content?: string; tool_calls?: any[] };

function scriptedModel(script: Step[], log: { calls: Message[][] }) {
  let turn = 0;
  return {
    bindTools() {
      return this;
    },
    async invoke(msgs: Message[]) {
      log.calls.push(msgs.map((m: any) => ({ ...m })));
      const step = script[Math.min(turn, script.length - 1)];
      turn += 1;
      const msg: any = { role: "assistant", content: step.content ?? "" };
      if (step.tool_calls) msg.tool_calls = step.tool_calls;
      return msg as Message;
    },
  } as any;
}

/** Hands out each batch once, in order; empty afterwards. */
function queue(batches: PendingInput[][]) {
  const drain = vi.fn(async () => batches.shift() ?? []);
  return drain;
}

/** Every assistant turn with tool_calls is followed directly by exactly its results. */
function expectWellPaired(messages: Message[]) {
  messages.forEach((m: any, index) => {
    const calls = Array.isArray(m.tool_calls) ? m.tool_calls : [];
    if (m.role !== "assistant" || calls.length === 0) return;
    const open = new Set(calls.map((c: any) => String(c.id)));
    let next = index + 1;
    while ((messages[next] as any)?.role === "tool") {
      open.delete(String((messages[next] as any).tool_call_id));
      next += 1;
    }
    expect([...open]).toEqual([]);
  });
}

const lookup = (counter: { ran: number }, needsApproval = false) =>
  createTool({
    name: "lookup",
    description: "Look something up.",
    schema: z.object({}).strict(),
    needsApproval,
    func: async () => {
      counter.ran += 1;
      return "found";
    },
  });

const userTurn = { messages: [{ role: "user", content: "start the release" }] } as any;
const injected = (m: any) => m?.role === "user" && m?.metadata?.injected === true;

describe("drainPendingInputs: base agent", () => {
  it("appends queued input as a user message before the next model call and keeps it in the transcript", async () => {
    const log = { calls: [] as Message[][] };
    const counter = { ran: 0 };
    const agent = createAgent({
      name: "Release",
      model: scriptedModel([{ tool_calls: [call("lookup")] }, { content: "done, and #557 is in" }], log),
      tools: [lookup(counter)],
    });
    // First drain (before the first model call) is empty; the second, after the
    // tool ran, carries the steering message.
    const drain = queue([[], [{ id: "in_1", content: "also add #557", source: "slack", metadata: { from: "anil" } }]]);
    const events: any[] = [];

    const result = await agent.invoke(userTurn, { drainPendingInputs: drain, onEvent: (e) => events.push(e) });

    expect(counter.ran).toBe(1);
    expect(log.calls).toHaveLength(2);
    // The second model call sees the tool result, then the injected message.
    const second = log.calls[1] as any[];
    expect(second.at(-1)).toMatchObject({ role: "user", content: "also add #557" });
    expect(second.at(-2)).toMatchObject({ role: "tool" });

    const msgs = result.messages as any[];
    const inj = msgs.filter(injected);
    expect(inj).toHaveLength(1);
    expect(inj[0].metadata).toMatchObject({ injected: true, inputId: "in_1", inputSource: "slack", inputKind: "message", from: "anil" });
    expect(msgs.at(-1)).toMatchObject({ role: "assistant", content: "done, and #557 is in" });
    expectWellPaired(msgs as Message[]);

    const ui = events.filter((e) => e.type === "user_input");
    expect(ui).toHaveLength(1);
    expect(ui[0]).toMatchObject({
      type: "user_input",
      stage: "before_model",
      iteration: 2,
      inputs: [{ id: "in_1", source: "slack", kind: "message", content: "also add #557" }],
    });
  });

  it("answers input that arrived during the final answer in the same run", async () => {
    const log = { calls: [] as Message[][] };
    const agent = createAgent({
      name: "Release",
      model: scriptedModel([{ content: "release started" }, { content: "ok, waiting for your PR" }], log),
    });
    // before_model (empty) → after_final (one message) → before_model (empty) → after_final (empty)
    const drain = queue([[], [{ id: "in_2", content: "wait, one more PR" }]]);
    const events: any[] = [];

    const result = await agent.invoke(userTurn, { drainPendingInputs: drain, onEvent: (e) => events.push(e) });

    expect(log.calls).toHaveLength(2);
    const msgs = result.messages as any[];
    expect(msgs.map((m) => m.role)).toEqual(["user", "assistant", "user", "assistant"]);
    expect(msgs[2]).toMatchObject({ content: "wait, one more PR", metadata: { injected: true, inputId: "in_2" } });
    expect(result.content).toBe("ok, waiting for your PR");
    expect(events.filter((e) => e.type === "user_input").map((e) => e.stage)).toEqual(["after_final"]);
    expect(events.filter((e) => e.type === "finalAnswer")).toHaveLength(1);
  });

  it("tells the host where it asks, so a host can leave what came after the answer for a new run", async () => {
    const log = { calls: [] as Message[][] };
    const agent = createAgent({ name: "Release", model: scriptedModel([{ content: "release started" }], log) });
    const asks: Array<{ stage: string; iteration: number }> = [];
    const waiting: Array<{ id: string; content: string }> = [];
    const events: any[] = [];

    const result = await agent.invoke(userTurn, {
      drainPendingInputs: (ask) => {
        asks.push(ask);
        if (ask.stage === "before_model") {
          // the person writes while the model answers
          waiting.push({ id: "in_3", content: "wait, one more PR" });
          return [];
        }
        // the answer is written: the host keeps the message for a run of its own
        return [];
      },
      onEvent: (e) => events.push(e),
    });

    expect(asks).toEqual([{ stage: "before_model", iteration: 1 }, { stage: "after_final", iteration: 1 }]);
    expect(log.calls).toHaveLength(1);
    expect(result.content).toBe("release started");
    expect((result.messages as any[]).map((m) => m.role)).toEqual(["user", "assistant"]);
    expect(events.some((e) => e.type === "user_input")).toBe(false);
    expect(waiting).toHaveLength(1);
  });

  it("skips empty items and treats a throwing callback as empty", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const log = { calls: [] as Message[][] };
    const agent = createAgent({ name: "R", model: scriptedModel([{ content: "hi" }], log) });
    let n = 0;
    const result = await agent.invoke(userTurn, {
      drainPendingInputs: () => {
        n += 1;
        if (n === 1) return [{ id: "blank", content: "   " }];
        throw new Error("queue down");
      },
    });
    expect(log.calls).toHaveLength(1);
    expect((result.messages as any[]).some(injected)).toBe(false);
    expect(warn).toHaveBeenCalledWith("[agent-sdk] drainPendingInputs callback error:", expect.any(Error));
    warn.mockRestore();
  });

  it("does not drain between an approved tool_call and its result on resume", async () => {
    const log = { calls: [] as Message[][] };
    const counter = { ran: 0 };
    const agent = createAgent({
      name: "Release",
      model: scriptedModel([{ tool_calls: [call("lookup")] }, { content: "published" }], log),
      tools: [lookup(counter, true)],
    });
    const paused = await agent.invoke(userTurn);
    const pending = ((paused.state as any).pendingApprovals || []).filter((a: any) => a.status === "pending");
    expect(pending).toHaveLength(1);
    const resolved = agent.resolveToolApproval(paused.state as any, { id: pending[0].id, approved: true });

    const drain = vi.fn(async () => [{ id: "in_3", content: "go ahead" }]);
    const result = await agent.invoke(resolved, { drainPendingInputs: drain });

    expect(counter.ran).toBe(1);
    const msgs = result.messages as any[];
    expectWellPaired(msgs as Message[]);
    const toolIdx = msgs.findIndex((m) => m.role === "tool");
    const injIdx = msgs.findIndex(injected);
    expect(injIdx).toBeGreaterThan(toolIdx);
  });

  it("is not passed to a child agent used as a tool", async () => {
    const childLog = { calls: [] as Message[][] };
    const child = createAgent({ name: "Child", model: scriptedModel([{ content: "child done" }], childLog) });
    const parentLog = { calls: [] as Message[][] };
    const parent = createAgent({
      name: "Parent",
      model: scriptedModel([{ tool_calls: [call("ask_child", { input: "x" })] }, { content: "parent done" }], parentLog),
      tools: [child.asTool({ toolName: "ask_child" })],
    });
    const drain = vi.fn(async () => [] as PendingInput[]);
    await parent.invoke(userTurn, { drainPendingInputs: drain });

    expect(childLog.calls).toHaveLength(1);
    // Parent loop: before model 1, before model 2, after final 2. The child's
    // own loop never calls it.
    expect(drain).toHaveBeenCalledTimes(3);
  });
});

describe("drainPendingInputs: smart agent", () => {
  it("forwards the callback to its legs and keeps the injected message in the result", async () => {
    const log = { calls: [] as Message[][] };
    const counter = { ran: 0 };
    const agent = createSmartAgent({
      name: "Release",
      model: scriptedModel([{ tool_calls: [call("lookup")] }, { content: "final" }], log),
      tools: [lookup(counter)],
    });
    const drain = queue([[], [{ id: "in_4", content: "which PRs are in?", source: "portal" }]]);
    const events: any[] = [];
    const result = await agent.invoke(userTurn, { drainPendingInputs: drain, onEvent: (e) => events.push(e) });

    const msgs = result.messages as any[];
    const inj = msgs.filter(injected);
    expect(inj).toHaveLength(1);
    expect(inj[0]).toMatchObject({ content: "which PRs are in?", metadata: { inputId: "in_4", inputSource: "portal" } });
    expect(msgs.at(-1)).toMatchObject({ role: "assistant", content: "final" });
    expectWellPaired(msgs as Message[]);
    expect(events.some((e) => e.type === "user_input")).toBe(true);
    // Last model call saw it.
    expect((log.calls.at(-1) as any[]).some((m) => m.content === "which PRs are in?")).toBe(true);
  });
});

/**
 * The contract the Cognipeer platform's room inbox (agentRooms/inbox.ts
 * `createSteeringTap`) relies on: it claims `steer` items at `before_model`,
 * returns nothing at `after_final` (what came in while the answer was written
 * starts the next run), and reads the taken items back from `result.messages`
 * by `metadata.injected` + string `metadata.inputId` + string `content`.
 */
describe("drainPendingInputs: room host contract", () => {
  type InboxItem = { id: string; text: string; from: { kind: string; display: string }; status: "queued" | "consumed" };

  function roomInbox() {
    const items: InboxItem[] = [];
    const asks: Array<{ stage: string; iteration: number }> = [];
    let seq = 0;
    return {
      items,
      asks,
      write(text: string) {
        seq += 1;
        items.push({ id: `inbox_${seq}`, text, from: { kind: "slack", display: "Anil" }, status: "queued" });
      },
      drain: async (ask: { stage: "before_model" | "after_final"; iteration: number }): Promise<PendingInput[]> => {
        asks.push(ask);
        if (ask.stage === "after_final") return [];
        const claimed = items.filter((item) => item.status === "queued");
        for (const item of claimed) item.status = "consumed";
        return claimed.map((item) => ({
          id: item.id,
          content: `[${item.from.display} · Slack] ${item.text}`,
          source: item.from.kind,
          kind: "message",
          metadata: { from: item.from },
        }));
      },
    };
  }

  /** What the platform's `transcriptMessages` reads back from the result. */
  function storedByInputId(messages: unknown[]) {
    const stored = new Map<string, string>();
    for (const message of messages) {
      const m = message as { role?: string; content?: unknown; metadata?: { injected?: boolean; inputId?: unknown } };
      if (m?.role === "user" && m.metadata?.injected && typeof m.metadata.inputId === "string" && typeof m.content === "string") {
        stored.set(m.metadata.inputId, m.content);
      }
    }
    return stored;
  }

  it("takes a message written mid-run exactly once and leaves one written during the answer for the next run", async () => {
    const inbox = roomInbox();
    const calls: Message[][] = [];
    const script: Step[] = [{ tool_calls: [call("lookup")] }, { content: "#557 is in the release" }];
    const model = {
      bindTools() {
        return this;
      },
      async invoke(msgs: Message[]) {
        calls.push(msgs.map((m: any) => ({ ...m })));
        const step = script[Math.min(calls.length - 1, script.length - 1)];
        // The person writes again while the final answer is being written.
        if (calls.length === 2) inbox.write("and tag it 0.25.0");
        const msg: any = { role: "assistant", content: step.content ?? "" };
        if (step.tool_calls) msg.tool_calls = step.tool_calls;
        return msg as Message;
      },
    } as any;
    const tool = createTool({
      name: "lookup",
      description: "Look something up.",
      schema: z.object({}).strict(),
      func: async () => {
        // The person writes while the tool runs.
        inbox.write("also add #557");
        return "found";
      },
    });
    const agent = createSmartAgent({ name: "Release", model, tools: [tool] });
    const events: any[] = [];

    const result = await agent.invoke(userTurn, { drainPendingInputs: inbox.drain, onEvent: (e) => events.push(e) });

    expect(inbox.asks).toEqual([
      { stage: "before_model", iteration: 1 },
      { stage: "before_model", iteration: 2 },
      { stage: "after_final", iteration: 2 },
    ]);
    expect(calls).toHaveLength(2);
    // The model saw the steering message once, after the tool result.
    const second = calls[1] as any[];
    expect(second.filter((m) => m.content === "[Anil · Slack] also add #557")).toHaveLength(1);
    expect(second.at(-1)).toMatchObject({ role: "user", content: "[Anil · Slack] also add #557" });

    const msgs = result.messages as any[];
    expect(msgs.filter(injected)).toHaveLength(1);
    expect(storedByInputId(msgs)).toEqual(new Map([["inbox_1", "[Anil · Slack] also add #557"]]));
    expectWellPaired(msgs as Message[]);
    expect(result.content).toBe("#557 is in the release");
    expect(events.filter((e) => e.type === "user_input")).toHaveLength(1);
    expect(events.filter((e) => e.type === "finalAnswer")).toHaveLength(1);
    // The message written during the answer is still the host's.
    expect(inbox.items.map((item) => item.status)).toEqual(["consumed", "queued"]);
  });

  it("goes on without input when the callback rejects or returns something that is not a list", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const log = { calls: [] as Message[][] };
    const agent = createSmartAgent({ name: "R", model: scriptedModel([{ content: "answer" }, { content: "second answer" }], log) });
    const asks: string[] = [];
    const result = await agent.invoke(userTurn, {
      drainPendingInputs: ((ask: { stage: string }) => {
        asks.push(ask.stage);
        if (ask.stage === "before_model") return Promise.reject(new Error("inbox unreachable"));
        return null;
      }) as any,
    });
    expect(asks).toEqual(["before_model", "after_final"]);
    expect(log.calls).toHaveLength(1);
    expect(result.content).toBe("answer");
    expect((result.messages as any[]).some(injected)).toBe(false);
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });

  it("ends with the answer when the callback throws at after_final", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const log = { calls: [] as Message[][] };
    const agent = createAgent({ name: "R", model: scriptedModel([{ content: "answer" }, { content: "never" }], log) });
    const result = await agent.invoke(userTurn, {
      drainPendingInputs: async (ask) => {
        if (ask.stage === "after_final") throw new Error("inbox unreachable");
        return [];
      },
    });
    expect(log.calls).toHaveLength(1);
    expect(result.content).toBe("answer");
    warn.mockRestore();
  });
});

describe("drainPendingInputs: after the final answer", () => {
  it("smart agent: input taken after the answer is answered in the same turn, once", async () => {
    const log = { calls: [] as Message[][] };
    const agent = createSmartAgent({
      name: "Release",
      model: scriptedModel([{ content: "release started" }, { content: "ok, adding it" }], log),
    });
    const handed: string[] = [];
    const events: any[] = [];
    const result = await agent.invoke(userTurn, {
      drainPendingInputs: async (ask) => {
        if (ask.stage !== "after_final" || handed.length > 0) return [];
        handed.push("in_late");
        return [{ id: "in_late", content: "wait, one more PR" }];
      },
      onEvent: (e) => events.push(e),
    });

    expect(log.calls).toHaveLength(2);
    expect((log.calls[1] as any[]).filter((m) => m.content === "wait, one more PR")).toHaveLength(1);
    const msgs = result.messages as any[];
    expect(msgs.filter((m) => m.role !== "system").map((m) => m.role)).toEqual(["user", "assistant", "user", "assistant"]);
    expect(msgs.filter(injected)).toHaveLength(1);
    expect(result.content).toBe("ok, adding it");
    expect(events.filter((e) => e.type === "user_input").map((e) => e.stage)).toEqual(["after_final"]);
    expect(events.filter((e) => e.type === "finalAnswer")).toHaveLength(1);
  });

  it("stays within the iteration limit when input keeps arriving after every answer", async () => {
    const log = { calls: [] as Message[][] };
    const agent = createAgent({ name: "R", model: scriptedModel([{ content: "answer" }], log), limits: { maxToolCalls: 1 } });
    let n = 0;
    const result = await agent.invoke(userTurn, {
      drainPendingInputs: async (ask) => {
        if (ask.stage !== "after_final") return [];
        n += 1;
        return [{ id: `in_${n}`, content: `more ${n}` }];
      },
    });
    // maxToolCalls 1 → an iteration limit of 40: one model call per iteration, no input after the last.
    expect(log.calls).toHaveLength(40);
    expect(n).toBe(39);
    expect(result.content).toBe("answer");
  });
});

describe("drainPendingInputs: request guardrails see every input", () => {
  const policy = () => createRegexGuardrail(/BLOCKED_TOPIC/, { phases: [GuardrailPhase.Request] });

  function countingModel(script: Step[]) {
    const log = { calls: [] as Message[][] };
    return { log, model: scriptedModel(script, log) };
  }

  it("blocks a single input that the request policy denies (control)", async () => {
    const { log, model } = countingModel([{ content: "answer" }]);
    const agent = createAgent({ name: "R", model, guardrails: [policy()] });
    const result = await agent.invoke(userTurn, {
      drainPendingInputs: queue([[{ id: "a", content: "about BLOCKED_TOPIC" }]]),
    });
    expect(log.calls).toHaveLength(0);
    expect((result.state as any).ctx.__guardrailBlocked).toBeDefined();
  });

  it("checks each input of a batch, not only the last one", async () => {
    const { log, model } = countingModel([{ content: "answer" }]);
    const agent = createAgent({ name: "R", model, guardrails: [policy()] });
    const events: any[] = [];
    const result = await agent.invoke(userTurn, {
      drainPendingInputs: queue([[
        { id: "a", content: "about BLOCKED_TOPIC" },
        { id: "b", content: "an ordinary question" },
      ]]),
      onEvent: (e) => events.push(e),
    });
    expect(log.calls).toHaveLength(0);
    expect((result.state as any).ctx.__guardrailBlocked).toBeDefined();
    expect(events.filter((e) => e.type === "guardrail" && e.disposition === "block")).toHaveLength(1);
  });

  it("checks the run's own request before taking input, and takes none when it is blocked", async () => {
    const { log, model } = countingModel([{ content: "answer" }]);
    const agent = createAgent({ name: "R", model, guardrails: [policy()] });
    const drain = vi.fn(async () => [{ id: "b", content: "an ordinary question" }] as PendingInput[]);
    const result = await agent.invoke(
      { messages: [{ role: "user", content: "about BLOCKED_TOPIC" }] } as any,
      { drainPendingInputs: drain },
    );
    expect(log.calls).toHaveLength(0);
    expect(drain).not.toHaveBeenCalled();
    expect((result.state as any).ctx.__guardrailBlocked).toBeDefined();
    expect((result.messages as any[]).some(injected)).toBe(false);
  });

  it("checks input taken after the answer before the next model call", async () => {
    const { log, model } = countingModel([{ content: "first answer" }, { content: "never" }]);
    const agent = createAgent({ name: "R", model, guardrails: [policy()] });
    const result = await agent.invoke(userTurn, {
      drainPendingInputs: async (ask) =>
        ask.stage === "after_final"
          ? [
              { id: "a", content: "about BLOCKED_TOPIC" },
              { id: "b", content: "an ordinary question" },
            ]
          : [],
    });
    expect(log.calls).toHaveLength(1);
    expect((result.state as any).ctx.__guardrailBlocked).toBeDefined();
  });

  it("lets allowed input through, each checked once", async () => {
    const { log, model } = countingModel([{ content: "answer" }]);
    const checked: string[] = [];
    const agent = createAgent({
      name: "R",
      model,
      guardrails: [
        createRegexGuardrail(/BLOCKED_TOPIC/, {
          phases: [GuardrailPhase.Request],
          rule: { selector: (ctx) => { const text = String(ctx.latestMessage?.content ?? ""); checked.push(text); return text; } },
        }),
      ],
    });
    const result = await agent.invoke(userTurn, {
      drainPendingInputs: queue([[
        { id: "a", content: "first question" },
        { id: "b", content: "second question" },
      ]]),
    });
    expect(log.calls).toHaveLength(1);
    expect(checked).toEqual(["start the release", "first question", "second question"]);
    expect((result.messages as any[]).filter(injected)).toHaveLength(2);
  });
});

describe("drainPendingInputs: execution budgets after the answer", () => {
  function clockedModel(clock: { now: number }, stepMs: number, usage?: { output_tokens: number }) {
    const log = { calls: [] as Message[][] };
    const model = {
      modelName: "budget-mock",
      bindTools() {
        return this;
      },
      async invoke(msgs: Message[]) {
        log.calls.push(msgs);
        clock.now += stepMs;
        const msg: any = { role: "assistant", content: `answer ${log.calls.length}` };
        if (usage) msg.usage_metadata = { input_tokens: 10, output_tokens: usage.output_tokens, total_tokens: 10 + usage.output_tokens };
        return msg as Message;
      },
    } as any;
    return { log, model };
  }

  function hostQueue() {
    const waiting: PendingInput[] = [{ id: "late", content: "one more thing" }];
    const asks: string[] = [];
    const drain = async (ask: { stage: string }) => {
      asks.push(ask.stage);
      if (ask.stage !== "after_final") return [];
      return waiting.splice(0, waiting.length);
    };
    return { waiting, asks, drain };
  }

  async function runWith(agent: ReturnType<typeof createAgent>, host: ReturnType<typeof hostQueue>) {
    const events: any[] = [];
    const result = await agent.invoke(userTurn, { drainPendingInputs: host.drain, onEvent: (e) => events.push(e) });
    return { result, events };
  }

  it("does not take input when the answer spent the wall-clock budget", async () => {
    const clock = { now: 1_000_000 };
    const spy = vi.spyOn(Date, "now").mockImplementation(() => clock.now);
    try {
      const { log, model } = clockedModel(clock, 11);
      const agent = createAgent({ name: "R", model, limits: { maxWallClockMs: 10 } });
      const host = hostQueue();
      const { result, events } = await runWith(agent, host);
      expect(log.calls).toHaveLength(1);
      expect(host.asks).toEqual(["before_model"]);
      expect(host.waiting).toHaveLength(1);
      expect(result.content).toBe("answer 1");
      expect((result.messages as any[]).at(-1)).toMatchObject({ role: "assistant", content: "answer 1" });
      expect(events.some((e) => e.type === "user_input")).toBe(false);
    } finally {
      spy.mockRestore();
    }
  });

  it("does not take input when the answer spent the output-token budget", async () => {
    const { log, model } = clockedModel({ now: 0 }, 0, { output_tokens: 60 });
    const agent = createAgent({ name: "R", model, limits: { maxTotalOutputTokens: 50 } });
    const host = hostQueue();
    const { result } = await runWith(agent, host);
    expect(log.calls).toHaveLength(1);
    expect(host.asks).toEqual(["before_model"]);
    expect(host.waiting).toHaveLength(1);
    expect(result.content).toBe("answer 1");
  });

  it("does not take input when the answer spent the cost budget", async () => {
    const { log, model } = clockedModel({ now: 0 }, 0, { output_tokens: 20 });
    const agent = createAgent({
      name: "R",
      model,
      limits: { maxCostUsd: 0.0005 },
      costEstimator: ({ outputTokens }) => outputTokens * 0.00003,
    });
    const host = hostQueue();
    const { result } = await runWith(agent, host);
    expect(log.calls).toHaveLength(1);
    expect(host.asks).toEqual(["before_model"]);
    expect(host.waiting).toHaveLength(1);
    expect(result.content).toBe("answer 1");
  });

  it("keeps input in the transcript and reports the limit when the budget runs out while the callback runs", async () => {
    const clock = { now: 1_000_000 };
    const spy = vi.spyOn(Date, "now").mockImplementation(() => clock.now);
    try {
      const { log, model } = clockedModel(clock, 5);
      const agent = createAgent({ name: "R", model, limits: { maxWallClockMs: 10 } });
      const events: any[] = [];
      const result = await agent.invoke(userTurn, {
        drainPendingInputs: async (ask) => {
          if (ask.stage !== "after_final") return [];
          clock.now += 20; // a slow queue
          return [{ id: "late", content: "one more thing" }];
        },
        onEvent: (e) => events.push(e),
      });
      expect(log.calls).toHaveLength(1);
      const msgs = result.messages as any[];
      expect(msgs.at(-1)).toMatchObject({ role: "user", content: "one more thing", metadata: { injected: true, inputId: "late" } });
      expect(events.filter((e) => e.type === "user_input").map((e) => e.stage)).toEqual(["after_final"]);
      expect(events.find((e) => e.type === "metadata" && e.limitBreached)?.limitBreached).toContain("maxWallClockMs");
      expect((result.state as any).ctx.__limitBreached).toContain("maxWallClockMs");
    } finally {
      spy.mockRestore();
    }
  });

  it("keeps input in the transcript and reports the cancellation when the run is cancelled while the callback runs", async () => {
    const { log, model } = clockedModel({ now: 0 }, 0);
    const agent = createAgent({ name: "R", model });
    const abort = new AbortController();
    const events: any[] = [];
    const result = await agent.invoke(userTurn, {
      cancellationToken: abort.signal,
      drainPendingInputs: async (ask) => {
        if (ask.stage !== "after_final") return [];
        abort.abort();
        return [{ id: "late", content: "one more thing" }];
      },
      onEvent: (e) => events.push(e),
    });
    expect(log.calls).toHaveLength(1);
    expect((result.messages as any[]).at(-1)).toMatchObject({ role: "user", metadata: { injected: true, inputId: "late" } });
    expect(events.some((e) => e.type === "cancelled")).toBe(true);
    expect((result.state as any).ctx.__cancelled).toBeDefined();
  });
});
