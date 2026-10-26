// OpenAI-compatible API provider.
// Works with any API that implements the OpenAI Chat Completions spec
// (e.g. Ollama, Together, Groq, Fireworks, vLLM, LiteLLM, etc.)

import { OpenAIProvider } from "./openai.js";
import type {
  ChatCompletionRequest,
  OpenAICompatibleProviderConfig,
  PromptCachingConfig,
  ProviderType,
  TextContent,
  UnifiedMessage,
} from "./types.js";
import type { RulePatch } from "../models/rules.js";

/** Anthropic allows 4 cache breakpoints per request; OpenRouter and LiteLLM forward the same limit. */
const MAX_CACHE_MARKERS = 4;

type CacheControl = NonNullable<TextContent["cacheControl"]>;

/** The `cache_control` object as it goes on the wire: `ttl` only when it is not the 5-minute default. */
function wireCacheControl(cc: CacheControl): Record<string, string> {
  return cc.ttl && cc.ttl !== "5m" ? { type: cc.type, ttl: cc.ttl } : { type: cc.type };
}

function countMarkers(messages: UnifiedMessage[]): number {
  let n = 0;
  for (const m of messages) {
    if (!Array.isArray(m.content)) continue;
    for (const part of m.content) if (part.type === "text" && part.cacheControl) n++;
  }
  return n;
}

/**
 * Returns a copy of `m` whose last non-empty text part carries `mark`, or
 * undefined when there is nothing to mark (no text, or that part already has a
 * marker of the caller's own). A plain string becomes one text part here and
 * only here. Never mutates `m`.
 */
function markLastText(m: UnifiedMessage, mark: CacheControl): UnifiedMessage | undefined {
  if (typeof m.content === "string") {
    return m.content.trim() ? { ...m, content: [{ type: "text", text: m.content, cacheControl: mark }] } : undefined;
  }
  if (!Array.isArray(m.content)) return undefined;
  for (let i = m.content.length - 1; i >= 0; i--) {
    const part = m.content[i];
    if (part.type !== "text" || !part.text.trim()) continue;
    if (part.cacheControl) return undefined;
    const content = m.content.slice();
    content[i] = { ...part, cacheControl: mark };
    return { ...m, content };
  }
  return undefined;
}

/**
 * Adds the provider's own cache markers to a copy of `messages`: the end of the
 * leading system prompt (`static` and `auto`) and, for `auto`, the last text
 * part of the last user or tool message. At most {@link MAX_CACHE_MARKERS}
 * markers in total, the caller's own included; the caller's are never removed.
 */
export function applyCacheMarkers(
  messages: UnifiedMessage[],
  caching: { strategy: "auto" | "static"; ttl: "5m" | "1h" },
): UnifiedMessage[] {
  const mark: CacheControl = caching.ttl === "1h" ? { type: "ephemeral", ttl: "1h" } : { type: "ephemeral" };
  let room = MAX_CACHE_MARKERS - countMarkers(messages);
  if (room <= 0) return messages;
  const out = messages.slice();

  // The static prefix: the last of the leading system messages.
  let lastSystem = -1;
  while (lastSystem + 1 < out.length && out[lastSystem + 1].role === "system") lastSystem++;
  if (lastSystem >= 0) {
    const marked = markLastText(out[lastSystem], mark);
    if (marked) {
      out[lastSystem] = marked;
      room--;
    }
  }

  if (caching.strategy === "auto" && room > 0) {
    for (let i = out.length - 1; i >= 0; i--) {
      if (out[i].role !== "user" && out[i].role !== "tool") continue;
      const marked = markLastText(out[i], mark);
      if (marked) out[i] = marked;
      break;
    }
  }
  return out;
}

export class OpenAICompatibleProvider extends OpenAIProvider {
  override readonly providerName: ProviderType = "openai-compatible";

  private readonly promptCachingEnabled: boolean;
  private readonly promptCaching: Required<Omit<PromptCachingConfig, "enabled">>;
  private readonly replayReasoningContent: boolean;

  constructor(config: OpenAICompatibleProviderConfig) {
    super({
      provider: "openai",
      apiKey: config.apiKey,
      baseURL: config.baseURL,
      defaultModel: config.defaultModel,
      defaultHeaders: config.defaultHeaders,
      organization: config.organization,
      retry: config.retry,
      fetch: config.fetch,
      timeoutMs: config.timeoutMs,
      onModelRuleLearned: config.onModelRuleLearned,
      maxTokensParam: config.maxTokensParam,
      api: config.api,
      // Unlike OpenAI / Azure, "auto" on a compatible server means Chat
      // Completions (the 0.11 default): the model name is the operator's.
      // `responsesApiModels` still applies; `responsesApi: "auto"` opts in.
      _autoMeansChat: true,
      responsesApi: config.responsesApi,
      responsesApiModels: config.responsesApiModels,
      responsesStreaming: config.responsesStreaming,
    });
    this.promptCachingEnabled = config.prompt_caching?.enabled === true;
    this.promptCaching = {
      strategy: config.prompt_caching?.strategy ?? "auto",
      ttl: config.prompt_caching?.ttl ?? "5m",
    };
    this.replayReasoningContent = config.replayReasoningContent === true;
  }

  /** Adds this provider's cache markers (when `prompt_caching` is on) before the body is built. */
  protected override buildRequestBody(request: ChatCompletionRequest, stream: boolean, overlay?: RulePatch): Record<string, any> {
    if (!this.promptCachingEnabled) return super.buildRequestBody(request, stream, overlay);
    const messages = applyCacheMarkers(request.messages, this.promptCaching);
    return super.buildRequestBody(messages === request.messages ? request : { ...request, messages }, stream, overlay);
  }

  /**
   * Chat Completions message with what only a compatible server takes:
   * `cache_control` on text parts the caller (or `prompt_caching`) marked, and,
   * with `replayReasoningContent`, the assistant's reasoning text as
   * `reasoning_content`. OpenAI and Azure never get either field.
   */
  protected override toOpenAIMessage(m: UnifiedMessage): Record<string, any> {
    const msg = super.toOpenAIMessage(m);
    if (Array.isArray(m.content) && Array.isArray(msg.content)) {
      m.content.forEach((part, i) => {
        if (part.type === "text" && part.cacheControl && msg.content[i]?.type === "text") {
          msg.content[i] = { ...msg.content[i], cache_control: wireCacheControl(part.cacheControl) };
        }
      });
    }
    if (this.replayReasoningContent && m.role === "assistant") {
      const text = m.reasoning?.summary;
      if (typeof text === "string" && text.length > 0) msg.reasoning_content = text;
    }
    return msg;
  }
}
