// Normalizes provider-specific usage objects into a common shape.
// Target shape:
// {
//   prompt_tokens: number;
//   completion_tokens: number;
//   total_tokens: number;
//   prompt_tokens_details: { cached_tokens: number; audio_tokens: number };
//   completion_tokens_details: { reasoning_tokens: number; audio_tokens: number; accepted_prediction_tokens: number; rejected_prediction_tokens: number };
//   raw?: any; // original provider usage
// }

import type { AgentState } from "../types.js";

export type NormalizedUsage = {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  prompt_tokens_details: { cached_tokens: number; audio_tokens: number };
  completion_tokens_details: {
    reasoning_tokens: number;
    audio_tokens: number;
    accepted_prediction_tokens: number;
    rejected_prediction_tokens: number;
  };
  raw?: any;
};

export function normalizeUsage(raw: any | undefined | null): NormalizedUsage | undefined {
  if (!raw) return undefined;
  // Canonical numeric fields from various provider key aliases.
  const prompt = num(raw.prompt_tokens, raw.input_tokens, raw.promptTokens, raw.total_prompt_tokens);
  const completion = num(raw.completion_tokens, raw.output_tokens, raw.completionTokens, raw.total_completion_tokens);
  // total might be explicitly provided or computed.
  const total = num(
    raw.total_tokens,
    raw.totalTokens,
    (typeof prompt === 'number' ? prompt : 0) + (typeof completion === 'number' ? completion : 0)
  );

  // Details: attempt to pull from common nested spots else zeros
  // OpenAI format: prompt_tokens_details / completion_tokens_details
  // LangChain format: input_token_details / output_token_details
  const promptDetailsSrc = raw.prompt_tokens_details || raw.promptTokensDetails
    || raw.input_token_details || raw.inputTokenDetails
    || raw.input_tokens_details || raw.inputTokensDetails
    || {};
  const completionDetailsSrc = raw.completion_tokens_details || raw.completionTokensDetails
    || raw.output_token_details || raw.outputTokenDetails
    || raw.output_tokens_details || raw.outputTokensDetails
    || {};

  const cachedTokens = num(
    promptDetailsSrc.cached_tokens,
    promptDetailsSrc.cachedTokens,
    promptDetailsSrc.cached,
    promptDetailsSrc.cache_read,
    promptDetailsSrc.cacheRead,
    promptDetailsSrc.cache_read_tokens,
    raw.cached_input_tokens,
    raw.cachedInputTokens,
    raw.cached_prompt_tokens,
    raw.cachedPromptTokens,
    raw.cache_read_input_tokens,
    raw.cacheReadInputTokens
  );

  const normalized: NormalizedUsage = {
    prompt_tokens: safe(prompt),
    completion_tokens: safe(completion),
    total_tokens: safe(total || (prompt || 0) + (completion || 0)),
    prompt_tokens_details: {
      cached_tokens: safe(cachedTokens),
      audio_tokens: safe(num(promptDetailsSrc.audio_tokens, promptDetailsSrc.audioTokens, promptDetailsSrc.audio)),
    },
    completion_tokens_details: {
      reasoning_tokens: safe(num(completionDetailsSrc.reasoning_tokens, completionDetailsSrc.reasoningTokens)),
      audio_tokens: safe(num(completionDetailsSrc.audio_tokens, completionDetailsSrc.audioTokens)),
      accepted_prediction_tokens: safe(
        num(completionDetailsSrc.accepted_prediction_tokens, completionDetailsSrc.acceptedPredictionTokens)
      ),
      rejected_prediction_tokens: safe(
        num(completionDetailsSrc.rejected_prediction_tokens, completionDetailsSrc.rejectedPredictionTokens)
      ),
    },
    raw,
  };
  return normalized;
}

/**
 * Append one model call to the agent state's usage ledger and roll it into the
 * per-model totals.
 *
 * Every node that calls a model must go through here. `state.usage` is what a
 * host bills from (`result.metadata.usage`), so a node that reports its tokens
 * only to the tracing sink is spend the host can see in its observability
 * dashboard and nowhere in its own accounting — which is exactly how the two
 * drift apart on the longest runs.
 *
 * Returns the entry id so a caller can correlate; the id is also the natural
 * idempotency key for a host writing one row per model call.
 */
export function recordUsage(
  state: any,
  modelName: string,
  normalized: NormalizedUsage,
): string {
  const usageState = state.usage || { perRequest: [], totals: {} };
  const id = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const cachedInput = normalized.prompt_tokens_details?.cached_tokens;

  usageState.perRequest.push({
    id,
    modelName,
    usage: normalized,
    timestamp: new Date().toISOString(),
    turn: usageState.perRequest.length + 1,
    cachedInput,
  });

  const previous = usageState.totals[modelName] || { input: 0, output: 0, total: 0, cachedInput: 0 };
  usageState.totals[modelName] = {
    input: previous.input + (Number(normalized.prompt_tokens) || 0),
    output: previous.output + (Number(normalized.completion_tokens) || 0),
    total: previous.total + (Number(normalized.total_tokens) || 0),
    cachedInput: previous.cachedInput + (Number(cachedInput) || 0),
  };

  state.usage = usageState;
  return id;
}

function num(...vals: any[]): number | undefined {
  for (const v of vals) {
    if (v === 0) return 0;
    if (v == null) continue;
    const n = Number(v);
    if (!Number.isNaN(n)) return n;
  }
  return undefined;
}
function safe(v: any): number { const n = Number(v); return Number.isFinite(n) && n >= 0 ? n : 0; }

type LedgerEntry = NonNullable<AgentState["usage"]>["perRequest"][number];
type Ledger = NonNullable<AgentState["usage"]>;

/** Roll a list of ledger entries up into per-model totals. */
export function totalUsage(entries: LedgerEntry[]): Ledger["totals"] {
  const totals: Ledger["totals"] = {};
  for (const entry of entries) {
    const previous = totals[entry.modelName] || { input: 0, output: 0, total: 0, cachedInput: 0 };
    totals[entry.modelName] = {
      input: previous.input + (Number(entry.usage?.prompt_tokens) || 0),
      output: previous.output + (Number(entry.usage?.completion_tokens) || 0),
      total: previous.total + (Number(entry.usage?.total_tokens) || 0),
      cachedInput: previous.cachedInput + (Number(entry.cachedInput) || 0),
    };
  }
  return totals;
}

/**
 * Append another run's ledger entries to a state's usage (a sub-agent's model
 * calls into its parent's), re-numbering `turn` and tagging each copy so a host
 * can tell whose call it was. Goes through the same totals arithmetic as
 * `recordUsage`, so a budget that reads `perRequest` or `totals` sees them.
 */
export function appendUsageEntries(
  state: any,
  entries: LedgerEntry[],
  tag?: LedgerEntry["subagent"],
): void {
  if (!Array.isArray(entries) || entries.length === 0) return;
  const usageState: Ledger = state.usage || { perRequest: [], totals: {} };
  for (const entry of entries) {
    usageState.perRequest.push({
      ...entry,
      turn: usageState.perRequest.length + 1,
      ...(tag ? { subagent: tag } : {}),
    });
  }
  const added = totalUsage(entries);
  for (const [modelName, add] of Object.entries(added)) {
    const previous = usageState.totals[modelName] || { input: 0, output: 0, total: 0, cachedInput: 0 };
    usageState.totals[modelName] = {
      input: previous.input + add.input,
      output: previous.output + add.output,
      total: previous.total + add.total,
      cachedInput: previous.cachedInput + add.cachedInput,
    };
  }
  state.usage = usageState;
}

/**
 * Split a usage ledger into the run's own calls and the ones a sub-agent made
 * (tagged `subagent`, merged in by the delegation tools). A child opens its own
 * session with its own record, so anything that reports per run and is later
 * summed has to keep the two apart or every child token is counted twice.
 */
export function splitUsage(usage: AgentState["usage"]): {
  own: Ledger["totals"];
  subagent: Ledger["totals"];
  ownCalls: number;
  subagentCalls: number;
  ownEntries: LedgerEntry[];
  subagentEntries: LedgerEntry[];
} {
  const entries = usage?.perRequest ?? [];
  const subagentEntries = entries.filter((entry) => entry.subagent);
  const ownEntries = entries.filter((entry) => !entry.subagent);
  const subagent = totalUsage(subagentEntries);
  // Totals minus the children's share, not a re-sum of `perRequest`: the totals
  // stay authoritative if the per-call list was ever trimmed.
  const own: Ledger["totals"] = {};
  for (const [modelName, total] of Object.entries(usage?.totals ?? {})) {
    const child = subagent[modelName];
    own[modelName] = child
      ? {
          input: Math.max(0, total.input - child.input),
          output: Math.max(0, total.output - child.output),
          total: Math.max(0, total.total - child.total),
          cachedInput: Math.max(0, total.cachedInput - child.cachedInput),
        }
      : total;
  }
  return { own, subagent, ownCalls: ownEntries.length, subagentCalls: subagentEntries.length, ownEntries, subagentEntries };
}
