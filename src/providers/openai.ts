// OpenAI Chat Completions API provider.
// Direct fetch-based implementation – no SDK dependency.

import { BaseProvider } from "./base.js";
import { parseSSEStream } from "./utils/sse.js";
import { applyOpenAIReasoning } from "./utils/reasoning.js";
import { audioMimeToOpenAIFormat } from "./utils/media.js";
import {
  type ChatCompletionRequest,
  type ChatCompletionResponse,
  type ChatCompletionChunk,
  type ToolCall,
  type TokenUsage,
  type UnifiedMessage,
  type ContentPart,
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
    if (config.retry) this.retryPolicy = { ...this.retryPolicy, ...config.retry };
  }

  /** True when the request targets a reasoning model (o-series / gpt-5) so we
   * should route through the Responses API, which exposes `reasoning.effort`
   * and reasoning summaries. Chat Completions silently drops these. */
  protected useResponsesApi(request: ChatCompletionRequest): boolean {
    if (!request.reasoning) return false;
    return isReasoningModel(request.model || this.defaultModel);
  }

  async complete(request: ChatCompletionRequest): Promise<ChatCompletionResponse> {
    if (this.useResponsesApi(request)) {
      return this.completeResponses(request);
    }
    const body = this.buildRequestBody(request, false);
    const res = await this.doFetch(body);
    const json = await res.json();
    return this.parseResponse(json);
  }

  async *completeStream(request: ChatCompletionRequest): AsyncGenerator<ChatCompletionChunk, void, unknown> {
    if (this.useResponsesApi(request)) {
      // Responses streaming uses a distinct SSE event protocol; for reasoning
      // models we issue a single non-streaming call and emit one final chunk
      // so reasoning summary + usage are preserved.
      const response = await this.completeResponses(request);
      yield {
        id: response.id,
        model: response.model,
        delta: {
          content: response.content ?? undefined,
          toolCalls: response.toolCalls.length > 0 ? response.toolCalls : undefined,
          reasoning: response.reasoning,
        },
        usage: response.usage,
        finishReason: response.finishReason,
      };
      return;
    }
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

  // ─── Responses API (reasoning models) ──────────────────────────────────────

  protected async completeResponses(request: ChatCompletionRequest): Promise<ChatCompletionResponse> {
    const body = this.buildResponsesBody(request);
    const res = await this.responsesFetch(body);
    const json = await res.json();
    return this.parseResponsesResponse(json, request.model || this.defaultModel);
  }

  protected buildResponsesBody(request: ChatCompletionRequest): Record<string, any> {
    const body: Record<string, any> = {
      model: request.model || this.defaultModel,
      input: request.messages.map((m) => this.toResponsesInput(m)),
    };

    if (request.maxTokens != null) body.max_output_tokens = request.maxTokens;
    if (request.topP != null) body.top_p = request.topP;
    // Reasoning models reject `temperature`; omit it intentionally.

    if (request.tools?.length) {
      // Responses tools are flat function objects (not nested under `function`).
      body.tools = request.tools.map((t) => ({
        type: "function",
        name: t.name,
        description: t.description,
        parameters: t.parameters,
        ...(t.strict ? { strict: true } : {}),
      }));
    }

    if (request.toolChoice != null && request.tools?.length) {
      if (typeof request.toolChoice === "string") {
        body.tool_choice = request.toolChoice;
      } else {
        body.tool_choice = { type: "function", name: request.toolChoice.name };
      }
    }

    if (request.responseFormat) {
      if (request.responseFormat.type === "json_schema") {
        body.text = {
          format: {
            type: "json_schema",
            name: request.responseFormat.name ?? "response",
            schema: request.responseFormat.schema,
            strict: true,
          },
        };
      } else if (request.responseFormat.type === "json_object") {
        body.text = { format: { type: "json_object" } };
      }
    }

    if (request.extra) Object.assign(body, request.extra);

    // reasoning.effort + reasoning.summary
    applyOpenAIReasoning(body, request.reasoning, "responses");

    return body;
  }

  /** Maps a unified message to a Responses API `input` item. */
  protected toResponsesInput(m: UnifiedMessage): Record<string, any> {
    // Tool result → function_call_output
    if (m.role === "tool" && m.toolCallId) {
      const output = typeof m.content === "string" ? m.content : JSON.stringify(m.content);
      return { type: "function_call_output", call_id: m.toolCallId, output };
    }

    // Assistant with tool calls → emit function_call items. The Responses API
    // expects each call as its own input item; when there is also text we keep
    // it as a separate message item.
    if (m.role === "assistant" && m.toolCalls?.length) {
      // Caller flattens arrays; return the function_call list wrapped so the
      // body builder can splice. We return a single item array marker instead.
      // To keep the 1:1 map contract, encode tool calls as a message with an
      // attached __calls field that buildResponsesBody expands.
      return {
        __assistantWithCalls: true,
        text: typeof m.content === "string" ? m.content : "",
        calls: m.toolCalls.map((tc) => ({
          type: "function_call",
          call_id: tc.id,
          name: tc.name,
          arguments: tc.arguments,
        })),
      };
    }

    const role = m.role === "system" ? "system" : m.role === "assistant" ? "assistant" : "user";
    const textType = role === "assistant" ? "output_text" : "input_text";
    if (typeof m.content === "string") {
      return { role, content: [{ type: textType, text: m.content }] };
    }
    const content = (m.content as ContentPart[]).map((part) => {
      if (part.type === "text") return { type: textType, text: part.text };
      if (part.type === "image") {
        const src = part.source;
        const url = src.type === "url" ? src.url : `data:${src.mediaType};base64,${src.data}`;
        return { type: "input_image", image_url: url };
      }
      if (part.type === "file") {
        const src = part.source;
        if (src.type === "base64") {
          return {
            type: "input_file",
            filename: part.fileName ?? "file",
            file_data: `data:${src.mediaType};base64,${src.data}`,
          };
        }
        return { type: "input_file", file_url: src.url };
      }
      if (part.type === "audio") {
        const src = part.source;
        if (src.type === "base64") {
          return {
            type: "input_audio",
            input_audio: { data: src.data, format: audioMimeToOpenAIFormat(src.mediaType) },
          };
        }
        return { type: textType, text: `[audio: ${src.url}]` };
      }
      return { type: textType, text: "" };
    });
    return { role, content };
  }

  protected async responsesFetch(body: Record<string, any>): Promise<Response> {
    // Expand assistant-with-calls markers into discrete input items.
    body.input = expandResponsesInput(body.input);
    const url = `${this.baseURL}/responses`;
    const headers = {
      "Content-Type": "application/json",
      Authorization: `Bearer ${this.apiKey}`,
      ...this.defaultHeaders,
    };
    const payload = JSON.stringify(body);
    const res = await this.doFetchWithRetry(() => fetch(url, { method: "POST", headers, body: payload }));
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new ProviderError(
        `OpenAI Responses API error ${res.status}: ${text}`,
        this.providerName,
        res.status,
        text,
      );
    }
    return res;
  }

  protected parseResponsesResponse(json: any, modelId: string): ChatCompletionResponse {
    const textParts: string[] = [];
    const toolCalls: ToolCall[] = [];
    const summaryParts: string[] = [];

    for (const item of json.output ?? []) {
      if (item.type === "message") {
        for (const c of item.content ?? []) {
          if (c.type === "output_text" && typeof c.text === "string") textParts.push(c.text);
        }
      } else if (item.type === "function_call") {
        toolCalls.push({
          id: item.call_id ?? item.id ?? "",
          name: item.name ?? "",
          arguments: typeof item.arguments === "string" ? item.arguments : JSON.stringify(item.arguments ?? {}),
        });
      } else if (item.type === "reasoning") {
        for (const s of item.summary ?? []) {
          if (typeof s.text === "string") summaryParts.push(s.text);
        }
      }
    }

    // Fallback: top-level output_text convenience field.
    if (textParts.length === 0 && typeof json.output_text === "string") {
      textParts.push(json.output_text);
    }

    const usage = json.usage ?? {};
    const reasoningTokens = usage.output_tokens_details?.reasoning_tokens ?? 0;
    const tokenUsage: TokenUsage = {
      inputTokens: usage.input_tokens ?? 0,
      outputTokens: usage.output_tokens ?? 0,
      totalTokens: usage.total_tokens ?? (usage.input_tokens ?? 0) + (usage.output_tokens ?? 0),
      cachedInputTokens: usage.input_tokens_details?.cached_tokens ?? 0,
      cachedWriteTokens: 0,
      cachedOutputTokens: 0,
      reasoningTokens,
    };

    const finishReason: ChatCompletionResponse["finishReason"] = toolCalls.length > 0
      ? "tool_calls"
      : json.status === "incomplete" ? "length" : "stop";

    return {
      id: json.id ?? "",
      model: json.model ?? modelId,
      content: textParts.join("") || null,
      toolCalls,
      usage: tokenUsage,
      finishReason,
      reasoning: summaryParts.length > 0 ? { summary: summaryParts.join("\n").trim() || undefined } : undefined,
      raw: json,
    };
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
        if (part.type === "file") {
          const src = part.source;
          if (src.type === "base64") {
            return {
              type: "file",
              file: {
                filename: part.fileName ?? "file",
                file_data: `data:${src.mediaType};base64,${src.data}`,
              },
            };
          }
          // Chat Completions has no URL file source; keep the reference visible.
          return { type: "text", text: `[file: ${src.url}]` };
        }
        if (part.type === "audio") {
          const src = part.source;
          if (src.type === "base64") {
            return {
              type: "input_audio",
              input_audio: { data: src.data, format: audioMimeToOpenAIFormat(src.mediaType) },
            };
          }
          return { type: "text", text: `[audio: ${src.url}]` };
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
    const headers = {
      "Content-Type": "application/json",
      Authorization: `Bearer ${this.apiKey}`,
      ...this.defaultHeaders,
    };
    const payload = JSON.stringify(body);
    const res = await this.doFetchWithRetry(() => fetch(url, { method: "POST", headers, body: payload }));

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

/** Detects OpenAI reasoning models (o-series and gpt-5 family). */
export function isReasoningModel(model: string | undefined): boolean {
  if (!model) return false;
  const m = model.toLowerCase();
  return /(^|[/_-])o[0-9]/.test(m) || m.startsWith("o1") || m.startsWith("o3") || m.startsWith("o4")
    || m.includes("gpt-5") || m.includes("gpt5");
}

/** Expands assistant-with-tool-call markers produced by toResponsesInput into
 * the flat Responses `input` item list (optional message text + function_call
 * items in order). */
function expandResponsesInput(input: any[]): any[] {
  const out: any[] = [];
  for (const item of input) {
    if (item && item.__assistantWithCalls) {
      if (item.text) {
        out.push({ role: "assistant", content: [{ type: "output_text", text: item.text }] });
      }
      for (const call of item.calls) out.push(call);
    } else {
      out.push(item);
    }
  }
  return out;
}

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
