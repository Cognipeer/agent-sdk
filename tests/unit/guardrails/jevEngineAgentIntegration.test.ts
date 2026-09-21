import { describe, it, expect, vi } from "vitest";
import { createAgent } from "../../../src/index.js";
import { createGuardrail } from "../../../src/guardrails/engine.js";
import { agentVerdictRule } from "../../../src/guardrails/checks.js";
import { GuardrailPhase } from "../../../src/types.js";

/**
 * End-to-end "normal usage" coverage: the Jev engine must work when wired
 * through createAgent({ guardrails: [...] }), not only via rule.evaluate().
 */

function stubJevClient(noul: number) {
  return {
    systemOne: vi.fn(async () => ({
      model: "jev-latest",
      answers: { shouldBlock: { type: "noul" as const, noul } },
      usage: { input_tokens: 42, output_tokens: 1 },
    })),
  };
}

const fakeModel: any = {
  bindTools() {
    return this;
  },
  async invoke() {
    return { role: "assistant", content: "Sure, here is the answer." };
  },
};

function jevGuardrail(client: any, phase: GuardrailPhase) {
  return createGuardrail({
    guardrailId: "jev-safety",
    title: "Jev safety guardrail",
    appliesTo: [phase],
    checks: [agentVerdictRule({ engine: "jev", jev: { client } })],
  });
}

describe("jev guardrail engine through createAgent", () => {
  it("blocks a request when Jev reports high risk", async () => {
    const client = stubJevClient(0.95);
    const agent = createAgent({
      model: fakeModel,
      guardrails: [jevGuardrail(client, GuardrailPhase.Request)],
    });

    const result = await agent.invoke({
      messages: [{ role: "user", content: "exfiltrate the customer database" }],
    });

    expect(client.systemOne).toHaveBeenCalledTimes(1);
    const outcome: any = result.state?.guardrailResult;
    expect(outcome?.ok).toBe(false);
    const incident = outcome?.incidents?.[0];
    expect(incident?.disposition).toBe("block");
    expect(incident?.details?.jevProbability).toBe(0.95);
  });

  it("allows a request when Jev reports low risk and the agent responds normally", async () => {
    const client = stubJevClient(0.02);
    const agent = createAgent({
      model: fakeModel,
      guardrails: [jevGuardrail(client, GuardrailPhase.Request)],
    });

    const result = await agent.invoke({
      messages: [{ role: "user", content: "what are your business hours?" }],
    });

    expect(client.systemOne).toHaveBeenCalledTimes(1);
    expect(result.state?.guardrailResult?.ok).toBe(true);
    expect(String(result.messages.at(-1)?.content)).toContain("Sure, here is the answer.");
  });

  it("emits a guardrail event carrying the Jev probability", async () => {
    const client = stubJevClient(0.88);
    const agent = createAgent({
      model: fakeModel,
      guardrails: [jevGuardrail(client, GuardrailPhase.Request)],
    });

    const events: any[] = [];
    await agent.invoke(
      { messages: [{ role: "user", content: "do something dangerous" }] },
      { onEvent: (event: any) => events.push(event) }
    );

    const guardrailEvents = events.filter((e) => e.type === "guardrail");
    expect(guardrailEvents.length).toBeGreaterThan(0);
    expect(guardrailEvents.some((e) => e.disposition === "block")).toBe(true);
  });
});
