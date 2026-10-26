// Anthropic Messages API provider.
// Direct fetch-based implementation – no SDK dependency.

import { supportsForcedToolChoice, forcedToolChoiceRejected } from "./utils/toolChoice.js";
import { BaseProvider } from "./base.js";
import { parseSSEStream } from "./utils/sse.js";
import { applyAnthropicReasoning, enforceAnthropicSampling, supportsAdaptiveThinking, type ThinkingMode } from "./utils/reasoning.js";
import { resolveModelRule, applyDropParams, type RulePatch } from "../models/rules.js";
import { runWithModelAdjustments } from "../models/adjust.js";
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
  type PromptCachingConfig,
  type ProviderType,
  ProviderError,
} from "./types.js";

const DEFAULT_MAX_TOKENS = 4096;
/** Adaptive-thinking models think by default, and 4096 truncates mid-thought. */
const DEFAULT_MAX_TOKENS_ADAPTIVE = 16384;
/** The Messages API accepts at most this many cache breakpoints per request. */
const MAX_CACHE_BREAKPOINTS = 4;

function defaultMaxTokens(model: unknown): number {
  return supportsAdaptiveThinking(model) ? DEFAULT_MAX_TOKENS_ADAPTIVE : DEFAULT_MAX_TOKENS;
}

/** Counts explicit `cache_control` markers in system, tools and messages. */
function countCacheMarkers(node: unknown): number {
  if (Array.isArray(node)) return node.reduce((n: number, v) => n + countCacheMarkers(v), 0);
  if (!node || typeof node !== "object") return 0;
  let n = 0;
  for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
    n += k === "cache_control" ? (v != null ? 1 : 0) : countCacheMarkers(v);
  }
  return n;
}

/** Enforces the Anthropic rules around a caller-supplied `thinking` block
 * without altering the caller's choice: enabled thinking needs
 * `max_tokens > budget_tokens` and forbids sampling overrides; a disabled or
 * null block is dropped from the sampling restrictions. */
function normalizeExplicitThinking(body: Record<string, any>): void {
  const t = body.thinking;
  if (t == null) {
    delete body.thinking;
    return;
  }
  if (t.type !== "enabled") return;
  const budget = typeof t.budget_tokens === "number" ? t.budget_tokens : 0;
  if (budget > 0 && (typeof body.max_tokens !== "number" || body.max_tokens <= budget)) {
    body.max_tokens = budget + 1024;
  }
  for (const k of ["temperature", "top_p", "top_k"]) delete body[k];
}

export class AnthropicProvider extends BaseProvider {
  readonly providerName: ProviderType = "anthropic";

  private readonly apiKey: string;
  private readonly baseURL: string;
  private readonly defaultModel: string;
  private readonly defaultHeaders: Record<string, string>;
  private readonly anthropicVersion: string;

  // Hooks for a subclass that talks to Claude through another front door
  // (Vertex AI `rawPredict`): where the model-rule family and learned
  // adjustments come from, the name used in error messages, and (see the
  // protected methods below) the URL, the headers and the body.
  /** Provider name the model rules are looked up under (the Messages wire shape). */
  protected readonly rulesProvider: string = "anthropic";
  /** Keeps what a 400 taught apart from the direct API's (same model id, other backend). */
  protected readonly rulesScope?: string;
  /** Names the API in error messages: "<apiName> API error 400: ...". */
  protected readonly apiName: string = "Anthropic";

  private readonly promptCachingEnabled: boolean;
  private readonly promptCaching: Required<Omit<PromptCachingConfig, "enabled">>;
  private readonly thinkingMode: ThinkingMode;

  constructor(config: AnthropicProviderConfig) {
    super();
    this.configureTransport(config);
    this.apiKey = config.apiKey;
    this.baseURL = (config.baseURL ?? "https://api.anthropic.com").replace(/\/$/, "");
    this.defaultModel = config.defaultModel ?? "claude-sonnet-4-20250514";
    this.defaultHeaders = config.defaultHeaders ?? {};
    this.anthropicVersion = config.anthropicVersion ?? "2023-06-01";
    this.thinkingMode = config.thinkingMode ?? "auto";
    this.promptCachingEnabled = config.prompt_caching?.enabled === true;
    this.promptCaching = {
      strategy: config.prompt_caching?.strategy ?? "auto",
      ttl: config.prompt_caching?.ttl ?? "5m",
    };
    if (config.retry) this.retryPolicy = { ...this.retryPolicy, ...config.retry };
  }

  async complete(request: ChatCompletionRequest): Promise<ChatCompletionResponse> {
    const res = await this.send(request, false);
    const json = await res.json();
    return this.parseResponse(json);
  }

  async *completeStream(request: ChatCompletionRequest): AsyncGenerator<ChatCompletionChunk, void, unknown> {
    const res = await this.send(request, true);

    if (!res.body) throw new ProviderError("No response body for stream", this.providerName);

    let id = "";
    let model = "";
    let inputTokens = 0;
    let outputTokens = 0;
    let thinkingTokens = 0;
    let cacheReadInputTokens = 0;
    let cacheCreationInputTokens = 0;
    const streamUsage = (): TokenUsage => this.normalizeUsage({
      inputTokens,
      outputTokens,
      totalTokens: inputTokens + outputTokens,
      cachedInputTokens: cacheReadInputTokens,
      cachedWriteTokens: cacheCreationInputTokens,
      cachedOutputTokens: 0,
      reasoningTokens: thinkingTokens,
    });
    const currentToolCalls = new Map<number, { id: string; name: string; arguments: string; ordinal: number }>();
    let toolOrdinal = 0;
    // Accumulate thinking blocks by content-block index so we can replay them.
    const reasoningBlocks = new Map<number, ReasoningBlock>();

    for await (const event of parseSSEStream(res.body, request.signal)) {
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
            outputTokens = msg.usage.output_tokens ?? 0;
            // The input side of the bill is known here: report it now, so a stream
            // that is cut or cancelled before `message_delta` still carries what the
            // prompt cost. Every usage chunk is CUMULATIVE (the last one wins, a
            // consumer never adds them); this one has no finish reason.
            yield { id, model, delta: {}, usage: streamUsage() };
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
              ordinal: toolOrdinal++,
            });
            const opened = currentToolCalls.get(idx)!;
            // Announce the call when it opens, so a tool that takes no input
            // (no input_json_delta ever follows) is still seen by the consumer.
            yield { id, model, delta: { toolCalls: [{ id: opened.id, name: opened.name, arguments: "", index: opened.ordinal }] } };
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
                  toolCalls: [{ id: tc.id, name: tc.name, arguments: delta.partial_json, index: tc.ordinal }],
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
            // Cumulative counters: newer API versions repeat the input side here, so a
            // value that is present replaces the one from `message_start`.
            inputTokens = data.usage.input_tokens ?? inputTokens;
            cacheReadInputTokens = data.usage.cache_read_input_tokens ?? cacheReadInputTokens;
            cacheCreationInputTokens = data.usage.cache_creation_input_tokens ?? cacheCreationInputTokens;
            outputTokens = data.usage.output_tokens ?? outputTokens;
            thinkingTokens = data.usage.output_tokens_details?.thinking_tokens ?? thinkingTokens;
          }
          const finishReason = mapAnthropicStopReason(delta?.stop_reason);
          const rawFinishReason = typeof delta?.stop_reason === "string" ? delta.stop_reason : undefined;
          const usage = streamUsage();
          const blocks = [...reasoningBlocks.values()].filter(
            (b) => (b.type === "thinking" && b.signature) || (b.type === "redacted_thinking" && b.data),
          );
          yield {
            id,
            model,
            delta: blocks.length > 0 ? { reasoning: { blocks } } : {},
            finishReason,
            ...(rawFinishReason ? { rawFinishReason } : {}),
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

  private buildRequestBody(request: ChatCompletionRequest, stream: boolean, overlay?: RulePatch, downgradeToolChoice = false): Record<string, any> {
    // Anthropic separates system from messages
    const { system, messages } = this.splitSystemMessages(request.messages);

    const body: Record<string, any> = {
      model: request.model || this.defaultModel,
      messages: this.toAnthropicMessages(messages),
      max_tokens: request.maxTokens ?? defaultMaxTokens(request.model || this.defaultModel),
      stream,
    };

    if (system) {
      // When prompt caching is on, ship `system` as a block array with a
      // cache_control breakpoint so the static system prompt is reused.
      if (this.promptCachingEnabled) {
        body.system = [{ type: "text", text: system, cache_control: this.cacheControl() }];
      } else {
        body.system = system;
      }
    }
    // Which sampling params and thinking form the model takes comes from its rule.
    const rule = resolveModelRule({ provider: this.rulesProvider, model: String(body.model), patch: overlay, scope: this.rulesScope });
    if (request.temperature != null) body.temperature = request.temperature;
    if (request.topP != null) body.top_p = request.topP;
    if (request.stop) body.stop_sequences = request.stop;

    if (request.tools?.length) {
      const tools = request.tools.map((t) => this.toAnthropicTool(t));
      // Cache the entire tools block by placing the breakpoint on the final
      // tool definition – everything above it in the request is cached too.
      if (this.promptCachingEnabled && tools.length > 0) {
        tools[tools.length - 1] = { ...tools[tools.length - 1], cache_control: this.cacheControl() };
      }
      body.tools = tools;
    }

    if (request.toolChoice != null) {
      const forceOk = !downgradeToolChoice && supportsForcedToolChoice(body.model);
      if (request.toolChoice === "auto") {
        body.tool_choice = { type: "auto" };
      } else if (request.toolChoice === "required") {
        body.tool_choice = forceOk ? { type: "any" } : { type: "auto" };
      } else if (request.toolChoice === "none") {
        // Anthropic doesn't have a direct "none" – omit tools
      } else {
        body.tool_choice = forceOk ? { type: "tool", name: request.toolChoice.name } : { type: "auto" };
      }
    }

    if (request.extra) {
      Object.assign(body, request.extra);
    }

    const explicitThinking = request.extra && typeof request.extra === "object" && "thinking" in request.extra;
    if (explicitThinking) {
      // An explicit `extra.thinking` is the caller's final word: derived reasoning
      // must not overwrite it. Only the hard API rules are enforced around it.
      normalizeExplicitThinking(body);
      enforceAnthropicSampling(body, rule, body.thinking?.type === "enabled" || body.thinking?.type === "adaptive");
    } else {
      applyAnthropicReasoning(body, request.reasoning, { model: body.model, mode: this.thinkingMode, rule, defaultedMaxTokens: request.maxTokens == null });
    }
    applyDropParams(body, rule);

    // max_tokens is mandatory on the Messages API; `extra` may have nulled it.
    if (typeof body.max_tokens !== "number" || !(body.max_tokens > 0)) {
      body.max_tokens = defaultMaxTokens(body.model);
    }

    // Automatic caching for the conversation tail. Applied last so the explicit
    // markers of `extra` are counted; the server answers 400 when the 4 slots
    // are full, and a caller-set top-level key is left alone (null included).
    if (this.promptCachingEnabled && this.promptCaching.strategy === "auto" && !("cache_control" in body)) {
      const explicit = countCacheMarkers(body.system) + countCacheMarkers(body.tools) + countCacheMarkers(body.messages);
      if (explicit < MAX_CACHE_BREAKPOINTS) body.cache_control = this.cacheControl();
    }

    return body;
  }

  /** `ttl` is sent only for 1h; the 5-minute default is the API's own. */
  private cacheControl(): Record<string, any> {
    return this.promptCaching.ttl === "1h" ? { type: "ephemeral", ttl: "1h" } : { type: "ephemeral" };
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
        if (part.type === "file") {
          const src = part.source;
          const title = part.fileName ? { title: part.fileName } : {};
          if (src.type === "base64") {
            return {
              type: "document",
              source: { type: "base64", media_type: src.mediaType, data: src.data },
              ...title,
            };
          }
          return { type: "document", source: { type: "url", url: src.url }, ...title };
        }
        if (part.type === "audio") {
          // Anthropic has no audio input; keep the reference visible.
          const src = part.source;
          return { type: "text", text: src.type === "url" ? `[audio: ${src.url}]` : "[audio attachment omitted: not supported by this model]" };
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

  /** Builds and sends the request; retries once with the other thinking form
   * when the upstream rejects the one we picked. */
  private send(request: ChatCompletionRequest, stream: boolean): Promise<Response> {
    let downgrade = false;
    return runWithModelAdjustments({
      provider: this.rulesProvider,
      scope: this.rulesScope,
      model: request.model || this.defaultModel,
      endpoint: "messages",
      callerParams: request.extra ? Object.keys(request.extra) : undefined,
      onLearned: this.onModelRuleLearned,
      run: async (overlay, guard) => {
        for (;;) {
          const body = this.buildRequestBody(request, stream, overlay, downgrade);
          guard(body);
          try {
            return await this.doFetch(body, stream, request.signal);
          } catch (err) {
            // Model refuses forced tool use: retry once with tool_choice auto.
            const rejected = err instanceof ProviderError && err.statusCode === 400 && !downgrade
              && body.tool_choice && body.tool_choice.type !== "auto"
              && forcedToolChoiceRejected(String(err.responseBody ?? err.message));
            if (!rejected) throw err;
            downgrade = true;
          }
        }
      },
    });
  }

  // ─── Transport hooks ─────────────────────────────────────────────────────
  // The defaults are the direct Anthropic API. A subclass overrides them to change
  // only the transport; body building, caching, thinking, tools, finish reasons
  // and stream parsing stay shared.

  /** The URL a request for `model` is posted to. */
  protected requestUrl(_model: string, _stream: boolean): string {
    return `${this.baseURL}/v1/messages`;
  }

  /** Auth and version headers, plus the configured `defaultHeaders`. Called once per request, before any retry. */
  protected async requestHeaders(): Promise<Record<string, string>> {
    return {
      "Content-Type": "application/json",
      "x-api-key": this.apiKey,
      "anthropic-version": this.anthropicVersion,
      ...this.defaultHeaders,
    };
  }

  /** The JSON that goes on the wire for a built request body (the body itself is left as it is). */
  protected wireBody(body: Record<string, any>): Record<string, any> {
    return body;
  }

  /** Puts the usage counters on the basis this provider reports. The default keeps the Messages API's own. */
  protected normalizeUsage(usage: TokenUsage): TokenUsage {
    return usage;
  }

  private async doFetch(body: Record<string, any>, stream: boolean, signal?: AbortSignal): Promise<Response> {
    const url = this.requestUrl(String(body.model), stream);
    const headers = await this.requestHeaders();
    const payload = JSON.stringify(this.wireBody(body));
    const res = await this.doFetchWithRetry(() => this.httpFetch(url, { method: "POST", headers, body: payload, signal }), signal);

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new ProviderError(
        `${this.apiName} API error ${res.status}: ${text}`,
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
      // Thinking tokens are billed inside `output_tokens`; newer models also
      // report the split as `output_tokens_details.thinking_tokens`.
      reasoningTokens: usage.output_tokens_details?.thinking_tokens ?? 0,
    };

    return {
      id: json.id ?? "",
      model: json.model ?? "",
      content: textParts.join("") || null,
      toolCalls,
      usage: this.normalizeUsage(tokenUsage),
      finishReason: mapAnthropicStopReason(json.stop_reason),
      ...(typeof json.stop_reason === "string" ? { rawFinishReason: json.stop_reason } : {}),
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
    case "model_context_window_exceeded":
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
