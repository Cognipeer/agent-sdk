// Abstract base class for all native LLM providers.
// Each concrete provider implements the conversion between unified ↔ wire format.

import type {
  ChatCompletionRequest,
  ChatCompletionResponse,
  ChatCompletionChunk,
  ProviderType,
} from "./types.js";

export abstract class BaseProvider {
  abstract readonly providerName: ProviderType;

  /** Non-streaming completion */
  abstract complete(request: ChatCompletionRequest): Promise<ChatCompletionResponse>;

  /** Streaming completion – yields incremental chunks */
  abstract completeStream(
    request: ChatCompletionRequest,
  ): AsyncGenerator<ChatCompletionChunk, void, unknown>;
}
