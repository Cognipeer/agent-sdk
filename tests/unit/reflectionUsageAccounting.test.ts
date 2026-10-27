/**
 * A reflection is a real model call. It must be booked in the run's usage like the
 * agent's own, so `result.metadata.usage` and the budgets (`maxTotalOutputTokens`,
 * `maxCostUsd`) count it, and it must say what it is for (`purpose: 'reflection'`)
 * so a host can tell it from the agent's own calls.
 *
 *  - exactly one ledger entry per reflection call that answered, in call order;
 *  - an empty reply and a near-duplicate reply cost tokens too: they are booked
 *    although no reflection is stored;
 *  - a reflection call that throws costs nothing that is known: nothing is booked.
 */

import { describe, it, expect } from "vitest";
import { z } from "zod";
import { createAgent, createTool } from "../../src/index.js";
import { fromNativeProvider } from "../../src/providers/adapter.js";
import { createReflectionNode } from "../../src/nodes/reflect.js";
import { resolveReasoning } from "../../src/smart/reasoning.js";
import type { Message } from "../../src/types.js";

const noop = createTool({ name: "noop", description: "", schema: z.object({}), func: async () => "ok" });

function isReflectAsk(msgs: Message[]): boolean {
  const last: any = msgs[msgs.length - 1];
  if (last?.name === "agent_reflection_ask") return true;
  return /Reflect briefly/.test(typeof last?.content === "string" ? last.content : "");
}

const NOTES = [
  "The first record looks fine; next I verify the second one.",
  "The second record matches the first; I can answer the user now.",
  "Nothing is left open, so the answer can be given as it stands.",
];

// What each kind of call reports. Reflection tokens are told apart from the agent's by size.
const AGENT_USAGE = { input_tokens: 10, output_tokens: 30, total_tokens: 40 };
const REFLECT_USAGE = { input_tokens: 7, output_tokens: 50, total_tokens: 57 };

type ReflectReply = string | Error | Record<string, unknown>;

/**
 * Agent turns: noop twice, then a final answer. A reflection call is told by its ask
 * message; `reflect(call)` says what call number `call` (1-based) answers.
 */
function scriptedModel(reflect: (call: number) => ReflectReply = (call) => NOTES[(call - 1) % NOTES.length]) {
  const calls: Array<{ kind: "agent" | "reflect"; options: any }> = [];
  let agentTurn = 0;
  let reflectCall = 0;
  const model: any = {
    modelName: "m",
    bindTools() { return model; },
    async invoke(msgs: Message[], options?: any) {
      if (isReflectAsk(msgs)) {
        reflectCall += 1;
        calls.push({ kind: "reflect", options });
        const reply = reflect(reflectCall);
        if (reply instanceof Error) throw reply;
        return typeof reply === "string" ? { role: "assistant", content: reply, usage_metadata: REFLECT_USAGE } : reply;
      }
      agentTurn += 1;
      calls.push({ kind: "agent", options });
      return agentTurn <= 2
        ? { role: "assistant", content: "", usage_metadata: AGENT_USAGE, tool_calls: [{ id: `t${agentTurn}`, type: "function", function: { name: "noop", arguments: "{}" } }] }
        : { role: "assistant", content: "done", usage_metadata: AGENT_USAGE };
    },
  };
  return { model, calls };
}

/** An agent that reflects after every tool turn (`reflection: false` leaves reflection off). */
function agentWith(model: any, extra: Record<string, unknown> = {}, reflection: Record<string, unknown> | false = {}) {
  return createAgent({
    model,
    tools: [noop],
    limits: { maxToolCalls: 10 },
    ...(reflection === false ? {} : { reasoning: { enabled: true, level: "low", reflection: { cadence: "after_tool", everyNTurns: 1, maxTokens: 123, ...reflection } } }),
    ...extra,
  } as any);
}

const input = () => ({ messages: [{ role: "user", content: "go" }] }) as any;
const ledger = (result: any): any[] => result.metadata.usage?.perRequest ?? [];
const outputs = (result: any): number[] => ledger(result).map((entry) => entry.usage.completion_tokens);

describe("reflection calls say what they are for", () => {
  it("sends purpose 'reflection' with its tool choice and token cap; the agent's own calls carry none", async () => {
    const { model, calls } = scriptedModel();
    await agentWith(model).invoke(input());

    const reflect = calls.filter((call) => call.kind === "reflect");
    const agent = calls.filter((call) => call.kind === "agent");
    expect(reflect).toHaveLength(2);
    for (const call of reflect) {
      expect(call.options).toMatchObject({ purpose: "reflection", tool_choice: "none", toolChoice: "none", max_tokens: 123, maxTokens: 123 });
    }
    expect(agent).toHaveLength(3);
    for (const call of agent) expect(call.options?.purpose).toBeUndefined();
  });

  it("reaches a native provider as request.purpose, on the reflection requests only", async () => {
    const requests: any[] = [];
    let agentTurn = 0;
    const native = (outputTokens: number) => ({
      inputTokens: 10, outputTokens, totalTokens: 10 + outputTokens, cachedInputTokens: 0, cachedWriteTokens: 0, cachedOutputTokens: 0, reasoningTokens: 0,
    });
    const provider: any = {
      providerName: "openai-compatible",
      defaultModel: "fake",
      async complete(req: any) {
        requests.push(req);
        if (req.messages[req.messages.length - 1]?.name === "agent_reflection_ask") {
          const note = NOTES[requests.filter((r) => r.purpose === "reflection").length - 1];
          return { id: "r", model: "fake", content: note, toolCalls: [], usage: native(50), finishReason: "stop" };
        }
        agentTurn += 1;
        return agentTurn <= 2
          ? { id: "a", model: "fake", content: "", toolCalls: [{ id: `t${agentTurn}`, name: "noop", arguments: "{}" }], usage: native(30), finishReason: "tool_calls" }
          : { id: "a", model: "fake", content: "done", toolCalls: [], usage: native(30), finishReason: "stop" };
      },
    };
    const result = await agentWith(fromNativeProvider(provider, { model: "fake" })).invoke(input());

    const reflection = requests.filter((req) => req.purpose === "reflection");
    expect(reflection).toHaveLength(2);
    for (const req of reflection) expect(req.maxTokens).toBe(123);
    expect(requests.filter((req) => req.purpose === undefined)).toHaveLength(3);
    // ...and the ledger of the run counts all five calls, reflections in between.
    expect(outputs(result)).toEqual([30, 50, 30, 50, 30]);
    expect(ledger(result).every((entry) => entry.modelName === "fake")).toBe(true);
  });
});

describe("a reflection is booked in the run's usage", () => {
  it("adds exactly one ledger entry per reflection call, in call order", async () => {
    const { model, calls } = scriptedModel();
    const result = await agentWith(model).invoke(input());

    expect(calls.map((call) => call.kind)).toEqual(["agent", "reflect", "agent", "reflect", "agent"]);
    expect(outputs(result)).toEqual([30, 50, 30, 50, 30]);
    expect(ledger(result).map((entry) => entry.usage.prompt_tokens)).toEqual([10, 7, 10, 7, 10]);
    expect(ledger(result).every((entry) => entry.modelName === "m")).toBe(true);
    expect(ledger(result).map((entry) => entry.turn)).toEqual([1, 2, 3, 4, 5]);
    // The per-model totals are the sum of all five calls.
    expect(result.metadata.usage.totals.m).toMatchObject({ input: 10 * 3 + 7 * 2, output: 30 * 3 + 50 * 2, total: 40 * 3 + 57 * 2 });
    // The state the run returns carries the same ledger.
    expect(result.state?.usage?.perRequest).toHaveLength(5);
  });

  it("books nothing for reflection when it is off", async () => {
    const { model, calls } = scriptedModel();
    const result = await agentWith(model, {}, false).invoke(input());

    expect(calls.every((call) => call.kind === "agent")).toBe(true);
    expect(outputs(result)).toEqual([30, 30, 30]);
  });

  it("books the tokens of an empty reply: no reflection is stored, the call still cost", async () => {
    const reflections: any[] = [];
    const { model } = scriptedModel((call) => (call === 1 ? "   " : NOTES[1]));
    const result = await agentWith(model).invoke(input(), { onEvent: (e: any) => { if (e.type === "reflection") reflections.push(e); } });

    expect(reflections).toHaveLength(1);
    expect(reflections[0].text).toBe(NOTES[1]);
    expect(outputs(result)).toEqual([30, 50, 30, 50, 30]);
  });

  it("books the tokens of a near-duplicate reply: it is dropped, the call still cost", async () => {
    const reflections: any[] = [];
    const { model } = scriptedModel(() => NOTES[0]);
    const result = await agentWith(model).invoke(input(), { onEvent: (e: any) => { if (e.type === "reflection") reflections.push(e); } });

    expect(reflections).toHaveLength(1);
    expect(outputs(result)).toEqual([30, 50, 30, 50, 30]);
  });

  it("books nothing for a reflection call that throws, and the run goes on", async () => {
    const { model } = scriptedModel((call) => (call === 1 ? new Error("reflection model down") : NOTES[1]));
    const result = await agentWith(model).invoke(input());

    expect(result.content).toBe("done");
    // agent1, (reflect1 failed), agent2, reflect2, agent3
    expect(outputs(result)).toEqual([30, 30, 50, 30]);
  });

  it("books nothing when the reply reports no usage, and still stores the reflection", async () => {
    const reflections: any[] = [];
    const { model } = scriptedModel((call) => ({ role: "assistant", content: NOTES[call - 1] }));
    const result = await agentWith(model).invoke(input(), { onEvent: (e: any) => { if (e.type === "reflection") reflections.push(e); } });

    expect(reflections).toHaveLength(2);
    expect(outputs(result)).toEqual([30, 30, 30]);
  });

  it("books once per call: what the reflection event reports is what the ledger holds", async () => {
    const reflections: any[] = [];
    const { model } = scriptedModel();
    const result = await agentWith(model).invoke(input(), { onEvent: (e: any) => { if (e.type === "reflection") reflections.push(e); } });

    expect(reflections.map((event) => event.usage)).toEqual([
      expect.objectContaining({ inputTokens: 7, outputTokens: 50, totalTokens: 57 }),
      expect.objectContaining({ inputTokens: 7, outputTokens: 50, totalTokens: 57 }),
    ]);
    expect(ledger(result).filter((entry) => entry.usage.completion_tokens === 50)).toHaveLength(2);
  });
});

describe("a reflection counts against the budgets", () => {
  // Agent calls: 30 output tokens (priced $0.03), reflection calls: 50 ($0.05). The agent alone
  // is under each cap below after two calls; the first reflection is what puts it over.
  const breachOf = (events: any[]) => events.find((e) => e.type === "metadata" && e.limitBreached)?.limitBreached as string | undefined;

  it("maxTotalOutputTokens trips on the reflection's tokens", async () => {
    const limits = { maxToolCalls: 10, maxTotalOutputTokens: 70 };

    // Control: without reflection, two agent calls (60) stay under the cap of 70.
    const controlEvents: any[] = [];
    const control = scriptedModel();
    await agentWith(control.model, { limits }, false).invoke(input(), { onEvent: (e: any) => controlEvents.push(e) });
    expect(breachOf(controlEvents)).toBeUndefined();
    expect(control.calls.filter((call) => call.kind === "agent")).toHaveLength(3);

    // With reflection: agent call 1 (30) + reflection 1 (50) is over, so the loop stops before the second one.
    const events: any[] = [];
    const reflecting = scriptedModel();
    await agentWith(reflecting.model, { limits }).invoke(input(), { onEvent: (e: any) => events.push(e) });
    expect(breachOf(events)).toContain("maxTotalOutputTokens (70) exceeded");
    expect(reflecting.calls.filter((call) => call.kind === "agent")).toHaveLength(1);
    expect(reflecting.calls.filter((call) => call.kind === "reflect")).toHaveLength(1);
  });

  it("maxCostUsd trips on the reflection's cost, priced by the estimator with the reflection's own tokens", async () => {
    const seen: any[] = [];
    const costEstimator = (args: any) => (seen.push(args), args.outputTokens * 0.001);
    const limits = { maxToolCalls: 10, maxCostUsd: 0.07 };

    // Control: two agent calls cost $0.06, under the cap of $0.07.
    const controlEvents: any[] = [];
    await agentWith(scriptedModel().model, { limits, costEstimator }, false).invoke(input(), { onEvent: (e: any) => controlEvents.push(e) });
    expect(breachOf(controlEvents)).toBeUndefined();

    // With reflection: $0.03 + $0.05 = $0.08 is over it.
    seen.length = 0;
    const events: any[] = [];
    await agentWith(scriptedModel().model, { limits, costEstimator }).invoke(input(), { onEvent: (e: any) => events.push(e) });
    expect(breachOf(events)).toContain("maxCostUsd ($0.07) exceeded (actual: $0.08");
    expect(seen.map((args) => args.outputTokens)).toEqual([30, 50]);
    expect(seen.every((args) => args.modelName === "m")).toBe(true);
  });
});

describe("the reflection node on its own", () => {
  const REPLY_SHAPES: Array<[string, Record<string, unknown>]> = [
    ["usage_metadata (LangChain)", { usage_metadata: { input_tokens: 7, output_tokens: 3, total_tokens: 10 } }],
    ["usage (a native adapter's message)", { usage: { prompt_tokens: 7, completion_tokens: 3, total_tokens: 10 } }],
    ["response_metadata.token_usage", { response_metadata: { token_usage: { prompt_tokens: 7, completion_tokens: 3, total_tokens: 10 } } }],
    ["response_metadata.usage", { response_metadata: { usage: { input_tokens: 7, output_tokens: 3 } } }],
  ];

  const resolved = (reflection: Record<string, unknown> = {}) =>
    resolveReasoning({ enabled: true, level: "low", reflection: { cadence: "after_tool", maxTokens: 123, ...reflection } } as any)!.reflection;

  const messages = () => [
    { role: "user", content: "go" },
    { role: "assistant", content: "", tool_calls: [{ id: "t1", type: "function", function: { name: "noop", arguments: "{}" } }] },
    { role: "tool", tool_call_id: "t1", name: "noop", content: "ok" },
  ];

  /** A model answering `reply` to every call, recording the options. `null` names it nothing. */
  function modelAnswering(reply: Record<string, unknown> | (() => never), modelName: string | null = "reflector") {
    const options: any[] = [];
    const model: any = {
      ...(modelName ? { modelName } : {}),
      async invoke(_messages: any[], opts?: any) {
        options.push(opts);
        if (typeof reply === "function") return reply();
        return { role: "assistant", content: NOTES[0], ...reply };
      },
    };
    return { model, options };
  }

  const stateOf = (extra: Record<string, unknown> = {}): any => ({
    messages: messages(),
    toolCallCount: 1,
    usage: { perRequest: [], totals: {} },
    ctx: {},
    ...extra,
  });

  it.each(REPLY_SHAPES)("books the usage a reply reports as %s, once", async (_label, shape) => {
    const { model } = modelAnswering(shape);
    const state = stateOf();
    const patch = await createReflectionNode({ name: "agent", model } as any, resolved())(state, "after_tool");

    expect(state.usage.perRequest).toHaveLength(1);
    expect(state.usage.perRequest[0]).toMatchObject({ modelName: "reflector", usage: { prompt_tokens: 7, completion_tokens: 3, total_tokens: 10 } });
    expect(state.usage.totals.reflector).toMatchObject({ input: 7, output: 3, total: 10 });
    // The stored reflection says the same thing.
    expect(patch.reflections?.[0].usage).toMatchObject({ inputTokens: 7, outputTokens: 3, totalTokens: 10 });
  });

  it("creates the ledger when the state has none yet", async () => {
    const { model } = modelAnswering({ usage_metadata: { input_tokens: 7, output_tokens: 3, total_tokens: 10 } });
    const state = stateOf({ usage: undefined });
    await createReflectionNode({ name: "agent", model } as any, resolved())(state, "after_tool");

    expect(state.usage.perRequest).toHaveLength(1);
    expect(state.usage.totals.reflector.output).toBe(3);
  });

  it("books under 'unknown_model' when the model names none", async () => {
    const { model } = modelAnswering({ usage_metadata: { input_tokens: 7, output_tokens: 3, total_tokens: 10 } }, null);
    const state = stateOf();
    await createReflectionNode({ name: "agent", model } as any, resolved())(state, "after_tool");

    expect(state.usage.perRequest[0].modelName).toBe("unknown_model");
  });

  it("books one entry for every call, two calls two entries", async () => {
    const { model } = modelAnswering({ usage_metadata: { input_tokens: 7, output_tokens: 3, total_tokens: 10 } });
    const node = createReflectionNode({ name: "agent", model } as any, resolved());
    // The patch of the first call is not merged into the state, so the second is no repeat.
    const state = stateOf();
    await node(state, "after_tool");
    await node(state, "after_tool");

    expect(state.usage.perRequest).toHaveLength(2);
    expect(state.usage.perRequest.map((entry: any) => entry.turn)).toEqual([1, 2]);
    expect(state.usage.totals.reflector).toMatchObject({ input: 14, output: 6, total: 20 });
  });

  it("books an empty reply and a repeat of the last note, and stores neither", async () => {
    const usage_metadata = { input_tokens: 7, output_tokens: 3, total_tokens: 10 };

    const empty = modelAnswering({ content: "", usage_metadata });
    const emptyState = stateOf();
    expect(await createReflectionNode({ name: "agent", model: empty.model } as any, resolved())(emptyState, "after_tool")).toEqual({});
    expect(emptyState.usage.perRequest).toHaveLength(1);

    const repeat = modelAnswering({ content: NOTES[0], usage_metadata });
    const repeatState = stateOf({ reflections: [{ id: "r0", turn: 0, text: NOTES[0], createdAt: "2026-01-01T00:00:00.000Z" }] });
    expect(await createReflectionNode({ name: "agent", model: repeat.model } as any, resolved())(repeatState, "after_tool")).toEqual({});
    expect(repeatState.usage.perRequest).toHaveLength(1);
  });

  it("books nothing when the call throws, and when the reply reports no usage", async () => {
    const failing = modelAnswering(() => { throw new Error("down"); });
    const failingState = stateOf();
    expect(await createReflectionNode({ name: "agent", model: failing.model } as any, resolved())(failingState, "after_tool")).toEqual({});
    expect(failingState.usage.perRequest).toHaveLength(0);

    const silent = modelAnswering({});
    const silentState = stateOf();
    const patch = await createReflectionNode({ name: "agent", model: silent.model } as any, resolved())(silentState, "after_tool");
    expect(patch.reflections).toHaveLength(1);
    expect(silentState.usage.perRequest).toHaveLength(0);
  });

  it.each(["piggyback", "separate"])("tells the %s call apart from the agent's with purpose 'reflection'", async (mode) => {
    const { model, options } = modelAnswering({ usage_metadata: { input_tokens: 7, output_tokens: 3, total_tokens: 10 } });
    await createReflectionNode({ name: "agent", model } as any, resolved({ mode }))(stateOf(), "after_tool");

    expect(options).toHaveLength(1);
    expect(options[0]).toMatchObject({ purpose: "reflection", tool_choice: "none", max_tokens: 123, maxTokens: 123 });
  });
});
