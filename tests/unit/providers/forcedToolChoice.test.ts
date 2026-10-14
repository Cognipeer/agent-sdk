import { describe, it, expect } from "vitest";
import { z } from "zod";
import { AnthropicProvider } from "../../../src/providers/anthropic.js";
import { BedrockProvider } from "../../../src/providers/bedrock.js";
import { supportsForcedToolChoice } from "../../../src/providers/utils/toolChoice.js";
import { ToolBasedStrategy } from "../../../src/structuredOutput/toolStrategy.js";

const OK = { id: "m", model: "x", content: [{ type: "text", text: '{"a":1}' }], stop_reason: "end_turn", usage: { input_tokens: 1, output_tokens: 1 } };
const TC_400 = { type: "error", error: { type: "invalid_request_error", message: 'tool_choice: type "tool" and "any" are not supported for this model.' } };
const OTHER_400 = { type: "error", error: { type: "invalid_request_error", message: "max_tokens too large" } };
const tools = [{ name: "response", description: "d", parameters: { type: "object", properties: { a: { type: "number" } } } }];

function make(model: string, replies: Array<{ status: number; body: any }>) {
  const bodies: any[] = [];
  const fetchMock = (async (_u: any, init: any) => {
    bodies.push(JSON.parse(init.body));
    const r = replies[Math.min(bodies.length - 1, replies.length - 1)];
    return new Response(JSON.stringify(r.body), { status: r.status });
  }) as typeof fetch;
  const p = new AnthropicProvider({ provider: "anthropic", apiKey: "k", defaultModel: model, fetch: fetchMock, retry: { maxRetries: 0 } as any });
  return { p, bodies };
}
const req = (toolChoice: any) => ({ messages: [{ role: "user" as const, content: "hi" }], tools, toolChoice });

describe("forced tool_choice", () => {
  it("model rule", () => {
    for (const m of ["claude-sonnet-5-5", "claude-opus-5-5", "claude-sonnet-5-6", "anthropic.claude-opus-5-5-v1:0", "claude-opus-6-0"]) expect(supportsForcedToolChoice(m)).toBe(false);
    for (const m of ["claude-haiku-5-5", "claude-sonnet-4-20250514", "claude-opus-4-1", "claude-3-7-sonnet-20250219", "gpt-5", undefined]) expect(supportsForcedToolChoice(m)).toBe(true);
  });

  it("maps required/specific to auto on sonnet-5-5, keeps them on haiku", async () => {
    for (const tc of ["required", { name: "response" }]) {
      const s = make("claude-sonnet-5-5", [{ status: 200, body: OK }]);
      await s.p.complete(req(tc));
      expect(s.bodies[0].tool_choice).toEqual({ type: "auto" });
      const h = make("claude-haiku-5-5", [{ status: 200, body: OK }]);
      await h.p.complete(req(tc));
      expect(h.bodies[0].tool_choice).toEqual(tc === "required" ? { type: "any" } : { type: "tool", name: "response" });
    }
  });

  it("retries once with auto on the specific 400 (unknown model)", async () => {
    const { p, bodies } = make("claude-custom-alias", [{ status: 400, body: TC_400 }, { status: 200, body: OK }]);
    await p.complete(req({ name: "response" }));
    expect(bodies).toHaveLength(2);
    expect(bodies[0].tool_choice).toEqual({ type: "tool", name: "response" });
    expect(bodies[1].tool_choice).toEqual({ type: "auto" });
  });

  it("does not retry on other 400s or twice", async () => {
    const a = make("claude-custom-alias", [{ status: 400, body: OTHER_400 }]);
    await expect(a.p.complete(req("required"))).rejects.toThrow();
    expect(a.bodies).toHaveLength(1);
    const b = make("claude-custom-alias", [{ status: 400, body: TC_400 }]);
    await expect(b.p.complete(req("required"))).rejects.toThrow();
    expect(b.bodies).toHaveLength(2);
  });

  it("bedrock maps and retries", async () => {
    const bodies: any[] = [];
    const replies = [{ status: 400, body: TC_400 }, { status: 200, body: { output: { message: { role: "assistant", content: [{ text: "x" }] } }, stopReason: "end_turn", usage: { inputTokens: 1, outputTokens: 1 } } }];
    let skip = 1;
    const mk = (model: string) => new BedrockProvider({
      provider: "bedrock", region: "us-east-1", accessKeyId: "AK", secretAccessKey: "SK", defaultModel: model,
      fetch: (async (_u: any, init: any) => { bodies.push(JSON.parse(init.body)); const r = replies[Math.min(bodies.length - 1 + skip, 1)]; return new Response(JSON.stringify(r.body), { status: r.status }); }) as any,
      retry: { maxRetries: 0 },
    } as any);
    await mk("anthropic.claude-sonnet-5-5-v1:0").complete(req("required") as any);
    expect(bodies[0].toolConfig.toolChoice).toEqual({ auto: {} });
    bodies.length = 0;
    skip = 0;
    await mk("anthropic.claude-custom").complete(req("required") as any);
    expect(bodies).toHaveLength(2);
    expect(bodies[0].toolConfig.toolChoice).toEqual({ any: {} });
    expect(bodies[1].toolConfig.toolChoice).toEqual({ auto: {} });
  });

  it("structured output tool_based: text answer without the tool call still parses", async () => {
    const { p, bodies } = make("claude-sonnet-5-5", [{ status: 200, body: OK }]);
    const res = await p.complete(req({ name: "response" }));
    expect(bodies[0].tool_choice).toEqual({ type: "auto" });
    expect(res.toolCalls ?? []).toHaveLength(0);
    const out = new ToolBasedStrategy().extractFromText(String((res as any).content), z.object({ a: z.number() }));
    expect(out).toEqual({ data: { a: 1 } });
  });
});
