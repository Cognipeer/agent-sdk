/**
 * Eval-harness regression test. Drives `runSmartAgentEvalHarness` with a
 * deterministic scripted model (no API key needed) so the harness math —
 * recall, obsolete-drop, trajectory, aggregate score, per-profile rollup —
 * stays correct as the runtime evolves. Behavioural quality against a real
 * model is covered separately by the opt-in provider matrix.
 */
import { describe, it, expect } from "vitest";
import { createSmartAgent, runSmartAgentEvalHarness } from "../../src/index.js";
import type { EvalCase, Message, RuntimeProfile } from "../../src/types.js";

/** Echoes the user prompt back, so expected phrases (substrings of the prompt)
 *  match and forbidden phrases (absent from the prompt) are correctly dropped. */
function echoModel() {
  return {
    modelName: "echo",
    bindTools() { return this; },
    async invoke(msgs: Message[]) {
      const lastUser = [...msgs].reverse().find((m) => m.role === "user");
      const text = typeof lastUser?.content === "string" ? lastUser.content : "";
      return { role: "assistant", content: text };
    },
  } as any;
}

const cases: EvalCase[] = [
  {
    id: "recall-1",
    family: "recall",
    prompt: "The access code is BLUE42 and the city is Berlin.",
    expectedPhrases: ["BLUE42", "Berlin"],
    forbiddenPhrases: ["RED99"],
  },
  {
    id: "rollover-1",
    family: "context_rollover",
    prompt: "Project Apollo ships on Friday; ignore the cancelled Project Zephyr.",
    expectedPhrases: ["Apollo", "Friday"],
    forbiddenPhrases: ["nonexistent-token"],
  },
];

const failingCase: EvalCase = {
  id: "miss-1",
  family: "recall",
  // Expected phrase is deliberately NOT in the (echoed) prompt → recall fails.
  prompt: "This answer omits the secret.",
  expectedPhrases: ["UNSPOKEN-SECRET"],
};

const profiles: RuntimeProfile[] = ["fast", "balanced"];

const makeAgent = (profile: RuntimeProfile) =>
  createSmartAgent({ name: `eval-${profile}`, model: echoModel(), runtimeProfile: profile, summarization: false });

describe("eval harness (scripted)", () => {
  it("produces one rollup per profile with well-formed metrics", async () => {
    const results = await runSmartAgentEvalHarness({ profiles, cases, createAgent: makeAgent });
    expect(results).toHaveLength(profiles.length);
    for (const r of results) {
      expect(profiles).toContain(r.profile);
      expect(r.cases).toHaveLength(cases.length);
      const m = r.metrics;
      for (const v of [m.taskSuccess, m.recallAccuracy, m.obsoleteDropAccuracy, m.trajectoryScore, m.recoveryRate, m.score]) {
        expect(v).toBeGreaterThanOrEqual(0);
        expect(v).toBeLessThanOrEqual(1);
      }
      expect(typeof m.latencyMs).toBe("number");
    }
  });

  it("scores fully-recalled cases as successful", async () => {
    const [result] = await runSmartAgentEvalHarness({ profiles: ["balanced"], cases, createAgent: makeAgent });
    expect(result.metrics.taskSuccess).toBe(1);
    for (const c of result.cases) {
      expect(c.success).toBe(true);
      expect(c.recallAccuracy).toBeGreaterThanOrEqual(0.8);
      expect(c.obsoleteDropAccuracy).toBeGreaterThanOrEqual(0.8);
    }
  });

  it("marks a missed-recall case as failed with diagnostic notes", async () => {
    const [result] = await runSmartAgentEvalHarness({ profiles: ["fast"], cases: [failingCase], createAgent: makeAgent });
    const c = result.cases[0];
    expect(c.success).toBe(false);
    expect(c.recallAccuracy).toBeLessThan(0.8);
    expect(c.notes.length).toBeGreaterThan(0);
  });
});
