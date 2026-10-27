// Claude models on Vertex AI (Claude Models on Google Cloud, Google managed).
//
// The request is a Messages API request, so this reuses AnthropicProvider for
// everything except the transport: body building, prompt caching, thinking, tool
// handling, finish-reason mapping and SSE stream parsing are inherited. What
// changes is the URL (`publishers/anthropic/models/{model}:rawPredict`, or
// `:streamRawPredict`), the auth (a Google bearer token) and the body (no `model`,
// `anthropic_version` instead, and no URL sources: Vertex takes base64 data only, so a
// body that has one is refused before anything is sent). `VertexProvider` delegates to
// this for Claude ids.

import { AnthropicProvider } from "./anthropic.js";
import { type PromptCachingConfig, type ProviderRetryConfig, type ProviderType, type TokenUsage, ProviderError } from "./types.js";
import type { ModelRuleLearnedEvent } from "../models/adjust.js";

/** The only `anthropic_version` a rawPredict body carries by default. */
export const VERTEX_ANTHROPIC_VERSION = "vertex-2023-10-16";

/**
 * Options of the Claude path, accepted next to the usual Vertex config.
 * They have no effect on Gemini models.
 */
export type VertexClaudeOptions = {
  /**
   * Prompt caching for Claude models: same shape and meaning as on
   * `AnthropicProviderConfig.prompt_caching` (explicit breakpoints on the system
   * prompt and the last tool, plus top-level automatic caching with the default
   * `strategy: "auto"`). Off unless `enabled: true`.
   */
  prompt_caching?: PromptCachingConfig;
  /** Thinking request shape for Claude models, as on `AnthropicProviderConfig.thinkingMode`. */
  thinkingMode?: "auto" | "adaptive" | "budget";
};

/**
 * The model id with a `publishers/anthropic/models/` prefix removed and a dated
 * snapshot written the way Vertex spells it (`claude-haiku-4-5-20251001` becomes
 * `claude-haiku-4-5@20251001`); `undefined` when it is not a Claude id.
 */
export function vertexClaudeModelId(model: string | undefined): string | undefined {
  if (!model) return undefined;
  let id = String(model).trim();
  const prefix = /^publishers\/anthropic\/models\//i.exec(id);
  if (prefix) id = id.slice(prefix[0].length);
  if (!/^claude/i.test(id)) return undefined;
  // Vertex ids separate the snapshot date with "@"; an id that has one is left alone.
  return id.replace(/-(\d{8})$/, "@$1");
}

/**
 * The host Claude requests go to: `global` and the multi-regions `us` / `eu`
 * have their own hosts, every other location is a region.
 */
export function vertexClaudeHost(location: string): string {
  if (location === "global") return "aiplatform.googleapis.com";
  if (location === "us" || location === "eu") return `aiplatform.${location}.rep.googleapis.com`;
  return `${location}-aiplatform.googleapis.com`;
}

/**
 * Where a built Messages body carries a URL source: an `image` or `document` block whose
 * `source` is `{ type: "url" }`, in a message or inside a tool result's own content.
 * Reported as `messages[i].content[j]` paths (never the URL: it may carry a signature).
 */
function urlSources(body: Record<string, any>): Array<{ path: string; type: string }> {
  const found: Array<{ path: string; type: string }> = [];
  const visit = (block: unknown, path: string): void => {
    if (!block || typeof block !== "object") return;
    const b = block as Record<string, any>;
    if ((b.type === "image" || b.type === "document") && b.source?.type === "url") found.push({ path, type: b.type });
    if (b.type === "tool_result" && Array.isArray(b.content)) {
      b.content.forEach((inner: unknown, k: number) => visit(inner, `${path}.content[${k}]`));
    }
  };
  const messages: unknown[] = Array.isArray(body.messages) ? body.messages : [];
  messages.forEach((message, i) => {
    const content = message && typeof message === "object" ? (message as Record<string, any>).content : undefined;
    if (Array.isArray(content)) content.forEach((block: unknown, j: number) => visit(block, `messages[${i}].content[${j}]`));
  });
  return found;
}

export type VertexAnthropicConfig = VertexClaudeOptions & {
  projectId: string;
  location: string;
  /** Resolves the Google bearer token for one request (the VertexProvider's own auth). */
  getAccessToken: () => Promise<string>;
  defaultHeaders?: Record<string, string>;
  retry?: ProviderRetryConfig;
  fetch?: typeof fetch;
  timeoutMs?: number;
  onModelRuleLearned?: (event: ModelRuleLearnedEvent) => void;
};

export class VertexAnthropicProvider extends AnthropicProvider {
  override readonly providerName: ProviderType = "vertex";
  // Messages-shaped rules (the base's "anthropic"), but what a 400 teaches stays
  // apart from the direct API's: the same id can differ between the backends.
  protected override readonly rulesScope = "vertex";
  protected override readonly apiName = "Vertex AI";

  private readonly projectId: string;
  private readonly location: string;
  private readonly getAccessToken: () => Promise<string>;
  private readonly extraHeaders: Record<string, string>;

  constructor(config: VertexAnthropicConfig) {
    super({
      provider: "anthropic",
      // Unused: auth is the Google bearer token.
      apiKey: "",
      prompt_caching: config.prompt_caching,
      thinkingMode: config.thinkingMode,
      retry: config.retry,
      fetch: config.fetch,
      timeoutMs: config.timeoutMs,
      onModelRuleLearned: config.onModelRuleLearned,
    });
    this.projectId = config.projectId;
    this.location = config.location;
    this.getAccessToken = config.getAccessToken;
    this.extraHeaders = config.defaultHeaders ?? {};
  }

  protected override requestUrl(model: string, stream: boolean): string {
    const action = stream ? "streamRawPredict" : "rawPredict";
    return `https://${vertexClaudeHost(this.location)}/v1/projects/${this.projectId}/locations/${this.location}/publishers/anthropic/models/${model}:${action}`;
  }

  protected override async requestHeaders(): Promise<Record<string, string>> {
    const token = await this.getAccessToken();
    // No x-api-key and no anthropic-version header: the version travels in the body.
    return { "Content-Type": "application/json", Authorization: `Bearer ${token}`, ...this.extraHeaders };
  }

  protected override wireBody(body: Record<string, any>): Record<string, any> {
    // Claude on Vertex takes image and document data inline only: URL sources (and the
    // Files API) are not supported there, and the API would answer a 400 for the whole
    // request. It is refused here with the fix in the message instead, as a 400 that is
    // not retried. The SDK does not fetch the URL itself: downloading a caller-supplied
    // URL from the host's network is a server-side request the host has to decide on.
    const urls = urlSources(body);
    if (urls.length > 0) {
      const [first, ...others] = urls;
      const where = `${first.path} (${first.type})${others.length > 0 ? ` and ${others.length} more` : ""}`;
      throw new ProviderError(
        `Claude on Vertex AI does not accept URL sources for images or documents, but ${where} has one. Send the content as base64 data instead (a base64 image or file part); the SDK does not download URLs.`,
        this.providerName,
        400,
      );
    }
    // The model is named by the URL. A caller's own `anthropic_version` (from `extra`) wins.
    const { model: _model, ...rest } = body;
    return { anthropic_version: VERTEX_ANTHROPIC_VERSION, ...rest };
  }

  /**
   * A Vertex provider reports usage on ONE basis whatever the model: `inputTokens`
   * includes the cache, `outputTokens` leaves out the reasoning (what a Gemini
   * response carries, and what `usageBasisOf("vertex")` converts). The Messages
   * API counts the other way round, so Claude's counters are moved onto it here:
   * `input_tokens` is only the part after the last cache breakpoint, so the cache
   * read and write are added to it; the thinking tokens are billed inside
   * `output_tokens`, so they are taken out of it (and `reasoningTokens` keeps
   * them). `fromNativeProvider` then gives prompt = input + cache read + cache
   * write and completion = output_tokens, exactly as for a direct Claude call.
   */
  protected override normalizeUsage(usage: TokenUsage): TokenUsage {
    const cached = Number(usage.cachedInputTokens) || 0;
    const written = Number(usage.cachedWriteTokens) || 0;
    const reasoning = Math.min(Number(usage.reasoningTokens) || 0, usage.outputTokens);
    const inputTokens = usage.inputTokens + cached + written;
    return {
      ...usage,
      inputTokens,
      outputTokens: usage.outputTokens - reasoning,
      reasoningTokens: reasoning,
      totalTokens: inputTokens + usage.outputTokens,
    };
  }
}
