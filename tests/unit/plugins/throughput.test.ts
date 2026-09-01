/**
 * Throughput built-ins: `rateLimit` (token bucket) and `responseCache`.
 *
 * As in `builtins.test.ts`, every plugin is driven through a real
 * `createPluginHost` run handle rather than by calling its hook directly — the
 * two properties these plugins are actually sold on (a bucket that survives the
 * per-run store, a cache whose entries survive being handed to a caller) are
 * only observable through the host's run lifecycle.
 *
 * The clock is faked for both: a refill measured against the wall clock is the
 * whole mechanism, and a test that waited for real seconds would be the slowest
 * file in the suite.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { createAgent, createTool } from "../../../src/index.js";
import { createPluginHost, rateLimit, responseCache } from "../../../src/plugins/index.js";
import type { AgentPlugin, PluginLogger, PluginRunHost } from "../../../src/plugins/index.js";
import type { AIMessage, Message, SmartAgentEvent, SmartState } from "../../../src/types.js";

// ─── Harness ─────────────────────────────────────────────────────────────────

const silentLogger: PluginLogger = { debug: () => {}, warn: () => {}, error: () => {} };

type Harness = {
  host: ReturnType<typeof createPluginHost>;
  run: PluginRunHost;
  events: SmartAgentEvent[];
  /** Open a second run over the same host — what a resume looks like to a plugin. */
  restart: () => PluginRunHost;
};

function harness(plugins: AgentPlugin[], state: Partial<SmartState> = {}): Harness {
  const events: SmartAgentEvent[] = [];
  const host = createPluginHost(plugins, { logger: silentLogger });
  const getState = () => ({ messages: [], ...state }) as SmartState;
  const begin = (runId: string) =>
    host.beginRun({ runId, agentName: "test-agent", getState, emit: (event) => events.push(event) });
  let current = begin("run-1");
  return {
    host,
    get run() {
      return current;
    },
    events,
    restart: () => {
      current.end();
      current = begin("run-2");
      return current;
    },
  } as Harness;
}

const toolInput = (toolName: string) => ({
  toolName,
  toolCallId: "call_1",
  args: {},
  tool: { name: toolName } as never,
  executionCount: 0,
});

const modelInput = (messages: Message[] = [], tools: Array<{ name: string }> = [], iteration = 1) => ({
  messages,
  tools: tools as never[],
  params: {},
  model: null,
  iteration,
});

const assistant = (content: string, extra: Record<string, unknown> = {}): AIMessage =>
  ({ role: "assistant", content, ...extra }) as AIMessage;

const metadataEvents = (events: SmartAgentEvent[]): Array<Record<string, unknown>> =>
  events.filter((event) => (event as { type?: string }).type === "metadata") as never;

// ─── rateLimit ───────────────────────────────────────────────────────────────

describe("rateLimit", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("allows up to the cap, denies past it, and says when to retry", async () => {
    const { run, events } = harness([rateLimit({ modelCallsPerMinute: 3 })]);

    for (let i = 0; i < 3; i += 1) {
      expect((await run.runGate("preModelCall", modelInput())).decision).toBe("allow");
    }

    const denied = await run.runGate("preModelCall", modelInput());
    expect(denied.decision).toBe("deny");
    expect(denied.deniedBy).toBe("rate-limit");
    expect(denied.reason).toContain("Rate limit reached for model calls (3/min), retry later.");

    // 3/min is one token every 20s, and the bucket was drained without the
    // clock moving — so that is exactly how long the caller has to wait.
    const reported = metadataEvents(events).find((event) => event.rateLimit);
    expect(reported?.rateLimit).toMatchObject({ limit: "model calls", perMinute: 3, retryAfterMs: 20_000 });
  });

  it("refills continuously from elapsed time, with no scheduler involved", async () => {
    const { run } = harness([rateLimit({ modelCallsPerMinute: 3 })]);
    for (let i = 0; i < 3; i += 1) await run.runGate("preModelCall", modelInput());
    expect((await run.runGate("preModelCall", modelInput())).decision).toBe("deny");

    // Half a token: still empty. A bucket that refilled in whole steps would
    // let this one through.
    vi.advanceTimersByTime(10_000);
    expect((await run.runGate("preModelCall", modelInput())).decision).toBe("deny");

    vi.advanceTimersByTime(10_000);
    expect((await run.runGate("preModelCall", modelInput())).decision).toBe("allow");
    // …and that single token is now spent again.
    expect((await run.runGate("preModelCall", modelInput())).decision).toBe("deny");

    // Long idle: the bucket refills to its capacity and no further.
    vi.advanceTimersByTime(10 * 60_000);
    for (let i = 0; i < 3; i += 1) {
      expect((await run.runGate("preModelCall", modelInput())).decision).toBe("allow");
    }
    expect((await run.runGate("preModelCall", modelInput())).decision).toBe("deny");
  });

  it("keeps per-tool ceilings independent, and does not charge the global bucket for a refused call", async () => {
    const { run } = harness([
      rateLimit({ toolCallsPerMinute: 2, perToolPerMinute: { search: 1 } }),
    ]);

    expect((await run.runGate("preToolUse", toolInput("search"))).decision).toBe("allow");
    const blocked = await run.runGate("preToolUse", toolInput("search"));
    expect(blocked.decision).toBe("deny");
    expect(blocked.reason).toContain('Rate limit reached for tool "search" (1/min)');

    // The refused `search` must not have spent a global token: two tool calls
    // per minute were bought, one was used, so exactly one is left.
    expect((await run.runGate("preToolUse", toolInput("echo"))).decision).toBe("allow");
    const exhausted = await run.runGate("preToolUse", toolInput("echo"));
    expect(exhausted.decision).toBe("deny");
    expect(exhausted.reason).toContain("Rate limit reached for tool calls (2/min)");

    // A tool with no ceiling of its own is still governed by the global one.
    const perToolOnly = harness([rateLimit({ perToolPerMinute: { search: 1 } })]);
    expect((await perToolOnly.run.runGate("preToolUse", toolInput("search"))).decision).toBe("allow");
    expect((await perToolOnly.run.runGate("preToolUse", toolInput("search"))).decision).toBe("deny");
    for (let i = 0; i < 5; i += 1) {
      expect((await perToolOnly.run.runGate("preToolUse", toolInput("echo"))).decision).toBe("allow");
    }
  });

  it('"wait" mode resolves once a token frees, and gives up at maxWaitMs', async () => {
    const waiting = harness([
      rateLimit({ modelCallsPerMinute: 1, onExceeded: "wait", maxWaitMs: 90_000 }),
    ]);
    expect((await waiting.run.runGate("preModelCall", modelInput())).decision).toBe("allow");

    let settled = false;
    const pending = waiting.run.runGate("preModelCall", modelInput()).then((gate) => {
      settled = true;
      return gate;
    });

    await vi.advanceTimersByTimeAsync(30_000);
    expect(settled).toBe(false); // still holding the call, not refusing it

    await vi.advanceTimersByTimeAsync(30_000);
    expect((await pending).decision).toBe("allow");

    // A wait longer than the budget is a deny, and an immediate one: sleeping
    // first would only make the same refusal arrive later.
    const impatient = harness([
      rateLimit({ modelCallsPerMinute: 1, onExceeded: "wait", maxWaitMs: 1_000 }),
    ]);
    expect((await impatient.run.runGate("preModelCall", modelInput())).decision).toBe("allow");
    const gate = await impatient.run.runGate("preModelCall", modelInput());
    expect(gate.decision).toBe("deny");
    expect(gate.reason).toContain("retry later");
  });

  it("keys buckets per tenant, and keeps them across runs", async () => {
    // One plugin instance, two hosts: the buckets live in the plugin's closure,
    // which is what makes the limit an agent-wide budget rather than a per-run one.
    const plugin = rateLimit({
      modelCallsPerMinute: 1,
      key: (ctx) => String((ctx.state as unknown as { ctx?: { tenantId?: string } }).ctx?.tenantId),
    });
    const acme = harness([plugin], { ctx: { tenantId: "acme" } } as Partial<SmartState>);
    const globex = harness([plugin], { ctx: { tenantId: "globex" } } as Partial<SmartState>);

    expect((await acme.run.runGate("preModelCall", modelInput())).decision).toBe("allow");
    expect((await acme.run.runGate("preModelCall", modelInput())).decision).toBe("deny");

    // A second tenant has its own budget — one runaway agent must not starve it.
    expect((await globex.run.runGate("preModelCall", modelInput())).decision).toBe("allow");

    // And the drained bucket survives a new run: a per-run store would hand
    // "acme" a full bucket on every invoke and limit nothing at all.
    const resumed = acme.restart();
    expect((await resumed.runGate("preModelCall", modelInput())).decision).toBe("deny");
  });

  it("does nothing when no ceiling is configured", async () => {
    const { run, events } = harness([rateLimit()]);
    for (let i = 0; i < 20; i += 1) {
      expect((await run.runGate("preModelCall", modelInput())).decision).toBe("allow");
      expect((await run.runGate("preToolUse", toolInput("search"))).decision).toBe("allow");
    }
    expect(metadataEvents(events)).toHaveLength(0);
  });

  it("declares that it never asks, so a tool batch is not serialized by it", () => {
    // Registering `preToolUse` without this flag would push every tool call
    // into the sequential group for a plugin that can only ever allow or deny.
    const host = createPluginHost([rateLimit({ toolCallsPerMinute: 1 })], { logger: silentLogger });
    expect(host.mayPauseOnToolUse()).toBe(false);
  });
});

// ─── responseCache ───────────────────────────────────────────────────────────

const cacheableCall = (question: string, iteration = 1) =>
  modelInput([{ role: "user", content: question }], [{ name: "search" }], iteration);

describe("responseCache", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("misses, stores, then short-circuits the identical call", async () => {
    const { run, events } = harness([responseCache()]);

    const miss = await run.runGate("preModelCall", cacheableCall("what is 2+2?"));
    expect(miss.shortCircuit).toBeUndefined();
    await run.runGate("postModelCall", {
      message: assistant("4"),
      durationMs: 5,
      iteration: 1,
      shortCircuited: false,
    });

    const hit = await run.runGate("preModelCall", cacheableCall("what is 2+2?", 2));
    expect(hit.shortCircuit).toEqual({ role: "assistant", content: "4" });
    expect(metadataEvents(events).some((event) => event.responseCache)).toBe(true);

    // Anything the key covers changing is a different call: the transcript…
    expect((await run.runGate("preModelCall", cacheableCall("what is 3+3?", 3))).shortCircuit).toBeUndefined();
    // …and the tool menu, which changes what the model is allowed to answer.
    const otherMenu = modelInput([{ role: "user", content: "what is 2+2?" }], [{ name: "shell" }], 4);
    expect((await run.runGate("preModelCall", otherMenu)).shortCircuit).toBeUndefined();
  });

  it("hands out a CLONE, so the caller mutating its assistant turn cannot poison the entry", async () => {
    const { run } = harness([responseCache()]);

    const original = assistant("cached answer");
    await run.runGate("preModelCall", cacheableCall("q"));
    await run.runGate("postModelCall", {
      message: original,
      durationMs: 1,
      iteration: 1,
      shortCircuited: false,
    });

    // The loop keeps editing the message it was handed after the hook returned.
    original.content = "mutated by the run that produced it";

    const first = (await run.runGate("preModelCall", cacheableCall("q", 2))).shortCircuit as AIMessage;
    expect(first.content).toBe("cached answer");
    expect(first).not.toBe(original);

    first.content = "mutated by the run that was served it";

    const second = (await run.runGate("preModelCall", cacheableCall("q", 3))).shortCircuit as AIMessage;
    expect(second.content).toBe("cached answer");
    expect(second).not.toBe(first);
  });

  it("caches a tool_calls turn with its ids intact, and deep-copies them", async () => {
    const { run } = harness([responseCache()]);
    const toolCall = {
      id: "call_abc",
      type: "function",
      function: { name: "search", arguments: '{"q":"weather"}' },
    };

    await run.runGate("preModelCall", cacheableCall("weather?"));
    await run.runGate("postModelCall", {
      message: assistant("", { tool_calls: [toolCall] }),
      durationMs: 1,
      iteration: 1,
      shortCircuited: false,
    });

    const first = (await run.runGate("preModelCall", cacheableCall("weather?", 2))).shortCircuit as AIMessage;
    // The id has to survive: the tool result that answers this turn is paired
    // to the request by that id, so a replayed turn with a rewritten id would
    // leave a dangling tool_call.
    expect(first.tool_calls).toEqual([toolCall]);

    (first.tool_calls as Array<{ id: string }>)[0].id = "call_rewritten";

    const second = (await run.runGate("preModelCall", cacheableCall("weather?", 3))).shortCircuit as AIMessage;
    expect((second.tool_calls as Array<{ id: string }>)[0].id).toBe("call_abc");
    // A shallow array copy would have shared the call object itself.
    expect((second.tool_calls as unknown[])[0]).not.toBe((first.tool_calls as unknown[])[0]);
  });

  it("keyOf returning undefined turns caching off for that call only", async () => {
    const { run } = harness([
      responseCache({
        // The realistic reason to opt out: the prompt carries something that
        // will never repeat, so an entry under it could only ever be stale.
        keyOf: (input) =>
          input.messages.some((message) => String(message.content).includes("now()"))
            ? undefined
            : String(input.messages.map((message) => message.content).join("|")),
      }),
    ]);

    const volatile = () => modelInput([{ role: "user", content: "time is now()" }], [], 1);
    expect((await run.runGate("preModelCall", volatile())).shortCircuit).toBeUndefined();
    await run.runGate("postModelCall", {
      message: assistant("12:00"),
      durationMs: 1,
      iteration: 1,
      shortCircuited: false,
    });
    expect((await run.runGate("preModelCall", volatile())).shortCircuit).toBeUndefined();

    // A call the key function does accept still caches normally.
    const stable = (iteration: number) => modelInput([{ role: "user", content: "capital of France" }], [], iteration);
    await run.runGate("preModelCall", stable(1));
    await run.runGate("postModelCall", {
      message: assistant("Paris"),
      durationMs: 1,
      iteration: 1,
      shortCircuited: false,
    });
    expect((await run.runGate("preModelCall", stable(2))).shortCircuit).toEqual({
      role: "assistant",
      content: "Paris",
    });
  });

  it("never re-caches a short-circuited turn", async () => {
    const { run } = harness([responseCache()]);

    // A miss, so the key is parked — and then some OTHER plugin serves the
    // turn. Writing that stub back under our key would cache a response the
    // provider never produced, and re-writing our own hit would refresh a TTL
    // that was never re-validated.
    await run.runGate("preModelCall", cacheableCall("q"));
    await run.runGate("postModelCall", {
      message: assistant("from another plugin"),
      durationMs: 0,
      iteration: 1,
      shortCircuited: true,
    });

    expect((await run.runGate("preModelCall", cacheableCall("q", 2))).shortCircuit).toBeUndefined();
  });

  it("expires an entry at ttlMs", async () => {
    const { run } = harness([responseCache({ ttlMs: 60_000 })]);

    await run.runGate("preModelCall", cacheableCall("q"));
    await run.runGate("postModelCall", {
      message: assistant("fresh"),
      durationMs: 1,
      iteration: 1,
      shortCircuited: false,
    });

    vi.advanceTimersByTime(59_000);
    expect((await run.runGate("preModelCall", cacheableCall("q", 2))).shortCircuit).toMatchObject({
      content: "fresh",
    });

    vi.advanceTimersByTime(2_000);
    expect((await run.runGate("preModelCall", cacheableCall("q", 3))).shortCircuit).toBeUndefined();
  });

  it("evicts the least recently used entry past maxEntries", async () => {
    const { run } = harness([responseCache({ maxEntries: 2 })]);
    let iteration = 0;

    const store = async (question: string, answer: string) => {
      iteration += 1;
      await run.runGate("preModelCall", cacheableCall(question, iteration));
      await run.runGate("postModelCall", {
        message: assistant(answer),
        durationMs: 1,
        iteration,
        shortCircuited: false,
      });
    };
    const lookup = async (question: string) => {
      iteration += 1;
      return (await run.runGate("preModelCall", cacheableCall(question, iteration))).shortCircuit as
        | AIMessage
        | undefined;
    };

    await store("a", "A");
    await store("b", "B");
    // Reading "a" makes "b" the coldest entry, so "b" is what the third write
    // displaces — FIFO would have dropped "a".
    expect(await lookup("a")).toMatchObject({ content: "A" });
    await store("c", "C");

    expect(await lookup("a")).toMatchObject({ content: "A" });
    expect(await lookup("c")).toMatchObject({ content: "C" });
    expect(await lookup("b")).toBeUndefined();
  });

  it('scope "run" dies with the run, scope "agent" outlives it', async () => {
    const seed = async (run: PluginRunHost) => {
      await run.runGate("preModelCall", cacheableCall("q"));
      await run.runGate("postModelCall", {
        message: assistant("shared"),
        durationMs: 1,
        iteration: 1,
        shortCircuited: false,
      });
    };

    const perRun = harness([responseCache()]);
    await seed(perRun.run);
    expect((await perRun.restart().runGate("preModelCall", cacheableCall("q", 2))).shortCircuit).toBeUndefined();

    const perAgent = harness([responseCache({ scope: "agent" })]);
    await seed(perAgent.run);
    expect((await perAgent.restart().runGate("preModelCall", cacheableCall("q", 2))).shortCircuit).toMatchObject({
      content: "shared",
    });
  });
});

// ─── responseCache, end to end ───────────────────────────────────────────────

describe("responseCache through createAgent", () => {
  it("a hit never reaches the provider and is never billed", async () => {
    const invoke = vi.fn(async () => ({
      role: "assistant",
      content: "42",
      usage: { prompt_tokens: 100, completion_tokens: 8, total_tokens: 108 },
    }));
    const model: any = {
      modelName: "scripted-model",
      bindTools() {
        return this;
      },
      invoke,
    };
    const tool = createTool({
      name: "search",
      description: "search (test tool)",
      schema: z.object({ message: z.string() }),
      func: async () => "nothing",
    });

    const agent = createAgent({
      name: "cached",
      model,
      tools: [tool],
      plugins: [responseCache({ scope: "agent" })],
    } as any);

    const question = { messages: [{ role: "user", content: "the answer?" }] } as any;

    const first = await agent.invoke(question);
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(first.content).toContain("42");
    expect(first.state?.usage?.perRequest ?? []).toHaveLength(1);

    const second = await agent.invoke(question);
    // The provider was never asked again…
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(second.content).toContain("42");
    // …so the run has nothing to bill: replaying the original call's token
    // counts would charge twice for one request and would fool budgetGuard.
    expect(second.state?.usage?.perRequest ?? []).toHaveLength(0);
  });
});
