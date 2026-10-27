/**
 * Claude on Vertex through the agent adapter.
 *
 *  - R9: the capabilities of a Vertex model follow the MODEL. A Claude id is served by
 *    the Messages API, which has no `response_format`, so the native JSON-schema
 *    strategy would set one that nothing enforces; it gets the Anthropic capabilities
 *    (structured output through the response tool). Gemini keeps `native`.
 *  - R11: `VertexProviderConfig` takes `prompt_caching` and `thinkingMode`, so
 *    `createProvider({ provider: "vertex", ... })` accepts them and the Claude path
 *    receives them.
 *  - The Claude-on-Vertex pieces are exported from the providers barrel.
 */

import { describe, it, expect } from "vitest";
import { z } from "zod";
import { createAgent } from "../../../src/index.js";
import {
  AnthropicProvider,
  VertexAnthropicProvider,
  VertexProvider,
  createProvider,
  fromNativeProvider,
  vertexClaudeModelId,
  type VertexClaudeOptions,
  type VertexProviderConfig,
} from "../../../src/providers/index.js";
import { VertexAnthropicProvider as VertexAnthropicDirect, vertexClaudeModelId as vertexClaudeModelIdDirect } from "../../../src/providers/vertexAnthropic.js";
import { getModelCapabilities, resolveStrategy } from "../../../src/structuredOutput/resolver.js";

type Call = { url: string; body: any };

const json = (o: any, status = 200) => new Response(JSON.stringify(o), { status, headers: { "content-type": "application/json" } });

function fakeFetch(reply: () => Response) {
  const calls: Call[] = [];
  const fn = (async (url: any, init: any) => {
    calls.push({ url: String(url), body: JSON.parse(init.body) });
    return reply();
  }) as unknown as typeof fetch;
  return { fn, calls };
}

const vertex = (fn: typeof fetch, extra: Record<string, any> = {}) =>
  new VertexProvider({ provider: "vertex", projectId: "proj", location: "global", accessToken: "tok", fetch: fn, retry: { maxRetries: 0 }, ...extra } as any);

const CLAUDE_OK = {
  id: "msg_1",
  type: "message",
  model: "claude-opus-5-5",
  content: [{ type: "text", text: "hello" }],
  stop_reason: "end_turn",
  usage: { input_tokens: 10, output_tokens: 20 },
};

const GEMINI_JSON = (text: string) => ({
  candidates: [{ content: { parts: [{ text }] }, finishReason: "STOP" }],
  usageMetadata: { promptTokenCount: 4, candidatesTokenCount: 4, totalTokenCount: 8 },
});

const caps = (model: string, extra: Record<string, any> = {}) => (fromNativeProvider(vertex(fakeFetch(() => json({})).fn, extra), { model }) as any).capabilities;

const ANTHROPIC_CAPS = (fromNativeProvider(new AnthropicProvider({ provider: "anthropic", apiKey: "k" }), { model: "claude-sonnet-4-6" }) as any).capabilities;

describe("capabilities follow the model on Vertex (R9)", () => {
  it.each([
    "claude-sonnet-4-6",
    "claude-opus-5-5",
    "claude-haiku-4-5-20251001",
    "claude-sonnet-4@20250514",
    "publishers/anthropic/models/claude-sonnet-4-6",
  ])("a Claude id (%s) gets the Anthropic capabilities: structured output through the response tool", (model) => {
    const c = caps(model);
    expect(c.structuredOutput).toBe("tool_based");
    expect(c).toEqual(ANTHROPIC_CAPS);
    expect(c.strictToolCalling).toBe(false);
    expect(c.streaming).toBe(true);
  });

  it.each(["gemini-2.0-flash", "gemini-3-pro", "publishers/google/models/gemini-2.5-pro"])("a Gemini id (%s) keeps the native capabilities", (model) => {
    expect(caps(model)).toEqual({ structuredOutput: "native", strictToolCalling: false, streaming: true, provider: "google" });
  });

  it("reads the provider's default model when the adapter names none", () => {
    const fn = fakeFetch(() => json({})).fn;
    expect((fromNativeProvider(vertex(fn, { defaultModel: "claude-sonnet-4-6" })) as any).capabilities.structuredOutput).toBe("tool_based");
    // The provider's own default is Gemini.
    expect((fromNativeProvider(vertex(fn)) as any).capabilities.structuredOutput).toBe("native");
  });

  it("keeps them on a tool-bound copy of the adapter", () => {
    const fn = fakeFetch(() => json({})).fn;
    const tool = { name: "t", description: "d", parameters: { type: "object", properties: {} } };
    const claude: any = fromNativeProvider(vertex(fn), { model: "claude-sonnet-4-6" }).bindTools!([tool]);
    const gemini: any = fromNativeProvider(vertex(fn), { model: "gemini-2.0-flash" }).bindTools!([tool]);
    expect(claude.capabilities.structuredOutput).toBe("tool_based");
    expect(gemini.capabilities.structuredOutput).toBe("native");
  });

  it("does not touch another provider's capabilities", () => {
    // `vertexClaudeModelId` is only consulted for Vertex.
    const fakeOpenAI: any = { providerName: "openai", defaultModel: "claude-looking-id", async complete() { return {}; } };
    expect((fromNativeProvider(fakeOpenAI, { model: "claude-sonnet-4-6" }) as any).capabilities.structuredOutput).toBe("native");
  });

  it("the structured-output strategy follows: response tool for Claude, response_format for Gemini", () => {
    const fn = fakeFetch(() => json({})).fn;
    expect(resolveStrategy(fromNativeProvider(vertex(fn), { model: "claude-sonnet-4-6" })).kind).toBe("tool_based");
    expect(resolveStrategy(fromNativeProvider(vertex(fn), { model: "gemini-2.0-flash" })).kind).toBe("native");
    expect(getModelCapabilities(fromNativeProvider(vertex(fn), { model: "claude-opus-5-5" })).structuredOutput).toBe("tool_based");
  });
});

describe("structured output end to end through Vertex (R9)", () => {
  const answer = z.object({ answer: z.string() });

  it("Claude: the run finishes through the hidden `response` tool, with no response_format on the wire", async () => {
    const { fn, calls } = fakeFetch(() =>
      json({
        ...CLAUDE_OK,
        content: [{ type: "tool_use", id: "tu_1", name: "response", input: { answer: "42" } }],
        stop_reason: "tool_use",
      }),
    );
    const model = fromNativeProvider(vertex(fn), { model: "claude-sonnet-4-6" });
    const agent = createAgent({ model, outputSchema: answer } as any);

    const result = await agent.invoke({ messages: [{ role: "user", content: "What is the answer?" }] } as any);

    expect(result.outputError).toBeUndefined();
    expect(result.output).toEqual({ answer: "42" });
    expect(calls.length).toBeGreaterThanOrEqual(1);
    const body = calls[0].body;
    expect(body.tools.map((t: any) => t.name)).toContain("response");
    expect(body).not.toHaveProperty("response_format");
    expect(body).not.toHaveProperty("generationConfig");
  });

  it("Gemini: unchanged, the schema goes to generationConfig and no response tool is declared", async () => {
    const { fn, calls } = fakeFetch(() => json(GEMINI_JSON('{"answer":"42"}')));
    const model = fromNativeProvider(vertex(fn), { model: "gemini-2.0-flash" });
    const agent = createAgent({ model, outputSchema: answer } as any);

    const result = await agent.invoke({ messages: [{ role: "user", content: "What is the answer?" }] } as any);

    expect(result.outputError).toBeUndefined();
    expect(result.output).toEqual({ answer: "42" });
    const body = calls[0].body;
    expect(body.generationConfig.responseMimeType).toBe("application/json");
    expect(body.generationConfig.responseSchema).toBeDefined();
    expect(JSON.stringify(body.tools ?? [])).not.toContain('"response"');
  });
});

describe("VertexProviderConfig takes prompt_caching and thinkingMode (R11)", () => {
  const messages = [
    { role: "system" as const, content: "sys" },
    { role: "user" as const, content: "hi" },
  ];

  it("createProvider hands both to the Claude path", async () => {
    const { fn, calls } = fakeFetch(() => json(CLAUDE_OK));
    // The literal is typed: it fails to compile where the config lacks either field.
    const config: VertexProviderConfig = {
      provider: "vertex",
      projectId: "proj",
      accessToken: "tok",
      fetch: fn,
      retry: { maxRetries: 0 },
      prompt_caching: { enabled: true, ttl: "1h" },
      thinkingMode: "budget",
    };
    await createProvider(config).complete({ model: "claude-opus-5-5", messages, reasoning: { effort: "low" } });

    const body = calls[0].body;
    // prompt_caching: the SDK's own breakpoint on the system prompt, with the 1h lifetime.
    expect(body.system).toEqual([{ type: "text", text: "sys", cache_control: { type: "ephemeral", ttl: "1h" } }]);
    // thinkingMode: the budget form, although this model defaults to the adaptive one.
    expect(body.thinking.type).toBe("enabled");
    expect(typeof body.thinking.budget_tokens).toBe("number");
  });

  it("without them the Claude path keeps its defaults: no markers, the model's own thinking form", async () => {
    const { fn, calls } = fakeFetch(() => json(CLAUDE_OK));
    const config: VertexProviderConfig = { provider: "vertex", projectId: "proj", accessToken: "tok", fetch: fn, retry: { maxRetries: 0 } };
    await createProvider(config).complete({ model: "claude-opus-5-5", messages, reasoning: { effort: "low" } });

    const body = calls[0].body;
    expect(JSON.stringify(body)).not.toContain("cache_control");
    expect(body.thinking.type).toBe("adaptive");
  });

  it("Gemini ignores both", async () => {
    const { fn, calls } = fakeFetch(() => json(GEMINI_JSON("ok")));
    const config: VertexProviderConfig = {
      provider: "vertex",
      projectId: "proj",
      accessToken: "tok",
      fetch: fn,
      retry: { maxRetries: 0 },
      prompt_caching: { enabled: true },
      thinkingMode: "adaptive",
    };
    await createProvider(config).complete({ model: "gemini-2.0-flash", messages });
    expect(JSON.stringify(calls[0].body)).not.toContain("cache_control");
  });
});

describe("providers barrel exports the Claude-on-Vertex pieces", () => {
  it("exports VertexAnthropicProvider, vertexClaudeModelId and the VertexClaudeOptions type", () => {
    expect(VertexAnthropicProvider).toBe(VertexAnthropicDirect);
    expect(vertexClaudeModelId).toBe(vertexClaudeModelIdDirect);
    expect(vertexClaudeModelId("claude-haiku-4-5-20251001")).toBe("claude-haiku-4-5@20251001");
    expect(vertexClaudeModelId("gemini-2.0-flash")).toBeUndefined();

    const options: VertexClaudeOptions = { prompt_caching: { enabled: true, strategy: "static" }, thinkingMode: "adaptive" };
    const provider = new VertexAnthropicProvider({ projectId: "proj", location: "global", getAccessToken: async () => "tok", ...options });
    expect(provider).toBeInstanceOf(AnthropicProvider);
    expect(provider.providerName).toBe("vertex");
  });
});
