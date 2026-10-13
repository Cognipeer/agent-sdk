// OpenAI Chat Completions API provider.
// Direct fetch-based implementation – no SDK dependency.

import { BaseProvider } from "./base.js";
import { parseSSEStream } from "./utils/sse.js";
import { applyOpenAIReasoning } from "./utils/reasoning.js";
import { audioMimeToOpenAIFormat } from "./utils/media.js";
import { inlineJsonSchemaRefs } from "./utils/jsonSchemaRefs.js";
import { chunkArray, decodeBase64Vector, assertVectorCount, requireEmbeddingModel } from "./utils/embeddings.js";
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
  type ProviderResponseFields,
  type EmbeddingRequest,
  type EmbeddingResponse,
  ProviderError,
  emptyUsage,
} from "./types.js";

export class OpenAIProvider extends BaseProvider {
  readonly providerName: ProviderType = "openai";

  protected readonly apiKey: string;
  protected readonly baseURL: string;
  protected readonly defaultModel: string;
  protected readonly defaultHeaders: Record<string, string>;
  protected readonly responsesApi: "auto" | "never" | "always";
  // Private, and read only by OpenAIProvider itself: see the constructor.
  private readonly responsesApiModels: Array<string | RegExp>;
  private readonly responsesStreaming: boolean;
  private readonly apiExplicitChat: boolean;
  private readonly apiExplicitResponses: boolean;
  /** `api: "responses"` was passed (the legacy `responsesApi: "always"` keeps its old single-call behaviour). */
  private readonly apiResponsesNative: boolean;
  protected readonly maxTokensParam: "auto" | "max_tokens" | "max_completion_tokens";

  constructor(config: OpenAIProviderConfig) {
    super();
    this.configureTransport(config);
    this.maxTokensParam = config.maxTokensParam ?? "auto";
    this.apiKey = config.apiKey;
    this.baseURL = (config.baseURL ?? "https://api.openai.com/v1").replace(/\/$/, "");
    this.defaultModel = config.defaultModel ?? "gpt-4o";
    this.defaultHeaders = {
      ...config.defaultHeaders,
      ...(config.organization ? { "OpenAI-Organization": config.organization } : {}),
    };
    // Upstream API selection is explicit: `api` wins, then the deprecated
    // `responsesApi` alias; with neither set every request is Chat Completions.
    // Nothing is inferred from a model name unless `responsesApi: "auto"` is
    // passed on purpose.
    const legacy = config.responsesApi;
    this.responsesApi = config.api === "responses" ? "always"
      : config.api === "chat" ? "never"
      : legacy ?? "never";
    this.apiExplicitChat = config.api === "chat" || (config.api === undefined && legacy === "never");
    this.apiExplicitResponses = this.responsesApi === "always";
    this.apiResponsesNative = config.api === "responses";
    this.responsesApiModels = [...(config.responsesApiModels ?? [])];
    this.responsesStreaming = config.responsesStreaming ?? this.apiResponsesNative;
    if (config.retry) this.retryPolicy = { ...this.retryPolicy, ...config.retry };
  }

  /** True when the caller listed this request's model in `responsesApiModels`. */
  private isResponsesApiModel(request: ChatCompletionRequest): boolean {
    if (this.responsesApiModels.length === 0) return false;
    const model = request.model || this.defaultModel;
    return this.responsesApiModels.some((entry) => {
      if (typeof entry === "string") return entry === model;
      entry.lastIndex = 0; // a /g or /y pattern would otherwise carry state between calls
      return entry.test(model);
    });
  }

  /** True when this request should go to the Responses API rather than Chat
   * Completions — which exposes `reasoning.effort` and reasoning summaries that
   * Chat Completions silently drops.
   *
   * `auto` (the default) keeps the historical rule: only when the request
   * carries a reasoning config AND the model name looks like an o-series/gpt-5
   * model. `never`/`always` let a caller state the answer instead, because the
   * name check is a guess and the two APIs differ in far more than reasoning —
   * see `responsesApi` in OpenAIProviderConfig.
   *
   * A model listed in `responsesApiModels` is the caller stating the answer
   * for that model alone; `never` still overrides it. */
  protected useResponsesApi(request: ChatCompletionRequest): boolean {
    if (this.apiExplicitChat) return false;
    if (this.apiExplicitResponses) return true;
    if (this.isResponsesApiModel(request)) return true;
    if (this.responsesApi !== "auto") return false;
    if (!request.reasoning) return false;
    return isReasoningModel(request.model || this.defaultModel);
  }

  async complete(request: ChatCompletionRequest): Promise<ChatCompletionResponse> {
    if (this.useResponsesApi(request)) {
      return this.completeResponses(request);
    }
    const body = this.buildRequestBody(request, false);
    const res = await this.doFetch(body, request.signal);
    const json = await res.json();
    return this.parseResponse(json);
  }

  async *completeStream(request: ChatCompletionRequest): AsyncGenerator<ChatCompletionChunk, void, unknown> {
    if (this.useResponsesApi(request)) {
      if (this.responsesStreaming && (this.apiResponsesNative || this.isResponsesApiModel(request))) {
        yield* this.streamResponses(request);
        return;
      }
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
    const res = await this.doFetch(body, request.signal);

    if (!res.body) throw new ProviderError("No response body for stream", this.providerName);

    let id = "";
    let model = "";
    const toolCallBuffers = new Map<number, { id: string; name: string; arguments: string }>();
    let usage: TokenUsage | undefined;

    for await (const event of parseSSEStream(res.body, request.signal)) {
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
      if (typeof choice.finish_reason === "string") out.rawFinishReason = choice.finish_reason;
      const fields = pickProviderFields(chunk, delta, choice);
      if (fields) out.providerFields = fields;

      if (delta.content) {
        out.delta.content = delta.content;
      }

      const reasoningDelta = extractReasoningText(delta);
      if (reasoningDelta) out.delta.reasoning = { summary: reasoningDelta };

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
          partials.push({ id: buf.id, name: buf.name || undefined, arguments: tc.function?.arguments, index: idx });
        }
        out.delta.toolCalls = partials;
      }

      if (usage) out.usage = usage;
      yield out;
    }
  }

  // ─── Embeddings ──────────────────────────────────────────────────────────

  /** POST /embeddings, batched (default 2048 inputs per request, the OpenAI cap). */
  override async embed(request: EmbeddingRequest): Promise<EmbeddingResponse> {
    const model = requireEmbeddingModel(this.providerName, request.model);
    const batches = chunkArray(request.input, request.batchSize ?? 2048);
    const vectors: number[][] = [];
    const raw: any[] = [];
    let inputTokens = 0;
    let totalTokens = 0;
    let responseModel = model;

    for (const batch of batches) {
      const body: Record<string, any> = { model, input: batch };
      if (request.dimensions != null) body.dimensions = request.dimensions;
      if (request.encodingFormat) body.encoding_format = request.encodingFormat;
      if (request.extra) Object.assign(body, request.extra);
      const res = await this.embeddingsFetch(body, request.signal);
      const json: any = await res.json();
      raw.push(json);
      const data: any[] = Array.isArray(json.data) ? [...json.data] : [];
      // `index` is authoritative when present; some servers return out of order.
      data.sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
      for (const d of data) {
        vectors.push(typeof d.embedding === "string" ? decodeBase64Vector(d.embedding) : d.embedding);
      }
      inputTokens += json.usage?.prompt_tokens ?? 0;
      totalTokens += json.usage?.total_tokens ?? json.usage?.prompt_tokens ?? 0;
      responseModel = json.model ?? responseModel;
    }

    assertVectorCount(this.providerName, vectors, request.input.length);
    return { model: responseModel, vectors, usage: { inputTokens, totalTokens }, raw };
  }

  protected async embeddingsFetch(body: Record<string, any>, signal?: AbortSignal): Promise<Response> {
    const url = `${this.baseURL}/embeddings`;
    const headers = {
      "Content-Type": "application/json",
      Authorization: `Bearer ${this.apiKey}`,
      ...this.defaultHeaders,
    };
    const payload = JSON.stringify(body);
    const res = await this.doFetchWithRetry(() => this.httpFetch(url, { method: "POST", headers, body: payload, signal }), signal);
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new ProviderError(`OpenAI embeddings API error ${res.status}: ${text}`, this.providerName, res.status, text);
    }
    return res;
  }

  // ─── Internals ───────────────────────────────────────────────────────────

  protected buildRequestBody(request: ChatCompletionRequest, stream: boolean): Record<string, any> {
    const body: Record<string, any> = {
      model: request.model || this.defaultModel,
      messages: request.messages.map((m) => this.toOpenAIMessage(m)),
      stream,
    };

    if (stream && request.streamUsage !== false) {
      body.stream_options = { include_usage: true };
    }
    const modelId = String(body.model);
    // Reasoning models (o-series, gpt-5) reject sampling overrides.
    const reasoningModel = isReasoningModel(modelId) && !/chat/i.test(modelId);
    if (request.temperature != null && !reasoningModel) body.temperature = request.temperature;
    if (request.maxTokens != null) {
      const useCompletionTokens =
        this.maxTokensParam === "max_completion_tokens" ||
        (this.maxTokensParam === "auto" && isReasoningModel(modelId));
      body[useCompletionTokens ? "max_completion_tokens" : "max_tokens"] = request.maxTokens;
    }
    if (request.topP != null && !reasoningModel) body.top_p = request.topP;
    if (request.stop) body.stop = request.stop;
    if (request.presencePenalty != null) body.presence_penalty = request.presencePenalty;
    if (request.frequencyPenalty != null) body.frequency_penalty = request.frequencyPenalty;
    if (request.seed != null) body.seed = request.seed;
    if (request.n != null) body.n = request.n;
    if (request.logprobs != null) body.logprobs = request.logprobs;
    if (request.topLogprobs != null) body.top_logprobs = request.topLogprobs;

    if (request.tools?.length) {
      body.tools = request.tools.map((t) => this.toOpenAITool(t));
      if (request.parallelToolCalls != null) body.parallel_tool_calls = request.parallelToolCalls;
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
    if (this.apiResponsesNative || this.isResponsesApiModel(request)) adaptChatExtrasForResponses(body, request.extra);
    const res = await this.responsesFetch(body, request.signal);
    const json = await res.json();
    return this.parseResponsesResponse(json, request.model || this.defaultModel);
  }

  /** Real Responses SSE streaming, for models opted in through
   * `responsesApiModels` with `responsesStreaming` on. Emits the same chunk
   * shapes as the Chat Completions stream: text deltas as they arrive, a tool
   * call's id + name when it opens and its argument fragments under that id,
   * then one final chunk with usage, finish reason and any reasoning summary
   * (taken from the completed response, exactly as the non-streaming parse
   * reads it). */
  private async *streamResponses(request: ChatCompletionRequest): AsyncGenerator<ChatCompletionChunk, void, unknown> {
    const modelId = request.model || this.defaultModel;
    const body = this.buildResponsesBody(request);
    adaptChatExtrasForResponses(body, request.extra);
    body.stream = true;
    const res = await this.responsesFetch(body, request.signal);

    if (!res.body) throw new ProviderError("No response body for stream", this.providerName);

    let id = "";
    let model = modelId;
    // Keyed by output item id: argument deltas name the item, not the call.
    const calls = new Map<string, { callId: string; name: string; arguments: string }>();
    let final: ChatCompletionResponse | undefined;
    let streamedSummary = false;

    for await (const event of parseSSEStream(res.body, request.signal)) {
      if (event.data === "[DONE]") break;

      let data: any;
      try {
        data = JSON.parse(event.data);
      } catch {
        continue;
      }

      switch (data.type ?? event.event) {
        case "response.created":
        case "response.in_progress":
          id = data.response?.id ?? id;
          model = data.response?.model ?? model;
          break;

        case "response.output_text.delta":
          if (data.delta) yield { id, model, delta: { content: data.delta } };
          break;

        case "response.reasoning_summary_text.delta":
          if (typeof data.delta === "string" && data.delta) {
            streamedSummary = true;
            yield { id, model, delta: { reasoning: { summary: data.delta } } };
          }
          break;

        case "response.output_item.added": {
          const item = data.item;
          if (item?.type !== "function_call") break;
          const call = { callId: item.call_id ?? item.id ?? "", name: item.name ?? "", arguments: item.arguments ?? "" };
          calls.set(item.id ?? call.callId, call);
          yield { id, model, delta: { toolCalls: [{ id: call.callId, name: call.name, arguments: call.arguments }] } };
          break;
        }

        case "response.function_call_arguments.delta": {
          const call = calls.get(data.item_id);
          if (!call || !data.delta) break;
          call.arguments += data.delta;
          yield { id, model, delta: { toolCalls: [{ id: call.callId, arguments: data.delta }] } };
          break;
        }

        case "response.output_item.done": {
          // A server that sends a call's arguments only once it is complete
          // (or never announced it): emit whatever the deltas did not carry.
          const item = data.item;
          if (item?.type !== "function_call") break;
          const full = typeof item.arguments === "string" ? item.arguments : "";
          const call = calls.get(item.id ?? item.call_id);
          if (!call) {
            const added = { callId: item.call_id ?? item.id ?? "", name: item.name ?? "", arguments: full };
            calls.set(item.id ?? added.callId, added);
            yield { id, model, delta: { toolCalls: [{ id: added.callId, name: added.name, arguments: full }] } };
          } else if (full.length > call.arguments.length && full.startsWith(call.arguments)) {
            const rest = full.slice(call.arguments.length);
            call.arguments = full;
            yield { id, model, delta: { toolCalls: [{ id: call.callId, arguments: rest }] } };
          }
          break;
        }

        case "response.completed":
        case "response.incomplete":
          final = this.parseResponsesResponse(data.response ?? {}, modelId);
          break;

        case "response.failed":
        case "error": {
          const err = data.response?.error ?? data.error ?? data;
          throw new ProviderError(
            `OpenAI Responses API stream error: ${err?.message ?? "unknown error"}`,
            this.providerName,
            undefined,
            data,
          );
        }
      }
    }

    yield {
      id: final?.id || id,
      model: final?.model || model,
      // Summary text already went out as deltas; do not repeat it.
      delta: final?.reasoning && !streamedSummary ? { reasoning: final.reasoning } : {},
      usage: final?.usage,
      finishReason: final?.finishReason ?? (calls.size > 0 ? "tool_calls" : "stop"),
    };
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
            schema: inlineJsonSchemaRefs(request.responseFormat.schema),
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

  protected async responsesFetch(body: Record<string, any>, signal?: AbortSignal): Promise<Response> {
    // Expand assistant-with-calls markers into discrete input items.
    body.input = expandResponsesInput(body.input);
    const url = `${this.baseURL}/responses`;
    const headers = {
      "Content-Type": "application/json",
      Authorization: `Bearer ${this.apiKey}`,
      ...this.defaultHeaders,
    };
    const payload = JSON.stringify(body);
    const res = await this.doFetchWithRetry(() => this.httpFetch(url, { method: "POST", headers, body: payload, signal }), signal);
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

  protected async doFetch(body: Record<string, any>, signal?: AbortSignal): Promise<Response> {
    const url = `${this.baseURL}/chat/completions`;
    const headers = {
      "Content-Type": "application/json",
      Authorization: `Bearer ${this.apiKey}`,
      ...this.defaultHeaders,
    };
    const payload = JSON.stringify(body);
    const res = await this.doFetchWithRetry(() => this.httpFetch(url, { method: "POST", headers, body: payload, signal }), signal);

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

    const reasoningText = extractReasoningText(message);

    const providerFields = pickProviderFields(json, message, choice);
    return {
      id: json.id ?? "",
      model: json.model ?? "",
      content: message.content ?? null,
      toolCalls,
      usage: this.extractUsage(json.usage),
      finishReason: mapFinishReason(choice?.finish_reason),
      ...(typeof choice?.finish_reason === "string" ? { rawFinishReason: choice.finish_reason } : {}),
      ...(providerFields ? { providerFields } : {}),
      ...(reasoningText ? { reasoning: { summary: reasoningText } } : {}),
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

/** Reasoning text as OpenAI-compatible servers spell it: `reasoning_content`
 * (DeepSeek, vLLM, Together) or `reasoning` (OpenRouter, newer vLLM). */
function extractReasoningText(src: any): string | undefined {
  if (!src || typeof src !== "object") return undefined;
  for (const key of ["reasoning_content", "reasoning"]) {
    const v = src[key];
    if (typeof v === "string" && v.length > 0) return v;
  }
  return undefined;
}

/** Response fields with no slot in the unified shape, kept when present:
 * top-level `system_fingerprint` / `service_tier`, the message's (or stream
 * delta's) `refusal` / `annotations`, and the choice's `logprobs`. */
function pickProviderFields(top: any, message: any, choice: any): ProviderResponseFields | undefined {
  const out: ProviderResponseFields = {};
  if (top?.system_fingerprint != null) out.system_fingerprint = top.system_fingerprint;
  if (top?.service_tier != null) out.service_tier = top.service_tier;
  if (message?.annotations != null) out.annotations = message.annotations;
  if (message?.refusal != null) out.refusal = message.refusal;
  if (choice?.logprobs != null) out.logprobs = choice.logprobs;
  return Object.keys(out).length > 0 ? out : undefined;
}

/** Detects OpenAI reasoning models (o-series and gpt-5 family). */
export function isReasoningModel(model: string | undefined): boolean {
  if (!model) return false;
  const m = model.toLowerCase();
  return /(^|[/_-])o[0-9]/.test(m) || m.startsWith("o1") || m.startsWith("o3") || m.startsWith("o4")
    || m.includes("gpt-5") || m.includes("gpt5");
}

/** Re-spells Chat Completions fields that arrived through `extra` into their
 * Responses equivalents. Each one below is rejected by /responses with a 400
 * that names the new spelling (measured on Azure /openai/v1), so passing it
 * through can only fail. Values are carried unchanged.
 *
 *  reasoning_effort            → reasoning.effort (a request `reasoning` effort wins)
 *  max_tokens, max_completion_tokens → max_output_tokens
 *  response_format             → text.format
 *  stream_options.include_usage → dropped (usage always arrives on response.completed)
 *
 * As on the chat path, `extra` wins over what the SDK built from the request,
 * unless `extra` also names the Responses field itself. Keys /responses does
 * not know at all (vLLM's `guided_json`, …) are left alone. Used only for
 * `responsesApiModels`. */
function adaptChatExtrasForResponses(body: Record<string, any>, extra: Record<string, any> | undefined): void {
  const native = extra ?? {};

  if ("reasoning_effort" in body) {
    const effort = body.reasoning_effort;
    delete body.reasoning_effort;
    if (effort != null) {
      const reasoning = body.reasoning && typeof body.reasoning === "object" ? body.reasoning : {};
      if (reasoning.effort == null) body.reasoning = { ...reasoning, effort };
    }
  }

  for (const key of ["max_tokens", "max_completion_tokens"]) {
    if (!(key in body)) continue;
    const value = body[key];
    delete body[key];
    if (value != null && !("max_output_tokens" in native)) body.max_output_tokens = value;
  }

  if ("response_format" in body) {
    const format = toResponsesTextFormat(body.response_format);
    delete body.response_format;
    if (format && !("text" in native)) body.text = { ...body.text, format };
  }

  if (body.stream_options && typeof body.stream_options === "object" && "include_usage" in body.stream_options) {
    const { include_usage: _dropped, ...rest } = body.stream_options;
    if (Object.keys(rest).length > 0) body.stream_options = rest;
    else delete body.stream_options;
  }
}

/** Chat Completions `response_format` → Responses `text.format`. */
function toResponsesTextFormat(rf: any): Record<string, any> | undefined {
  if (!rf || typeof rf !== "object") return undefined;
  if (rf.type === "json_schema") {
    const js = rf.json_schema ?? {};
    return {
      type: "json_schema",
      name: js.name ?? "response",
      schema: inlineJsonSchemaRefs(js.schema),
      ...(js.description != null ? { description: js.description } : {}),
      ...(js.strict != null ? { strict: js.strict } : {}),
    };
  }
  if (rf.type === "json_object" || rf.type === "text") return { type: rf.type };
  return undefined;
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
