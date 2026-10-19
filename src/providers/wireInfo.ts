/**
 * Facts about a model response that the unified message shape has no field for:
 * which provider answered, the provider's response id and model, its own stop
 * reason, whether it was streamed, and how it counts tokens.
 *
 * They ride on the response message under a Symbol key. A symbol key is copied
 * by object spread (the LangChain adapter and the plugin hooks rebuild messages
 * that way) and skipped by JSON, so the facts never reach a wire payload, a
 * persisted transcript or a trace sink - they are read once, by the node that
 * records the model call. Kept apart from the adapter so `nodes/` can import it
 * without a cycle.
 */

export const WIRE_INFO = Symbol.for("cognipeer.agent-sdk.wireInfo");

export type WireUsageBasis = {
  /** `inputTokens` leaves out the cache read / write tokens (Anthropic, Bedrock). */
  inputExcludesCache?: true;
  /** `outputTokens` leaves out the reasoning tokens (Vertex). */
  outputExcludesReasoning?: true;
};

export type WireInfo = {
  /** The SDK provider type (`openai`, `vertex`, ...). */
  provider?: string;
  responseId?: string;
  responseModel?: string;
  rawFinishReason?: string;
  streaming?: boolean;
  usageBasis?: WireUsageBasis;
};

/** How each native provider counts tokens. Anything not listed counts inclusively. */
export function usageBasisOf(provider: string | undefined): WireUsageBasis | undefined {
  switch (provider) {
    case "anthropic":
    case "bedrock":
      return { inputExcludesCache: true };
    case "vertex":
      return { outputExcludesReasoning: true };
    default:
      return undefined;
  }
}

/** Attaches `info` to `message` (empty values are left out) and returns the message. */
export function attachWireInfo<T extends object>(message: T, info: WireInfo): T {
  const clean: WireInfo = {};
  if (info.provider) clean.provider = info.provider;
  if (info.responseId) clean.responseId = info.responseId;
  if (info.responseModel) clean.responseModel = info.responseModel;
  if (info.rawFinishReason) clean.rawFinishReason = info.rawFinishReason;
  if (info.streaming) clean.streaming = true;
  const basis = info.usageBasis ?? usageBasisOf(info.provider);
  if (basis) clean.usageBasis = basis;
  (message as any)[WIRE_INFO] = clean;
  return message;
}

export function wireInfoOf(message: unknown): WireInfo | undefined {
  if (!message || typeof message !== "object") return undefined;
  return (message as any)[WIRE_INFO] as WireInfo | undefined;
}
