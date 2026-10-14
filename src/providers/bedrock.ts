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
  type EmbeddingRequest,
  type EmbeddingResponse,
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

  private readonly thinkingMode: ThinkingMode;

  constructor(config: BedrockProviderConfig) {
    super();
    this.configureTransport(config);
    this.region = config.region;
    this.defaultModel = config.defaultModel ?? "anthropic.claude-sonnet-4-20250514-v1:0";
    this.defaultHeaders = config.defaultHeaders ?? {};
    this.thinkingMode = config.thinkingMode ?? "auto";
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
          finishReason = mapBedrockStopReason(data.stopReason);
          if (typeof data.stopReason === "string") rawFinishReason = data.stopReason;
          break;
        case "metadata": {
          const u = data.usage ?? {};
          usage = {
            inputTokens: u.inputTokens ?? 0,
            outputTokens: u.outputTokens ?? 0,
            totalTokens: u.totalTokens ?? (u.inputTokens ?? 0) + (u.outputTokens ?? 0),
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
        } else if (part.type === "file") {
          const src = part.source;
          const format = documentMimeToBedrockFormat(src.mediaType, part.fileName);
          if (src.type === "base64" && format) {
            content.push({
              document: {
                format,
                name: sanitizeBedrockDocName(part.fileName),
                source: { bytes: src.data },
              },
            });
          } else {
            // Converse has no URL document source / unknown format; keep the reference visible.
            const ref = src.type === "url" ? src.url : part.fileName ?? "attachment";
            content.push({ text: `[file: ${ref}]` });
          }
        } else if (part.type === "audio") {
          const src = part.source;
          content.push({ text: src.type === "url" ? `[audio: ${src.url}]` : "[audio attachment omitted: not supported by this model]" });
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
      totalTokens: usage.totalTokens ?? (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0),
      cachedInputTokens: usage.cacheReadInputTokens ?? usage.cacheReadInputTokenCount ?? 0,
      cachedWriteTokens: usage.cacheWriteInputTokens ?? usage.cacheWriteInputTokenCount ?? 0,
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
    case "content_filtered":
    case "guardrail_intervened":
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
