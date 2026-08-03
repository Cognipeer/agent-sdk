/**
 * Three properties of the reasoning surface that no existing suite covered, and
 * each of which was a silent failure rather than a loud one:
 *
 *  1. WHICH API a reasoning-carrying request goes to. The `auto` rule is a
 *     regex over the MODEL NAME, so on a deployment whose model happens to be
 *     called `gpt-5.6-terra`, asking for less thinking moved every request onto
 *     the Responses API — a different body shape and a different parse — with no
 *     error and no log. `responsesApi` lets a caller state the answer instead.
 *
 *  2. MERGING an endpoint-level reasoning config with a per-call one. The
 *     adapter used to replace, so an agent that set a per-run effort dropped the
 *     endpoint's `providerExtras` — the chat-template flag or gateway field the
 *     deployment needs on EVERY request — on exactly the turns the agent touched.
 *
 *  3. `effort: "none"`. On a thinking-by-default model, off is a value that must
 *     be SENT; before this it was not expressible at all.
 */

import { describe, it, expect, vi, afterEach } from "vitest";

import { OpenAIProvider } from "../../../src/providers/openai.js";
import { fromNativeProvider } from "../../../src/providers/adapter.js";
import {
  applyOpenAIReasoning,
  applyAnthropicReasoning,
  applyGeminiReasoning,
} from "../../../src/providers/utils/reasoning.js";
import type { ChatCompletionRequest } from "../../../src/providers/types.js";

/** Reaches the protected router without going near the network. */
function routesToResponses(
  config: { responsesApi?: "auto" | "never" | "always"; defaultModel?: string },
  request: Partial<ChatCompletionRequest>,
): boolean {
  const provider = new OpenAIProvider({
    provider: "openai",
    apiKey: "test",
    defaultModel: config.defaultModel ?? "gpt-4o",
    ...(config.responsesApi ? { responsesApi: config.responsesApi } : {}),
  });
  return (provider as any).useResponsesApi({
    model: request.model,
    messages: [],
    ...request,
  });
}

describe("OpenAIProvider transport selection", () => {
  it("defaults to auto: a reasoning request on a gpt-5 name goes to Responses", () => {
    expect(routesToResponses({}, { model: "gpt-5.6-terra", reasoning: { effort: "low" } })).toBe(true);
  });

  it("auto never fires without a reasoning config, whatever the model is called", () => {
    expect(routesToResponses({}, { model: "gpt-5.6-terra" })).toBe(false);
    expect(routesToResponses({}, { model: "o3-mini" })).toBe(false);
  });

  it("never keeps a gpt-5 reasoning request on Chat Completions", () => {
    expect(
      routesToResponses({ responsesApi: "never" }, { model: "gpt-5.6-terra", reasoning: { effort: "low" } }),
    ).toBe(false);
  });

  it("always routes to Responses even for a model the name check does not recognise", () => {
    // The case `auto` cannot serve: a self-hosted or renamed deployment.
    expect(
      routesToResponses({ responsesApi: "always" }, { model: "qwen3-32b", reasoning: { effort: "low" } }),
    ).toBe(true);
  });

  it("always applies to a request carrying no reasoning at all", () => {
    expect(routesToResponses({ responsesApi: "always" }, { model: "gpt-4o" })).toBe(true);
  });

  it("falls back to the default model name when the request names none", () => {
    expect(
      routesToResponses({ defaultModel: "gpt-5.6-terra" }, { reasoning: { effort: "low" } }),
    ).toBe(true);
    expect(routesToResponses({ defaultModel: "gpt-4o" }, { reasoning: { effort: "low" } })).toBe(false);
  });
});

/** A provider stub that records the request the adapter built for it. */
function recordingProvider() {
  const seen: ChatCompletionRequest[] = [];
  const provider: any = {
    providerName: "openai",
    defaultModel: "test-model",
    complete: async (request: ChatCompletionRequest) => {
      seen.push(request);
      return {
        id: "1",
        model: "test-model",
        content: "ok",
        toolCalls: [],
        usage: {
          inputTokens: 0,
          outputTokens: 0,
          totalTokens: 0,
          cachedInputTokens: 0,
          cachedWriteTokens: 0,
          cachedOutputTokens: 0,
          reasoningTokens: 0,
        },
        finishReason: "stop",
      };
    },
  };
  return { provider, seen };
}

describe("fromNativeProvider reasoning merge", () => {
  afterEach(() => vi.restoreAllMocks());

  const messages = [{ role: "user", content: "hi" }] as any[];

  it("passes the endpoint-level config through when the call supplies none", async () => {
    const { provider, seen } = recordingProvider();
    const model = fromNativeProvider(provider, {
      model: "m",
      reasoning: { providerExtras: { chat_template_kwargs: { enable_thinking: false } } },
    });
    await model.invoke(messages);
    expect(seen[0].reasoning).toEqual({
      providerExtras: { chat_template_kwargs: { enable_thinking: false } },
    });
  });

  it("keeps the endpoint's providerExtras when a call sets only an effort", async () => {
    // The regression: the per-call config used to REPLACE the endpoint's, so the
    // chat-template flag vanished on every turn an agent asked for an effort.
    const { provider, seen } = recordingProvider();
    const model = fromNativeProvider(provider, {
      model: "m",
      reasoning: { providerExtras: { chat_template_kwargs: { enable_thinking: false } } },
    });
    await model.invoke(messages, { reasoning: { effort: "high" } } as any);
    expect(seen[0].reasoning).toEqual({
      effort: "high",
      providerExtras: { chat_template_kwargs: { enable_thinking: false } },
    });
  });

  it("lets a call override one extras key without restating the rest", async () => {
    const { provider, seen } = recordingProvider();
    const model = fromNativeProvider(provider, {
      model: "m",
      reasoning: { providerExtras: { gateway_flag: 1, keep_me: true } },
    });
    await model.invoke(messages, { reasoning: { providerExtras: { gateway_flag: 2 } } } as any);
    expect(seen[0].reasoning?.providerExtras).toEqual({ gateway_flag: 2, keep_me: true });
  });

  it("leaves request.reasoning unset when neither side supplies one", async () => {
    // Load-bearing: an unset `reasoning` is what keeps `auto` from firing.
    const { provider, seen } = recordingProvider();
    const model = fromNativeProvider(provider, { model: "m" });
    await model.invoke(messages);
    expect(seen[0].reasoning).toBeUndefined();
  });

  it("survives bindTools, which the agent loop calls on every leg", async () => {
    const { provider, seen } = recordingProvider();
    const model = fromNativeProvider(provider, {
      model: "m",
      reasoning: { providerExtras: { chat_template_kwargs: { enable_thinking: false } } },
    });
    await model.bindTools!([]).invoke(messages);
    expect(seen[0].reasoning).toEqual({
      providerExtras: { chat_template_kwargs: { enable_thinking: false } },
    });
  });
});

describe('effort "none"', () => {
  it("is sent verbatim as reasoning_effort on OpenAI chat completions", () => {
    const body: any = {};
    applyOpenAIReasoning(body, { effort: "none" }, "legacy_effort");
    expect(body.reasoning_effort).toBe("none");
  });

  it("is nested under reasoning on the Responses API", () => {
    const body: any = {};
    applyOpenAIReasoning(body, { effort: "none" }, "responses");
    expect(body.reasoning).toEqual({ effort: "none" });
  });

  it("emits no thinking block on Anthropic, where absence IS off", () => {
    const body: any = { max_tokens: 2048, temperature: 0.7 };
    applyAnthropicReasoning(body, { effort: "none" });
    expect(body.thinking).toBeUndefined();
    // And the sampling params survive, because thinking never turned on.
    expect(body.temperature).toBe(0.7);
  });

  it("sends thinkingBudget 0 on Gemini, where off must be spelled out", () => {
    const generationConfig: any = {};
    applyGeminiReasoning(generationConfig, { effort: "none" });
    expect(generationConfig.thinkingConfig).toEqual({ thinkingBudget: 0 });
  });

  it("beats a leftover budgetTokens rather than being silently overridden by it", () => {
    const body: any = { max_tokens: 4096 };
    applyAnthropicReasoning(body, { effort: "none", budgetTokens: 8192 });
    expect(body.thinking).toBeUndefined();
  });
});
