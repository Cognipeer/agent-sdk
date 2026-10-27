// Abstract base class for all native LLM providers.
// Each concrete provider implements the conversion between unified ↔ wire format.

import type {
  ChatCompletionRequest,
  ChatCompletionResponse,
  ChatCompletionChunk,
  ProviderType,
  EmbeddingRequest,
  EmbeddingResponse,
} from "./types.js";
import { ProviderError } from "./types.js";
import type { ModelRuleLearnedEvent } from "../models/adjust.js";
import type { WireUsageBasis } from "./wireInfo.js";
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
  /**
   * How this provider's `TokenUsage` counts tokens. Unset = derive it from
   * `providerName` (`usageBasisOf`: Anthropic / Bedrock `inputTokens` leave out the
   * cache read + write, Vertex `outputTokens` leaves out the reasoning). An
   * explicit `{}` = already inclusive: a gateway or wrapper that normalised the
   * usage itself. `fromNativeProvider` converts to the inclusive `MessageUsage`
   * with this basis, so a provider that reports inclusive counts under a
   * provider name that is exclusive by default must declare `{}`.
   */
  readonly usageBasis?: WireUsageBasis;
  protected retryPolicy: ProviderRetryPolicy = DEFAULT_RETRY;
  /** Injected `fetch` (config.fetch); falls back to the global one at call time. */
  protected fetchImpl?: typeof fetch;
  /** Per-request timeout in ms (config.timeoutMs). Undefined = no timeout. */
  protected timeoutMs?: number;
  /** Called when a 400 taught the provider a per-model adjustment (config.onModelRuleLearned). */
  protected onModelRuleLearned?: (event: ModelRuleLearnedEvent) => void;

  /** Applies the transport options shared by every provider config. */
  protected configureTransport(config: { fetch?: typeof fetch; timeoutMs?: number; onModelRuleLearned?: (event: ModelRuleLearnedEvent) => void }): void {
    this.fetchImpl = config.fetch;
    this.onModelRuleLearned = config.onModelRuleLearned;
    this.timeoutMs = typeof config.timeoutMs === "number" && config.timeoutMs > 0 ? config.timeoutMs : undefined;
  }

  /**
   * The single HTTP entry point for every provider call site. Uses the
   * configured `fetch` and applies `timeoutMs`: the timer covers the time until
   * the response HEADERS arrive and is cleared after that, so a long-running
   * stream is never cut by it (use the request `signal` to cancel a stream).
   * A timeout surfaces as a `ProviderError` with status 408. The caller's
   * `signal` still aborts the request as before.
   */
  protected async httpFetch(url: string, init: RequestInit = {}): Promise<Response> {
    const doFetch = this.fetchImpl ?? fetch;
    const timeoutMs = this.timeoutMs;
    if (!timeoutMs) return doFetch(url, init);

    const controller = new AbortController();
    const outer = init.signal ?? undefined;
    let timedOut = false;
    const onOuterAbort = () => controller.abort(outer?.reason);
    if (outer) {
      if (outer.aborted) controller.abort(outer.reason);
      else outer.addEventListener("abort", onOuterAbort, { once: true });
    }
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort(new Error(`timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    try {
      const res = await doFetch(url, { ...init, signal: controller.signal });
      // Stream bodies keep reading under the caller's signal; drop only the timer.
      return res;
    } catch (err) {
      if (timedOut) {
        throw new ProviderError(`${this.providerName} request timed out after ${timeoutMs}ms`, this.providerName, 408);
      }
      throw err;
    } finally {
      clearTimeout(timer);
      // The outer listener is deliberately left attached: it must keep
      // forwarding a later abort to the (still streaming) response.
    }
  }

  /**
   * Embeds `request.input`. Implemented by the providers that have an
   * embeddings endpoint (OpenAI, Azure, openai-compatible, Bedrock, Vertex);
   * the others reject with a 400 ProviderError.
   */
  async embed(_request: EmbeddingRequest): Promise<EmbeddingResponse> {
    throw new ProviderError(`${this.providerName} does not support embeddings`, this.providerName, 400);
  }

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
