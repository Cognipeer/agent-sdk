/**
 * "Unrecognized request argument supplied: <name>" is an unsupported parameter for
 * that name (OpenAI, and Azure for an api-version or deployment that predates a field),
 * not only for stream_options; and `max_tokens_too_large` is a typed error code that
 * carries the server's stated maximum as `maxAllowed`.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { OpenAICompatibleProvider } from "../../../src/providers/openaiCompatible.js";
import { ProviderError } from "../../../src/providers/types.js";
import type { ChatCompletionRequest } from "../../../src/providers/types.js";
import { asModelRequestError, parseModelError, patchFromParsedError } from "../../../src/models/adjust.js";
import { ModelRequestError } from "../../../src/models/errors.js";
import { clearLearnedModelRules, listLearnedModelRules, type ModelRuleLearnedEvent } from "../../../src/index.js";

beforeEach(() => clearLearnedModelRules());

const oaiErr = (message: string, param?: string | null) =>
  JSON.stringify({ error: { message, type: "invalid_request_error", param: param ?? null, code: null } });
const OK = { id: "c", model: "m", choices: [{ message: { role: "assistant", content: "ok" }, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } };
const msgs = [{ role: "user" as const, content: "hi" }];

function compat(fn: typeof fetch, extra: Record<string, any> = {}) {
  return new OpenAICompatibleProvider({ provider: "openai-compatible", apiKey: "k", baseURL: "http://x/v1", fetch: fn, retry: { maxRetries: 0 }, ...extra });
}

// ─── OA-13: Unrecognized request argument ────────────────────────────────────

describe("parseModelError: Unrecognized request argument supplied", () => {
  const forms: Array<[string, string, string]> = [
    ["singular", "Unrecognized request argument supplied: seed", "seed"],
    ["plural: the first name is fixed now, the next one on the retry", "Unrecognized request arguments supplied: seed, logit_bias", "seed"],
    ["dotted name", "Unrecognized request argument supplied: reasoning.effort", "reasoning.effort"],
    ["any case", "UNRECOGNIZED REQUEST ARGUMENT SUPPLIED: top_p", "top_p"],
  ];
  for (const [label, message, param] of forms) {
    it(`${label} -> unsupported_parameter ${param}`, () => {
      // as an OpenAI error body, as bare text, and inside a gateway's `{ detail }`
      for (const text of [oaiErr(message), message, JSON.stringify({ detail: message })]) {
        expect(parseModelError(text), text).toMatchObject({ kind: "unsupported_parameter", param });
      }
    });
  }

  it("stream_options keeps its own mapping, wherever it stands in the list", () => {
    for (const message of ["Unrecognized request argument supplied: stream_options", "Unrecognized request arguments supplied: seed, stream_options"]) {
      expect(parseModelError(oaiErr(message))).toMatchObject({ kind: "unsupported_parameter", param: "stream_options" });
    }
    const parsed = parseModelError(oaiErr("Unrecognized request argument supplied: stream_options"))!;
    expect(patchFromParsedError(parsed)).toEqual({ patch: { dropParams: ["stream_options"] }, adjustment: "drop:stream_options" });
  });

  it("the patch drops that parameter the way the same parameter is dropped elsewhere", () => {
    const patch = (name: string) => patchFromParsedError(parseModelError(oaiErr(`Unrecognized request argument supplied: ${name}`))!);
    expect(patch("seed")).toEqual({ patch: { dropParams: ["seed"] }, adjustment: "drop:seed" });
    expect(patch("temperature")).toEqual({ patch: { sampling: { temperature: "unsupported" } }, adjustment: "drop:temperature" });
    expect(patch("max_completion_tokens")).toEqual({ patch: { maxTokensParam: "max_tokens" }, adjustment: "max_completion_tokens->max_tokens" });
  });

  it("a message that names no argument is not claimed", () => {
    expect(parseModelError(oaiErr("Unrecognized request argument supplied."))).toBeUndefined();
    expect(parseModelError(oaiErr("Unrecognized request argument supplied: "))).toBeUndefined();
    expect(parseModelError(oaiErr("Unrecognized request URL (POST /v1/chat/completion)."))).toBeUndefined();
  });
});

describe("a call that sends an argument the server does not recognise", () => {
  it("is retried without it, and the model is remembered", async () => {
    const bodies: any[] = [];
    const events: ModelRuleLearnedEvent[] = [];
    const fn = (async (_u: any, init: any) => {
      bodies.push(JSON.parse(init.body));
      return bodies.length === 1
        ? new Response(oaiErr("Unrecognized request argument supplied: seed"), { status: 400 })
        : new Response(JSON.stringify(OK), { status: 200 });
    }) as typeof fetch;
    const p = compat(fn, { onModelRuleLearned: (e: ModelRuleLearnedEvent) => events.push(e) });
    expect((await p.complete({ model: "acme-x1", messages: msgs, seed: 7 })).content).toBe("ok");
    expect(bodies[0].seed).toBe(7);
    expect(bodies[1]).not.toHaveProperty("seed");
    expect(events).toMatchObject([{ provider: "openai-compatible", model: "acme-x1", adjustment: "drop:seed" }]);
    // the next call is right first time
    await p.complete({ model: "acme-x1", messages: msgs, seed: 7 });
    expect(bodies).toHaveLength(3);
    expect(bodies[2]).not.toHaveProperty("seed");
  });

  it("several unrecognised arguments are fixed one retry at a time; a field the caller put in extra is not remembered", async () => {
    const bodies: any[] = [];
    const fn = (async (_u: any, init: any) => {
      bodies.push(JSON.parse(init.body));
      if (bodies.length === 1) return new Response(oaiErr("Unrecognized request arguments supplied: seed, logit_bias"), { status: 400 });
      if (bodies.length === 2) return new Response(oaiErr("Unrecognized request argument supplied: logit_bias"), { status: 400 });
      return new Response(JSON.stringify(OK), { status: 200 });
    }) as typeof fetch;
    const res = await compat(fn).complete({ model: "acme-x1", messages: msgs, seed: 7, extra: { logit_bias: { "50256": -100 } } });
    expect(res.content).toBe("ok");
    expect(bodies).toHaveLength(3);
    expect(bodies[0]).toMatchObject({ seed: 7, logit_bias: { "50256": -100 } });
    expect(bodies[1]).not.toHaveProperty("seed");
    expect(bodies[1]).toHaveProperty("logit_bias");
    expect(bodies[2]).not.toHaveProperty("seed");
    expect(bodies[2]).not.toHaveProperty("logit_bias");
    expect(listLearnedModelRules().map((e) => e.patch.dropParams)).toEqual([["seed"]]);
  });
});

// ─── ERR-CODE: max_tokens_too_large ──────────────────────────────────────────

describe("max_tokens_too_large is a typed error code", () => {
  const TOO_LARGE = "max_tokens is too large: 32768. This model supports at most 4096 completion tokens, whereas you provided 32768.";

  async function failing(replyBody: string, req: Partial<ChatCompletionRequest> = {}) {
    const bodies: any[] = [];
    const fn = (async (_u: any, init: any) => {
      bodies.push(JSON.parse(init.body));
      return new Response(replyBody, { status: 400 });
    }) as typeof fetch;
    const err: any = await compat(fn).complete({ model: "acme-big", messages: msgs, ...req }).catch((e) => e);
    return { err, bodies };
  }

  it("a provider call rejects with the code and the stated maximum, once, and learns nothing", async () => {
    const { err, bodies } = await failing(oaiErr(TOO_LARGE, "max_tokens"), { maxTokens: 32768 });
    expect(err).toBeInstanceOf(ModelRequestError);
    expect(err).toBeInstanceOf(ProviderError);
    expect(err.code).toBe("max_tokens_too_large");
    expect(err.maxAllowed).toBe(4096);
    expect(err.param).toBe("max_tokens");
    expect(err.status).toBe(400);
    expect(err.statusCode).toBe(400);
    expect(err.model).toBe("acme-big");
    expect(err.provider).toBe("openai-compatible");
    expect(bodies).toHaveLength(1);
    expect(listLearnedModelRules()).toHaveLength(0);
  });

  it("max_completion_tokens keeps its param", async () => {
    const { err } = await failing(oaiErr("max_completion_tokens is too large: 50000. This model supports at most 16384 completion tokens, whereas you provided 50000.", "max_completion_tokens"));
    expect(err.code).toBe("max_tokens_too_large");
    expect(err.param).toBe("max_completion_tokens");
    expect(err.maxAllowed).toBe(16384);
  });

  it("a context-length message states the window minus the prompt", async () => {
    const { err } = await failing(oaiErr("This model's maximum context length is 16385 tokens. However, you requested 19847 tokens (3398 in the messages, 449 in the functions, and 16000 in the completion). Please reduce the length of the messages, functions, or completion."));
    expect(err.code).toBe("max_tokens_too_large");
    expect(err.maxAllowed).toBe(16385 - 3398 - 449);
  });

  it("a message that states no number is the code without a maximum", async () => {
    const { err } = await failing(oaiErr("max_tokens is too large: 1000000."));
    expect(err.code).toBe("max_tokens_too_large");
    expect(err.maxAllowed).toBeUndefined();
  });

  it("a streaming call fails the same way, before anything streams", async () => {
    const fn = (async () => new Response(oaiErr(TOO_LARGE, "max_tokens"), { status: 400 })) as unknown as typeof fetch;
    let err: any;
    try {
      for await (const _chunk of compat(fn).completeStream({ model: "acme-big", messages: msgs, maxTokens: 32768 })) { /* nothing arrives */ }
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(ModelRequestError);
    expect(err.code).toBe("max_tokens_too_large");
    expect(err.maxAllowed).toBe(4096);
  });

  it("asModelRequestError (the single-shot providers) carries it too", () => {
    const typed = asModelRequestError(new ProviderError("API error 400", "vertex", 400, oaiErr(TOO_LARGE, "max_tokens")), "vertex", "gemini-x") as ModelRequestError;
    expect(typed).toBeInstanceOf(ModelRequestError);
    expect(typed.code).toBe("max_tokens_too_large");
    expect(typed.maxAllowed).toBe(4096);
    expect(typed.provider).toBe("vertex");
    expect(typed.model).toBe("gemini-x");
  });

  it("the other codes carry no maximum, and an unparseable 400 stays model_request_invalid", () => {
    const code = (message: string) => {
      const typed = asModelRequestError(new ProviderError(message, "openai", 400, message), "openai", "m") as ModelRequestError;
      return [typed.code, typed.maxAllowed];
    };
    expect(code(oaiErr("Unsupported parameter: 'max_tokens' is not supported with this model. Use 'max_completion_tokens' instead.", "max_tokens"))).toEqual(["unsupported_parameter", undefined]);
    expect(code(oaiErr("Unsupported value: 'reasoning_effort' does not support 'xhigh' with this model. Supported values are: 'low', 'medium', and 'high'."))).toEqual(["unsupported_value", undefined]);
    expect(code(oaiErr("Unrecognized request argument supplied: seed"))).toEqual(["unsupported_parameter", undefined]);
    expect(code("Something else broke")).toEqual(["model_request_invalid", undefined]);
  });

  it("ModelRequestError holds the maximum it is given", () => {
    const err = new ModelRequestError({ code: "max_tokens_too_large", maxAllowed: 8192, provider: "p", model: "m", message: "too large" });
    expect(err.code).toBe("max_tokens_too_large");
    expect(err.maxAllowed).toBe(8192);
    expect(err.status).toBe(400);
    expect(new ModelRequestError({ code: "model_request_invalid", provider: "p", model: "m", message: "x" }).maxAllowed).toBeUndefined();
  });
});
