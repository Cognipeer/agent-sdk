// OpenAI Chat Completions API provider.
// Direct fetch-based implementation – no SDK dependency.

import { BaseProvider } from "./base.js";
import { parseSSEStream } from "./utils/sse.js";
import { applyOpenAIReasoning } from "./utils/reasoning.js";
import { resolveModelRule, allowsSampling, applyDropParams, type ResolvedModelRule, type RulePatch } from "../models/rules.js";
import { runWithModelAdjustments, parseModelError } from "../models/adjust.js";
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
  type ReasoningBlock,
  type ReasoningPayload,
  type EmbeddingRequest,
  type EmbeddingResponse,
  ProviderError,
  emptyUsage,
} from "./types.js";

/** A Responses `reasoning` output item, as far as this file reads it. */
type ResponsesReasoningItem = {
  type?: string;
  id?: string;
  summary?: Array<{ type?: string; text?: string }>;
  content?: unknown[] | null;
  encrypted_content?: string | null;
  [key: string]: unknown;
};

/**
 * A Responses reasoning item kept on `reasoning.blocks` so the next call of the
 * same tool loop can hand it back (see `captureReasoningBlocks`). It is typed
 * `thinking` with no `signature`, which Anthropic / Bedrock replay skips, and
 * carries the item under `openaiResponses`:
 *  - `item`    the output item as the API returned it (`encrypted_content` is what makes it replayable)
 *  - `origin`  provider | endpoint | model that produced it; the blob only decrypts for that account
 *  - `next`    what followed it in the output (`"message"`, or `call:<call_id>`): it must go back right before that item
 *  - `nextId`  the `id` of that function call item (`fc_…`), for an endpoint that wants the pair back with its ids (Azure)
 */
export type ResponsesReasoningBlock = ReasoningBlock & {
  openaiResponses: { item: ResponsesReasoningItem; origin: string; next: string; nextId?: string };
};

/** What `toResponsesInput` hands `expandResponsesInput` for a replayed reasoning item (`nextId`: see `ResponsesReasoningBlock`). */
type ReplayedReasoning = { next: string; item: Record<string, any>; nextId?: string };

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
  /** Origins (see `responsesOrigin`) whose endpoint refused a replayed reasoning item: not replayed again by this instance. */
  private readonly reasoningReplayRefused = new Set<string>();

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
    // Upstream API selection: `api` "chat" / "responses" are explicit choices;
    // "auto" (the default, and what 0.11 did) keeps the model-name heuristic,
    // unless the deprecated `responsesApi` alias states otherwise.
    const legacy = config.responsesApi;
    const explicit = config.api === "chat" || config.api === "responses" ? config.api : undefined;
    this.responsesApi = explicit === "responses" ? "always"
      : explicit === "chat" ? "never"
      : legacy ?? (config._autoMeansChat ? "never" : "auto");
    this.apiExplicitChat = explicit === "chat" || (explicit === undefined && legacy === "never");
    this.apiExplicitResponses = this.responsesApi === "always";
    this.apiResponsesNative = explicit === "responses";
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
    const res = await this.fetchChat(request, false);
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
        ...(response.rawFinishReason ? { rawFinishReason: response.rawFinishReason } : {}),
      };
      return;
    }
    const res = await this.fetchChat(request, true);

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
      const out: ChatCompletionChunk = { id, model, delta: {} };
      // Only the chunk that carries a finish reason sets one: a null is "still
      // generating", not a "stop" (a consumer keeps the last finish reason it saw).
      if (typeof choice.finish_reason === "string") {
        out.finishReason = mapFinishReason(choice.finish_reason);
        out.rawFinishReason = choice.finish_reason;
      }
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

  /** Chat Completions call that corrects itself from the provider's own 400s (see models/adjust.ts). */
  private fetchChat(request: ChatCompletionRequest, stream: boolean): Promise<Response> {
    const model = request.model || this.defaultModel;
    return runWithModelAdjustments({
      provider: this.providerName,
      model,
      endpoint: "chat",
      scope: this.baseURL,
      callerParams: request.extra ? Object.keys(request.extra) : undefined,
      onLearned: this.onModelRuleLearned,
      run: (overlay, guard) => {
        const body = this.buildRequestBody(request, stream, overlay);
        guard(body);
        return this.doFetch(body, request.signal);
      },
    });
  }

  /**
   * Same for the Responses API. Replaying reasoning items is an optimisation and
   * must never break a call: when the endpoint answers a request that carries
   * them with a 400 no model adjustment explains, the request goes out once more
   * without them, and when that one succeeds they are not replayed to that origin again.
   */
  private fetchResponses(request: ChatCompletionRequest, adaptExtras: boolean, stream = false): Promise<Response> {
    const model = request.model || this.defaultModel;
    return runWithModelAdjustments({
      provider: this.providerName,
      model,
      endpoint: "responses",
      scope: this.baseURL,
      callerParams: request.extra ? Object.keys(request.extra) : undefined,
      onLearned: this.onModelRuleLearned,
      run: async (overlay, guard) => {
        const build = (replayReasoning: boolean) => {
          const body = this.buildResponsesBody(request, overlay, { replayReasoning });
          if (adaptExtras) adaptChatExtrasForResponses(body, request.extra);
          if (stream) body.stream = true;
          guard(body);
          return body;
        };
        const body = build(true);
        const replayed = hasReplayedReasoning(body.input); // before `responsesFetch` flattens `input`
        try {
          return await this.responsesFetch(body, request.signal);
        } catch (err) {
          if (!replayed || request.signal?.aborted || !isUnexplainedBadRequest(err)) throw err;
          const res = await this.responsesFetch(build(false), request.signal);
          this.reasoningReplayRefused.add(this.responsesOrigin(model));
          return res;
        }
      },
    });
  }

  protected buildRequestBody(request: ChatCompletionRequest, stream: boolean, overlay?: RulePatch): Record<string, any> {
    const body: Record<string, any> = {
      model: request.model || this.defaultModel,
      messages: request.messages.map((m) => this.toOpenAIMessage(m)),
      stream,
    };

    if (stream && request.streamUsage !== false) {
      body.stream_options = { include_usage: true };
    }
    const modelId = String(body.model);
    // What the model accepts (sampling, token-limit field, reasoning values)
    // comes from its rule in model-rules.json, plus anything learned from 400s.
    const rule = resolveModelRule({ provider: this.providerName, model: modelId, patch: overlay, scope: this.baseURL });
    if (request.temperature != null && allowsSampling(rule, "temperature", request.temperature)) body.temperature = request.temperature;
    if (request.maxTokens != null) {
      const param = this.maxTokensParam === "auto" ? rule.maxTokensParam : this.maxTokensParam;
      body[param] = request.maxTokens;
    }
    if (request.topP != null && allowsSampling(rule, "topP")) body.top_p = request.topP;
    if (request.stop) body.stop = request.stop;
    if (request.presencePenalty != null && allowsSampling(rule, "presencePenalty")) body.presence_penalty = request.presencePenalty;
    if (request.frequencyPenalty != null && allowsSampling(rule, "frequencyPenalty")) body.frequency_penalty = request.frequencyPenalty;
    if (request.seed != null) body.seed = request.seed;
    if (request.n != null) body.n = request.n;
    if (request.logprobs != null && allowsSampling(rule, "logprobs")) body.logprobs = request.logprobs;
    if (request.topLogprobs != null && allowsSampling(rule, "logprobs")) body.top_logprobs = request.topLogprobs;

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

    applyOpenAIReasoning(body, request.reasoning, "legacy_effort", modelId, rule);

    // Function tools + a reasoning effort is a 400 on Chat Completions for these
    // models (and their default effort is not `none`): say `none` explicitly.
    if (body.tools?.length && rule.chatTools.reasoning === "force-none" && rule.reasoning.style !== "none") {
      body.reasoning_effort = "none";
    }
    applyDropParams(body, rule);

    return body;
  }

  // ─── Responses API (reasoning models) ──────────────────────────────────────

  protected async completeResponses(request: ChatCompletionRequest): Promise<ChatCompletionResponse> {
    const adapt = this.apiResponsesNative || this.isResponsesApiModel(request);
    const res = await this.fetchResponses(request, adapt);
    const json = await res.json();
    return this.parseResponsesResponse(json, request.model || this.defaultModel);
  }

  /** Real Responses SSE streaming, for models opted in through
   * `responsesApiModels` with `responsesStreaming` on. Emits the same chunk
   * shapes as the Chat Completions stream: text deltas as they arrive, a tool
   * call's id + name when it opens and its argument fragments under that id,
   * then one final chunk with usage, finish reason, any reasoning summary and
   * the reasoning blocks to replay (taken from the completed response, exactly
   * as the non-streaming parse reads them). A stream that ends without
   * `response.completed` is an error, not a clean stop. */
  private async *streamResponses(request: ChatCompletionRequest): AsyncGenerator<ChatCompletionChunk, void, unknown> {
    const modelId = request.model || this.defaultModel;
    const res = await this.fetchResponses(request, true, true);

    if (!res.body) throw new ProviderError("No response body for stream", this.providerName);

    let id = "";
    let model = modelId;
    // Keyed by output item id: argument deltas name the item, not the call.
    const calls = new Map<string, { callId: string; name: string; arguments: string; index: number }>();
    let final: ChatCompletionResponse | undefined;
    let streamedSummary = false;
    // Every finished output item, in order: the source of the reasoning blocks when the completed event carries no output.
    const doneItems: any[] = [];

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

        case "response.reasoning_summary_part.added":
          if (streamedSummary) yield { id, model, delta: { reasoning: { summary: "\n\n" } } };
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
          const call = { callId: item.call_id ?? item.id ?? "", name: item.name ?? "", arguments: item.arguments ?? "", index: calls.size };
          calls.set(item.id ?? call.callId, call);
          yield { id, model, delta: { toolCalls: [{ id: call.callId, name: call.name, arguments: call.arguments, index: call.index }] } };
          break;
        }

        case "response.function_call_arguments.delta": {
          const call = calls.get(data.item_id);
          if (!call || !data.delta) break;
          call.arguments += data.delta;
          yield { id, model, delta: { toolCalls: [{ id: call.callId, arguments: data.delta, index: call.index }] } };
          break;
        }

        case "response.output_item.done": {
          // A server that sends a call's arguments only once it is complete
          // (or never announced it): emit whatever the deltas did not carry.
          const item = data.item;
          if (item && typeof item === "object") doneItems.push(item);
          if (item?.type !== "function_call") break;
          const full = typeof item.arguments === "string" ? item.arguments : "";
          const call = calls.get(item.id ?? item.call_id);
          if (!call) {
            const added = { callId: item.call_id ?? item.id ?? "", name: item.name ?? "", arguments: full, index: calls.size };
            calls.set(item.id ?? added.callId, added);
            yield { id, model, delta: { toolCalls: [{ id: added.callId, name: added.name, arguments: full, index: added.index }] } };
          } else if (full.length > call.arguments.length && full.startsWith(call.arguments)) {
            const rest = full.slice(call.arguments.length);
            call.arguments = full;
            yield { id, model, delta: { toolCalls: [{ id: call.callId, arguments: rest, index: call.index }] } };
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

    // A body that ended before the terminal event was cut off (a proxy, a reset): what
    // streamed so far is an unfinished answer, not a stop. 502 = the upstream response
    // was incomplete, a failure a caller retries; a cancelled call is the caller's own doing.
    if (!final && !request.signal?.aborted) {
      throw new ProviderError("Responses stream ended before response.completed", this.providerName, 502);
    }

    // The reasoning items to replay come from the completed response; a server whose
    // completed event carries no output still sent each one as output_item.done.
    const blocks = final?.reasoning?.blocks?.length ? final.reasoning.blocks : this.captureReasoningBlocks(doneItems, modelId);
    let reasoning: ReasoningPayload | undefined;
    if (streamedSummary) {
      // The summary text already went out as deltas; do not repeat it.
      if (blocks.length > 0) reasoning = { blocks };
    } else if (final?.reasoning || blocks.length > 0) {
      reasoning = { ...final?.reasoning, ...(blocks.length > 0 ? { blocks } : {}) };
    }
    yield {
      id: final?.id || id,
      model: final?.model || model,
      delta: reasoning ? { reasoning } : {},
      usage: final?.usage,
      finishReason: final?.finishReason ?? (calls.size > 0 ? "tool_calls" : "stop"),
      ...(final?.rawFinishReason ? { rawFinishReason: final.rawFinishReason } : {}),
    };
  }

  protected buildResponsesBody(request: ChatCompletionRequest, overlay?: RulePatch, opts?: { replayReasoning?: boolean }): Record<string, any> {
    const model = request.model || this.defaultModel;
    // The tool loop in progress (the assistant turns after the last user message) gets its
    // reasoning items back; `fetchResponses` turns that off for an endpoint that refused them.
    const origin = this.responsesOrigin(model);
    const replayOrigin = opts?.replayReasoning === false || this.reasoningReplayRefused.has(origin) ? undefined : origin;
    let lastUser = -1;
    request.messages.forEach((m, i) => { if (m.role === "user") lastUser = i; });
    const body: Record<string, any> = {
      model,
      input: request.messages.map((m, i) => this.toResponsesInput(m, i > lastUser ? replayOrigin : undefined)),
    };

    if (request.maxTokens != null) body.max_output_tokens = request.maxTokens;
    const rule = resolveModelRule({ provider: this.providerName, model: String(body.model), patch: overlay, scope: this.baseURL });
    // The rule decides what the model takes: reasoning models accept no temperature or top_p.
    if (request.temperature != null && allowsSampling(rule, "temperature", request.temperature)) body.temperature = request.temperature;
    if (request.topP != null && allowsSampling(rule, "topP")) body.top_p = request.topP;
    // seed, stop, presence/frequency penalties and logprobs have no Responses equivalent here: left out.

    if (request.tools?.length) {
      // Responses tools are flat function objects (not nested under `function`).
      body.tools = request.tools.map((t) => ({
        type: "function",
        name: t.name,
        description: t.description,
        parameters: t.parameters,
        ...(t.strict ? { strict: true } : {}),
      }));
      if (request.parallelToolCalls != null) body.parallel_tool_calls = request.parallelToolCalls;
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
    applyOpenAIReasoning(body, request.reasoning, "responses", String(body.model), rule);
    // A stored response carries its reasoning as encrypted_content only when asked (a stateless one,
    // store:false or ZDR, carries it by default and still accepts the legacy include): ask for it, so
    // a tool loop can hand the reasoning back (see `replayableReasoning`). Only the reasoning models
    // take it, any other answers 400 "Encrypted content is not supported with this model". A caller's
    // `include` is kept and merged; `extra: { include: null }` opts out.
    if (isEffortReasoningRule(rule) && this.acceptsEncryptedReasoningInclude()) addInclude(body, "reasoning.encrypted_content");
    applyDropParams(body, rule);

    return body;
  }

  /** Whether the Responses endpoint takes `include: ["reasoning.encrypted_content"]`. Azure's older dated api-versions do not. */
  protected acceptsEncryptedReasoningInclude(): boolean {
    return true;
  }

  /**
   * Who a reasoning item was produced for. `encrypted_content` only decrypts for
   * the account that minted it, so an item goes back only to the same provider,
   * endpoint and model. Azure overrides the endpoint part.
   */
  protected responsesOrigin(model: string): string {
    return `${this.providerName}|${this.baseURL}|${model}`;
  }

  /**
   * The reasoning items of an assistant turn that are safe to hand back: those
   * this origin produced and that carry `encrypted_content` (the opaque payload
   * is the whole point; an item without it is only a reference to stored state
   * that may be gone). Blocks from another provider are skipped.
   */
  protected replayableReasoning(m: UnifiedMessage, origin: string): ReplayedReasoning[] {
    const out: ReplayedReasoning[] = [];
    for (const block of m.reasoning?.blocks ?? []) {
      const kept = (block as Partial<ResponsesReasoningBlock>).openaiResponses;
      if (!kept || typeof kept !== "object" || kept.origin !== origin || typeof kept.next !== "string") continue;
      if (!kept.item || typeof kept.item.encrypted_content !== "string" || !kept.item.encrypted_content) continue;
      const item = this.reasoningInputItem(kept.item);
      if (!item) continue;
      const nextId = this.replaysItemIds() && typeof kept.nextId === "string" && kept.nextId ? kept.nextId : undefined;
      out.push({ next: kept.next, item, ...(nextId ? { nextId } : {}) });
    }
    return out;
  }

  /**
   * Whether a replayed reasoning item, and the function call it preceded, go back with the ids
   * the API gave them. No by default: the id is a pointer into the server's storage, a stored
   * item must then be followed by the exact item that followed it ("Item 'rs_…' of type
   * 'reasoning' was provided without its required following item") and can have expired,
   * while `encrypted_content` is self-contained. AzureProvider says yes: its docs replay the
   * items with their ids, and it is reported to answer one without its `id` with 400 `invalid_payload`.
   */
  protected replaysItemIds(): boolean {
    return false;
  }

  /**
   * A captured reasoning item as it goes back in `input`: type, summary and
   * `encrypted_content` (plus the reasoning text when the server gave it), never the
   * `status`; the `id` only when `replaysItemIds()`. Undefined when the item cannot
   * go back in that shape (an id is required and the item has none).
   */
  protected reasoningInputItem(item: ResponsesReasoningItem): Record<string, any> | undefined {
    const withId = this.replaysItemIds();
    if (withId && (typeof item.id !== "string" || !item.id)) return undefined;
    return {
      type: "reasoning",
      ...(withId ? { id: item.id } : {}),
      summary: Array.isArray(item.summary) ? item.summary : [],
      encrypted_content: item.encrypted_content,
      ...(Array.isArray(item.content) && item.content.length > 0 ? { content: item.content } : {}),
    };
  }

  /**
   * The reasoning items of a Responses output worth keeping on `reasoning.blocks`
   * for the next call of the same tool loop. Only a turn that calls functions
   * continues (a final answer has nothing to hand back), and only an item with
   * `encrypted_content` followed by a message or a function call can go back as
   * it came, right before that item.
   */
  protected captureReasoningBlocks(output: unknown, model: string): ResponsesReasoningBlock[] {
    if (!Array.isArray(output) || !output.some((it) => it?.type === "function_call")) return [];
    const origin = this.responsesOrigin(model);
    const blocks: ResponsesReasoningBlock[] = [];
    output.forEach((item: any, i: number) => {
      if (item?.type !== "reasoning" || typeof item.encrypted_content !== "string" || !item.encrypted_content) return;
      let next: string | undefined;
      let nextId: string | undefined;
      for (let j = i + 1; j < output.length; j++) {
        const follower = output[j];
        if (follower?.type === "reasoning") continue; // consecutive items stay together, in order
        if (follower?.type === "function_call") {
          next = callKey(follower.call_id ?? follower.id);
          if (typeof follower.id === "string" && follower.id) nextId = follower.id;
        } else if (follower?.type === "message") next = "message";
        break;
      }
      if (!next) return;
      const summary = Array.isArray(item.summary)
        ? item.summary.map((s: any) => (typeof s?.text === "string" ? s.text : "")).filter(Boolean).join("\n")
        : "";
      blocks.push({
        type: "thinking",
        ...(summary ? { text: summary } : {}),
        openaiResponses: { item: { ...item }, origin, next, ...(nextId ? { nextId } : {}) },
      });
    });
    return blocks;
  }

  /** Maps a unified message to a Responses API `input` item. `replayOrigin` is set for the
   * assistant turns of the tool loop in progress: their reasoning items go back in. */
  protected toResponsesInput(m: UnifiedMessage, replayOrigin?: string): Record<string, any> {
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
      // attached __calls field that buildResponsesBody expands. The reasoning
      // items ride along and are put back right before the item they preceded.
      const reasoning = replayOrigin ? this.replayableReasoning(m, replayOrigin) : [];
      return {
        __assistantWithCalls: true,
        text: typeof m.content === "string" ? m.content : "",
        calls: m.toolCalls.map((tc) => ({
          type: "function_call",
          call_id: tc.id,
          name: tc.name,
          arguments: tc.arguments,
        })),
        ...(reasoning.length > 0 ? { reasoning } : {}),
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

    const tokenUsage = usageFromOpenAIShape(json.usage);

    // A limit hit is status "incomplete" + a reason; "incomplete" alone says
    // nothing about the cause, so it is not "length". A cut-off call's
    // arguments are unusable, so a limit outranks the tool calls.
    const incompleteReason = json.status === "incomplete"
      ? (typeof json.incomplete_details?.reason === "string" ? json.incomplete_details.reason : "incomplete")
      : undefined;
    const finishReason: ChatCompletionResponse["finishReason"] = incompleteReason === "max_output_tokens"
      ? "length"
      : incompleteReason === "content_filter"
        ? "content_filter"
        : toolCalls.length > 0 ? "tool_calls" : "stop";
    const rawFinishReason = incompleteReason ?? (typeof json.status === "string" ? json.status : undefined);

    // Reasoning items with encrypted content ride along for the next call of a tool loop.
    const blocks = this.captureReasoningBlocks(json.output, modelId);

    return {
      id: json.id ?? "",
      model: json.model ?? modelId,
      content: textParts.join("") || null,
      toolCalls,
      usage: tokenUsage,
      finishReason,
      ...(rawFinishReason ? { rawFinishReason } : {}),
      reasoning: summaryParts.length > 0 || blocks.length > 0
        ? {
            ...(blocks.length > 0 ? { blocks } : {}),
            ...(summaryParts.length > 0 ? { summary: summaryParts.join("\n").trim() || undefined } : {}),
          }
        : undefined,
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
    return usageFromOpenAIShape(usage);
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * `TokenUsage` from an OpenAI-shaped usage object: Chat Completions
 * (`prompt_tokens` / `completion_tokens`) and Responses (`input_tokens` /
 * `output_tokens`), plus the cache dialects of OpenAI-compatible servers. Every
 * dialect below reports `prompt_tokens` INCLUSIVE of the cached tokens, so the
 * input is kept as it is:
 *  - cache read: `prompt_tokens_details.cached_tokens` / `input_tokens_details.cached_tokens`
 *    (OpenAI, Azure, OpenRouter), DeepSeek's `prompt_cache_hit_tokens` (docs:
 *    `prompt_tokens = hit + miss`) and Moonshot's top-level `cached_tokens`
 *    (docs: "cache reads and writes are already included in `prompt_tokens`")
 *  - cache write: `prompt_tokens_details.cache_write_tokens` (OpenRouter, also
 *    `input_tokens_details.cache_write_tokens`) and LiteLLM's `cache_creation_input_tokens`
 * Defensive guard: read + write above the prompt can only mean a server that
 * leaves the cache out of `prompt_tokens` (an Anthropic-style usage forwarded
 * verbatim), so the cache is added back instead of being billed as a negative.
 * Reasoning is a subset of the output and is 0 when the server does not report it.
 */
function usageFromOpenAIShape(usage: any): TokenUsage {
  if (!usage || typeof usage !== "object") return emptyUsage();
  const count = (...vals: any[]): number => {
    for (const v of vals) if (typeof v === "number" && Number.isFinite(v) && v >= 0) return v;
    return 0;
  };
  const completionDetails = usage.completion_tokens_details ?? usage.output_tokens_details ?? {};
  let input = count(usage.prompt_tokens, usage.input_tokens);
  const output = count(usage.completion_tokens, usage.output_tokens);
  const cachedRead = count(
    usage.prompt_tokens_details?.cached_tokens,
    usage.input_tokens_details?.cached_tokens,
    usage.prompt_cache_hit_tokens,
    usage.cached_tokens,
  );
  const cachedWrite = count(
    usage.prompt_tokens_details?.cache_write_tokens,
    usage.input_tokens_details?.cache_write_tokens,
    usage.cache_creation_input_tokens,
  );
  let total = count(usage.total_tokens);
  if (cachedRead + cachedWrite > input) {
    input += cachedRead + cachedWrite;
    total = 0;
  }
  return {
    inputTokens: input,
    outputTokens: output,
    totalTokens: total || input + output,
    cachedInputTokens: cachedRead,
    cachedWriteTokens: cachedWrite,
    cachedOutputTokens: 0,
    reasoningTokens: Math.min(count(completionDetails.reasoning_tokens), output),
  };
}

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

/**
 * True for OpenAI models whose rule (model-rules.json) is a reasoning model with
 * restricted sampling: o-series, gpt-5, gpt-5.x, gpt-6 and newer. `-chat`
 * variants, gpt-oss, older gpt and models the rules do not know are not.
 */
export function isReasoningModel(model: string | undefined): boolean {
  if (!model) return false;
  return isEffortReasoningRule(resolveModelRule({ provider: "openai", model }));
}

/** A rule that describes a reasoning model with restricted sampling (see {@link isReasoningModel}); the
 * models that return reasoning items with `encrypted_content`. */
function isEffortReasoningRule(rule: ResolvedModelRule): boolean {
  return !rule.isDefault && rule.reasoning.style === "effort" && rule.sampling.temperature !== "any";
}

/** Adds `value` to the body's `include` list, keeping what the caller put there. An explicit
 * `include: null` is the caller opting out, and anything that is not a list is left alone. */
function addInclude(body: Record<string, any>, value: string): void {
  if (body.include === null) return;
  if (body.include !== undefined && !Array.isArray(body.include)) return;
  const have: unknown[] = body.include ?? [];
  if (!have.includes(value)) body.include = [...have, value];
}

/** Key tying a reasoning item to the function call it preceded (the call's `call_id`). */
function callKey(callId: unknown): string {
  return `call:${typeof callId === "string" ? callId : ""}`;
}

/** True when a built Responses `input` carries reasoning items to replay (checked before it is flattened). */
function hasReplayedReasoning(input: unknown): boolean {
  return Array.isArray(input) && input.some((item) => item?.__assistantWithCalls && Array.isArray(item.reasoning) && item.reasoning.length > 0);
}

/** A 400 / 422 whose message no model adjustment (models/adjust.ts) explains: what a refused reasoning item looks like. */
function isUnexplainedBadRequest(err: unknown): boolean {
  if (!(err instanceof ProviderError) || (err.statusCode !== 400 && err.statusCode !== 422)) return false;
  return parseModelError(String(err.responseBody ?? err.message)) === undefined;
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
 * items in order). A replayed reasoning item goes right before the item it
 * preceded in the model's output (the message, or its function call); one whose
 * item is not there any more is left out, never sent without it. A function call
 * whose reasoning kept the call's original `id` (`nextId`) gets it back. Shared
 * with AzureProvider. */
export function expandResponsesInput(input: any[]): any[] {
  const out: any[] = [];
  for (const item of input) {
    if (item && item.__assistantWithCalls) {
      const reasoning: ReplayedReasoning[] = Array.isArray(item.reasoning) ? item.reasoning : [];
      // Puts the reasoning items that preceded `key` here; returns the id of the item they preceded, when they kept it.
      const before = (key: string): string | undefined => {
        let id: string | undefined;
        for (const r of reasoning) {
          if (r.next !== key) continue;
          out.push(r.item);
          id = r.nextId ?? id;
        }
        return id;
      };
      if (item.text) {
        before("message");
        out.push({ role: "assistant", content: [{ type: "output_text", text: item.text }] });
      }
      for (const call of item.calls) {
        const id = before(callKey(call.call_id));
        out.push(id && call.id === undefined ? { ...call, id } : call);
      }
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
    case "max_tokens":
    case "model_length":
    case "max_output_tokens":
      return "length";
    case "content_filter":
      return "content_filter";
    case "insufficient_system_resource":
      return "error";
    default:
      return "stop";
  }
}
