// AWS Bedrock Converse API provider.
// Uses AWS SigV4 signing with fetch – no AWS SDK dependency.

import { BaseProvider } from "./base.js";
import { signRequest, type SigV4Credentials } from "./utils/sigv4.js";
import {
  type ChatCompletionRequest,
  type ChatCompletionResponse,
  type ChatCompletionChunk,
  type ToolCall,
  type TokenUsage,
  type UnifiedMessage,
  type ToolDefinition,
  type BedrockProviderConfig,
  type ProviderType,
  ProviderError,
} from "./types.js";

export class BedrockProvider extends BaseProvider {
  readonly providerName: ProviderType = "bedrock";

  private readonly region: string;
  private readonly credentials: SigV4Credentials;
  private readonly defaultModel: string;
  private readonly defaultHeaders: Record<string, string>;

  constructor(config: BedrockProviderConfig) {
    super();
    this.region = config.region;
    this.defaultModel = config.defaultModel ?? "anthropic.claude-sonnet-4-20250514-v1:0";
    this.defaultHeaders = config.defaultHeaders ?? {};

    this.credentials = {
      accessKeyId: config.accessKeyId ?? process.env.AWS_ACCESS_KEY_ID ?? "",
      secretAccessKey: config.secretAccessKey ?? process.env.AWS_SECRET_ACCESS_KEY ?? "",
      sessionToken: config.sessionToken ?? process.env.AWS_SESSION_TOKEN,
    };

    if (!this.credentials.accessKeyId || !this.credentials.secretAccessKey) {
      throw new ProviderError(
        "AWS credentials required: provide accessKeyId/secretAccessKey or set AWS_ACCESS_KEY_ID/AWS_SECRET_ACCESS_KEY env vars",
        "bedrock",
      );
    }
  }

  async complete(request: ChatCompletionRequest): Promise<ChatCompletionResponse> {
    const modelId = request.model || this.defaultModel;
    const body = this.buildConverseBody(request);
    const json = await this.doFetch(modelId, body);
    return this.parseResponse(json, modelId);
  }

  async *completeStream(request: ChatCompletionRequest): AsyncGenerator<ChatCompletionChunk, void, unknown> {
    // Bedrock ConverseStream uses AWS event stream binary protocol.
    // For simplicity, we fall back to non-streaming and yield a single chunk.
    // Full event stream parsing can be added if needed.
    const response = await this.complete(request);

    yield {
      id: response.id,
      model: response.model,
      delta: {
        content: response.content ?? undefined,
        toolCalls: response.toolCalls.length > 0 ? response.toolCalls : undefined,
      },
      usage: response.usage,
      finishReason: response.finishReason,
    };
  }

  // ─── Internals ───────────────────────────────────────────────────────────

  private buildConverseBody(request: ChatCompletionRequest): Record<string, any> {
    const { system, messages } = this.splitSystemMessages(request.messages);

    const body: Record<string, any> = {
      messages: messages.map((m) => this.toBedrockMessage(m)),
    };

    if (system.length > 0) {
      body.system = system.map((s) => ({ text: s }));
    }

    // Inference config
    const inferenceConfig: Record<string, any> = {};
    if (request.maxTokens != null) inferenceConfig.maxTokens = request.maxTokens;
    if (request.temperature != null) inferenceConfig.temperature = request.temperature;
    if (request.topP != null) inferenceConfig.topP = request.topP;
    if (request.stop) inferenceConfig.stopSequences = request.stop;
    if (Object.keys(inferenceConfig).length > 0) body.inferenceConfig = inferenceConfig;

    // Tools
    if (request.tools?.length) {
      body.toolConfig = {
        tools: request.tools.map((t) => this.toBedrockTool(t)),
      };

      if (request.toolChoice != null) {
        if (request.toolChoice === "auto") {
          body.toolConfig.toolChoice = { auto: {} };
        } else if (request.toolChoice === "required") {
          body.toolConfig.toolChoice = { any: {} };
        } else if (typeof request.toolChoice === "object") {
          body.toolConfig.toolChoice = { tool: { name: request.toolChoice.name } };
        }
      }
    }

    if (request.extra) {
      Object.assign(body, request.extra);
    }

    return body;
  }

  private splitSystemMessages(messages: UnifiedMessage[]): { system: string[]; messages: UnifiedMessage[] } {
    const system: string[] = [];
    const rest: UnifiedMessage[] = [];

    for (const m of messages) {
      if (m.role === "system") {
        const text = typeof m.content === "string"
          ? m.content
          : m.content.filter((p) => p.type === "text").map((p) => (p as { type: "text"; text: string }).text).join("\n");
        if (text) system.push(text);
      } else {
        rest.push(m);
      }
    }

    return { system, messages: rest };
  }

  private toBedrockMessage(m: UnifiedMessage): Record<string, any> {
    // Tool result → user message with toolResult content
    if (m.role === "tool" && m.toolCallId) {
      const text = typeof m.content === "string" ? m.content : JSON.stringify(m.content);
      return {
        role: "user",
        content: [
          {
            toolResult: {
              toolUseId: m.toolCallId,
              content: [{ text }],
              status: "success",
            },
          },
        ],
      };
    }

    // Assistant with tool calls
    if (m.role === "assistant" && m.toolCalls?.length) {
      const content: any[] = [];
      if (typeof m.content === "string" && m.content) {
        content.push({ text: m.content });
      }
      for (const tc of m.toolCalls) {
        content.push({
          toolUse: {
            toolUseId: tc.id,
            name: tc.name,
            input: safeJsonParse(tc.arguments),
          },
        });
      }
      return { role: "assistant", content };
    }

    // Regular messages
    const content: any[] = [];
    if (typeof m.content === "string") {
      content.push({ text: m.content });
    } else if (Array.isArray(m.content)) {
      for (const part of m.content) {
        if (part.type === "text") {
          content.push({ text: part.text });
        } else if (part.type === "image") {
          const src = part.source;
          if (src.type === "base64") {
            content.push({
              image: {
                format: mediaTypeToFormat(src.mediaType),
                source: { bytes: src.data },
              },
            });
          }
        }
      }
    }

    return { role: m.role === "user" ? "user" : "assistant", content };
  }

  private toBedrockTool(t: ToolDefinition): Record<string, any> {
    return {
      toolSpec: {
        name: t.name,
        description: t.description,
        inputSchema: { json: t.parameters },
      },
    };
  }

  private async doFetch(modelId: string, body: Record<string, any>): Promise<any> {
    const host = `bedrock-runtime.${this.region}.amazonaws.com`;
    const url = `https://${host}/model/${encodeURIComponent(modelId)}/converse`;
    const bodyStr = JSON.stringify(body);

    const headers = signRequest({
      method: "POST",
      url,
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        ...this.defaultHeaders,
      },
      body: bodyStr,
      region: this.region,
      service: "bedrock",
      credentials: this.credentials,
    });

    const res = await fetch(url, {
      method: "POST",
      headers,
      body: bodyStr,
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new ProviderError(
        `Bedrock API error ${res.status}: ${text}`,
        this.providerName,
        res.status,
        text,
      );
    }

    return res.json();
  }

  private parseResponse(json: any, modelId: string): ChatCompletionResponse {
    const output = json.output?.message;
    const textParts: string[] = [];
    const toolCalls: ToolCall[] = [];

    for (const block of output?.content ?? []) {
      if (block.text) {
        textParts.push(block.text);
      } else if (block.toolUse) {
        toolCalls.push({
          id: block.toolUse.toolUseId,
          name: block.toolUse.name,
          arguments: typeof block.toolUse.input === "string"
            ? block.toolUse.input
            : JSON.stringify(block.toolUse.input ?? {}),
        });
      }
    }

    const usage = json.usage ?? {};
    const tokenUsage: TokenUsage = {
      inputTokens: usage.inputTokens ?? 0,
      outputTokens: usage.outputTokens ?? 0,
      totalTokens: usage.totalTokens ?? (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0),
      cachedInputTokens: usage.cacheReadInputTokenCount ?? 0,
      cachedWriteTokens: usage.cacheWriteInputTokenCount ?? 0,
      cachedOutputTokens: 0,
      reasoningTokens: 0,
    };

    return {
      id: json.requestId ?? json.$metadata?.requestId ?? "",
      model: modelId,
      content: textParts.join("") || null,
      toolCalls,
      usage: tokenUsage,
      finishReason: mapBedrockStopReason(json.stopReason),
      raw: json,
    };
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function mapBedrockStopReason(reason: string | null | undefined): ChatCompletionResponse["finishReason"] {
  switch (reason) {
    case "end_turn":
    case "stop_sequence":
      return "stop";
    case "tool_use":
      return "tool_calls";
    case "max_tokens":
      return "length";
    case "content_filtered":
    case "guardrail":
      return "content_filter";
    default:
      return "stop";
  }
}

function mediaTypeToFormat(mediaType: string): string {
  const map: Record<string, string> = {
    "image/jpeg": "jpeg",
    "image/png": "png",
    "image/gif": "gif",
    "image/webp": "webp",
  };
  return map[mediaType] ?? "png";
}

function safeJsonParse(str: string): any {
  try {
    return JSON.parse(str);
  } catch {
    return {};
  }
}
