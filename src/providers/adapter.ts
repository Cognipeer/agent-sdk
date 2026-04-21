// Adapter that wraps a native provider into the agent-sdk's BaseChatModel interface.
// This allows any provider to be used directly with createAgent() / createSmartAgent().

import type { BaseChatModel, BaseChatMessage, BaseChatMessagePart } from "../model.js";
import type { ModelCapabilities } from "../structuredOutput/types.js";
import type { BaseProvider } from "./base.js";
import type {
  ChatCompletionRequest,
  ChatCompletionResponse,
  UnifiedMessage,
  ToolDefinition,
  ToolCall,
  ContentPart,
  TokenUsage,
  ProviderType,
  ReasoningRequestConfig,
} from "./types.js";
import { zodToJsonSchema } from "zod-to-json-schema";

export type NativeModelOptions = {
  /** Override the model ID per adapter instance */
  model?: string;
  /** Default temperature */
  temperature?: number;
  /** Default max tokens */
  maxTokens?: number;
  /** Provider-specific extras passed on every request */
  extra?: Record<string, any>;
  /** Unified native reasoning config applied by default (per-call overrides supported). */
  reasoning?: ReasoningRequestConfig;
};

/**
 * Creates a BaseChatModel from a native provider.
 *
 * Usage:
 * ```ts
 * const provider = createProvider({ provider: "openai", apiKey: "..." });
 * const model = fromNativeProvider(provider, { model: "gpt-4o" });
 * const agent = createSmartAgent({ model, tools: [...] });
 * ```
 */
export function fromNativeProvider(
  provider: BaseProvider,
  options?: NativeModelOptions,
): BaseChatModel {
  let boundTools: ToolDefinition[] | undefined = (options as any)?.__tools;

  const modelName = options?.model ?? (provider as any).defaultModel ?? provider.providerName;

  const adapted: BaseChatModel = {
    modelName,

    capabilities: resolveCapabilities(provider.providerName),

    invoke: async (
      messages: BaseChatMessage[],
      _invokeOptions?: Record<string, any>,
    ): Promise<BaseChatMessage> => {
      const request = buildRequest(messages, boundTools, options, _invokeOptions);
      const response = await provider.complete(request);
      return toBaseChatMessage(response);
    },

    stream: async function* (
      messages: BaseChatMessage[],
      _invokeOptions?: Record<string, any>,
    ): AsyncIterable<BaseChatMessage | BaseChatMessagePart | string> {
      const request = buildRequest(messages, boundTools, options, _invokeOptions);
      request.stream = true;

      let fullContent = "";
      let allToolCalls: ToolCall[] = [];
      let lastUsage: TokenUsage | undefined;
      const toolCallBuffers = new Map<string, ToolCall>();

      for await (const chunk of provider.completeStream(request)) {
        // Yield text deltas as strings for streaming
        if (chunk.delta.content) {
          fullContent += chunk.delta.content;
          yield chunk.delta.content;
        }

        // Accumulate tool calls
        if (chunk.delta.toolCalls) {
          for (const tc of chunk.delta.toolCalls) {
            if (tc.id) {
              const existing = toolCallBuffers.get(tc.id);
              if (existing) {
                if (tc.arguments) existing.arguments += tc.arguments;
              } else {
                toolCallBuffers.set(tc.id, {
                  id: tc.id,
                  name: tc.name ?? "",
                  arguments: tc.arguments ?? "",
                });
              }
            }
          }
        }

        if (chunk.usage) lastUsage = chunk.usage;
      }

      // Yield final assembled message
      allToolCalls = [...toolCallBuffers.values()];
      const finalMessage = assembleMessage(fullContent, allToolCalls, lastUsage);
      yield finalMessage;
    },

    bindTools: (tools: any[], _bindOptions?: { strict?: boolean; [key: string]: any }): BaseChatModel => {
      const strict = _bindOptions?.strict ?? false;
      const toolDefs = tools.map((t) => toToolDefinition(t, strict));
      // Create a new adapter instance with tools pre-set in its closure
      return fromNativeProvider(provider, { ...options, __tools: toolDefs } as any);
    },
  };

  return adapted;

  // ─── Internal helpers ──────────────────────────────────────────────────

  function buildRequest(
    messages: BaseChatMessage[],
    tools?: ToolDefinition[],
    opts?: NativeModelOptions,
    invokeOptions?: Record<string, any>,
  ): ChatCompletionRequest {
    const req: ChatCompletionRequest = {
      model: opts?.model ?? modelName,
      messages: messages.map(toUnifiedMessage),
    };

    if (opts?.temperature != null) req.temperature = opts.temperature;
    if (opts?.maxTokens != null) req.maxTokens = opts.maxTokens;
    if (tools?.length) req.tools = tools;
    if (opts?.extra) req.extra = opts.extra;

    // Reasoning config: per-call invokeOptions.reasoning overrides the adapter default
    const reasoningOverride = (invokeOptions as any)?.reasoning as ReasoningRequestConfig | undefined;
    const reasoningCfg = reasoningOverride ?? opts?.reasoning;
    if (reasoningCfg) req.reasoning = reasoningCfg;

    // Per-call tool choice override (used by reflection node to disable tools temporarily)
    const tc = (invokeOptions as any)?.tool_choice ?? (invokeOptions as any)?.toolChoice;
    if (tc) {
      req.toolChoice = tc;
    }

    // Propagate response_format from invoke options (set by StructuredOutputManager via agentCore)
    const rf = invokeOptions?.response_format;
    if (rf && typeof rf === "object" && rf.type) {
      if (rf.type === "json_schema" && rf.json_schema) {
        req.responseFormat = {
          type: "json_schema",
          schema: rf.json_schema.schema,
          name: rf.json_schema.name,
        };
      } else if (rf.type === "json_object") {
        req.responseFormat = { type: "json_object" };
      } else if (rf.type === "text") {
        req.responseFormat = { type: "text" };
      }
    }

    // Fallback: check for __responseFormat in messages (legacy path)
    if (!req.responseFormat) {
      const lastMsg = messages[messages.length - 1];
      if (lastMsg && (lastMsg as any).__responseFormat) {
        req.responseFormat = (lastMsg as any).__responseFormat;
      }
    }

    return req;
  }
}

// ─── Conversion helpers ──────────────────────────────────────────────────────

function toUnifiedMessage(msg: BaseChatMessage): UnifiedMessage {
  const unified: UnifiedMessage = {
    role: msg.role as UnifiedMessage["role"],
    content: convertContent(msg.content),
  };

  if (msg.name) unified.name = msg.name;
  if (msg.tool_call_id) unified.toolCallId = msg.tool_call_id;

  if (msg.tool_calls?.length) {
    unified.toolCalls = msg.tool_calls.map((tc: any) => ({
      id: tc.id,
      name: tc.function?.name ?? tc.name ?? "",
      arguments: tc.function?.arguments ?? tc.arguments ?? "{}",
    }));
  }

  return unified;
}

function convertContent(content: string | BaseChatMessagePart[]): string | ContentPart[] {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return String(content ?? "");

  return content.map((part): ContentPart => {
    if (part.type === "text" || (!part.type && part.text)) {
      return { type: "text", text: part.text ?? part.content ?? "" };
    }
    if (part.type === "image_url") {
      const img = (part as any).image_url;
      if (typeof img === "string" || img?.url?.startsWith("http")) {
        return {
          type: "image",
          source: { type: "url", url: typeof img === "string" ? img : img.url },
        };
      }
      // data URI → base64
      if (img?.url?.startsWith("data:")) {
        const match = img.url.match(/^data:([^;]+);base64,(.+)$/);
        if (match) {
          return {
            type: "image",
            source: { type: "base64", mediaType: match[1], data: match[2] },
          };
        }
      }
    }
    // Fallback: treat as text
    return { type: "text", text: part.text ?? part.content ?? JSON.stringify(part) };
  });
}

// ─── Zod → JSON Schema helpers ───────────────────────────────────────────────

function isZodSchema(obj: any): boolean {
  return obj != null && typeof obj === "object" && typeof obj.safeParse === "function" && "_def" in obj;
}

function hasStrictUnsafeShape(node: any, inProperty = false): boolean {
  if (!node || typeof node !== "object") return false;

  if (Array.isArray(node)) {
    return node.some((item) => hasStrictUnsafeShape(item, inProperty));
  }

  if (typeof node.$ref === "string") {
    return true;
  }

  const hasType = typeof node.type === "string" || (Array.isArray(node.type) && node.type.length > 0);
  const hasProperties = !!node.properties && typeof node.properties === "object" && !Array.isArray(node.properties);
  const hasItems = node.items !== undefined;
  const hasComposite = ["anyOf", "oneOf", "allOf"].some((key) => Array.isArray(node[key]) && node[key].length > 0);

  if (inProperty && !hasType && !hasProperties && !hasItems) {
    return true;
  }

  if (inProperty && hasComposite && !hasType) {
    return true;
  }

  if (hasProperties) {
    for (const value of Object.values(node.properties as Record<string, unknown>)) {
      if (hasStrictUnsafeShape(value, true)) {
        return true;
      }
    }
  }

  if (node.items && hasStrictUnsafeShape(node.items, false)) {
    return true;
  }

  for (const key of ["anyOf", "oneOf", "allOf"]) {
    if (Array.isArray(node[key]) && hasStrictUnsafeShape(node[key], false)) {
      return true;
    }
  }

  for (const key of ["definitions", "$defs"]) {
    const defs = node[key];
    if (defs && typeof defs === "object") {
      for (const value of Object.values(defs as Record<string, unknown>)) {
        if (hasStrictUnsafeShape(value, false)) {
          return true;
        }
      }
    }
  }

  return false;
}

function canUseStrictToolSchema(schema: any): boolean {
  if (!schema || typeof schema !== "object") {
    return true;
  }

  if (isZodSchema(schema)) {
    return true;
  }

  return !hasStrictUnsafeShape(schema);
}

/**
 * Convert a potentially-Zod schema to a plain JSON Schema object.
 * If it's already a JSON Schema (plain object with `type`), pass through.
 */
function convertToJsonSchema(schema: any, strict = false): Record<string, any> {
  if (!schema || typeof schema !== "object") {
    return { type: "object", properties: {}, required: [], additionalProperties: false };
  }
  if (isZodSchema(schema)) {
    const converted = zodToJsonSchema(schema, {
      $refStrategy: "none",
      ...(strict ? { openaiStrictMode: true } : {}),
    }) as Record<string, any>;
    delete converted["$schema"];
    // Ensure root is type: "object" (zodToJsonSchema should do this, but guard)
    if (!converted.type) converted.type = "object";
    return converted;
  }
  const converted = { ...schema };
  delete converted["$schema"];
  // Already JSON Schema — ensure type is present
  if (!converted.type && converted.properties) {
    return { type: "object", ...converted };
  }
  return converted;
}

/**
 * Recursively normalize a JSON Schema for OpenAI strict mode:
 * - All object properties become required
 * - additionalProperties: false on every object
 */
function normalizeStrictSchema(schema: Record<string, any>): Record<string, any> {
  if (!schema || typeof schema !== "object") return schema;
  const clone = { ...schema };

  if (typeof clone.format === "string") {
    delete clone.format;
  }

  if (clone.type === "object" || clone.properties) {
    if (!clone.type) clone.type = "object";
    if (clone.properties && typeof clone.properties === "object") {
      const normalized: Record<string, any> = {};
      for (const [k, v] of Object.entries(clone.properties)) {
        normalized[k] = normalizeStrictSchema(v as Record<string, any>);
      }
      clone.properties = normalized;
      clone.required = Object.keys(normalized);
    } else {
      clone.properties = {};
      clone.required = [];
    }
    clone.additionalProperties = false;
  }

  if (clone.items) clone.items = normalizeStrictSchema(clone.items);
  for (const key of ["anyOf", "oneOf", "allOf"]) {
    if (Array.isArray(clone[key])) {
      clone[key] = clone[key].map((s: any) => normalizeStrictSchema(s));
    }
  }
  if (clone.definitions && typeof clone.definitions === "object") {
    const nd: Record<string, any> = {};
    for (const [k, v] of Object.entries(clone.definitions)) {
      nd[k] = normalizeStrictSchema(v as Record<string, any>);
    }
    clone.definitions = nd;
  }
  if (clone.$defs && typeof clone.$defs === "object") {
    const nd: Record<string, any> = {};
    for (const [k, v] of Object.entries(clone.$defs)) {
      nd[k] = normalizeStrictSchema(v as Record<string, any>);
    }
    clone.$defs = nd;
  }
  return clone;
}

function toToolDefinition(tool: any, strict?: boolean): ToolDefinition {
  let name: string;
  let description: string;
  let parameters: Record<string, any>;
  let rawSchema: any;
  let useStrict = strict ?? false;

  if (tool.type === "function" && tool.function) {
    // OpenAI function format — parameters are already JSON Schema
    name = tool.function.name;
    description = tool.function.description ?? "";
    rawSchema = tool.function.parameters ?? { type: "object", properties: {}, additionalProperties: false };
  } else {
    name = tool.name ?? "unknown";
    description = tool.description ?? "";
    rawSchema = tool.schema ?? tool.parameters;
  }

  if (useStrict && !canUseStrictToolSchema(rawSchema)) {
    useStrict = false;
  }

  parameters = convertToJsonSchema(rawSchema, useStrict);

  if (useStrict) {
    parameters = normalizeStrictSchema(parameters);
  }

  return { name, description, parameters, ...(useStrict ? { strict: true } : {}) };
}

function toBaseChatMessage(response: ChatCompletionResponse): BaseChatMessage {
  const msg: BaseChatMessage = {
    role: "assistant",
    content: response.content ?? "",
    usage: {
      prompt_tokens: response.usage.inputTokens,
      completion_tokens: response.usage.outputTokens,
      total_tokens: response.usage.totalTokens,
      prompt_tokens_details: {
        cached_tokens: response.usage.cachedInputTokens,
      },
      completion_tokens_details: {
        reasoning_tokens: response.usage.reasoningTokens,
      },
    },
    response_metadata: {
      token_usage: {
        prompt_tokens: response.usage.inputTokens,
        completion_tokens: response.usage.outputTokens,
        total_tokens: response.usage.totalTokens,
        cached_tokens: response.usage.cachedInputTokens,
        cache_write_tokens: response.usage.cachedWriteTokens,
      },
      finish_reason: response.finishReason,
      model_name: response.model,
    },
  };

  if (response.toolCalls.length > 0) {
    msg.tool_calls = response.toolCalls.map((tc) => ({
      id: tc.id,
      type: "function" as const,
      function: { name: tc.name, arguments: tc.arguments },
    }));
  }

  return msg;
}

function assembleMessage(content: string, toolCalls: ToolCall[], usage?: TokenUsage): BaseChatMessage {
  const msg: BaseChatMessage = {
    role: "assistant",
    content,
  };

  if (usage) {
    msg.usage = {
      prompt_tokens: usage.inputTokens,
      completion_tokens: usage.outputTokens,
      total_tokens: usage.totalTokens,
      prompt_tokens_details: {
        cached_tokens: usage.cachedInputTokens,
      },
      completion_tokens_details: {
        reasoning_tokens: usage.reasoningTokens,
      },
    };
    msg.response_metadata = {
      token_usage: {
        prompt_tokens: usage.inputTokens,
        completion_tokens: usage.outputTokens,
        total_tokens: usage.totalTokens,
        cached_tokens: usage.cachedInputTokens,
        cache_write_tokens: usage.cachedWriteTokens,
      },
    };
  }

  if (toolCalls.length > 0) {
    msg.tool_calls = toolCalls.map((tc) => ({
      id: tc.id,
      type: "function" as const,
      function: { name: tc.name, arguments: tc.arguments },
    }));
  }

  return msg;
}

function resolveCapabilities(provider: ProviderType): ModelCapabilities {
  switch (provider) {
    case "openai":
    case "azure":
    case "openai-compatible":
      return {
        structuredOutput: "native",
        strictToolCalling: true,
        streaming: true,
        provider: provider,
      };
    case "anthropic":
      return {
        structuredOutput: "tool_based",
        strictToolCalling: false,
        streaming: true,
        provider: "anthropic",
      };
    case "bedrock":
      return {
        structuredOutput: "tool_based",
        strictToolCalling: false,
        streaming: false, // streaming uses binary protocol
        provider: "bedrock",
      };
    case "vertex":
      return {
        structuredOutput: "native",
        strictToolCalling: false,
        streaming: true,
        provider: "google",
      };
    default:
      return { provider };
  }
}
