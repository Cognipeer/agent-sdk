// Google Vertex AI (Gemini) provider.
// Direct fetch-based implementation – supports both access token and service account auth.

import { BaseProvider } from "./base.js";
import { parseSSEStream } from "./utils/sse.js";
import {
  type ChatCompletionRequest,
  type ChatCompletionResponse,
  type ChatCompletionChunk,
  type ToolCall,
  type TokenUsage,
  type UnifiedMessage,
  type ToolDefinition,
  type VertexProviderConfig,
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
    this.projectId = config.projectId;
    this.location = config.location ?? "us-central1";
    this.defaultModel = config.defaultModel ?? "gemini-2.0-flash";
    this.defaultHeaders = config.defaultHeaders ?? {};

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
    const res = await this.doFetch(url, body);
    const json = await res.json();
    return this.parseResponse(json, modelId);
  }

  async *completeStream(request: ChatCompletionRequest): AsyncGenerator<ChatCompletionChunk, void, unknown> {
    const modelId = request.model || this.defaultModel;
    const body = this.buildGeminiBody(request);
    const url = this.buildUrl(modelId, true);
    const res = await this.doFetch(url, body);

    if (!res.body) throw new ProviderError("No response body for stream", this.providerName);

    // Vertex streams JSON array items separated by newlines or SSE
    const contentType = res.headers.get("content-type") ?? "";

    if (contentType.includes("text/event-stream")) {
      // SSE format
      for await (const event of parseSSEStream(res.body)) {
        if (event.data === "[DONE]") break;
        let chunk: any;
        try {
          chunk = JSON.parse(event.data);
        } catch {
          continue;
        }
        yield this.parseStreamChunk(chunk, modelId);
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
              yield this.parseStreamChunk(chunk, modelId);
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
            yield this.parseStreamChunk(chunk, modelId);
          } catch {
            // ignore
          }
        }
      } finally {
        reader.releaseLock();
      }
    }
  }

  // ─── Internals ───────────────────────────────────────────────────────────

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

    if (Object.keys(generationConfig).length > 0) body.generationConfig = generationConfig;

    // Tools
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

    for (const m of messages) {
      if (m.role === "system") {
        const text = typeof m.content === "string"
          ? m.content
          : m.content.filter((p) => p.type === "text").map((p) => (p as { type: "text"; text: string }).text).join("\n");
        if (text) systemParts.push(text);
        continue;
      }

      contents.push(this.toGeminiContent(m));
    }

    return {
      system: systemParts.length > 0 ? systemParts.join("\n\n") : undefined,
      contents,
    };
  }

  private toGeminiContent(m: UnifiedMessage): Record<string, any> {
    // Tool result → user message with functionResponse
    if (m.role === "tool" && m.toolCallId) {
      const text = typeof m.content === "string" ? m.content : JSON.stringify(m.content);
      let response: any;
      try {
        response = JSON.parse(text);
      } catch {
        response = { result: text };
      }
      return {
        role: "user",
        parts: [
          {
            functionResponse: {
              name: m.name ?? m.toolCallId,
              response,
            },
          },
        ],
      };
    }

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
              fileData: { mimeType: "image/jpeg", fileUri: src.url },
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

    const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
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

  private async doFetch(url: string, body: Record<string, any>): Promise<Response> {
    const token = await this.getAccessToken();

    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
        ...this.defaultHeaders,
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "");
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
    let toolCallIdx = 0;

    for (const part of parts) {
      if (part.text) {
        textParts.push(part.text);
      } else if (part.functionCall) {
        toolCalls.push({
          id: `call_${toolCallIdx++}`,
          name: part.functionCall.name,
          arguments: JSON.stringify(part.functionCall.args ?? {}),
        });
      }
    }

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
      finishReason: mapGeminiFinishReason(candidate?.finishReason),
      raw: json,
    };
  }

  private parseStreamChunk(chunk: any, modelId: string): ChatCompletionChunk {
    const candidate = chunk.candidates?.[0];
    const parts = candidate?.content?.parts ?? [];
    const delta: ChatCompletionChunk["delta"] = {};

    for (const part of parts) {
      if (part.text) {
        delta.content = (delta.content ?? "") + part.text;
      } else if (part.functionCall) {
        if (!delta.toolCalls) delta.toolCalls = [];
        delta.toolCalls.push({
          id: `call_${delta.toolCalls.length}`,
          name: part.functionCall.name,
          arguments: JSON.stringify(part.functionCall.args ?? {}),
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

    return {
      id: chunk.responseId ?? "",
      model: modelId,
      delta,
      usage,
      finishReason: mapGeminiFinishReason(candidate?.finishReason),
    };
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function mapGeminiFinishReason(reason: string | null | undefined): ChatCompletionResponse["finishReason"] {
  switch (reason) {
    case "STOP":
      return "stop";
    case "MAX_TOKENS":
      return "length";
    case "SAFETY":
    case "RECITATION":
      return "content_filter";
    case "TOOL_CALLS":
      return "tool_calls";
    default:
      return "stop";
  }
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
