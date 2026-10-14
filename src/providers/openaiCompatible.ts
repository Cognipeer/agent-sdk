// OpenAI-compatible API provider.
// Works with any API that implements the OpenAI Chat Completions spec
// (e.g. Ollama, Together, Groq, Fireworks, vLLM, LiteLLM, etc.)

import { OpenAIProvider } from "./openai.js";
import type { OpenAICompatibleProviderConfig, ProviderType } from "./types.js";

export class OpenAICompatibleProvider extends OpenAIProvider {
  override readonly providerName: ProviderType = "openai-compatible";

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
  }
}
