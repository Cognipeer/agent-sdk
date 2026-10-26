/**
 * parseModelError: `max_tokens` larger than the server takes (parse-only, with
 * the stated maximum) and the several ways a server says it does not take
 * `stream_options` (learned as a dropped parameter).
 */
import { describe, it, expect, beforeEach } from "vitest";
import { OpenAICompatibleProvider } from "../../../src/providers/openaiCompatible.js";
import { parseModelError, patchFromParsedError } from "../../../src/models/adjust.js";
import { ModelRequestError, clearLearnedModelRules, listLearnedModelRules } from "../../../src/index.js";

beforeEach(() => clearLearnedModelRules());

const oaiErr = (message: string, param?: string) =>
  JSON.stringify({ error: { message, type: "invalid_request_error", param: param ?? null, code: null } });

describe("parseModelError: max_tokens_too_large", () => {
  it("OpenAI: 'max_tokens is too large: N. This model supports at most M completion tokens'", () => {
    const parsed = parseModelError(oaiErr("max_tokens is too large: 32768. This model supports at most 4096 completion tokens, whereas you provided 32768.", "max_tokens"));
    expect(parsed).toMatchObject({ kind: "max_tokens_too_large", param: "max_tokens", maxAllowed: 4096 });
  });

  it("OpenAI via a gateway: bare message text, larger limit", () => {
    const parsed = parseModelError("max_tokens is too large: 944157. This model supports at most 131072 completion tokens");
    expect(parsed).toMatchObject({ kind: "max_tokens_too_large", maxAllowed: 131072 });
  });

  it("max_completion_tokens spelling keeps its param", () => {
    const parsed = parseModelError(oaiErr("max_completion_tokens is too large: 50000. This model supports at most 16384 completion tokens, whereas you provided 50000.", "max_completion_tokens"));
    expect(parsed).toMatchObject({ kind: "max_tokens_too_large", param: "max_completion_tokens", maxAllowed: 16384 });
  });

  it("vLLM (newer): window minus the input tokens", () => {
    const parsed = parseModelError(oaiErr("'max_tokens' or 'max_completion_tokens' is too large: 65536. This model's maximum context length is 65536 tokens and your request has 10969 input tokens (65536 > 65536 - 10969). (parameter=max_tokens, value=65536)"));
    expect(parsed).toMatchObject({ kind: "max_tokens_too_large", param: "max_tokens", maxAllowed: 65536 - 10969 });
  });

  it("vLLM (newer, second form): 'you requested N output tokens and your prompt contains at least M input tokens'", () => {
    const parsed = parseModelError(oaiErr("This model's maximum context length is 409600 tokens. However, you requested 32000 output tokens and your prompt contains at least 377601 input tokens, for a total of at least 409601 tokens. Please reduce the length of the prompt or output."));
    expect(parsed).toMatchObject({ kind: "max_tokens_too_large", maxAllowed: 409600 - 377601 });
  });

  it("vLLM / OpenAI (older): window minus the messages", () => {
    const parsed = parseModelError(oaiErr("This model's maximum context length is 16384 tokens. However, you requested 19591 tokens (9591 in the messages, 10000 in the completion). Please reduce the length of the messages or completion."));
    expect(parsed).toMatchObject({ kind: "max_tokens_too_large", maxAllowed: 16384 - 9591 });
  });

  it("OpenAI (older) also counts the functions in the prompt", () => {
    const parsed = parseModelError(oaiErr("This model's maximum context length is 16385 tokens. However, you requested 19847 tokens (3398 in the messages, 449 in the functions, and 16000 in the completion). Please reduce the length of the messages, functions, or completion."));
    expect(parsed).toMatchObject({ kind: "max_tokens_too_large", maxAllowed: 16385 - 3398 - 449 });
  });

  it("a prompt that alone overflows the window states no usable maximum", () => {
    const parsed = parseModelError(oaiErr("This model's maximum context length is 4097 tokens. However, you requested 9000 tokens (8000 in the messages, 1000 in the completion). Please reduce the length of the messages or completion."));
    expect(parsed?.kind).toBe("max_tokens_too_large");
    expect(parsed?.maxAllowed).toBeUndefined();
  });

  it("DeepSeek: valid range of max_tokens", () => {
    const parsed = parseModelError(oaiErr("Invalid max_tokens value, the valid range of max_tokens is [1, 8192]"));
    expect(parsed).toMatchObject({ kind: "max_tokens_too_large", maxAllowed: 8192 });
  });

  it("'Field 'max_tokens' must be at most N'", () => {
    const parsed = parseModelError("API Error: 400 Field 'max_tokens' must be at most 65536");
    expect(parsed).toMatchObject({ kind: "max_tokens_too_large", maxAllowed: 65536 });
  });

  it("'is too large' with no stated number is still recognised, without maxAllowed", () => {
    const parsed = parseModelError(oaiErr("max_tokens is too large: 1000000."));
    expect(parsed?.kind).toBe("max_tokens_too_large");
    expect(parsed?.maxAllowed).toBeUndefined();
  });

  it("does not claim unrelated messages", () => {
    expect(parseModelError(oaiErr("Unsupported parameter: 'max_tokens' is not supported with this model. Use 'max_completion_tokens' instead.", "max_tokens"))?.kind).toBe("max_tokens_rename");
    expect(parseModelError(oaiErr("This model's maximum context length is 8192 tokens, however you requested 9000 tokens"))).toBeUndefined();
    expect(parseModelError(oaiErr("Rate limit reached"))).toBeUndefined();
  });

  it("is parse-only: no learned rule patch", () => {
    const parsed = parseModelError(oaiErr("max_tokens is too large: 32768. This model supports at most 4096 completion tokens"))!;
    expect(patchFromParsedError(parsed)).toBeUndefined();
  });

  it("a provider call surfaces it as one typed error (no retry), the maximum readable from the body", async () => {
    const bodies: any[] = [];
    const fn = (async (_u: any, init: any) => {
      bodies.push(JSON.parse(init.body));
      return new Response(oaiErr("max_tokens is too large: 32768. This model supports at most 4096 completion tokens, whereas you provided 32768.", "max_tokens"), { status: 400 });
    }) as typeof fetch;
    const p = new OpenAICompatibleProvider({ provider: "openai-compatible", apiKey: "k", baseURL: "http://x/v1", fetch: fn, retry: { maxRetries: 0 } });
    const err = await p.complete({ model: "acme-big", messages: [{ role: "user", content: "hi" }], maxTokens: 32768 }).catch((e) => e);
    expect(err).toBeInstanceOf(ModelRequestError);
    expect(err.param).toBe("max_tokens");
    expect(bodies).toHaveLength(1);
    expect(parseModelError(String(err.responseBody))?.maxAllowed).toBe(4096);
    expect(listLearnedModelRules()).toHaveLength(0);
  });
});

describe("parseModelError: stream_options", () => {
  const cases: Array<[string, string]> = [
    ["Azure (older api-version)", "Unrecognized request argument supplied: stream_options"],
    ["gateway validation (Anthropic-style)", "stream_options: Extra inputs are not permitted"],
    ["Azure On Your Data", "Validation error at #/stream_options: Extra inputs are not permitted"],
    ["pydantic text form", "stream_options\n  Extra inputs are not permitted [type=extra_forbidden, input_value={'include_usage': True}, input_type=dict]"],
    ["serde (Rust servers)", "unknown field `stream_options`, expected one of `model`, `messages`, `stream`"],
    ["plain", "stream_options is not supported by this endpoint"],
    ["OpenAI wording", "Unsupported parameter: 'stream_options'"],
  ];
  for (const [label, message] of cases) {
    it(`${label} -> unsupported_parameter stream_options`, () => {
      for (const text of [oaiErr(message), message, JSON.stringify({ detail: message })]) {
        expect(parseModelError(text), text).toMatchObject({ kind: "unsupported_parameter", param: "stream_options" });
      }
    });
  }

  it("the existing patch drops the field", () => {
    const parsed = parseModelError(oaiErr("Unrecognized request argument supplied: stream_options"))!;
    expect(patchFromParsedError(parsed)).toEqual({ patch: { dropParams: ["stream_options"] }, adjustment: "drop:stream_options" });
  });

  it("does not claim messages that only mention stream_options", () => {
    expect(parseModelError(oaiErr("stream_options.include_usage is only allowed when stream is true"))).toBeUndefined();
    expect(parseModelError(oaiErr("Extra inputs are not permitted: foo"))).toBeUndefined();
  });

  it("a streaming call retries without stream_options and remembers the fix", async () => {
    const bodies: any[] = [];
    const ok = `data: ${JSON.stringify({ id: "1", model: "m", choices: [{ delta: { content: "a" }, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`;
    const fn = (async (_u: any, init: any) => {
      bodies.push(JSON.parse(init.body));
      if (bodies.length === 1) return new Response(oaiErr("Unrecognized request argument supplied: stream_options"), { status: 400 });
      return new Response(ok, { status: 200, headers: { "content-type": "text/event-stream" } });
    }) as typeof fetch;
    const p = new OpenAICompatibleProvider({ provider: "openai-compatible", apiKey: "k", baseURL: "http://x/v1", fetch: fn, retry: { maxRetries: 0 } });
    const chunks: any[] = [];
    for await (const c of p.completeStream({ model: "acme-s1", messages: [{ role: "user", content: "hi" }] })) chunks.push(c);
    expect(chunks.some((c) => c.delta.content === "a")).toBe(true);
    expect(bodies[0].stream_options).toEqual({ include_usage: true });
    expect(bodies[1]).not.toHaveProperty("stream_options");
    expect(listLearnedModelRules()).toHaveLength(1);

    // the next call is right first time
    const again: any[] = [];
    for await (const c of p.completeStream({ model: "acme-s1", messages: [{ role: "user", content: "hi" }] })) again.push(c);
    expect(bodies).toHaveLength(3);
    expect(bodies[2]).not.toHaveProperty("stream_options");
  });
});
