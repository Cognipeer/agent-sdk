/**
 * Gemini thinking: Gemini 3 takes `thinkingLevel` (never a budget, never both
 * fields), 2.5 Pro cannot be switched off, every other model keeps the budget style.
 */

import { describe, it, expect } from "vitest";
import { applyGeminiReasoning, GEMINI_EFFORT_BUDGET } from "../../../src/providers/utils/reasoning.js";
import { resolveModelRule } from "../../../src/models/rules.js";
import type { ReasoningRequestConfig } from "../../../src/providers/types.js";

const PRO3 = "gemini-3-pro-preview";
const PRO31 = "gemini-3.1-pro-preview";
const FLASH3 = "gemini-3-flash-preview";
const FLASH_LITE = "gemini-3.1-flash-lite";

function run(model: string | undefined, reasoning: ReasoningRequestConfig, cfg: Record<string, any> = {}) {
  applyGeminiReasoning(cfg, reasoning, model ? { model } : undefined);
  return cfg;
}

describe("gemini rule matching", () => {
  it.each([
    [PRO3, "gemini-3-pro"],
    ["publishers/google/models/gemini-3-pro-preview", "gemini-3-pro"],
    [PRO31, "gemini-3x-pro"],
    [FLASH3, "gemini-3-level"],
    [FLASH_LITE, "gemini-3-level"],
    ["gemini-3.7-flash", "gemini-3x-flash-no-minimal"],
    ["gemini-3-pro-image-preview", "gemini-3-pro-image"],
    ["gemini-3.1-flash-image-preview", "gemini-3-image"],
    ["gemini-2.5-pro", "gemini-2.5-pro"],
    ["gemini-2.5-flash", "gemini-budget"],
    ["gemini-2.5-flash-lite", "gemini-budget"],
    ["gemini-2.0-flash", "gemini-budget"],
  ])("%s -> %s", (model, id) => {
    expect(resolveModelRule({ provider: "vertex", model }).matchedRuleId).toBe(id);
  });

  it("gemini 3 rules use the level style, the others the budget style", () => {
    expect(resolveModelRule({ provider: "vertex", model: PRO3 }).reasoning.style).toBe("level");
    expect(resolveModelRule({ provider: "vertex", model: "gemini-2.5-pro" }).reasoning.style).toBe("budget");
    expect(resolveModelRule({ provider: "vertex", model: "gemini-2.5-flash" }).reasoning.style).toBe("budget");
  });
});

describe("Gemini 3 thinkingLevel mapping", () => {
  it("Gemini 3 Pro accepts low and high only: effort goes to the nearest lower allowed level", () => {
    expect(run(PRO3, { effort: "low" }).thinkingConfig).toEqual({ thinkingLevel: "low" });
    expect(run(PRO3, { effort: "medium" }).thinkingConfig).toEqual({ thinkingLevel: "low" });
    expect(run(PRO3, { effort: "high" }).thinkingConfig).toEqual({ thinkingLevel: "high" });
    expect(run(PRO3, { effort: "xhigh" }).thinkingConfig).toEqual({ thinkingLevel: "high" });
    expect(run(PRO3, { effort: "max" }).thinkingConfig).toEqual({ thinkingLevel: "high" });
  });

  it("minimal is not supported on Pro: it goes up to low, never to off", () => {
    expect(run(PRO3, { effort: "minimal" }).thinkingConfig).toEqual({ thinkingLevel: "low" });
    expect(run(PRO31, { effort: "minimal" }).thinkingConfig).toEqual({ thinkingLevel: "low" });
  });

  it("Gemini 3.1 Pro adds medium", () => {
    expect(run(PRO31, { effort: "medium" }).thinkingConfig).toEqual({ thinkingLevel: "medium" });
    expect(run(PRO31, { effort: "high" }).thinkingConfig).toEqual({ thinkingLevel: "high" });
    expect(run(PRO31, { effort: "max" }).thinkingConfig).toEqual({ thinkingLevel: "high" });
  });

  it("Gemini 3 Flash and Flash-Lite accept minimal, low, medium and high", () => {
    for (const model of [FLASH3, FLASH_LITE]) {
      for (const level of ["minimal", "low", "medium", "high"] as const) {
        expect(run(model, { effort: level }).thinkingConfig).toEqual({ thinkingLevel: level });
      }
      expect(run(model, { effort: "xhigh" }).thinkingConfig).toEqual({ thinkingLevel: "high" });
    }
  });

  it("Gemini 3.7 / 3.8 Flash have no minimal", () => {
    expect(run("gemini-3.7-flash", { effort: "minimal" }).thinkingConfig).toEqual({ thinkingLevel: "low" });
    expect(run("gemini-3.8-flash", { effort: "medium" }).thinkingConfig).toEqual({ thinkingLevel: "medium" });
  });

  it("image models keep to the levels they accept", () => {
    expect(run("gemini-3-pro-image-preview", { effort: "low" }).thinkingConfig).toEqual({ thinkingLevel: "high" });
    expect(run("gemini-3.1-flash-image-preview", { effort: "minimal" }).thinkingConfig).toEqual({ thinkingLevel: "minimal" });
    expect(run("gemini-3.1-flash-image-preview", { effort: "medium" }).thinkingConfig).toEqual({ thinkingLevel: "minimal" });
  });

  it("includeThoughts rides along with the level", () => {
    expect(run(FLASH3, { effort: "low", includeThoughts: true }).thinkingConfig).toEqual({
      thinkingLevel: "low",
      includeThoughts: true,
    });
  });

  it("sends nothing when no effort, level or budget is given", () => {
    expect(run(FLASH3, {}).thinkingConfig).toBeUndefined();
    expect(run(FLASH3, { includeThoughts: true }).thinkingConfig).toBeUndefined();
  });
});

describe("effort none", () => {
  it("on Gemini 3 it is the lowest allowed level, never thinkingBudget 0", () => {
    expect(run(PRO3, { effort: "none" }).thinkingConfig).toEqual({ thinkingLevel: "low" });
    expect(run(PRO31, { effort: "none" }).thinkingConfig).toEqual({ thinkingLevel: "low" });
    expect(run(FLASH3, { effort: "none" }).thinkingConfig).toEqual({ thinkingLevel: "minimal" });
    expect(run(FLASH_LITE, { effort: "none" }).thinkingConfig).toEqual({ thinkingLevel: "minimal" });
    expect(run("gemini-3.7-flash", { effort: "none" }).thinkingConfig).toEqual({ thinkingLevel: "low" });
    expect(run("gemini-3-pro-image-preview", { effort: "none" }).thinkingConfig).toEqual({ thinkingLevel: "high" });
  });

  it("none beats an explicit budget on Gemini 3 (the later, more specific intent)", () => {
    expect(run(FLASH3, { effort: "none", budgetTokens: 4000 }).thinkingConfig).toEqual({ thinkingLevel: "minimal" });
  });

  it("on Gemini 2.5 Pro it is the documented minimum budget (128), not 0", () => {
    expect(run("gemini-2.5-pro", { effort: "none" }).thinkingConfig).toEqual({ thinkingBudget: 128 });
    expect(run("publishers/google/models/gemini-2.5-pro", { effort: "none" }).thinkingConfig).toEqual({ thinkingBudget: 128 });
  });

  it("on Gemini 2.5 Flash / Flash-Lite and unknown models it stays budget 0 (off)", () => {
    expect(run("gemini-2.5-flash", { effort: "none" }).thinkingConfig).toEqual({ thinkingBudget: 0 });
    expect(run("gemini-2.5-flash-lite", { effort: "none" }).thinkingConfig).toEqual({ thinkingBudget: 0 });
    expect(run("gemini-2.0-flash", { effort: "none" }).thinkingConfig).toEqual({ thinkingBudget: 0 });
    expect(run(undefined, { effort: "none" }).thinkingConfig).toEqual({ thinkingBudget: 0 });
  });
});

describe("Gemini 2.5 Pro and the other budget models", () => {
  it("2.5 Pro keeps the budget table for the other efforts", () => {
    expect(run("gemini-2.5-pro", { effort: "high" }).thinkingConfig).toEqual({ thinkingBudget: GEMINI_EFFORT_BUDGET.high });
    expect(run("gemini-2.5-pro", { effort: "minimal" }).thinkingConfig).toEqual({ thinkingBudget: GEMINI_EFFORT_BUDGET.minimal });
  });

  it("budget models keep the pre-0.22 shapes, with or without a model id", () => {
    for (const model of [undefined, "gemini-2.5-flash", "gemini-2.5-flash-lite", "gemini-2.5-pro", "gemini-2.0-flash"]) {
      expect(run(model, { effort: "medium" }).thinkingConfig).toEqual({ thinkingBudget: 4096 });
      expect(run(model, { effort: "high", thinkingLevel: "low", includeThoughts: true }).thinkingConfig).toEqual({
        thinkingLevel: "low",
        includeThoughts: true,
      });
      expect(run(model, { thinkingLevel: "high" }).thinkingConfig).toEqual({ thinkingLevel: "high" });
    }
    expect(run("gemini-2.5-flash", { effort: "none", thinkingLevel: "high" }).thinkingConfig).toEqual({ thinkingBudget: 0 });
  });
});

describe("explicit caller values win", () => {
  it("an explicit thinkingLevel is sent as given on Gemini 3, whatever the effort", () => {
    expect(run(PRO3, { effort: "low", thinkingLevel: "high" }).thinkingConfig).toEqual({ thinkingLevel: "high" });
    expect(run(FLASH3, { effort: "none", thinkingLevel: "medium" }).thinkingConfig).toEqual({ thinkingLevel: "medium" });
    expect(run(FLASH3, { thinkingLevel: "minimal" }).thinkingConfig).toEqual({ thinkingLevel: "minimal" });
  });

  // R6 (deliberate change): on a level model a numeric budget picks the nearest level; no thinkingBudget is sent.
  it("an explicit budgetTokens picks a level (never a budget) on Gemini 3", () => {
    expect(run(PRO3, { effort: "high", budgetTokens: 4000 }).thinkingConfig).toEqual({ thinkingLevel: "low" });
    expect(run(FLASH3, { budgetTokens: 2000.7 }).thinkingConfig).toEqual({ thinkingLevel: "medium" });
  });

  it("providerExtras.thinkingBudget replaces the derived level on Gemini 3", () => {
    expect(run(PRO3, { effort: "high", providerExtras: { thinkingBudget: -1 } }).thinkingConfig).toEqual({ thinkingBudget: -1 });
  });

  it("providerExtras.thinkingLevel replaces the derived budget on a budget model", () => {
    expect(run("gemini-2.5-flash", { effort: "low", providerExtras: { thinkingLevel: "low" } }).thinkingConfig).toEqual({
      thinkingLevel: "low",
    });
  });

  it("providerExtras.thinkingLevel wins over the derived level", () => {
    expect(run(PRO31, { effort: "low", providerExtras: { thinkingLevel: "medium" } }).thinkingConfig).toEqual({
      thinkingLevel: "medium",
    });
  });

  it("providerExtras still merge other fields", () => {
    expect(run(FLASH3, { effort: "low", providerExtras: { includeThoughts: true } }).thinkingConfig).toEqual({
      thinkingLevel: "low",
      includeThoughts: true,
    });
  });
});

describe("thinkingLevel and thinkingBudget are never sent together", () => {
  const efforts = ["none", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
  const gemini3 = [PRO3, PRO31, FLASH3, FLASH_LITE, "gemini-3.7-flash", "gemini-3-pro-image-preview", "gemini-3.1-flash-image-preview"];

  it("holds for every Gemini 3 model and effort", () => {
    for (const model of gemini3) {
      for (const effort of efforts) {
        const tc = run(model, { effort }).thinkingConfig;
        expect(tc, `${model} ${effort}`).toBeDefined();
        expect("thinkingBudget" in tc, `${model} ${effort} budget`).toBe(false);
        expect(typeof tc.thinkingLevel).toBe("string");
      }
    }
  });

  it("holds when the caller mixes the typed fields", () => {
    for (const model of [PRO3, FLASH3, "gemini-2.5-flash", undefined]) {
      for (const effort of efforts) {
        const tc = run(model, { effort, budgetTokens: 4000, thinkingLevel: "low" }).thinkingConfig;
        expect("thinkingBudget" in tc && "thinkingLevel" in tc, `${model} ${effort}`).toBe(false);
      }
    }
  });

  it("holds when providerExtras supply only one of the two fields", () => {
    for (const model of [PRO3, "gemini-2.5-flash"]) {
      for (const extras of [{ thinkingLevel: "high" }, { thinkingBudget: 1500 }]) {
        const tc = run(model, { effort: "medium", providerExtras: extras }).thinkingConfig;
        expect("thinkingBudget" in tc && "thinkingLevel" in tc).toBe(false);
        expect(tc).toMatchObject(extras);
      }
    }
  });
});

describe("maxOutputTokens headroom", () => {
  it("still raises a too-small cap for a numeric budget on budget models", () => {
    const cfg = run("gemini-2.5-flash", { budgetTokens: 4000 }, { maxOutputTokens: 1000 });
    expect(cfg.thinkingConfig.thinkingBudget).toBe(4000);
    expect(cfg.maxOutputTokens).toBe(6048);
  });

  it("raises it for 2.5 Pro's minimum budget as well", () => {
    const cfg = run("gemini-2.5-pro", { effort: "none" }, { maxOutputTokens: 100 });
    expect(cfg.thinkingConfig.thinkingBudget).toBe(128);
    expect(cfg.maxOutputTokens).toBe(128 + 2048);
  });

  it("keeps a cap that already has room, and never creates one", () => {
    expect(run("gemini-2.5-flash", { budgetTokens: 4000 }, { maxOutputTokens: 20000 }).maxOutputTokens).toBe(20000);
    expect(run("gemini-2.5-flash", { budgetTokens: 4000 }).maxOutputTokens).toBeUndefined();
  });

  it("does not touch the cap for a thinking level", () => {
    for (const effort of ["none", "low", "high", "max"] as const) {
      const cfg = run(PRO3, { effort }, { maxOutputTokens: 100 });
      expect(cfg.maxOutputTokens).toBe(100);
    }
    expect(run(FLASH3, { thinkingLevel: "high" }, { maxOutputTokens: 100 }).maxOutputTokens).toBe(100);
  });

  // R6 (deliberate change): a budget on a level model becomes a level, so no headroom is added.
  it("a budget on Gemini 3 becomes a level and adds no headroom", () => {
    expect(run(PRO3, { budgetTokens: 4000 }, { maxOutputTokens: 1000 }).maxOutputTokens).toBe(1000);
  });
});
