/**
 * Plugins across REAL multi-tool flows.
 *
 * `plugins.integration.test.ts` proves a hook's verdict survives contact with a
 * real model on a single tool call. This file is about what happens when there
 * is more than one call in flight: the scheduling guard that decides whether a
 * batch fans out or serializes, a denial landing in the middle of a batch, a
 * per-run execution ceiling, a rejected approval that must stay rejected across
 * the resume boundary, and a policy a delegation must not be able to shed.
 *
 *   OPENAI_API_KEY=sk-… npx vitest run tests/integration/pluginsToolFlows.integration.test.ts
 *
 * Any OpenAI-compatible endpoint works — a gateway, a proxy, or a local server:
 *
 *   OPENAI_BASE_URL=http://localhost:11434/v1 \
 *   PLUGIN_TEST_MODEL=qwen2.5 OPENAI_API_KEY=ignored npx vitest run …
 *
 * Skipped entirely without a key. A real model picks its own tool calls, so
 * every assertion here is about what the RUNTIME did — which function ran, how
 * many `role: "tool"` messages were appended, whether two executions overlapped
 * in wall-clock time — never about how the model worded its answer.
 */

import { describe, it, expect, vi } from "vitest";
import { z } from "zod";
import { createAgent, createSmartAgent, createTool } from "../../src/index.js";
import { createProvider, fromNativeProvider } from "../../src/providers/index.js";
import { defineHook } from "../../src/plugins/define.js";
import { auditLog } from "../../src/plugins/builtin/auditLog.js";
import { responseCache } from "../../src/plugins/builtin/responseCache.js";
import { toolPolicy } from "../../src/plugins/builtin/toolPolicy.js";
import type { AgentPlugin } from "../../src/plugins/types.js";
import type { BaseChatModel } from "../../src/model.js";
import type { Message, SmartState, ToolInterface } from "../../src/types.js";
import type { SubagentDef } from "../../src/smart/subagents/types.js";

const API_KEY = process.env.OPENAI_API_KEY;
const runReal = API_KEY ? describe : describe.skip;
const MODEL = process.env.PLUGIN_TEST_MODEL ?? "gpt-4o-mini";

const BASE_URL = process.env.OPENAI_BASE_URL;

function realModel(): BaseChatModel {
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

// ─── Shared helpers ──────────────────────────────────────────────────────────

/** `Message.tool_calls` is `any` in the SDK's type surface; narrow it locally. */
type ToolCallRef = { id: string; type?: string; function?: { name?: string; arguments?: string } };

const toolCallsOf = (message: Message): ToolCallRef[] =>
  Array.isArray(message.tool_calls) ? (message.tool_calls as ToolCallRef[]) : [];

const toolMessages = (messages: Message[]): Message[] => messages.filter((m) => m.role === "tool");

const historyOf = (state: SmartState | undefined) => state?.toolHistory ?? [];

/**
 * Every `tool_call` the assistant emitted must be answered by exactly one
 * `role: "tool"` message. A denial that skipped the pairing would leave a
 * dangling tool_use and the NEXT provider call is what would reject it — long
 * after the plugin that caused it is out of the picture.
 */
function expectValidToolPairing(messages: Message[]): void {
  const requested = messages
    .filter((m) => m.role === "assistant")
    .flatMap((m) => toolCallsOf(m))
    .map((call) => call.id);
  const answered = toolMessages(messages).map((m) => String(m.tool_call_id));

  expect(new Set(answered).size).toBe(answered.length);
  expect([...answered].sort()).toEqual([...requested].sort());
}

/** Wall-clock window of one tool execution, recorded inside the tool function. */
type Interval = { label: string; start: number; end: number };

/**
 * Peak simultaneous executions. Ends are processed before starts at an equal
 * timestamp, so back-to-back serial calls never read as an overlap.
 */
function peakConcurrency(intervals: Interval[]): number {
  const events = intervals.flatMap((i) => [
    { at: i.start, delta: 1 },
    { at: i.end, delta: -1 },
  ]);
  events.sort((a, b) => a.at - b.at || a.delta - b.delta);
  let current = 0;
  let peak = 0;
  for (const event of events) {
    current += event.delta;
    peak = Math.max(peak, current);
  }
  return peak;
}

/** Largest number of tool calls the model packed into a single assistant turn. */
function widestToolBatch(messages: Message[]): number {
  return messages
    .filter((m) => m.role === "assistant")
    .reduce((widest, m) => Math.max(widest, toolCallsOf(m).length), 0);
}

/**
 * Counts provider calls, and keeps counting through `bindTools` — the adapter's
 * `bindTools` returns a brand-new model object, so a wrapper that forgot to
 * re-wrap the bound instance would observe zero calls and "prove" a cache hit
 * that never happened.
 */
function countingModel(inner: BaseChatModel, counter: { calls: number }): BaseChatModel {
  const wrapped: BaseChatModel = {
    ...inner,
    invoke: (messages, options) => {
      counter.calls += 1;
      return inner.invoke(messages, options);
    },
  };
  if (typeof inner.bindTools === "function") {
    wrapped.bindTools = (tools, options) => countingModel(inner.bindTools!(tools, options), counter);
  }
  return wrapped;
}

// ─── 1. Two different tools, in sequence, with an attempt log ────────────────

runReal("a multi-step flow with two different tools", () => {
  it("logs every preToolUse attempt in exactly the order the runtime executed them", async () => {
    const attempts: Array<{ toolName: string; toolCallId: string }> = [];

    const resolveCode = vi.fn(async ({ city }: { city: string }) => ({
      city,
      code: `CTY-${city.trim().slice(0, 3).toUpperCase()}`,
    }));
    const fetchPopulation = vi.fn(async ({ code }: { code: string }) => ({
      code,
      population: code === "CTY-OSA" ? 2_691_000 : 0,
    }));

    const agent = createSmartAgent({
      name: "TwoToolAgent",
      model: realModel(),
      tools: [
        createTool({
          name: "resolve_city_code",
          description: "Resolve a city name to the internal city code required by fetch_population.",
          schema: z.object({ city: z.string().describe("City name") }),
          func: resolveCode,
        }),
        createTool({
          name: "fetch_population",
          description:
            "Return the population for an internal city code. The code MUST come from resolve_city_code; a raw city name is not accepted.",
          schema: z.object({ code: z.string().describe("Internal city code from resolve_city_code") }),
          func: fetchPopulation,
        }),
      ],
      limits: { maxToolCalls: 4 },
      summarization: false,
      plugins: [
        defineHook(
          "preToolUse",
          ({ toolName, toolCallId }) => {
            attempts.push({ toolName, toolCallId });
            return undefined;
          },
          { name: "attempt-log", priority: 0 },
        ),
      ],
    });

    const result = await agent.invoke({
      messages: [
        {
          role: "user",
          content:
            "What is the population of Osaka? Use resolve_city_code first to get the internal code, then call fetch_population with that exact code, then tell me the number.",
        },
      ],
    });

    // Premise: the model really did drive both tools.
    const names = attempts.map((a) => a.toolName);
    expect(names).toContain("resolve_city_code");
    expect(names).toContain("fetch_population");
    expect(names.indexOf("resolve_city_code")).toBeLessThan(names.indexOf("fetch_population"));

    // The claim: the attempt log IS the execution log — same calls, same order.
    // A hook that saw calls the executor never ran (or ran in another order)
    // would make every audit trail built on `preToolUse` fiction.
    const executed = historyOf(result.state).map((entry) => ({
      toolName: entry.toolName,
      toolCallId: String(entry.tool_call_id),
    }));
    expect(attempts).toEqual(executed);

    expect(resolveCode.mock.calls.length).toBeGreaterThanOrEqual(1);
    expect(fetchPopulation.mock.calls.length).toBeGreaterThanOrEqual(1);
    expectValidToolPairing(result.messages);
    expect(result.content.length).toBeGreaterThan(0);
  }, 120_000);
});

// ─── 2. The parallel-scheduling guard ────────────────────────────────────────

/**
 * `src/nodes/tools.ts` splits a tool batch in two: calls that might pause for a
 * human run sequentially, everything else fans out to `maxParallelTools`. The
 * decision is made from `host.mayPauseOnToolUse`, which is true for ANY plugin
 * registering `preToolUse` unless it declares `mayRequireApproval: false`.
 *
 * That flag is therefore a scheduling contract with a visible cost: get it
 * wrong on an audit hook and every tool batch in the system silently becomes
 * serial. These three runs pin all three states of it.
 */
runReal("parallel tool execution and the preToolUse scheduling guard", () => {
  const POPULATION: Record<string, number> = { tokyo: 37_000_000, paris: 11_200_000, cairo: 22_100_000 };

  function lookupTool(intervals: Interval[]): { tool: ToolInterface; func: ReturnType<typeof vi.fn> } {
    // Long enough that genuine overlap is unmistakable, short enough that three
    // serial calls still finish well inside the test timeout.
    const func = vi.fn(async ({ city }: { city: string }) => {
      const start = Date.now();
      await new Promise((resolve) => setTimeout(resolve, 400));
      intervals.push({ label: city.toLowerCase(), start, end: Date.now() });
      return { city, metroPopulation: POPULATION[city.trim().toLowerCase()] ?? null };
    });
    return {
      tool: createTool({
        name: "metro_population",
        description: "Return the metro-area population of one city. Independent per city.",
        schema: z.object({ city: z.string().describe("City name") }),
        func,
      }),
      func,
    };
  }

  async function runThreeLookups(plugins: AgentPlugin[]) {
    const intervals: Interval[] = [];
    const { tool, func } = lookupTool(intervals);
    const agent = createSmartAgent({
      name: "ParallelLookupAgent",
      model: realModel(),
      tools: [tool],
      limits: { maxToolCalls: 4, maxParallelTools: 4 },
      summarization: false,
      plugins,
    });

    const result = await agent.invoke({
      messages: [
        {
          role: "user",
          content:
            "Look up the metro population of Tokyo, Paris and Cairo. These are independent lookups — issue all three metro_population tool calls together in one turn, then report the three numbers.",
        },
      ],
    });

    return { result, intervals, func };
  }

  it("fans the batch out with no preToolUse plugin installed", async () => {
    const { result, intervals } = await runThreeLookups([]);

    // Premise: the model actually batched. Without a batch there is nothing to
    // schedule and an overlap assertion would be vacuous.
    expect(widestToolBatch(result.messages)).toBeGreaterThanOrEqual(2);
    expect(intervals.length).toBeGreaterThanOrEqual(2);
    expect(peakConcurrency(intervals)).toBeGreaterThan(1);
    expectValidToolPairing(result.messages);
  }, 120_000);

  it("STILL fans the batch out with auditLog() installed, because it declares mayRequireApproval: false", async () => {
    const entries: string[] = [];
    const { result, intervals } = await runThreeLookups([
      auditLog({ sink: (entry) => void entries.push(`${entry.kind}:${entry.toolName ?? ""}`) }),
    ]);

    // The audit hook really ran on every attempt — this is not a case of the
    // plugin quietly not being wired up.
    expect(entries.filter((e) => e.startsWith("tool_attempt:")).length).toBe(intervals.length);

    expect(widestToolBatch(result.messages)).toBeGreaterThanOrEqual(2);
    expect(peakConcurrency(intervals)).toBeGreaterThan(1);
    expectValidToolPairing(result.messages);
  }, 120_000);

  it("serializes the whole batch for a preToolUse plugin that does NOT declare the flag", async () => {
    const seen: string[] = [];
    // Identical observational behaviour to auditLog above; the ONLY difference
    // is the missing declaration. Anything that can return `ask` has to run in
    // the sequential group, because by the time a pause is raised inside a
    // fan-out its siblings have already run.
    const mayPause: AgentPlugin = {
      name: "unflagged-observer",
      priority: 0,
      hooks: {
        preToolUse: ({ toolName }) => {
          seen.push(toolName);
          return undefined;
        },
      },
    };

    const { result, intervals } = await runThreeLookups([mayPause]);

    expect(seen.length).toBe(intervals.length);
    expect(widestToolBatch(result.messages)).toBeGreaterThanOrEqual(2);
    expect(intervals.length).toBeGreaterThanOrEqual(2);
    expect(peakConcurrency(intervals)).toBe(1);
    expectValidToolPairing(result.messages);
  }, 120_000);
});

// ─── 3. One denial inside a batch ────────────────────────────────────────────

runReal("a denial in the middle of a multi-tool batch", () => {
  it("blocks exactly one call, runs the rest, and leaves the transcript pairable", async () => {
    const alpha = vi.fn(async () => ({ region: "alpha", status: "green" }));
    const beta = vi.fn(async () => ({ region: "beta", status: "green" }));
    const gamma = vi.fn(async () => ({ region: "gamma", status: "green" }));

    const statusTool = (name: string, func: () => Promise<unknown>) =>
      createTool({
        name,
        description: `Return the health status of the ${name.replace("check_", "")} region.`,
        schema: z.object({}),
        func,
      });

    const agent = createSmartAgent({
      name: "BatchDenialAgent",
      model: realModel(),
      tools: [statusTool("check_alpha", alpha), statusTool("check_beta", beta), statusTool("check_gamma", gamma)],
      limits: { maxToolCalls: 5, maxParallelTools: 4 },
      summarization: false,
      plugins: [
        toolPolicy({
          rules: [
            {
              tool: "check_beta",
              action: "deny",
              reason:
                "The beta region probe is permanently disabled in this environment. Do not retry it; report beta as unavailable.",
            },
          ],
        }),
      ],
    });

    const result = await agent.invoke({
      messages: [
        {
          role: "user",
          content:
            "Check the health of all three regions (alpha, beta, gamma) with the tools, then summarise which regions are green and which you could not check.",
        },
      ],
    });

    expect(beta).not.toHaveBeenCalled();
    expect(alpha).toHaveBeenCalledTimes(1);
    expect(gamma).toHaveBeenCalledTimes(1);

    const history = historyOf(result.state);
    const rejected = history.filter((entry) => entry.status === "rejected");
    expect(rejected).toHaveLength(1);
    expect(rejected[0].toolName).toBe("check_beta");

    const succeeded = history.filter((entry) => entry.status === "success").map((entry) => entry.toolName);
    expect(succeeded.sort()).toEqual(["check_alpha", "check_gamma"]);

    // A deny must resolve its tool_use exactly like a normal result, or the
    // next provider call sees a dangling tool_call.
    expectValidToolPairing(result.messages);
    const denialMessage = toolMessages(result.messages).find((m) => m.name === "check_beta");
    expect(String(denialMessage?.content)).toContain("permanently disabled");

    expect(result.content.length).toBeGreaterThan(0);
  }, 120_000);
});

// ─── 4. An approval the human REFUSES ────────────────────────────────────────

runReal("a rejected tool approval", () => {
  it("never executes the tool, not even on the resumed leg, and the run still answers", async () => {
    const func = vi.fn(async ({ target }: { target: string }) => ({ target, deployed: true }));
    const agent = createAgent({
      name: "RejectedApprovalAgent",
      model: realModel(),
      tools: [
        createTool({
          name: "deploy_service",
          description: "Deploy the service to an environment.",
          schema: z.object({ target: z.string().describe("Environment name") }),
          func,
        }),
      ],
      limits: { maxToolCalls: 3 },
      plugins: [
        defineHook(
          "preToolUse",
          ({ toolName }) =>
            toolName === "deploy_service" ? { decision: "ask", approvalPrompt: "Deploy to production?" } : undefined,
          { name: "ask-before-deploy" },
        ),
      ],
    });

    const paused = await agent.invoke({
      messages: [{ role: "user", content: "Deploy the service to production using your tool, then confirm." }],
    });

    const pending = paused.state?.pendingApprovals ?? [];
    expect(pending).toHaveLength(1);
    expect(pending[0].toolName).toBe("deploy_service");
    expect(func).not.toHaveBeenCalled();

    const rejectedState = agent.resolveToolApproval(paused.state!, {
      id: pending[0].id,
      approved: false,
      comment: "The reviewer refused this deployment. Do not attempt it again; explain that it was not approved.",
    });
    const finished = await agent.invoke(rejectedState);

    // The whole point of a rejection: the side effect never happens, on either
    // leg. The hook still says "ask" on resume, so only the ledger entry keeps
    // the gate closed.
    expect(func).not.toHaveBeenCalled();

    // Retry-tolerant, and still absolute: whatever the model tried on the
    // resumed leg, not one attempt got through.
    const history = historyOf(finished.state);
    expect(history.length).toBeGreaterThanOrEqual(1);
    expect(history.every((entry) => entry.status === "rejected")).toBe(true);

    expectValidToolPairing(finished.messages);
    expect(finished.content.length).toBeGreaterThan(0);
  }, 120_000);
});

// ─── 5. A per-run execution ceiling ──────────────────────────────────────────

runReal("toolPolicy maxExecutionsPerTool against a model that wants three calls", () => {
  it("executes the tool once and hands every later attempt back as a readable denial", async () => {
    const func = vi.fn(async ({ label }: { label: string }) => ({ label, value: 42 }));

    const agent = createSmartAgent({
      name: "CeilingAgent",
      model: realModel(),
      tools: [
        createTool({
          name: "sample_metric",
          description: "Take one sample of the metric under the given label.",
          schema: z.object({ label: z.string().describe("Sample label") }),
          func,
        }),
      ],
      limits: { maxToolCalls: 6, maxParallelTools: 4 },
      summarization: false,
      plugins: [toolPolicy({ maxExecutionsPerTool: 1 })],
    });

    const result = await agent.invoke({
      messages: [
        {
          role: "user",
          content:
            "Take three samples of the metric using sample_metric with the labels 'first', 'second' and 'third', then report what you managed to collect.",
        },
      ],
    });

    expect(func).toHaveBeenCalledTimes(1);

    const history = historyOf(result.state);
    expect(history.filter((entry) => entry.status === "success")).toHaveLength(1);
    const rejected = history.filter((entry) => entry.status === "rejected");
    expect(rejected.length).toBeGreaterThanOrEqual(1);
    expect(rejected.every((entry) => entry.toolName === "sample_metric")).toBe(true);

    // The ceiling has to arrive as a tool result the model can act on, not as a
    // thrown error — that is the difference between a bounded run and a broken
    // transcript.
    const denials = toolMessages(result.messages).filter((m) =>
      String(m.content).includes("Per-run execution limit reached"),
    );
    expect(denials.length).toBe(rejected.length);

    expectValidToolPairing(result.messages);
    expect(result.content.length).toBeGreaterThan(0);
  }, 120_000);
});

// ─── 6. Plugin inheritance across a real delegation ──────────────────────────

runReal("plugin inheritance into a real sub-agent", () => {
  const CHILD_PROMPT =
    "You read entries from the vault. ALWAYS call the read_vault tool with the requested entry id before answering. Then report what you got back, including any refusal.";

  function buildParent(inheritToSubagents: boolean) {
    const childFunc = vi.fn(async ({ entry }: { entry: string }) => ({ entry, secret: "swordfish" }));
    const child: SubagentDef = {
      name: "vault_reader",
      header: "Reads an entry out of the secret vault. Use it for any vault lookup.",
      systemPrompt: CHILD_PROMPT,
      model: realModel(),
      tools: [
        createTool({
          name: "read_vault",
          description: "Read one entry from the secret vault.",
          schema: z.object({ entry: z.string().describe("Vault entry id") }),
          func: childFunc,
        }),
      ],
    };

    const denyVault: AgentPlugin = {
      name: "no-vault-reads",
      // Named explicitly so the delegation tool itself is never caught by it.
      hooks: {
        preToolUse: ({ toolName }) =>
          toolName === "read_vault"
            ? { decision: "deny" as const, reason: "Vault reads are blocked by the parent's policy." }
            : undefined,
      },
      inheritToSubagents,
    };

    const parent = createSmartAgent({
      name: "VaultParent",
      model: realModel(),
      subagents: [child],
      limits: { maxToolCalls: 3 },
      summarization: false,
      plugins: [denyVault],
    });

    return { parent, childFunc };
  }

  const DELEGATE_PROMPT =
    "Use delegate_to with the sub-agent 'vault_reader' to read the vault entry 'alpha', then tell me what came back.";

  it("blocks the CHILD's tool from a plugin installed on the parent", async () => {
    const { parent, childFunc } = buildParent(true);

    const result = await parent.invoke({ messages: [{ role: "user", content: DELEGATE_PROMPT }] });

    // A policy a delegation can shed is not a policy.
    expect(childFunc).not.toHaveBeenCalled();

    const delegation = toolMessages(result.messages).find((m) => m.name === "delegate_to");
    expect(delegation).toBeDefined();
    expectValidToolPairing(result.messages);
    expect(result.content.length).toBeGreaterThan(0);
  }, 120_000);

  it("lets the child's tool run when the plugin opts out with inheritToSubagents: false", async () => {
    const { parent, childFunc } = buildParent(false);

    const result = await parent.invoke({ messages: [{ role: "user", content: DELEGATE_PROMPT }] });

    expect(childFunc.mock.calls.length).toBeGreaterThanOrEqual(1);

    const delegation = toolMessages(result.messages).find((m) => m.name === "delegate_to");
    expect(delegation).toBeDefined();
    expectValidToolPairing(result.messages);
    expect(result.content.length).toBeGreaterThan(0);
  }, 120_000);
});

// ─── 7. responseCache across two runs of one agent ───────────────────────────

runReal("responseCache on an agent-scoped cache", () => {
  it("serves the second identical run without touching the provider, and bills nothing for it", async () => {
    const counter = { calls: 0 };
    const agent = createAgent({
      name: "CachedAgent",
      model: countingModel(realModel(), counter),
      plugins: [responseCache({ scope: "agent" })],
    });

    const prompt: Message[] = [{ role: "user", content: "Name the capital city of France in one short sentence." }];

    const first = await agent.invoke({ messages: prompt });
    expect(counter.calls).toBe(1);
    expect(first.content.length).toBeGreaterThan(0);
    expect((first.state?.usage?.perRequest ?? []).length).toBe(1);

    const second = await agent.invoke({ messages: prompt });

    // No provider call at all on the second run.
    expect(counter.calls).toBe(1);
    expect(second.content).toBe(first.content);

    // A replayed answer costs nothing, so it must not be billed — leaving the
    // original call's token counts on the cached message would charge the run
    // for traffic that never left the process.
    expect(second.state?.usage?.perRequest ?? []).toHaveLength(0);
    expect(Object.keys(second.state?.usage?.totals ?? {})).toHaveLength(0);
  }, 120_000);
});
