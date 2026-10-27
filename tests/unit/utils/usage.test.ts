import { describe, it, expect } from "vitest";
import { appendUsageEntries, normalizeUsage, recordUsage, splitUsage, totalUsage } from "../../../src/utils/usage.js";
import type { SmartState } from "../../../src/types.js";

const ANTHROPIC_SHAPED = {
  prompt_tokens: 105,
  completion_tokens: 20,
  total_tokens: 125,
  prompt_tokens_details: { cached_tokens: 90, cache_write_tokens: 5 },
};

describe("normalizeUsage cache writes", () => {
  it("reads the cache write from every spelling the SDK knows", () => {
    expect(normalizeUsage(ANTHROPIC_SHAPED)!.prompt_tokens_details).toMatchObject({ cached_tokens: 90, cache_write_tokens: 5 });
    expect(normalizeUsage({ input_tokens: 10, output_tokens: 1, cache_creation_input_tokens: 7 })!.prompt_tokens_details.cache_write_tokens).toBe(7);
    expect(normalizeUsage({ inputTokens: 10, outputTokens: 1, cacheWriteInputTokens: 3 })!.prompt_tokens_details.cache_write_tokens).toBe(3);
  });

  it("is 0 when not reported", () => {
    expect(normalizeUsage({ prompt_tokens: 10, completion_tokens: 1 })!.prompt_tokens_details.cache_write_tokens).toBe(0);
  });
});

function entry(modelName: string, usage: any, extra: Record<string, unknown> = {}) {
  const n = normalizeUsage(usage)!;
  return {
    id: `id_${Math.random()}`,
    modelName,
    usage: n,
    timestamp: new Date(0).toISOString(),
    turn: 1,
    cachedInput: n.prompt_tokens_details.cached_tokens,
    cacheWrite: n.prompt_tokens_details.cache_write_tokens,
    ...extra,
  };
}

describe("usage ledger carries cache writes", () => {
  it("recordUsage: perRequest.cacheWrite and totals.cacheWriteInput accumulate", () => {
    const state = {} as SmartState;
    recordUsage(state, "m", normalizeUsage(ANTHROPIC_SHAPED)!);
    recordUsage(state, "m", normalizeUsage({ ...ANTHROPIC_SHAPED, prompt_tokens_details: { cached_tokens: 10, cache_write_tokens: 2 } })!);
    expect(state.usage!.perRequest.map((r) => r.cacheWrite)).toEqual([5, 2]);
    expect(state.usage!.totals.m).toEqual({ input: 210, output: 40, total: 250, cachedInput: 100, cacheWriteInput: 7 });
  });

  it("totalUsage and appendUsageEntries add the child's writes; splitUsage takes them back out", () => {
    const own = entry("m", ANTHROPIC_SHAPED);
    const child = entry("m", { ...ANTHROPIC_SHAPED, prompt_tokens_details: { cached_tokens: 0, cache_write_tokens: 40 } }, {
      subagent: { name: "c", id: "sa_1", mode: "registry" },
    });
    expect(totalUsage([own, child]).m.cacheWriteInput).toBe(45);

    const state = { usage: { perRequest: [own], totals: totalUsage([own]) } } as unknown as SmartState;
    appendUsageEntries(state, [child] as any);
    expect(state.usage!.totals.m.cacheWriteInput).toBe(45);

    const { own: ownTotals, subagent } = splitUsage(state.usage);
    expect(ownTotals.m.cacheWriteInput).toBe(5);
    expect(subagent.m.cacheWriteInput).toBe(40);
  });

  it("a ledger restored from an older SDK (no write counter) does not turn into NaN", () => {
    const makeLegacy = () => ({
      perRequest: [{ id: "a", modelName: "m", usage: { prompt_tokens: 10, completion_tokens: 1, total_tokens: 11 }, timestamp: "t", turn: 1, cachedInput: 2 }],
      totals: { m: { input: 10, output: 1, total: 11, cachedInput: 2 } },
    });
    const state = { usage: makeLegacy() } as unknown as SmartState;
    recordUsage(state, "m", normalizeUsage(ANTHROPIC_SHAPED)!);
    expect(state.usage!.totals.m.cacheWriteInput).toBe(5);
    expect(totalUsage(makeLegacy().perRequest as any).m.cacheWriteInput).toBe(0);

    const withChild = makeLegacy();
    appendUsageEntries({ usage: withChild }, [entry("m", ANTHROPIC_SHAPED)] as any, { name: "c", id: "sa", mode: "registry" });
    expect(withChild.totals).toEqual({ m: { input: 115, output: 21, total: 136, cachedInput: 92, cacheWriteInput: 5 } });
    expect(splitUsage(withChild as any).own.m).toEqual({ input: 10, output: 1, total: 11, cachedInput: 2, cacheWriteInput: 0 });
  });
});
