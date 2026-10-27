/**
 * Prompt caching strategy/ttl for Anthropic (explicit prefix markers + top-level
 * automatic caching) and Bedrock Converse (cachePoint checkpoints per model
 * family), plus the Anthropic stop reason and default max_tokens changes.
 */

import { describe, it, expect } from "vitest";
import { AnthropicProvider, BedrockProvider } from "../../../src/providers/index.js";
import type { ChatCompletionRequest } from "../../../src/providers/index.js";

const ANTHROPIC_OK = {
  id: "m", model: "x", content: [{ type: "text", text: "hi" }], stop_reason: "end_turn",
  usage: { input_tokens: 1, output_tokens: 1 },
};
const BEDROCK_OK = {
  output: { message: { content: [{ text: "ok" }] } },
  stopReason: "end_turn",
  usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
};

const TOOLS = [
  { name: "t1", description: "a", parameters: { type: "object", properties: {}, additionalProperties: false } },
  { name: "t2", description: "b", parameters: { type: "object", properties: {}, additionalProperties: false } },
];

function stubFetch(reply: any) {
  const bodies: any[] = [];
  const fetchImpl = (async (_u: any, init: any) => {
    bodies.push(JSON.parse(init.body));
    return new Response(JSON.stringify(reply), { status: 200 });
  }) as typeof fetch;
  return { bodies, fetchImpl };
}

async function anthropicBody(
  caching: any,
  req: Partial<ChatCompletionRequest> = {},
  reply: any = ANTHROPIC_OK,
): Promise<any> {
  const { bodies, fetchImpl } = stubFetch(reply);
  const p = new AnthropicProvider({
    provider: "anthropic", apiKey: "k", fetch: fetchImpl, retry: { maxRetries: 0 },
    ...(caching ? { prompt_caching: caching } : {}),
  } as any);
  await p.complete({
    model: "claude-sonnet-4-20250514",
    messages: [{ role: "system", content: "sys" }, { role: "user", content: "hi" }],
    tools: TOOLS,
    ...req,
  });
  return bodies[0];
}

async function bedrockBody(
  caching: any,
  model: string,
  req: Partial<ChatCompletionRequest> = {},
): Promise<any> {
  const { bodies, fetchImpl } = stubFetch(BEDROCK_OK);
  const p = new BedrockProvider({
    provider: "bedrock", region: "us-east-1", accessKeyId: "AK", secretAccessKey: "SK",
    fetch: fetchImpl, retry: { maxRetries: 0 },
    ...(caching ? { prompt_caching: caching } : {}),
  } as any);
  await p.complete({
    model,
    messages: [{ role: "system", content: "sys" }, { role: "user", content: "hi" }],
    tools: TOOLS,
    ...req,
  });
  return bodies[0];
}

const EPH = { type: "ephemeral" };
const EPH_1H = { type: "ephemeral", ttl: "1h" };

describe("Anthropic prompt caching strategy", () => {
  it("auto (default) marks system, last tool and the top level", async () => {
    const body = await anthropicBody({ enabled: true });
    expect(body.system).toEqual([{ type: "text", text: "sys", cache_control: EPH }]);
    expect(body.tools[0]).not.toHaveProperty("cache_control");
    expect(body.tools[1].cache_control).toEqual(EPH);
    expect(body.cache_control).toEqual(EPH);
  });

  it("ttl 1h is sent on all three markers", async () => {
    const body = await anthropicBody({ enabled: true, ttl: "1h" });
    expect(body.system[0].cache_control).toEqual(EPH_1H);
    expect(body.tools[1].cache_control).toEqual(EPH_1H);
    expect(body.cache_control).toEqual(EPH_1H);
  });

  it("explicit 5m omits the ttl key", async () => {
    const body = await anthropicBody({ enabled: true, ttl: "5m" });
    expect(body.cache_control).toEqual(EPH);
    expect(body.system[0].cache_control).not.toHaveProperty("ttl");
  });

  it("static strategy keeps the 0.20 shape (no top-level field)", async () => {
    const body = await anthropicBody({ enabled: true, strategy: "static" });
    expect(body.system[0].cache_control).toEqual(EPH);
    expect(body.tools[1].cache_control).toEqual(EPH);
    expect(body).not.toHaveProperty("cache_control");
  });

  it("disabled sends no markers", async () => {
    for (const cfg of [undefined, { enabled: false, strategy: "auto", ttl: "1h" }]) {
      const body = await anthropicBody(cfg);
      expect(body.system).toBe("sys");
      expect(body.tools[1]).not.toHaveProperty("cache_control");
      expect(body).not.toHaveProperty("cache_control");
    }
  });

  it("works without system or tools (top level only)", async () => {
    const body = await anthropicBody({ enabled: true }, {
      messages: [{ role: "user", content: "hi" }],
      tools: undefined,
    });
    expect(body).not.toHaveProperty("system");
    expect(body).not.toHaveProperty("tools");
    expect(body.cache_control).toEqual(EPH);
  });

  it("leaves a caller-set extra.cache_control alone, null included", async () => {
    const custom = await anthropicBody({ enabled: true }, { extra: { cache_control: { type: "ephemeral", ttl: "1h" } } });
    expect(custom.cache_control).toEqual(EPH_1H);
    const nulled = await anthropicBody({ enabled: true }, { extra: { cache_control: null } });
    expect(nulled.cache_control).toBeNull();
  });

  it("skips the top-level field when 4 explicit markers are already present", async () => {
    const block = (text: string) => ({ type: "text", text, cache_control: EPH });
    // system + last tool = 2; two more come from `extra.messages`.
    const body = await anthropicBody({ enabled: true }, {
      extra: { messages: [{ role: "user", content: [block("a"), block("b")] }] },
    });
    expect(body).not.toHaveProperty("cache_control");
    // 3 explicit markers still leave a slot.
    const three = await anthropicBody({ enabled: true }, {
      extra: { messages: [{ role: "user", content: [block("a")] }] },
    });
    expect(three.cache_control).toEqual(EPH);
  });
});

describe("Anthropic stop reason and default max_tokens", () => {
  it("maps model_context_window_exceeded to length and keeps the raw value", async () => {
    const { fetchImpl } = stubFetch({ ...ANTHROPIC_OK, stop_reason: "model_context_window_exceeded" });
    const p = new AnthropicProvider({ provider: "anthropic", apiKey: "k", fetch: fetchImpl, retry: { maxRetries: 0 } } as any);
    const res = await p.complete({ model: "claude-sonnet-4-20250514", messages: [{ role: "user", content: "hi" }] });
    expect(res.finishReason).toBe("length");
    expect(res.rawFinishReason).toBe("model_context_window_exceeded");
  });

  it("maps it on the stream path too", async () => {
    const sse = [
      `event: message_start\ndata: ${JSON.stringify({ type: "message_start", message: { id: "m", model: "x", usage: { input_tokens: 1, output_tokens: 0 } } })}\n\n`,
      `event: message_delta\ndata: ${JSON.stringify({ type: "message_delta", delta: { stop_reason: "model_context_window_exceeded" }, usage: { output_tokens: 3 } })}\n\n`,
      `event: message_stop\ndata: ${JSON.stringify({ type: "message_stop" })}\n\n`,
    ].join("");
    const fetchImpl = (async () => new Response(sse, { status: 200, headers: { "content-type": "text/event-stream" } })) as typeof fetch;
    const p = new AnthropicProvider({ provider: "anthropic", apiKey: "k", fetch: fetchImpl, retry: { maxRetries: 0 } } as any);
    const chunks: any[] = [];
    for await (const c of p.completeStream({ model: "claude-sonnet-4-20250514", messages: [{ role: "user", content: "hi" }] })) chunks.push(c);
    const last = chunks.find((c) => c.finishReason);
    expect(last.finishReason).toBe("length");
    expect(last.rawFinishReason).toBe("model_context_window_exceeded");
  });

  it("defaults max_tokens to 16384 for adaptive-thinking models, 4096 otherwise", async () => {
    const adaptive = await anthropicBody(undefined, { model: "claude-sonnet-5-5" });
    expect(adaptive.max_tokens).toBe(16384);
    const legacy = await anthropicBody(undefined, { model: "claude-sonnet-4-20250514" });
    expect(legacy.max_tokens).toBe(4096);
  });

  it("keeps a caller-supplied maxTokens", async () => {
    const body = await anthropicBody(undefined, { model: "claude-sonnet-5-5", maxTokens: 1000 });
    expect(body.max_tokens).toBe(1000);
  });

  it("falls back to the model default when extra nulls max_tokens", async () => {
    const body = await anthropicBody(undefined, { model: "claude-sonnet-5-5", extra: { max_tokens: null } });
    expect(body.max_tokens).toBe(16384);
  });
});

describe("Bedrock Converse prompt caching strategy", () => {
  const CLAUDE = "anthropic.claude-sonnet-4-20250514-v1:0";
  const CP = { cachePoint: { type: "default" } };
  const CP_1H = { cachePoint: { type: "default", ttl: "1h" } };

  it("claude auto: system, tools and the last user message", async () => {
    const body = await bedrockBody({ enabled: true }, CLAUDE);
    expect(body.system.at(-1)).toEqual(CP);
    expect(body.toolConfig.tools.at(-1)).toEqual(CP);
    expect(body.messages.at(-1).content).toEqual([{ text: "hi" }, CP]);
  });

  it("strips a region prefix when classifying", async () => {
    for (const id of ["us.anthropic.claude-sonnet-4-20250514-v1:0", "eu.anthropic.claude-sonnet-4-20250514-v1:0", "global.anthropic.claude-sonnet-4-20250514-v1:0", "us-gov.anthropic.claude-sonnet-4-20250514-v1:0"]) {
      const body = await bedrockBody({ enabled: true }, id);
      expect(body.toolConfig.tools.at(-1)).toEqual(CP);
    }
  });

  it("static strategy skips the tail checkpoint", async () => {
    const body = await bedrockBody({ enabled: true, strategy: "static" }, CLAUDE);
    expect(body.system.at(-1)).toEqual(CP);
    expect(body.toolConfig.tools.at(-1)).toEqual(CP);
    expect(body.messages.at(-1).content).toEqual([{ text: "hi" }]);
  });

  it("disabled sends no checkpoints", async () => {
    const body = await bedrockBody(undefined, CLAUDE);
    expect(JSON.stringify(body)).not.toContain("cachePoint");
  });

  it("1h ttl is sent on every checkpoint", async () => {
    const body = await bedrockBody({ enabled: true, ttl: "1h" }, CLAUDE);
    expect(body.system.at(-1)).toEqual(CP_1H);
    expect(body.toolConfig.tools.at(-1)).toEqual(CP_1H);
    expect(body.messages.at(-1).content.at(-1)).toEqual(CP_1H);
  });

  it("nova: no tools checkpoint and never a ttl", async () => {
    for (const id of ["amazon.nova-pro-v1:0", "us.amazon.nova-lite-v1:0"]) {
      const body = await bedrockBody({ enabled: true, ttl: "1h" }, id);
      expect(body.system.at(-1)).toEqual(CP);
      expect(body.toolConfig.tools.some((t: any) => t.cachePoint)).toBe(false);
      expect(body.messages.at(-1).content.at(-1)).toEqual(CP);
      expect(JSON.stringify(body)).not.toContain("ttl");
    }
  });

  it("families without explicit caching get no checkpoints", async () => {
    for (const id of ["meta.llama3-70b-instruct-v1:0", "us.meta.llama3-3-70b-instruct-v1:0", "mistral.mistral-large-2407-v1:0", "cohere.command-r-v1:0", "deepseek.r1-v1:0", "openai.gpt-oss-120b-1:0", "amazon.titan-text-express-v1"]) {
      const body = await bedrockBody({ enabled: true }, id);
      expect(JSON.stringify(body)).not.toContain("cachePoint");
    }
  });

  it("unknown ids (ARN / application profile) are treated like claude", async () => {
    const arn = "arn:aws:bedrock:us-east-1:123456789012:application-inference-profile/abc123";
    const body = await bedrockBody({ enabled: true }, arn);
    expect(body.system.at(-1)).toEqual(CP);
    expect(body.toolConfig.tools.at(-1)).toEqual(CP);
    expect(body.messages.at(-1).content.at(-1)).toEqual(CP);
  });

  it("skips the tail checkpoint when the last message is an assistant message", async () => {
    const body = await bedrockBody({ enabled: true }, CLAUDE, {
      messages: [
        { role: "system", content: "sys" },
        { role: "user", content: "hi" },
        { role: "assistant", content: "prefill" },
      ],
    });
    expect(body.messages.at(-1).role).toBe("assistant");
    expect(JSON.stringify(body.messages)).not.toContain("cachePoint");
    expect(body.system.at(-1)).toEqual(CP);
  });

  it("puts the tail checkpoint after the merged toolResult blocks", async () => {
    const body = await bedrockBody({ enabled: true }, CLAUDE, {
      messages: [
        { role: "system", content: "sys" },
        { role: "user", content: "hi" },
        { role: "assistant", content: "", toolCalls: [{ id: "c1", name: "t1", arguments: "{}" }, { id: "c2", name: "t2", arguments: "{}" }] },
        { role: "tool", toolCallId: "c1", content: "r1" },
        { role: "tool", toolCallId: "c2", content: "r2" },
      ] as any,
    });
    const last = body.messages.at(-1);
    expect(last.role).toBe("user");
    expect(last.content).toHaveLength(3);
    expect(last.content[0].toolResult).toBeDefined();
    expect(last.content[1].toolResult).toBeDefined();
    expect(last.content[2]).toEqual(CP);
    // earlier messages stay untouched
    expect(JSON.stringify(body.messages.slice(0, -1))).not.toContain("cachePoint");
  });

  it("never exceeds 4 checkpoints", async () => {
    const body = await bedrockBody({ enabled: true, ttl: "1h" }, CLAUDE);
    expect((JSON.stringify(body).match(/cachePoint/g) ?? []).length).toBeLessThanOrEqual(4);
  });

  it("works without system or tools", async () => {
    const body = await bedrockBody({ enabled: true }, CLAUDE, {
      messages: [{ role: "user", content: "hi" }],
      tools: undefined,
    });
    expect(body).not.toHaveProperty("system");
    expect(body).not.toHaveProperty("toolConfig");
    expect(body.messages[0].content).toEqual([{ text: "hi" }, CP]);
  });
});
