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
    | { type: "url"; url: string };
};

export type ContentPart = TextContent | ImageContent;

export type ToolCall = {
  id: string;
  name: string;
  arguments: string; // JSON string
};

export type UnifiedMessage = {
  role: MessageRole;
  content: string | ContentPart[];
  name?: string;
  toolCalls?: ToolCall[];
  toolCallId?: string; // for tool result messages
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
  // Provider-specific extras (e.g. thinking, reasoning effort)
  extra?: Record<string, any>;
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
  raw: any; // Original provider response
};

// ─── Stream Chunk ────────────────────────────────────────────────────────────

export type ChatCompletionChunk = {
  id: string;
  model: string;
  delta: {
    content?: string;
    toolCalls?: Partial<ToolCall>[];
  };
  usage?: TokenUsage;
  finishReason?: FinishReason;
};

// ─── Provider Configs ────────────────────────────────────────────────────────

export type OpenAIProviderConfig = {
  provider: "openai";
  apiKey: string;
  baseURL?: string;
  organization?: string;
  defaultModel?: string;
  defaultHeaders?: Record<string, string>;
};

export type AnthropicProviderConfig = {
  provider: "anthropic";
  apiKey: string;
  baseURL?: string;
  defaultModel?: string;
  defaultHeaders?: Record<string, string>;
  anthropicVersion?: string;
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
