/**
 * SLOT-backed plugins against a REAL model: conversation history, checkpointing
 * and the MCP session lifecycle.
 *
 *   OPENAI_API_KEY=sk-… npx vitest run tests/integration/pluginsStores.integration.test.ts
 *
 * Any OpenAI-compatible endpoint works — a gateway, a proxy, or a local server:
 *
 *   OPENAI_BASE_URL=http://localhost:11434/v1 \
 *   PLUGIN_TEST_MODEL=qwen2.5 OPENAI_API_KEY=ignored npx vitest run …
 *
 * Skipped entirely without a key.
 *
 * These three plugins are the ones a scripted model cannot really exercise:
 * every one of them is about what survives BETWEEN invokes — a second turn that
 * has to see the first, a pause that has to be resumable from bytes on disk, a
 * server session that has to close exactly once. The unit tests drive their
 * hooks directly, which proves the composition but not that the runtime hands
 * them the transcript they expect at the moment they expect it.
 *
 * Every assertion is on RUNTIME behaviour — how many messages the store holds,
 * which tool name reached the wire, whether a spy ran — never on model wording.
 */

import { describe, it, expect, vi } from "vitest";
import { z } from "zod";
import { createAgent, createTool } from "../../src/index.js";
import { createProvider, fromNativeProvider } from "../../src/providers/index.js";
import { defineHook } from "../../src/plugins/define.js";
import {
  checkpointing,
  conversationHistory,
  inMemoryCheckpointStore,
  inMemoryConversationStore,
  mcp,
} from "../../src/plugins/index.js";
import type { AgentSnapshot, Message, SmartState, ToolInterface } from "../../src/types.js";

const API_KEY = process.env.OPENAI_API_KEY;
const runReal = API_KEY ? describe : describe.skip;
const MODEL = process.env.PLUGIN_TEST_MODEL ?? "gpt-4o-mini";
const BASE_URL = process.env.OPENAI_BASE_URL;

function realModel() {
  return fromNativeProvider(
    createProvider({
      provider: "openai",
      apiKey: API_KEY!,
      defaultModel: MODEL,
      ...(BASE_URL ? { baseURL: BASE_URL } : {}),
    }),
    { model: MODEL },
  );
}

/** What the provider was actually handed, per model call. */
function wireSpy(sink: Array<Message[]>) {
  return defineHook(
    "preModelCall",
    ({ messages }) => {
      sink.push(messages.map((m) => ({ ...m })));
      return undefined;
    },
    { name: "wire-spy", priority: 999 },
  );
}

/** The tool MENU offered on each call — the only proof a contribution landed. */
function menuSpy(sink: string[][]) {
  return defineHook(
    "preModelCall",
    ({ tools }) => {
      sink.push(tools.map((t) => t.name));
      return undefined;
    },
    { name: "menu-spy", priority: 999 },
  );
}

const userTurns = (messages: Message[]) => messages.filter((m) => m.role === "user");
const textOf = (message: Message) =>
  typeof message.content === "string" ? message.content : JSON.stringify(message.content);

/**
 * Drive a run to a terminal state, approving every pause on the way. A real
 * model may ask for the gated tool more than once, and the point of these tests
 * is what the stores hold at the end — not how many pauses it took to get there.
 */
async function approveThrough(
  agent: ReturnType<typeof createAgent>,
  first: Awaited<ReturnType<ReturnType<typeof createAgent>["invoke"]>>,
  maxResumes = 3,
) {
  let result = first;
  for (let i = 0; i < maxResumes; i += 1) {
    const pending = (result.state?.pendingApprovals ?? []).filter((p) => p.status === "pending");
    if (pending.length === 0) return result;
    let next = result.state!;
    for (const entry of pending) {
      next = agent.resolveToolApproval(next, { id: entry.id, approved: true });
    }
    result = await agent.invoke(next);
  }
  return result;
}

runReal("slot-backed plugins against a real model", () => {
  // ─── conversationHistory ───────────────────────────────────────────────────

  it("hydrates turn 2 from the store and persists each turn — user turns included — exactly once", async () => {
    const store = inMemoryConversationStore();
    const wire: Message[][] = [];
    const agent = createAgent({
      name: "HistoryAgent",
      model: realModel(),
      plugins: [conversationHistory({ store, threadId: "thread-a" }), wireSpy(wire)],
    });

    const TURN_1 = "The passphrase is ALPACA-77. Reply with the single word OK.";
    const TURN_2 = "What passphrase did I give you? Answer with just the passphrase.";

    await agent.invoke({ messages: [{ role: "user", content: TURN_1 }] });

    // The user turn is what a naive "append only what the model produced"
    // implementation loses; without it turn 2 hydrates an assistant reply to a
    // question nobody can see.
    const afterTurn1 = (await store.load("thread-a")) ?? [];
    expect(afterTurn1.map((m) => m.role)).toEqual(["user", "assistant"]);
    expect(textOf(afterTurn1[0])).toBe(TURN_1);

    // Turn 2 is a FRESH invoke carrying only the new message: everything the
    // model knows about turn 1 has to come back out of the store.
    wire.length = 0;
    await agent.invoke({ messages: [{ role: "user", content: TURN_2 }] });

    expect(wire.length).toBeGreaterThan(0);
    const firstCall = wire[0];
    expect(firstCall.map((m) => m.role)).toEqual(["user", "assistant", "user"]);
    expect(textOf(firstCall[0])).toBe(TURN_1);
    expect(textOf(firstCall[2])).toBe(TURN_2);

    const thread = (await store.load("thread-a")) ?? [];
    expect(thread.map((m) => m.role)).toEqual(["user", "assistant", "user", "assistant"]);
    // Exactly once each: a baseline that counted the incoming turn instead of
    // the loaded history would write turn 1 twice here.
    expect(userTurns(thread).map(textOf)).toEqual([TURN_1, TURN_2]);
  }, 90_000);

  it("hydrates only the tail when maxMessages is set, and still appends the whole new turn", async () => {
    const store = inMemoryConversationStore();
    const seeded: Message[] = [
      { role: "user", content: "SEEDED-1: my favourite colour is green." },
      { role: "assistant", content: "Noted." },
      { role: "user", content: "SEEDED-2: my favourite number is nine." },
      { role: "assistant", content: "Noted." },
    ];
    await store.append("thread-b", seeded);

    const wire: Message[][] = [];
    const agent = createAgent({
      name: "TailHistoryAgent",
      model: realModel(),
      plugins: [
        conversationHistory({ store, threadId: "thread-b", maxMessages: 2 }),
        wireSpy(wire),
      ],
    });

    const NEW_TURN = "Reply with the single word OK.";
    await agent.invoke({ messages: [{ role: "user", content: NEW_TURN }] });

    const firstCall = wire[0];
    expect(firstCall).toHaveLength(3);
    expect(textOf(firstCall[0])).toBe(textOf(seeded[2]));
    expect(textOf(firstCall[1])).toBe(textOf(seeded[3]));
    expect(textOf(firstCall[2])).toBe(NEW_TURN);
    // The trimmed head must not reach the provider at all.
    expect(JSON.stringify(firstCall)).not.toContain("SEEDED-1");

    // The baseline is the TRIMMED length, so the new turn is appended whole and
    // the untrimmed head is left where it was.
    const thread = (await store.load("thread-b")) ?? [];
    expect(thread).toHaveLength(6);
    expect(thread.slice(0, 4).map(textOf)).toEqual(seeded.map(textOf));
    expect(thread.slice(4).map((m) => m.role)).toEqual(["user", "assistant"]);
    expect(textOf(thread[4])).toBe(NEW_TURN);
  }, 90_000);

  it("does not duplicate the transcript when a paused run is resumed", async () => {
    const store = inMemoryConversationStore();
    const func = vi.fn(async ({ city }: { city: string }) => ({ city, population: 1234567 }));
    const tool = createTool({
      name: "get_population",
      description: "Return the population of a city.",
      schema: z.object({ city: z.string() }),
      needsApproval: true,
      func,
    });

    const agent = createAgent({
      name: "ResumeHistoryAgent",
      model: realModel(),
      tools: [tool],
      limits: { maxToolCalls: 2 },
      plugins: [conversationHistory({ store, threadId: "thread-c" })],
    });

    const PROMPT = "Use your tool to look up the population of Springfield, then state the number.";
    const paused = await agent.invoke({ messages: [{ role: "user", content: PROMPT }] });

    expect(func).not.toHaveBeenCalled();
    expect((paused.state?.pendingApprovals ?? []).length).toBeGreaterThan(0);

    // The paused run already persisted its own turns, so the resumed run's
    // sessionStart must NOT reload them on top of the carried transcript.
    const atPause = (await store.load("thread-c")) ?? [];
    expect(atPause).toHaveLength(paused.state!.messages.length);

    const finished = await approveThrough(agent, paused);
    expect(func).toHaveBeenCalled();

    const thread = (await store.load("thread-c")) ?? [];
    // One row per message the run actually produced — no second copy of the
    // pre-pause exchange, which is what a resume-blind hydrate would create.
    expect(thread.map((m) => m.role)).toEqual(finished.state!.messages.map((m) => m.role));
    expect(userTurns(thread).map(textOf)).toEqual([PROMPT]);
  }, 120_000);

  // ─── checkpointing ─────────────────────────────────────────────────────────

  it("checkpoints a paused run into the store, serializably, and resumes from it", async () => {
    const checkpoints = inMemoryCheckpointStore();
    const func = vi.fn(async ({ city }: { city: string }) => ({ city, population: 1234567 }));
    const tool = createTool({
      name: "get_population",
      description: "Return the population of a city.",
      schema: z.object({ city: z.string() }),
      needsApproval: true,
      func,
    });

    const agent = createAgent({
      name: "CheckpointAgent",
      model: realModel(),
      tools: [tool],
      limits: { maxToolCalls: 2 },
      plugins: [checkpointing({ store: checkpoints })],
    });

    const paused = await agent.invoke({
      messages: [
        { role: "user", content: "Use your tool to look up the population of Springfield, then state the number." },
      ],
    });
    expect((paused.state?.pendingApprovals ?? []).length).toBeGreaterThan(0);
    expect(func).not.toHaveBeenCalled();

    const ids = (await checkpoints.list?.()) ?? [];
    expect(ids).toHaveLength(1);
    const snapshot = (await checkpoints.load(ids[0])) as AgentSnapshot;
    expect(snapshot).toBeTruthy();

    // Serializable is the whole point: a checkpoint that only lives in memory
    // is not a checkpoint. captureSnapshot strips the live ctx, so this is the
    // assertion that would fail if a run host or a trace session leaked in.
    let serialized = "";
    expect(() => {
      serialized = JSON.stringify(snapshot);
    }).not.toThrow();
    expect(serialized.length).toBeGreaterThan(0);
    expect(serialized).not.toContain("__plugins");
    expect(serialized).not.toContain("__pluginState");
    expect(serialized).not.toContain("__traceSession");
    const ctxKeys = Object.keys(snapshot.state.ctx ?? {});
    expect(ctxKeys).not.toContain("__plugins");
    expect(ctxKeys).not.toContain("__pluginState");
    expect(ctxKeys).not.toContain("__traceSession");
    // The pause itself has to survive, or there is nothing to resume into.
    expect(snapshot.state.pendingApprovals?.length).toBeGreaterThan(0);

    // Resume from the persisted bytes, not from the in-memory result state.
    const revived = JSON.parse(serialized) as AgentSnapshot;
    let resolvedState = revived.state as unknown as SmartState;
    for (const entry of revived.state.pendingApprovals ?? []) {
      resolvedState = agent.resolveToolApproval(resolvedState, { id: entry.id, approved: true });
    }
    const resumed = await agent.resume({ ...revived, state: resolvedState as never });

    expect(func).toHaveBeenCalled();
    expect((resumed.state?.pendingApprovals ?? []).every((p) => p.status !== "pending")).toBe(true);
    expect(resumed.state?.ctx?.__awaitingApproval).toBeFalsy();
    expect(resumed.content.length).toBeGreaterThan(0);
  }, 120_000);

  it('checkpoints a clean run when saveOn includes "success"', async () => {
    const checkpoints = inMemoryCheckpointStore();
    const agent = createAgent({
      name: "SuccessCheckpointAgent",
      model: realModel(),
      plugins: [checkpointing({ store: checkpoints, saveOn: ["success"] })],
    });

    const result = await agent.invoke({
      messages: [{ role: "user", content: "Reply with the single word OK." }],
    });
    expect(result.content.length).toBeGreaterThan(0);

    const ids = (await checkpoints.list?.()) ?? [];
    expect(ids).toHaveLength(1);
    const snapshot = (await checkpoints.load(ids[0])) as AgentSnapshot;
    expect(snapshot.state.messages.map((m) => m.role)).toEqual(["user", "assistant"]);
    expect(() => JSON.stringify(snapshot)).not.toThrow();
  }, 90_000);

  // ─── mcp ───────────────────────────────────────────────────────────────────

  it("puts prefixed MCP tools on the wire, leaves the originals alone, and closes the session on dispose", async () => {
    const populationFn = vi.fn(async ({ city }: { city: string }) => ({ city, population: 4242 }));
    const timezoneFn = vi.fn(async ({ city }: { city: string }) => ({ city, timezone: "UTC+3" }));
    const originals: ToolInterface[] = [
      createTool({
        name: "get_population",
        description: "Return the population of a city.",
        schema: z.object({ city: z.string() }),
        func: populationFn,
      }),
      createTool({
        name: "get_timezone",
        description: "Return the timezone of a city.",
        schema: z.object({ city: z.string() }),
        func: timezoneFn,
      }),
    ];
    const close = vi.fn(async () => {});
    const connect = vi.fn(async () => ({ tools: originals, close }));

    const menus: string[][] = [];
    const agent = createAgent({
      name: "McpAgent",
      model: realModel(),
      tools: [],
      limits: { maxToolCalls: 2 },
      plugins: [mcp({ connect, prefix: "srv" }), menuSpy(menus)],
    });

    const result = await agent.invoke({
      messages: [{ role: "user", content: "Use your tool to look up the population of Springfield, then state the number." }],
    });

    expect(connect).toHaveBeenCalledTimes(1);
    expect(menus.length).toBeGreaterThan(0);
    expect(menus[0].sort()).toEqual(["srv__get_population", "srv__get_timezone"]);

    // Renaming must not reach back into the caller's objects: one connection is
    // shared by every agent built from this plugin.
    expect(originals.map((t) => t.name)).toEqual(["get_population", "get_timezone"]);

    // The model picked a tool off the prefixed menu and the runtime routed it
    // back to the original implementation.
    expect(populationFn).toHaveBeenCalled();
    const executed = (result.state?.toolHistory ?? []).map((entry) => entry.toolName);
    expect(executed.length).toBeGreaterThan(0);
    expect(executed.every((name) => name.startsWith("srv__"))).toBe(true);

    expect(close).not.toHaveBeenCalled();
    await agent.dispose();
    expect(close).toHaveBeenCalledTimes(1);
  }, 120_000);

  it("is fail-open when the MCP server is unreachable: the agent builds and answers with no MCP tools", async () => {
    const connect = vi.fn(async () => {
      throw new Error("ECONNREFUSED mcp://unreachable");
    });

    const menus: string[][] = [];
    const agent = createAgent({
      name: "McpFailOpenAgent",
      model: realModel(),
      plugins: [mcp({ connect, name: "mcp-down" }), menuSpy(menus)],
    });

    const result = await agent.invoke({
      messages: [{ role: "user", content: "Reply with the single word OK." }],
    });

    expect(connect).toHaveBeenCalled();
    expect(result.content.length).toBeGreaterThan(0);
    expect(menus.length).toBeGreaterThan(0);
    // Degraded, not broken: no tools, but a working agent.
    expect(menus[0]).toEqual([]);

    await agent.dispose();
  }, 90_000);

  it('is fatal under failureMode: "closed" when the MCP server is unreachable', async () => {
    const connect = vi.fn(async () => {
      throw new Error("ECONNREFUSED mcp://unreachable");
    });
    const modelCall = vi.fn(() => undefined);

    const agent = createAgent({
      name: "McpFailClosedAgent",
      model: realModel(),
      plugins: [
        mcp({ connect, name: "mcp-required", failureMode: "closed" }),
        defineHook("preModelCall", () => modelCall(), { name: "model-call-spy" }),
      ],
    });

    await expect(
      agent.invoke({ messages: [{ role: "user", content: "Reply with the single word OK." }] }),
    ).rejects.toThrow(/fail-closed/i);

    // An agent whose required tools are missing must not improvise: the model
    // is never reached at all.
    expect(modelCall).not.toHaveBeenCalled();
  }, 60_000);
});
