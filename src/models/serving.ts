// Where an OpenAI-compatible server reads a request's reasoning.
//
// The SDK maps the unified `reasoning` config to `reasoning_effort` on Chat
// Completions. That reaches OpenAI and the servers that read the field, but a
// self-hosted hybrid model (Qwen3) behind a server that renders the model's own
// chat template (mlx_lm.server, vLLM, SGLang, llama.cpp) is switched by a
// template variable (`chat_template_kwargs.enable_thinking`) and ignores
// `reasoning_effort`. The wire form therefore depends on two things known
// before the call: the server type (`OpenAICompatibleProviderConfig.serverType`)
// and the model's reasoning profile (model-rules.json `reasoningProfiles`).
//
// Pure and client-safe: the provider applies the plan, and a UI can read
// `describeServingReasoning` to say whether a reasoning setting takes effect.
// A combination this file does not know returns no plan, so the request goes
// out exactly as it did before `serverType` existed.

import type { ReasoningRequestConfig } from "../providers/types.js";
import { mapReasoningEffort, resolveReasoningProfile, type ModelRule, type ReasoningEffort, type ReasoningProfile } from "./rules.js";

/**
 * What answers an OpenAI-compatible base URL. `generic` (the default) keeps the
 * SDK's mapping for every model; so do `openai`, `ollama` and `lmstudio`, which
 * read `reasoning_effort` themselves.
 */
export const SERVER_TYPES = [
  "generic",
  "openai",
  "vllm",
  "sglang",
  "mlx",
  "llamacpp",
  "ollama",
  "lmstudio",
  "dashscope",
  "openrouter",
] as const;
export type ServerType = (typeof SERVER_TYPES)[number];

const SERVER_TYPE_SET: ReadonlySet<string> = new Set(SERVER_TYPES);

/** The server type a setting names; anything else (unset, a typo, a type this version does not know) is `generic`. */
export function normalizeServerType(value: unknown): ServerType {
  const type = typeof value === "string" ? value.trim().toLowerCase() : "";
  return SERVER_TYPE_SET.has(type) ? (type as ServerType) : "generic";
}

/** Servers that render the model's chat template and take per-request template arguments (`chat_template_kwargs`). */
const TEMPLATE_SERVERS: ReadonlySet<ServerType> = new Set<ServerType>(["vllm", "sglang", "mlx", "llamacpp"]);
/** Template servers that read no top-level `reasoning_effort`: gpt-oss takes its level as the template variable. */
const LEVEL_IN_TEMPLATE: ReadonlySet<ServerType> = new Set<ServerType>(["mlx", "llamacpp"]);

/**
 * Where a server reads the reasoning of a model:
 * `chat_template_kwargs` (a template variable), `enable_thinking` (a top-level
 * switch, Alibaba Model Studio / DashScope), `reasoning` (OpenRouter's reasoning
 * object), `reasoning_effort` (the SDK's default mapping) or `none` (the model
 * has nothing to switch and the server is sent nothing).
 */
export type ServingReasoningWire = "chat_template_kwargs" | "enable_thinking" | "reasoning" | "reasoning_effort" | "none";

function wireFor(serverType: ServerType, profile: ReasoningProfile | undefined): ServingReasoningWire {
  if (!profile) return "reasoning_effort";
  const template = TEMPLATE_SERVERS.has(serverType);
  switch (profile.style) {
    case "toggle":
      if (template && profile.templateSwitch === "enable_thinking") return "chat_template_kwargs";
      if (serverType === "dashscope") return "enable_thinking";
      if (serverType === "openrouter") return "reasoning";
      return "reasoning_effort";
    case "effort":
      if (LEVEL_IN_TEMPLATE.has(serverType) && profile.templateSwitch === "reasoning_effort") return "chat_template_kwargs";
      if (serverType === "openrouter") return "reasoning";
      return "reasoning_effort";
    case "always":
    case "none":
      // Nothing to switch: a known server would only get a field its template ignores (or a strict one refuses).
      return template || serverType === "dashscope" || serverType === "openrouter" ? "none" : "reasoning_effort";
  }
}

export type ServingReasoningInfo = {
  serverType: ServerType;
  /** The model's open-weight reasoning profile; undefined when the table does not know the model. */
  profile?: ReasoningProfile;
  wire: ServingReasoningWire;
  /**
   * Whether a reasoning setting (off / on / an effort) takes effect for this
   * model on this server: `no` for a model that always or never thinks,
   * `unknown` for a hybrid model on a server not known to read
   * `reasoning_effort` as its switch (`generic`, `openai`, `lmstudio`: set the
   * server type), `yes` otherwise, including a model outside the profile table,
   * whose reasoning follows its model rule as before.
   */
  effective: "yes" | "no" | "unknown";
};

/** How a reasoning setting reaches `model` on `serverType` (normalised; unset is `generic`). For UI hints. */
export function describeServingReasoning(serverType: unknown, model: string | undefined): ServingReasoningInfo {
  const type = normalizeServerType(serverType);
  const profile = resolveReasoningProfile(model);
  const wire = wireFor(type, profile);
  let effective: ServingReasoningInfo["effective"] = "yes";
  if (profile?.style === "always" || profile?.style === "none") effective = "no";
  else if (profile?.style === "toggle" && wire === "reasoning_effort" && type !== "ollama") effective = "unknown";
  return { serverType: type, ...(profile ? { profile } : {}), wire, effective };
}

/**
 * Fields that replace the SDK's `reasoning_effort` mapping for one Chat
 * Completions request. Merged over the body one level deep (a caller's
 * `chat_template_kwargs` keeps its other keys; the plan wins for its own).
 * Empty `fields`: send no reasoning at all.
 */
export type ServingReasoningPlan = { fields: Record<string, unknown> };

const EFFORTS: ReadonlySet<string> = new Set(["none", "minimal", "low", "medium", "high", "xhigh", "max"]);

/** `on` / `off` when the request asks for something; undefined when it leaves reasoning unset. */
function onOrOff(reasoning: ReasoningRequestConfig | undefined): "on" | "off" | undefined {
  const effort = reasoning?.effort;
  if (effort && EFFORTS.has(effort)) return effort === "none" ? "off" : "on";
  return (reasoning?.budgetTokens ?? 0) > 0 ? "on" : undefined;
}

/**
 * The wire plan for one request, or undefined to keep the SDK's mapping
 * (`reasoning_effort`, as without a server type). Undefined whenever the request
 * leaves reasoning unset, the model has no profile, or the server reads
 * `reasoning_effort` itself.
 */
export function planServingReasoning(input: {
  serverType: unknown;
  model: string | undefined;
  reasoning: ReasoningRequestConfig | undefined;
  /** The model's resolved rule (with learned adjustments): maps an effort onto the levels the model takes. */
  rule: ModelRule;
}): ServingReasoningPlan | undefined {
  const asked = onOrOff(input.reasoning);
  if (!asked) return undefined;
  const profile = resolveReasoningProfile(input.model);
  if (!profile) return undefined;
  const wire = wireFor(normalizeServerType(input.serverType), profile);
  const effort = input.reasoning?.effort as ReasoningEffort | undefined;
  const level = () => (effort && EFFORTS.has(effort) ? mapReasoningEffort(input.rule, effort).effort : undefined);

  switch (wire) {
    case "reasoning_effort":
      return undefined;
    case "none":
      return { fields: {} };
    case "enable_thinking":
      return { fields: { enable_thinking: asked === "on" } };
    case "chat_template_kwargs": {
      const name = profile.templateSwitch!;
      if (profile.style === "toggle") return { fields: { chat_template_kwargs: { [name]: asked === "on" } } };
      const value = level();
      return value ? { fields: { chat_template_kwargs: { [name]: value } } } : undefined;
    }
    case "reasoning": {
      if (profile.style === "toggle") {
        if (asked === "off") return { fields: { reasoning: { enabled: false } } };
        const value = level();
        return { fields: { reasoning: value && value !== "none" ? { effort: value } : { enabled: true } } };
      }
      const value = level();
      return value ? { fields: { reasoning: { effort: value } } } : undefined;
    }
  }
}

/**
 * Whether answers from this server type can start with the blank line a
 * reasoning template leaves after `</think>` once the server has split the
 * thinking out (`reasoning` / `reasoning_content`): the servers that render the
 * template with a reasoning parser.
 */
export function leavesReasoningSeparator(serverType: unknown): boolean {
  return TEMPLATE_SERVERS.has(normalizeServerType(serverType));
}
