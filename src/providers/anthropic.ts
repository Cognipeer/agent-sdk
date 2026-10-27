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
  type ContentPart,
  type ToolCall,
  type TokenUsage,
  type UnifiedMessage,
  type ToolDefinition,
  type ReasoningBlock,
  type AnthropicProviderConfig,
  type PromptCachingConfig,
  type ProviderType,
  type TextContent,
  ProviderError,
} from "./types.js";

const DEFAULT_MAX_TOKENS = 4096;
/** Adaptive-thinking models think by default, and 4096 truncates mid-thought. */
const DEFAULT_MAX_TOKENS_ADAPTIVE = 16384;
/** The Messages API accepts at most this many cache breakpoints per request. */
const MAX_CACHE_BREAKPOINTS = 4;

/** What a tool result with no output is sent as: both APIs reject an empty text block. */
export const EMPTY_TOOL_RESULT_TEXT = "(no output)";
/** What a user or assistant message with no text (and nothing else) is sent as, for the same reason. */
export const EMPTY_MESSAGE_TEXT = "(empty message)";

function defaultMaxTokens(model: unknown): number {
  return supportsAdaptiveThinking(model) ? DEFAULT_MAX_TOKENS_ADAPTIVE : DEFAULT_MAX_TOKENS;
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

/** The blocks of the built request the SDK made itself, so the breakpoint pass never touches what `extra` replaced. */
type OwnBlocks = {
  /** The `system` block array (absent when `system` went out as a plain string). */
  system?: Record<string, any>[];
  /** The last block of the static system prefix: where the SDK's system breakpoint goes. */
  lastStatic?: Record<string, any>;
  tools?: Record<string, any>[];
};

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
    // True once the message is known to be complete: `message_stop`, or the
    // `message_delta` that carries the stop reason (some gateways drop the former).
    let finished = false;

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
          if (rawFinishReason) finished = true;
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
          finished = true;
          break;

        case "error": {
          // The stream's own error event: it carries the failure the HTTP status would
          // have named (an `overloaded_error` is a 529), so it is retried, or not, by the
          // same rule. The raw event is the body, as the response text is on an HTTP error.
          const errMsg = data.error?.message ?? "Unknown Anthropic streaming error";
          throw new ProviderError(errMsg, this.providerName, anthropicErrorStatus(data.error?.type), event.data);
        }
      }
    }

    // The body ended with no `message_stop` and no stop reason: the connection was
    // cut, not the message finished. Ending quietly would hand the caller half a
    // message (a tool call whose arguments stop halfway) as if it were whole. A
    // caller that cancelled the call ended it itself: that is not an error.
    if (!finished) {
      if (request.signal?.aborted) return;
      throw truncatedStreamError(this.providerName, this.apiName);
    }
  }

  // ─── Internals ───────────────────────────────────────────────────────────

  private buildRequestBody(request: ChatCompletionRequest, stream: boolean, overlay?: RulePatch, downgradeToolChoice = false): Record<string, any> {
    // Anthropic separates system from messages. The system prompt that does not
    // change between turns comes first and the SDK's own per-turn blocks (summary,
    // memory, plugin and reflection context) after it, so a cache breakpoint can
    // sit between the two instead of after text that changes every turn.
    const { staticSystem, dynamicSystem, rest } = partitionSystemMessages(request.messages);
    // The `cache_control` objects made from the caller's `cacheControl` parts.
    const partMarks = new Set<object>();
    const staticBlocks = systemTextBlocks(staticSystem, partMarks);
    const systemBlocks = [...staticBlocks, ...systemTextBlocks(dynamicSystem, partMarks)];

    const body: Record<string, any> = {
      model: request.model || this.defaultModel,
      messages: this.toAnthropicMessages(rest, partMarks),
      max_tokens: request.maxTokens ?? defaultMaxTokens(request.model || this.defaultModel),
      stream,
    };

    // `system` stays a plain string unless something needs blocks: prompt caching
    // (the SDK's breakpoint goes on a block) or a breakpoint the caller put on a part.
    let ownSystem: Record<string, any>[] | undefined;
    if (systemBlocks.length > 0) {
      if (this.promptCachingEnabled || systemBlocks.some((b) => b.cache_control)) {
        ownSystem = systemBlocks;
        body.system = ownSystem;
      } else {
        body.system = systemBlocks.map((b) => b.text).join("\n\n");
      }
    }
    // Which sampling params and thinking form the model takes comes from its rule.
    const rule = resolveModelRule({ provider: this.rulesProvider, model: String(body.model), patch: overlay, scope: this.rulesScope });
    if (request.temperature != null) body.temperature = request.temperature;
    if (request.topP != null) body.top_p = request.topP;
    if (request.stop) body.stop_sequences = request.stop;

    let ownTools: Record<string, any>[] | undefined;
    if (request.tools?.length) {
      ownTools = request.tools.map((t) => this.toAnthropicTool(t));
      body.tools = ownTools;
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

    // Last, on the finished body: `extra` may have replaced any block, and its own
    // markers count against the limit too.
    this.settleCacheBreakpoints(body, { system: ownSystem, lastStatic: staticBlocks[staticBlocks.length - 1], tools: ownTools }, partMarks);

    return body;
  }

  /**
   * Settles the cache breakpoints of a finished body so a request never carries
   * more than the 4 the API accepts (a 5th is a 400). In order:
   *  1. The caller's own come first: the `cacheControl` of text parts and any
   *     `cache_control` in `extra`. Over the limit, the earliest ones made from parts
   *     are dropped (a later breakpoint covers a longer prefix); a raw `extra` one
   *     is never touched.
   *  2. The SDK's own, only while a slot is free and only on blocks it built: the
   *     end of the static system prompt, the last tool, then top-level automatic
   *     caching (it takes one slot, on the last cacheable block). A breakpoint the
   *     caller already put on that block counts as the SDK's. Automatic caching is
   *     left out when the request's last block carries a breakpoint of another
   *     lifetime: it would land on that block, a 400 (the caller asked for 1h on the
   *     tail, the provider default is 5m). At the same lifetime it is a no-op, and sent.
   *  3. A longer lifetime may not come after a shorter one (the API answers 400): a
   *     1h breakpoint after a 5m one, in the order tools, system, messages, is sent as
   *     5m. Only the ones the SDK made (from parts, or its own) are changed.
   */
  private settleCacheBreakpoints(body: Record<string, any>, own: OwnBlocks, partMarks: Set<object>): void {
    const sdkMarks = new Set<object>();
    const found = cacheHolders(body, partMarks, sdkMarks);
    let count = found.length;
    for (const holder of found) {
      if (count <= MAX_CACHE_BREAKPOINTS) break;
      if (holder.origin !== "part") continue;
      delete holder.node.cache_control;
      count--;
    }

    if (this.promptCachingEnabled) {
      const mark = (node: Record<string, any>): void => {
        const marker = this.cacheControl();
        node.cache_control = marker;
        sdkMarks.add(marker);
        count++;
      };
      if (count < MAX_CACHE_BREAKPOINTS && own.lastStatic && body.system === own.system && own.lastStatic.cache_control == null) {
        mark(own.lastStatic);
      }
      const tools = own.tools;
      const lastTool = tools && tools.length > 0 ? tools[tools.length - 1] : undefined;
      if (count < MAX_CACHE_BREAKPOINTS && lastTool && body.tools === tools && lastTool.cache_control == null) {
        mark(lastTool);
      }
      // A caller-set top-level key is left alone (null included).
      if (count < MAX_CACHE_BREAKPOINTS && this.promptCaching.strategy === "auto" && !("cache_control" in body) && !tailClashes(body, this.cacheControl())) {
        mark(body);
      }
    }

    let shorter = false;
    for (const holder of cacheHolders(body, partMarks, sdkMarks)) {
      const marker = holder.node.cache_control as Record<string, any>;
      if (marker.ttl !== "1h") shorter = true;
      else if (shorter && holder.origin !== "raw") delete marker.ttl;
    }
  }

  /** `ttl` is sent only for 1h; the 5-minute default is the API's own. */
  private cacheControl(): Record<string, any> {
    return this.promptCaching.ttl === "1h" ? { type: "ephemeral", ttl: "1h" } : { type: "ephemeral" };
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
  private toAnthropicMessages(messages: UnifiedMessage[], marks: Set<object>): Record<string, any>[] {
    const result: Record<string, any>[] = [];
    let mergingToolResults = false;

    for (const m of messages) {
      if (m.role === "tool" && m.toolCallId) {
        const toolResult = this.toAnthropicToolResult(m, marks);
        if (mergingToolResults) {
          result[result.length - 1].content.push(toolResult);
        } else {
          result.push({ role: "user", content: [toolResult] });
          mergingToolResults = true;
        }
        continue;
      }

      mergingToolResults = false;
      result.push(this.toAnthropicMessage(m, marks));
    }

    return result;
  }

  private toAnthropicToolResult(m: UnifiedMessage, marks: Set<object>): Record<string, any> {
    return {
      type: "tool_result",
      tool_use_id: m.toolCallId,
      content: toolResultContent(m.content, marks),
      // Only when set: a result that did not fail carries no flag at all.
      ...(m.isError ? { is_error: true } : {}),
    };
  }

  private toAnthropicMessage(m: UnifiedMessage, marks: Set<object>): Record<string, any> {
    // Assistant with tool calls. Anthropic requires the original thinking
    // blocks (with their `signature`) to be replayed verbatim *before* the
    // text/tool_use blocks whenever extended thinking was used in that turn.
    if (m.role === "assistant" && m.toolCalls?.length) {
      const content: any[] = [];
      appendReasoningBlocks(content, m.reasoning?.blocks);
      content.push(...assistantTextBlocks(m.content, marks));
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
      content.push(...assistantTextBlocks(m.content, marks));
      if (content.length === 0) content.push({ type: "text", text: EMPTY_MESSAGE_TEXT });
      return { role: "assistant", content };
    }

    // Regular messages. An empty text block is a 400, so blank text is dropped,
    // and a message left with nothing carries a placeholder instead.
    const msg: Record<string, any> = { role: m.role };

    if (typeof m.content === "string") {
      msg.content = m.content.trim() ? m.content : EMPTY_MESSAGE_TEXT;
    } else if (Array.isArray(m.content)) {
      const blocks: Record<string, any>[] = [];
      for (const part of m.content) {
        const block = anthropicPart(part, marks);
        if (block) blocks.push(block);
      }
      msg.content = blocks.length > 0 ? blocks : [{ type: "text", text: EMPTY_MESSAGE_TEXT }];
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

  /**
   * The JSON that goes on the wire for a built request body (the body itself is left as
   * it is). A backend that can never take part of the body throws a non-retryable
   * `ProviderError` here, before anything is sent.
   */
  protected wireBody(body: Record<string, any>): Record<string, any> {
    return body;
  }

  /** Puts the usage counters on the basis this provider reports. The default keeps the Messages API's own. */
  protected normalizeUsage(usage: TokenUsage): TokenUsage {
    return usage;
  }

  private async doFetch(body: Record<string, any>, stream: boolean, signal?: AbortSignal): Promise<Response> {
    const url = this.requestUrl(String(body.model), stream);
    // The payload first: `wireBody` may refuse a body the backend can never take, and
    // that must fail before any auth work (a token fetch) is spent on it.
    const payload = JSON.stringify(this.wireBody(body));
    const headers = await this.requestHeaders();
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
    // `pause_turn`: a server tool's sampling loop hit its iteration limit, so the turn
    // is NOT finished. There is no unified "paused" reason, so it stays "stop"; the raw
    // value is always kept in `rawFinishReason` (both paths), which is how a host that
    // runs server tools sees it and decides whether to send the content back to continue.
    case "pause_turn":
      return "stop";
    case "tool_use":
      return "tool_calls";
    case "max_tokens":
    case "model_context_window_exceeded":
      return "length";
    // A safety classifier declined to answer: an HTTP 200, not an error.
    case "refusal":
      return "content_filter";
    default:
      return "stop";
  }
}

/**
 * The HTTP status the Messages API gives an error type (platform.claude.com/docs/en/api/errors).
 * An `error` event inside a stream names only the type, so this puts it on the same
 * footing as the HTTP answer: 429 and 5xx (500, 504, 529) retry, the rest do not. The
 * list may grow, so an unknown type has no status rather than a guessed one.
 */
export function anthropicErrorStatus(type: unknown): number | undefined {
  switch (type) {
    case "invalid_request_error": return 400;
    case "authentication_error": return 401;
    case "billing_error": return 402;
    case "permission_error": return 403;
    case "not_found_error": return 404;
    case "conflict_error": return 409;
    case "request_too_large": return 413;
    case "rate_limit_error": return 429;
    case "api_error": return 500;
    case "timeout_error": return 504;
    case "overloaded_error": return 529;
    default: return undefined;
  }
}

/**
 * The error for a response stream that ended before the message was finished.
 * A cut connection is the same transient failure as a 502 from a gateway, so it
 * carries that status: retried like any other 5xx, with the one phrase the hosts
 * and the other native providers can match on.
 */
export function truncatedStreamError(provider: string, apiName: string, cause?: string): ProviderError {
  return new ProviderError(
    `${apiName} stream ended before the message finished${cause ? ` (${cause})` : ""}`,
    provider,
    502,
  );
}

// ── System prompt: what stays the same between turns, and what does not ─────

/**
 * Names of the system messages the SDK itself injects and rewrites between turns:
 * the context summary and memory block (smart/contextPolicy), plugin context
 * (plugins/session) and the reflection note (nodes/reflect). They change from turn
 * to turn, so a cache breakpoint must not sit after them.
 */
const DYNAMIC_SYSTEM_NAMES = new Set(["context_summary", "memory_context", "plugin_context", "agent_reflection"]);

/**
 * Splits the messages into the static system prefix, the dynamic system messages
 * and everything else (a native `system` field takes the first two, in that order).
 * Static is the run of system messages at the head of the list up to the first one
 * the SDK names as a per-turn block; every other system message (named, or added
 * after the conversation began, such as a language guard) is dynamic. The relative
 * order of the system messages never changes.
 */
export function partitionSystemMessages(messages: UnifiedMessage[]): {
  staticSystem: UnifiedMessage[];
  dynamicSystem: UnifiedMessage[];
  rest: UnifiedMessage[];
} {
  const staticSystem: UnifiedMessage[] = [];
  const dynamicSystem: UnifiedMessage[] = [];
  const rest: UnifiedMessage[] = [];
  let stable = true;
  for (const m of messages) {
    if (m.role !== "system") {
      stable = false;
      rest.push(m);
    } else if (stable && !(m.name && DYNAMIC_SYSTEM_NAMES.has(m.name))) {
      staticSystem.push(m);
    } else {
      stable = false;
      dynamicSystem.push(m);
    }
  }
  return { staticSystem, dynamicSystem, rest };
}

/** One run of a system message's text, ended by a part the caller marked for caching. */
export type SystemPiece = { text: string; mark?: TextContent["cacheControl"] };

/**
 * What a system message contributes: its text, cut after each text part that carries
 * a `cacheControl` (the text parts of one run are joined with a newline; other parts
 * have no place in a system prompt).
 */
export function systemPieces(m: UnifiedMessage): SystemPiece[] {
  if (typeof m.content === "string") return [{ text: m.content }];
  const pieces: SystemPiece[] = [];
  let run: string[] = [];
  for (const part of Array.isArray(m.content) ? m.content : []) {
    if (part.type !== "text") continue;
    run.push(part.text);
    if (part.cacheControl) {
      pieces.push({ text: run.join("\n"), mark: part.cacheControl });
      run = [];
    }
  }
  if (run.length > 0) pieces.push({ text: run.join("\n") });
  return pieces;
}

/**
 * The text blocks of a group of system messages. Runs of unmarked text are merged
 * (blank ones dropped: the API rejects an empty text block) and a block ends
 * wherever the caller put a cache breakpoint.
 */
function systemTextBlocks(messages: UnifiedMessage[], marks: Set<object>): Record<string, any>[] {
  const blocks: Record<string, any>[] = [];
  let pending: string[] = [];
  const flush = (mark?: TextContent["cacheControl"]): void => {
    if (pending.length === 0) return;
    const block = anthropicTextBlock(pending.join("\n\n"), mark, marks);
    pending = [];
    if (block) blocks.push(block);
  };
  for (const m of messages) {
    for (const piece of systemPieces(m)) {
      if (!piece.text.trim()) continue;
      pending.push(piece.text);
      if (piece.mark) flush(piece.mark);
    }
  }
  flush();
  return blocks;
}

// ── Content parts ───────────────────────────────────────────────────────────

/** A unified content part, as opposed to arbitrary JSON a tool returned. */
export function isContentPart(value: unknown): value is ContentPart {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, any>;
  if (v.type === "text") return typeof v.text === "string";
  return (v.type === "image" || v.type === "file" || v.type === "audio") && !!v.source && typeof v.source === "object";
}

/** The `cache_control` for a caller's breakpoint: `ttl` only when it is not the 5-minute default. */
function wireCacheControl(cc: NonNullable<TextContent["cacheControl"]>): Record<string, any> {
  return cc.ttl === "1h" ? { type: "ephemeral", ttl: "1h" } : { type: "ephemeral" };
}

/**
 * A text block, with the caller's cache breakpoint when it has one. Blank text has
 * no block (the API rejects it), so a breakpoint on it is dropped with it.
 */
function anthropicTextBlock(text: string, cc: TextContent["cacheControl"], marks: Set<object>): Record<string, any> | undefined {
  if (!text.trim()) return undefined;
  if (!cc) return { type: "text", text };
  const cache_control = wireCacheControl(cc);
  marks.add(cache_control);
  return { type: "text", text, cache_control };
}

/** One unified content part as a Messages API block; undefined for blank text. */
function anthropicPart(part: ContentPart, marks: Set<object>): Record<string, any> | undefined {
  if (part.type === "text") return anthropicTextBlock(part.text, part.cacheControl, marks);
  if (part.type === "image") {
    const src = part.source;
    if (src.type === "base64") {
      return { type: "image", source: { type: "base64", media_type: src.mediaType, data: src.data } };
    }
    return { type: "image", source: { type: "url", url: src.url } };
  }
  if (part.type === "file") {
    const src = part.source;
    const title = part.fileName ? { title: part.fileName } : {};
    if (src.type === "base64") {
      return { type: "document", source: { type: "base64", media_type: src.mediaType, data: src.data }, ...title };
    }
    return { type: "document", source: { type: "url", url: src.url }, ...title };
  }
  if (part.type === "audio") {
    // Anthropic has no audio input; keep the reference visible.
    const src = part.source;
    return { type: "text", text: src.type === "url" ? `[audio: ${src.url}]` : "[audio attachment omitted: not supported by this model]" };
  }
  return part;
}

/** The text blocks of an assistant message (its other parts have no place in an assistant turn). */
function assistantTextBlocks(content: UnifiedMessage["content"], marks: Set<object>): Record<string, any>[] {
  const blocks: Record<string, any>[] = [];
  if (typeof content === "string") {
    const block = anthropicTextBlock(content, undefined, marks);
    if (block) blocks.push(block);
  } else if (Array.isArray(content)) {
    for (const part of content) {
      if (part.type !== "text") continue;
      const block = anthropicTextBlock(part.text, part.cacheControl, marks);
      if (block) blocks.push(block);
    }
  }
  return blocks;
}

function stringifyJson(value: unknown): string {
  try {
    return JSON.stringify(value) ?? "";
  } catch {
    return String(value);
  }
}

/**
 * `tool_result.content`: the text itself, or blocks when the result is made of
 * parts (text, images, documents). Never empty: an empty text block is a 400, so
 * a result with no output says so. Anything that is not text or parts (a JSON
 * value a host passed through) goes out as its JSON text.
 */
function toolResultContent(content: unknown, marks: Set<object>): string | Record<string, any>[] {
  if (typeof content === "string") return content.trim() ? content : EMPTY_TOOL_RESULT_TEXT;
  if (Array.isArray(content) && content.length === 0) return EMPTY_TOOL_RESULT_TEXT;
  const list: unknown[] = Array.isArray(content) ? content : [content];
  if (list.every(isContentPart)) {
    const blocks: Record<string, any>[] = [];
    for (const part of list as ContentPart[]) {
      const block = anthropicPart(part, marks);
      if (block) blocks.push(block);
    }
    return blocks.length > 0 ? blocks : EMPTY_TOOL_RESULT_TEXT;
  }
  const json = content == null ? "" : stringifyJson(content);
  return json.trim() ? json : EMPTY_TOOL_RESULT_TEXT;
}

// ── Cache breakpoints ───────────────────────────────────────────────────────

/** Where a `cache_control` came from: the caller's raw JSON (`extra`), a `cacheControl` text part, or the SDK's own strategy. */
type CacheOrigin = "raw" | "part" | "sdk";

type CacheHolder = { node: Record<string, any>; origin: CacheOrigin };

/**
 * The blocks of a built body that carry a `cache_control`, in the order the API reads
 * them: tools, system, messages (a tool result's own content included), then the
 * top-level field, which lands on the last cacheable block of the request.
 */
function cacheHolders(body: Record<string, any>, part: Set<object>, sdk: Set<object>): CacheHolder[] {
  const found: CacheHolder[] = [];
  const visit = (node: unknown): void => {
    if (!node || typeof node !== "object") return;
    const marker = (node as Record<string, any>).cache_control;
    if (marker == null) return;
    found.push({ node: node as Record<string, any>, origin: part.has(marker) ? "part" : sdk.has(marker) ? "sdk" : "raw" });
  };
  if (Array.isArray(body.tools)) body.tools.forEach((tool: unknown) => visit(tool));
  if (Array.isArray(body.system)) body.system.forEach((block: unknown) => visit(block));
  if (Array.isArray(body.messages)) {
    for (const message of body.messages) {
      const content = message && typeof message === "object" ? (message as Record<string, any>).content : undefined;
      if (!Array.isArray(content)) continue;
      for (const block of content) {
        visit(block);
        const inner = block && typeof block === "object" ? (block as Record<string, any>).content : undefined;
        if (Array.isArray(inner)) inner.forEach((nested: unknown) => visit(nested));
      }
    }
  }
  visit(body);
  return found;
}

/**
 * True when the last block of the request carries a breakpoint of another lifetime than
 * `marker`. That is where top-level automatic caching lands (the last cacheable block: a
 * thinking block cannot hold one, so the walk back skips it), and the API answers 400
 * when the two lifetimes differ (the same one is a no-op). A tool result counts when it,
 * or its last nested block, carries one. A message whose content is a plain string has
 * no block.
 */
function tailClashes(body: Record<string, any>, marker: Record<string, any>): boolean {
  const messages: unknown[] = Array.isArray(body.messages) ? body.messages : [];
  const last = messages.length > 0 ? messages[messages.length - 1] : undefined;
  const content = last && typeof last === "object" ? (last as Record<string, any>).content : undefined;
  if (!Array.isArray(content)) return false;
  for (let i = content.length - 1; i >= 0; i--) {
    const block = content[i];
    if (!block || typeof block !== "object" || block.type === "thinking" || block.type === "redacted_thinking") continue;
    let tail = block.cache_control;
    if (tail == null) {
      const inner = Array.isArray(block.content) ? block.content : undefined;
      const innerLast = inner && inner.length > 0 ? inner[inner.length - 1] : undefined;
      tail = innerLast && typeof innerLast === "object" ? innerLast.cache_control : undefined;
    }
    // Only "1h" is a longer lifetime; anything else is the 5-minute default.
    return tail != null && (tail.ttl === "1h") !== (marker.ttl === "1h");
  }
  return false;
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
