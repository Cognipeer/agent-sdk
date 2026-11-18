/**
 * OpenAI-compatible `serverType`: the request's reasoning in the form the
 * server reads (a self-hosted Qwen3 is switched by its chat template, not by
 * `reasoning_effort`), and the answer without the blank line the template
 * leaves after split-off reasoning. Unset `serverType` keeps the wire as it was.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { OpenAICompatibleProvider } from "../../../src/providers/openaiCompatible.js";
import { clearLearnedModelRules } from "../../../src/models/index.js";
import type { ChatCompletionRequest, OpenAICompatibleProviderConfig, ReasoningRequestConfig } from "../../../src/providers/types.js";

beforeEach(() => clearLearnedModelRules());

const completion = (message: Record<string, unknown>) => ({
  id: "c1", object: "chat.completion", created: 1, model: "m",
  choices: [{ index: 0, message: { role: "assistant", ...message }, finish_reason: "stop" }],
  usage: { prompt_tokens: 10, completion_tokens: 148, total_tokens: 158 },
});
const delta = (d: Record<string, unknown>, finish: string | null = null) => ({
  id: "c1", object: "chat.completion.chunk", created: 1, model: "m",
  choices: [{ index: 0, delta: d, finish_reason: finish }],
});
const usageChunk = { id: "c1", object: "chat.completion.chunk", created: 1, model: "m", choices: [], usage: { prompt_tokens: 10, completion_tokens: 148, total_tokens: 158 } };
const sse = (events: unknown[]) => `${events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join("")}data: [DONE]\n\n`;

function provider(serverType: string | undefined, respond: () => Response = () => new Response(JSON.stringify(completion({ content: "ok" })), { status: 200 })) {
  const bodies: any[] = [];
  const raw: string[] = [];
  const fetchImpl = (async (_u: any, init: any) => {
    raw.push(init.body);
    bodies.push(JSON.parse(init.body));
    return respond();
  }) as typeof fetch;
  const config: OpenAICompatibleProviderConfig = {
    provider: "openai-compatible", apiKey: "k", baseURL: "http://pool.local/v1", fetch: fetchImpl, retry: { maxRetries: 0 },
    ...(serverType !== undefined ? { serverType: serverType as OpenAICompatibleProviderConfig["serverType"] } : {}),
  };
  return { p: new OpenAICompatibleProvider(config), bodies, raw };
}

const USER = [{ role: "user" as const, content: "2+2?" }];
const QWEN_MLX = "mlx-community/Qwen3.5-9B-4bit";

async function wire(serverType: string | undefined, model: string, req: Partial<ChatCompletionRequest> = {}) {
  const { p, bodies } = provider(serverType);
  await p.complete({ model, messages: USER, ...req });
  return bodies[0];
}

async function rawWire(serverType: string | undefined, model: string, req: Partial<ChatCompletionRequest>, stream = false) {
  const respond = stream
    ? () => new Response(sse([delta({ content: "ok" }, "stop")]), { status: 200 })
    : undefined;
  const { p, raw } = provider(serverType, respond);
  if (stream) {
    for await (const _ of p.completeStream({ model, messages: USER, ...req })) { /* drain */ }
  } else {
    await p.complete({ model, messages: USER, ...req });
  }
  return raw[0];
}

/* ── Unset serverType: today's wire, byte for byte ─────────────────────── */

describe("serverType unset or generic: the wire is unchanged", () => {
  const MODELS = [QWEN_MLX, "Qwen/QwQ-32B", "qwen3-coder:30b", "gpt-oss-20b", "deepseek-r1:8b", "meta-llama/Llama-3.1-8B-Instruct", "anthropic/claude-sonnet-4"];
  const REASONING: Array<ReasoningRequestConfig | undefined> = [
    undefined,
    { effort: "none" },
    { effort: "high" },
    { effort: "max", includeThoughts: true },
    { budgetTokens: 2048 },
    { effort: "low", providerExtras: { chat_template_kwargs: { enable_thinking: true } } },
  ];
  const EXTRA = [undefined, { chat_template_kwargs: { enable_thinking: false, foo: 1 }, top_k: 20 }];

  it("same JSON as a provider built before serverType existed, for every model x reasoning x extra x stream", async () => {
    for (const model of MODELS) {
      for (const reasoning of REASONING) {
        for (const extra of EXTRA) {
          for (const stream of [false, true]) {
            const req: Partial<ChatCompletionRequest> = { ...(reasoning ? { reasoning } : {}), ...(extra ? { extra } : {}), temperature: 0.2, maxTokens: 64 };
            const baseline = await rawWire(undefined, model, req, stream);
            for (const server of ["generic", "nonsense"]) {
              expect(await rawWire(server, model, req, stream), `${server} ${model} ${JSON.stringify(req)} stream=${stream}`).toBe(baseline);
            }
          }
        }
      }
    }
  });

  it("today's mapping for a Qwen3: reasoning_effort, no template arguments", async () => {
    const body = await wire(undefined, QWEN_MLX, { reasoning: { effort: "none" } });
    expect(body.reasoning_effort).toBe("none");
    expect(body).not.toHaveProperty("chat_template_kwargs");
  });
});

/* ── Per server type ───────────────────────────────────────────────────── */

describe("template servers (mlx, vllm, sglang, llamacpp)", () => {
  const TEMPLATE = ["mlx", "vllm", "sglang", "llamacpp"];

  it("hybrid Qwen3: none → enable_thinking=false, every other effort → true; no reasoning_effort", async () => {
    for (const server of TEMPLATE) {
      const off = await wire(server, QWEN_MLX, { reasoning: { effort: "none" } });
      expect(off.chat_template_kwargs, server).toEqual({ enable_thinking: false });
      expect(off, server).not.toHaveProperty("reasoning_effort");
      for (const effort of ["minimal", "low", "medium", "high", "xhigh", "max"] as const) {
        const on = await wire(server, QWEN_MLX, { reasoning: { effort } });
        expect(on.chat_template_kwargs, `${server} ${effort}`).toEqual({ enable_thinking: true });
        expect(on, `${server} ${effort}`).not.toHaveProperty("reasoning_effort");
      }
      const budget = await wire(server, "Qwen/Qwen3-8B", { reasoning: { budgetTokens: 1024 } });
      expect(budget.chat_template_kwargs, server).toEqual({ enable_thinking: true });
    }
  });

  it("unset reasoning sends nothing: a caller's chat_template_kwargs goes out as written", async () => {
    const plain = await wire("mlx", QWEN_MLX);
    expect(plain).not.toHaveProperty("chat_template_kwargs");
    expect(plain).not.toHaveProperty("reasoning_effort");
    const kept = await wire("vllm", QWEN_MLX, { extra: { chat_template_kwargs: { enable_thinking: false } } });
    expect(kept.chat_template_kwargs).toEqual({ enable_thinking: false });
  });

  it("a caller's chat_template_kwargs merge one level deep; the resolved reasoning wins for its own key", async () => {
    const extra = { chat_template_kwargs: { enable_thinking: false, foo: 1 }, top_k: 20 };
    const body = await wire("vllm", "Qwen/Qwen3-8B", { reasoning: { effort: "high" }, extra });
    expect(body.chat_template_kwargs).toEqual({ enable_thinking: true, foo: 1 });
    expect(body.top_k).toBe(20);
    expect(body).not.toHaveProperty("reasoning_effort");
    // The caller's object is not mutated.
    expect(extra.chat_template_kwargs).toEqual({ enable_thinking: false, foo: 1 });
  });

  it("reasoning.providerExtras still have the last word, merged one level deep", async () => {
    const body = await wire("mlx", QWEN_MLX, {
      reasoning: { effort: "none", providerExtras: { chat_template_kwargs: { enable_thinking: true, bar: 2 }, top_k: 5 } },
    });
    expect(body.chat_template_kwargs).toEqual({ enable_thinking: true, bar: 2 });
    expect(body.top_k).toBe(5);
  });

  it("a model that always or never thinks is sent no switch and no reasoning_effort", async () => {
    for (const server of TEMPLATE) {
      for (const model of ["Qwen/QwQ-32B", "deepseek-ai/DeepSeek-R1", "qwen3-coder:30b", "Qwen/Qwen3-30B-A3B-Instruct-2507", "Qwen/Qwen3-30B-A3B-Thinking-2507"]) {
        const body = await wire(server, model, { reasoning: { effort: "none" } });
        expect(body, `${server} ${model}`).not.toHaveProperty("chat_template_kwargs");
        expect(body, `${server} ${model}`).not.toHaveProperty("reasoning_effort");
      }
    }
  });

  it("gpt-oss: MLX and llama.cpp get the level as a template argument; vLLM and SGLang keep reasoning_effort", async () => {
    for (const server of ["mlx", "llamacpp"]) {
      const body = await wire(server, "mlx-community/gpt-oss-20b-MXFP4-Q8", { reasoning: { effort: "low" } });
      expect(body.chat_template_kwargs, server).toEqual({ reasoning_effort: "low" });
      expect(body, server).not.toHaveProperty("reasoning_effort");
      expect((await wire(server, "gpt-oss-20b", { reasoning: { effort: "none" } })).chat_template_kwargs, server).toEqual({ reasoning_effort: "low" });
      expect((await wire(server, "gpt-oss-20b", { reasoning: { effort: "xhigh" } })).chat_template_kwargs, server).toEqual({ reasoning_effort: "high" });
    }
    for (const server of ["vllm", "sglang"]) {
      const body = await wire(server, "openai/gpt-oss-20b", { reasoning: { effort: "high" } });
      expect(body.reasoning_effort, server).toBe("high");
      expect(body, server).not.toHaveProperty("chat_template_kwargs");
    }
  });

  it("a model outside the table keeps the rule-driven reasoning_effort", async () => {
    const body = await wire("vllm", "meta-llama/Llama-3.1-8B-Instruct", { reasoning: { effort: "low" } });
    expect(body.reasoning_effort).toBe("low");
    expect(body).not.toHaveProperty("chat_template_kwargs");
  });

  it("streaming requests carry the same switch", async () => {
    const { p, bodies } = provider("sglang", () => new Response(sse([delta({ content: "ok" }, "stop")]), { status: 200 }));
    for await (const _ of p.completeStream({ model: "Qwen/Qwen3-8B", messages: USER, reasoning: { effort: "none" } })) { /* drain */ }
    expect(bodies[0].chat_template_kwargs).toEqual({ enable_thinking: false });
    expect(bodies[0]).not.toHaveProperty("reasoning_effort");
    expect(bodies[0].stream).toBe(true);
  });

  it("a learned drop of chat_template_kwargs is honoured (no resend loop)", async () => {
    let n = 0;
    const bodies: any[] = [];
    const fetchImpl = (async (_u: any, init: any) => {
      bodies.push(JSON.parse(init.body));
      n++;
      if (n === 1) {
        return new Response(JSON.stringify({ error: { message: "Unrecognized request argument supplied: chat_template_kwargs", type: "invalid_request_error", param: "chat_template_kwargs" } }), { status: 400 });
      }
      return new Response(JSON.stringify(completion({ content: "ok" })), { status: 200 });
    }) as typeof fetch;
    const p = new OpenAICompatibleProvider({ provider: "openai-compatible", apiKey: "k", baseURL: "http://strict.local/v1", fetch: fetchImpl, retry: { maxRetries: 0 }, serverType: "vllm" });
    const res = await p.complete({ model: "Qwen/Qwen3-8B", messages: USER, reasoning: { effort: "none" } });
    expect(res.content).toBe("ok");
    expect(bodies).toHaveLength(2);
    expect(bodies[0].chat_template_kwargs).toEqual({ enable_thinking: false });
    expect(bodies[1]).not.toHaveProperty("chat_template_kwargs");
  });
});

describe("hosted servers", () => {
  it("DashScope: a top-level enable_thinking for a hybrid Qwen3", async () => {
    const off = await wire("dashscope", "qwen3-32b", { reasoning: { effort: "none" } });
    expect(off.enable_thinking).toBe(false);
    expect(off).not.toHaveProperty("reasoning_effort");
    expect(off).not.toHaveProperty("chat_template_kwargs");
    expect((await wire("dashscope", "qwen3-32b", { reasoning: { effort: "medium" } })).enable_thinking).toBe(true);
  });

  it("OpenRouter: reasoning { enabled } for a toggle, reasoning { effort } for levels, nothing for fixed models", async () => {
    const off = await wire("openrouter", "qwen/qwen3-32b", { reasoning: { effort: "none" } });
    expect(off.reasoning).toEqual({ enabled: false });
    expect(off).not.toHaveProperty("reasoning_effort");
    expect((await wire("openrouter", "qwen/qwen3-32b", { reasoning: { effort: "high" } })).reasoning).toEqual({ effort: "high" });
    expect((await wire("openrouter", "openai/gpt-oss-120b", { reasoning: { effort: "max" } })).reasoning).toEqual({ effort: "high" });
    const fixed = await wire("openrouter", "deepseek/deepseek-r1", { reasoning: { effort: "none" } });
    expect(fixed).not.toHaveProperty("reasoning");
    expect(fixed).not.toHaveProperty("reasoning_effort");
    // A caller's reasoning object keeps its other keys.
    const merged = await wire("openrouter", "qwen/qwen3-32b", { reasoning: { effort: "none" }, extra: { reasoning: { exclude: true, enabled: true } } });
    expect(merged.reasoning).toEqual({ exclude: true, enabled: false });
  });

  it("OpenRouter: a model outside the table keeps reasoning_effort", async () => {
    const body = await wire("openrouter", "anthropic/claude-sonnet-4", { reasoning: { effort: "low" } });
    expect(body.reasoning_effort).toBe("low");
    expect(body).not.toHaveProperty("reasoning");
  });

  it("OpenAI, Ollama and LM Studio keep reasoning_effort and get no template arguments", async () => {
    for (const server of ["openai", "ollama", "lmstudio"]) {
      const body = await wire(server, "qwen3:8b", { reasoning: { effort: "none" } });
      expect(body.reasoning_effort, server).toBe("none");
      expect(body, server).not.toHaveProperty("chat_template_kwargs");
    }
  });

  it("the Responses API is left alone: no template arguments in a Responses body", async () => {
    const bodies: any[] = [];
    const urls: string[] = [];
    const fetchImpl = (async (u: any, init: any) => {
      urls.push(String(u));
      bodies.push(JSON.parse(init.body));
      return new Response(JSON.stringify({ id: "r1", object: "response", status: "completed", model: "m", output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "ok" }] }], usage: { input_tokens: 1, output_tokens: 1 } }), { status: 200 });
    }) as typeof fetch;
    const p = new OpenAICompatibleProvider({ provider: "openai-compatible", apiKey: "k", baseURL: "http://pool.local/v1", fetch: fetchImpl, retry: { maxRetries: 0 }, serverType: "vllm", api: "responses" });
    await p.complete({ model: "Qwen/Qwen3-8B", messages: USER, reasoning: { effort: "none" } });
    expect(urls[0]).toBe("http://pool.local/v1/responses");
    expect(bodies[0]).not.toHaveProperty("chat_template_kwargs");
  });
});

/* ── The answer after split-off reasoning ──────────────────────────────── */

const THINKING = "The user asks 2+2. That is 4.";

async function completeWith(serverType: string | undefined, message: Record<string, unknown>) {
  const { p } = provider(serverType, () => new Response(JSON.stringify(completion(message)), { status: 200 }));
  return p.complete({ model: QWEN_MLX, messages: USER });
}

async function streamWith(serverType: string | undefined, events: unknown[]) {
  const { p } = provider(serverType, () => new Response(sse(events), { status: 200 }));
  let content = "";
  let reasoning = "";
  let outputTokens = 0;
  let finish: string | undefined;
  const contents: Array<string | undefined> = [];
  for await (const chunk of p.completeStream({ model: QWEN_MLX, messages: USER })) {
    contents.push(chunk.delta.content);
    content += chunk.delta.content ?? "";
    reasoning += chunk.delta.reasoning?.summary ?? "";
    if (chunk.usage) outputTokens = chunk.usage.outputTokens;
    if (chunk.finishReason) finish = chunk.finishReason;
  }
  return { content, reasoning, outputTokens, finish, contents };
}

describe("answer separator after split-off reasoning (non-streamed)", () => {
  it("MLX `reasoning` and vLLM `reasoning_content`: the template's blank line is removed", async () => {
    for (const server of ["mlx", "vllm", "sglang", "llamacpp"]) {
      for (const field of ["reasoning", "reasoning_content"]) {
        const res = await completeWith(server, { content: "\n\n4", [field]: THINKING });
        expect(res.content, `${server} ${field}`).toBe("4");
        expect(res.reasoning?.summary, `${server} ${field}`).toBe(THINKING);
        expect(res.usage.outputTokens).toBe(148);
      }
    }
  });

  it("indentation after the separator is kept: spaces and tabs are never stripped", async () => {
    expect((await completeWith("mlx", { content: "\n\n    print(\"hello\")", reasoning: THINKING })).content).toBe("    print(\"hello\")");
    expect((await completeWith("vllm", { content: "\n\n\tx = 1", reasoning_content: THINKING })).content).toBe("\tx = 1");
    expect((await completeWith("vllm", { content: "  - item", reasoning_content: THINKING })).content).toBe("  - item");
    expect((await completeWith("vllm", { content: "\r\n\r\n```py\n    a\n```", reasoning_content: THINKING })).content).toBe("```py\n    a\n```");
  });

  it("only the separator goes: a third newline is the model's own", async () => {
    expect((await completeWith("mlx", { content: "\n\n\nX", reasoning: THINKING })).content).toBe("\nX");
    expect((await completeWith("mlx", { content: "\nX", reasoning: THINKING })).content).toBe("X");
  });

  it("an answer that was only the separator (a tool call followed) becomes null", async () => {
    expect((await completeWith("vllm", { content: "\n\n", reasoning_content: THINKING })).content).toBeNull();
  });

  it("without split-off reasoning the answer is left exactly as sent", async () => {
    expect((await completeWith("mlx", { content: "\n\n4" })).content).toBe("\n\n4");
  });

  it("unset, generic and servers that do not leave the separator: the answer is untouched", async () => {
    for (const server of [undefined, "generic", "openai", "ollama", "lmstudio", "dashscope", "openrouter"]) {
      expect((await completeWith(server, { content: "\n\n4", reasoning: THINKING })).content, String(server)).toBe("\n\n4");
    }
  });
});

describe("answer separator after split-off reasoning (streamed)", () => {
  const events = (field: string, answer: Array<Record<string, unknown>>) => [
    delta({ role: "assistant", content: "" }),
    delta({ [field]: "The user asks 2+2. " }),
    delta({ [field]: "That is 4." }),
    ...answer.map((d, i) => delta(d, i === answer.length - 1 ? "stop" : null)),
    usageChunk,
  ];

  it("the blank line split over chunks is dropped; reasoning and usage stay", async () => {
    for (const server of ["mlx", "vllm"]) {
      for (const field of ["reasoning", "reasoning_content"]) {
        const out = await streamWith(server, events(field, [{ content: "\n" }, { content: "\n" }, { content: "4" }, { content: "\n\nDone." }]));
        expect(out.content, `${server} ${field}`).toBe("4\n\nDone.");
        expect(out.reasoning, `${server} ${field}`).toBe(THINKING);
        expect(out.outputTokens).toBe(148);
        expect(out.finish).toBe("stop");
      }
    }
  });

  it("indentation split over chunks is kept: \\n, \\n, then four spaces", async () => {
    const out = await streamWith("mlx", events("reasoning", [{ content: "\n" }, { content: "\n" }, { content: "    print" }, { content: "(\"hi\")" }]));
    expect(out.content).toBe("    print(\"hi\")");
    const together = await streamWith("vllm", events("reasoning_content", [{ content: "\n\n    print" }]));
    expect(together.content).toBe("    print");
    const spacesFirst = await streamWith("vllm", events("reasoning_content", [{ content: "\n" }, { content: "\n    " }, { content: "print" }]));
    expect(spacesFirst.content).toBe("    print");
    const tabs = await streamWith("sglang", events("reasoning_content", [{ content: "\n\n\t" }, { content: "x" }]));
    expect(tabs.content).toBe("\tx");
  });

  it("only two newlines go, however they are split", async () => {
    const out = await streamWith("mlx", events("reasoning", [{ content: "\n" }, { content: "\n" }, { content: "\n" }, { content: "X" }]));
    expect(out.content).toBe("\nX");
  });

  it("a chunk left empty by the strip still arrives, without content", async () => {
    const out = await streamWith("mlx", events("reasoning", [{ content: "\n" }, { content: "\n" }, { content: "4" }]));
    expect(out.contents.filter((c) => c === "\n")).toHaveLength(0);
    expect(out.content).toBe("4");
  });

  it("without reasoning a leading newline is the model's own and is kept", async () => {
    const out = await streamWith("mlx", [delta({ content: "\n" }), delta({ content: "Hi" }, "stop")]);
    expect(out.content).toBe("\nHi");
  });

  it("unset and generic servers stream the answer untouched", async () => {
    for (const server of [undefined, "generic", "ollama"]) {
      const out = await streamWith(server, events("reasoning", [{ content: "\n" }, { content: "\n" }, { content: "4" }]));
      expect(out.content, String(server)).toBe("\n\n4");
    }
  });
});
