import { describe, it, expect, vi } from "vitest";
import { agentVerdictRule } from "../../../src/guardrails/checks.js";
import { GuardrailPhase } from "../../../src/types.js";
import type { GuardrailContext } from "../../../src/types.js";

// Simulate `@typesafe-ai/sdk` not being installed: the optional peer dependency
// must never be a hard runtime requirement.
vi.mock("@typesafe-ai/sdk", () => {
  throw new Error("Cannot find module '@typesafe-ai/sdk'");
});

function ctx(latest: string): GuardrailContext {
  return {
    phase: GuardrailPhase.Response,
    messages: [{ role: "user", content: latest }] as any,
    latestMessage: { role: "user", content: latest } as any,
    state: {} as any,
    options: {} as any,
  };
}

describe("agentVerdictRule jev engine without @typesafe-ai/sdk", () => {
  it("throws an actionable error when the package cannot be resolved", async () => {
    const rule = agentVerdictRule({ engine: "jev" });
    await expect(rule.evaluate(ctx("hello"))).rejects.toThrow(
      /Jev engine requires @typesafe-ai\/sdk to be installed\. Run `npm install @typesafe-ai\/sdk`/
    );
  });

  it("retries resolution on the next evaluation instead of caching the failure", async () => {
    const rule = agentVerdictRule({ engine: "jev" });
    await expect(rule.evaluate(ctx("hello"))).rejects.toThrow(/@typesafe-ai\/sdk/);
    await expect(rule.evaluate(ctx("hello"))).rejects.toThrow(/@typesafe-ai\/sdk/);
  });

  it("still works with an injected client while the package is unavailable", async () => {
    const client = {
      systemOne: async () => ({
        model: "jev-latest",
        answers: { shouldBlock: { type: "noul" as const, noul: 0.05 } },
        usage: { input_tokens: 10, output_tokens: 1 },
      }),
    };
    const res = await agentVerdictRule({ engine: "jev", jev: { client } }).evaluate(ctx("hello"));
    expect(res.passed).toBe(true);
  });
});
