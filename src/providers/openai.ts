// OpenAI Chat Completions API provider.
// Direct fetch-based implementation – no SDK dependency.

import { BaseProvider } from "./base.js";
import { parseSSEStream } from "./utils/sse.js";
import { applyOpenAIReasoning } from "./utils/reasoning.js";
import {
  type ChatCompletionRequest,
  type ChatCompletionResponse,
  type ChatCompletionChunk,
  type ToolCall,
  type TokenUsage,
  type UnifiedMessage,
  type ToolDefinition,
  type OpenAIProviderConfig,
  type ProviderType,
  ProviderError,
  emptyUsage,
} from "./types.js";

export class OpenAIProvider extends BaseProvider {
  readonly providerName: ProviderType = "openai";

  protected readonly apiKey: string;
  protected readonly baseURL: string;
  protected readonly defaultModel: string;
  protected readonly defaultHeaders: Record<string, string>;

  constructor(config: OpenAIProviderConfig) {
    super();
    this.apiKey = config.apiKey;
    this.baseURL = (config.baseURL ?? "https://api.openai.com/v1").replace(/\/$/, "");
    this.defaultModel = config.defaultModel ?? "gpt-4o";
    this.defaultHeaders = {
      ...config.defaultHeaders,
      ...(config.organization ? { "OpenAI-Organization": config.organization } : {}),
    };
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
    const toolCallBuffers = new Map<number, { id: string; name: string; arguments: string }>();
    let usage: TokenUsage | undefined;

    for await (const event of parseSSEStream(res.body)) {
      if (event.data === "[DONE]") break;

      let chunk: any;
      try {
        chunk = JSON.parse(event.data);
      } catch {
        continue;
      }

      id = chunk.id ?? id;
      model = chunk.model ?? model;

      const choice = chunk.choices?.[0];

      // Usage is in the final chunk when stream_options.include_usage is true
      if (chunk.usage) {
        usage = this.extractUsage(chunk.usage);
      }

      if (!choice) {
        // Usage-only chunk
        if (usage) yield { id, model, delta: {}, usage };
        continue;
      }

      const delta = choice.delta ?? {};
      const out: ChatCompletionChunk = {
        id,
        model,
        delta: {},
        finishReason: mapFinishReason(choice.finish_reason),
      };

      if (delta.content) {
        out.delta.content = delta.content;
      }

      // Accumulate tool calls
      if (delta.tool_calls) {
        const partials: Partial<ToolCall>[] = [];
        for (const tc of delta.tool_calls) {
          const idx = tc.index ?? 0;
          if (!toolCallBuffers.has(idx)) {
            toolCallBuffers.set(idx, { id: tc.id ?? "", name: "", arguments: "" });
          }
          const buf = toolCallBuffers.get(idx)!;
          if (tc.id) buf.id = tc.id;
          if (tc.function?.name) buf.name = tc.function.name;
          if (tc.function?.arguments) buf.arguments += tc.function.arguments;
          partials.push({ id: buf.id, name: buf.name || undefined, arguments: tc.function?.arguments });
        }
        out.delta.toolCalls = partials;
      }

      if (usage) out.usage = usage;
      yield out;
    }
  }

  // ─── Internals ───────────────────────────────────────────────────────────

  protected buildRequestBody(request: ChatCompletionRequest, stream: boolean): Record<string, any> {
    const body: Record<string, any> = {
      model: request.model || this.defaultModel,
      messages: request.messages.map((m) => this.toOpenAIMessage(m)),
      stream,
    };

    if (stream) {
      body.stream_options = { include_usage: true };
    }
    if (request.temperature != null) body.temperature = request.temperature;
    if (request.maxTokens != null) body.max_tokens = request.maxTokens;
    if (request.topP != null) body.top_p = request.topP;
    if (request.stop) body.stop = request.stop;

    if (request.tools?.length) {
      body.tools = request.tools.map((t) => this.toOpenAITool(t));
    }

    if (request.toolChoice != null && request.tools?.length) {
      if (typeof request.toolChoice === "string") {
        body.tool_choice = request.toolChoice;
      } else {
        body.tool_choice = { type: "function", function: { name: request.toolChoice.name } };
      }
    }

    if (request.responseFormat) {
      if (request.responseFormat.type === "json_schema") {
        body.response_format = {
          type: "json_schema",
          json_schema: {
            name: request.responseFormat.name ?? "response",
            schema: request.responseFormat.schema,
            strict: true,
          },
        };
      } else if (request.responseFormat.type === "json_object") {
        body.response_format = { type: "json_object" };
      }
    }

    if (request.extra) {
      Object.assign(body, request.extra);
    }

    applyOpenAIReasoning(body, request.reasoning, "legacy_effort");

    return body;
  }

  protected toOpenAIMessage(m: UnifiedMessage): Record<string, any> {
    const msg: Record<string, any> = { role: m.role };

    if (typeof m.content === "string") {
      msg.content = m.content;
    } else if (Array.isArray(m.content)) {
      msg.content = m.content.map((part) => {
        if (part.type === "text") return { type: "text", text: part.text };
        if (part.type === "image") {
          const src = part.source;
          const url = src.type === "url" ? src.url : `data:${src.mediaType};base64,${src.data}`;
          return { type: "image_url", image_url: { url } };
        }
        return part;
      });
    }

    if (m.role === "assistant" && m.toolCalls?.length) {
      msg.tool_calls = m.toolCalls.map((tc) => ({
        id: tc.id,
        type: "function",
        function: { name: tc.name, arguments: tc.arguments },
      }));
    }

    if (m.role === "tool" && m.toolCallId) {
      msg.tool_call_id = m.toolCallId;
    }

    if (m.name) msg.name = m.name;

    return msg;
  }

  protected toOpenAITool(t: ToolDefinition): Record<string, any> {
    const fn: Record<string, any> = {
      name: t.name,
      description: t.description,
      parameters: t.parameters,
    };
    if (t.strict) {
      fn.strict = true;
    }
    return { type: "function", function: fn };
  }

  protected async doFetch(body: Record<string, any>): Promise<Response> {
    const url = `${this.baseURL}/chat/completions`;
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.apiKey}`,
        ...this.defaultHeaders,
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new ProviderError(
        `OpenAI API error ${res.status}: ${text}`,
        this.providerName,
        res.status,
        text,
      );
    }

    return res;
  }

  protected parseResponse(json: any): ChatCompletionResponse {
    const choice = json.choices?.[0];
    const message = choice?.message ?? {};

    const toolCalls: ToolCall[] = (message.tool_calls ?? []).map((tc: any) => ({
      id: tc.id,
      name: tc.function?.name ?? "",
      arguments: tc.function?.arguments ?? "{}",
    }));

    return {
      id: json.id ?? "",
      model: json.model ?? "",
      content: message.content ?? null,
      toolCalls,
      usage: this.extractUsage(json.usage),
      finishReason: mapFinishReason(choice?.finish_reason),
      raw: json,
    };
  }

  protected extractUsage(usage: any): TokenUsage {
    if (!usage) return emptyUsage();
    const promptDetails = usage.prompt_tokens_details ?? {};
    const completionDetails = usage.completion_tokens_details ?? {};
    return {
      inputTokens: usage.prompt_tokens ?? 0,
      outputTokens: usage.completion_tokens ?? 0,
      totalTokens: usage.total_tokens ?? (usage.prompt_tokens ?? 0) + (usage.completion_tokens ?? 0),
      cachedInputTokens: promptDetails.cached_tokens ?? 0,
      cachedWriteTokens: 0,
      cachedOutputTokens: 0,
      reasoningTokens: completionDetails.reasoning_tokens ?? 0,
    };
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function mapFinishReason(reason: string | null | undefined): ChatCompletionResponse["finishReason"] {
  switch (reason) {
    case "stop":
      return "stop";
    case "tool_calls":
      return "tool_calls";
    case "length":
      return "length";
    case "content_filter":
      return "content_filter";
    default:
      return "stop";
  }
}
