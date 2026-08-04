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
      let reasoningBlocks: import("./types.js").ReasoningBlock[] | undefined;
      const toolCallBuffers = new Map<string, ToolCall>();

      for await (const chunk of provider.completeStream(request)) {
        // Yield text deltas as strings for streaming
        if (chunk.delta.content) {
          fullContent += chunk.delta.content;
          yield chunk.delta.content;
        }

        // Capture final reasoning blocks (emitted near end of stream).
        if (chunk.delta.reasoning?.blocks?.length) {
          reasoningBlocks = chunk.delta.reasoning.blocks;
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
      if (reasoningBlocks?.length) {
        (finalMessage as any).reasoning = { blocks: reasoningBlocks };
      }
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

    // Reasoning config: a per-call `invokeOptions.reasoning` is MERGED over the
    // adapter default rather than replacing it.
    //
    // The two configs answer different questions and neither is the whole
    // answer. The adapter default is a property of the ENDPOINT — the fields it
    // needs on every request, which for a self-hosted server is typically a
    // `providerExtras` passthrough (a chat-template variable, a gateway flag)
    // and nothing else. The per-call override is a property of the TURN: an
    // agent asking this particular step for more or less deliberation, which is
    // an `effort` and nothing else.
    //
    // Replacing therefore dropped the endpoint's fields the moment any agent set
    // a per-run reasoning config — silently, on a subset of turns, in exactly the
    // deployments that needed them. `providerExtras` is merged key-wise for the
    // same reason, one level deep: the call may override a single flag without
    // having to restate the endpoint's whole passthrough.
    const reasoningOverride = (invokeOptions as any)?.reasoning as ReasoningRequestConfig | undefined;
    const reasoningCfg = mergeReasoning(opts?.reasoning, reasoningOverride);
    if (reasoningCfg) req.reasoning = reasoningCfg;

    // Per-call tool choice override (used by reflection node to disable tools temporarily)
    const tc = (invokeOptions as any)?.tool_choice ?? (invokeOptions as any)?.toolChoice;
    if (tc && tools?.length) {
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

/**
 * Endpoint-level reasoning config with a per-call one merged over it.
 *
 * Returns the surviving object, or undefined when neither side supplied one —
 * so the caller can leave `request.reasoning` unset, which is what keeps a
 * provider's `useResponsesApi` check from firing on a request that never asked
 * for reasoning at all.
 */
function mergeReasoning(
  base: ReasoningRequestConfig | undefined,
  override: ReasoningRequestConfig | undefined,
): ReasoningRequestConfig | undefined {
  if (!base) return override;
  if (!override) return base;
  const merged: ReasoningRequestConfig = { ...base, ...override };
  if (base.providerExtras || override.providerExtras) {
    merged.providerExtras = { ...base.providerExtras, ...override.providerExtras };
  }
  return merged;
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

  // Carry native reasoning blocks back so providers can replay them verbatim
  // (Anthropic/Bedrock extended thinking requires the signed blocks intact).
  const reasoning = (msg as any).reasoning;
  if (reasoning && (reasoning.blocks?.length || reasoning.summary)) {
    unified.reasoning = reasoning;
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
    if (part.type === "file" || part.type === "document") {
      const source = extractBinarySource(part);
      if (source) {
        const fileName = part.metadata?.filename ?? part.metadata?.fileName
          ?? (part as any).fileName ?? (part as any).filename ?? (part as any).name
          ?? (part as any).file?.filename;
        return { type: "file", source, ...(fileName ? { fileName } : {}) };
      }
    }
    if (part.type === "audio" || part.type === "input_audio") {
      // OpenAI chat-completions shape: { type: "input_audio", input_audio: { data, format } }
      const ia = (part as any).input_audio;
      if (ia?.data) {
        const mediaType = ia.format === "wav" ? "audio/wav" : "audio/mpeg";
        return { type: "audio", source: { type: "base64", mediaType, data: ia.data } };
      }
      const source = extractBinarySource(part);
      if (source) return { type: "audio", source };
    }
    // Fallback: treat as text
    return { type: "text", text: part.text ?? part.content ?? JSON.stringify(part) };
  });
}

/**
 * Extracts a unified base64/url source from the shapes file/audio parts arrive
 * in: the unified `source` object, LangChain-style standard data blocks
 * (`source_type` + `data`/`url` + `mime_type`), or a raw data URL.
 */
function extractBinarySource(
  part: any,
): { type: "base64"; mediaType: string; data: string } | { type: "url"; url: string; mediaType?: string } | undefined {
  // Already unified: { source: { type: "base64" | "url", ... } }
  const src = part.source;
  if (src?.type === "base64" && src.data) {
    return { type: "base64", mediaType: src.mediaType ?? src.media_type ?? src.mime_type ?? "application/octet-stream", data: src.data };
  }
  if (src?.type === "url" && src.url) {
    const mediaType = src.mediaType ?? src.media_type ?? src.mime_type;
    return { type: "url", url: src.url, ...(mediaType ? { mediaType } : {}) };
  }

  const mediaType = part.mime_type ?? part.mimeType ?? part.media_type ?? part.mediaType;

  // LangChain standard data block: { source_type: "base64" | "url", data | url }
  if (part.source_type === "base64" && part.data) {
    return { type: "base64", mediaType: mediaType ?? "application/octet-stream", data: part.data };
  }
  if (part.source_type === "url" && part.url) {
    return { type: "url", url: part.url, ...(mediaType ? { mediaType } : {}) };
  }

  // Raw data URL or plain URL in `data` / `url` / OpenAI `file.file_data`
  const value = part.data ?? part.url ?? part.file?.file_data;
  if (typeof value === "string" && value) {
    const match = value.match(/^data:([^;]+);base64,(.+)$/);
    if (match) return { type: "base64", mediaType: mediaType ?? match[1], data: match[2] };
    if (/^https?:\/\//.test(value)) return { type: "url", url: value, ...(mediaType ? { mediaType } : {}) };
    if (mediaType) return { type: "base64", mediaType, data: value };
  }

  return undefined;
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
 * Collapse `anyOf: [X, {type:"null"}]` down to `X` for properties that are not
 * required, and `type: ["string","null"]` down to `type: "string"` likewise.
 *
 * Zod's `.nullable().optional()` — the idiomatic way to spell "you may leave
 * this out" — produces a two-branch union for every constrained field. Grammar-
 * constrained backends (vLLM/xgrammar and the smaller open-weight models behind
 * them) follow unions far less reliably than a plain type, and for an OPTIONAL
 * property the null branch carries no information the `required` list does not
 * already carry: omitting the key and sending null mean the same thing to the
 * tool. So the branch is removed from what the model has to read, and the Zod
 * schema still accepts null if one arrives anyway.
 *
 * Only ever applied to non-strict tool parameters. Under OpenAI strict mode
 * every property is required and the null branch is the ONLY way to express
 * optionality, so collapsing it there would change the contract.
 */
function simplifyOptionalNullableUnions(schema: Record<string, any>, required: Set<string> | null = null): Record<string, any> {
  if (!schema || typeof schema !== "object") return schema;
  const clone: Record<string, any> = { ...schema };

  if (clone.properties && typeof clone.properties === "object") {
    const requiredKeys = new Set<string>(Array.isArray(clone.required) ? clone.required : []);
    const properties: Record<string, any> = {};
    for (const [key, value] of Object.entries(clone.properties)) {
      const child = simplifyOptionalNullableUnions(value as Record<string, any>, requiredKeys);
      properties[key] = requiredKeys.has(key) ? child : dropNullBranch(child);
    }
    clone.properties = properties;
  }

  if (clone.items) clone.items = simplifyOptionalNullableUnions(clone.items, required);
  for (const key of ["anyOf", "oneOf", "allOf"]) {
    if (Array.isArray(clone[key])) {
      clone[key] = clone[key].map((entry: any) => simplifyOptionalNullableUnions(entry, required));
    }
  }
  return clone;
}

function dropNullBranch(schema: Record<string, any>): Record<string, any> {
  if (!schema || typeof schema !== "object") return schema;

  if (Array.isArray(schema.type) && schema.type.includes("null") && schema.type.length === 2) {
    return { ...schema, type: schema.type.find((entry: string) => entry !== "null") };
  }

  if (Array.isArray(schema.anyOf)) {
    const branches = schema.anyOf.filter((entry: any) => entry?.type !== "null");
    if (branches.length === 1 && branches.length !== schema.anyOf.length) {
      const { anyOf, ...rest } = schema;
      return { ...branches[0], ...rest };
    }
    if (branches.length !== schema.anyOf.length && branches.length > 1) {
      return { ...schema, anyOf: branches };
    }
  }

  return schema;
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
  } else {
    parameters = simplifyOptionalNullableUnions(parameters);
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

  if (response.reasoning && (response.reasoning.blocks?.length || response.reasoning.summary)) {
    (msg as any).reasoning = response.reasoning;
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
