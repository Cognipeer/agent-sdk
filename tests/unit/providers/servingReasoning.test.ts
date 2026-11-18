/**
 * OpenAI-compatible `serverType`: the request's reasoning in the form the
 * server reads (a self-hosted Qwen3 is switched by its chat template, not by
 * `reasoning_effort`), and the answer without the blank line the template
 * leaves after split-off reasoning. Unset `serverType` keeps the wire as it was.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { OpenAICompatibleProvider } from "../../../src/providers/openaiCompatible.js";
import { clearLearnedModelRules, describeServingReasoning, SERVER_TYPES } from "../../../src/models/index.js";
import { stripAnswerSeparator, stripStreamSeparator } from "../../../src/providers/utils/reasoningSeparator.js";
import type { ChatCompletionChunk, ChatCompletionRequest, ChatCompletionResponse, OpenAICompatibleProviderConfig, ReasoningRequestConfig } from "../../../src/providers/types.js";

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

/* ── describeServingReasoning says what the wire does ──────────────────── */

describe("describeServingReasoning matches the request the provider builds", () => {
  const MODELS = [
    QWEN_MLX, "qwen3:8b", "Qwen/QwQ-32B", "qwen3-coder:30b", "Qwen/Qwen3-30B-A3B-Thinking-2507", "gpt-oss-20b",
    "deepseek-r1:8b", "meta-llama/Llama-3.1-8B-Instruct", "gpt-4o", "chatgpt-4o-latest", "o3-mini", "openai/gpt-5",
  ];
  const FIELDS = ["chat_template_kwargs", "enable_thinking", "reasoning", "reasoning_effort"] as const;

  it("the wire it names is the one reasoning field sent, and `none` sends none, for every server type", async () => {
    for (const server of SERVER_TYPES) {
      for (const model of MODELS) {
        const described = describeServingReasoning(server, model).wire;
        for (const effort of ["none", "high"] as const) {
          const body = await wire(server, model, { reasoning: { effort } });
          const sent = FIELDS.filter((f) => f in body);
          expect(sent, `${server} ${model} ${effort}`).toEqual(described === "none" ? [] : [described]);
        }
      }
    }
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

  it("the Responses API answer is left as sent, with a reasoning summary, through every completion path", async () => {
    const answer = "\n\n    print(1)";
    const responseJson = {
      id: "r1", object: "response", status: "completed", model: "m",
      output: [
        { type: "reasoning", id: "rs_1", summary: [{ type: "summary_text", text: THINKING }] },
        { type: "message", role: "assistant", content: [{ type: "output_text", text: answer }] },
      ],
      usage: { input_tokens: 1, output_tokens: 1 },
    };
    const events = [
      { type: "response.created", response: { id: "r1", model: "m" } },
      { type: "response.reasoning_summary_text.delta", delta: THINKING },
      { type: "response.output_text.delta", delta: "\n" },
      { type: "response.output_text.delta", delta: "\n" },
      { type: "response.output_text.delta", delta: "    print(1)" },
      { type: "response.completed", response: responseJson },
    ];
    const make = (responsesStreaming: boolean | undefined, stream: boolean) => {
      const fetchImpl = (async () => stream
        ? new Response(sse(events), { status: 200 })
        : new Response(JSON.stringify(responseJson), { status: 200 })) as unknown as typeof fetch;
      return new OpenAICompatibleProvider({
        provider: "openai-compatible", apiKey: "k", baseURL: "http://pool.local/v1", fetch: fetchImpl, retry: { maxRetries: 0 },
        serverType: "vllm", api: "responses", ...(responsesStreaming !== undefined ? { responsesStreaming } : {}),
      });
    };
    const done = await make(undefined, false).complete({ model: "Qwen/Qwen3-8B", messages: USER });
    expect(done.reasoning?.summary).toBe(THINKING);
    expect(done.content).toBe(answer);
    for (const [label, p] of [["synthetic stream", make(false, false)], ["event stream", make(true, true)]] as const) {
      let content = "";
      let reasoning = "";
      for await (const chunk of p.completeStream({ model: "Qwen/Qwen3-8B", messages: USER })) {
        content += chunk.delta.content ?? "";
        reasoning += chunk.delta.reasoning?.summary ?? "";
      }
      expect(reasoning, label).toBe(THINKING);
      expect(content, label).toBe(answer);
    }
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

  it("a CRLF split across chunks counts as one line break", async () => {
    const out = await streamWith("mlx", events("reasoning", [{ content: "\r" }, { content: "\n" }, { content: "\r\n" }, { content: "4" }]));
    expect(out.content).toBe("4");
    const mixed = await streamWith("vllm", events("reasoning_content", [{ content: "\n\r" }, { content: "\n    x" }]));
    expect(mixed.content).toBe("    x");
    const third = await streamWith("vllm", events("reasoning_content", [{ content: "\r" }, { content: "\n\r" }, { content: "\n" }, { content: "\r" }, { content: "\nX" }]));
    expect(third.content).toBe("\r\nX");
  });

  it("a lone CR is answer text and is kept, also when the stream ends on it", async () => {
    const text = await streamWith("mlx", events("reasoning", [{ content: "\r" }, { content: "X" }]));
    expect(text.content).toBe("\rX");
    // The CR is the last content and its chunk carries the finish reason: it arrives, and so does the finish.
    const last = await streamWith("mlx", events("reasoning", [{ content: "\n" }, { content: "\r" }]));
    expect(last.content).toBe("\r");
    expect(last.finish).toBe("stop");
    expect(last.outputTokens).toBe(148);
    // Nothing follows the CR at all (no finish chunk, no usage): it is still delivered.
    const bare = await streamWith("vllm", [delta({ reasoning_content: THINKING }), delta({ content: "\r" })]);
    expect(bare.content).toBe("\r");
    expect(bare.reasoning).toBe(THINKING);
  });

  it("a CR in the chunk that carries the finish reason arrives with it, not after (a consumer may stop there)", async () => {
    const { p } = provider("mlx", () => new Response(sse([
      delta({ reasoning: THINKING }),
      delta({ content: "\n" }),
      delta({ content: "\r" }, "stop"),
      usageChunk,
    ]), { status: 200 }));
    let content = "";
    for await (const chunk of p.completeStream({ model: QWEN_MLX, messages: USER })) {
      content += chunk.delta.content ?? "";
      if (chunk.finishReason) break; // an early-closing consumer
    }
    expect(content).toBe("\r");
    // Same when the CR closes the answer and only usage follows in the same chunk.
    const { p: q } = provider("vllm", () => new Response(sse([
      delta({ reasoning_content: THINKING }),
      { ...delta({ content: "\r" }), usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } },
    ]), { status: 200 }));
    const seen: Array<{ content?: string; usage: boolean }> = [];
    for await (const chunk of q.completeStream({ model: QWEN_MLX, messages: USER })) {
      if (chunk.delta.content !== undefined || chunk.usage) seen.push({ content: chunk.delta.content, usage: !!chunk.usage });
    }
    expect(seen).toEqual([{ content: "\r", usage: true }]);
  });

  it("usage on every chunk (vLLM continuous_usage_stats) is not an end of the answer", async () => {
    const u = (n: number) => ({ prompt_tokens: 10, completion_tokens: n, total_tokens: 10 + n });
    const { p } = provider("vllm", () => new Response(sse([
      { ...delta({ reasoning_content: THINKING }), usage: u(1) },
      { ...delta({ content: "\r" }), usage: u(2) },
      { ...delta({ content: "\n" }), usage: u(3) },
      { ...delta({ content: "\r" }), usage: u(4) },
      { ...delta({ content: "\n" }), usage: u(5) },
      { ...delta({ content: "X" }, "stop"), usage: u(6) },
    ]), { status: 200 }));
    let content = "";
    let outputTokens = 0;
    for await (const chunk of p.completeStream({ model: "Qwen/Qwen3-8B", messages: USER, extra: { stream_options: { include_usage: true, continuous_usage_stats: true } } })) {
      content += chunk.delta.content ?? "";
      if (chunk.usage) outputTokens = chunk.usage.outputTokens;
    }
    expect(content).toBe("X");
    expect(outputTokens).toBe(6);
  });

  it("every chunk partition streams the same answer as the non-streamed cleanup", async () => {
    const answers = ["\r\n\r\nX", "\n\r\n    y", "\r\n\n\tz", "\n\n\nZ", "\r\rA", "\rB", "\n\rC", "\r\n", "\n\r", "\n\n", "\r"];
    const partitions = (text: string): string[][] => {
      if (text.length <= 1) return [[text]];
      const out: string[][] = [];
      for (let mask = 0; mask < 1 << (text.length - 1); mask++) {
        const parts: string[] = [];
        let cur = text[0];
        for (let i = 1; i < text.length; i++) {
          if (mask & (1 << (i - 1))) { parts.push(cur); cur = text[i]; } else cur += text[i];
        }
        parts.push(cur);
        out.push(parts);
      }
      return out;
    };
    const base = { id: "c", model: "m" };
    const usage = { inputTokens: 1, outputTokens: 1, totalTokens: 2, cachedInputTokens: 0, cachedWriteTokens: 0, cachedOutputTokens: 0, reasoningTokens: 0 };
    let checked = 0;
    for (const answer of answers) {
      const expected = stripAnswerSeparator({ ...base, content: answer, toolCalls: [], usage, finishReason: "stop", reasoning: { summary: THINKING }, raw: {} } as ChatCompletionResponse).content ?? "";
      for (const parts of partitions(answer)) {
        for (const withUsage of [false, true]) {
          async function* source(): AsyncGenerator<ChatCompletionChunk> {
            yield { ...base, delta: { reasoning: { summary: THINKING } }, ...(withUsage ? { usage } : {}) };
            for (let i = 0; i < parts.length; i++) {
              yield { ...base, delta: { content: parts[i] }, ...(withUsage ? { usage } : {}), ...(i === parts.length - 1 ? { finishReason: "stop" as const } : {}) };
            }
          }
          let got = "";
          let finishSeenWith = "";
          for await (const chunk of stripStreamSeparator(source())) {
            got += chunk.delta.content ?? "";
            if (chunk.finishReason) finishSeenWith = got;
          }
          expect(got, JSON.stringify({ parts, withUsage })).toBe(expected);
          // Every character is out by the time the finish reason arrives.
          expect(finishSeenWith, JSON.stringify({ parts, withUsage })).toBe(expected);
          checked++;
        }
      }
    }
    expect(checked).toBeGreaterThan(50);
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
