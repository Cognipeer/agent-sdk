/**
 * The cost estimator receives the cache WRITE tokens next to the cache read:
 * `maxCostUsd`, `budgetGuard` and `sessionMetrics` all price a ledger entry
 * through the same arguments, and `inputTokens` is the inclusive figure.
 */

import { describe, it, expect } from "vitest";
import { createAgent, createTool } from "../../src/index.js";
import { budgetGuard, sessionMetrics } from "../../src/plugins/index.js";
import { costEstimatorArgsOf } from "../../src/utils/usage.js";
import type { Message } from "../../src/types.js";
import { z } from "zod";

// What the adapter hands the loop for an Anthropic-shaped call
// (10 uncached + 90 read + 5 written), already inclusive.
const USAGE = {
  prompt_tokens: 105,
  completion_tokens: 20,
  total_tokens: 125,
  prompt_tokens_details: { cached_tokens: 90, cache_write_tokens: 5 },
  completion_tokens_details: { reasoning_tokens: 8 },
};

const noop = createTool({ name: "noop", description: "", schema: z.object({}), func: async () => "ok" });

/** Every turn but the last calls `noop`, so the loop reaches a second model call. */
function model(turns: number) {
  let index = 0;
  return {
    modelName: "cache-model",
    bindTools() {
      return this;
    },
    async invoke() {
      index += 1;
      if (index < turns) {
        return {
          role: "assistant",
          content: "",
          usage: USAGE,
          tool_calls: [{ id: `t${index}`, type: "function", function: { name: "noop", arguments: "{}" } }],
        };
      }
      return { role: "assistant", content: "done", usage: USAGE };
    },
  } as any;
}

const input = { messages: [{ role: "user", content: "go" } as Message] } as any;

describe("costEstimatorArgsOf", () => {
  it("reads inclusive input, cache read, cache write and reasoning from a ledger entry", () => {
    expect(costEstimatorArgsOf({ modelName: "m", usage: USAGE })).toEqual({
      modelName: "m",
      inputTokens: 105,
      outputTokens: 20,
      cachedInputTokens: 90,
      cacheWriteTokens: 5,
      reasoningTokens: 8,
    });
  });

  it("a ledger entry from an older SDK (no cache write) reads as 0, never NaN", () => {
    const args = costEstimatorArgsOf({ modelName: "m", usage: { prompt_tokens: 7, completion_tokens: 3 } });
    expect(args).toMatchObject({ inputTokens: 7, outputTokens: 3, cachedInputTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 });
    expect(costEstimatorArgsOf({}).inputTokens).toBe(0);
  });
});

describe("cache writes reach every cost estimator call site", () => {
  it("maxCostUsd passes cacheWriteTokens and trips on the inclusive arithmetic", async () => {
    const seen: any[] = [];
    // (input - read - write) * 0.001 + read * 0.0001 + write * 0.00125 + output * 0.002
    // = 10 * 0.001 + 90 * 0.0001 + 5 * 0.00125 + 20 * 0.002 = 0.06525
    const costEstimator = (a: any) => {
      seen.push(a);
      return (
        (a.inputTokens - a.cachedInputTokens - a.cacheWriteTokens) * 0.001 +
        a.cachedInputTokens * 0.0001 +
        a.cacheWriteTokens * 0.00125 +
        a.outputTokens * 0.002
      );
    };
    const events: any[] = [];
    const agent = createAgent({ model: model(3), tools: [noop], limits: { maxToolCalls: 10, maxCostUsd: 0.05 }, costEstimator } as any);
    await agent.invoke(input, { onEvent: (e: any) => events.push(e) });
    const breach = events.find((e) => e.type === "metadata" && e.limitBreached);
    expect(breach?.limitBreached).toContain("maxCostUsd");
    expect(breach.limitBreached).toContain("actual: $0.065");
    expect(seen[0]).toMatchObject({ inputTokens: 105, cachedInputTokens: 90, cacheWriteTokens: 5, outputTokens: 20, reasoningTokens: 8 });
  });

  it("budgetGuard passes cacheWriteTokens", async () => {
    const seen: any[] = [];
    const agent = createAgent({
      name: "guarded",
      model: model(3),
      tools: [noop],
      plugins: [budgetGuard({ maxUsd: 100, costEstimator: (a) => (seen.push(a), 0.001) })],
    } as any);
    await agent.invoke(input);
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.at(-1)).toMatchObject({ inputTokens: 105, cachedInputTokens: 90, cacheWriteTokens: 5 });
  });

  it("sessionMetrics passes cacheWriteTokens", async () => {
    const seen: any[] = [];
    const emitted: any[] = [];
    const agent = createAgent({
      name: "metrics",
      model: model(1),
      plugins: [sessionMetrics({ sink: (m) => void emitted.push(m), costEstimator: (a) => (seen.push(a), 0.5) })],
    } as any);
    await agent.invoke(input);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ modelName: "cache-model", inputTokens: 105, cachedInputTokens: 90, cacheWriteTokens: 5, reasoningTokens: 8 });
    expect(emitted[0].estimatedCostUsd).toBeCloseTo(0.5, 10);
  });
});
