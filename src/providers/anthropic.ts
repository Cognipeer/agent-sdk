// Anthropic Messages API provider.
// Direct fetch-based implementation – no SDK dependency.

import { BaseProvider } from "./base.js";
import { parseSSEStream } from "./utils/sse.js";
import { applyAnthropicReasoning } from "./utils/reasoning.js";
import {
  type ChatCompletionRequest,
  type ChatCompletionResponse,
  type ChatCompletionChunk,
  type ToolCall,
  type TokenUsage,
  type UnifiedMessage,
  type ToolDefinition,
  type ReasoningBlock,
  type AnthropicProviderConfig,
  type ProviderType,
  ProviderError,
} from "./types.js";

export class AnthropicProvider extends BaseProvider {
  readonly providerName: ProviderType = "anthropic";

  private readonly apiKey: string;
  private readonly baseURL: string;
  private readonly defaultModel: string;
  private readonly defaultHeaders: Record<string, string>;
  private readonly anthropicVersion: string;

  private readonly promptCachingEnabled: boolean;

  constructor(config: AnthropicProviderConfig) {
    super();
    this.apiKey = config.apiKey;
    this.baseURL = (config.baseURL ?? "https://api.anthropic.com").replace(/\/$/, "");
    this.defaultModel = config.defaultModel ?? "claude-sonnet-4-20250514";
    this.defaultHeaders = config.defaultHeaders ?? {};
    this.anthropicVersion = config.anthropicVersion ?? "2023-06-01";
    this.promptCachingEnabled = config.prompt_caching?.enabled === true;
    if (config.retry) this.retryPolicy = { ...this.retryPolicy, ...config.retry };
  }

  async complete(request: ChatCompletionRequest): Promise<ChatCompletionResponse> {
    const body = this.buildRequestBody(request, false);
    const res = await this.doFetch(body);
    const json = await res.json();
    return this.parseResponse(json);
  }

  async *completeStream(request: ChatCompletionRequest): AsyncGenerator<ChatCompletionChunk, void, unknown> {
    const body = this.buildRequestBody(request, true);
    const res = await this.doFetch(body);

    if (!res.body) throw new ProviderError("No response body for stream", this.providerName);

    let id = "";
    let model = "";
    let inputTokens = 0;
    let outputTokens = 0;
    let cacheReadInputTokens = 0;
    let cacheCreationInputTokens = 0;
    const currentToolCalls = new Map<number, { id: string; name: string; arguments: string }>();
    // Accumulate thinking blocks by content-block index so we can replay them.
    const reasoningBlocks = new Map<number, ReasoningBlock>();

    for await (const event of parseSSEStream(res.body)) {
      let data: any;
      try {
        data = JSON.parse(event.data);
      } catch {
        continue;
      }

      const eventType = event.event ?? data.type;

      switch (eventType) {
        case "message_start": {
          const msg = data.message;
          id = msg?.id ?? "";
          model = msg?.model ?? "";
          if (msg?.usage) {
            inputTokens = msg.usage.input_tokens ?? 0;
            cacheReadInputTokens = msg.usage.cache_read_input_tokens ?? 0;
            cacheCreationInputTokens = msg.usage.cache_creation_input_tokens ?? 0;
          }
          break;
        }

        case "content_block_start": {
          const idx = data.index ?? 0;
          const block = data.content_block;
          if (block?.type === "tool_use") {
            currentToolCalls.set(idx, {
              id: block.id ?? "",
              name: block.name ?? "",
              arguments: "",
            });
          } else if (block?.type === "thinking") {
            reasoningBlocks.set(idx, { type: "thinking", text: block.thinking ?? "", signature: block.signature });
          } else if (block?.type === "redacted_thinking") {
            reasoningBlocks.set(idx, { type: "redacted_thinking", data: block.data });
          }
          break;
        }

        case "content_block_delta": {
          const idx = data.index ?? 0;
          const delta = data.delta;

          if (delta?.type === "text_delta" && delta.text) {
            yield {
              id,
              model,
              delta: { content: delta.text },
            };
          } else if (delta?.type === "thinking_delta" && delta.thinking) {
            const blk = reasoningBlocks.get(idx) ?? { type: "thinking", text: "" };
            blk.text = (blk.text ?? "") + delta.thinking;
            reasoningBlocks.set(idx, blk);
            yield {
              id,
              model,
              delta: { reasoning: { summary: delta.thinking } },
            };
          } else if (delta?.type === "signature_delta" && delta.signature) {
            const blk = reasoningBlocks.get(idx) ?? { type: "thinking", text: "" };
            blk.signature = (blk.signature ?? "") + delta.signature;
            reasoningBlocks.set(idx, blk);
          } else if (delta?.type === "input_json_delta" && delta.partial_json) {
            const tc = currentToolCalls.get(idx);
            if (tc) {
              tc.arguments += delta.partial_json;
              yield {
                id,
                model,
                delta: {
                  toolCalls: [{ id: tc.id, name: tc.name, arguments: delta.partial_json }],
                },
              };
            }
          }
          break;
        }

        case "content_block_stop":
          // No action needed
          break;

        case "message_delta": {
          const delta = data.delta;
          if (data.usage) {
            outputTokens = data.usage.output_tokens ?? outputTokens;
          }
          const finishReason = mapAnthropicStopReason(delta?.stop_reason);
          const usage: TokenUsage = {
            inputTokens,
            outputTokens,
            totalTokens: inputTokens + outputTokens,
            cachedInputTokens: cacheReadInputTokens,
            cachedWriteTokens: cacheCreationInputTokens,
            cachedOutputTokens: 0,
            reasoningTokens: 0,
          };
          const blocks = [...reasoningBlocks.values()].filter(
            (b) => (b.type === "thinking" && b.signature) || (b.type === "redacted_thinking" && b.data),
          );
          yield {
            id,
            model,
            delta: blocks.length > 0 ? { reasoning: { blocks } } : {},
            finishReason,
            usage,
          };
          break;
        }

        case "message_stop":
          break;

        case "error": {
          const errMsg = data.error?.message ?? "Unknown Anthropic streaming error";
          throw new ProviderError(errMsg, this.providerName);
        }
      }
    }
  }

  // ─── Internals ───────────────────────────────────────────────────────────

  private buildRequestBody(request: ChatCompletionRequest, stream: boolean): Record<string, any> {
    // Anthropic separates system from messages
    const { system, messages } = this.splitSystemMessages(request.messages);

    const body: Record<string, any> = {
      model: request.model || this.defaultModel,
      messages: this.toAnthropicMessages(messages),
      max_tokens: request.maxTokens ?? 4096,
      stream,
    };

    if (system) {
      // When prompt caching is on, ship `system` as a block array with a
      // cache_control breakpoint so the static system prompt is reused.
      if (this.promptCachingEnabled) {
        body.system = [{ type: "text", text: system, cache_control: { type: "ephemeral" } }];
      } else {
        body.system = system;
      }
    }
    if (request.temperature != null) body.temperature = request.temperature;
    if (request.topP != null) body.top_p = request.topP;
    if (request.stop) body.stop_sequences = request.stop;

    if (request.tools?.length) {
      const tools = request.tools.map((t) => this.toAnthropicTool(t));
      // Cache the entire tools block by placing the breakpoint on the final
      // tool definition – everything above it in the request is cached too.
      if (this.promptCachingEnabled && tools.length > 0) {
        tools[tools.length - 1] = { ...tools[tools.length - 1], cache_control: { type: "ephemeral" } };
      }
      body.tools = tools;
    }

    if (request.toolChoice != null) {
      if (request.toolChoice === "auto") {
        body.tool_choice = { type: "auto" };
      } else if (request.toolChoice === "required") {
        body.tool_choice = { type: "any" };
      } else if (request.toolChoice === "none") {
        // Anthropic doesn't have a direct "none" – omit tools
      } else {
        body.tool_choice = { type: "tool", name: request.toolChoice.name };
      }
    }

    if (request.extra) {
      Object.assign(body, request.extra);
    }

    applyAnthropicReasoning(body, request.reasoning);

    return body;
  }

  private splitSystemMessages(messages: UnifiedMessage[]): { system: string | undefined; messages: UnifiedMessage[] } {
    const systemParts: string[] = [];
    const rest: UnifiedMessage[] = [];

    for (const m of messages) {
      if (m.role === "system") {
        if (typeof m.content === "string") {
          systemParts.push(m.content);
        } else {
          const text = m.content
            .filter((p) => p.type === "text")
            .map((p) => (p as { type: "text"; text: string }).text)
            .join("\n");
          if (text) systemParts.push(text);
        }
      } else {
        rest.push(m);
      }
    }

    return {
      system: systemParts.length > 0 ? systemParts.join("\n\n") : undefined,
      messages: rest,
    };
  }

  /**
   * Converts unified messages to Anthropic format, coalescing consecutive
   * tool-result messages into a single `user` turn.
   *
   * The unified message list carries one `role: "tool"` entry per tool call
   * (mirroring OpenAI's shape). Anthropic's Messages API expects every
   * `tool_result` block answering a single assistant turn's `tool_use`
   * block(s) to be batched into ONE `user` message rather than sent as
   * separate consecutive `user` messages.
   */
  private toAnthropicMessages(messages: UnifiedMessage[]): Record<string, any>[] {
    const result: Record<string, any>[] = [];
    let mergingToolResults = false;

    for (const m of messages) {
      if (m.role === "tool" && m.toolCallId) {
        const toolResult = this.toAnthropicToolResult(m);
        if (mergingToolResults) {
          result[result.length - 1].content.push(toolResult);
        } else {
          result.push({ role: "user", content: [toolResult] });
          mergingToolResults = true;
        }
        continue;
      }

      mergingToolResults = false;
      result.push(this.toAnthropicMessage(m));
    }

    return result;
  }

  private toAnthropicToolResult(m: UnifiedMessage): Record<string, any> {
    const content = typeof m.content === "string" ? m.content : JSON.stringify(m.content);
    return {
      type: "tool_result",
      tool_use_id: m.toolCallId,
      content,
    };
  }

  private toAnthropicMessage(m: UnifiedMessage): Record<string, any> {
    // Assistant with tool calls. Anthropic requires the original thinking
    // blocks (with their `signature`) to be replayed verbatim *before* the
    // text/tool_use blocks whenever extended thinking was used in that turn.
    if (m.role === "assistant" && m.toolCalls?.length) {
      const content: any[] = [];
      appendReasoningBlocks(content, m.reasoning?.blocks);
      if (typeof m.content === "string" && m.content) {
        content.push({ type: "text", text: m.content });
      }
      for (const tc of m.toolCalls) {
        content.push({
          type: "tool_use",
          id: tc.id,
          name: tc.name,
          input: safeJsonParse(tc.arguments),
        });
      }
      return { role: "assistant", content };
    }

    // Assistant text-only turn that nonetheless carried thinking blocks.
    if (m.role === "assistant" && m.reasoning?.blocks?.length) {
      const content: any[] = [];
      appendReasoningBlocks(content, m.reasoning.blocks);
      const text = typeof m.content === "string" ? m.content : "";
      if (text) content.push({ type: "text", text });
      return { role: "assistant", content };
    }

    // Regular messages
    const msg: Record<string, any> = { role: m.role };

    if (typeof m.content === "string") {
      msg.content = m.content;
    } else if (Array.isArray(m.content)) {
      msg.content = m.content.map((part) => {
        if (part.type === "text") return { type: "text", text: part.text };
        if (part.type === "image") {
          const src = part.source;
          if (src.type === "base64") {
            return {
              type: "image",
              source: { type: "base64", media_type: src.mediaType, data: src.data },
            };
          }
          return {
            type: "image",
            source: { type: "url", url: src.url },
          };
        }
        return part;
      });
    }

    return msg;
  }

  private toAnthropicTool(t: ToolDefinition): Record<string, any> {
    return {
      name: t.name,
      description: t.description,
      input_schema: t.parameters,
    };
  }

  private async doFetch(body: Record<string, any>): Promise<Response> {
    const url = `${this.baseURL}/v1/messages`;
    const headers = {
      "Content-Type": "application/json",
      "x-api-key": this.apiKey,
      "anthropic-version": this.anthropicVersion,
      ...this.defaultHeaders,
    };
    const payload = JSON.stringify(body);
    const res = await this.doFetchWithRetry(() => fetch(url, { method: "POST", headers, body: payload }));

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new ProviderError(
        `Anthropic API error ${res.status}: ${text}`,
        this.providerName,
        res.status,
        text,
      );
    }

    return res;
  }

  private parseResponse(json: any): ChatCompletionResponse {
    const textParts: string[] = [];
    const toolCalls: ToolCall[] = [];
    const reasoningBlocks: ReasoningBlock[] = [];
    const summaryParts: string[] = [];

    for (const block of json.content ?? []) {
      if (block.type === "text") {
        textParts.push(block.text);
      } else if (block.type === "thinking") {
        reasoningBlocks.push({
          type: "thinking",
          text: block.thinking ?? "",
          signature: block.signature,
        });
        if (block.thinking) summaryParts.push(block.thinking);
      } else if (block.type === "redacted_thinking") {
        reasoningBlocks.push({ type: "redacted_thinking", data: block.data });
      } else if (block.type === "tool_use") {
        toolCalls.push({
          id: block.id,
          name: block.name,
          arguments: typeof block.input === "string" ? block.input : JSON.stringify(block.input),
        });
      }
    }

    const usage = json.usage ?? {};
    const tokenUsage: TokenUsage = {
      inputTokens: usage.input_tokens ?? 0,
      outputTokens: usage.output_tokens ?? 0,
      totalTokens: (usage.input_tokens ?? 0) + (usage.output_tokens ?? 0),
      cachedInputTokens: usage.cache_read_input_tokens ?? 0,
      cachedWriteTokens: usage.cache_creation_input_tokens ?? 0,
      cachedOutputTokens: 0,
      // Anthropic bills thinking tokens inside `output_tokens` and does not
      // expose a separate count, so reasoningTokens stays 0 here (cost is still
      // captured via outputTokens). See docs for the limitation.
      reasoningTokens: 0,
    };

    return {
      id: json.id ?? "",
      model: json.model ?? "",
      content: textParts.join("") || null,
      toolCalls,
      usage: tokenUsage,
      finishReason: mapAnthropicStopReason(json.stop_reason),
      reasoning: reasoningBlocks.length > 0
        ? { blocks: reasoningBlocks, summary: summaryParts.join("\n").trim() || undefined }
        : undefined,
      raw: json,
    };
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function mapAnthropicStopReason(reason: string | null | undefined): ChatCompletionResponse["finishReason"] {
  switch (reason) {
    case "end_turn":
    case "stop_sequence":
      return "stop";
    case "tool_use":
      return "tool_calls";
    case "max_tokens":
      return "length";
    default:
      return "stop";
  }
}

function safeJsonParse(str: string): any {
  try {
    return JSON.parse(str);
  } catch {
    return {};
  }
}

/** Pushes captured thinking blocks back into an Anthropic assistant content
 * array. `thinking` blocks must include their original `signature`; redacted
 * blocks carry an opaque `data` payload. Blocks missing required fields are
 * skipped (Anthropic rejects malformed thinking blocks).
 */
function appendReasoningBlocks(content: any[], blocks: ReasoningBlock[] | undefined): void {
  if (!blocks?.length) return;
  for (const b of blocks) {
    if (b.type === "redacted_thinking") {
      if (b.data) content.push({ type: "redacted_thinking", data: b.data });
    } else if (b.type === "thinking") {
      if (b.signature) {
        content.push({ type: "thinking", thinking: b.text ?? "", signature: b.signature });
      }
    }
  }
}
