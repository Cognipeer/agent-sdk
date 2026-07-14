// AWS Bedrock Converse API provider.
// Uses AWS SigV4 signing with fetch – no AWS SDK dependency.

import { BaseProvider } from "./base.js";
import { signRequest, type SigV4Credentials } from "./utils/sigv4.js";
import { applyBedrockReasoning } from "./utils/reasoning.js";
import {
  type ChatCompletionRequest,
  type ChatCompletionResponse,
  type ChatCompletionChunk,
  type ToolCall,
  type TokenUsage,
  type UnifiedMessage,
  type ToolDefinition,
  type ReasoningBlock,
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

  private readonly promptCachingEnabled: boolean;

  constructor(config: BedrockProviderConfig) {
    super();
    this.region = config.region;
    this.defaultModel = config.defaultModel ?? "anthropic.claude-sonnet-4-20250514-v1:0";
    this.defaultHeaders = config.defaultHeaders ?? {};
    this.promptCachingEnabled = config.prompt_caching?.enabled === true;
    if (config.retry) this.retryPolicy = { ...this.retryPolicy, ...config.retry };

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
      messages: this.toBedrockMessages(messages),
    };

    if (system.length > 0) {
      const systemBlocks = system.map((s) => ({ text: s }) as Record<string, any>);
      if (this.promptCachingEnabled) systemBlocks.push({ cachePoint: { type: "default" } });
      body.system = systemBlocks;
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
      const tools = request.tools.map((t) => this.toBedrockTool(t)) as Array<Record<string, any>>;
      if (this.promptCachingEnabled && tools.length > 0) {
        // Converse uses a {cachePoint} block at the end of the tools array.
        tools.push({ cachePoint: { type: "default" } });
      }
      body.toolConfig = {
        tools,
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

    // Native reasoning: maps to additionalModelRequestFields.thinking and
    // enforces the budget/temperature rules for thinking-capable models.
    applyBedrockReasoning(body, request.reasoning);

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

  /**
   * Converts unified messages to Bedrock Converse format, coalescing
   * consecutive tool-result messages into a single `user` turn.
   *
   * The unified message list carries one `role: "tool"` entry per tool call
   * (mirroring OpenAI's shape). Bedrock's Converse API requires every
   * `toolResult` block answering a single assistant turn's `toolUse`
   * block(s) to be batched into ONE `user` message — sending them as
   * separate consecutive `user` messages triggers: "Expected toolResult
   * blocks at messages.N.content for the following Ids: ...".
   */
  private toBedrockMessages(messages: UnifiedMessage[]): Record<string, any>[] {
    const result: Record<string, any>[] = [];
    let mergingToolResults = false;

    for (const m of messages) {
      if (m.role === "tool" && m.toolCallId) {
        const toolResult = this.toBedrockToolResult(m);
        if (mergingToolResults) {
          result[result.length - 1].content.push(toolResult);
        } else {
          result.push({ role: "user", content: [toolResult] });
          mergingToolResults = true;
        }
        continue;
      }

      mergingToolResults = false;
      result.push(this.toBedrockMessage(m));
    }

    return result;
  }

  private toBedrockToolResult(m: UnifiedMessage): Record<string, any> {
    const text = typeof m.content === "string" ? m.content : JSON.stringify(m.content);
    return {
      toolResult: {
        toolUseId: m.toolCallId,
        content: [{ text }],
        status: "success",
      },
    };
  }

  private toBedrockMessage(m: UnifiedMessage): Record<string, any> {
    // Assistant with tool calls
    if (m.role === "assistant" && m.toolCalls?.length) {
      const content: any[] = [];
      appendBedrockReasoning(content, m.reasoning?.blocks);
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

    const res = await this.doFetchWithRetry(() => {
      // SigV4 must re-sign on each retry because of the x-amz-date header.
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
      return fetch(url, { method: "POST", headers, body: bodyStr });
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
    const reasoningBlocks: ReasoningBlock[] = [];
    const summaryParts: string[] = [];

    for (const block of output?.content ?? []) {
      if (block.text) {
        textParts.push(block.text);
      } else if (block.reasoningContent) {
        const rc = block.reasoningContent;
        if (rc.reasoningText) {
          reasoningBlocks.push({
            type: "thinking",
            text: rc.reasoningText.text ?? "",
            signature: rc.reasoningText.signature,
          });
          if (rc.reasoningText.text) summaryParts.push(rc.reasoningText.text);
        } else if (rc.redactedContent) {
          reasoningBlocks.push({ type: "redacted_thinking", data: rc.redactedContent });
        }
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
      // Bedrock bills thinking tokens inside outputTokens; no separate count.
      reasoningTokens: 0,
    };

    return {
      id: json.requestId ?? json.$metadata?.requestId ?? "",
      model: modelId,
      content: textParts.join("") || null,
      toolCalls,
      usage: tokenUsage,
      finishReason: mapBedrockStopReason(json.stopReason),
      reasoning: reasoningBlocks.length > 0
        ? { blocks: reasoningBlocks, summary: summaryParts.join("\n").trim() || undefined }
        : undefined,
      raw: json,
    };
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Replays captured thinking blocks into a Bedrock Converse assistant content
 * array as `reasoningContent` blocks, ahead of text/toolUse blocks. */
function appendBedrockReasoning(content: any[], blocks: ReasoningBlock[] | undefined): void {
  if (!blocks?.length) return;
  for (const b of blocks) {
    if (b.type === "redacted_thinking") {
      if (b.data) content.push({ reasoningContent: { redactedContent: b.data } });
    } else if (b.type === "thinking") {
      if (b.signature) {
        content.push({
          reasoningContent: { reasoningText: { text: b.text ?? "", signature: b.signature } },
        });
      }
    }
  }
}

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
