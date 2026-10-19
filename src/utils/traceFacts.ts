/**
 * What a model call's trace record says about the provider's answer, read from
 * the response message: the provider, the response id and model, the provider's
 * own stop reason, cache-write tokens and how the provider counts tokens.
 *
 * Native adapters attach these as wire info; a LangChain model carries them in
 * `response_metadata`, which is read as a fallback. Every field is left out when
 * unknown (never zero or empty).
 */

import type { TraceEventRecord } from "../types.js";
import { getModelCapabilities } from "../structuredOutput/resolver.js";
import { wireInfoOf } from "../providers/wireInfo.js";
import { cacheWriteTokensOf } from "./usage.js";
import { getProviderName } from "./tracing.js";

export type TraceResponseFacts = Pick<
  TraceEventRecord,
  "provider" | "responseId" | "responseModel" | "rawFinishReason" | "cacheWriteTokens" | "usageBasis" | "streaming"
>;

const nonEmpty = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim().length > 0 ? value : undefined;

/** A LangChain run id is not a provider's response id. */
const isRunId = (id: string) => /^(run-|lc_run)/i.test(id);

/**
 * The provider behind a model: its own say-so first, then what the response
 * says about itself, then what the capability detector infers.
 */
export function providerHintOf(model: unknown, response?: unknown): string | undefined {
  const named = getProviderName(model);
  if (named) return named;
  const fromWire = wireInfoOf(response)?.provider;
  if (fromWire) return fromWire;
  try {
    return nonEmpty(getModelCapabilities(model).provider);
  } catch {
    return undefined;
  }
}

export function traceResponseFacts(
  model: unknown,
  response: unknown,
  rawUsage: unknown,
  streaming?: boolean,
): TraceResponseFacts {
  const wire = wireInfoOf(response);
  const meta = (response as any)?.response_metadata ?? {};
  const message = response as { id?: unknown } | undefined;

  const idCandidate = nonEmpty(wire?.responseId) ?? nonEmpty(meta.id) ?? nonEmpty(message?.id);
  const responseId = idCandidate && !isRunId(idCandidate) ? idCandidate : undefined;
  const responseModel = nonEmpty(wire?.responseModel) ?? nonEmpty(meta.model_name) ?? nonEmpty(meta.model) ?? nonEmpty(meta.modelName);
  const rawFinishReason = nonEmpty(wire?.rawFinishReason) ?? nonEmpty(meta.stop_reason) ?? nonEmpty(meta.finish_reason) ?? nonEmpty(meta.finishReason);
  const cacheWriteTokens = cacheWriteTokensOf(rawUsage);
  const provider = providerHintOf(model, response);
  const isStreaming = streaming ?? wire?.streaming;

  return {
    ...(provider ? { provider } : {}),
    ...(responseId ? { responseId } : {}),
    ...(responseModel ? { responseModel } : {}),
    ...(rawFinishReason ? { rawFinishReason } : {}),
    ...(cacheWriteTokens !== undefined ? { cacheWriteTokens } : {}),
    ...(wire?.usageBasis ? { usageBasis: { ...wire.usageBasis } } : {}),
    ...(isStreaming ? { streaming: true } : {}),
  };
}
