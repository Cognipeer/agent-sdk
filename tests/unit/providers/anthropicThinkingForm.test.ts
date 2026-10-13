import { describe, it, expect } from "vitest";
import { AnthropicProvider } from "../../../src/providers/anthropic.js";
import { supportsAdaptiveThinking, applyBedrockReasoning } from "../../../src/providers/utils/reasoning.js";

const OK = { id: "m", model: "x", content: [{ type: "text", text: "hi" }], stop_reason: "end_turn", usage: { input_tokens: 1, output_tokens: 1 } };

function make(model: string, replies: Array<{ status: number; body: any }>, thinkingMode?: "auto" | "adaptive" | "budget") {
  const bodies: any[] = [];
  const fetchMock = (async (_u: any, init: any) => {
    bodies.push(JSON.parse(init.body));
    const r = replies[Math.min(bodies.length - 1, replies.length - 1)];
    return new Response(JSON.stringify(r.body), { status: r.status });
  }) as typeof fetch;
  const p = new AnthropicProvider({ provider: "anthropic", apiKey: "k", defaultModel: model, fetch: fetchMock, thinkingMode, retry: { maxRetries: 0 } as any });
  return { p, bodies };
}
const req = (extra: any = {}) => ({ messages: [{ role: "user" as const, content: "hi" }], ...extra });
const ENABLED_400 = { type: "error", error: { type: "invalid_request_error", message: "\"thinking.type.enabled\" is not supported for this model. Use \"thinking.type.adaptive\" and \"output_config.effort\"" } };

describe("anthropic thinking form", () => {
  it("detects adaptive models by id", () => {
    for (const m of ["claude-haiku-5-5", "claude-sonnet-5-5", "claude-opus-5-5", "claude-fable-5-1", "anthropic.claude-sonnet-5-5-v1:0"]) expect(supportsAdaptiveThinking(m)).toBe(true);
    for (const m of ["claude-sonnet-4-20250514", "claude-3-7-sonnet-20250219", "claude-opus-4-1", "gpt-5"]) expect(supportsAdaptiveThinking(m)).toBe(false);
  });

  it("sends adaptive + output_config.effort for 5.x (minimal -> low)", async () => {
    const { p, bodies } = make("claude-haiku-5-5", [{ status: 200, body: OK }]);
    await p.complete(req({ reasoning: { effort: "minimal" }, temperature: 0.2 }));
    expect(bodies[0].thinking).toEqual({ type: "adaptive", display: "summarized" });
    expect(bodies[0].output_config).toEqual({ effort: "low" });
    expect(bodies[0].temperature).toBeUndefined();
  });

  it("keeps the budget form for legacy models", async () => {
    const { p, bodies } = make("claude-sonnet-4-20250514", [{ status: 200, body: OK }]);
    await p.complete(req({ reasoning: { effort: "medium" } }));
    expect(bodies[0].thinking).toEqual({ type: "enabled", budget_tokens: 8192 });
    expect(bodies[0].output_config).toBeUndefined();
  });

  it("thinkingMode overrides detection", async () => {
    const { p, bodies } = make("claude-sonnet-4-20250514", [{ status: 200, body: OK }], "adaptive");
    await p.complete(req({ reasoning: { effort: "high" } }));
    expect(bodies[0].thinking).toEqual({ type: "adaptive", display: "summarized" });
    expect(bodies[0].output_config.effort).toBe("high");
  });

  it("effort none sends no thinking", async () => {
    const { p, bodies } = make("claude-opus-5-5", [{ status: 200, body: OK }]);
    await p.complete(req({ reasoning: { effort: "none" } }));
    expect(bodies[0].thinking).toBeUndefined();
    expect(bodies[0].output_config).toBeUndefined();
  });

  it("retries once with adaptive on the enabled-not-supported 400", async () => {
    const { p, bodies } = make("claude-custom-alias", [{ status: 400, body: ENABLED_400 }, { status: 200, body: OK }]);
    await p.complete(req({ reasoning: { effort: "low" } }));
    expect(bodies).toHaveLength(2);
    expect(bodies[0].thinking.type).toBe("enabled");
    expect(bodies[1].thinking).toEqual({ type: "adaptive", display: "summarized" });
    expect(bodies[1].output_config.effort).toBe("low");
  });

  it("retries with budget when adaptive is rejected", async () => {
    const err = { error: { message: "thinking.type.adaptive is not supported for this model" } };
    const { p, bodies } = make("claude-haiku-5-5", [{ status: 400, body: err }, { status: 200, body: OK }]);
    await p.complete(req({ reasoning: { effort: "low" } }));
    expect(bodies[1].thinking.type).toBe("enabled");
  });

  it("does not retry other 400s or explicit extra.thinking", async () => {
    const a = make("claude-custom-alias", [{ status: 400, body: { error: { message: "bad" } } }]);
    await expect(a.p.complete(req({ reasoning: { effort: "low" } }))).rejects.toThrow();
    expect(a.bodies).toHaveLength(1);
    const b = make("claude-custom-alias", [{ status: 400, body: ENABLED_400 }]);
    await expect(b.p.complete(req({ extra: { thinking: { type: "enabled", budget_tokens: 2000 } }, reasoning: { effort: "low" } }))).rejects.toThrow();
    expect(b.bodies).toHaveLength(1);
    expect(b.bodies[0].thinking).toEqual({ type: "enabled", budget_tokens: 2000 });
  });

  it("bedrock mapper emits adaptive fields for 5.x", () => {
    const body: any = {};
    applyBedrockReasoning(body, { effort: "high" }, { model: "anthropic.claude-sonnet-5-5-v1:0" });
    expect(body.additionalModelRequestFields).toEqual({ thinking: { type: "adaptive", display: "summarized" }, output_config: { effort: "high" } });
  });
});
