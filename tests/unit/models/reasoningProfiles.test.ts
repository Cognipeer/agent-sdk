/**
 * Open-weight reasoning profiles (model-rules.json `reasoningProfiles`) and the
 * server types of an OpenAI-compatible endpoint: which models can be switched
 * at all, and where a server reads the switch.
 */
import { describe, it, expect } from "vitest";
import {
  MODEL_RULES,
  SERVER_TYPES,
  describeServingReasoning,
  normalizeServerType,
  resolveReasoningProfile,
} from "../../../src/model-rules.js";
import { planServingReasoning } from "../../../src/models/serving.js";
import { resolveModelRule } from "../../../src/models/rules.js";

const style = (id: string) => resolveReasoningProfile(id)?.style;

describe("reasoning profile matching", () => {
  it("hybrid Qwen3 under any id spelling: HF repo, MLX quant, pool key, Ollama tag", () => {
    for (const id of [
      "Qwen/Qwen3-8B",
      "mlx-community/Qwen3.5-9B-4bit",
      "qwen3-5-9b",
      "Qwen3-30B-A3B",
      "mlx-community/Qwen3.6-35B-A3B-4bit",
      "qwen3:8b",
      "qwen3:30b-a3b",
      "QWEN3-32B",
    ]) {
      expect(style(id), id).toBe("toggle");
    }
    expect(resolveReasoningProfile("Qwen/Qwen3-8B")).toMatchObject({ id: "qwen3-hybrid", templateSwitch: "enable_thinking", parser: "qwen3" });
  });

  it("Instruct-2507, Coder and VL-Instruct releases never think, under HF ids and colon tags", () => {
    for (const id of [
      "Qwen/Qwen3-30B-A3B-Instruct-2507",
      "Qwen/Qwen3-235B-A22B-Instruct-2507-FP8",
      "Qwen/Qwen3-Coder-30B-A3B-Instruct-FP8",
      "mlx-community/Qwen3-Coder-30B-A3B-Instruct-4bit",
      "Qwen/Qwen3-VL-8B-Instruct",
      "Qwen/Qwen3-Next-80B-A3B-Instruct",
      "qwen3-coder:30b",
      "qwen3-coder",
      "qwen3:30b-a3b-instruct-2507-q4_K_M",
      "qwen3:4b-instruct-2507-q4_K_M",
    ]) {
      expect(style(id), id).toBe("none");
    }
  });

  it("Thinking-2507, QwQ and DeepSeek-R1 always think", () => {
    for (const id of [
      "Qwen/Qwen3-235B-A22B-Thinking-2507-FP8",
      "Qwen/Qwen3-30B-A3B-Thinking-2507",
      "Qwen/Qwen3-VL-8B-Thinking",
      "qwen3:4b-thinking-2507-q4_K_M",
      "qwen3:30b-a3b-thinking-2507",
      "Qwen/QwQ-32B",
      "qwq:32b",
      "deepseek-ai/DeepSeek-R1",
      "deepseek-ai/DeepSeek-R1-Distill-Qwen-7B",
      "deepseek-r1:8b",
      "deepseek-reasoner",
    ]) {
      expect(style(id), id).toBe("always");
    }
    expect(resolveReasoningProfile("deepseek-ai/DeepSeek-R1")?.parser).toBe("deepseek_r1");
    expect(resolveReasoningProfile("Qwen/Qwen3-235B-A22B-Thinking-2507")?.parser).toBe("deepseek_r1");
  });

  it("gpt-oss takes effort levels; models outside the table get no profile", () => {
    expect(style("openai/gpt-oss-20b")).toBe("effort");
    expect(style("mlx-community/gpt-oss-20b-MXFP4-Q8")).toBe("effort");
    expect(style("gpt-oss:120b")).toBe("effort");
    expect(resolveReasoningProfile("gpt-oss-20b")?.templateSwitch).toBe("reasoning_effort");
    for (const id of ["Qwen/Qwen2.5-7B-Instruct", "qwen2.5-coder:7b", "gpt-4o", "meta-llama/Llama-3.1-8B-Instruct", "claude-sonnet-4-5", "", undefined]) {
      expect(resolveReasoningProfile(id as string | undefined), String(id)).toBeUndefined();
    }
  });

  it("every profile is valid data: a known style, a compiling pattern, a source and a note", () => {
    const profiles = MODEL_RULES.reasoningProfiles;
    expect(profiles.length).toBeGreaterThanOrEqual(6);
    for (const p of profiles) {
      expect(["toggle", "always", "none", "effort"], p.id).toContain(p.style);
      expect(() => new RegExp(p.match, "i"), p.id).not.toThrow();
      expect(p.source, p.id).toBeTruthy();
      expect(p.note, p.id).toBeTruthy();
    }
    expect(new Set(profiles.map((p) => p.id)).size).toBe(profiles.length);
  });

  it("leaves the wire rules alone: Qwen3-Coder still resolves the same openai rule as before", () => {
    expect(resolveModelRule({ provider: "openai-compatible", model: "qwen3-coder:30b" }).matchedRuleId).toBe("openai-compatible-toggle");
    expect(resolveModelRule({ provider: "openai-compatible", model: "Qwen/Qwen3-30B-A3B-Instruct-2507" }).matchedRuleId).toBe("openai-compatible-toggle");
  });
});

describe("server types", () => {
  it("lists the known types; anything else is generic", () => {
    expect([...SERVER_TYPES]).toEqual(["generic", "openai", "vllm", "sglang", "mlx", "llamacpp", "ollama", "lmstudio", "dashscope", "openrouter"]);
    expect(normalizeServerType("MLX")).toBe("mlx");
    expect(normalizeServerType(" vllm ")).toBe("vllm");
    expect(normalizeServerType("tgi")).toBe("generic");
    expect(normalizeServerType(undefined)).toBe("generic");
    expect(normalizeServerType(42)).toBe("generic");
  });
});

describe("describeServingReasoning", () => {
  const QWEN = "mlx-community/Qwen3.5-9B-4bit";

  it("a hybrid Qwen3 is switched through the template on template servers", () => {
    for (const server of ["mlx", "vllm", "sglang", "llamacpp"]) {
      expect(describeServingReasoning(server, QWEN), server).toMatchObject({ wire: "chat_template_kwargs", effective: "yes" });
    }
    expect(describeServingReasoning("dashscope", QWEN)).toMatchObject({ wire: "enable_thinking", effective: "yes" });
    expect(describeServingReasoning("openrouter", QWEN)).toMatchObject({ wire: "reasoning", effective: "yes" });
    expect(describeServingReasoning("ollama", QWEN)).toMatchObject({ wire: "reasoning_effort", effective: "yes" });
  });

  it("a hybrid Qwen3 on a server whose switch is unknown: reasoning_effort, effect unknown", () => {
    for (const server of [undefined, "generic", "openai", "lmstudio", "nonsense"]) {
      expect(describeServingReasoning(server, QWEN), String(server)).toMatchObject({ wire: "reasoning_effort", effective: "unknown" });
    }
  });

  it("a model that always or never thinks has nothing to switch on a known server", () => {
    expect(describeServingReasoning("vllm", "Qwen/QwQ-32B")).toMatchObject({ wire: "none", effective: "no" });
    expect(describeServingReasoning("mlx", "qwen3-coder:30b")).toMatchObject({ wire: "none", effective: "no" });
    expect(describeServingReasoning("generic", "Qwen/QwQ-32B")).toMatchObject({ wire: "reasoning_effort", effective: "no" });
  });

  it("gpt-oss: the template on MLX / llama.cpp, reasoning_effort elsewhere", () => {
    expect(describeServingReasoning("mlx", "gpt-oss-20b")).toMatchObject({ wire: "chat_template_kwargs", effective: "yes" });
    expect(describeServingReasoning("llamacpp", "gpt-oss-20b")).toMatchObject({ wire: "chat_template_kwargs", effective: "yes" });
    expect(describeServingReasoning("vllm", "gpt-oss-20b")).toMatchObject({ wire: "reasoning_effort", effective: "yes" });
    expect(describeServingReasoning("openrouter", "openai/gpt-oss-120b")).toMatchObject({ wire: "reasoning", effective: "yes" });
  });

  it("a model outside the table: its model rule decides (no claim of an effect the wire does not have)", () => {
    // Only the permissive default rule matched: whether the model reasons is not known.
    for (const server of ["vllm", "generic", "openrouter"]) {
      const d = describeServingReasoning(server, "meta-llama/Llama-3.1-8B-Instruct");
      expect(d.profile, server).toBeUndefined();
      expect(d, server).toMatchObject({ wire: "reasoning_effort", effective: "unknown" });
    }
    // A rule without reasoning control: nothing is sent, nothing takes effect.
    for (const model of ["gpt-4o", "openai/gpt-4o-mini", "chatgpt-4o-latest", "gpt-3.5-turbo"]) {
      for (const server of ["vllm", "generic", "openrouter", "mlx"]) {
        expect(describeServingReasoning(server, model), `${server} ${model}`).toMatchObject({ wire: "none", effective: "no" });
      }
    }
    // A rule that knows the model's effort values: the setting takes effect.
    for (const model of ["openai/gpt-5", "o3-mini", "gpt-5.1"]) {
      expect(describeServingReasoning("openrouter", model), model).toMatchObject({ wire: "reasoning_effort", effective: "yes" });
    }
  });
});

describe("planServingReasoning", () => {
  const QWEN = "mlx-community/Qwen3.5-9B-4bit";
  const plan = (serverType: string | undefined, model: string, reasoning: any) =>
    planServingReasoning({ serverType, model, reasoning, rule: resolveModelRule({ provider: "openai-compatible", model }) });

  it("template servers: none is enable_thinking=false, any other effort or a budget is true, unset or no switch sends nothing", () => {
    for (const server of ["mlx", "vllm", "sglang", "llamacpp"]) {
      expect(plan(server, QWEN, { effort: "none" })).toEqual({ fields: { chat_template_kwargs: { enable_thinking: false } } });
      for (const effort of ["minimal", "low", "medium", "high", "xhigh", "max"]) {
        expect(plan(server, QWEN, { effort })).toEqual({ fields: { chat_template_kwargs: { enable_thinking: true } } });
      }
      expect(plan(server, QWEN, { budgetTokens: 2048 })).toEqual({ fields: { chat_template_kwargs: { enable_thinking: true } } });
      expect(plan(server, QWEN, undefined)).toBeUndefined();
      expect(plan(server, QWEN, { includeThoughts: true })).toBeUndefined();
      expect(plan(server, QWEN, { budgetTokens: 0 })).toBeUndefined();
    }
  });

  it("DashScope takes a top-level switch; OpenRouter its reasoning object", () => {
    expect(plan("dashscope", QWEN, { effort: "none" })).toEqual({ fields: { enable_thinking: false } });
    expect(plan("dashscope", QWEN, { effort: "high" })).toEqual({ fields: { enable_thinking: true } });
    expect(plan("openrouter", "qwen/qwen3-32b", { effort: "none" })).toEqual({ fields: { reasoning: { enabled: false } } });
    expect(plan("openrouter", "qwen/qwen3-32b", { effort: "high" })).toEqual({ fields: { reasoning: { effort: "high" } } });
    expect(plan("openrouter", "qwen/qwen3-32b", { budgetTokens: 4096 })).toEqual({ fields: { reasoning: { enabled: true } } });
  });

  it("generic, OpenAI, Ollama and LM Studio keep today's mapping (no plan)", () => {
    for (const server of [undefined, "generic", "openai", "ollama", "lmstudio"]) {
      expect(plan(server, QWEN, { effort: "none" }), String(server)).toBeUndefined();
      expect(plan(server, "Qwen/QwQ-32B", { effort: "none" }), String(server)).toBeUndefined();
      expect(plan(server, "gpt-oss-20b", { effort: "high" }), String(server)).toBeUndefined();
    }
  });

  it("gpt-oss: MLX and llama.cpp read the level from the template, mapped by the model's rule", () => {
    expect(plan("mlx", "mlx-community/gpt-oss-20b-MXFP4-Q8", { effort: "high" })).toEqual({ fields: { chat_template_kwargs: { reasoning_effort: "high" } } });
    expect(plan("llamacpp", "gpt-oss-20b", { effort: "none" })).toEqual({ fields: { chat_template_kwargs: { reasoning_effort: "low" } } });
    expect(plan("mlx", "gpt-oss-20b", { effort: "max" })).toEqual({ fields: { chat_template_kwargs: { reasoning_effort: "high" } } });
    expect(plan("mlx", "gpt-oss-20b", { budgetTokens: 4096 })).toBeUndefined();
    expect(plan("vllm", "gpt-oss-20b", { effort: "high" })).toBeUndefined();
    expect(plan("sglang", "gpt-oss-20b", { effort: "high" })).toBeUndefined();
    expect(plan("openrouter", "openai/gpt-oss-120b", { effort: "max" })).toEqual({ fields: { reasoning: { effort: "high" } } });
    expect(plan("openrouter", "openai/gpt-oss-120b", { effort: "none" })).toEqual({ fields: { reasoning: { effort: "low" } } });
  });

  it("a model that always or never thinks: no switch on a known server (the typed effort is dropped)", () => {
    for (const server of ["mlx", "vllm", "sglang", "llamacpp", "dashscope", "openrouter"]) {
      expect(plan(server, "Qwen/QwQ-32B", { effort: "none" }), server).toEqual({ fields: {} });
      expect(plan(server, "qwen3-coder:30b", { effort: "high" }), server).toEqual({ fields: {} });
    }
  });

  it("a model outside the table is left to the rules on every server", () => {
    for (const server of SERVER_TYPES) {
      expect(plan(server, "meta-llama/Llama-3.1-8B-Instruct", { effort: "high" }), server).toBeUndefined();
    }
  });
});
