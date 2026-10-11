// TypeSafe Jev provider.
// Jev is a decision model, not a chat model: it speaks the System One wire format
// (POST /v1/systemone) and answers typed questions with probabilities. It is a
// first-class provider so it is configured, authenticated and retried like the
// others, but its entry point is `systemOne()` rather than `complete()`.

import { BaseProvider } from "./base.js";
import {
  type ChatCompletionChunk,
  type ChatCompletionRequest,
  type ChatCompletionResponse,
  type JevProviderConfig,
  type ProviderType,
  ProviderError,
} from "./types.js";

export const JEV_DEFAULT_BASE_URL = "https://api.typesafe.ai";

/** A System One question. `noul` asks for the probability of a "yes". */
export type JevQuestion = {
  type: "noul" | "choice" | "score";
  instructions?: string;
  criteria?: unknown;
};

export type JevSystemOneRequest = {
  /** The text the questions are asked about. */
  state: string;
  questions: Record<string, JevQuestion>;
  /** Overrides the provider's `defaultModel` for this call. */
  model?: string;
};

export type JevSystemOneResult = {
  readonly model?: string;
  readonly answers?: Record<string, { readonly type: string; readonly noul?: number; readonly [k: string]: unknown } | undefined>;
  readonly usage?: { readonly input_tokens: number; readonly output_tokens: number };
};

export class JevProvider extends BaseProvider {
  readonly providerName: ProviderType = "jev";

  private readonly apiKey: string;
  private readonly baseURL: string;
  private readonly defaultModel?: string;
  private readonly defaultHeaders: Record<string, string>;

  constructor(config: JevProviderConfig) {
    super();
    this.apiKey = config.apiKey;
    this.baseURL = (config.baseURL ?? JEV_DEFAULT_BASE_URL).replace(/\/$/, "");
    this.defaultModel = config.defaultModel;
    this.defaultHeaders = config.defaultHeaders ?? {};
    if (config.retry) this.retryPolicy = { ...this.retryPolicy, ...config.retry };
  }

  /** Ask System One questions about `state`. */
  async systemOne(
    request: JevSystemOneRequest,
    options?: { signal?: AbortSignal },
  ): Promise<JevSystemOneResult> {
    const model = request.model ?? this.defaultModel;
    const body = {
      ...(model ? { model } : {}),
      state: request.state,
      questions: request.questions,
    };

    const res = await this.doFetchWithRetry(() =>
      fetch(`${this.baseURL}/v1/systemone`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.apiKey}`,
          ...this.defaultHeaders,
        },
        body: JSON.stringify(body),
        signal: options?.signal,
      }),
    );

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new ProviderError(`Jev API error ${res.status}: ${text}`, this.providerName, res.status, text);
    }
    return (await res.json()) as JevSystemOneResult;
  }

  async complete(_request: ChatCompletionRequest): Promise<ChatCompletionResponse> {
    throw new ProviderError(
      "Jev is a decision model and has no chat completion; use systemOne() or agentVerdictRule({ engine: \"jev\" })",
      this.providerName,
    );
  }

  // eslint-disable-next-line require-yield
  async *completeStream(_request: ChatCompletionRequest): AsyncGenerator<ChatCompletionChunk, void, unknown> {
    throw new ProviderError("Jev does not stream; use systemOne()", this.providerName);
  }
}
