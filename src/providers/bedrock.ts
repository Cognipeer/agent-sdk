// AWS Bedrock Converse API provider.
// Uses AWS SigV4 signing with fetch – no AWS SDK dependency.

import { supportsForcedToolChoice, forcedToolChoiceRejected } from "./utils/toolChoice.js";
import { BaseProvider } from "./base.js";
import { signRequest, type SigV4Credentials } from "./utils/sigv4.js";
import { parseEventStream } from "./utils/eventStream.js";
import { applyBedrockReasoning, type ThinkingMode } from "./utils/reasoning.js";
import { resolveModelRule, applyDropParams, type RulePatch } from "../models/rules.js";
import { runWithModelAdjustments } from "../models/adjust.js";
import { chunkArray, mapWithConcurrency, assertVectorCount, requireEmbeddingModel } from "./utils/embeddings.js";
import { documentMimeToBedrockFormat, sanitizeBedrockDocName } from "./utils/media.js";
// What the two Messages-shaped providers share: the split of the system prompt into its
// static and per-turn parts, the pieces a caller's cache markers cut it into, the content
// part guard, the placeholders for empty text and the truncated-stream error.
import {
  partitionSystemMessages,
  systemPieces,
  isContentPart,
  truncatedStreamError,
  EMPTY_MESSAGE_TEXT,
  EMPTY_TOOL_RESULT_TEXT,
} from "./anthropic.js";
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
  type BedrockProviderConfig,
  type PromptCachingConfig,
  type EmbeddingRequest,
  type EmbeddingResponse,
  type ProviderType,
  type TextContent,
  ProviderError,
} from "./types.js";

type BedrockCacheFamily = "claude" | "nova" | "none" | "unknown";

// Converse families without explicit prompt caching (checkpoints raise a ValidationException).
const NON_CACHING_FAMILIES = /^(meta|mistral|cohere|ai21|deepseek|openai|qwen|writer|stability|luma|twelvelabs|amazon\.titan)\b/;

/**
 * Classifies a Converse model id for prompt caching. A region / inference-profile
 * prefix (`us.`, `eu.`, `apac.`, `global.`, `us-gov.`, ...) is ignored. ARNs and
 * application inference profiles hide the family, so they are "unknown".
 */
function bedrockCacheFamily(modelId: string): BedrockCacheFamily {
  const id = String(modelId ?? "").toLowerCase();
  if (id.startsWith("arn:")) return "unknown";
  const bare = id.replace(/^(?:us-gov|us|eu|apac|jp|au|ca|global)\./, "");
  if (bare.startsWith("anthropic.claude")) return "claude";
  if (bare.startsWith("amazon.nova")) return "nova";
  if (NON_CACHING_FAMILIES.test(bare)) return "none";
  return "unknown";
}

/**
 * Whether a Converse model id takes the 1-hour cache TTL: Claude 4.5 and later only
 * (Opus/Sonnet/Haiku 4.5+, every 5.x). Claude 3.x, 4.0/4.1, Nova and anything unrecognised
 * are 5-minute only, and a `ttl` there can raise a ValidationException, so the field is
 * left out. An ARN / inference-profile id is read by its last path segment; an opaque
 * application profile id is unknown and gets no ttl.
 */
function bedrockSupportsOneHourTtl(modelId: string): boolean {
  const last = String(modelId ?? "").toLowerCase().split("/").pop() ?? "";
  const bare = last.replace(/^(?:us-gov|us|eu|apac|jp|au|ca|global)\./, "").replace(/^anthropic\./, "");
  const m = /^claude-(?:opus|sonnet|haiku|fable|mythos)-(\d+)(?:-(\d{1,2})(?!\d))?(?=[-:]|$)/.exec(bare);
  if (!m) return false;
  const major = Number(m[1]);
  const minor = m[2] ? Number(m[2]) : 0;
  return major > 4 || (major === 4 && minor >= 5);
}

/** Converse accepts at most this many cache checkpoints per request (Claude and Nova alike). */
const MAX_CACHE_CHECKPOINTS = 4;

type CacheControl = NonNullable<TextContent["cacheControl"]>;

/** What one request body is built against: the model's caching family and the checkpoints made from the caller's parts. */
type BuildCtx = {
  family: BedrockCacheFamily;
  /** The model takes the 1-hour cache TTL (see bedrockSupportsOneHourTtl). */
  oneHour: boolean;
  /** The `cachePoint` blocks made from the caller's `cacheControl` text parts (as opposed to the SDK's own or raw `extra` ones). */
  parts: Set<object>;
};

/** The blocks of the built request the SDK made itself, so the checkpoint pass never touches what `extra` replaced. */
type OwnBlocks = {
  system?: Record<string, any>[];
  /** The last block of the static system prefix: where the SDK's system checkpoint goes after. */
  lastStatic?: Record<string, any>;
  tools?: Record<string, any>[];
  messages?: Record<string, any>[];
};

export class BedrockProvider extends BaseProvider {
  readonly providerName: ProviderType = "bedrock";

  private readonly region: string;
  private readonly credentials: SigV4Credentials;
  private readonly defaultModel: string;
  private readonly defaultHeaders: Record<string, string>;

  private readonly promptCachingEnabled: boolean;
  private readonly promptCaching: Required<Omit<PromptCachingConfig, "enabled">>;

  private readonly thinkingMode: ThinkingMode;

  constructor(config: BedrockProviderConfig) {
    super();
    this.configureTransport(config);
    this.region = config.region;
    this.defaultModel = config.defaultModel ?? "anthropic.claude-sonnet-4-20250514-v1:0";
    this.defaultHeaders = config.defaultHeaders ?? {};
    this.thinkingMode = config.thinkingMode ?? "auto";
    this.promptCachingEnabled = config.prompt_caching?.enabled === true;
    this.promptCaching = {
      strategy: config.prompt_caching?.strategy ?? "auto",
      ttl: config.prompt_caching?.ttl ?? "5m",
    };
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
    const res = await this.converseFetch(modelId, request, false);
    return this.parseResponse(await res.json(), modelId);
  }

  /**
   * Real streaming over ConverseStream. The response is an AWS event-stream
   * (binary frames); each frame carries one JSON event: messageStart,
   * contentBlockStart/Delta/Stop (text, toolUse, reasoningContent),
   * messageStop and, last, metadata (usage). Text, tool-call argument and
   * reasoning deltas are yielded as they arrive; one closing chunk carries the
   * finish reason, usage and the signed reasoning blocks.
   */
  async *completeStream(request: ChatCompletionRequest): AsyncGenerator<ChatCompletionChunk, void, unknown> {
    const modelId = request.model || this.defaultModel;
    const res = await this.converseFetch(modelId, request, true);
    if (!res.body) throw new ProviderError("No response body for stream", this.providerName);

    const id = res.headers.get("x-amzn-requestid") ?? "";
    const toolsByIndex = new Map<number, { id: string; name: string; ordinal: number }>();
    const reasoningByIndex = new Map<number, ReasoningBlock>();
    let finishReason: ChatCompletionResponse["finishReason"] | undefined;
    let rawFinishReason: string | undefined;
    let toolOrdinal = 0;
    let usage: TokenUsage | undefined;
    // True once `messageStop` (the event that carries the stop reason) has arrived.
    let stopped = false;

    for await (const msg of parseEventStream(res.body, request.signal)) {
      const messageType = String(msg.headers[":message-type"] ?? "event");
      const eventType = String(msg.headers[":event-type"] ?? msg.headers[":exception-type"] ?? "");
      let data: any = {};
      const text = new TextDecoder().decode(msg.payload);
      if (text) {
        try { data = JSON.parse(text); } catch { data = { message: text }; }
      }

      if (messageType === "exception" || messageType === "error") {
        const code = String(msg.headers[":exception-type"] ?? msg.headers[":error-code"] ?? eventType);
        throw new ProviderError(
          `Bedrock stream error ${code}: ${data.message ?? text}`,
          this.providerName,
          bedrockExceptionStatus(code),
          data,
        );
      }

      switch (eventType) {
        case "contentBlockStart": {
          const idx = data.contentBlockIndex ?? 0;
          const tu = data.start?.toolUse;
          if (tu) {
            const ordinal = toolOrdinal++;
            toolsByIndex.set(idx, { id: tu.toolUseId ?? "", name: tu.name ?? "", ordinal });
            yield { id, model: modelId, delta: { toolCalls: [{ id: tu.toolUseId, name: tu.name, arguments: "", index: ordinal }] } };
          }
          break;
        }
        case "contentBlockDelta": {
          const idx = data.contentBlockIndex ?? 0;
          const d = data.delta ?? {};
          if (typeof d.text === "string" && d.text) {
            yield { id, model: modelId, delta: { content: d.text } };
          } else if (d.toolUse) {
            const tc = toolsByIndex.get(idx);
            if (tc && typeof d.toolUse.input === "string" && d.toolUse.input) {
              yield { id, model: modelId, delta: { toolCalls: [{ id: tc.id, name: tc.name, arguments: d.toolUse.input, index: tc.ordinal }] } };
            }
          } else if (d.reasoningContent) {
            const rc = d.reasoningContent;
            const blk: ReasoningBlock = reasoningByIndex.get(idx) ?? { type: "thinking", text: "" };
            if (typeof rc.text === "string" && rc.text) {
              blk.text = (blk.text ?? "") + rc.text;
              reasoningByIndex.set(idx, blk);
              yield { id, model: modelId, delta: { reasoning: { summary: rc.text } } };
            }
            if (typeof rc.signature === "string" && rc.signature) {
              blk.signature = (blk.signature ?? "") + rc.signature;
              reasoningByIndex.set(idx, blk);
            }
            if (rc.redactedContent) {
              reasoningByIndex.set(idx, { type: "redacted_thinking", data: rc.redactedContent });
            }
          }
          break;
        }
        case "messageStop":
          stopped = true;
          finishReason = mapBedrockStopReason(data.stopReason);
          if (typeof data.stopReason === "string") rawFinishReason = data.stopReason;
          break;
        case "metadata": {
          // The ONLY usage event of a Converse stream (`messageStart` carries none), so a
          // stream cut before it reports no usage: unlike Anthropic's `message_start`
          // there is no early input count to capture. A host that must bill a cancelled
          // Bedrock stream estimates the input itself.
          // Native basis: `inputTokens` leaves out the cache read + write (the adapter
          // adds them); `totalTokens` is input + output, not the service's own figure,
          // which is not documented to cover the same parts.
          const u = data.usage ?? {};
          usage = {
            inputTokens: u.inputTokens ?? 0,
            outputTokens: u.outputTokens ?? 0,
            totalTokens: (u.inputTokens ?? 0) + (u.outputTokens ?? 0),
            cachedInputTokens: u.cacheReadInputTokens ?? u.cacheReadInputTokenCount ?? 0,
            cachedWriteTokens: u.cacheWriteInputTokens ?? u.cacheWriteInputTokenCount ?? 0,
            cachedOutputTokens: 0,
            reasoningTokens: 0,
          };
          break;
        }
        default:
          break; // messageStart, contentBlockStop, unknown events
      }
    }

    // The body ended with no `messageStop`: the connection was cut, not the message
    // finished. Closing with a "stop" would hand the caller half a message (a tool call
    // whose arguments stop halfway) as if it were whole, so it is the same retryable
    // failure as a cut Anthropic stream. A caller that cancelled the call ended it
    // itself: that is not an error.
    if (!stopped) {
      if (request.signal?.aborted) return;
      throw truncatedStreamError(this.providerName, "Bedrock");
    }

    const blocks = [...reasoningByIndex.values()].filter(
      (b) => (b.type === "thinking" && b.signature) || (b.type === "redacted_thinking" && b.data),
    );
    yield {
      id,
      model: modelId,
      delta: blocks.length > 0 ? { reasoning: { blocks } } : {},
      finishReason: finishReason ?? "stop",
      ...(rawFinishReason ? { rawFinishReason } : {}),
      usage,
    };
  }

  // ─── Embeddings ──────────────────────────────────────────────────────────

  /**
   * InvokeModel embeddings. Supported families (by model id, inference-profile
   * prefixes such as `us.` allowed):
   *  - Amazon Titan Text Embeddings (v1, v2): one text per call, `dimensions`
   *    (v2: 256/512/1024) and `normalize` via `extra`.
   *  - Cohere Embed (v3, v4): a batch of texts per call (default 96), `inputType`
   *    maps to `input_type`, `dimensions` to `output_dimension` (v4).
   */
  override async embed(request: EmbeddingRequest): Promise<EmbeddingResponse> {
    const model = requireEmbeddingModel(this.providerName, request.model);
    const id = model.toLowerCase();
    const raw: any[] = [];
    let inputTokens = 0;
    let vectors: number[][] = [];

    if (id.includes("titan-embed")) {
      const results = await mapWithConcurrency(request.input, 4, async (text) => {
        const body: Record<string, any> = { inputText: text };
        if (request.dimensions != null && !id.includes("titan-embed-text-v1")) body.dimensions = request.dimensions;
        if (request.extra) Object.assign(body, request.extra);
        const res = await this.invokeModel(model, body, request.signal);
        const json: any = await res.json();
        return { json, tokens: json.inputTextTokenCount ?? Number(res.headers.get("x-amzn-bedrock-input-token-count") ?? 0) };
      }, request.signal);
      for (const r of results) {
        raw.push(r.json);
        inputTokens += r.tokens || 0;
        vectors.push(r.json.embedding ?? r.json.embeddingsByType?.float);
      }
    } else if (id.includes("cohere.embed")) {
      for (const batch of chunkArray(request.input, request.batchSize ?? 96)) {
        const body: Record<string, any> = {
          texts: batch,
          input_type: request.inputType ?? "search_document",
          embedding_types: ["float"],
        };
        if (request.dimensions != null) body.output_dimension = request.dimensions;
        if (request.extra) Object.assign(body, request.extra);
        const res = await this.invokeModel(model, body, request.signal);
        const json: any = await res.json();
        raw.push(json);
        // v3: embeddings is number[][]; with embedding_types (and v4): { float: number[][] }.
        const emb = Array.isArray(json.embeddings) ? json.embeddings : json.embeddings?.float;
        vectors.push(...(emb ?? []));
        inputTokens += Number(res.headers.get("x-amzn-bedrock-input-token-count") ?? 0) || 0;
      }
    } else {
      throw new ProviderError(
        `Bedrock embeddings are supported for Amazon Titan and Cohere Embed models, not "${model}"`,
        this.providerName,
        400,
      );
    }

    assertVectorCount(this.providerName, vectors, request.input.length);
    return { model, vectors, usage: { inputTokens, totalTokens: inputTokens }, raw };
  }

  private async invokeModel(modelId: string, body: Record<string, any>, signal?: AbortSignal): Promise<Response> {
    const host = `bedrock-runtime.${this.region}.amazonaws.com`;
    const url = `https://${host}/model/${encodeURIComponent(modelId)}/invoke`;
    const bodyStr = JSON.stringify(body);
    const res = await this.doFetchWithRetry(() => {
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
      return this.httpFetch(url, { method: "POST", headers, body: bodyStr, signal });
    }, signal);
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new ProviderError(`Bedrock API error ${res.status}: ${text}`, this.providerName, res.status, text);
    }
    return res;
  }

  // ─── Internals ───────────────────────────────────────────────────────────

  private buildConverseBody(request: ChatCompletionRequest, downgradeToolChoice = false, overlay?: RulePatch): Record<string, any> {
    // "unknown" families (ARNs, application profiles) keep the 0.20 behaviour: the
    // caller opted in, so checkpoints are sent. A family with no explicit caching
    // takes none at all (a ValidationException), the caller's own markers included.
    const cacheModel = request.model || this.defaultModel;
    const ctx: BuildCtx = { family: bedrockCacheFamily(cacheModel), oneHour: bedrockSupportsOneHourTtl(cacheModel), parts: new Set<object>() };

    // The system prompt that does not change between turns comes first and the SDK's
    // own per-turn blocks (summary, memory, plugin and reflection context) after it, so
    // the checkpoint can sit between the two instead of after text that changes every turn.
    const { staticSystem, dynamicSystem, rest } = partitionSystemMessages(request.messages);
    const staticBlocks = this.toBedrockSystem(staticSystem, ctx);
    const systemBlocks = [...staticBlocks, ...this.toBedrockSystem(dynamicSystem, ctx)];
    const messages = this.toBedrockMessages(rest, ctx);

    const body: Record<string, any> = { messages };
    if (systemBlocks.length > 0) body.system = systemBlocks;

    // Inference config
    const inferenceConfig: Record<string, any> = {};
    if (request.maxTokens != null) inferenceConfig.maxTokens = request.maxTokens;
    if (request.temperature != null) inferenceConfig.temperature = request.temperature;
    if (request.topP != null) inferenceConfig.topP = request.topP;
    if (request.stop) inferenceConfig.stopSequences = request.stop;
    if (Object.keys(inferenceConfig).length > 0) body.inferenceConfig = inferenceConfig;

    // Tools (the SDK's checkpoint, a {cachePoint} block at the end of the array, is
    // added with the others once the body is finished)
    let ownTools: Record<string, any>[] | undefined;
    if (request.tools?.length) {
      ownTools = request.tools.map((t) => this.toBedrockTool(t));
      body.toolConfig = {
        tools: ownTools,
      };

      const forceOk = !downgradeToolChoice && supportsForcedToolChoice(request.model || this.defaultModel);
      if (request.toolChoice != null) {
        if (request.toolChoice === "auto" || (!forceOk && request.toolChoice !== "none")) {
          body.toolConfig.toolChoice = { auto: {} };
        } else if (request.toolChoice === "required") {
          body.toolConfig.toolChoice = { any: {} };
        } else if (typeof request.toolChoice === "object") {
          body.toolConfig.toolChoice = { tool: { name: request.toolChoice.name } };
        }
      }
    }

    if (request.extra) {
      // Converse's own top-level fields stay where they are; every other key is
      // model-specific and travels in additionalModelRequestFields.
      // Build the merged object explicitly: never assign or mutate the caller's.
      const fields: Record<string, any> = { ...(request.extra.additionalModelRequestFields ?? {}) };
      const topLevel: Record<string, any> = { ...((request.extra as any).__top ?? {}) };
      for (const [key, value] of Object.entries(request.extra)) {
        if (key === "additionalModelRequestFields" || key === "__top") continue;
        if (CONVERSE_TOP_LEVEL_FIELDS.has(key)) body[key] = value;
        else fields[key] = value;
      }
      // `extra.__top` forces keys to the Converse top level, bypassing the allow-list.
      Object.assign(body, topLevel);
      if (Object.keys(fields).length > 0) body.additionalModelRequestFields = fields;
    }

    // Native reasoning: maps to additionalModelRequestFields.thinking and
    // enforces the budget/temperature rules for thinking-capable models.
    const rule = resolveModelRule({ provider: this.providerName, model: request.model || this.defaultModel, patch: overlay });
    applyBedrockReasoning(body, request.reasoning, { model: request.model || this.defaultModel, mode: this.thinkingMode, rule });
    // Converse names sampling fields in camelCase inside inferenceConfig.
    if (body.inferenceConfig && rule.dropParams?.length) {
      for (const p of rule.dropParams) delete body.inferenceConfig[p === "top_p" ? "topP" : p === "max_tokens" ? "maxTokens" : p];
    }
    applyDropParams(body, rule);

    // Last, on the finished body: `extra` may have replaced any of its parts, and its
    // own checkpoints count against the limit too.
    this.settleCheckpoints(
      body,
      { system: systemBlocks, lastStatic: staticBlocks[staticBlocks.length - 1], tools: ownTools, messages },
      ctx,
    );

    return body;
  }

  /**
   * The `system` blocks of a group of system messages: one text block per message
   * (blank text has no block: Converse rejects it), cut after each text part the
   * caller marked for caching, which gets a checkpoint right after it.
   */
  private toBedrockSystem(messages: UnifiedMessage[], ctx: BuildCtx): Record<string, any>[] {
    const blocks: Record<string, any>[] = [];
    for (const m of messages) {
      for (const piece of systemPieces(m)) blocks.push(...textBlocks(piece.text, piece.mark, ctx));
    }
    return blocks;
  }

  /**
   * Settles the cache checkpoints of a finished body so a request never carries more
   * than the 4 Converse accepts. In order:
   *  1. The caller's own come first: the `cacheControl` of text parts and any
   *     `cachePoint` in `extra`. Over the limit, the earliest ones made from parts are
   *     dropped (a later checkpoint covers a longer prefix); a raw `extra` one is
   *     never touched. They are sent whether or not `prompt_caching` is enabled: that
   *     switch is for the SDK's own, and a marker is an explicit request.
   *  2. The SDK's own, only while a slot is free (`prompt_caching.enabled`) and only on
   *     blocks it built: after the static system prompt, after the tools (not on Nova,
   *     which takes none there) and, with strategy `auto`, at the end of the last user
   *     message: a rolling breakpoint, each request writes at the new tail and reads
   *     the previous prefix (Bedrock looks back ~20 content blocks). A checkpoint the
   *     caller already put at that spot counts as the SDK's.
   *  3. A longer lifetime may not come after a shorter one: in the order Bedrock reads
   *     them (tools, system, messages) a 1h checkpoint after a 5m one is sent as 5m.
   *     Only the ones the SDK made (from parts, or its own) are changed.
   */
  private settleCheckpoints(body: Record<string, any>, own: OwnBlocks, ctx: BuildCtx): void {
    const sdk = new Set<object>();
    const found = checkpointHolders(body, ctx.parts, sdk);
    let count = found.length;
    for (const holder of found) {
      if (count <= MAX_CACHE_CHECKPOINTS) break;
      if (holder.origin !== "part") continue;
      holder.list.splice(holder.list.indexOf(holder.block), 1);
      count--;
    }

    if (this.promptCachingEnabled && ctx.family !== "none") {
      const add = (list: Record<string, any>[], at: number): void => {
        const block = cachePointBlock(ctx.oneHour, this.promptCaching.ttl);
        list.splice(at, 0, block);
        sdk.add(block);
        count++;
      };
      const system = own.system;
      if (count < MAX_CACHE_CHECKPOINTS && system && own.lastStatic && body.system === system && !own.lastStatic.cachePoint) {
        const after = system.indexOf(own.lastStatic);
        if (after >= 0) add(system, after + 1);
      }
      const tools = own.tools;
      if (count < MAX_CACHE_CHECKPOINTS && ctx.family !== "nova" && tools && tools.length > 0 && body.toolConfig?.tools === tools && !tools[tools.length - 1].cachePoint) {
        add(tools, tools.length);
      }
      const messages = own.messages;
      if (count < MAX_CACHE_CHECKPOINTS && this.promptCaching.strategy === "auto" && messages && body.messages === messages) {
        const last = messages[messages.length - 1];
        const content = last?.role === "user" ? last.content : undefined;
        if (Array.isArray(content) && content.length > 0 && !content[content.length - 1].cachePoint) add(content, content.length);
      }
    }

    let shorter = false;
    for (const holder of checkpointHolders(body, ctx.parts, sdk)) {
      const point = holder.block.cachePoint as Record<string, any>;
      if (point.ttl !== "1h") shorter = true;
      else if (shorter && holder.origin !== "raw") delete point.ttl;
    }
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
  private toBedrockMessages(messages: UnifiedMessage[], ctx: BuildCtx): Record<string, any>[] {
    const result: Record<string, any>[] = [];
    let mergingToolResults = false;

    for (const m of messages) {
      if (m.role === "tool" && m.toolCallId) {
        const blocks = this.toBedrockToolResult(m, ctx);
        if (mergingToolResults) {
          result[result.length - 1].content.push(...blocks);
        } else {
          result.push({ role: "user", content: blocks });
          mergingToolResults = true;
        }
        continue;
      }

      mergingToolResults = false;
      result.push(this.toBedrockMessage(m, ctx));
    }

    return result;
  }

  /**
   * One tool result: the `toolResult` block (`status` "error" when the host flagged the
   * result as one, which Converse documents for Nova and Claude), then a checkpoint
   * when a text part of the result carried the caller's `cacheControl`: a toolResult
   * has no cachePoint member of its own, so it goes after the whole block.
   */
  private toBedrockToolResult(m: UnifiedMessage, ctx: BuildCtx): Record<string, any>[] {
    return [
      {
        toolResult: {
          toolUseId: m.toolCallId,
          content: toolResultContent(m.content, ctx),
          status: m.isError ? "error" : "success",
        },
      },
      ...callerCheckpoint(ctx, toolResultMark(m.content)),
    ];
  }

  private toBedrockMessage(m: UnifiedMessage, ctx: BuildCtx): Record<string, any> {
    // Assistant with tool calls
    if (m.role === "assistant" && m.toolCalls?.length) {
      const content: any[] = [];
      appendBedrockReasoning(content, m.reasoning?.blocks);
      if (typeof m.content === "string") {
        content.push(...textBlocks(m.content, undefined, ctx));
      } else if (Array.isArray(m.content)) {
        for (const part of m.content) {
          if (part.type === "text") content.push(...textBlocks(part.text, part.cacheControl, ctx));
        }
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

    // Regular messages. Converse rejects a blank text block, so blank text is dropped,
    // and a message left with nothing carries a placeholder instead.
    const content: any[] = [];
    if (typeof m.content === "string") {
      content.push(...textBlocks(m.content, undefined, ctx));
    } else if (Array.isArray(m.content)) {
      for (const part of m.content) content.push(...partBlocks(part, ctx));
    }
    if (content.length === 0) content.push({ text: EMPTY_MESSAGE_TEXT });

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

  /** Sends the Converse call; retries once with toolChoice auto when the
   * model rejects forced tool use. */
  private converseFetch(modelId: string, request: ChatCompletionRequest, stream: boolean): Promise<Response> {
    let downgrade = false;
    return runWithModelAdjustments({
      provider: this.providerName,
      model: modelId,
      endpoint: "converse",
      callerParams: request.extra ? Object.keys(request.extra) : undefined,
      onLearned: this.onModelRuleLearned,
      run: async (overlay, guard) => {
        for (;;) {
          const body = this.buildConverseBody(request, downgrade, overlay);
          guard(body);
          try {
            return await this.doFetch(modelId, body, request.signal, stream);
          } catch (err) {
            const tc = body.toolConfig?.toolChoice;
            const rejected = err instanceof ProviderError && err.statusCode === 400 && !downgrade && !!tc && !tc.auto
              && forcedToolChoiceRejected(String(err.responseBody ?? err.message));
            if (!rejected) throw err;
            downgrade = true;
          }
        }
      },
    });
  }

  private async doFetch(modelId: string, body: Record<string, any>, signal: AbortSignal | undefined, stream: boolean): Promise<Response> {
    const host = `bedrock-runtime.${this.region}.amazonaws.com`;
    const url = `https://${host}/model/${encodeURIComponent(modelId)}/${stream ? "converse-stream" : "converse"}`;
    const bodyStr = JSON.stringify(body);

    const res = await this.doFetchWithRetry(() => {
      // SigV4 must re-sign on each retry because of the x-amz-date header.
      const headers = signRequest({
        method: "POST",
        url,
        headers: {
          "Content-Type": "application/json",
          Accept: stream ? "application/vnd.amazon.eventstream" : "application/json",
          ...this.defaultHeaders,
        },
        body: bodyStr,
        region: this.region,
        service: "bedrock",
        credentials: this.credentials,
      });
      return this.httpFetch(url, { method: "POST", headers, body: bodyStr, signal });
    }, signal);

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new ProviderError(
        `Bedrock API error ${res.status}: ${text}`,
        this.providerName,
        res.status,
        text,
      );
    }

    return res;
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
      // Native basis (see the stream's `metadata`): input leaves out the cache, total = input + output.
      totalTokens: (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0),
      cachedInputTokens: usage.cacheReadInputTokens ?? usage.cacheReadInputTokenCount ?? 0,
      cachedWriteTokens: usage.cacheWriteInputTokens ?? usage.cacheWriteInputTokenCount ?? 0,
      cachedOutputTokens: 0,
      // Bedrock bills thinking tokens inside outputTokens and reports no separate count: 0 = not reported.
      reasoningTokens: 0,
    };

    return {
      id: json.requestId ?? json.$metadata?.requestId ?? "",
      model: modelId,
      content: textParts.join("") || null,
      toolCalls,
      usage: tokenUsage,
      finishReason: mapBedrockStopReason(json.stopReason),
      ...(typeof json.stopReason === "string" ? { rawFinishReason: json.stopReason } : {}),
      reasoning: reasoningBlocks.length > 0
        ? { blocks: reasoningBlocks, summary: summaryParts.join("\n").trim() || undefined }
        : undefined,
      raw: json,
    };
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Fields the Converse / ConverseStream request defines itself. */
const CONVERSE_TOP_LEVEL_FIELDS = new Set([
  "messages", "system", "inferenceConfig", "toolConfig", "guardrailConfig",
  "additionalModelRequestFields", "additionalModelResponseFieldPaths",
  "promptVariables", "requestMetadata", "performanceConfig", "serviceTier", "outputConfig",
]);

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

// ── Cache checkpoints ───────────────────────────────────────────────────────

/**
 * A `cachePoint` content block (Converse: `type: "default"`, optional `ttl` of `5m` or
 * `1h`). The ttl is sent for 1h only (the 5-minute default is the API's own) and only
 * for a model that takes it: on a 5-minute-only model a ttl can raise a ValidationException.
 */
function cachePointBlock(oneHour: boolean, ttl: CacheControl["ttl"] | undefined): Record<string, any> {
  return { cachePoint: ttl === "1h" && oneHour ? { type: "default", ttl: "1h" } : { type: "default" } };
}

/** The checkpoint the caller asked for after a block: none when it asked for none, or when the model takes none. */
function callerCheckpoint(ctx: BuildCtx, cc: CacheControl | undefined): Record<string, any>[] {
  if (!cc || ctx.family === "none") return [];
  const block = cachePointBlock(ctx.oneHour, cc.ttl);
  ctx.parts.add(block);
  return [block];
}

/**
 * A text part as Converse blocks: the text, then the caller's checkpoint when it marked
 * the part. Blank text has no block (Converse rejects it) and a checkpoint on it goes
 * with it, so a checkpoint never follows nothing.
 */
function textBlocks(text: string, cc: CacheControl | undefined, ctx: BuildCtx): Record<string, any>[] {
  return text.trim() ? [{ text }, ...callerCheckpoint(ctx, cc)] : [];
}

/** Where a built body carries a `cachePoint`: the block, the array it sits in and who made it. */
type CheckpointHolder = { list: Record<string, any>[]; block: Record<string, any>; origin: "raw" | "part" | "sdk" };

/** Every `cachePoint` block of a built body, in the order Bedrock reads them: tools, system, messages. */
function checkpointHolders(body: Record<string, any>, parts: Set<object>, sdk: Set<object>): CheckpointHolder[] {
  const found: CheckpointHolder[] = [];
  const visit = (list: unknown): void => {
    if (!Array.isArray(list)) return;
    for (const block of list) {
      if (!block || typeof block !== "object" || !(block as Record<string, any>).cachePoint) continue;
      found.push({ list, block, origin: parts.has(block) ? "part" : sdk.has(block) ? "sdk" : "raw" });
    }
  };
  visit(body.toolConfig?.tools);
  visit(body.system);
  if (Array.isArray(body.messages)) {
    for (const message of body.messages) visit(message && typeof message === "object" ? (message as Record<string, any>).content : undefined);
  }
  return found;
}

// ── Content parts ───────────────────────────────────────────────────────────

/**
 * One content part of a message (or, with `inToolResult`, of a tool result) as Converse
 * blocks. Converse takes no URL source for an image or a document and no audio, so
 * those keep a visible text reference. The text of a tool result takes no checkpoint
 * here (see `toolResultMark`).
 */
function partBlocks(part: ContentPart, ctx: BuildCtx, inToolResult = false): Record<string, any>[] {
  if (part.type === "text") return textBlocks(part.text, inToolResult ? undefined : part.cacheControl, ctx);
  if (part.type === "image") {
    const src = part.source;
    if (src.type !== "base64") return [{ text: `[image: ${src.url}]` }];
    // An image inside a tool result is documented for Nova and Claude only.
    if (inToolResult && ctx.family === "none") {
      return [{ text: "[image attachment omitted: not supported in tool results by this model]" }];
    }
    return [{ image: { format: mediaTypeToFormat(src.mediaType), source: { bytes: src.data } } }];
  }
  if (part.type === "file") {
    const src = part.source;
    const format = documentMimeToBedrockFormat(src.mediaType, part.fileName);
    if (src.type === "base64" && format) {
      return [{ document: { format, name: sanitizeBedrockDocName(part.fileName), source: { bytes: src.data } } }];
    }
    // Converse has no URL document source / unknown format; keep the reference visible.
    const ref = src.type === "url" ? src.url : part.fileName ?? "attachment";
    return [{ text: `[file: ${ref}]` }];
  }
  const src = part.source;
  return [{ text: src.type === "url" ? `[audio: ${src.url}]` : "[audio attachment omitted: not supported by this model]" }];
}

/**
 * `toolResult.content`: text, images and documents when the result is made of parts,
 * one `json` block for a JSON object a host passed through, the JSON text for anything
 * else. Never empty: Converse rejects a blank text block (and some models an empty
 * array), so a result with no output says so.
 */
function toolResultContent(content: unknown, ctx: BuildCtx): Record<string, any>[] {
  if (typeof content === "string") return [{ text: content.trim() ? content : EMPTY_TOOL_RESULT_TEXT }];
  const list: unknown[] = Array.isArray(content) ? content : content == null ? [] : [content];
  if (list.length === 0) return [{ text: EMPTY_TOOL_RESULT_TEXT }];
  if (list.every(isContentPart)) {
    const blocks = (list as ContentPart[]).flatMap((part) => partBlocks(part, ctx, true));
    return blocks.length > 0 ? blocks : [{ text: EMPTY_TOOL_RESULT_TEXT }];
  }
  return [structuredResultBlock(content)];
}

/**
 * A JSON value a host passed through as a tool result. Converse takes a JSON OBJECT in a
 * `json` block: an array or any scalar there is a ValidationException ("Provide a json
 * object for the field"), although the API reference types it as any JSON value. So an
 * object goes out as one (a plain JSON copy, nothing a JSON body cannot carry reaches
 * the wire) and everything else as its JSON text.
 */
function structuredResultBlock(value: unknown): Record<string, any> {
  let text: string;
  try {
    text = JSON.stringify(value) ?? "";
  } catch {
    text = String(value);
  }
  if (!text.trim()) return { text: EMPTY_TOOL_RESULT_TEXT };
  try {
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return { json: parsed };
  } catch {
    // Not JSON (the String() of a value that has no JSON form): sent as text.
  }
  return { text };
}

/**
 * The caching marker among a tool result's text parts (the last marked one with text in
 * it). A toolResult content block has no cachePoint member, so the marker becomes one
 * checkpoint after the whole toolResult block.
 */
function toolResultMark(content: unknown): CacheControl | undefined {
  if (!Array.isArray(content) || !content.every(isContentPart)) return undefined;
  let mark: CacheControl | undefined;
  for (const part of content as ContentPart[]) {
    if (part.type === "text" && part.text.trim() && part.cacheControl) mark = part.cacheControl;
  }
  return mark;
}

function bedrockExceptionStatus(code: string): number | undefined {
  switch (code) {
    case "throttlingException": return 429;
    case "validationException": return 400;
    case "modelTimeoutException": return 408;
    case "serviceUnavailableException": return 503;
    case "internalServerException":
    case "modelStreamErrorException": return 500;
    default: return undefined;
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
    case "model_context_window_exceeded":
      return "length";
    // A content filter or a guardrail withheld the answer: an HTTP 200, not an error.
    case "content_filtered":
    case "guardrail_intervened":
    case "guardrail":
      return "content_filter";
    // The model's own output (`malformed_model_output`) or its tool call
    // (`malformed_tool_use`) came out malformed: the turn did not finish properly, so it
    // is not a "stop". The raw value stays in `rawFinishReason` for a host that retries.
    case "malformed_model_output":
    case "malformed_tool_use":
      return "error";
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
