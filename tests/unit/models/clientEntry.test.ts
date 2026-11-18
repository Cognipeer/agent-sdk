/** The client-safe "./model-rules" entry: same rules, no Node built-ins in the built chunk. */
import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import * as entry from "../../../src/model-rules.js";

const SERVING_API = ["SERVER_TYPES", "normalizeServerType", "resolveReasoningProfile", "describeServingReasoning"];

describe("model-rules client entry", () => {
  it("exports the pure rule API", () => {
    for (const n of ["MODEL_RULES", "resolveModelRule", "mapReasoningEffort", "modelIdCandidates", "allowsSampling", "effortBudget"]) {
      expect(typeof (entry as any)[n]).not.toBe("undefined");
    }
    expect(entry.resolveModelRule({ provider: "openai", model: "gpt-6-luna" }).matchedRuleId).toBe("openai-gpt-6-plus");
  });
  it("exports the serving-aware reasoning API (profiles, server types)", () => {
    for (const n of SERVING_API) expect(typeof (entry as any)[n], n).not.toBe("undefined");
    expect(entry.resolveReasoningProfile("Qwen/Qwen3-8B")?.style).toBe("toggle");
    expect(entry.describeServingReasoning("mlx", "Qwen/Qwen3-8B").wire).toBe("chat_template_kwargs");
  });
  const dist = new URL("../../../dist/model-rules.mjs", import.meta.url);
  it.skipIf(!existsSync(dist))("the package subpath resolves from the built package, in both formats", async () => {
    // Self-reference through package.json "exports", as a consumer resolves it.
    const require = createRequire(import.meta.url);
    const cjsPath = require.resolve("@cognipeer/agent-sdk/model-rules");
    expect(cjsPath.replace(/\\/g, "/")).toMatch(/\/dist\/model-rules\.cjs$/);
    const cjs = require("@cognipeer/agent-sdk/model-rules");
    const esm = await import(pathToFileURL(cjsPath.replace(/\.cjs$/, ".mjs")).href);
    for (const mod of [cjs, esm]) {
      for (const n of [...SERVING_API, "MODEL_RULES", "resolveModelRule"]) expect(typeof mod[n], n).not.toBe("undefined");
      expect(mod.resolveReasoningProfile("qwen3-coder:30b")?.style).toBe("none");
      expect(mod.MODEL_RULES.reasoningProfiles.length).toBeGreaterThan(0);
    }
    const json = require("@cognipeer/agent-sdk/model-rules.json");
    expect(json.reasoningProfiles.map((p: { id: string }) => p.id)).toContain("qwen3-hybrid");
  });
  it.skipIf(!existsSync(dist))("built chunk imports nothing from Node", () => {
    for (const f of ["model-rules.mjs", "model-rules.cjs"]) {
      const src = readFileSync(new URL(`../../../dist/${f}`, import.meta.url), "utf8");
      expect(src).not.toMatch(/(?:from|require\()\s*["'](?:node:|fs|path|crypto|buffer|module|os|url|stream)/);
    }
  });
});
