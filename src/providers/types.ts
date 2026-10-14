// ─── Unified LLM Provider Types ─────────────────────────────────────────────
// Provider-agnostic request/response contracts consumed by all native providers.
// Each provider converts these into its own wire format and maps back.

// ─── Messages ────────────────────────────────────────────────────────────────

export type MessageRole = "system" | "user" | "assistant" | "tool";

export type TextContent = { type: "text"; text: string };

export type ImageContent = {
  type: "image";
  source:
    | { type: "base64"; mediaType: string; data: string }
    | { type: "url"; url: string; mediaType?: string };
};

/**
 * A document attachment (PDF, DOCX, CSV, …). Providers map this to their
 * native document blocks: Gemini `inlineData`/`fileData`, Anthropic
 * `document`, OpenAI Chat Completions `file` / Responses `input_file`,
 * Bedrock Converse `document`. Providers without document support degrade
 * to a text placeholder referencing the file name/URL.
 */
export type FileContent = {
  type: "file";
  source:
    | { type: "base64"; mediaType: string; data: string }
    | { type: "url"; url: string; mediaType?: string };
  /** Original file name, when known (required by some providers, e.g. Bedrock). */
  fileName?: string;
};

/**
 * An audio attachment. Gemini accepts it as `inlineData`/`fileData`; OpenAI
 * audio-capable models as `input_audio`. Providers without audio support
 * degrade to a text placeholder.
 */
export type AudioContent = {
  type: "audio";
  source:
    | { type: "base64"; mediaType: string; data: string }
    | { type: "url"; url: string; mediaType?: string };
};

export type ContentPart = TextContent | ImageContent | FileContent | AudioContent;

export type ToolCall = {
  id: string;
  name: string;
  arguments: string; // JSON string
  /** Gemini `thoughtSignature` attached to a functionCall part; must be echoed back on the next turn. */
  thoughtSignature?: string;
  /** Position of the call within the assistant turn. Set on streamed deltas so a consumer can frame them (OpenAI `tool_calls[].index`). */
  index?: number;
};

/**
 * A provider-native reasoning/thinking block. Captured from the model response
 * and replayed verbatim on subsequent turns (required by Anthropic extended
 * thinking when tools are involved — the `signature` must round-trip intact).
 */
export type ReasoningBlock = {
  type: "thinking" | "redacted_thinking";
  /** Plain-text thinking content (absent for redacted blocks). */
  text?: string;
  /** Cryptographic signature Anthropic requires to be echoed back verbatim. */
  signature?: string;
  /** Opaque payload for redacted_thinking blocks. */
  data?: string;
};

/** Captured reasoning payload attached to assistant turns / responses. */
export type ReasoningPayload = {
  /** Verbatim provider blocks to replay on the next turn. */
  blocks?: ReasoningBlock[];
  /** Human-readable reasoning summary, when the provider exposes one. */
  summary?: string;
};

export type UnifiedMessage = {
  role: MessageRole;
  content: string | ContentPart[];
  name?: string;
  toolCalls?: ToolCall[];
  toolCallId?: string; // for tool result messages
  /** Native reasoning blocks to replay verbatim (Anthropic/Bedrock thinking). */
  reasoning?: ReasoningPayload;
};

// ─── Tool Definition ─────────────────────────────────────────────────────────

export type ToolDefinition = {
  name: string;
  description: string;
  parameters: Record<string, any>; // JSON Schema
  strict?: boolean;
};

// ─── Request ─────────────────────────────────────────────────────────────────

export type ChatCompletionRequest = {
  model: string;
  messages: UnifiedMessage[];
  temperature?: number;
  maxTokens?: number;
  topP?: number;
  stop?: string[];
  /** OpenAI-family only; other providers ignore it. */
  presencePenalty?: number;
  /** OpenAI-family only; other providers ignore it. */
  frequencyPenalty?: number;
  tools?: ToolDefinition[];
  toolChoice?: "auto" | "required" | "none" | { name: string };
  responseFormat?: {
    type: "json_schema" | "json_object" | "text";
    schema?: Record<string, any>;
    name?: string;
  };
  stream?: boolean;
  /**
   * Streaming only. `false` opts out of `stream_options.include_usage` on
   * OpenAI-shaped endpoints (some servers reject the option). Default true.
   */
  streamUsage?: boolean;
  /** OpenAI-family: deterministic sampling seed. Passed through. */
  seed?: number;
  /** OpenAI-family: number of choices. Pass-through only; only choice 0 is parsed. */
  n?: number;
  /** OpenAI-family: allow/forbid parallel tool calls. Passed through when set. */
  parallelToolCalls?: boolean;
  /** OpenAI-family: return token log probabilities. Passed through. */
  logprobs?: boolean;
  /** OpenAI-family: how many top log probabilities per token. Passed through. */
  topLogprobs?: number;
  // Provider-specific extras passed raw into the body (escape hatch)
  extra?: Record<string, any>;
  /**
   * Unified native-reasoning request config. Each provider maps this to its
   * own shape:
   *  - OpenAI o-series:   body.reasoning_effort = effort
   *  - OpenAI Responses:  body.reasoning = { effort }
   *  - Anthropic:         body.thinking  = { type: "enabled", budget_tokens }
   *  - Google / Vertex:   body.generationConfig.thinkingConfig = { thinkingBudget, includeThoughts }
   *
   * Providers silently ignore unsupported fields.
   */
  reasoning?: ReasoningRequestConfig;
  /**
   * Cancels the HTTP request (and an in-flight stream) when it aborts. The agent
   * loop sets it from the run's cancellation token / abort signal; a caller using
   * a provider directly can pass its own. It is never serialised into the body.
   */
  signal?: AbortSignal;
};

/**
 * `none` is OFF, and it is a value rather than the absence of one.
 *
 * On a thinking-by-default model — every Qwen3 under vLLM, gpt-5.1 and newer on
 * OpenAI — sending no reasoning field leaves the model thinking. So "do not
 * think" is an instruction that has to travel: `reasoning_effort:"none"` on
 * OpenAI, `thinkingBudget:0` on Gemini, and no thinking block at all on
 * Anthropic (where thinking is opt-in and the absence IS off). Omitting
 * `effort` still means "say nothing about reasoning", which is the different
 * and equally necessary state.
 */
export type ReasoningEffort = "none" | "minimal" | "low" | "medium" | "high";

export type ReasoningRequestConfig = {
  /** Qualitative effort hint (mapped per-provider). */
  effort?: ReasoningEffort;
  /** Explicit per-call token budget for reasoning/thinking. */
  budgetTokens?: number;
  /**
   * Gemini 3 style discrete thinking level (e.g. "low" | "high"). Sent as
   * `thinkingConfig.thinkingLevel` and replaces the derived `thinkingBudget`
   * (the API rejects both together). Ignored by other providers.
   */
  thinkingLevel?: string;
  /** Whether the provider should expose its reasoning/thought summary to the caller. Gemini: default false. Claude adaptive thinking (5.x): default summarized (`thinking.display = "summarized"`) unless this is `false`; never added when the caller passes an explicit `extra.thinking`. */
  includeThoughts?: boolean;
  /** Provider-specific passthrough merged on top of the mapped shape. */
  providerExtras?: Record<string, any>;
};

// ─── Token Usage ─────────────────────────────────────────────────────────────

export type TokenUsage = {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  cachedInputTokens: number;
  cachedWriteTokens: number;
  cachedOutputTokens: number;
  reasoningTokens: number;
};

export function emptyUsage(): TokenUsage {
  return {
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    cachedInputTokens: 0,
    cachedWriteTokens: 0,
    cachedOutputTokens: 0,
    reasoningTokens: 0,
  };
}

// ─── Response ────────────────────────────────────────────────────────────────

export type FinishReason = "stop" | "tool_calls" | "length" | "content_filter" | "error";

export type ProviderResponseFields = {
  system_fingerprint?: string;
  service_tier?: string;
  annotations?: any[];
  refusal?: string | null;
  logprobs?: any;
  [key: string]: any;
};

export type ChatCompletionResponse = {
  id: string;
  model: string;
  content: string | null;
  toolCalls: ToolCall[];
  usage: TokenUsage;
  finishReason: FinishReason;
  /** The provider's own finish/stop reason string, unnormalised (e.g. "end_turn", "function_call"). */
  rawFinishReason?: string;
  /**
   * Provider response fields the unified shape has no slot for, kept when present:
   * `system_fingerprint`, `service_tier`, `annotations`, `refusal`, `logprobs`.
   */
  providerFields?: ProviderResponseFields;
  /** Native reasoning blocks + summary captured from the response, if any. */
  reasoning?: ReasoningPayload;
  raw: any; // Original provider response
};

// ─── Stream Chunk ────────────────────────────────────────────────────────────

export type ChatCompletionChunk = {
  id: string;
  model: string;
  delta: {
    content?: string;
    toolCalls?: Partial<ToolCall>[];
    /** Incremental reasoning text / signature deltas (Anthropic thinking). */
    reasoning?: ReasoningPayload;
  };
  usage?: TokenUsage;
  finishReason?: FinishReason;
  /** The provider's own finish reason string, unnormalised. Present on the chunk that carries it. */
  rawFinishReason?: string;
  /** See ChatCompletionResponse.providerFields; per-chunk (fingerprint, tier, delta refusal/annotations, logprobs). */
  providerFields?: ProviderResponseFields;
};

// ─── Embeddings ──────────────────────────────────────────────────────────────

/** Why the text is being embedded; mapped to each provider's own task/input type. */
export type EmbeddingInputType =
  | "search_document"
  | "search_query"
  | "classification"
  | "clustering"
  | "semantic_similarity"
  | "question_answering"
  | "fact_verification"
  | "code_retrieval_query"
  | (string & {});

export type EmbeddingRequest = {
  /** Model id (OpenAI/compatible), deployment name (Azure), model id (Bedrock), model name (Vertex). */
  model: string;
  /** Texts to embed. One vector per entry, in the same order. */
  input: string[];
  /** Requested output dimensions, for models that support shortening (OpenAI v3, Titan v2, Cohere v4, Gemini). */
  dimensions?: number;
  /** OpenAI-shaped endpoints: wire encoding. Vectors are always returned as number[] either way. */
  encodingFormat?: "float" | "base64";
  /** Task hint (Cohere on Bedrock, Gemini on Vertex). Ignored by providers without one. */
  inputType?: EmbeddingInputType;
  /** Max texts per HTTP request. Defaults per provider (OpenAI 2048, Vertex 100, Gemini-embedding 1, Titan 1). */
  batchSize?: number;
  /** Provider-specific fields merged into each request body (escape hatch). */
  extra?: Record<string, any>;
  signal?: AbortSignal;
};

export type EmbeddingUsage = {
  inputTokens: number;
  totalTokens: number;
};

export type EmbeddingResponse = {
  model: string;
  /** One vector per input, in input order. */
  vectors: number[][];
  usage: EmbeddingUsage;
  /** Raw provider responses, one per HTTP request made. */
  raw: any[];
};

// ─── Provider Configs ────────────────────────────────────────────────────────

export type ProviderRetryConfig = {
  /** Maximum retries on 429/5xx (default 3). */
  maxRetries?: number;
  /** Initial delay between retries in ms (default 500, doubled each attempt). */
  baseDelayMs?: number;
  /** Hard cap on a single retry delay in ms (default 8000). */
  maxDelayMs?: number;
  /** Custom predicate to opt in/out of a specific retry. */
  shouldRetry?: (error: any, attempt: number) => boolean;
};

/** Transport options shared by every provider config. */
export type ProviderTransportConfig = {
  /**
   * Custom `fetch` used at EVERY HTTP call site of the provider (chat, stream,
   * Responses, token exchange). Lets a host inject an SSRF-safe or proxied
   * fetch. Defaults to the global `fetch`.
   */
  fetch?: typeof fetch;
  /**
   * Per-request timeout in ms, measured until the response headers arrive
   * (an established stream is not cut by it). Default: none.
   */
  timeoutMs?: number;
};

export type OpenAIProviderConfig = ProviderTransportConfig & {
  /**
   * Which token-limit field to send: `max_tokens` or `max_completion_tokens`.
   * `auto` (default) uses `max_completion_tokens` for o-series / gpt-5 models
   * and `max_tokens` otherwise.
   */
  maxTokensParam?: "auto" | "max_tokens" | "max_completion_tokens";
  provider: "openai";
  apiKey: string;
  baseURL?: string;
  organization?: string;
  defaultModel?: string;
  defaultHeaders?: Record<string, string>;
  retry?: ProviderRetryConfig;
  /**
   * @deprecated Use `api: "chat" | "responses" | "auto"`. Kept as an alias:
   * `never` = chat, `always` = responses, `auto` = the name-based heuristic.
   * When `api` is also set, `api` wins.
   *
   * WHICH API a reasoning-carrying request is addressed to.
   *
   *  auto    (the default for OpenAI and Azure) route to the Responses API when
   *          the request carries `reasoning` AND the model name looks like an
   *          o-series/gpt-5 reasoning model.
   *  never   always Chat Completions. `reasoning` is still mapped, as
   *          `reasoning_effort` plus any `providerExtras`.
   *  always  always Responses, whatever the model is called.
   *
   * `auto` is a name-based guess, and it decides far more than where reasoning
   * goes: Responses is a different request shape (`input` not `messages`,
   * `text.format` not `response_format`, flat tool objects) and a different
   * response parse. A caller with its own measurements of the Chat Completions
   * body — a gateway, a proxy, an on-prem server that serves one and not the
   * other, or anything that has tuned `extra` — must be able to say so, rather
   * than discover that asking for less thinking silently changed the transport.
   *
   * Applies to any OpenAI-shaped endpoint, which is also why the guess is weak
   * where it matters most: a self-hosted model is named by whoever served it.
   */
  responsesApi?: "auto" | "never" | "always";
  /** @internal Set by OpenAICompatibleProvider: `auto` then means Chat Completions. */
  _autoMeansChat?: boolean;
  /**
   * Which upstream API requests are sent to. `"auto"` (default) keeps the
   * 0.11 behaviour of each class: OpenAI and Azure use Responses when the
   * request carries `reasoning` and the model name looks like an o-series /
   * gpt-5 model, otherwise Chat Completions; OpenAI-compatible always uses
   * Chat Completions (the model name is the server operator's). `"chat"` always
   * sends Chat Completions. `"responses"`
   * sends every request to the Responses API (`POST /responses`) and streams it
   * over real SSE (text, tool-call arguments and reasoning-summary deltas;
   * set `responsesStreaming: false` to get one non-streaming call instead).
   * Works on `OpenAIProvider`, `AzureProvider` and `OpenAICompatibleProvider`.
   * When set, it wins over the deprecated `responsesApi`.
   */
  api?: "chat" | "responses" | "auto";
  /**
   * Models that go to the Responses API, named explicitly. Opt-in; unset by
   * default.
   *
   * A string matches the request's model (or `defaultModel`) exactly; a RegExp
   * is tested against it. A match routes the request to Responses whether or
   * not it carries `reasoning` — the case this exists for is a model that
   * reasons by default and rejects function tools on Chat Completions, where
   * sending no reasoning field does not help. `responsesApi: "never"` still
   * wins; under `"always"` the routing is unchanged.
   *
   * Requests for a matched model also get, on the Responses body only:
   *  - Chat Completions spellings arriving through `extra`, which /responses
   *    rejects with a 400, re-spelled with their values unchanged:
   *    `reasoning_effort` → `reasoning.effort` (a request `reasoning` effort
   *    still wins), `max_tokens` / `max_completion_tokens` →
   *    `max_output_tokens`, `response_format` → `text.format`, and
   *    `stream_options.include_usage` dropped.
   *  - real SSE streaming, when `responsesStreaming` is also true.
   *
   * Honoured by `OpenAIProvider`, `AzureProvider` and
   * `OpenAICompatibleProvider` alike.
   */
  responsesApiModels?: Array<string | RegExp>;
  /**
   * Stream Responses API output as it arrives (text, tool-call argument and
   * reasoning-summary deltas) for `api: "responses"` and for models in
   * `responsesApiModels`. Default true with `api: "responses"`, false
   * otherwise (one non-streaming Responses call emitted as a single chunk).
   * Has no effect on Chat Completions requests.
   */
  responsesStreaming?: boolean;
};

export type AnthropicProviderConfig = ProviderTransportConfig & {
  provider: "anthropic";
  apiKey: string;
  baseURL?: string;
  defaultModel?: string;
  defaultHeaders?: Record<string, string>;
  anthropicVersion?: string;
  retry?: ProviderRetryConfig;
  /**
   * Prompt caching configuration. When enabled, places cache_control:
   * ephemeral breakpoints on the system prompt and the final tool definition,
   * which is the recommended Anthropic recipe for static system + tools.
   */
  prompt_caching?: { enabled: boolean };
  /**
   * Thinking request shape. `auto` (default) picks per model id: Claude 5.x
   * and newer use `thinking:{type:"adaptive"}` + `output_config.effort`, older
   * models use `thinking:{type:"enabled", budget_tokens}`. Force one with
   * `adaptive` / `budget`. On the specific 400 for the wrong shape the
   * provider retries once with the other form.
   */
  thinkingMode?: "auto" | "adaptive" | "budget";
};

export type AzureProviderConfig = ProviderTransportConfig & {
  provider: "azure";
  retry?: ProviderRetryConfig;
  /** See OpenAIProviderConfig.maxTokensParam. */
  maxTokensParam?: "auto" | "max_tokens" | "max_completion_tokens";
  apiKey: string;
  endpoint: string; // e.g. https://my-resource.openai.azure.com
  apiVersion?: string;
  deploymentName?: string;
  defaultModel?: string;
  defaultHeaders?: Record<string, string>;
  /** See OpenAIProviderConfig.api. Default "auto". */
  api?: "chat" | "responses" | "auto";
  /** @deprecated Use `api`. */
  responsesApi?: "auto" | "never" | "always";
  responsesApiModels?: Array<string | RegExp>;
  responsesStreaming?: boolean;
};

export type OpenAICompatibleProviderConfig = ProviderTransportConfig & {
  provider: "openai-compatible";
  organization?: string;
  retry?: ProviderRetryConfig;
  /** @deprecated Use `api`. Default: see `api`. */
  responsesApi?: "auto" | "never" | "always";
  /** See OpenAIProviderConfig.api. Default "auto". */
  api?: "chat" | "responses" | "auto";
  responsesApiModels?: Array<string | RegExp>;
  responsesStreaming?: boolean;
  /** See OpenAIProviderConfig.maxTokensParam. Compatible servers default to `auto`. */
  maxTokensParam?: "auto" | "max_tokens" | "max_completion_tokens";
  apiKey: string;
  baseURL: string;
  defaultModel?: string;
  defaultHeaders?: Record<string, string>;
};

export type BedrockProviderConfig = ProviderTransportConfig & {
  provider: "bedrock";
  region: string;
  /** Thinking request shape for Claude models: `auto` (by model id), `adaptive` or `budget`. */
  thinkingMode?: "auto" | "adaptive" | "budget";
  accessKeyId?: string;
  secretAccessKey?: string;
  sessionToken?: string;
  defaultModel?: string;
  defaultHeaders?: Record<string, string>;
  retry?: ProviderRetryConfig;
  /**
   * Insert Bedrock Converse `cachePoint` blocks at the end of the system
   * prompt and tools list. Only supported by models that implement Converse
   * prompt caching (most Anthropic Claude variants on Bedrock).
   */
  prompt_caching?: { enabled: boolean };
};

export type VertexProviderConfig = ProviderTransportConfig & {
  provider: "vertex";
  projectId: string;
  location?: string;
  accessToken?: string;
  serviceAccountJson?: string | Record<string, any>;
  defaultModel?: string;
  defaultHeaders?: Record<string, string>;
  /** Retry policy for 429/5xx (default 3 retries, exponential backoff). */
  retry?: ProviderRetryConfig;
};

export type JevProviderConfig = ProviderTransportConfig & {
  provider: "jev";
  apiKey: string;
  /** Defaults to https://api.typesafe.ai. */
  baseURL?: string;
  defaultModel?: string;
  defaultHeaders?: Record<string, string>;
  retry?: ProviderRetryConfig;
};

export type ProviderConfig =
  | OpenAIProviderConfig
  | AnthropicProviderConfig
  | AzureProviderConfig
  | OpenAICompatibleProviderConfig
  | BedrockProviderConfig
  | VertexProviderConfig
  | JevProviderConfig;

export type ProviderType = ProviderConfig["provider"];

// ─── Provider Error ──────────────────────────────────────────────────────────

export class ProviderError extends Error {
  constructor(
    message: string,
    public readonly provider: string,
    public readonly statusCode?: number,
    public readonly responseBody?: any,
  ) {
    super(message);
    this.name = "ProviderError";
  }
}
