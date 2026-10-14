// Self-correcting requests. A model that is not in model-rules.json (or whose
// rules drifted) answers a 400 that names the offending parameter or value.
// We parse that, fix the request, retry (at most MAX_ADJUSTMENTS times, and
// only for the HTTP error — nothing has been streamed yet), and remember the
// fix per (provider, model) so the next call is right first time. When it
// still fails the caller gets a typed ModelRequestError, not an opaque string.

import { ProviderError } from "../providers/types.js";
import { ModelRequestError, type ModelRequestErrorCode } from "./errors.js";
import { MODEL_RULES, mergeRulePatch, rememberModelRulePatch, type ReasoningEffort, type RulePatch } from "./rules.js";

export const MAX_ADJUSTMENTS = 3;

export type ParsedModelErrorKind =
  | "unsupported_parameter"
  | "unsupported_value"
  | "max_tokens_rename"
  | "default_only"
  | "chat_tools_effort"
  | "thinking_enabled_unsupported"
  | "thinking_adaptive_unsupported"
  | "thinking_off_between_tools"
  | "thinking_disabled_unsupported"
  | "temperature_thinking";

export type ParsedModelError = {
  kind: ParsedModelErrorKind;
  param?: string;
  value?: string;
  supportedValues?: string[];
  /** `max_tokens` / `max_completion_tokens` for `max_tokens_rename`. */
  renameTo?: "max_tokens" | "max_completion_tokens";
  message: string;
};

export type ModelRuleLearnedEvent = {
  provider: string;
  model: string;
  /** Short label, e.g. `drop:temperature`, `max_tokens->max_completion_tokens`. */
  adjustment: string;
  patch: RulePatch;
  /** The provider's error message that triggered it. */
  reason: string;
};

const Q = "['\"`]";

function errorMessage(text: string): { message: string; param?: string; code?: string } {
  try {
    const j = JSON.parse(text);
    const e = j?.error ?? j;
    const message = typeof e?.message === "string" ? e.message : typeof j?.message === "string" ? j.message : text;
    return { message, param: typeof e?.param === "string" ? e.param : undefined, code: typeof e?.code === "string" ? e.code : undefined };
  } catch {
    return { message: text };
  }
}

function quotedList(s: string): string[] {
  const quoted = [...s.matchAll(new RegExp(`${Q}([^'"\`]+)${Q}`, "g"))].map((m) => m[1]);
  if (quoted.length > 0) return quoted;
  return s.split(/[,\s]+/).map((x) => x.replace(/[.\s]+$/, "")).filter(Boolean);
}

/** Recognises the 400 shapes OpenAI-wire servers and Anthropic use for a bad parameter or value. */
export function parseModelError(text: string): ParsedModelError | undefined {
  const { message, param: errParam } = errorMessage(String(text ?? ""));
  const m = message.toLowerCase();

  if (m.includes("function tools with reasoning_effort") && m.includes("not supported")) {
    return { kind: "chat_tools_effort", message };
  }

  // Anthropic thinking forms.
  if (m.includes("between_tools") && m.includes("thinking")) return { kind: "thinking_off_between_tools", message };
  if (m.includes("thinking.type.enabled") && m.includes("not supported")) return { kind: "thinking_enabled_unsupported", message };
  if (m.includes("thinking.type.adaptive") && m.includes("not supported")) return { kind: "thinking_adaptive_unsupported", message };
  if (m.includes("thinking.type.disabled") && m.includes("not supported")) return { kind: "thinking_disabled_unsupported", message };
  const tt = new RegExp(`${Q}?(temperature|top_p|top_k)${Q}?\\s+may only be set to 1 when thinking is enabled`, "i").exec(message);
  if (tt) return { kind: "temperature_thinking", param: tt[1].toLowerCase(), message };
  const dep = new RegExp(`${Q}([\\w.]+)${Q}\\s+is deprecated for this model`, "i").exec(message);
  if (dep) return { kind: "unsupported_parameter", param: dep[1], message };

  const rename = new RegExp(`use ${Q}(max_completion_tokens|max_tokens)${Q} instead`, "i").exec(message);
  if (rename) return { kind: "max_tokens_rename", renameTo: rename[1].toLowerCase() as any, param: rename[1].toLowerCase() === "max_tokens" ? "max_completion_tokens" : "max_tokens", message };

  const val = new RegExp(`unsupported value:?\\s*${Q}?([\\w.]+)${Q}?\\s+does not support\\s+(${Q}[^'"\`]*${Q}|[^\\s]+)`, "i").exec(message);
  if (val) {
    const param = val[1];
    const value = val[2].replace(/^['"`]|['"`]$/g, "");
    if (m.includes("only the default") && m.includes("value is supported")) return { kind: "default_only", param, value, message };
    const sup = /supported values? (?:are|is):?\s*([^\n]*)/i.exec(message);
    return { kind: "unsupported_value", param, value, supportedValues: sup ? quotedList(sup[1]) : undefined, message };
  }
  if (m.includes("only the default") && m.includes("value is supported")) {
    return { kind: "default_only", param: errParam ?? "temperature", message };
  }
  const prm = new RegExp(`unsupported parameter:?\\s*${Q}?([\\w.]+)${Q}?`, "i").exec(message);
  if (prm) return { kind: "unsupported_parameter", param: prm[1], message };
  return undefined;
}

const normParam = (p: string) => p.toLowerCase().replace(/[-\s]/g, "_");
const LADDER = new Set<string>(MODEL_RULES.effortLadder);

/** Turns a parsed error into a rule patch and a short label. */
export function patchFromParsedError(parsed: ParsedModelError, endpoint: string = "chat"): { patch: RulePatch; adjustment: string } | undefined {
  const param = parsed.param ? normParam(parsed.param) : "";
  switch (parsed.kind) {
    case "chat_tools_effort":
      return { patch: { chatTools: { reasoning: "force-none" } }, adjustment: "chat-tools:force-effort-none" };
    case "max_tokens_rename":
      return { patch: { maxTokensParam: parsed.renameTo! }, adjustment: `${parsed.param}->${parsed.renameTo}` };
    case "thinking_enabled_unsupported":
      return { patch: { reasoning: { style: "adaptive" } }, adjustment: "thinking:adaptive" };
    case "thinking_adaptive_unsupported":
      return { patch: { reasoning: { style: "budget" } }, adjustment: "thinking:budget" };
    case "thinking_off_between_tools":
      return { patch: { reasoning: { off: "between_tools" } }, adjustment: "thinking-off:between_tools" };
    case "thinking_disabled_unsupported":
      return { patch: { reasoning: { off: null } }, adjustment: "thinking-off:none" };
    case "temperature_thinking":
      return { patch: { sampling: { temperature: "unsupported" } }, adjustment: "drop:temperature" };
    case "default_only":
      if (param === "temperature") return { patch: { sampling: { temperature: "default-only" } }, adjustment: "temperature:default-only" };
      return { patch: { dropParams: [parsed.param ?? param] }, adjustment: `drop:${parsed.param ?? param}` };
    case "unsupported_value": {
      if (/^(reasoning_effort|reasoning\.effort|effort|output_config\.effort)$/.test(param)) {
        const list = (parsed.supportedValues ?? []).map((v) => v.toLowerCase()).filter((v): v is ReasoningEffort => LADDER.has(v)) as ReasoningEffort[];
        if (list.length === 0) return undefined;
        const reasoning = endpoint === "responses" ? { responsesEfforts: list } : { efforts: list };
        return { patch: { reasoning }, adjustment: `efforts:${list.join("|")}` };
      }
      return paramDropPatch(param, parsed);
    }
    case "unsupported_parameter":
      return paramDropPatch(param, parsed);
  }
}

function paramDropPatch(param: string, parsed: ParsedModelError): { patch: RulePatch; adjustment: string } | undefined {
  if (!param) return undefined;
  const label = `drop:${parsed.param ?? param}`;
  switch (param) {
    case "temperature": return { patch: { sampling: { temperature: "unsupported" } }, adjustment: label };
    case "top_p": return { patch: { sampling: { topP: false } }, adjustment: label };
    case "top_k": return { patch: { sampling: { topK: false } }, adjustment: label };
    case "presence_penalty":
    case "frequency_penalty": return { patch: { sampling: { penalties: false } }, adjustment: label };
    case "logprobs":
    case "top_logprobs": return { patch: { sampling: { logprobs: false } }, adjustment: label };
    case "max_tokens": return { patch: { maxTokensParam: "max_completion_tokens" }, adjustment: "max_tokens->max_completion_tokens" };
    case "max_completion_tokens": return { patch: { maxTokensParam: "max_tokens" }, adjustment: "max_completion_tokens->max_tokens" };
    case "reasoning_effort":
    case "reasoning.effort":
    case "reasoning":
      return { patch: { reasoning: { style: "none", efforts: [], responsesEfforts: [] }, dropParams: [param] }, adjustment: label };
    default:
      return { patch: { dropParams: [parsed.param ?? param] }, adjustment: label };
  }
}

function codeFor(parsed: ParsedModelError | undefined): ModelRequestErrorCode {
  if (!parsed) return "model_request_invalid";
  if (parsed.kind === "unsupported_value" || parsed.kind === "default_only") return "unsupported_value";
  if (parsed.kind === "unsupported_parameter" || parsed.kind === "max_tokens_rename" || parsed.kind === "temperature_thinking") return "unsupported_parameter";
  return "model_request_invalid";
}

function toModelRequestError(err: ProviderError, parsed: ParsedModelError | undefined, provider: string, model: string): ModelRequestError {
  return new ModelRequestError({
    status: err.statusCode ?? 400,
    code: codeFor(parsed),
    param: parsed?.param,
    value: parsed?.value,
    supportedValues: parsed?.supportedValues,
    provider: err.provider || provider,
    model,
    message: err.message,
    responseBody: err.responseBody,
  });
}

class SameRequest extends Error {}

/** Drops caller-set fields from a patch before it is remembered; undefined when nothing generic is left. */
function withoutCallerParams<S extends { patch: RulePatch }>(step: S, callerParams: string[] | undefined): S | undefined {
  const drops = step.patch.dropParams;
  if (!callerParams?.length || !drops) return step;
  const mine = (p: string) => callerParams.includes(p.split(".")[0]);
  if (!drops.some(mine)) return step;
  const { dropParams: _ignored, ...rest } = step.patch;
  const kept = drops.filter((p) => !mine(p));
  const patch: RulePatch = kept.length ? { ...rest, dropParams: kept } : rest;
  return Object.keys(patch).length ? { ...step, patch } : undefined;
}

export type AdjustmentRun<T> = {
  provider: string;
  model: string;
  /** `chat` (default), `responses`, `messages` or `converse`; selects which effort list a value error teaches. */
  endpoint?: string;
  onLearned?: (event: ModelRuleLearnedEvent) => void;
  /** Keeps learned patches apart per backend (e.g. the base URL): same model id, different deployment. */
  scope?: string;
  /** Request fields the caller set itself (`request.extra` keys): corrected for this call, never learned for the model. */
  callerParams?: string[];
  /**
   * Performs the call for the given overlay. `guard(body)` must be called with
   * the request body just before sending: a retry whose body is identical to
   * the previous attempt's is pointless and ends the loop with the typed error.
   */
  run: (overlay: RulePatch, guard: (body: unknown) => void) => Promise<T>;
};

/** Runs a request, correcting it from the provider's own 400s (see file header). */
export async function runWithModelAdjustments<T>(opts: AdjustmentRun<T>): Promise<T> {
  let overlay: RulePatch = {};
  const steps: Array<{ patch: RulePatch; adjustment: string; reason: string }> = [];
  let previous: string | undefined;
  let lastError: ProviderError | undefined;
  let lastParsed: ParsedModelError | undefined;

  for (;;) {
    const guard = (body: unknown) => {
      let json: string;
      try { json = JSON.stringify(body); } catch { return; }
      if (previous !== undefined && json === previous) throw new SameRequest();
      previous = json;
    };
    try {
      const result = await opts.run(overlay, guard);
      for (const step of steps) {
        const s = withoutCallerParams(step, opts.callerParams);
        if (!s) continue;
        rememberModelRulePatch(opts.provider, opts.model, s.patch, opts.scope);
        if (opts.onLearned) {
          try { opts.onLearned({ provider: opts.provider, model: opts.model, adjustment: s.adjustment, patch: s.patch, reason: s.reason }); } catch { /* host callback must not break the call */ }
        }
      }
      return result;
    } catch (err) {
      if (err instanceof SameRequest) throw toModelRequestError(lastError!, lastParsed, opts.provider, opts.model);
      if (!(err instanceof ProviderError) || err instanceof ModelRequestError || err.statusCode !== 400) throw err;
      const parsed = parseModelError(String(err.responseBody ?? err.message));
      const fix = parsed ? patchFromParsedError(parsed, opts.endpoint) : undefined;
      lastError = err;
      lastParsed = parsed;
      if (!fix || steps.length >= MAX_ADJUSTMENTS) throw toModelRequestError(err, parsed, opts.provider, opts.model);
      overlay = mergeRulePatch(overlay, fix.patch);
      steps.push({ ...fix, reason: parsed!.message });
    }
  }
}

/** Converts a 400 ProviderError into the typed error without retrying (Vertex and other single-shot paths). */
export function asModelRequestError(err: unknown, provider: string, model: string): unknown {
  if (!(err instanceof ProviderError) || err instanceof ModelRequestError || err.statusCode !== 400) return err;
  return toModelRequestError(err, parseModelError(String(err.responseBody ?? err.message)), provider, model);
}
