// ─── Native LLM Providers ───────────────────────────────────────────────────
// Direct API consumption without LangChain or any framework dependency.
// Unified request/response schema with per-provider wire format conversion.

// Types
export type {
  // Message types
  MessageRole,
  TextContent,
  ImageContent,
  ContentPart,
  ToolCall,
  UnifiedMessage,
  ToolDefinition,
  // Request / Response
  ChatCompletionRequest,
  ChatCompletionResponse,
  ChatCompletionChunk,
  TokenUsage,
  FinishReason,
  // Provider configs
  ProviderConfig,
  ProviderType,
  OpenAIProviderConfig,
  AnthropicProviderConfig,
  AzureProviderConfig,
  OpenAICompatibleProviderConfig,
  BedrockProviderConfig,
  VertexProviderConfig,
} from "./types.js";

export { ProviderError, emptyUsage } from "./types.js";

// Base
export { BaseProvider } from "./base.js";

// Providers
export { OpenAIProvider } from "./openai.js";
export { AnthropicProvider } from "./anthropic.js";
export { AzureProvider } from "./azure.js";
export { OpenAICompatibleProvider } from "./openaiCompatible.js";
export { BedrockProvider } from "./bedrock.js";
export { VertexProvider } from "./vertex.js";

// Adapter
export { fromNativeProvider, type NativeModelOptions } from "./adapter.js";

// Factory
import type { ProviderConfig } from "./types.js";
import type { BaseProvider } from "./base.js";
import { OpenAIProvider } from "./openai.js";
import { AnthropicProvider } from "./anthropic.js";
import { AzureProvider } from "./azure.js";
import { OpenAICompatibleProvider } from "./openaiCompatible.js";
import { BedrockProvider } from "./bedrock.js";
import { VertexProvider } from "./vertex.js";

/**
 * Factory function to create a provider from a config object.
 *
 * @example
 * ```ts
 * const provider = createProvider({
 *   provider: "openai",
 *   apiKey: process.env.OPENAI_API_KEY!,
 * });
 *
 * // Direct usage
 * const response = await provider.complete({
 *   model: "gpt-4o",
 *   messages: [{ role: "user", content: "Hello!" }],
 * });
 *
 * // Or wrap as BaseChatModel for agent-sdk
 * import { fromNativeProvider } from "./adapter";
 * const model = fromNativeProvider(provider, { model: "gpt-4o" });
 * const agent = createSmartAgent({ model, tools: [...] });
 * ```
 */
export function createProvider(config: ProviderConfig): BaseProvider {
  switch (config.provider) {
    case "openai":
      return new OpenAIProvider(config);
    case "anthropic":
      return new AnthropicProvider(config);
    case "azure":
      return new AzureProvider(config);
    case "openai-compatible":
      return new OpenAICompatibleProvider(config);
    case "bedrock":
      return new BedrockProvider(config);
    case "vertex":
      return new VertexProvider(config);
    default:
      throw new Error(`Unknown provider: ${(config as any).provider}`);
  }
}
