/**
 * Gemini thinking levels:
 *  - Gemini 4 takes levels only (low / medium / high); thinkingBudget is a 400 there and
 *    MINIMAL is not supported;
 *  - on every level-style model a numeric budget picks the nearest level instead of
 *    being sent as the deprecated thinkingBudget;
 *  - effort none sends MINIMAL as asked; a functionCall of the current turn that has no
 *    thought signature gets Google's skip value instead (see the Vertex request tests).
 */

import { describe, it, expect } from "vitest";
import { applyGeminiReasoning } from "../../../src/providers/utils/reasoning.js";
import { MODEL_RULES, resolveModelRule } from "../../../src/models/rules.js";
import { VertexProvider } from "../../../src/providers/vertex.js";

const PRO3 = "gemini-3-pro-preview"; // low, high
const PRO31 = "gemini-3.1-pro-preview"; // low, medium, high
const FLASH3 = "gemini-3-flash-preview"; // minimal, low, medium, high
const FLASH_LITE = "gemini-3.1-flash-lite"; // minimal, low, medium, high
const FLASH37 = "gemini-3.7-flash"; // low, medium, high
const IMAGE_FLASH = "gemini-3.1-flash-image-preview"; // minimal, high
const IMAGE_PRO = "gemini-3-pro-image-preview"; // high
const GEMINI4 = "gemini-4-argon"; // low, medium, high

const EFFORTS = ["none", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

function run(model: string | undefined, reasoning: Record<string, any>, cfg: Record<string, any> = {}, opts: Record<string, any> = {}) {
  applyGeminiReasoning(cfg, reasoning, { model, ...opts });
  return cfg;
}

// ─── R5: Gemini 4 ────────────────────────────────────────────────────────────

describe("Gemini 4 rule", () => {
  it.each([GEMINI4, "gemini-4.1-pro", "gemini-4-argon-cyber-permissive", "publishers/google/models/gemini-4-argon", "gemini-5-pro"])(
    "%s is a level model with low, medium and high",
    (model) => {
      const r = resolveModelRule({ provider: "vertex", model });
      expect(r.matchedRuleId).toBe("gemini-4-level");
      expect(r.isDefault).toBe(false);
      expect(r.reasoning.style).toBe("level");
      expect(r.reasoning.efforts).toEqual(["low", "medium", "high"]);
      expect(r.reasoning.off).toBeNull();
    },
  );

  it("sits before the Gemini catch-all, and Gemini 2.5 / 3 and unknown ids keep their rules", () => {
    const ids = MODEL_RULES.rules.map((r) => r.id);
    expect(ids.indexOf("gemini-4-level")).toBeGreaterThan(-1);
    expect(ids.indexOf("gemini-4-level")).toBeLessThan(ids.indexOf("gemini-budget"));
    for (const [model, id] of [
      ["gemini-2.5-flash", "gemini-budget"],
      ["gemini-2.5-pro", "gemini-2.5-pro"],
      ["gemini-2.0-flash", "gemini-budget"],
      ["gemini-embedding-001", "gemini-budget"],
      [FLASH3, "gemini-3-level"],
      [PRO3, "gemini-3-pro"],
    ]) {
      expect(resolveModelRule({ provider: "vertex", model }).matchedRuleId, model).toBe(id);
    }
  });

  it("effort goes to low, medium or high: xhigh and max to high, minimal and none to low (no MINIMAL)", () => {
    const cases: Array<[string, string]> = [
      ["low", "low"],
      ["medium", "medium"],
      ["high", "high"],
      ["xhigh", "high"],
      ["max", "high"],
      ["minimal", "low"],
      ["none", "low"],
    ];
    for (const [effort, level] of cases) {
      expect(run(GEMINI4, { effort }).thinkingConfig, effort).toEqual({ thinkingLevel: level });
    }
  });

  it("never sends thinkingBudget, whatever effort and budget are asked for", () => {
    for (const model of [GEMINI4, "gemini-5-pro"]) {
      for (const effort of EFFORTS) {
        for (const budgetTokens of [undefined, 1, 1024, 1025, 8192, 8193, 100_000]) {
          const tc = run(model, { effort, budgetTokens }).thinkingConfig;
          expect("thinkingBudget" in tc, `${model} ${effort} ${budgetTokens}`).toBe(false);
          expect(["low", "medium", "high"], `${model} ${effort} ${budgetTokens}`).toContain(tc.thinkingLevel);
        }
      }
    }
  });

  it("budgetTokens picks the nearest level", () => {
    expect(run(GEMINI4, { budgetTokens: 512 }).thinkingConfig).toEqual({ thinkingLevel: "low" });
    expect(run(GEMINI4, { budgetTokens: 4000 }).thinkingConfig).toEqual({ thinkingLevel: "medium" });
    expect(run(GEMINI4, { budgetTokens: 20_000 }).thinkingConfig).toEqual({ thinkingLevel: "high" });
  });

  it("includeThoughts rides along, and the output cap is left alone", () => {
    const cfg = run(GEMINI4, { effort: "low", includeThoughts: true }, { maxOutputTokens: 100 });
    expect(cfg.thinkingConfig).toEqual({ thinkingLevel: "low", includeThoughts: true });
    expect(cfg.maxOutputTokens).toBe(100);
  });

  it("an explicit thinkingLevel is sent as given", () => {
    expect(run(GEMINI4, { effort: "low", thinkingLevel: "high" }).thinkingConfig).toEqual({ thinkingLevel: "high" });
  });

  it("sends nothing when no effort, level or budget is asked for", () => {
    expect(run(GEMINI4, {}).thinkingConfig).toBeUndefined();
  });
});

// ─── R6: a budget picks a level on a level model ─────────────────────────────

describe("a numeric budget on a level model", () => {
  const level = (model: string, budgetTokens: number) => run(model, { budgetTokens }).thinkingConfig;

  it("<= 1024 is low, <= 8192 medium, above that high (Flash has all three)", () => {
    const table: Array<[number, string]> = [
      [1, "low"],
      [1024, "low"],
      [1024.9, "low"],
      [1025, "medium"],
      [4000, "medium"],
      [8192, "medium"],
      [8193, "high"],
      [32_768, "high"],
    ];
    for (const model of [FLASH3, FLASH_LITE, FLASH37, PRO31, GEMINI4]) {
      for (const [budget, expected] of table) {
        expect(level(model, budget), `${model} ${budget}`).toEqual({ thinkingLevel: expected });
      }
    }
  });

  it("is clamped to the levels the rule accepts (nearest lower, else nearest higher)", () => {
    // Gemini 3 Pro: low and high only.
    for (const [budget, expected] of [[500, "low"], [4000, "low"], [8192, "low"], [8193, "high"]] as Array<[number, string]>) {
      expect(level(PRO3, budget), `pro ${budget}`).toEqual({ thinkingLevel: expected });
    }
    // Image Flash: minimal and high only; medium and low land on minimal.
    for (const [budget, expected] of [[500, "minimal"], [4000, "minimal"], [9000, "high"]] as Array<[number, string]>) {
      expect(level(IMAGE_FLASH, budget), `image flash ${budget}`).toEqual({ thinkingLevel: expected });
    }
    // Image Pro: high only.
    for (const budget of [500, 4000, 9000]) expect(level(IMAGE_PRO, budget), `image pro ${budget}`).toEqual({ thinkingLevel: "high" });
  });

  it("is a level, never thinkingBudget, and leaves maxOutputTokens alone", () => {
    for (const model of [PRO3, PRO31, FLASH3, FLASH_LITE, FLASH37, IMAGE_FLASH, IMAGE_PRO, GEMINI4]) {
      const cfg = run(model, { budgetTokens: 4000 }, { maxOutputTokens: 1000 });
      expect("thinkingBudget" in cfg.thinkingConfig, model).toBe(false);
      expect(typeof cfg.thinkingConfig.thinkingLevel, model).toBe("string");
      expect(cfg.maxOutputTokens, model).toBe(1000);
    }
  });

  it("an explicit budget still wins over effort", () => {
    expect(run(PRO31, { effort: "low", budgetTokens: 20_000 }).thinkingConfig).toEqual({ thinkingLevel: "high" });
    expect(run(FLASH3, { effort: "high", budgetTokens: 500 }).thinkingConfig).toEqual({ thinkingLevel: "low" });
  });

  it("an explicit thinkingLevel wins over the budget", () => {
    expect(run(FLASH3, { budgetTokens: 20_000, thinkingLevel: "low" }).thinkingConfig).toEqual({ thinkingLevel: "low" });
  });

  it("effort none is the later, more specific intent and wins over the budget", () => {
    expect(run(FLASH3, { effort: "none", budgetTokens: 20_000 }).thinkingConfig).toEqual({ thinkingLevel: "minimal" });
    expect(run(PRO3, { effort: "none", budgetTokens: 20_000 }).thinkingConfig).toEqual({ thinkingLevel: "low" });
  });

  it("a budget that is not a positive number is no budget", () => {
    expect(run(FLASH3, { budgetTokens: 0 }).thinkingConfig).toBeUndefined();
    expect(run(FLASH3, { budgetTokens: -1 }).thinkingConfig).toBeUndefined();
    expect(run(FLASH3, { budgetTokens: Number.NaN }).thinkingConfig).toBeUndefined();
    expect(run(FLASH3, { effort: "high", budgetTokens: 0 }).thinkingConfig).toEqual({ thinkingLevel: "high" });
  });

  it("includeThoughts rides along with the level the budget picked", () => {
    expect(run(FLASH3, { budgetTokens: 4000, includeThoughts: true }).thinkingConfig).toEqual({ thinkingLevel: "medium", includeThoughts: true });
  });

  it("an explicit providerExtras.thinkingBudget is still sent, as the caller's own choice (and gets headroom)", () => {
    const cfg = run(FLASH3, { budgetTokens: 4000, providerExtras: { thinkingBudget: 2048 } }, { maxOutputTokens: 1000 });
    expect(cfg.thinkingConfig).toEqual({ thinkingBudget: 2048 });
    expect(cfg.maxOutputTokens).toBe(2048 + 2048);
    expect(run(GEMINI4, { effort: "high", providerExtras: { thinkingBudget: -1 } }).thinkingConfig).toEqual({ thinkingBudget: -1 });
  });

  it("providerExtras.thinkingLevel replaces the level the budget picked", () => {
    expect(run(PRO3, { budgetTokens: 20_000, providerExtras: { thinkingLevel: "low" } }).thinkingConfig).toEqual({ thinkingLevel: "low" });
  });

  it("thinkingLevel and thinkingBudget are never sent together", () => {
    for (const model of [PRO3, FLASH3, GEMINI4]) {
      for (const budgetTokens of [undefined, 500, 4000, 20_000]) {
        for (const extras of [undefined, { thinkingLevel: "high" }, { thinkingBudget: 1500 }]) {
          const tc = run(model, { effort: "medium", budgetTokens, providerExtras: extras }).thinkingConfig;
          expect("thinkingBudget" in tc && "thinkingLevel" in tc, `${model} ${budgetTokens} ${JSON.stringify(extras)}`).toBe(false);
        }
      }
    }
  });

  it("budget-style models are unchanged: the budget is sent as a budget, with headroom", () => {
    expect(run("gemini-2.5-flash", { budgetTokens: 4000 }).thinkingConfig).toEqual({ thinkingBudget: 4000 });
    expect(run("gemini-2.5-pro", { budgetTokens: 2000.7 }).thinkingConfig).toEqual({ thinkingBudget: 2000 });
    expect(run(undefined, { budgetTokens: 300 }).thinkingConfig).toEqual({ thinkingBudget: 300 });
    expect(run("gemini-2.5-flash", { budgetTokens: 4000 }, { maxOutputTokens: 1000 }).maxOutputTokens).toBe(6048);
  });
});

// ─── R7: effort none and MINIMAL ─────────────────────────────────────────────

describe("effort none and MINIMAL", () => {
  const none = (model: string, opts?: Record<string, any>) => run(model, { effort: "none" }, {}, opts).thinkingConfig;

  it("MINIMAL is sent as asked", () => {
    for (const model of [FLASH3, FLASH_LITE]) {
      expect(none(model), model).toEqual({ thinkingLevel: "minimal" });
    }
  });

  it("models whose lowest level is not MINIMAL send that lowest level", () => {
    expect(none(PRO3)).toEqual({ thinkingLevel: "low" });
    expect(none(PRO31)).toEqual({ thinkingLevel: "low" });
    expect(none(FLASH37)).toEqual({ thinkingLevel: "low" });
    expect(none(GEMINI4)).toEqual({ thinkingLevel: "low" });
    expect(none(IMAGE_PRO)).toEqual({ thinkingLevel: "high" });
  });

  it("a rule with minimal but no low keeps minimal", () => {
    expect(none(IMAGE_FLASH)).toEqual({ thinkingLevel: "minimal" });
  });

  it("only effort none is adjusted: an explicit minimal or thinkingLevel is the caller's own choice", () => {
    expect(run(FLASH3, { effort: "minimal" }).thinkingConfig).toEqual({ thinkingLevel: "minimal" });
    expect(run(FLASH3, { thinkingLevel: "minimal" }).thinkingConfig).toEqual({ thinkingLevel: "minimal" });
    expect(run(FLASH3, { effort: "medium" }).thinkingConfig).toEqual({ thinkingLevel: "medium" });
  });

  it("none still beats an explicit budget", () => {
    expect(run(FLASH3, { effort: "none", budgetTokens: 4000 }).thinkingConfig).toEqual({ thinkingLevel: "minimal" });
  });

  it("budget-style models: none is still budget 0", () => {
    expect(none("gemini-2.5-flash")).toEqual({ thinkingBudget: 0 });
    expect(none("gemini-2.5-pro")).toEqual({ thinkingBudget: 128 });
  });
});

describe("Vertex request: effort none and thought signatures", () => {
  const OK = { candidates: [{ content: { parts: [{ text: "ok" }] }, finishReason: "STOP" }], usageMetadata: {} };
  const SIGNED = { type: "thinking", thoughtSignature: "SIG" };

  async function send(messages: any[], model = FLASH3, reasoning: Record<string, any> = { effort: "none" }) {
    const bodies: any[] = [];
    const fn = (async (_url: any, init: any) => {
      bodies.push(JSON.parse(init.body));
      return new Response(JSON.stringify(OK), { status: 200, headers: { "content-type": "application/json" } });
    }) as unknown as typeof fetch;
    const provider = new VertexProvider({ provider: "vertex", projectId: "proj", accessToken: "tok", fetch: fn, retry: { maxRetries: 0 } } as any);
    await provider.complete({ model, messages, reasoning } as any);
    return bodies[0];
  }
  const level = (body: any) => body.generationConfig.thinkingConfig;
  const user = (content: string) => ({ role: "user", content });

  it("effort none is MINIMAL whatever the history holds", async () => {
    expect(level(await send([user("hi")]))).toEqual({ thinkingLevel: "minimal" });
    const body = await send([user("hi"), { role: "assistant", content: "hello" }, user("again")]);
    expect(level(body)).toEqual({ thinkingLevel: "minimal" });
  });

  it("a signed text turn sends its signature back; text parts are never given the skip value", async () => {
    const body = await send([user("hi"), { role: "assistant", content: "hello", reasoning: { blocks: [SIGNED] } }, user("again")]);
    expect(body.contents[1]).toEqual({ role: "model", parts: [{ text: "hello", thoughtSignature: "SIG" }] });
    const plain = await send([user("hi"), { role: "assistant", content: "hello" }, user("again")]);
    expect(plain.contents[1]).toEqual({ role: "model", parts: [{ text: "hello" }] });
  });

  const call = (id: string, thoughtSignature?: string) => ({ id, name: "f", arguments: "{}", ...(thoughtSignature ? { thoughtSignature } : {}) });

  it("an unsigned functionCall in the current turn gets the skip value on Gemini 3", async () => {
    const body = await send([
      user("go"),
      { role: "assistant", content: "", toolCalls: [call("c1"), call("c2")] },
      { role: "tool", content: "{}", toolCallId: "c1" },
      { role: "tool", content: "{}", toolCallId: "c2" },
    ]);
    const parts = body.contents[1].parts;
    expect(parts[0].thoughtSignature).toBe("skip_thought_signature_validator");
    expect(parts[1].thoughtSignature).toBeUndefined();
  });

  it("a signed functionCall keeps its own signature", async () => {
    const body = await send([
      user("go"),
      { role: "assistant", content: "", toolCalls: [call("c1", "TS")] },
      { role: "tool", content: "{}", toolCallId: "c1" },
    ]);
    expect(body.contents[1].parts[0].thoughtSignature).toBe("TS");
  });

  it("every step of the current turn is covered; earlier turns are left alone", async () => {
    const body = await send([
      user("old"),
      { role: "assistant", content: "", toolCalls: [call("o1")] },
      { role: "tool", content: "{}", toolCallId: "o1" },
      { role: "assistant", content: "done" },
      user("new"),
      { role: "assistant", content: "", toolCalls: [call("n1")] },
      { role: "tool", content: "{}", toolCallId: "n1" },
      { role: "assistant", content: "", toolCalls: [call("n2")] },
      { role: "tool", content: "{}", toolCallId: "n2" },
    ]);
    const sig = (i: number) => body.contents[i].parts[0].thoughtSignature;
    expect(sig(1)).toBeUndefined();
    expect(sig(5)).toBe("skip_thought_signature_validator");
    expect(sig(7)).toBe("skip_thought_signature_validator");
  });

  it("a budget-style model (Gemini 2.5) is not given the skip value", async () => {
    const body = await send(
      [user("go"), { role: "assistant", content: "", toolCalls: [call("c1")] }, { role: "tool", content: "{}", toolCallId: "c1" }],
      "gemini-2.5-flash",
    );
    expect(body.contents[1].parts[0].thoughtSignature).toBeUndefined();
  });
});
