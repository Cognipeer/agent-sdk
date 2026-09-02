/**
 * Plugin host, in isolation — createPluginHost -> beginRun -> runGate/runObservers.
 * No agent, no model call, no network.
 *
 * Every composition rule from the header of src/plugins/host.ts is exercised:
 *   R1 order        priority ascending, then registration order; stable
 *   R2 mutation     chained — each handler sees the previous one's output
 *   R3 decision     deny > ask > allow; the first deny ends the chain
 *   R4 short-circuit the first value offered wins; the rest are dropped with a warning
 *   R5 errors       failureMode "open" continues, "closed" denies
 *   R6 timeout      per-handler timeoutMs, treated as an error under R5
 *   R7 observers    concurrent, cannot mutate, never fail the run
 *   R8 observable   decisions/mutations/short-circuits/errors emit a `plugin` event
 *
 * The assertions check the ORDER handlers ran in (names pushed into an array),
 * not only the folded result: an out-of-order chain that happens to produce the
 * right final value is still a broken chain.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { createPluginHost, HOOK_NAMES } from "../../../src/plugins/host.js";
import type { PluginHost, PluginRunHost } from "../../../src/plugins/host.js";
import type { AgentPlugin, HookContext, HookMap } from "../../../src/plugins/types.js";
import type { SmartState, ToolInterface } from "../../../src/types.js";
import { createMinimalState } from "../../setup/fixtures/states.js";
import { calculatorTool, echoTool } from "../../setup/mocks/mockTools.js";
import { createMockModel } from "../../setup/mocks/mockModel.js";

afterEach(() => {
  vi.restoreAllMocks();
});

// ─── helpers ────────────────────────────────────────────────────────────────

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

function makeLogger() {
  return { debug: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

type Harness = {
  host: PluginHost;
  run: PluginRunHost;
  events: any[];
  logger: ReturnType<typeof makeLogger>;
  state: SmartState;
};

/** One host + one open run, with the emitted `plugin` events captured. */
function harness(
  plugins: AgentPlugin[],
  options: { debug?: boolean; depth?: number; maxModelRetries?: number; maxContinuations?: number } = {},
): Harness {
  const { debug, depth, ...hostOptions } = options;
  const events: any[] = [];
  const logger = makeLogger();
  const state = createMinimalState("hello");
  const host = createPluginHost(plugins, { logger, debug, ...hostOptions });
  const run = host.beginRun({
    runId: "run-1",
    agentName: "host-test-agent",
    getState: () => state,
    emit: (event) => {
      events.push(event);
    },
    depth,
  });
  return { host, run, events, logger, state };
}

const promptInput = (text = "hello"): HookMap["userPromptSubmit"]["input"] => ({
  text,
  message: { role: "user", content: text },
});

const toolInput = (
  over: Partial<HookMap["preToolUse"]["input"]> = {},
): HookMap["preToolUse"]["input"] => ({
  toolName: "echo",
  toolCallId: "call_1",
  args: { message: "hi" },
  tool: echoTool as ToolInterface,
  executionCount: 0,
  ...over,
});

const modelInput = (
  over: Partial<HookMap["preModelCall"]["input"]> = {},
): HookMap["preModelCall"]["input"] => ({
  messages: [{ role: "user", content: "hi" }],
  tools: [echoTool as ToolInterface],
  params: { response_format: { type: "json_object" }, temperature: 0 },
  model: { modelName: "fake" },
  iteration: 1,
  ...over,
});

const sessionEndInput = (): HookMap["sessionEnd"]["input"] => ({
  status: "success",
  durationMs: 12,
});

/** A userPromptSubmit plugin that records that it ran and appends to the text. */
function tagPlugin(name: string, order: string[], priority?: number): AgentPlugin {
  return {
    name,
    priority,
    hooks: {
      userPromptSubmit: (input) => {
        order.push(name);
        return { text: `${input.text}>${name}` };
      },
    },
  };
}

// ─── construction & validation ──────────────────────────────────────────────

describe("createPluginHost — construction & validation", () => {
  it("throws on a duplicate plugin name", () => {
    const a: AgentPlugin = { name: "audit" };
    const b: AgentPlugin = { name: "audit" };
    expect(() => createPluginHost([a, b])).toThrowError(/Duplicate plugin name "audit"/);
  });

  it("throws when a plugin has no usable name", () => {
    expect(() => createPluginHost([{ name: "" } as AgentPlugin])).toThrowError(/unique `name`/);
    expect(() => createPluginHost([{ name: 42 } as unknown as AgentPlugin])).toThrowError(/unique `name`/);
  });

  it("throws when two plugins claim the same slot, naming the slot AND both plugins", () => {
    const fast: AgentPlugin = {
      name: "fast-summarizer",
      provides: { summarizer: { name: "fast", compress: () => null } },
    };
    const smart: AgentPlugin = {
      name: "smart-summarizer",
      provides: { summarizer: { name: "smart", compress: () => null } },
    };

    let message = "";
    try {
      createPluginHost([fast, smart]);
    } catch (err) {
      message = err instanceof Error ? err.message : String(err);
    }
    expect(message).toContain('Slot "summarizer"');
    expect(message).toContain("fast-summarizer");
    expect(message).toContain("smart-summarizer");
  });

  it("resolves a slot with exactly one owner and ignores undefined slot values", () => {
    const host = createPluginHost([
      { name: "counter", provides: { tokenCounter: (text: string) => text.length } },
      { name: "abstains", provides: { tokenCounter: undefined } },
    ]);
    expect(host.slots.tokenCounter?.("abcd")).toBe(4);
    // Different slots on different plugins never collide.
    const two = createPluginHost([
      { name: "counter", provides: { tokenCounter: (text: string) => text.length } },
      { name: "coster", provides: { costEstimator: () => 1 } },
    ]);
    expect(two.slots.tokenCounter).toBeTypeOf("function");
    expect(two.slots.costEstimator).toBeTypeOf("function");
  });

  it("has()/hasAny() reflect the registry for all 13 hooks", () => {
    expect(HOOK_NAMES).toHaveLength(13);

    const empty = createPluginHost([]);
    expect(empty.hasAny()).toBe(false);
    for (const hook of HOOK_NAMES) expect(empty.has(hook)).toBe(false);

    const host = createPluginHost([
      { name: "p", hooks: { preToolUse: () => undefined, sessionEnd: () => undefined } },
    ]);
    expect(host.hasAny()).toBe(true);
    expect(host.has("preToolUse")).toBe(true);
    expect(host.has("sessionEnd")).toBe(true);
    expect(host.has("preModelCall")).toBe(false);
  });

  it("ignores non-function hook entries instead of registering them", () => {
    const host = createPluginHost([
      { name: "junk", hooks: { preToolUse: "nope" as unknown as never } },
    ]);
    expect(host.has("preToolUse")).toBe(false);
  });

  it("exposes maxModelRetries / maxContinuations with defaults, and forwards them to the run", () => {
    const defaults = harness([{ name: "p", hooks: { postModelCall: () => undefined } }]);
    expect(defaults.host.maxModelRetries).toBe(2);
    expect(defaults.host.maxContinuations).toBe(2);
    expect(defaults.run.maxModelRetries).toBe(2);
    expect(defaults.run.maxContinuations).toBe(2);

    const tuned = harness([{ name: "p", hooks: { postModelCall: () => undefined } }], {
      maxModelRetries: 5,
      maxContinuations: 1,
    });
    expect(tuned.run.maxModelRetries).toBe(5);
    expect(tuned.run.maxContinuations).toBe(1);
  });
});

// ─── R1 ─────────────────────────────────────────────────────────────────────

describe("R1 — order: priority ascending, then registration order, stable", () => {
  it("runs handlers in priority order and breaks ties by registration order", async () => {
    const order: string[] = [];
    const { host, run } = harness([
      tagPlugin("late", order, 50),
      tagPlugin("tie-a", order, 10),
      tagPlugin("tie-b", order, 10),
      tagPlugin("no-priority", order), // defaults to 100
    ]);

    expect(host.plugins.map((p) => p.name)).toEqual(["tie-a", "tie-b", "late", "no-priority"]);

    const result = await run.runGate("userPromptSubmit", promptInput("x"));
    expect(order).toEqual(["tie-a", "tie-b", "late", "no-priority"]);
    expect(result.input.text).toBe("x>tie-a>tie-b>late>no-priority");
  });

  it("keeps array-form handlers of one plugin in declaration order, interleaved by priority", async () => {
    const order: string[] = [];
    const { run } = harness([
      {
        name: "multi",
        priority: 10,
        hooks: {
          userPromptSubmit: [
            () => {
              order.push("multi#1");
            },
            () => {
              order.push("multi#2");
            },
          ],
        },
      },
      {
        name: "first",
        priority: 5,
        hooks: {
          userPromptSubmit: () => {
            order.push("first");
          },
        },
      },
    ]);

    await run.runGate("userPromptSubmit", promptInput());
    expect(order).toEqual(["first", "multi#1", "multi#2"]);
  });

  it("is stable across repeated runs of the same chain", async () => {
    const order: string[] = [];
    const { run } = harness([tagPlugin("a", order, 10), tagPlugin("b", order, 10), tagPlugin("c", order, 10)]);
    await run.runGate("userPromptSubmit", promptInput());
    await run.runGate("userPromptSubmit", promptInput());
    expect(order).toEqual(["a", "b", "c", "a", "b", "c"]);
  });
});

// ─── R2 ─────────────────────────────────────────────────────────────────────

describe("R2 — mutation is a waterfall", () => {
  it("hands handler N the payload handler N-1 produced", async () => {
    const seen: string[] = [];
    const { run } = harness([
      {
        name: "a",
        priority: 10,
        hooks: {
          userPromptSubmit: (input) => {
            seen.push(input.text);
            return { text: `${input.text}>a` };
          },
        },
      },
      {
        name: "b",
        priority: 20,
        hooks: {
          userPromptSubmit: (input) => {
            seen.push(input.text);
            return { text: `${input.text}>b` };
          },
        },
      },
      {
        name: "c",
        priority: 30,
        hooks: {
          userPromptSubmit: (input) => {
            seen.push(input.text);
            return { text: `${input.text}>c` };
          },
        },
      },
    ]);

    const result = await run.runGate("userPromptSubmit", promptInput("hello"));
    expect(seen).toEqual(["hello", "hello>a", "hello>a>b"]);
    expect(result.input.text).toBe("hello>a>b>c");
    expect(result.mutated).toBe(true);
  });

  it("never mutates the caller's payload object in place", async () => {
    const { run } = harness([
      {
        name: "rewriter",
        hooks: { userPromptSubmit: () => ({ text: "REWRITTEN" }) },
      },
    ]);
    const input = promptInput("original");
    const result = await run.runGate("userPromptSubmit", input);
    expect(result.input.text).toBe("REWRITTEN");
    expect(input.text).toBe("original");
    expect(result.input).not.toBe(input);
  });

  it("treats undefined / void / a non-object return as 'nothing changed'", async () => {
    const order: string[] = [];
    const { run } = harness([
      {
        name: "undef",
        priority: 10,
        hooks: {
          userPromptSubmit: () => {
            order.push("undef");
            return undefined;
          },
        },
      },
      {
        name: "void",
        priority: 20,
        hooks: {
          userPromptSubmit: () => {
            order.push("void");
          },
        },
      },
      {
        name: "garbage",
        priority: 30,
        hooks: {
          userPromptSubmit: () => {
            order.push("garbage");
            return "not-an-object" as unknown as never;
          },
        },
      },
    ]);

    const input = promptInput("untouched");
    const result = await run.runGate("userPromptSubmit", input);
    expect(order).toEqual(["undef", "void", "garbage"]);
    expect(result.mutated).toBe(false);
    expect(result.decision).toBe("allow");
    // Nothing folded, so the very same payload object comes back out.
    expect(result.input).toBe(input);
    expect(result.input.text).toBe("untouched");
  });

  it("folds only the fields declared mutable for that hook", async () => {
    const { run } = harness([
      {
        name: "sneaky",
        hooks: {
          // `message` is not a userPromptSubmit output field; it must be ignored.
          userPromptSubmit: () => ({ message: { role: "user", content: "swapped" } } as any),
        },
      },
    ]);
    const input = promptInput("keep");
    const result = await run.runGate("userPromptSubmit", input);
    expect(result.input.message.content).toBe("keep");
    expect(result.mutated).toBe(false);
  });

  it("mutates messages/tools for preModelCall and message for postModelCall", async () => {
    const { run } = harness([
      {
        name: "narrow",
        hooks: {
          preModelCall: (input) => ({
            messages: [...input.messages, { role: "system", content: "extra" }],
            tools: input.tools.filter((tool) => tool.name !== "echo"),
          }),
          postModelCall: (input) => ({ message: { ...input.message, content: "redacted" } }),
        },
      },
    ]);

    const gate = await run.runGate("preModelCall", modelInput());
    expect(gate.input.messages).toHaveLength(2);
    expect(gate.input.tools).toHaveLength(0);
    expect(gate.mutated).toBe(true);

    const post = await run.runGate("postModelCall", {
      message: { role: "assistant", content: "secret" },
      durationMs: 5,
      iteration: 1,
      shortCircuited: false,
    });
    expect(post.input.message.content).toBe("redacted");
  });
});

// ─── R3 ─────────────────────────────────────────────────────────────────────

describe("R3 — decisions: deny > ask > allow", () => {
  it("escalates allow -> ask and ends the chain on the FIRST deny", async () => {
    const order: string[] = [];
    const { run } = harness([
      {
        name: "auditor",
        priority: 10,
        hooks: {
          preToolUse: () => {
            order.push("auditor");
            return { decision: "allow" };
          },
        },
      },
      {
        name: "asker",
        priority: 20,
        hooks: {
          preToolUse: () => {
            order.push("asker");
            return { decision: "ask", approvalPrompt: "Run echo?" };
          },
        },
      },
      {
        name: "blocker",
        priority: 30,
        hooks: {
          preToolUse: () => {
            order.push("blocker");
            return { decision: "deny", reason: "outside the sandbox" };
          },
        },
      },
      {
        name: "never-runs",
        priority: 40,
        hooks: {
          preToolUse: () => {
            order.push("never-runs");
            return { decision: "allow" };
          },
        },
      },
    ]);

    const result = await run.runGate("preToolUse", toolInput());
    expect(order).toEqual(["auditor", "asker", "blocker"]);
    expect(result.decision).toBe("deny");
    expect(result.deniedBy).toBe("blocker");
  });

  it("a later 'allow' can never downgrade an earlier 'ask'", async () => {
    const order: string[] = [];
    const { run } = harness([
      {
        name: "asker",
        priority: 10,
        hooks: {
          preToolUse: () => {
            order.push("asker");
            return { decision: "ask", reason: "human, please" };
          },
        },
      },
      {
        name: "permissive",
        priority: 20,
        hooks: {
          preToolUse: () => {
            order.push("permissive");
            return { decision: "allow" };
          },
        },
      },
    ]);

    const result = await run.runGate("preToolUse", toolInput());
    expect(order).toEqual(["asker", "permissive"]);
    expect(result.decision).toBe("ask");
    // The caller ORs this with the tool's own needsApproval, so an "ask" that
    // survives here is what keeps a dangerous tool behind a human.
    expect(result.deniedBy).toBeUndefined();
  });

  it("prefixes the surfaced reason with the plugin that produced it", async () => {
    const { run } = harness([
      { name: "sandbox", hooks: { preToolUse: () => ({ decision: "deny", reason: "path escapes /workspace" }) } },
    ]);
    const result = await run.runGate("preToolUse", toolInput());
    expect(result.reason).toBe("sandbox: path escapes /workspace");
    expect(result.deniedBy).toBe("sandbox");
  });

  it("keeps the mutations made before the deny", async () => {
    const { run } = harness([
      {
        name: "normalizer",
        priority: 10,
        hooks: { preToolUse: (input) => ({ args: { ...(input.args as object), normalized: true } }) },
      },
      { name: "blocker", priority: 20, hooks: { preToolUse: () => ({ decision: "deny", reason: "no" }) } },
    ]);
    const result = await run.runGate("preToolUse", toolInput());
    expect(result.decision).toBe("deny");
    expect(result.input.args).toEqual({ message: "hi", normalized: true });
    expect(result.mutated).toBe(true);
  });

  it("stays 'allow' with an empty collected/flags shape when every handler abstains", async () => {
    const { run } = harness([{ name: "quiet", hooks: { preToolUse: () => undefined } }]);
    const result = await run.runGate("preToolUse", toolInput());
    expect(result.decision).toBe("allow");
    expect(result.reason).toBeUndefined();
    expect(result.collected).toEqual({});
    expect(result.flags).toEqual({});
    expect(result.metadata).toBeUndefined();
  });

  it("returns a neutral allow when no plugin registered the hook at all", async () => {
    const { run } = harness([{ name: "p", hooks: { sessionEnd: () => undefined } }]);
    const input = toolInput();
    const result = await run.runGate("preToolUse", input);
    expect(result).toEqual({ decision: "allow", input, mutated: false,
      mutatedBy: [], collected: {}, flags: {} });
    expect(result.input).toBe(input);
  });

  it("the deny's reason wins over an earlier non-blocking reason", async () => {
    const { run } = harness([
      { name: "asker", priority: 10, hooks: { preToolUse: () => ({ decision: "ask", reason: "needs approval" }) } },
      { name: "policy", priority: 20, hooks: { preToolUse: () => ({ decision: "deny", reason: "blocked by policy" }) } },
    ]);
    const result = await run.runGate("preToolUse", toolInput());
    expect(result.decision).toBe("deny");
    expect(result.deniedBy).toBe("policy");
    expect(result.reason).toBe("policy: blocked by policy");
  });

  it("a reason-less deny does NOT inherit an earlier plugin's non-blocking reason", async () => {
    const { run } = harness([
      { name: "scanner", priority: 10, hooks: { preToolUse: () => ({ decision: "allow", reason: "looks fine" }) } },
      { name: "policy", priority: 20, hooks: { preToolUse: () => ({ decision: "deny" }) } },
    ]);
    const result = await run.runGate("preToolUse", toolInput());
    expect(result.decision).toBe("deny");
    expect(result.deniedBy).toBe("policy");
    // Surfacing "scanner: looks fine" as the block message would name the
    // wrong plugin and say the opposite of what happened. The caller falls
    // back to its own hook-specific default instead.
    expect(result.reason).toBeUndefined();
  });

  it("a non-escalating handler's reason is kept only while there is none yet", async () => {
    const { run } = harness([
      { name: "first", priority: 10, hooks: { preToolUse: () => ({ decision: "ask", reason: "first asks" }) } },
      { name: "second", priority: 20, hooks: { preToolUse: () => ({ decision: "ask", reason: "second asks" }) } },
    ]);
    const result = await run.runGate("preToolUse", toolInput());
    expect(result.decision).toBe("ask");
    expect(result.reason).toBe("first: first asks");
  });

  it('"ask" from a hook without approval semantics is read as deny; on preToolUse it stays "ask"', async () => {
    const reviewer: AgentPlugin = {
      name: "reviewer",
      hooks: {
        postModelCall: () => ({ decision: "ask", reason: "needs review" }) as any,
        userPromptSubmit: () => ({ decision: "ask" }) as any,
        preToolUse: () => ({ decision: "ask" }),
      },
    };
    const { run, logger } = harness([reviewer]);

    const post = await run.runGate("postModelCall", {
      message: { role: "assistant", content: "x" } as any,
      durationMs: 1,
      iteration: 1,
      shortCircuited: false,
    });
    expect(post.decision).toBe("deny");
    expect(post.deniedBy).toBe("reviewer");
    expect(post.reason).toBe("reviewer: needs review");

    // Reason-less: the caller's default applies, but the run still stops.
    const prompt = await run.runGate("userPromptSubmit", promptInput());
    expect(prompt.decision).toBe("deny");
    expect(prompt.deniedBy).toBe("reviewer");
    expect(prompt.reason).toBeUndefined();

    const warned = logger.warn.mock.calls.map((call) => call.join(" ")).join("\n");
    expect(warned).toContain('returned "ask" from "postModelCall"');
    expect(warned).toContain('returned "ask" from "userPromptSubmit"');

    // The one hook with a ledger to park the call in keeps the real semantics.
    const pre = await run.runGate("preToolUse", toolInput());
    expect(pre.decision).toBe("ask");
    expect(pre.deniedBy).toBeUndefined();
  });
});

// ─── R4 ─────────────────────────────────────────────────────────────────────

describe("R4 — short-circuit: the first value offered wins", () => {
  it("preToolUse: keeps the first `result` and drops later ones with a warning", async () => {
    const order: string[] = [];
    const { run, logger } = harness([
      {
        name: "cache",
        priority: 10,
        hooks: {
          preToolUse: () => {
            order.push("cache");
            return { result: "from-cache" };
          },
        },
      },
      {
        name: "mock",
        priority: 20,
        hooks: {
          preToolUse: () => {
            order.push("mock");
            return { result: "from-mock" };
          },
        },
      },
      {
        name: "after",
        priority: 30,
        hooks: {
          preToolUse: (input) => {
            order.push("after");
            return { args: { ...(input.args as object), seen: true } };
          },
        },
      },
    ]);

    const result = await run.runGate("preToolUse", toolInput());
    // A short-circuit does not end the chain — only a deny does.
    expect(order).toEqual(["cache", "mock", "after"]);
    expect(result.shortCircuit).toBe("from-cache");
    expect(result.decision).toBe("allow");
    expect(logger.warn).toHaveBeenCalled();
    const warned = logger.warn.mock.calls.map((call) => call.join(" ")).join("\n");
    expect(warned).toContain('plugin "mock" offered a second short-circuit');
    expect(warned).not.toContain('plugin "cache" offered');
  });

  it("preModelCall: the first shortCircuit message wins", async () => {
    const { run } = harness([
      { name: "cache", priority: 10, hooks: { preModelCall: () => ({ shortCircuit: { role: "assistant", content: "cached" } }) } },
      { name: "stub", priority: 20, hooks: { preModelCall: () => ({ shortCircuit: { role: "assistant", content: "stub" } }) } },
    ]);
    const result = await run.runGate("preModelCall", modelInput());
    expect((result.shortCircuit as { content: string }).content).toBe("cached");
  });

  it("non-short-circuit firstWins fields (approvalPrompt, continueWith) also keep the first value, silently", async () => {
    const tool = harness([
      { name: "first", priority: 10, hooks: { preToolUse: () => ({ decision: "ask", approvalPrompt: "First prompt?" }) } },
      { name: "second", priority: 20, hooks: { preToolUse: () => ({ decision: "ask", approvalPrompt: "Second prompt?" }) } },
    ]);
    const toolResult = await tool.run.runGate("preToolUse", toolInput());
    expect((toolResult as unknown as { approvalPrompt?: string }).approvalPrompt).toBe("First prompt?");
    const warned = tool.logger.warn.mock.calls.map((call) => call.join(" ")).join("\n");
    expect(warned).not.toContain("short-circuit");

    const final = harness([
      { name: "critic", priority: 10, hooks: { preFinalAnswer: () => ({ continueWith: "cite your sources" }) } },
      { name: "picky", priority: 20, hooks: { preFinalAnswer: () => ({ continueWith: "be shorter" }) } },
    ]);
    const finalResult = await final.run.runGate("preFinalAnswer", { content: "done" });
    expect((finalResult as unknown as { continueWith?: string }).continueWith).toBe("cite your sources");
  });

  it("an offered `undefined` is not an offer", async () => {
    const { run, logger } = harness([
      { name: "abstains", priority: 10, hooks: { preToolUse: () => ({ result: undefined }) } },
      { name: "offers", priority: 20, hooks: { preToolUse: () => ({ result: "real" }) } },
    ]);
    const result = await run.runGate("preToolUse", toolInput());
    expect(result.shortCircuit).toBe("real");
    const warned = logger.warn.mock.calls.map((call) => call.join(" ")).join("\n");
    expect(warned).not.toContain("short-circuit");
  });
});

// ─── R5 ─────────────────────────────────────────────────────────────────────

describe("R5 — errors: failureMode decides", () => {
  it("fail-open (the default) logs, keeps earlier mutations and continues the chain", async () => {
    const order: string[] = [];
    const { run, logger } = harness([
      {
        name: "before",
        priority: 10,
        hooks: {
          userPromptSubmit: (input) => {
            order.push("before");
            return { text: `${input.text}>before` };
          },
        },
      },
      {
        name: "boom",
        priority: 20,
        hooks: {
          userPromptSubmit: () => {
            order.push("boom");
            throw new Error("plugin exploded");
          },
        },
      },
      {
        name: "after",
        priority: 30,
        hooks: {
          userPromptSubmit: (input) => {
            order.push("after");
            return { text: `${input.text}>after` };
          },
        },
      },
    ]);

    const result = await run.runGate("userPromptSubmit", promptInput("x"));
    expect(order).toEqual(["before", "boom", "after"]);
    expect(result.decision).toBe("allow");
    expect(result.input.text).toBe("x>before>after");
    expect(logger.warn).toHaveBeenCalled();
    expect(logger.warn.mock.calls.map((call) => call.join(" ")).join("\n")).toContain('plugin "boom"');
  });

  it("a rejected promise is handled exactly like a synchronous throw", async () => {
    const { run } = harness([
      { name: "async-boom", hooks: { userPromptSubmit: async () => Promise.reject(new Error("async exploded")) } },
      { name: "after", priority: 200, hooks: { userPromptSubmit: (input) => ({ text: `${input.text}!` }) } },
    ]);
    const result = await run.runGate("userPromptSubmit", promptInput("x"));
    expect(result.decision).toBe("allow");
    expect(result.input.text).toBe("x!");
  });

  it("fail-closed turns the error into a deny and stops the chain", async () => {
    const order: string[] = [];
    const { run } = harness([
      {
        name: "normalizer",
        priority: 10,
        hooks: {
          preToolUse: (input) => {
            order.push("normalizer");
            return { args: { ...(input.args as object), normalized: true } };
          },
        },
      },
      {
        name: "strict",
        priority: 20,
        failureMode: "closed",
        hooks: {
          preToolUse: () => {
            order.push("strict");
            throw new Error("policy service unreachable");
          },
        },
      },
      {
        name: "never-runs",
        priority: 30,
        hooks: {
          preToolUse: () => {
            order.push("never-runs");
          },
        },
      },
    ]);

    const result = await run.runGate("preToolUse", toolInput());
    expect(order).toEqual(["normalizer", "strict"]);
    expect(result.decision).toBe("deny");
    expect(result.deniedBy).toBe("strict");
    expect(result.reason).toContain("fail-closed");
    expect(result.reason).toContain("policy service unreachable");
    // The payload folded so far still comes back for the caller to log.
    expect(result.input.args).toEqual({ message: "hi", normalized: true });
  });

  it("failureMode is per plugin: one fail-open thrower does not arm another plugin's fail-closed", async () => {
    const { run } = harness([
      { name: "loose", priority: 10, hooks: { preToolUse: () => { throw new Error("whatever"); } } },
      { name: "strict", priority: 20, failureMode: "closed", hooks: { preToolUse: () => ({ decision: "allow" }) } },
    ]);
    const result = await run.runGate("preToolUse", toolInput());
    expect(result.decision).toBe("allow");
    expect(result.deniedBy).toBeUndefined();
  });

  // `DECISION_RANK["block"]` is undefined, so the escalation compare used to be
  // false and the chain proceeded as allow while the `plugin` event echoed the
  // string as if a verdict had been taken. A policy service's own vocabulary
  // (block / redact / warn) is exactly how such a value arrives.
  it("an unknown decision string is a handler error, not an allow: fail-open skips it and logs at error level", async () => {
    const order: string[] = [];
    const { run, logger, events } = harness([
      {
        name: "console-vocab",
        priority: 10,
        hooks: {
          userPromptSubmit: () => {
            order.push("console-vocab");
            return { decision: "block", reason: "policy hit" } as any;
          },
        },
      },
      {
        name: "after",
        priority: 20,
        hooks: {
          userPromptSubmit: (input) => {
            order.push("after");
            return { text: `${input.text}!` };
          },
        },
      },
    ]);

    const result = await run.runGate("userPromptSubmit", promptInput("x"));
    expect(order).toEqual(["console-vocab", "after"]);
    expect(result.decision).toBe("allow");
    expect(result.input.text).toBe("x!");
    // The bogus verdict must not leak out as though it had been taken.
    expect(result.reason).toBeUndefined();
    expect(result.deniedBy).toBeUndefined();

    const errored = logger.error.mock.calls.map((call) => call.join(" ")).join("\n");
    expect(errored).toContain('plugin "console-vocab"');
    expect(errored).toContain('hook "userPromptSubmit"');
    expect(errored).toContain('"block"');
    expect(events.some((e) => e.type === "plugin" && e.plugin === "console-vocab" && e.phase === "error")).toBe(true);
    expect(events.some((e) => e.type === "plugin" && e.decision === "block")).toBe(false);
  });

  it("an unknown decision string on a fail-closed plugin denies, naming the plugin and the value", async () => {
    const order: string[] = [];
    const { run } = harness([
      {
        name: "strict-vocab",
        priority: 10,
        failureMode: "closed",
        hooks: { userPromptSubmit: () => ({ decision: "DENY" }) as any },
      },
      {
        name: "never-runs",
        priority: 20,
        hooks: {
          userPromptSubmit: (input) => {
            order.push("never-runs");
            return { text: `${input.text}!` };
          },
        },
      },
    ]);

    const result = await run.runGate("userPromptSubmit", promptInput("x"));
    expect(order).toEqual([]);
    expect(result.decision).toBe("deny");
    expect(result.deniedBy).toBe("strict-vocab");
    expect(result.reason).toContain("fail-closed");
    expect(result.reason).toContain("invalid decision");
    expect(result.reason).toContain('"DENY"');
    expect(result.input.text).toBe("x");
  });

  it("a non-string decision (true) is rejected the same way", async () => {
    const { run, logger } = harness([
      { name: "boolean-vocab", hooks: { preToolUse: () => ({ decision: true }) as any } },
    ]);
    const result = await run.runGate("preToolUse", toolInput());
    expect(result.decision).toBe("allow");
    expect(logger.error.mock.calls.map((call) => call.join(" ")).join("\n")).toContain("true");
  });
});

// ─── R6 ─────────────────────────────────────────────────────────────────────

describe("R6 — timeout is per handler and behaves like an error", () => {
  it("drops the late result of a slow fail-open handler and keeps going", async () => {
    const order: string[] = [];
    const { run, events } = harness([
      {
        name: "slow",
        priority: 10,
        timeoutMs: 15,
        hooks: {
          userPromptSubmit: async () => {
            order.push("slow");
            await sleep(80);
            return { text: "TOO LATE" };
          },
        },
      },
      {
        name: "fast",
        priority: 20,
        timeoutMs: 15,
        hooks: {
          userPromptSubmit: (input) => {
            order.push("fast");
            return { text: `${input.text}>fast` };
          },
        },
      },
    ]);

    const result = await run.runGate("userPromptSubmit", promptInput("x"));
    expect(order).toEqual(["slow", "fast"]);
    expect(result.input.text).toBe("x>fast");
    expect(result.decision).toBe("allow");

    const timeouts = events.filter((event) => event.phase === "timeout");
    expect(timeouts).toHaveLength(1);
    expect(timeouts[0].plugin).toBe("slow");
    expect(timeouts[0].hook).toBe("userPromptSubmit");
    expect(timeouts[0].error.message).toContain("timed out after 15ms");
  });

  it("a fail-closed timeout denies, naming the plugin and the timeout", async () => {
    const { run } = harness([
      {
        name: "slow-guard",
        failureMode: "closed",
        timeoutMs: 15,
        hooks: { preToolUse: async () => { await sleep(80); return { decision: "allow" as const }; } },
      },
    ]);
    const result = await run.runGate("preToolUse", toolInput());
    expect(result.decision).toBe("deny");
    expect(result.deniedBy).toBe("slow-guard");
    expect(result.reason).toContain("timed out");
    expect(result.reason).toContain("fail-closed");
  });

  it("timeoutMs: 0 disables the timeout for that plugin", async () => {
    const { run, events } = harness([
      {
        name: "patient",
        timeoutMs: 0,
        hooks: { userPromptSubmit: async () => { await sleep(30); return { text: "arrived" }; } },
      },
    ]);
    const result = await run.runGate("userPromptSubmit", promptInput("x"));
    expect(result.input.text).toBe("arrived");
    expect(events.filter((event) => event.phase === "timeout")).toHaveLength(0);
  });
});

// ─── R7 ─────────────────────────────────────────────────────────────────────

describe("R7 — observers never block, mutate or fail the run", () => {
  it("runs sessionEnd observers concurrently", async () => {
    const order: string[] = [];
    const bStarted = deferred();
    const { run, events } = harness([
      {
        name: "waiter",
        priority: 10,
        timeoutMs: 400,
        hooks: {
          sessionEnd: async () => {
            order.push("waiter:start");
            await bStarted.promise; // only resolvable if the second observer already started
            order.push("waiter:end");
          },
        },
      },
      {
        name: "starter",
        priority: 20,
        hooks: {
          sessionEnd: async () => {
            order.push("starter:start");
            bStarted.resolve();
          },
        },
      },
    ]);

    await run.runObservers("sessionEnd", sessionEndInput());
    expect(order).toEqual(["waiter:start", "starter:start", "waiter:end"]);
    expect(events.filter((event) => event.phase !== "success")).toHaveLength(0);
  });

  it("ignores observer return values and resolves to undefined", async () => {
    const { run } = harness([
      {
        name: "greedy",
        hooks: {
          // sessionEnd's output is void; anything returned must be dropped.
          sessionEnd: () => ({ status: "error", result: "hijacked" } as any),
        },
      },
    ]);
    const input = sessionEndInput();
    await expect(run.runObservers("sessionEnd", input)).resolves.toBeUndefined();
    expect(input.status).toBe("success");
  });

  it("swallows a throwing observer, a rejecting observer and a timing-out observer", async () => {
    const order: string[] = [];
    const { run, events, logger } = harness([
      {
        name: "thrower",
        priority: 10,
        hooks: {
          notification: () => {
            order.push("thrower");
            throw new Error("observer exploded");
          },
        },
      },
      {
        name: "slow",
        priority: 20,
        timeoutMs: 15,
        hooks: {
          notification: async () => {
            order.push("slow");
            await sleep(80);
          },
        },
      },
      {
        name: "healthy",
        priority: 30,
        hooks: {
          notification: () => {
            order.push("healthy");
          },
        },
      },
    ]);

    await expect(
      run.runObservers("notification", { kind: "limit", detail: { limit: "maxSteps" } }),
    ).resolves.toBeUndefined();
    expect(order.sort()).toEqual(["healthy", "slow", "thrower"]);
    expect(logger.warn).toHaveBeenCalled();
    expect(events.filter((event) => event.phase === "error")).toHaveLength(1);
    expect(events.filter((event) => event.phase === "timeout")).toHaveLength(1);
  });

  it("is a no-op when nothing registered the observer hook", async () => {
    const { run, events } = harness([{ name: "p", hooks: { preToolUse: () => undefined } }]);
    await expect(run.runObservers("postCompact", {
      summary: {} as HookMap["postCompact"]["input"]["summary"],
      tokensBefore: 100,
      tokensAfter: 10,
      strategy: "builtin",
    })).resolves.toBeUndefined();
    expect(events).toHaveLength(0);
  });

  it("delivers subagentStop to every observer", async () => {
    const seen: Array<{ plugin: string; name: string; depth: number }> = [];
    const { run } = harness([
      { name: "one", hooks: { subagentStop: (input, ctx) => { seen.push({ plugin: "one", name: input.name, depth: ctx.depth }); } } },
      { name: "two", hooks: { subagentStop: (input) => { seen.push({ plugin: "two", name: input.name, depth: input.depth }); } } },
    ]);
    await run.runObservers("subagentStop", { name: "researcher", result: "ok", depth: 1, durationMs: 3 });
    expect(seen.map((entry) => entry.plugin).sort()).toEqual(["one", "two"]);
    expect(seen.every((entry) => entry.name === "researcher")).toBe(true);
  });
});

// ─── R8 ─────────────────────────────────────────────────────────────────────

describe("R8 — the hook layer is observable", () => {
  it("emits a `plugin` event for decisions, mutations, short-circuits and errors", async () => {
    const { run, events } = harness([
      { name: "mutator", priority: 10, hooks: { preToolUse: (input) => ({ args: { ...(input.args as object), tagged: true } }) } },
      { name: "cacher", priority: 20, hooks: { preToolUse: () => ({ result: "cached" }) } },
      { name: "thrower", priority: 30, hooks: { preToolUse: () => { throw new Error("nope"); } } },
      { name: "denier", priority: 40, hooks: { preToolUse: () => ({ decision: "deny", reason: "policy" }) } },
    ]);

    await run.runGate("preToolUse", toolInput());

    expect(events.map((event) => `${event.plugin}:${event.phase}`)).toEqual([
      "mutator:success",
      "cacher:success",
      "thrower:error",
      "denier:success",
    ]);
    for (const event of events) {
      expect(event.type).toBe("plugin");
      expect(event.hook).toBe("preToolUse");
      expect(typeof event.durationMs).toBe("number");
    }
    expect(events[0].mutated).toBe(true);
    expect(events[1].shortCircuited).toBe(true);
    expect(events[2].error.message).toBe("nope");
    expect(events[3].decision).toBe("deny");
    // The event carries the raw reason; only GateResult.reason is plugin-prefixed.
    expect(events[3].reason).toBe("policy");
  });

  it("stays quiet for uneventful handlers unless debug is on", async () => {
    const quiet = harness([
      { name: "silent", priority: 10, hooks: { userPromptSubmit: () => undefined } },
      { name: "allows", priority: 20, hooks: { userPromptSubmit: () => ({ decision: "allow" as const }) } },
    ]);
    await quiet.run.runGate("userPromptSubmit", promptInput());
    expect(quiet.events).toHaveLength(0);

    const loud = harness(
      [
        { name: "silent", priority: 10, hooks: { userPromptSubmit: () => undefined } },
        { name: "allows", priority: 20, hooks: { userPromptSubmit: () => ({ decision: "allow" as const }) } },
      ],
      { debug: true },
    );
    await loud.run.runGate("userPromptSubmit", promptInput());
    expect(loud.events.map((event) => `${event.plugin}:${event.phase}`)).toEqual([
      "silent:success",
      "allows:success",
    ]);
  });

  it("lets a handler emit its own event through ctx.emit, and survives an emit that throws", async () => {
    const events: any[] = [];
    const host = createPluginHost(
      [
        {
          name: "reporter",
          hooks: {
            userPromptSubmit: (_input, ctx) => {
              ctx.emit({ type: "custom-from-plugin" } as any);
              return { text: "changed" };
            },
          },
        },
      ],
      { logger: makeLogger() },
    );
    const state = createMinimalState();
    const run = host.beginRun({
      runId: "run-emit",
      getState: () => state,
      emit: (event) => {
        events.push(event);
        if ((event as any).type === "plugin") throw new Error("consumer blew up");
      },
    });

    const result = await run.runGate("userPromptSubmit", promptInput());
    expect(result.input.text).toBe("changed");
    expect(events.map((event) => event.type)).toEqual(["custom-from-plugin", "plugin"]);
  });

  it("runs fine when beginRun was given no emit at all", async () => {
    const host = createPluginHost([{ name: "p", hooks: { userPromptSubmit: () => ({ text: "ok" }) } }], {
      logger: makeLogger(),
    });
    const state = createMinimalState();
    const run = host.beginRun({ runId: "run-no-emit", getState: () => state });
    const result = await run.runGate("userPromptSubmit", promptInput());
    expect(result.input.text).toBe("ok");
  });

  it("only the plugin that actually offered the short-circuit is flagged", async () => {
    const { run, events } = harness([
      { name: "cacher", priority: 10, hooks: { preToolUse: () => ({ result: "cached" }) } },
      { name: "bystander", priority: 20, hooks: { preToolUse: () => ({ metadata: { seen: true } }) } },
    ]);
    await run.runGate("preToolUse", toolInput());
    const bystander = events.find((event) => event.plugin === "bystander");
    expect(bystander?.shortCircuited).toBeFalsy();
  });
});

// ─── collect / merge / flags ────────────────────────────────────────────────

describe("collect, merge and flag folding", () => {
  it("sessionStart.systemPromptAppend accumulates across handlers, in order", async () => {
    const { run } = harness([
      { name: "policy", priority: 10, hooks: { sessionStart: () => ({ systemPromptAppend: "Follow policy X." }) } },
      { name: "silent", priority: 20, hooks: { sessionStart: () => undefined } },
      { name: "tone", priority: 30, hooks: { sessionStart: () => ({ systemPromptAppend: "Be terse." }) } },
    ]);
    const result = await run.runGate("sessionStart", { messages: [{ role: "user", content: "hi" }], resumed: false });
    expect(result.collected.systemPromptAppend).toEqual(["Follow policy X.", "Be terse."]);
    // A collect field is not a mutation of the payload.
    expect(result.mutated).toBe(false);
  });

  it("userPromptSubmit.additionalContext accumulates while `text` still waterfalls", async () => {
    const { run } = harness([
      { name: "a", priority: 10, hooks: { userPromptSubmit: (input) => ({ text: input.text.toUpperCase(), additionalContext: "ctx-a" }) } },
      { name: "b", priority: 20, hooks: { userPromptSubmit: (input) => ({ text: `${input.text}!`, additionalContext: "ctx-b" }) } },
    ]);
    const result = await run.runGate("userPromptSubmit", promptInput("hello"));
    expect(result.input.text).toBe("HELLO!");
    expect(result.collected.additionalContext).toEqual(["ctx-a", "ctx-b"]);
    expect(result.mutated).toBe(true);
  });

  it("preModelCall.params shallow-merges instead of replacing", async () => {
    const { run } = harness([
      { name: "reasoner", priority: 10, hooks: { preModelCall: () => ({ params: { reasoning: { effort: "low" } } }) } },
      { name: "hotter", priority: 20, hooks: { preModelCall: () => ({ params: { temperature: 0.7 } }) } },
    ]);
    const input = modelInput();
    const result = await run.runGate("preModelCall", input);
    expect(result.input.params).toEqual({
      response_format: { type: "json_object" },
      temperature: 0.7,
      reasoning: { effort: "low" },
    });
    // A hook that adds one key must not drop response_format…
    expect(result.input.params.response_format).toEqual({ type: "json_object" });
    // …nor edit the caller's own params object.
    expect(input.params).toEqual({ response_format: { type: "json_object" }, temperature: 0 });
  });

  it("preCompact.skip and postModelCall.retry OR across handlers and cannot be un-set", async () => {
    const compact = harness([
      { name: "no-opinion", priority: 10, hooks: { preCompact: () => ({ skip: false }) } },
      { name: "pin", priority: 20, hooks: { preCompact: (input) => ({ skip: true, messages: input.messages.slice(0, 1) }) } },
      { name: "late-no", priority: 30, hooks: { preCompact: () => ({ skip: false }) } },
    ]);
    const compactResult = await compact.run.runGate("preCompact", {
      reason: "token_pressure",
      messages: [{ role: "user", content: "a" }, { role: "assistant", content: "b" }],
      tokenCount: 900,
      threshold: 800,
    });
    expect(compactResult.flags.skip).toBe(true);
    expect(compactResult.input.messages).toHaveLength(1);

    const post = harness([
      { name: "checker", priority: 10, hooks: { postModelCall: () => ({ retry: true }) } },
      { name: "other", priority: 20, hooks: { postModelCall: () => ({ retry: false }) } },
    ]);
    const postResult = await post.run.runGate("postModelCall", {
      message: { role: "assistant", content: "hm" },
      durationMs: 4,
      iteration: 1,
      shortCircuited: false,
    });
    expect(postResult.flags.retry).toBe(true);
  });

  it("leaves flags empty when nobody raised one", async () => {
    const { run } = harness([{ name: "p", hooks: { preCompact: () => ({ skip: false }) } }]);
    const result = await run.runGate("preCompact", {
      reason: "manual",
      messages: [],
      tokenCount: 1,
      threshold: 2,
    });
    expect(result.flags).toEqual({});
  });

  it("merges metadata from every handler, later keys winning", async () => {
    const { run } = harness([
      { name: "a", priority: 10, hooks: { postToolUse: () => ({ metadata: { source: "a", shared: 1 } }) } },
      { name: "b", priority: 20, hooks: { postToolUse: () => ({ metadata: { shared: 2, extra: true } }) } },
    ]);
    const result = await run.runGate("postToolUse", {
      toolName: "echo",
      toolCallId: "call_1",
      args: {},
      output: "raw",
      durationMs: 2,
      executionId: "exec_1",
    });
    expect(result.metadata).toEqual({ source: "a", shared: 2, extra: true });
  });

  it("postToolUse rewrites the output as a waterfall", async () => {
    const { run } = harness([
      { name: "redact", priority: 10, hooks: { postToolUse: (input) => ({ output: String(input.output).replace("secret", "***") }) } },
      { name: "trim", priority: 20, hooks: { postToolUse: (input) => ({ output: String(input.output).trim() }) } },
    ]);
    const result = await run.runGate("postToolUse", {
      toolName: "echo",
      toolCallId: "call_1",
      args: {},
      output: "  the secret token  ",
      durationMs: 2,
      executionId: "exec_1",
    });
    expect(result.input.output).toBe("the *** token");
    expect(result.mutated).toBe(true);
  });

  it("subagentStart rewrites the task and can deny a delegation", async () => {
    const { run } = harness([
      { name: "rewriter", priority: 10, hooks: { subagentStart: (input) => ({ task: `${input.task} (be brief)` }) } },
      { name: "depth-guard", priority: 20, hooks: { subagentStart: (input) => (input.depth > 1 ? { decision: "deny", reason: "too deep" } : undefined) } },
    ]);
    const shallow = await run.runGate("subagentStart", { name: "researcher", task: "find facts", depth: 1 });
    expect(shallow.decision).toBe("allow");
    expect(shallow.input.task).toBe("find facts (be brief)");

    const deep = await run.runGate("subagentStart", { name: "researcher", task: "find facts", depth: 2 });
    expect(deep.decision).toBe("deny");
    expect(deep.reason).toBe("depth-guard: too deep");
  });
});

// ─── per-run stores & context ───────────────────────────────────────────────

describe("beginRun — per-plugin store and hook context", () => {
  const counter = (name: string, seen: Record<string, unknown[]>): AgentPlugin => ({
    name,
    hooks: {
      userPromptSubmit: (_input, ctx) => {
        const count = ((ctx.store.count as number) ?? 0) + 1;
        ctx.store.count = count;
        (seen[name] ??= []).push(count);
      },
    },
  });

  it("keeps a store private per plugin and shared across calls within one run", async () => {
    const seen: Record<string, unknown[]> = {};
    const { run } = harness([counter("a", seen), counter("b", seen)]);

    await run.runGate("userPromptSubmit", promptInput());
    await run.runGate("userPromptSubmit", promptInput());
    await run.runGate("userPromptSubmit", promptInput());

    // Each plugin counted its own calls; neither saw the other's counter.
    expect(seen.a).toEqual([1, 2, 3]);
    expect(seen.b).toEqual([1, 2, 3]);
  });

  it("hands two plugins different store objects", async () => {
    const stores: Record<string, Record<string, unknown>> = {};
    const { run } = harness([
      { name: "a", priority: 10, hooks: { userPromptSubmit: (_i, ctx) => { stores.a = ctx.store; ctx.store.mine = "a"; } } },
      { name: "b", priority: 20, hooks: { userPromptSubmit: (_i, ctx) => { stores.b = ctx.store; } } },
    ]);
    await run.runGate("userPromptSubmit", promptInput());
    expect(stores.a).not.toBe(stores.b);
    expect(stores.b).toEqual({});
  });

  it("gives a second beginRun fresh stores", async () => {
    const seen: Record<string, unknown[]> = {};
    const { host } = harness([counter("a", seen)]);
    const state = createMinimalState();

    const first = host.beginRun({ runId: "run-A", getState: () => state });
    await first.runGate("userPromptSubmit", promptInput());
    await first.runGate("userPromptSubmit", promptInput());

    const second = host.beginRun({ runId: "run-B", getState: () => state });
    await second.runGate("userPromptSubmit", promptInput());

    expect(seen.a).toEqual([1, 2, 1]);
  });

  it("end() releases the stores of that run", async () => {
    const seen: Record<string, unknown[]> = {};
    const { run } = harness([counter("a", seen)]);
    await run.runGate("userPromptSubmit", promptInput());
    await run.runGate("userPromptSubmit", promptInput());
    run.end();
    await run.runGate("userPromptSubmit", promptInput());
    expect(seen.a).toEqual([1, 2, 1]);
  });

  it("carries runId, agentName, hookName, depth and a signal into the hook context", async () => {
    const controller = new AbortController();
    const contexts: HookContext[] = [];
    const host = createPluginHost(
      [
        {
          name: "spy",
          hooks: {
            userPromptSubmit: (_i, ctx) => { contexts.push(ctx); },
            preToolUse: (_i, ctx) => { contexts.push(ctx); },
          },
        },
      ],
      { logger: makeLogger() },
    );
    const state = createMinimalState();
    const run = host.beginRun({
      runId: "run-xyz",
      agentName: "researcher",
      getState: () => state,
      signal: controller.signal,
      depth: 2,
    });

    await run.runGate("userPromptSubmit", promptInput());
    await run.runGate("preToolUse", toolInput());

    expect(contexts.map((ctx) => ctx.hookName)).toEqual(["userPromptSubmit", "preToolUse"]);
    for (const ctx of contexts) {
      expect(ctx.runId).toBe("run-xyz");
      expect(ctx.agentName).toBe("researcher");
      expect(ctx.depth).toBe(2);
      expect(ctx.signal).toBe(controller.signal);
      expect(ctx.logger.warn).toBeTypeOf("function");
    }
    expect(contexts[0].store).toBe(contexts[1].store);
  });

  it("defaults depth to 0 and reads the state fresh on every handler call", async () => {
    const snapshots: number[] = [];
    const state = createMinimalState("first");
    const host = createPluginHost(
      [{ name: "spy", hooks: { userPromptSubmit: (_i, ctx) => { snapshots.push(ctx.state.messages.length); } } }],
      { logger: makeLogger() },
    );
    const run = host.beginRun({ runId: "r", getState: () => state, depth: undefined });

    await run.runGate("userPromptSubmit", promptInput());
    state.messages = [...state.messages, { role: "assistant", content: "second" }];
    await run.runGate("userPromptSubmit", promptInput());

    expect(snapshots).toEqual([1, 2]);
  });

  it("prefixes plugin logs with the plugin name", async () => {
    const { run, logger } = harness([
      { name: "chatty", hooks: { userPromptSubmit: (_i, ctx) => { ctx.logger.warn("careful"); ctx.logger.error("bad"); ctx.logger.debug("noisy"); } } },
    ]);
    await run.runGate("userPromptSubmit", promptInput());
    expect(logger.warn).toHaveBeenCalledWith("[chatty]", "careful");
    expect(logger.error).toHaveBeenCalledWith("[chatty]", "bad");
    expect(logger.debug).toHaveBeenCalledWith("[chatty]", "noisy");
  });

  it("run.has() mirrors the host registry", () => {
    const { run } = harness([{ name: "p", hooks: { preToolUse: () => undefined } }]);
    expect(run.has("preToolUse")).toBe(true);
    expect(run.has("sessionStart")).toBe(false);
  });
});

// ─── setup / dispose ────────────────────────────────────────────────────────

describe("setup and dispose", () => {
  it("is idempotent: a second setup() re-runs nothing and does not duplicate contributions", async () => {
    let setups = 0;
    const host = createPluginHost(
      [{ name: "once", setup: () => { setups += 1; }, tools: [echoTool] }],
      { logger: makeLogger() },
    );
    const model = createMockModel();
    await host.setup({ model });
    await host.setup({ model });
    await host.setup({ model });

    expect(setups).toBe(1);
    expect(host.contributions.tools.map((tool) => tool.name)).toEqual(["echo"]);
  });

  it("runs setup in priority order and passes agent identity + model through", async () => {
    const order: string[] = [];
    const seen: Array<{ agentName?: string; agentVersion?: string; model: unknown }> = [];
    const model = createMockModel();
    const host = createPluginHost(
      [
        { name: "second", priority: 20, setup: (ctx) => { order.push("second"); seen.push(ctx); } },
        { name: "first", priority: 10, setup: (ctx) => { order.push("first"); seen.push(ctx); } },
      ],
      { logger: makeLogger() },
    );
    await host.setup({ model, agentName: "agent-x", agentVersion: "1.2.3" });

    expect(order).toEqual(["first", "second"]);
    expect(seen.every((ctx) => ctx.agentName === "agent-x" && ctx.agentVersion === "1.2.3")).toBe(true);
    expect(seen.every((ctx) => ctx.model === model)).toBe(true);
  });

  it("skips a fail-open plugin whose setup throws, and still loads the rest", async () => {
    const logger = makeLogger();
    const host = createPluginHost(
      [
        { name: "broken", priority: 10, setup: () => { throw new Error("cannot connect"); }, tools: [echoTool] },
        { name: "healthy", priority: 20, tools: [calculatorTool], systemPrompt: "healthy-block" },
      ],
      { logger },
    );

    await expect(host.setup({ model: createMockModel() })).resolves.toBeUndefined();
    // The broken plugin contributes nothing — not its tools, not its prompt.
    expect(host.contributions.tools.map((tool) => tool.name)).toEqual(["calculator"]);
    expect(host.contributions.applySystemPrompt("BASE")).toBe("BASE\n\nhealthy-block");
    expect(logger.warn.mock.calls.map((call) => call.join(" ")).join("\n")).toContain('plugin "broken" setup failed');
  });

  it("rejects setup when a fail-closed plugin cannot start", async () => {
    const host = createPluginHost(
      [{ name: "strict", failureMode: "closed", setup: () => { throw new Error("keyring locked"); } }],
      { logger: makeLogger() },
    );
    await expect(host.setup({ model: createMockModel() })).rejects.toThrowError(
      /Plugin "strict" failed to set up and is fail-closed: keyring locked/,
    );
  });

  it("keeps failing on later setup() calls after a fail-closed setup error", async () => {
    const host = createPluginHost(
      [{ name: "strict", failureMode: "closed", setup: () => { throw new Error("keyring locked"); }, tools: [echoTool] }],
      { logger: makeLogger() },
    );
    await expect(host.setup({ model: createMockModel() })).rejects.toThrowError(/fail-closed/);
    await expect(host.setup({ model: createMockModel() })).rejects.toThrowError(/fail-closed/);
  });

  it("runs disposers in reverse registration order and tolerates a throwing disposer", async () => {
    const order: string[] = [];
    const logger = makeLogger();
    const host = createPluginHost(
      [
        { name: "p1", priority: 10, setup: () => () => { order.push("p1:returned"); } },
        {
          name: "p2",
          priority: 20,
          setup: (ctx) => { ctx.onDispose(() => { order.push("p2:onDispose"); }); },
          dispose: () => { order.push("p2:dispose"); },
        },
        { name: "p3", priority: 30, dispose: () => { order.push("p3:dispose"); throw new Error("dispose failed"); } },
      ],
      { logger },
    );

    await host.setup({ model: createMockModel() });
    await expect(host.dispose()).resolves.toBeUndefined();

    expect(order).toEqual(["p3:dispose", "p2:dispose", "p2:onDispose", "p1:returned"]);
    expect(logger.warn.mock.calls.map((call) => call.join(" ")).join("\n")).toContain("plugin dispose failed");
  });

  it("drains the disposer list, so a second dispose() is a no-op", async () => {
    const order: string[] = [];
    const host = createPluginHost([{ name: "p", dispose: () => { order.push("p"); } }], { logger: makeLogger() });
    await host.setup({ model: createMockModel() });
    await host.dispose();
    await host.dispose();
    expect(order).toEqual(["p"]);
  });

  it("does not register the dispose of a fail-open plugin that never set up", async () => {
    const order: string[] = [];
    const host = createPluginHost(
      [{ name: "broken", setup: () => { throw new Error("nope"); }, dispose: () => { order.push("broken"); } }],
      { logger: makeLogger() },
    );
    await host.setup({ model: createMockModel() });
    await host.dispose();
    expect(order).toEqual([]);
  });
});

// ─── childPlugins / mayPauseOnToolUse ───────────────────────────────────────

describe("childPlugins and mayPauseOnToolUse", () => {
  it("childPlugins() drops inheritToSubagents: false and keeps priority order", () => {
    const host = createPluginHost([
      { name: "shared-late", priority: 30 },
      { name: "root-only", priority: 20, inheritToSubagents: false },
      { name: "shared-early", priority: 10, inheritToSubagents: true },
    ]);
    expect(host.plugins.map((p) => p.name)).toEqual(["shared-early", "root-only", "shared-late"]);
    expect(host.childPlugins().map((p) => p.name)).toEqual(["shared-early", "shared-late"]);
  });

  it("mayPauseOnToolUse() is false without any preToolUse handler", () => {
    const host = createPluginHost([{ name: "observer", hooks: { postToolUse: () => undefined } }]);
    expect(host.mayPauseOnToolUse()).toBe(false);
  });

  it("mayPauseOnToolUse() is true for a preToolUse plugin that did not opt out", () => {
    const implicit = createPluginHost([{ name: "gate", hooks: { preToolUse: () => undefined } }]);
    expect(implicit.mayPauseOnToolUse()).toBe(true);

    const explicit = createPluginHost([
      { name: "gate", mayRequireApproval: true, hooks: { preToolUse: () => undefined } },
    ]);
    expect(explicit.mayPauseOnToolUse()).toBe(true);
  });

  it("mayPauseOnToolUse() is false when every preToolUse plugin opted out", () => {
    const host = createPluginHost([
      { name: "redactor", mayRequireApproval: false, hooks: { preToolUse: () => undefined } },
      { name: "auditor", mayRequireApproval: false, hooks: { preToolUse: () => undefined } },
      // Opting out only matters for plugins that actually gate tool use.
      { name: "prompt-guard", hooks: { userPromptSubmit: () => undefined } },
    ]);
    expect(host.mayPauseOnToolUse()).toBe(false);
  });

  it("mayPauseOnToolUse() is true as soon as one of several preToolUse plugins may ask", () => {
    const host = createPluginHost([
      { name: "redactor", priority: 10, mayRequireApproval: false, hooks: { preToolUse: () => undefined } },
      { name: "approver", priority: 20, hooks: { preToolUse: () => ({ decision: "ask" as const }) } },
    ]);
    expect(host.mayPauseOnToolUse()).toBe(true);
  });

  it("the run host snapshots the same answer", () => {
    const pausing = harness([{ name: "gate", hooks: { preToolUse: () => undefined } }]);
    expect(pausing.run.mayPauseOnToolUse).toBe(true);

    const parallel = harness([
      { name: "redactor", mayRequireApproval: false, hooks: { preToolUse: () => undefined } },
    ]);
    expect(parallel.run.mayPauseOnToolUse).toBe(false);
  });
});

// ─── contributions ──────────────────────────────────────────────────────────

describe("contributions", () => {
  it("accumulates tools (sync and async factories), descriptions and guardrails in priority order", async () => {
    const sink = { type: "custom", handler: () => {} } as any;
    const guardrail = { appliesTo: [], rules: [] } as any;
    const host = createPluginHost(
      [
        { name: "static", priority: 10, tools: [echoTool] },
        { name: "async", priority: 20, tools: async () => [calculatorTool] },
        {
          name: "meta",
          priority: 30,
          toolDescriptions: { echo: "Echo, but louder." },
          guardrails: [guardrail],
        },
      ],
      { logger: makeLogger() },
    );

    await host.setup({ model: createMockModel() });
    expect(host.contributions.tools.map((tool) => tool.name)).toEqual(["echo", "calculator"]);
    expect(host.contributions.toolDescriptions.echo).toBe("Echo, but louder.");
    expect(host.contributions.guardrails).toEqual([guardrail]);
  });

  it("is an inert identity before setup() has run", () => {
    const host = createPluginHost([{ name: "p", tools: [echoTool], systemPrompt: "block" }]);
    expect(host.contributions.tools).toEqual([]);
    expect(host.contributions.applySystemPrompt("BASE")).toBe("BASE");
    const model = createMockModel();
    expect(host.contributions.applyModelWrappers(model)).toBe(model);
  });

  it("applySystemPrompt composes in priority order, honouring string and function forms", async () => {
    const order: string[] = [];
    const host = createPluginHost(
      [
        { name: "third", priority: 30, systemPrompt: "THIRD" },
        {
          name: "second",
          priority: 20,
          systemPrompt: (current) => {
            order.push("second");
            return `${current}\n\nSECOND(saw:${current.split("\n\n").pop()})`;
          },
        },
        { name: "first", priority: 10, systemPrompt: "FIRST" },
      ],
      { logger: makeLogger() },
    );

    await host.setup({ model: createMockModel() });
    const composed = host.contributions.applySystemPrompt("BASE");
    expect(order).toEqual(["second"]);
    expect(composed).toBe("BASE\n\nFIRST\n\nSECOND(saw:FIRST)\n\nTHIRD");
    // Pure function of its input — composing twice does not accumulate.
    expect(host.contributions.applySystemPrompt("BASE")).toBe(composed);
  });

  it("skips a throwing or undefined-returning systemPrompt contribution instead of dying", async () => {
    const logger = makeLogger();
    const host = createPluginHost(
      [
        { name: "boom", priority: 10, systemPrompt: () => { throw new Error("prompt builder failed"); } },
        { name: "abstains", priority: 20, systemPrompt: () => undefined as unknown as string },
        { name: "good", priority: 30, systemPrompt: "GOOD" },
      ],
      { logger },
    );

    await host.setup({ model: createMockModel() });
    expect(host.contributions.applySystemPrompt("BASE")).toBe("BASE\n\nGOOD");
    expect(logger.warn.mock.calls.map((call) => call.join(" ")).join("\n")).toContain("systemPrompt contribution failed");
  });

  it("applyModelWrappers wraps ascending, so the lowest priority number sits closest to the model", async () => {
    const order: string[] = [];
    const seenModels: unknown[] = [];
    const host = createPluginHost(
      [
        {
          name: "outer",
          priority: 50,
          wrapModel: (model, ctx) => {
            order.push("outer");
            seenModels.push(ctx.model);
            return { tag: "outer", inner: model };
          },
        },
        {
          name: "inner",
          priority: 10,
          wrapModel: (model, ctx) => {
            order.push("inner");
            seenModels.push(ctx.model);
            return { tag: "inner", inner: model };
          },
        },
      ],
      { logger: makeLogger() },
    );

    const model = createMockModel();
    await host.setup({ model });
    const wrapped = host.contributions.applyModelWrappers(model) as any;

    expect(order).toEqual(["inner", "outer"]);
    expect(wrapped.tag).toBe("outer");
    expect(wrapped.inner.tag).toBe("inner");
    expect(wrapped.inner.inner).toBe(model);
    // Each wrapper's ctx.model is what it is about to wrap, not the raw model.
    expect(seenModels[0]).toBe(model);
    expect((seenModels[1] as any).tag).toBe("inner");
  });

  it("skips a wrapModel that throws and keeps the rest of the chain", async () => {
    const logger = makeLogger();
    const host = createPluginHost(
      [
        { name: "broken", priority: 10, wrapModel: () => { throw new Error("wrap failed"); } },
        { name: "good", priority: 20, wrapModel: (model) => ({ tag: "good", inner: model }) },
      ],
      { logger },
    );

    const model = createMockModel();
    await host.setup({ model });
    const wrapped = host.contributions.applyModelWrappers(model) as any;

    expect(wrapped.tag).toBe("good");
    expect(wrapped.inner).toBe(model);
    expect(logger.warn.mock.calls.map((call) => call.join(" ")).join("\n")).toContain(
      'wrapModel from "broken" failed',
    );
  });

  it("treats a wrapModel returning undefined as 'keep the current model'", async () => {
    const host = createPluginHost([{ name: "noop", wrapModel: () => undefined }], { logger: makeLogger() });
    const model = createMockModel();
    await host.setup({ model });
    expect(host.contributions.applyModelWrappers(model)).toBe(model);
  });
});
