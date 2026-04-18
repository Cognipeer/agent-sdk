/**
 * Unit Tests for native LLM providers.
 * Tests message conversion, request building, response parsing, usage extraction,
 * factory, and adapter – all using mocked fetch (no real API calls).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { z } from "zod";
import { createAgent } from "../../../src/agent.js";
import { createTool } from "../../../src/tool.js";
import {
  createProvider,
  fromNativeProvider,
  OpenAIProvider,
  AnthropicProvider,
  AzureProvider,
  OpenAICompatibleProvider,
  BedrockProvider,
  VertexProvider,
  ProviderError,
  emptyUsage,
} from "../../../src/providers/index.js";
import type {
  ChatCompletionRequest,
  ChatCompletionResponse,
  UnifiedMessage,
  TokenUsage,
} from "../../../src/providers/types.js";

// ─── Mock fetch ──────────────────────────────────────────────────────────────

const originalFetch = globalThis.fetch;

function mockFetch(response: any, status = 200) {
  return vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    json: async () => response,
    text: async () => JSON.stringify(response),
    headers: new Headers({ "content-type": "application/json" }),
    body: null,
  } as any);
}

function mockFetchSequence(responses: Array<{ response: any; status?: number }>) {
  const fn = vi.fn();
  for (const entry of responses) {
    fn.mockResolvedValueOnce({
      ok: (entry.status ?? 200) >= 200 && (entry.status ?? 200) < 300,
      status: entry.status ?? 200,
      json: async () => entry.response,
      text: async () => JSON.stringify(entry.response),
      headers: new Headers({ "content-type": "application/json" }),
      body: null,
    } as any);
  }
  return fn;
}

// ─── Fixtures ────────────────────────────────────────────────────────────────

const simpleRequest: ChatCompletionRequest = {
  model: "test-model",
  messages: [
    { role: "system", content: "You are helpful." },
    { role: "user", content: "Hello!" },
  ],
  temperature: 0.7,
  maxTokens: 100,
};

const requestWithTools: ChatCompletionRequest = {
  ...simpleRequest,
  tools: [
    {
      name: "get_weather",
      description: "Get weather for a city",
      parameters: {
        type: "object",
        properties: { city: { type: "string" } },
        required: ["city"],
      },
    },
  ],
  toolChoice: "auto",
};

const requestWithImages: ChatCompletionRequest = {
  model: "test-model",
  messages: [
    {
      role: "user",
      content: [
        { type: "text", text: "What is in this image?" },
        { type: "image", source: { type: "base64", mediaType: "image/png", data: "iVBOR..." } },
      ],
    },
  ],
};

// ─── Types ───────────────────────────────────────────────────────────────────

describe("Types", () => {
  it("emptyUsage should return zeroed usage", () => {
    const usage = emptyUsage();
    expect(usage.inputTokens).toBe(0);
    expect(usage.outputTokens).toBe(0);
    expect(usage.totalTokens).toBe(0);
    expect(usage.cachedInputTokens).toBe(0);
    expect(usage.cachedWriteTokens).toBe(0);
    expect(usage.cachedOutputTokens).toBe(0);
    expect(usage.reasoningTokens).toBe(0);
  });

  it("ProviderError should include metadata", () => {
    const err = new ProviderError("test error", "openai", 429, { error: "rate limit" });
    expect(err.message).toBe("test error");
    expect(err.provider).toBe("openai");
    expect(err.statusCode).toBe(429);
    expect(err.responseBody).toEqual({ error: "rate limit" });
    expect(err.name).toBe("ProviderError");
  });
});

// ─── OpenAI Provider ─────────────────────────────────────────────────────────

describe("OpenAIProvider", () => {
  let provider: OpenAIProvider;

  beforeEach(() => {
    provider = new OpenAIProvider({
      provider: "openai",
      apiKey: "test-key",
      defaultModel: "gpt-4o",
    });
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("should send correct request and parse response", async () => {
    const apiResponse = {
      id: "chatcmpl-123",
      model: "gpt-4o",
      choices: [
        {
          message: { role: "assistant", content: "Hello! How can I help?" },
          finish_reason: "stop",
        },
      ],
      usage: {
        prompt_tokens: 10,
        completion_tokens: 8,
        total_tokens: 18,
        prompt_tokens_details: { cached_tokens: 5 },
        completion_tokens_details: { reasoning_tokens: 2 },
      },
    };

    globalThis.fetch = mockFetch(apiResponse);
    const result = await provider.complete(simpleRequest);

    expect(result.id).toBe("chatcmpl-123");
    expect(result.model).toBe("gpt-4o");
    expect(result.content).toBe("Hello! How can I help?");
    expect(result.finishReason).toBe("stop");
    expect(result.toolCalls).toEqual([]);
    expect(result.usage.inputTokens).toBe(10);
    expect(result.usage.outputTokens).toBe(8);
    expect(result.usage.totalTokens).toBe(18);
    expect(result.usage.cachedInputTokens).toBe(5);
    expect(result.usage.reasoningTokens).toBe(2);

    // Verify fetch was called with correct URL and headers
    const call = (globalThis.fetch as any).mock.calls[0];
    expect(call[0]).toBe("https://api.openai.com/v1/chat/completions");
    expect(call[1].headers.Authorization).toBe("Bearer test-key");
  });

  it("should handle tool calls in response", async () => {
    const apiResponse = {
      id: "chatcmpl-456",
      model: "gpt-4o",
      choices: [
        {
          message: {
            role: "assistant",
            content: null,
            tool_calls: [
              {
                id: "call_abc",
                type: "function",
                function: {
                  name: "get_weather",
                  arguments: '{"city":"London"}',
                },
              },
            ],
          },
          finish_reason: "tool_calls",
        },
      ],
      usage: { prompt_tokens: 20, completion_tokens: 15, total_tokens: 35 },
    };

    globalThis.fetch = mockFetch(apiResponse);
    const result = await provider.complete(requestWithTools);

    expect(result.finishReason).toBe("tool_calls");
    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls[0].id).toBe("call_abc");
    expect(result.toolCalls[0].name).toBe("get_weather");
    expect(result.toolCalls[0].arguments).toBe('{"city":"London"}');
  });

  it("should handle image content in messages", async () => {
    const apiResponse = {
      id: "chatcmpl-789",
      model: "gpt-4o",
      choices: [{ message: { role: "assistant", content: "A cat" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 100, completion_tokens: 2, total_tokens: 102 },
    };

    globalThis.fetch = mockFetch(apiResponse);
    await provider.complete(requestWithImages);

    const call = (globalThis.fetch as any).mock.calls[0];
    const body = JSON.parse(call[1].body);
    const userMsg = body.messages[0];

    expect(userMsg.content).toHaveLength(2);
    expect(userMsg.content[0].type).toBe("text");
    expect(userMsg.content[1].type).toBe("image_url");
    expect(userMsg.content[1].image_url.url).toContain("data:image/png;base64,");
  });

  it("should throw ProviderError on API failure", async () => {
    globalThis.fetch = mockFetch({ error: "rate limited" }, 429);

    await expect(provider.complete(simpleRequest)).rejects.toThrow(ProviderError);
    await expect(provider.complete(simpleRequest)).rejects.toMatchObject({
      statusCode: 429,
    });
  });

  it("should handle response_format for structured output", async () => {
    const apiResponse = {
      id: "chatcmpl-so",
      model: "gpt-4o",
      choices: [{ message: { role: "assistant", content: '{"name":"test"}' }, finish_reason: "stop" }],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    };

    globalThis.fetch = mockFetch(apiResponse);
    await provider.complete({
      ...simpleRequest,
      responseFormat: {
        type: "json_schema",
        name: "test_output",
        schema: { type: "object", properties: { name: { type: "string" } } },
      },
    });

    const call = (globalThis.fetch as any).mock.calls[0];
    const body = JSON.parse(call[1].body);
    expect(body.response_format.type).toBe("json_schema");
    expect(body.response_format.json_schema.name).toBe("test_output");
    expect(body.response_format.json_schema.strict).toBe(true);
  });

  it("should include tool_choice in request body", async () => {
    const apiResponse = {
      id: "chatcmpl-tc",
      model: "gpt-4o",
      choices: [{ message: { role: "assistant", content: null, tool_calls: [] }, finish_reason: "stop" }],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    };

    globalThis.fetch = mockFetch(apiResponse);
    await provider.complete({
      ...requestWithTools,
      toolChoice: { name: "get_weather" },
    });

    const call = (globalThis.fetch as any).mock.calls[0];
    const body = JSON.parse(call[1].body);
    expect(body.tool_choice).toEqual({ type: "function", function: { name: "get_weather" } });
  });
});

// ─── Anthropic Provider ──────────────────────────────────────────────────────

describe("AnthropicProvider", () => {
  let provider: AnthropicProvider;

  beforeEach(() => {
    provider = new AnthropicProvider({
      provider: "anthropic",
      apiKey: "test-key",
      defaultModel: "claude-sonnet-4-20250514",
    });
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("should separate system messages and parse response", async () => {
    const apiResponse = {
      id: "msg_123",
      type: "message",
      role: "assistant",
      content: [{ type: "text", text: "Hello from Claude!" }],
      model: "claude-sonnet-4-20250514",
      stop_reason: "end_turn",
      usage: {
        input_tokens: 15,
        output_tokens: 5,
        cache_read_input_tokens: 3,
        cache_creation_input_tokens: 10,
      },
    };

    globalThis.fetch = mockFetch(apiResponse);
    const result = await provider.complete(simpleRequest);

    expect(result.id).toBe("msg_123");
    expect(result.content).toBe("Hello from Claude!");
    expect(result.finishReason).toBe("stop");
    expect(result.usage.inputTokens).toBe(15);
    expect(result.usage.outputTokens).toBe(5);
    expect(result.usage.cachedInputTokens).toBe(3);
    expect(result.usage.cachedWriteTokens).toBe(10);

    // Verify system message is extracted
    const call = (globalThis.fetch as any).mock.calls[0];
    const body = JSON.parse(call[1].body);
    expect(body.system).toBe("You are helpful.");
    expect(body.messages).toHaveLength(1);
    expect(body.messages[0].role).toBe("user");

    // Verify headers
    expect(call[1].headers["x-api-key"]).toBe("test-key");
    expect(call[1].headers["anthropic-version"]).toBe("2023-06-01");
  });

  it("should handle tool use in response", async () => {
    const apiResponse = {
      id: "msg_456",
      type: "message",
      role: "assistant",
      content: [
        { type: "text", text: "Let me check the weather." },
        { type: "tool_use", id: "toolu_123", name: "get_weather", input: { city: "London" } },
      ],
      model: "claude-sonnet-4-20250514",
      stop_reason: "tool_use",
      usage: { input_tokens: 20, output_tokens: 30 },
    };

    globalThis.fetch = mockFetch(apiResponse);
    const result = await provider.complete(requestWithTools);

    expect(result.finishReason).toBe("tool_calls");
    expect(result.content).toBe("Let me check the weather.");
    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls[0].id).toBe("toolu_123");
    expect(result.toolCalls[0].name).toBe("get_weather");
    expect(JSON.parse(result.toolCalls[0].arguments)).toEqual({ city: "London" });
  });

  it("should convert tool result messages correctly", async () => {
    const apiResponse = {
      id: "msg_789",
      content: [{ type: "text", text: "It's 22°C" }],
      stop_reason: "end_turn",
      usage: { input_tokens: 30, output_tokens: 5 },
    };

    globalThis.fetch = mockFetch(apiResponse);
    await provider.complete({
      model: "claude-sonnet-4-20250514",
      messages: [
        { role: "user", content: "What's the weather?" },
        {
          role: "assistant",
          content: "",
          toolCalls: [{ id: "toolu_1", name: "get_weather", arguments: '{"city":"London"}' }],
        },
        { role: "tool", content: '{"temp":22}', toolCallId: "toolu_1" },
      ],
    });

    const call = (globalThis.fetch as any).mock.calls[0];
    const body = JSON.parse(call[1].body);
    // Tool result should be converted to user message with tool_result content
    const toolResultMsg = body.messages[2];
    expect(toolResultMsg.role).toBe("user");
    expect(toolResultMsg.content[0].type).toBe("tool_result");
    expect(toolResultMsg.content[0].tool_use_id).toBe("toolu_1");
  });

  it("should convert tool choice correctly", async () => {
    const apiResponse = {
      id: "msg_tc",
      content: [{ type: "text", text: "ok" }],
      stop_reason: "end_turn",
      usage: { input_tokens: 10, output_tokens: 1 },
    };

    globalThis.fetch = mockFetch(apiResponse);

    // Test "required" → "any"
    await provider.complete({ ...requestWithTools, toolChoice: "required" });
    let body = JSON.parse((globalThis.fetch as any).mock.calls[0][1].body);
    expect(body.tool_choice).toEqual({ type: "any" });

    // Test specific tool
    globalThis.fetch = mockFetch(apiResponse);
    await provider.complete({ ...requestWithTools, toolChoice: { name: "get_weather" } });
    body = JSON.parse((globalThis.fetch as any).mock.calls[0][1].body);
    expect(body.tool_choice).toEqual({ type: "tool", name: "get_weather" });
  });
});

// ─── Azure Provider ──────────────────────────────────────────────────────────

describe("AzureProvider", () => {
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("should use Azure URL format with deployment and api-version", async () => {
    const provider = new AzureProvider({
      provider: "azure",
      apiKey: "azure-key",
      endpoint: "https://my-resource.openai.azure.com",
      deploymentName: "my-gpt4",
      apiVersion: "2024-10-21",
    });

    const apiResponse = {
      id: "chatcmpl-az1",
      model: "gpt-4o",
      choices: [{ message: { role: "assistant", content: "Hello from Azure!" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    };

    globalThis.fetch = mockFetch(apiResponse);
    await provider.complete(simpleRequest);

    const call = (globalThis.fetch as any).mock.calls[0];
    expect(call[0]).toContain("my-resource.openai.azure.com");
    expect(call[0]).toContain("/openai/deployments/my-gpt4/");
    expect(call[0]).toContain("api-version=2024-10-21");
    expect(call[1].headers["api-key"]).toBe("azure-key");
    // model should not be in body
    const body = JSON.parse(call[1].body);
    expect(body.model).toBeUndefined();
  });
});

// ─── OpenAI-Compatible Provider ──────────────────────────────────────────────

describe("OpenAICompatibleProvider", () => {
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("should use custom baseURL", async () => {
    const provider = new OpenAICompatibleProvider({
      provider: "openai-compatible",
      apiKey: "custom-key",
      baseURL: "https://my-llm-proxy.com/v1",
      defaultModel: "llama-3",
    });

    const apiResponse = {
      id: "chatcmpl-oc1",
      model: "llama-3",
      choices: [{ message: { role: "assistant", content: "Hi!" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 5, completion_tokens: 1, total_tokens: 6 },
    };

    globalThis.fetch = mockFetch(apiResponse);
    const result = await provider.complete({
      ...simpleRequest,
      model: "llama-3",
    });

    const call = (globalThis.fetch as any).mock.calls[0];
    expect(call[0]).toBe("https://my-llm-proxy.com/v1/chat/completions");
    expect(result.model).toBe("llama-3");
  });
});

// ─── Bedrock Provider ────────────────────────────────────────────────────────

describe("BedrockProvider", () => {
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("should build Converse API request format", async () => {
    const provider = new BedrockProvider({
      provider: "bedrock",
      region: "us-east-1",
      accessKeyId: "AKID",
      secretAccessKey: "secret",
      defaultModel: "anthropic.claude-sonnet-4-20250514-v1:0",
    });

    const apiResponse = {
      output: {
        message: {
          role: "assistant",
          content: [{ text: "Hello from Bedrock!" }],
        },
      },
      stopReason: "end_turn",
      usage: {
        inputTokens: 12,
        outputTokens: 5,
        totalTokens: 17,
        cacheReadInputTokenCount: 4,
        cacheWriteInputTokenCount: 8,
      },
      requestId: "req-123",
    };

    globalThis.fetch = mockFetch(apiResponse);
    const result = await provider.complete(simpleRequest);

    expect(result.content).toBe("Hello from Bedrock!");
    expect(result.finishReason).toBe("stop");
    expect(result.usage.inputTokens).toBe(12);
    expect(result.usage.outputTokens).toBe(5);
    expect(result.usage.cachedInputTokens).toBe(4);
    expect(result.usage.cachedWriteTokens).toBe(8);

    // Verify request format
    const call = (globalThis.fetch as any).mock.calls[0];
    expect(call[0]).toContain("bedrock-runtime.us-east-1.amazonaws.com");
    expect(call[0]).toContain("/converse");

    const body = JSON.parse(call[1].body);
    expect(body.system).toHaveLength(1);
    expect(body.system[0].text).toBe("You are helpful.");
    expect(body.messages).toHaveLength(1);
    expect(body.messages[0].content[0].text).toBe("Hello!");
  });

  it("should handle tool use in Bedrock format", async () => {
    const provider = new BedrockProvider({
      provider: "bedrock",
      region: "us-east-1",
      accessKeyId: "AKID",
      secretAccessKey: "secret",
    });

    const apiResponse = {
      output: {
        message: {
          role: "assistant",
          content: [
            { text: "Let me check" },
            { toolUse: { toolUseId: "tu_1", name: "get_weather", input: { city: "Paris" } } },
          ],
        },
      },
      stopReason: "tool_use",
      usage: { inputTokens: 20, outputTokens: 15, totalTokens: 35 },
    };

    globalThis.fetch = mockFetch(apiResponse);
    const result = await provider.complete(requestWithTools);

    expect(result.finishReason).toBe("tool_calls");
    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls[0].name).toBe("get_weather");
    expect(JSON.parse(result.toolCalls[0].arguments)).toEqual({ city: "Paris" });
  });

  it("should throw when credentials are missing", () => {
    const originalEnv = { ...process.env };
    delete process.env.AWS_ACCESS_KEY_ID;
    delete process.env.AWS_SECRET_ACCESS_KEY;

    expect(
      () =>
        new BedrockProvider({
          provider: "bedrock",
          region: "us-east-1",
        }),
    ).toThrow(ProviderError);

    process.env = originalEnv;
  });
});

// ─── Vertex Provider ─────────────────────────────────────────────────────────

describe("VertexProvider", () => {
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("should build Gemini API request format", async () => {
    const provider = new VertexProvider({
      provider: "vertex",
      projectId: "my-project",
      location: "us-central1",
      accessToken: "gcp-token",
      defaultModel: "gemini-2.0-flash",
    });

    const apiResponse = {
      candidates: [
        {
          content: {
            role: "model",
            parts: [{ text: "Hello from Gemini!" }],
          },
          finishReason: "STOP",
        },
      ],
      usageMetadata: {
        promptTokenCount: 10,
        candidatesTokenCount: 5,
        totalTokenCount: 15,
        cachedContentTokenCount: 2,
      },
    };

    globalThis.fetch = mockFetch(apiResponse);
    const result = await provider.complete(simpleRequest);

    expect(result.content).toBe("Hello from Gemini!");
    expect(result.finishReason).toBe("stop");
    expect(result.usage.inputTokens).toBe(10);
    expect(result.usage.outputTokens).toBe(5);
    expect(result.usage.cachedInputTokens).toBe(2);

    // Verify URL format
    const call = (globalThis.fetch as any).mock.calls[0];
    expect(call[0]).toContain("us-central1-aiplatform.googleapis.com");
    expect(call[0]).toContain("/projects/my-project/");
    expect(call[0]).toContain(":generateContent");
    expect(call[1].headers.Authorization).toBe("Bearer gcp-token");

    // Verify body format
    const body = JSON.parse(call[1].body);
    expect(body.systemInstruction.parts[0].text).toBe("You are helpful.");
    expect(body.contents).toHaveLength(1);
    expect(body.contents[0].parts[0].text).toBe("Hello!");
    expect(body.generationConfig.temperature).toBe(0.7);
    expect(body.generationConfig.maxOutputTokens).toBe(100);
  });

  it("should handle function calls in Gemini format", async () => {
    const provider = new VertexProvider({
      provider: "vertex",
      projectId: "my-project",
      accessToken: "token",
    });

    const apiResponse = {
      candidates: [
        {
          content: {
            role: "model",
            parts: [
              { text: "Let me check" },
              { functionCall: { name: "get_weather", args: { city: "Tokyo" } } },
            ],
          },
          finishReason: "STOP",
        },
      ],
      usageMetadata: { promptTokenCount: 20, candidatesTokenCount: 10, totalTokenCount: 30 },
    };

    globalThis.fetch = mockFetch(apiResponse);
    const result = await provider.complete(requestWithTools);

    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls[0].name).toBe("get_weather");
    expect(JSON.parse(result.toolCalls[0].arguments)).toEqual({ city: "Tokyo" });
  });
});

// ─── Factory ─────────────────────────────────────────────────────────────────

describe("createProvider factory", () => {
  it("should create OpenAI provider", () => {
    const p = createProvider({ provider: "openai", apiKey: "key" });
    expect(p).toBeInstanceOf(OpenAIProvider);
    expect(p.providerName).toBe("openai");
  });

  it("should create Anthropic provider", () => {
    const p = createProvider({ provider: "anthropic", apiKey: "key" });
    expect(p).toBeInstanceOf(AnthropicProvider);
    expect(p.providerName).toBe("anthropic");
  });

  it("should create Azure provider", () => {
    const p = createProvider({
      provider: "azure",
      apiKey: "key",
      endpoint: "https://test.openai.azure.com",
    });
    expect(p).toBeInstanceOf(AzureProvider);
    expect(p.providerName).toBe("azure");
  });

  it("should create OpenAI-compatible provider", () => {
    const p = createProvider({
      provider: "openai-compatible",
      apiKey: "key",
      baseURL: "https://custom.api.com/v1",
    });
    expect(p).toBeInstanceOf(OpenAICompatibleProvider);
    expect(p.providerName).toBe("openai-compatible");
  });

  it("should create Bedrock provider", () => {
    const p = createProvider({
      provider: "bedrock",
      region: "us-east-1",
      accessKeyId: "AKID",
      secretAccessKey: "secret",
    });
    expect(p).toBeInstanceOf(BedrockProvider);
    expect(p.providerName).toBe("bedrock");
  });

  it("should create Vertex provider", () => {
    const p = createProvider({
      provider: "vertex",
      projectId: "my-project",
      accessToken: "token",
    });
    expect(p).toBeInstanceOf(VertexProvider);
    expect(p.providerName).toBe("vertex");
  });

  it("should throw on unknown provider", () => {
    expect(() => createProvider({ provider: "unknown" as any } as any)).toThrow("Unknown provider");
  });
});

// ─── Adapter ─────────────────────────────────────────────────────────────────

describe("fromNativeProvider adapter", () => {
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("should wrap provider as BaseChatModel and invoke correctly", async () => {
    const provider = new OpenAIProvider({
      provider: "openai",
      apiKey: "test-key",
    });

    const apiResponse = {
      id: "chatcmpl-adapt",
      model: "gpt-4o",
      choices: [
        { message: { role: "assistant", content: "Adapted response" }, finish_reason: "stop" },
      ],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    };

    globalThis.fetch = mockFetch(apiResponse);

    const model = fromNativeProvider(provider, { model: "gpt-4o" });

    expect(model.modelName).toBe("gpt-4o");
    expect(model.invoke).toBeInstanceOf(Function);
    expect(model.stream).toBeDefined();
    expect(model.bindTools).toBeDefined();
    expect(model.capabilities?.structuredOutput).toBe("native");
    expect(model.capabilities?.provider).toBe("openai");

    const result = await model.invoke([
      { role: "user", content: "Hello" },
    ]);

    expect(result.role).toBe("assistant");
    expect(result.content).toBe("Adapted response");
    expect(result.usage.prompt_tokens).toBe(10);
    expect(result.usage.completion_tokens).toBe(5);
    expect(result.response_metadata.token_usage.cached_tokens).toBe(0);
  });

  it("should handle tool calls in adapted response", async () => {
    const provider = new OpenAIProvider({
      provider: "openai",
      apiKey: "test-key",
    });

    const apiResponse = {
      id: "chatcmpl-tc",
      model: "gpt-4o",
      choices: [
        {
          message: {
            role: "assistant",
            content: null,
            tool_calls: [
              { id: "call_1", type: "function", function: { name: "test", arguments: "{}" } },
            ],
          },
          finish_reason: "tool_calls",
        },
      ],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    };

    globalThis.fetch = mockFetch(apiResponse);
    const model = fromNativeProvider(provider);
    const result = await model.invoke([{ role: "user", content: "test" }]);

    expect(result.tool_calls).toHaveLength(1);
    expect(result.tool_calls![0].id).toBe("call_1");
    expect(result.tool_calls![0].function?.name).toBe("test");
  });

  it("should bind tools and create new model instance", () => {
    const provider = new AnthropicProvider({
      provider: "anthropic",
      apiKey: "test-key",
    });

    const model = fromNativeProvider(provider, { model: "claude-sonnet-4-20250514" });
    const boundModel = model.bindTools!([
      { name: "test_tool", description: "A test tool", parameters: { type: "object" } },
    ]);

    expect(boundModel).toBeDefined();
    expect(boundModel.invoke).toBeInstanceOf(Function);
    expect(boundModel.capabilities?.provider).toBe("anthropic");
  });

  it("should convert Zod tool schemas to JSON Schema compatible with OpenAI strict tools", async () => {
    const provider = new OpenAIProvider({
      provider: "openai",
      apiKey: "test-key",
    });

    globalThis.fetch = mockFetch({
      id: "chatcmpl-strict-tool",
      model: "gpt-4o",
      choices: [
        { message: { role: "assistant", content: "ok" }, finish_reason: "stop" },
      ],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    });

    const model = fromNativeProvider(provider, { model: "gpt-4o" }).bindTools!(
      [
        {
          name: "list_agent_memory",
          description: "List saved memory entries",
          schema: z.object({
            limit: z.number().positive().optional(),
          }),
          invoke: vi.fn(),
        },
      ],
      { strict: true },
    );

    await model.invoke([{ role: "user", content: "List memories" }]);

    const call = (globalThis.fetch as any).mock.calls[0];
    const body = JSON.parse(call[1].body);
    const limitSchema = body.tools[0].function.parameters.properties.limit;

    expect(body.tools[0].function.strict).toBe(true);
    expect(limitSchema.exclusiveMinimum).toBe(0);
    expect(typeof limitSchema.exclusiveMinimum).toBe("number");
  });

  it("should strip unsupported format keywords from OpenAI strict tool schemas", async () => {
    const provider = new OpenAIProvider({
      provider: "openai",
      apiKey: "test-key",
    });

    globalThis.fetch = mockFetch({
      id: "chatcmpl-strict-tool-url",
      model: "gpt-4o",
      choices: [
        { message: { role: "assistant", content: "ok" }, finish_reason: "stop" },
      ],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    });

    const model = fromNativeProvider(provider, { model: "gpt-4o" }).bindTools!(
      [
        {
          name: "local_browser_fetch",
          description: "Fetch a browser URL",
          schema: z.object({
            url: z.string().url(),
          }),
          invoke: vi.fn(),
        },
      ],
      { strict: true },
    );

    await model.invoke([{ role: "user", content: "Fetch https://example.com" }]);

    const call = (globalThis.fetch as any).mock.calls[0];
    const body = JSON.parse(call[1].body);
    const urlSchema = body.tools[0].function.parameters.properties.url;

    expect(body.tools[0].function.strict).toBe(true);
    expect(urlSchema.type).toBe("string");
    expect(urlSchema.format).toBeUndefined();
  });

  it("should keep native structured output tool binding but skip strict for MCP-style raw JSON Schemas", async () => {
    const provider = new OpenAIProvider({
      provider: "openai",
      apiKey: "test-key",
    });

    globalThis.fetch = mockFetch({
      id: "chatcmpl-mcp-raw-schema",
      model: "gpt-4o",
      choices: [
        { message: { role: "assistant", content: "ok" }, finish_reason: "stop" },
      ],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    });

    const model = fromNativeProvider(provider, { model: "gpt-4o" }).bindTools!(
      [
        {
          name: "kogniser_crm_create_deal",
          description: "Create a CRM deal",
          schema: {
            type: "object",
            properties: {
              contactId: { $ref: "#/$defs/contactId" },
              title: { type: "string" },
            },
            required: ["contactId", "title"],
            additionalProperties: false,
            $defs: {
              contactId: {
                type: "string",
                description: "Existing contact id",
              },
            },
          },
          invoke: vi.fn(),
        },
      ],
      { strict: true },
    );

    await model.invoke([{ role: "user", content: "Create the deal" }]);

    const call = (globalThis.fetch as any).mock.calls[0];
    const body = JSON.parse(call[1].body);

    expect(body.tools[0].function.strict).toBeUndefined();
    expect(body.tools[0].function.parameters.properties.contactId.$ref).toBe("#/$defs/contactId");
  });

  it("should execute native adapter tool calls and emit trace events", async () => {
    const provider = new OpenAIProvider({
      provider: "openai",
      apiKey: "test-key",
    });
    const runtimeEvents: any[] = [];
    const traceEvents: any[] = [];
    const toolInputs: any[] = [];

    globalThis.fetch = mockFetchSequence([
      {
        response: {
          id: "chatcmpl-tool-1",
          model: "gpt-4o",
          choices: [
            {
              message: {
                role: "assistant",
                content: null,
                tool_calls: [
                  {
                    id: "call_weather",
                    type: "function",
                    function: {
                      name: "get_weather",
                      arguments: '{"city":"Istanbul"}',
                    },
                  },
                ],
              },
              finish_reason: "tool_calls",
            },
          ],
          usage: { prompt_tokens: 12, completion_tokens: 6, total_tokens: 18 },
        },
      },
      {
        response: {
          id: "chatcmpl-tool-2",
          model: "gpt-4o",
          choices: [
            {
              message: { role: "assistant", content: "Sunny in Istanbul" },
              finish_reason: "stop",
            },
          ],
          usage: { prompt_tokens: 18, completion_tokens: 4, total_tokens: 22 },
        },
      },
    ]);

    const agent = createAgent({
      name: "NativeProviderToolAgent",
      model: fromNativeProvider(provider, { model: "gpt-4o" }),
      tools: [
        createTool({
          name: "get_weather",
          description: "Get weather for a city",
          schema: z.object({ city: z.string() }),
          func: async (args: { city: string }) => {
            toolInputs.push(args);
            return { forecast: `Sunny in ${args.city}` };
          },
        }),
      ],
      tracing: {
        enabled: true,
        sink: {
          type: "custom",
          onEvent: (event) => traceEvents.push(event),
        },
      },
    });

    const result = await agent.invoke(
      {
        messages: [{ role: "user", content: "What is the weather in Istanbul?" }],
      } as any,
      {
        onEvent: (event) => runtimeEvents.push(event),
      },
    );

    expect(toolInputs).toEqual([{ city: "Istanbul" }]);
    expect(result.content).toBe("Sunny in Istanbul");
    expect(result.state.toolHistory).toHaveLength(1);
    expect(result.state.toolHistory?.[0].toolName).toBe("get_weather");
    expect(runtimeEvents.some((event) => event.type === "tool_call" && event.phase === "success" && event.name === "get_weather")).toBe(true);
    expect(traceEvents.some((event) => event.type === "tool_call" && event.label.includes("Tool Execution - get_weather"))).toBe(true);
  });

  it("should set correct capabilities for each provider type", () => {
    const openai = fromNativeProvider(
      new OpenAIProvider({ provider: "openai", apiKey: "k" }),
    );
    expect(openai.capabilities?.structuredOutput).toBe("native");
    expect(openai.capabilities?.streaming).toBe(true);

    const anthropic = fromNativeProvider(
      new AnthropicProvider({ provider: "anthropic", apiKey: "k" }),
    );
    expect(anthropic.capabilities?.structuredOutput).toBe("tool_based");

    const vertex = fromNativeProvider(
      new VertexProvider({ provider: "vertex", projectId: "p", accessToken: "t" }),
    );
    expect(vertex.capabilities?.structuredOutput).toBe("native");
    expect(vertex.capabilities?.provider).toBe("google");

    const bedrock = fromNativeProvider(
      new BedrockProvider({ provider: "bedrock", region: "us-east-1", accessKeyId: "a", secretAccessKey: "s" }),
    );
    expect(bedrock.capabilities?.streaming).toBe(false);
  });
});

// ─── Token Usage Tracking ────────────────────────────────────────────────────

describe("Token Usage Tracking", () => {
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("should track cached tokens from OpenAI", async () => {
    const provider = new OpenAIProvider({ provider: "openai", apiKey: "key" });
    globalThis.fetch = mockFetch({
      id: "test",
      model: "gpt-4o",
      choices: [{ message: { content: "hi" }, finish_reason: "stop" }],
      usage: {
        prompt_tokens: 1000,
        completion_tokens: 100,
        total_tokens: 1100,
        prompt_tokens_details: { cached_tokens: 500 },
        completion_tokens_details: { reasoning_tokens: 20 },
      },
    });

    const result = await provider.complete(simpleRequest);
    expect(result.usage.cachedInputTokens).toBe(500);
    expect(result.usage.reasoningTokens).toBe(20);
    expect(result.usage.cachedWriteTokens).toBe(0);
  });

  it("should track cached tokens from Anthropic", async () => {
    const provider = new AnthropicProvider({ provider: "anthropic", apiKey: "key" });
    globalThis.fetch = mockFetch({
      id: "msg_test",
      content: [{ type: "text", text: "hi" }],
      stop_reason: "end_turn",
      usage: {
        input_tokens: 500,
        output_tokens: 50,
        cache_read_input_tokens: 200,
        cache_creation_input_tokens: 100,
      },
    });

    const result = await provider.complete(simpleRequest);
    expect(result.usage.inputTokens).toBe(500);
    expect(result.usage.cachedInputTokens).toBe(200);
    expect(result.usage.cachedWriteTokens).toBe(100);
  });

  it("should track cached tokens from Bedrock", async () => {
    const provider = new BedrockProvider({
      provider: "bedrock",
      region: "us-east-1",
      accessKeyId: "AKID",
      secretAccessKey: "secret",
    });

    globalThis.fetch = mockFetch({
      output: { message: { role: "assistant", content: [{ text: "hi" }] } },
      stopReason: "end_turn",
      usage: {
        inputTokens: 300,
        outputTokens: 30,
        totalTokens: 330,
        cacheReadInputTokenCount: 100,
        cacheWriteInputTokenCount: 50,
      },
    });

    const result = await provider.complete(simpleRequest);
    expect(result.usage.cachedInputTokens).toBe(100);
    expect(result.usage.cachedWriteTokens).toBe(50);
  });

  it("should track cached tokens from Vertex", async () => {
    const provider = new VertexProvider({
      provider: "vertex",
      projectId: "proj",
      accessToken: "tok",
    });

    globalThis.fetch = mockFetch({
      candidates: [{ content: { parts: [{ text: "hi" }] }, finishReason: "STOP" }],
      usageMetadata: {
        promptTokenCount: 200,
        candidatesTokenCount: 20,
        totalTokenCount: 220,
        cachedContentTokenCount: 80,
        thoughtsTokenCount: 10,
      },
    });

    const result = await provider.complete(simpleRequest);
    expect(result.usage.cachedInputTokens).toBe(80);
    expect(result.usage.reasoningTokens).toBe(10);
  });
});

// ─── SSE Parser ──────────────────────────────────────────────────────────────

describe("SSE Parser", () => {
  it("should parse SSE events from a stream", async () => {
    const { parseSSEStream } = await import("../../../src/providers/utils/sse.js");

    const text = [
      "event: message\ndata: {\"text\":\"hello\"}\n\n",
      "event: message\ndata: {\"text\":\"world\"}\n\n",
      "data: [DONE]\n\n",
    ].join("");

    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(text));
        controller.close();
      },
    });

    const events = [];
    for await (const event of parseSSEStream(stream)) {
      events.push(event);
    }

    expect(events).toHaveLength(3);
    expect(events[0].event).toBe("message");
    expect(events[0].data).toBe('{"text":"hello"}');
    expect(events[1].data).toBe('{"text":"world"}');
    expect(events[2].data).toBe("[DONE]");
  });

  it("should handle chunked SSE data", async () => {
    const { parseSSEStream } = await import("../../../src/providers/utils/sse.js");

    const encoder = new TextEncoder();
    const chunks = [
      "data: {\"text\":\"hel",
      "lo\"}\n\ndata: {\"text\":\"world\"}\n\n",
    ];

    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) {
          controller.enqueue(encoder.encode(chunk));
        }
        controller.close();
      },
    });

    const events = [];
    for await (const event of parseSSEStream(stream)) {
      events.push(event);
    }

    expect(events).toHaveLength(2);
    expect(events[0].data).toBe('{"text":"hello"}');
    expect(events[1].data).toBe('{"text":"world"}');
  });
});

// ─── SigV4 Signing ───────────────────────────────────────────────────────────

describe("SigV4 Signing", () => {
  it("should produce Authorization header", async () => {
    const { signRequest } = await import("../../../src/providers/utils/sigv4.js");

    const result = signRequest({
      method: "POST",
      url: "https://bedrock-runtime.us-east-1.amazonaws.com/model/test/converse",
      headers: { "Content-Type": "application/json" },
      body: '{"test":true}',
      region: "us-east-1",
      service: "bedrock",
      credentials: {
        accessKeyId: "AKIDEXAMPLE",
        secretAccessKey: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY",
      },
    });

    expect(result.Authorization).toBeDefined();
    expect(result.Authorization).toContain("AWS4-HMAC-SHA256");
    expect(result.Authorization).toContain("AKIDEXAMPLE");
    expect(result["x-amz-date"]).toBeDefined();
  });

  it("should include security token when provided", async () => {
    const { signRequest } = await import("../../../src/providers/utils/sigv4.js");

    const result = signRequest({
      method: "POST",
      url: "https://bedrock-runtime.us-east-1.amazonaws.com/model/test/converse",
      headers: {},
      body: "{}",
      region: "us-east-1",
      service: "bedrock",
      credentials: {
        accessKeyId: "AKID",
        secretAccessKey: "secret",
        sessionToken: "session-token",
      },
    });

    expect(result["x-amz-security-token"]).toBe("session-token");
  });
});
