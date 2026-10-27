// Google Vertex AI provider: Gemini models, and Claude models (see vertexAnthropic.ts).
// Direct fetch-based implementation – supports both access token and service account auth.

import { BaseProvider } from "./base.js";
import { parseSSEStream } from "./utils/sse.js";
import { applyGeminiReasoning } from "./utils/reasoning.js";
import { ModelRequestError } from "../models/errors.js";
import { parseModelError } from "../models/adjust.js";
import { resolveModelRule } from "../models/rules.js";
import { inferMediaTypeFromUrl } from "./utils/media.js";
import { sanitizeGeminiSchema } from "./utils/geminiSchema.js";
import { chunkArray, assertVectorCount, requireEmbeddingModel } from "./utils/embeddings.js";
import { VertexAnthropicProvider, vertexClaudeModelId, vertexClaudeHost, type VertexClaudeOptions } from "./vertexAnthropic.js";
import {
  type ChatCompletionRequest,
  type ChatCompletionResponse,
  type ChatCompletionChunk,
  type ToolCall,
  type TokenUsage,
  type UnifiedMessage,
  type ToolDefinition,
  type ReasoningBlock,
  type VertexProviderConfig,
  type EmbeddingRequest,
  type EmbeddingResponse,
  type ProviderType,
  ProviderError,
} from "./types.js";

/** How Google credentials are obtained, accepted next to the usual Vertex config. */
export type VertexAuthOptions = {
  /**
   * How long the `gcloud auth print-access-token` fallback (no `accessToken` and no
   * `serviceAccountJson`) may run before it is killed. Default 30000. A slow
   * first call (cold CLI, credential refresh) is not a failure.
   */
  gcloudTimeoutMs?: number;
};

export class VertexProvider extends BaseProvider {
  readonly providerName: ProviderType = "vertex";

  private readonly projectId: string;
  private readonly location: string;
  /** Where Claude models are called: the configured `location`, or `global` when none was set. */
  private readonly claudeLocation: string;
  private readonly defaultModel: string;
  private readonly defaultHeaders: Record<string, string>;
  /** An explicit `accessToken`, or the token the gcloud fallback produced. Service-account tokens live in a module-level cache instead. */
  private accessToken?: string;
  private serviceAccountJson?: Record<string, any>;
  private tokenExpiry = 0;
  private gcloudRefresh?: Promise<string>;
  private readonly gcloudTimeoutMs: number;
  private readonly claudeConfig: VertexProviderConfig & VertexClaudeOptions;
  private claude?: VertexAnthropicProvider;

  /**
   * A model id that starts with `claude` (or `publishers/anthropic/models/claude...`)
   * is served by the Claude publisher: same project, location and credentials,
   * `:rawPredict` / `:streamRawPredict`. `prompt_caching` and `thinkingMode` apply to those.
   *
   * `location` defaults to `us-central1` for Gemini. That region does not serve the
   * newer Claude models (they need `global` or the `us` / `eu` multi-regions), so a
   * Claude call made with no explicit `location` goes to `global`; an explicit
   * `location` is always used as given.
   */
  constructor(config: VertexProviderConfig & VertexClaudeOptions & VertexAuthOptions) {
    super();
    this.claudeConfig = config;
    this.configureTransport(config);
    this.projectId = config.projectId;
    const location = typeof config.location === "string" ? config.location.trim() : "";
    this.location = location || "us-central1";
    this.claudeLocation = location || "global";
    const gcloudTimeout = config.gcloudTimeoutMs;
    this.gcloudTimeoutMs = typeof gcloudTimeout === "number" && Number.isFinite(gcloudTimeout) && gcloudTimeout > 0 ? Math.max(1, Math.floor(gcloudTimeout)) : GCLOUD_TIMEOUT_MS;
    this.defaultModel = config.defaultModel ?? "gemini-2.0-flash";
    this.defaultHeaders = config.defaultHeaders ?? {};
    if (config.retry) this.retryPolicy = { ...this.retryPolicy, ...config.retry };

    if (config.accessToken) {
      this.accessToken = config.accessToken;
      this.tokenExpiry = Date.now() + 3600_000; // assume 1h validity
    }

    if (config.serviceAccountJson) {
      this.serviceAccountJson =
        typeof config.serviceAccountJson === "string"
          ? JSON.parse(config.serviceAccountJson)
          : config.serviceAccountJson;
    }
  }

  async complete(request: ChatCompletionRequest): Promise<ChatCompletionResponse> {
    const modelId = request.model || this.defaultModel;
    const claudeId = vertexClaudeModelId(modelId);
    if (claudeId) return this.claudeProvider().complete({ ...request, model: claudeId });
    const body = this.buildGeminiBody(request, modelId);
    const url = this.buildUrl(modelId, false);
    const res = await this.doFetch(url, body, request.signal, modelId);
    const json = await res.json();
    return this.parseResponse(json, modelId);
  }

  async *completeStream(request: ChatCompletionRequest): AsyncGenerator<ChatCompletionChunk, void, unknown> {
    const modelId = request.model || this.defaultModel;
    const claudeId = vertexClaudeModelId(modelId);
    if (claudeId) {
      yield* this.claudeProvider().completeStream({ ...request, model: claudeId });
      return;
    }
    const body = this.buildGeminiBody(request, modelId);
    const url = this.buildUrl(modelId, true);
    const res = await this.doFetch(url, body, request.signal, modelId);

    if (!res.body) throw new ProviderError("No response body for stream", this.providerName);
    const counter: StreamState = { next: 0, signatures: [] };

    // Vertex streams JSON array items separated by newlines or SSE
    const contentType = res.headers.get("content-type") ?? "";

    if (contentType.includes("text/event-stream")) {
      // SSE format
      for await (const event of parseSSEStream(res.body, request.signal)) {
        if (event.data === "[DONE]") break;
        let chunk: any;
        try {
          chunk = JSON.parse(event.data);
        } catch {
          continue;
        }
        yield this.parseStreamChunk(chunk, modelId, counter);
      }
    } else {
      // NDJSON or JSON array format
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });

          // Try to parse JSON objects from buffer
          const lines = buffer.split("\n");
          buffer = lines.pop() ?? "";

          for (const line of lines) {
            const trimmed = line.trim().replace(/^,/, "").replace(/^\[/, "").replace(/\]$/, "");
            if (!trimmed || trimmed === "[" || trimmed === "]") continue;
            try {
              const chunk = JSON.parse(trimmed);
              yield this.parseStreamChunk(chunk, modelId, counter);
            } catch {
              // Incomplete JSON, put back
              buffer = line + "\n" + buffer;
              break;
            }
          }
        }

        // Process remaining buffer
        const remaining = buffer.trim().replace(/^,/, "").replace(/^\[/, "").replace(/\]$/, "");
        if (remaining && remaining !== "[" && remaining !== "]") {
          try {
            const chunk = JSON.parse(remaining);
            yield this.parseStreamChunk(chunk, modelId, counter);
          } catch {
            // ignore
          }
        }
      } finally {
        // Hang up on an early exit; a no-op once the body has been read to the end.
        reader.cancel().catch(() => undefined);
        reader.releaseLock();
      }
    }
  }

  // ─── Internals ───────────────────────────────────────────────────────────

  /** The Claude-on-Vertex path, made on first use and sharing this provider's token handling. */
  private claudeProvider(): VertexAnthropicProvider {
    const c = this.claudeConfig;
    this.claude ??= new VertexAnthropicProvider({
      projectId: this.projectId,
      location: this.claudeLocation,
      getAccessToken: () => this.getAccessToken(),
      defaultHeaders: this.defaultHeaders,
      prompt_caching: c.prompt_caching,
      thinkingMode: c.thinkingMode,
      retry: c.retry,
      fetch: c.fetch,
      timeoutMs: c.timeoutMs,
      onModelRuleLearned: c.onModelRuleLearned,
    });
    return this.claude;
  }

  /**
   * Vertex `:predict` embeddings (text-embedding-00x, text-multilingual-embedding,
   * gemini-embedding-001). `inputType` maps to the task type; `dimensions` to
   * `outputDimensionality`. gemini-embedding takes one instance per request, the
   * text-embedding models up to `batchSize` (default 100).
   */
  override async embed(request: EmbeddingRequest): Promise<EmbeddingResponse> {
    const model = requireEmbeddingModel(this.providerName, request.model);
    const perRequest = request.batchSize ?? (/gemini-embedding/i.test(model) ? 1 : 100);
    const url = `https://${vertexHost(this.location)}/v1/projects/${this.projectId}/locations/${this.location}/publishers/google/models/${model}:predict`;
    const taskType = request.inputType ? (Object.prototype.hasOwnProperty.call(GEMINI_TASK_TYPES, request.inputType) ? GEMINI_TASK_TYPES[request.inputType] : request.inputType.toUpperCase()) : undefined;
    const vectors: number[][] = [];
    const raw: any[] = [];
    let inputTokens = 0;

    for (const batch of chunkArray(request.input, perRequest)) {
      const body: Record<string, any> = {
        instances: batch.map((content) => ({ content, ...(taskType ? { task_type: taskType } : {}) })),
      };
      const { parameters: extraParameters, ...extraRest } = request.extra ?? {};
      const parameters: Record<string, any> = {
        ...(request.dimensions != null ? { outputDimensionality: request.dimensions } : {}),
        // Caller-supplied parameters are merged in, not replacing the above (an
        // explicit extra.parameters.outputDimensionality still wins).
        ...(extraParameters && typeof extraParameters === "object" ? extraParameters : {}),
      };
      if (Object.keys(parameters).length > 0) body.parameters = parameters;
      Object.assign(body, extraRest);
      const res = await this.doFetch(url, body, request.signal, model);
      const json: any = await res.json();
      raw.push(json);
      for (const p of json.predictions ?? []) {
        const values = p.embeddings?.values;
        if (!Array.isArray(values)) {
          throw new ProviderError("Vertex embeddings response has a prediction without an embeddings.values array", this.providerName, undefined, json);
        }
        vectors.push(values);
        inputTokens += p.embeddings?.statistics?.token_count ?? 0;
      }
    }

    assertVectorCount(this.providerName, vectors, request.input.length);
    return { model, vectors, usage: { inputTokens, totalTokens: inputTokens }, raw };
  }

  private buildUrl(modelId: string, stream: boolean): string {
    const base = `https://${vertexHost(this.location)}/v1`;
    const path = `projects/${this.projectId}/locations/${this.location}/publishers/google/models/${modelId}`;
    const action = stream ? "streamGenerateContent?alt=sse" : "generateContent";
    return `${base}/${path}:${action}`;
  }

  private buildGeminiBody(request: ChatCompletionRequest, modelId?: string): Record<string, any> {
    const { system, contents } = this.buildContents(request.messages);
    const model = modelId ?? (request.model || this.defaultModel);
    // Gemini 3 and later (level-style rules) are the thinking models that validate the signatures of the current turn.
    if (resolveModelRule({ provider: "vertex", model }).reasoning.style === "level") skipUnsignedCurrentTurnCalls(contents);

    const body: Record<string, any> = { contents };

    if (system) {
      body.systemInstruction = { parts: [{ text: system }] };
    }

    // Generation config
    const generationConfig: Record<string, any> = {};
    if (request.maxTokens != null) generationConfig.maxOutputTokens = request.maxTokens;
    if (request.temperature != null) generationConfig.temperature = request.temperature;
    if (request.topP != null) generationConfig.topP = request.topP;
    if (request.stop) generationConfig.stopSequences = request.stop;
    if (request.seed != null) generationConfig.seed = request.seed;
    if (request.presencePenalty != null) generationConfig.presencePenalty = request.presencePenalty;
    if (request.frequencyPenalty != null) generationConfig.frequencyPenalty = request.frequencyPenalty;

    if (request.responseFormat) {
      if (request.responseFormat.type === "json_schema" || request.responseFormat.type === "json_object") {
        generationConfig.responseMimeType = "application/json";
        if (request.responseFormat.schema) {
          generationConfig.responseSchema = sanitizeGeminiSchema(request.responseFormat.schema);
        }
      }
    }

    applyGeminiReasoning(generationConfig, request.reasoning, { model });

    if (Object.keys(generationConfig).length > 0) body.generationConfig = generationConfig;
    if (request.tools?.length) {
      body.tools = [
        {
          functionDeclarations: request.tools.map((t) => this.toGeminiTool(t)),
        },
      ];

      const choice = request.toolChoice;
      if (choice != null) {
        if (typeof choice === "object" && typeof choice.name === "string" && choice.name) {
          // Forcing one function: mode ANY limited to that name.
          body.toolConfig = { functionCallingConfig: { mode: "ANY", allowedFunctionNames: [choice.name] } };
        } else {
          const mode =
            choice === "auto" ? "AUTO"
            : choice === "required" ? "ANY"
            : choice === "none" ? "NONE"
            : "AUTO";
          body.toolConfig = { functionCallingConfig: { mode } };
        }
      }
    }

    if (request.extra) {
      Object.assign(body, request.extra);
    }

    return body;
  }

  private buildContents(messages: UnifiedMessage[]): { system: string | undefined; contents: any[] } {
    const systemParts: string[] = [];
    const contents: any[] = [];
    let mergingToolResults = false;
    // Gemini matches a functionResponse to its call by NAME. A tool message
    // usually carries only the call id, so the names come from the assistant
    // tool calls seen so far.
    const callNames = new Map<string, string>();

    for (const m of messages) {
      if (m.role === "assistant" && m.toolCalls?.length) {
        for (const tc of m.toolCalls) if (tc.id) callNames.set(tc.id, tc.name);
      }

      if (m.role === "system") {
        const text = typeof m.content === "string"
          ? m.content
          : m.content.filter((p) => p.type === "text").map((p) => (p as { type: "text"; text: string }).text).join("\n");
        if (text) systemParts.push(text);
        continue;
      }

      // Gemini expects every functionResponse part answering a single model
      // turn's (possibly multiple) functionCall parts to be batched into ONE
      // turn. The unified message list carries one `role: "tool"` entry per
      // tool call (mirroring OpenAI's shape), so consecutive tool messages
      // here are coalesced into a single content entry.
      if (m.role === "tool" && m.toolCallId) {
        const part = this.toGeminiFunctionResponsePart(m, callNames);
        if (mergingToolResults) {
          contents[contents.length - 1].parts.push(part);
        } else {
          contents.push({ role: "user", parts: [part] });
          mergingToolResults = true;
        }
        continue;
      }

      mergingToolResults = false;
      contents.push(this.toGeminiContent(m));
    }

    return {
      system: systemParts.length > 0 ? systemParts.join("\n\n") : undefined,
      contents,
    };
  }

  private toGeminiFunctionResponsePart(m: UnifiedMessage, callNames: Map<string, string>): Record<string, any> {
    const text = typeof m.content === "string" ? m.content : JSON.stringify(m.content);
    let response: any;
    try {
      response = JSON.parse(text);
    } catch {
      response = { result: text };
    }
    return {
      functionResponse: {
        name: (m.toolCallId ? callNames.get(m.toolCallId) : undefined) ?? m.name ?? m.toolCallId,
        response,
      },
    };
  }

  private toGeminiContent(m: UnifiedMessage): Record<string, any> {
    // The signature the response carried on a text part (see signatureBlock); it goes back on the turn's last text part.
    const textSignature = m.role === "assistant" ? textSignatureOf(m) : undefined;

    // Assistant with tool calls
    if (m.role === "assistant" && m.toolCalls?.length) {
      const parts: any[] = [];
      if (typeof m.content === "string" && m.content) {
        parts.push({ text: m.content, ...(textSignature ? { thoughtSignature: textSignature } : {}) });
      }
      for (const tc of m.toolCalls) {
        parts.push({
          functionCall: {
            name: tc.name,
            args: safeJsonParse(tc.arguments),
          },
          // Gemini 3 requires the signature of each functionCall echoed back.
          ...(tc.thoughtSignature ? { thoughtSignature: tc.thoughtSignature } : {}),
        });
      }
      return { role: "model", parts };
    }

    // Map roles: user→user, assistant→model
    const role = m.role === "assistant" ? "model" : "user";
    const parts: any[] = [];

    if (typeof m.content === "string") {
      parts.push({ text: m.content });
    } else if (Array.isArray(m.content)) {
      for (const part of m.content) {
        if (part.type === "text") {
          parts.push({ text: part.text });
        } else if (part.type === "image") {
          const src = part.source;
          if (src.type === "base64") {
            parts.push({
              inlineData: { mimeType: src.mediaType, data: src.data },
            });
          } else {
            parts.push({
              fileData: {
                mimeType: src.mediaType ?? inferMediaTypeFromUrl(src.url) ?? "image/jpeg",
                fileUri: src.url,
              },
            });
          }
        } else if (part.type === "file" || part.type === "audio") {
          // Gemini takes documents and audio through the same inline/file parts.
          const src = part.source;
          const fallbackMime = part.type === "audio" ? "audio/mpeg" : "application/pdf";
          if (src.type === "base64") {
            parts.push({
              inlineData: { mimeType: src.mediaType ?? fallbackMime, data: src.data },
            });
          } else {
            parts.push({
              fileData: {
                mimeType: src.mediaType
                  ?? inferMediaTypeFromUrl(src.url)
                  ?? inferMediaTypeFromUrl((part as any).fileName)
                  ?? fallbackMime,
                fileUri: src.url,
              },
            });
          }
        }
      }
    }

    if (textSignature) {
      // Never an empty part just to carry it: an empty text part is a request error.
      for (let i = parts.length - 1; i >= 0; i--) {
        if (typeof parts[i].text === "string" && parts[i].text) {
          parts[i].thoughtSignature = textSignature;
          break;
        }
      }
    }

    return { role, parts };
  }

  private toGeminiTool(t: ToolDefinition): Record<string, any> {
    return {
      name: t.name,
      description: t.description,
      parameters: sanitizeGeminiSchema(t.parameters),
    };
  }

  private async getAccessToken(): Promise<string> {
    // An explicit accessToken (or the gcloud token) is reused until it expires.
    if (this.accessToken && Date.now() < this.tokenExpiry) {
      return this.accessToken;
    }

    // Service account: minted tokens are shared by every provider instance.
    if (this.serviceAccountJson) {
      return this.getServiceAccountToken(this.serviceAccountJson);
    }

    // gcloud CLI as fallback
    if (!this.gcloudRefresh) {
      this.gcloudRefresh = gcloudAccessToken(this.gcloudTimeoutMs)
        .then((token) => {
          this.accessToken = token;
          this.tokenExpiry = Date.now() + 3500_000;
          return token;
        })
        .catch((error: unknown) => {
          // A killed child is a timeout, not a missing or unauthenticated CLI: say so,
          // and say what to change.
          throw new ProviderError(
            (error as { killed?: unknown } | null)?.killed === true
              ? `gcloud timed out after ${this.gcloudTimeoutMs} ms while getting an access token (gcloud auth print-access-token). Raise gcloudTimeoutMs, or provide accessToken or serviceAccountJson.`
              : "No access token available. Provide accessToken, serviceAccountJson, or ensure gcloud CLI is authenticated.",
            this.providerName,
          );
        })
        .finally(() => {
          this.gcloudRefresh = undefined;
        });
    }
    return this.gcloudRefresh;
  }

  /**
   * Cached per (service account, scope, key) at module level, so a provider built
   * per call does not sign a JWT and hit the token endpoint every time. Callers
   * arriving while a refresh runs await the same request; a failed refresh is
   * not cached.
   */
  private async getServiceAccountToken(sa: Record<string, any>): Promise<string> {
    const key = await serviceAccountCacheKey(sa);
    const hit = serviceAccountTokens.get(key);
    if (hit && Date.now() < hit.expiresAt) return hit.token;

    let pending = serviceAccountRefreshes.get(key);
    if (!pending) {
      pending = this.getTokenFromServiceAccount(sa)
        .then((minted) => {
          serviceAccountTokens.set(key, minted);
          return minted;
        })
        .finally(() => {
          serviceAccountRefreshes.delete(key);
        });
      serviceAccountRefreshes.set(key, pending);
    }
    return (await pending).token;
  }

  private async getTokenFromServiceAccount(sa: Record<string, any>): Promise<CachedToken> {
    const { createSign } = await import("crypto");

    const now = Math.floor(Date.now() / 1000);
    const header = { alg: "RS256", typ: "JWT" };
    const claims = {
      iss: sa.client_email,
      scope: SERVICE_ACCOUNT_SCOPE,
      aud: "https://oauth2.googleapis.com/token",
      iat: now,
      exp: now + 3600,
    };

    const segments = [
      base64url(JSON.stringify(header)),
      base64url(JSON.stringify(claims)),
    ];
    const signingInput = segments.join(".");

    const sign = createSign("RSA-SHA256");
    sign.update(signingInput);
    const signature = sign.sign(sa.private_key, "base64url");
    const jwt = `${signingInput}.${signature}`;

    const tokenRes = await this.httpFetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: `grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer&assertion=${jwt}`,
    });

    if (!tokenRes.ok) {
      const text = await tokenRes.text().catch(() => "");
      throw new ProviderError(`Failed to get Vertex access token: ${text}`, this.providerName);
    }

    const tokenJson = (await tokenRes.json()) as { access_token?: string; expires_in?: number | string };
    if (typeof tokenJson.access_token !== "string" || !tokenJson.access_token) {
      throw new ProviderError("Failed to get Vertex access token: the token response has no access_token", this.providerName);
    }
    // The endpoint states how long the token lives (`expires_in`, seconds);
    // refresh a little early (a tenth of the lifetime, at most 2 minutes).
    const expiresIn = Number(tokenJson.expires_in);
    const lifetimeMs = (Number.isFinite(expiresIn) && expiresIn > 0 ? expiresIn : 3600) * 1000;
    return {
      token: tokenJson.access_token,
      expiresAt: Date.now() + lifetimeMs - Math.min(TOKEN_REFRESH_MARGIN_MS, lifetimeMs / 10),
    };
  }

  private async doFetch(url: string, body: Record<string, any>, signal?: AbortSignal, model = ""): Promise<Response> {
    const token = await this.getAccessToken();

    const bodyStr = JSON.stringify(body);
    // 429/5xx are retried with backoff (Retry-After honoured); the last
    // response is returned and surfaced below as a ProviderError.
    const res = await this.doFetchWithRetry(
      () =>
        this.httpFetch(url, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${token}`,
            ...this.defaultHeaders,
          },
          body: bodyStr,
          signal,
        }),
      signal,
    );

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      // A 400 about the request is surfaced typed (param/value) rather than opaque.
      if (res.status === 400) {
        const parsed = parseModelError(text);
        throw new ModelRequestError({
          status: 400,
          code: parsed?.kind === "unsupported_value" ? "unsupported_value" : parsed?.kind === "unsupported_parameter" ? "unsupported_parameter" : "model_request_invalid",
          param: parsed?.param,
          value: parsed?.value,
          supportedValues: parsed?.supportedValues,
          provider: this.providerName,
          model,
          message: `Vertex AI API error ${res.status}: ${text}`,
          responseBody: text,
        });
      }
      throw new ProviderError(
        `Vertex AI API error ${res.status}: ${text}`,
        this.providerName,
        res.status,
        text,
      );
    }

    return res;
  }

  private parseResponse(json: any, modelId: string): ChatCompletionResponse {
    const candidate = json.candidates?.[0];
    const parts = candidate?.content?.parts ?? [];

    const textParts: string[] = [];
    const toolCalls: ToolCall[] = [];
    const thoughtParts: string[] = [];
    const signatures: string[] = [];
    let toolCallIdx = 0;

    for (const part of parts) {
      // The signature of a part that is not a function call (the last text part, or an empty one).
      const textSignature = part.functionCall || part.thought === true ? undefined : signatureOf(part);
      if (textSignature) signatures.push(textSignature);
      if (part.text) {
        // Gemini marks reasoning summary parts with thought:true.
        if (part.thought === true) {
          thoughtParts.push(part.text);
        } else {
          textParts.push(part.text);
        }
      } else if (part.functionCall) {
        // Gemini can return an id for the call; when it does that is the call's id,
        // otherwise one is made up here and marked so a trace does not pass it off as the provider's.
        const suppliedId = typeof part.functionCall.id === "string" && part.functionCall.id ? part.functionCall.id : undefined;
        const position = toolCallIdx++;
        toolCalls.push({
          id: suppliedId ?? `call_${position}`,
          name: part.functionCall.name,
          arguments: JSON.stringify(part.functionCall.args ?? {}),
          ...(suppliedId ? {} : { idSynthesized: true }),
          ...(part.thoughtSignature ? { thoughtSignature: part.thoughtSignature } : {}),
        });
      }
    }

    const finish = geminiFinish(json, candidate);

    const usageMeta = json.usageMetadata ?? {};
    const tokenUsage: TokenUsage = {
      inputTokens: usageMeta.promptTokenCount ?? 0,
      outputTokens: usageMeta.candidatesTokenCount ?? 0,
      totalTokens: usageMeta.totalTokenCount ?? 0,
      cachedInputTokens: usageMeta.cachedContentTokenCount ?? 0,
      cachedWriteTokens: 0,
      cachedOutputTokens: 0,
      reasoningTokens: usageMeta.thoughtsTokenCount ?? 0,
    };

    return {
      id: json.responseId ?? "",
      model: modelId,
      content: textParts.join("") || null,
      toolCalls,
      usage: tokenUsage,
      finishReason: finish.finishReason ?? "stop",
      ...(finish.rawFinishReason ? { rawFinishReason: finish.rawFinishReason } : {}),
      reasoning:
        thoughtParts.length > 0 || signatures.length > 0
          ? {
              ...(thoughtParts.length > 0 ? { summary: thoughtParts.join("\n").trim() || undefined } : {}),
              ...(signatures.length > 0 ? { blocks: signatures.map(signatureBlock) } : {}),
            }
          : undefined,
      raw: json,
    };
  }

  private parseStreamChunk(chunk: any, modelId: string, counter: StreamState): ChatCompletionChunk {
    const candidate = chunk.candidates?.[0];
    const parts = candidate?.content?.parts ?? [];
    const delta: ChatCompletionChunk["delta"] = {};

    for (const part of parts) {
      const textSignature = part.functionCall || part.thought === true ? undefined : signatureOf(part);
      if (textSignature) {
        // The consumer keeps the LAST blocks it is given, so each one carries every signature seen so far.
        counter.signatures.push(textSignature);
        delta.reasoning = { ...(delta.reasoning ?? {}), blocks: counter.signatures.map(signatureBlock) };
      }
      if (part.text) {
        if (part.thought === true) {
          delta.reasoning = { ...(delta.reasoning ?? {}), summary: (delta.reasoning?.summary ?? "") + part.text };
        } else {
          delta.content = (delta.content ?? "") + part.text;
        }
      } else if (part.functionCall) {
        if (!delta.toolCalls) delta.toolCalls = [];
        const suppliedId = typeof part.functionCall.id === "string" && part.functionCall.id ? part.functionCall.id : undefined;
        const position = counter.next++;
        delta.toolCalls.push({
          // Unique across the whole stream: the adapter merges chunks by id.
          id: suppliedId ?? `call_${position}`,
          index: position,
          name: part.functionCall.name,
          arguments: JSON.stringify(part.functionCall.args ?? {}),
          ...(suppliedId ? {} : { idSynthesized: true }),
          ...(part.thoughtSignature ? { thoughtSignature: part.thoughtSignature } : {}),
        });
      }
    }

    let usage: TokenUsage | undefined;
    if (chunk.usageMetadata) {
      const u = chunk.usageMetadata;
      usage = {
        inputTokens: u.promptTokenCount ?? 0,
        outputTokens: u.candidatesTokenCount ?? 0,
        totalTokens: u.totalTokenCount ?? 0,
        cachedInputTokens: u.cachedContentTokenCount ?? 0,
        cachedWriteTokens: 0,
        cachedOutputTokens: 0,
        reasoningTokens: u.thoughtsTokenCount ?? 0,
      };
    }

    // Mid-stream chunks carry no finishReason: leave it unset rather than
    // reporting "stop" on every one of them.
    const finish = geminiFinish(chunk, candidate);
    return {
      id: chunk.responseId ?? "",
      model: modelId,
      delta,
      usage,
      ...(finish.finishReason ? { finishReason: finish.finishReason } : {}),
      ...(finish.rawFinishReason ? { rawFinishReason: finish.rawFinishReason } : {}),
    };
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Gemini and Claude are served from the same hosts, so one function picks them:
 * `global` has the plain host, the `us` / `eu` multi-regions
 * `aiplatform.{us|eu}.rep.googleapis.com` (the path keeps `locations/us`), every
 * other location a regional host. Used by chat, streaming and embeddings.
 */
const vertexHost = vertexClaudeHost;

type CachedToken = { token: string; expiresAt: number };

const SERVICE_ACCOUNT_SCOPE = "https://www.googleapis.com/auth/cloud-platform";
/** Upper bound of how long before expiry a cached token is replaced. */
const TOKEN_REFRESH_MARGIN_MS = 120_000;
/** Default for `gcloudTimeoutMs`: gcloud can take a while on a cold start or a credential refresh. */
const GCLOUD_TIMEOUT_MS = 30_000;

/** Minted service-account tokens, shared by every VertexProvider in the process. */
const serviceAccountTokens = new Map<string, CachedToken>();
/** Token requests in flight, so concurrent callers share one. */
const serviceAccountRefreshes = new Map<string, Promise<CachedToken>>();

/**
 * client_email + scope, plus a digest of the private key: two tenants that
 * claim the same client_email with different keys must not share a token.
 */
async function serviceAccountCacheKey(sa: Record<string, any>): Promise<string> {
  const { createHash } = await import("crypto");
  const keyDigest = createHash("sha256").update(String(sa.private_key ?? "")).digest("hex");
  return `${sa.client_email ?? ""}\n${SERVICE_ACCOUNT_SCOPE}\n${keyDigest}`;
}

/**
 * `gcloud auth print-access-token` without blocking the event loop or a shell. Past
 * `timeoutMs` the child is killed and the error carries `killed: true`.
 */
async function gcloudAccessToken(timeoutMs: number): Promise<string> {
  const { execFile } = await import("child_process");
  return new Promise<string>((resolve, reject) => {
    execFile(
      "gcloud",
      ["auth", "print-access-token"],
      // On Windows gcloud is a .cmd shim, which only runs through a shell (the arguments are constant).
      { encoding: "utf8", timeout: timeoutMs, windowsHide: true, shell: process.platform === "win32" },
      (error, stdout) => {
        if (error) return reject(error);
        const token = String(stdout ?? "").trim();
        if (token) resolve(token);
        else reject(new Error("gcloud printed no token"));
      },
    );
  });
}

const GEMINI_TASK_TYPES: Record<string, string> = {
  search_document: "RETRIEVAL_DOCUMENT",
  search_query: "RETRIEVAL_QUERY",
  classification: "CLASSIFICATION",
  clustering: "CLUSTERING",
  semantic_similarity: "SEMANTIC_SIMILARITY",
  question_answering: "QUESTION_ANSWERING",
  fact_verification: "FACT_VERIFICATION",
  code_retrieval_query: "CODE_RETRIEVAL_QUERY",
};

/** What the stream parser carries from chunk to chunk. */
type StreamState = {
  /** Count of function calls so far: the next call's position, and part of its synthesized id. */
  next: number;
  /** Thought signatures of non-function-call parts, in order. */
  signatures: string[];
};

/** A part's `thoughtSignature`, when it has one. */
function signatureOf(part: any): string | undefined {
  return typeof part?.thoughtSignature === "string" && part.thoughtSignature ? part.thoughtSignature : undefined;
}

/** A `ReasoningBlock` that carries a Gemini thought signature instead of Claude's `signature` (see `signatureBlock`). */
type SignatureBlock = ReasoningBlock & { thoughtSignature: string };

/**
 * A Gemini thought signature kept from a part that is not a function call (those
 * ride on their `ToolCall`). Google asks for every signature back "inside its
 * original Part"; the unified response has text only as a string, so the
 * signature travels on `reasoning.blocks`, the one field the adapter carries to
 * the next request unchanged. The block has no `signature` and no text, which
 * the Anthropic and Bedrock providers skip: a Gemini signature is never sent to
 * them as a thinking signature (the OpenAI Responses blocks work the same way).
 */
function signatureBlock(thoughtSignature: string): ReasoningBlock {
  const block: SignatureBlock = { type: "thinking", thoughtSignature };
  return block;
}

/** The signature `signatureBlock` kept on an assistant turn (the last one when there are several), for the turn's last text part. */
function textSignatureOf(m: UnifiedMessage): string | undefined {
  const blocks = m.reasoning?.blocks;
  if (!blocks?.length) return undefined;
  for (let i = blocks.length - 1; i >= 0; i--) {
    const signature = (blocks[i] as Partial<SignatureBlock>).thoughtSignature;
    if (typeof signature === "string" && signature) return signature;
  }
  return undefined;
}

/** The value Google documents for a functionCall whose signature is unavailable (history from another model). */
const SKIP_SIGNATURE_VALIDATOR = "skip_thought_signature_validator";

/**
 * Gemini 3 answers 400 when the first functionCall part of any step of the CURRENT turn has
 * no thought signature (a turn begins at the latest user message that is not a
 * functionResponse; text parts and earlier turns are not validated). A call that did not
 * come from Gemini has none to echo, so the documented skip value stands in for it, on that
 * first functionCall of the step only.
 */
function skipUnsignedCurrentTurnCalls(contents: Array<{ role: string; parts: any[] }>): void {
  let start = -1;
  for (let i = contents.length - 1; i >= 0; i--) {
    const c = contents[i];
    if (c.role === "user" && !c.parts.some((p) => p?.functionResponse)) {
      start = i;
      break;
    }
  }
  for (let i = start + 1; i < contents.length; i++) {
    const c = contents[i];
    if (c.role !== "model") continue;
    const first = c.parts.find((p) => p?.functionCall);
    if (first && !signatureOf(first)) first.thoughtSignature = SKIP_SIGNATURE_VALIDATOR;
  }
}

function mapGeminiFinishReason(reason: string | null | undefined): ChatCompletionResponse["finishReason"] {
  switch (reason) {
    case "STOP":
      return "stop";
    case "MAX_TOKENS":
      return "length";
    case "SAFETY":
    case "RECITATION":
    case "PROHIBITED_CONTENT":
    case "BLOCKLIST":
    case "SPII":
    case "IMAGE_SAFETY":
      return "content_filter";
    case "MALFORMED_FUNCTION_CALL":
    case "UNEXPECTED_TOOL_CALL":
      return "error";
    case "TOOL_CALLS":
      return "tool_calls";
    default:
      return "stop";
  }
}

/** The finish facts of a Gemini response or stream chunk. A prompt refused
 * before generation has no candidate, only promptFeedback.blockReason. A
 * missing reason leaves both fields unset (the caller decides the fallback). */
function geminiFinish(
  json: any,
  candidate: any,
): { finishReason?: ChatCompletionResponse["finishReason"]; rawFinishReason?: string } {
  if (typeof candidate?.finishReason === "string") {
    return { finishReason: mapGeminiFinishReason(candidate.finishReason), rawFinishReason: candidate.finishReason };
  }
  const blockReason = json?.promptFeedback?.blockReason;
  if (!candidate && typeof blockReason === "string" && blockReason) {
    return { finishReason: "content_filter", rawFinishReason: blockReason };
  }
  return {};
}

function base64url(str: string): string {
  return Buffer.from(str).toString("base64url");
}

function safeJsonParse(str: string): any {
  try {
    return JSON.parse(str);
  } catch {
    return {};
  }
}
