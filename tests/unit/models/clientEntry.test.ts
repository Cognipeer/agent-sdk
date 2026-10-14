/** The client-safe "./model-rules" entry: same rules, no Node built-ins in the built chunk. */
import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import * as entry from "../../../src/model-rules.js";

describe("model-rules client entry", () => {
  it("exports the pure rule API", () => {
    for (const n of ["MODEL_RULES", "resolveModelRule", "mapReasoningEffort", "modelIdCandidates", "allowsSampling", "effortBudget"]) {
      expect(typeof (entry as any)[n]).not.toBe("undefined");
    }
    expect(entry.resolveModelRule({ provider: "openai", model: "gpt-6-luna" }).matchedRuleId).toBe("openai-gpt-6-plus");
  });
  const dist = new URL("../../../dist/model-rules.mjs", import.meta.url);
  it.skipIf(!existsSync(dist))("built chunk imports nothing from Node", () => {
    for (const f of ["model-rules.mjs", "model-rules.cjs"]) {
      const src = readFileSync(new URL(`../../../dist/${f}`, import.meta.url), "utf8");
      expect(src).not.toMatch(/(?:from|require\()\s*["'](?:node:|fs|path|crypto|buffer|module|os|url|stream)/);
    }
  });
});
