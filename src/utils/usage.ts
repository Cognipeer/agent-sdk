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
