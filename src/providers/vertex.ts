// Google Vertex AI (Gemini) provider.
// Direct fetch-based implementation – supports both access token and service account auth.

import { BaseProvider } from "./base.js";
import { parseSSEStream } from "./utils/sse.js";
import { applyGeminiReasoning } from "./utils/reasoning.js";
import { ModelRequestError } from "../models/errors.js";
import { parseModelError } from "../models/adjust.js";
import { inferMediaTypeFromUrl } from "./utils/media.js";
import { chunkArray, assertVectorCount, requireEmbeddingModel } from "./utils/embeddings.js";
import {
  type ChatCompletionRequest,
  type ChatCompletionResponse,
  type ChatCompletionChunk,
  type ToolCall,
  type TokenUsage,
  type UnifiedMessage,
  type ToolDefinition,
  type VertexProviderConfig,
  type EmbeddingRequest,
  type EmbeddingResponse,
  type ProviderType,
  ProviderError,
} from "./types.js";

export class VertexProvider extends BaseProvider {
  readonly providerName: ProviderType = "vertex";

  private readonly projectId: string;
  private readonly location: string;
  private readonly defaultModel: string;
  private readonly defaultHeaders: Record<string, string>;
  private accessToken?: string;
  private serviceAccountJson?: Record<string, any>;
  private tokenExpiry = 0;

  constructor(config: VertexProviderConfig) {
    super();
    this.configureTransport(config);
    this.projectId = config.projectId;
    this.location = config.location ?? "us-central1";
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
    const body = this.buildGeminiBody(request);
    const url = this.buildUrl(modelId, false);
    const res = await this.doFetch(url, body, request.signal, modelId);
    const json = await res.json();
    return this.parseResponse(json, modelId);
  }

  async *completeStream(request: ChatCompletionRequest): AsyncGenerator<ChatCompletionChunk, void, unknown> {
    const modelId = request.model || this.defaultModel;
    const body = this.buildGeminiBody(request);
    const url = this.buildUrl(modelId, true);
    const res = await this.doFetch(url, body, request.signal, modelId);

    if (!res.body) throw new ProviderError("No response body for stream", this.providerName);
    const counter = { next: 0 };

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

  /**
   * Vertex `:predict` embeddings (text-embedding-00x, text-multilingual-embedding,
   * gemini-embedding-001). `inputType` maps to the task type; `dimensions` to
   * `outputDimensionality`. gemini-embedding takes one instance per request, the
   * text-embedding models up to `batchSize` (default 100).
   */
  override async embed(request: EmbeddingRequest): Promise<EmbeddingResponse> {
    const model = requireEmbeddingModel(this.providerName, request.model);
    const perRequest = request.batchSize ?? (/gemini-embedding/i.test(model) ? 1 : 100);
    const url = `https://${this.location}-aiplatform.googleapis.com/v1/projects/${this.projectId}/locations/${this.location}/publishers/google/models/${model}:predict`;
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
    const base = `https://${this.location}-aiplatform.googleapis.com/v1`;
    const path = `projects/${this.projectId}/locations/${this.location}/publishers/google/models/${modelId}`;
    const action = stream ? "streamGenerateContent?alt=sse" : "generateContent";
    return `${base}/${path}:${action}`;
  }

  private buildGeminiBody(request: ChatCompletionRequest): Record<string, any> {
    const { system, contents } = this.buildContents(request.messages);

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

    if (request.responseFormat) {
      if (request.responseFormat.type === "json_schema" || request.responseFormat.type === "json_object") {
        generationConfig.responseMimeType = "application/json";
        if (request.responseFormat.schema) {
          generationConfig.responseSchema = request.responseFormat.schema;
        }
      }
    }

    applyGeminiReasoning(generationConfig, request.reasoning);

    if (Object.keys(generationConfig).length > 0) body.generationConfig = generationConfig;
    if (request.tools?.length) {
      body.tools = [
        {
          functionDeclarations: request.tools.map((t) => this.toGeminiTool(t)),
        },
      ];

      if (request.toolChoice != null) {
        const mode =
          request.toolChoice === "auto" ? "AUTO"
          : request.toolChoice === "required" ? "ANY"
          : request.toolChoice === "none" ? "NONE"
          : "AUTO";
        body.toolConfig = { functionCallingConfig: { mode } };
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

    for (const m of messages) {
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
        const part = this.toGeminiFunctionResponsePart(m);
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

  private toGeminiFunctionResponsePart(m: UnifiedMessage): Record<string, any> {
    const text = typeof m.content === "string" ? m.content : JSON.stringify(m.content);
    let response: any;
    try {
      response = JSON.parse(text);
    } catch {
      response = { result: text };
    }
    return {
      functionResponse: {
        name: m.name ?? m.toolCallId,
        response,
      },
    };
  }

  private toGeminiContent(m: UnifiedMessage): Record<string, any> {
    // Assistant with tool calls
    if (m.role === "assistant" && m.toolCalls?.length) {
      const parts: any[] = [];
      if (typeof m.content === "string" && m.content) {
        parts.push({ text: m.content });
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

    return { role, parts };
  }

  private toGeminiTool(t: ToolDefinition): Record<string, any> {
    return {
      name: t.name,
      description: t.description,
      parameters: t.parameters,
    };
  }

  private async getAccessToken(): Promise<string> {
    // If we have a valid token, reuse it
    if (this.accessToken && Date.now() < this.tokenExpiry) {
      return this.accessToken;
    }

    // Try to get token from service account JSON
    if (this.serviceAccountJson) {
      const token = await this.getTokenFromServiceAccount(this.serviceAccountJson);
      this.accessToken = token;
      this.tokenExpiry = Date.now() + 3500_000; // ~58 minutes
      return token;
    }

    // Try gcloud CLI as fallback
    try {
      const { execSync } = await import("child_process");
      const token = execSync("gcloud auth print-access-token", { encoding: "utf8" }).trim();
      this.accessToken = token;
      this.tokenExpiry = Date.now() + 3500_000;
      return token;
    } catch {
      throw new ProviderError(
        "No access token available. Provide accessToken, serviceAccountJson, or ensure gcloud CLI is authenticated.",
        this.providerName,
      );
    }
  }

  private async getTokenFromServiceAccount(sa: Record<string, any>): Promise<string> {
    const { createSign } = await import("crypto");

    const now = Math.floor(Date.now() / 1000);
    const header = { alg: "RS256", typ: "JWT" };
    const claims = {
      iss: sa.client_email,
      scope: "https://www.googleapis.com/auth/cloud-platform",
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

    const tokenJson = (await tokenRes.json()) as { access_token: string };
    return tokenJson.access_token;
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
    let toolCallIdx = 0;

    for (const part of parts) {
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
      reasoning: thoughtParts.length > 0 ? { summary: thoughtParts.join("\n").trim() || undefined } : undefined,
      raw: json,
    };
  }

  private parseStreamChunk(chunk: any, modelId: string, counter: { next: number }): ChatCompletionChunk {
    const candidate = chunk.candidates?.[0];
    const parts = candidate?.content?.parts ?? [];
    const delta: ChatCompletionChunk["delta"] = {};

    for (const part of parts) {
      if (part.text) {
        if (part.thought === true) {
          delta.reasoning = { summary: (delta.reasoning?.summary ?? "") + part.text };
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
