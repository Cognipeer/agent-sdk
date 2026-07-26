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
  tools?: ToolDefinition[];
  toolChoice?: "auto" | "required" | "none" | { name: string };
  responseFormat?: {
    type: "json_schema" | "json_object" | "text";
    schema?: Record<string, any>;
    name?: string;
  };
  stream?: boolean;
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
};

export type ReasoningEffort = "minimal" | "low" | "medium" | "high";

export type ReasoningRequestConfig = {
  /** Qualitative effort hint (mapped per-provider). */
  effort?: ReasoningEffort;
  /** Explicit per-call token budget for reasoning/thinking. */
  budgetTokens?: number;
  /** Whether the provider should expose its reasoning/thought summary to the caller. Default false. */
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

export type ChatCompletionResponse = {
  id: string;
  model: string;
  content: string | null;
  toolCalls: ToolCall[];
  usage: TokenUsage;
  finishReason: FinishReason;
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

export type OpenAIProviderConfig = {
  provider: "openai";
  apiKey: string;
  baseURL?: string;
  organization?: string;
  defaultModel?: string;
  defaultHeaders?: Record<string, string>;
  retry?: ProviderRetryConfig;
};

export type AnthropicProviderConfig = {
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
};

export type AzureProviderConfig = {
  provider: "azure";
  apiKey: string;
  endpoint: string; // e.g. https://my-resource.openai.azure.com
  apiVersion?: string;
  deploymentName?: string;
  defaultModel?: string;
  defaultHeaders?: Record<string, string>;
};

export type OpenAICompatibleProviderConfig = {
  provider: "openai-compatible";
  apiKey: string;
  baseURL: string;
  defaultModel?: string;
  defaultHeaders?: Record<string, string>;
};

export type BedrockProviderConfig = {
  provider: "bedrock";
  region: string;
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

export type VertexProviderConfig = {
  provider: "vertex";
  projectId: string;
  location?: string;
  accessToken?: string;
  serviceAccountJson?: string | Record<string, any>;
  defaultModel?: string;
  defaultHeaders?: Record<string, string>;
};

export type ProviderConfig =
  | OpenAIProviderConfig
  | AnthropicProviderConfig
  | AzureProviderConfig
  | OpenAICompatibleProviderConfig
  | BedrockProviderConfig
  | VertexProviderConfig;

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
