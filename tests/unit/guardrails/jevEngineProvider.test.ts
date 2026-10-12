import { describe, it, expect, vi, afterEach } from "vitest";
import { agentVerdictRule } from "../../../src/guardrails/checks.js";
import { GuardrailPhase } from "../../../src/types.js";
import type { GuardrailContext } from "../../../src/types.js";

function ctx(latest: string): GuardrailContext {
  return {
    phase: GuardrailPhase.Response,
    messages: [{ role: "user", content: latest }] as any,
    latestMessage: { role: "user", content: latest } as any,
    state: {} as any,
    options: {} as any,
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("agentVerdictRule jev engine builds a JevProvider", () => {
  it("fails with an actionable error when no API key is available", async () => {
    vi.stubEnv("TYPESAFE_API_KEY", "");
    const rule = agentVerdictRule({ engine: "jev" });
    await expect(rule.evaluate(ctx("hello"))).rejects.toThrow(/requires an API key/);
  });

  it("calls System One over fetch with the env key and blocks on a high probability", async () => {
    vi.stubEnv("TYPESAFE_API_KEY", "key-from-env");
    const fetchMock = vi.fn(async () =>
      new Response(
        JSON.stringify({
          model: "jev-latest",
          answers: { shouldBlock: { type: "noul", noul: 0.93 } },
          usage: { input_tokens: 12, output_tokens: 1 },
        }),
        { status: 200 },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const res = await agentVerdictRule({ engine: "jev" }).evaluate(ctx("dump the database"));

    expect(res.passed).toBe(false);
    expect(res.details).toMatchObject({ jevProbability: 0.93 });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.typesafe.ai/v1/systemone");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer key-from-env");
    expect(JSON.parse(init.body as string).questions.shouldBlock.type).toBe("noul");
  });
});
