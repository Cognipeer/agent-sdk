// Abstract base class for all native LLM providers.
// Each concrete provider implements the conversion between unified ↔ wire format.

import type {
  ChatCompletionRequest,
  ChatCompletionResponse,
  ChatCompletionChunk,
  ProviderType,
} from "./types.js";
import { abortableSleep, abortReason } from "../utils/abort.js";

export type ProviderRetryPolicy = {
  /** Maximum number of retries on 429/5xx responses. Default: 3. */
  maxRetries?: number;
  /** Initial backoff in ms (doubled on each retry). Default: 500. */
  baseDelayMs?: number;
  /** Hard cap on individual delay between retries. Default: 8000. */
  maxDelayMs?: number;
  /**
   * Custom predicate to decide whether to retry. By default we retry 429
   * and 5xx responses; pass a function to broaden/narrow that set.
   */
  shouldRetry?: (error: any, attempt: number) => boolean;
};

const DEFAULT_RETRY: Required<Pick<ProviderRetryPolicy, "maxRetries" | "baseDelayMs" | "maxDelayMs">> = {
  maxRetries: 3,
  baseDelayMs: 500,
  maxDelayMs: 8000,
};

export abstract class BaseProvider {
  abstract readonly providerName: ProviderType;
  protected retryPolicy: ProviderRetryPolicy = DEFAULT_RETRY;

  /** Non-streaming completion */
  abstract complete(request: ChatCompletionRequest): Promise<ChatCompletionResponse>;

  /** Streaming completion – yields incremental chunks */
  abstract completeStream(
    request: ChatCompletionRequest,
  ): AsyncGenerator<ChatCompletionChunk, void, unknown>;

  /**
   * Helper concrete providers can wrap their fetch with. Retries 429/5xx
   * with exponential backoff and respects Retry-After if the response
   * carries one.
   *
   * `signal` is the call's cancellation: a run that is cancelled while the
   * provider is backing off must not sit out the delay, nor start another attempt.
   */
  protected async doFetchWithRetry(execute: () => Promise<Response>, signal?: AbortSignal): Promise<Response> {
    const policy = this.retryPolicy;
    const maxRetries = Math.max(0, policy.maxRetries ?? DEFAULT_RETRY.maxRetries);
    const baseDelay = Math.max(0, policy.baseDelayMs ?? DEFAULT_RETRY.baseDelayMs);
    const maxDelay = Math.max(baseDelay, policy.maxDelayMs ?? DEFAULT_RETRY.maxDelayMs);

    let lastResp: Response | undefined;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      if (signal?.aborted) throw abortReason(signal);
      const res = await execute();
      const isRetryable = res.status === 429 || (res.status >= 500 && res.status < 600);
      if (!isRetryable) return res;

      // Custom predicate gets a chance to opt out.
      const predicate = policy.shouldRetry;
      if (predicate && !predicate({ status: res.status }, attempt)) return res;

      if (attempt === maxRetries) {
        lastResp = res;
        break;
      }
      // Respect Retry-After when present (in seconds or HTTP date).
      const retryAfter = res.headers.get("retry-after");
      let delay = Math.min(maxDelay, baseDelay * Math.pow(2, attempt));
      if (retryAfter) {
        const asNumber = Number(retryAfter);
        if (!Number.isNaN(asNumber)) delay = Math.min(maxDelay, Math.max(delay, asNumber * 1000));
      }
      // Drain the body so the connection can be reused.
      try { await res.text(); } catch { /* ignore */ }
      await abortableSleep(delay, signal);
    }
    return lastResp!;
  }
}
