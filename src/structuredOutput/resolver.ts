import type { StructuredOutputStrategy, ModelCapabilities } from "./types.js";
import { NativeJsonSchemaStrategy } from "./nativeStrategy.js";
import { ToolBasedStrategy } from "./toolStrategy.js";

/**
 * Resolve the most appropriate structured output strategy for a given model.
 *
 * If the model exposes capabilities (via adapter or direct provider),
 * we use native JSON Schema support when available. Otherwise we fall back
 * to the universal tool-based approach.
 *
 * When direct providers are added to the SDK, they should set
 * `model.capabilities.structuredOutput = "native"` for providers that support
 * response_format (OpenAI, Gemini, etc.).
 */
export function resolveStrategy(model: any): StructuredOutputStrategy {
  const capabilities = getModelCapabilities(model);

  if (capabilities.structuredOutput === "native") {
    return new NativeJsonSchemaStrategy();
  }

  return new ToolBasedStrategy();
}

/**
 * Extract capabilities from a model object.
 * Supports:
 *   - model.capabilities (set by adapters or direct providers)
 *   - Auto-detection from model class name / metadata
 */
export function getModelCapabilities(model: any): ModelCapabilities {
  // Explicit capabilities take precedence
  if (model?.capabilities && typeof model.capabilities === "object") {
    return model.capabilities as ModelCapabilities;
  }

  // Auto-detect from LangChain wrapper or model metadata
  const provider = detectProvider(model);
  if (provider) {
    return {
      provider,
      structuredOutput: supportsNativeStructuredOutput(provider) ? "native" : "tool_based",
      strictToolCalling: requiresStrictToolCalling(provider),
      streaming: true,
    };
  }

  // Default: tool-based (safe fallback)
  return { structuredOutput: "tool_based" };
}

/**
 * Try to detect the provider from model metadata.
 * Works with both fromLangchainModel wrappers and future direct providers.
 */
function detectProvider(model: any): string | undefined {
  if (!model || typeof model !== "object") return undefined;

  // Check explicit provider field
  if (typeof model.provider === "string") return model.provider;

  // Check LangChain wrapped model
  const lcModel = model._lc;
  if (lcModel) {
    return detectProviderFromLCModel(lcModel);
  }

  // Check model name hints
  const modelName: string = model.modelName || model.model || "";
  if (modelName.startsWith("gpt-") || modelName.startsWith("o1") || modelName.startsWith("o3") || modelName.startsWith("o4")) return "openai";
  if (modelName.startsWith("claude")) return "anthropic";
  if (modelName.startsWith("gemini")) return "google";
  if (modelName.startsWith("amazon.") || modelName.startsWith("anthropic.")) return "bedrock";

  return undefined;
}

function detectProviderFromLCModel(lcModel: any): string | undefined {
  if (!lcModel) return undefined;

  const className = lcModel.constructor?.name || "";
  if (className.includes("ChatOpenAI") || className.includes("AzureChatOpenAI")) return "openai";
  if (className.includes("ChatAnthropic")) return "anthropic";
  if (className.includes("ChatGoogleGenerativeAI") || className.includes("ChatVertexAI")) return "google";
  if (className.includes("ChatBedrock") || className.includes("BedrockChat")) return "bedrock";
  if (className.includes("ChatGroq")) return "groq";
  if (className.includes("ChatMistralAI")) return "mistral";

  // Check _llmType()
  const llmType = typeof lcModel._llmType === "function" ? lcModel._llmType() : lcModel._llmType;
  if (typeof llmType === "string") {
    if (llmType.includes("openai")) return "openai";
    if (llmType.includes("anthropic")) return "anthropic";
    if (llmType.includes("google")) return "google";
  }

  return undefined;
}

/**
 * Providers that support native response_format with json_schema.
 * This list will grow as more providers adopt the standard.
 */
function supportsNativeStructuredOutput(provider: string): boolean {
  return ["openai", "google", "groq", "mistral"].includes(provider);
}

function requiresStrictToolCalling(provider: string): boolean {
  return ["openai"].includes(provider);
}
