# Native LLM Providers

The SDK ships a built-in provider layer that calls LLM APIs directly using `fetch` — no LangChain, no extra framework dependency. All six providers share a unified `ChatCompletionRequest` / `ChatCompletionResponse` schema so swapping providers is a one-line change.

## Supported providers

| Provider | `provider` value | Notes |
|---|---|---|
| OpenAI | `"openai"` | Chat Completions API, SSE streaming |
| Anthropic | `"anthropic"` | Messages API, SSE streaming |
| Azure OpenAI | `"azure"` | Deployment-scoped URL, `api-key` auth |
| AWS Bedrock | `"bedrock"` | Converse API, SigV4 signing built-in |
| Google Vertex AI | `"vertex"` | Gemini generateContent, service account or access token auth |
| OpenAI-compatible | `"openai-compatible"` | Ollama, Groq, Together, Fireworks, vLLM, LiteLLM, … |

## Quick start

```ts
import { createProvider, fromNativeProvider, createSmartAgent } from "@cognipeer/agent-sdk";

const provider = createProvider({
  provider: "openai",
  apiKey: process.env.OPENAI_API_KEY!,
});

// Use directly
const response = await provider.complete({
  model: "gpt-4o",
  messages: [{ role: "user", content: "Hello!" }],
  temperature: 0.7,
  maxTokens: 1024,
});
console.log(response.content);
console.log(response.usage); // TokenUsage

// Or pass to agent-sdk
const model = fromNativeProvider(provider, { model: "gpt-4o" });
const agent = createSmartAgent({ model, tools: [...] });
```

## Provider configurations

### OpenAI

```ts
createProvider({
  provider: "openai",
  apiKey: process.env.OPENAI_API_KEY!,
  defaultModel: "gpt-4o",          // used when request.model is omitted
  organization: "org-...",          // optional
  baseURL: "https://api.openai.com/v1", // override for proxies
  defaultHeaders: { "X-Custom": "value" },
})
```

### Anthropic

```ts
createProvider({
  provider: "anthropic",
  apiKey: process.env.ANTHROPIC_API_KEY!,
  defaultModel: "claude-sonnet-4-20250514",
  anthropicVersion: "2023-06-01",   // optional, defaults to latest
  baseURL: "https://api.anthropic.com",
})
```

### Azure OpenAI

```ts
createProvider({
  provider: "azure",
  apiKey: process.env.AZURE_OPENAI_KEY!,
  endpoint: "https://my-resource.openai.azure.com",
  deploymentName: "gpt-4o",         // Azure deployment name
  apiVersion: "2024-10-21",         // optional, has a default
})
```

The request URL is constructed as:
```
{endpoint}/openai/deployments/{deploymentName}/chat/completions?api-version={apiVersion}
```

### AWS Bedrock

```ts
createProvider({
  provider: "bedrock",
  region: "us-east-1",
  accessKeyId: process.env.AWS_ACCESS_KEY_ID,        // or reads from env
  secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY, // or reads from env
  sessionToken: process.env.AWS_SESSION_TOKEN,        // optional, for STS
  defaultModel: "anthropic.claude-sonnet-4-20250514-v1:0",
})
```

AWS Signature V4 signing is implemented inline — no `@aws-sdk` dependency needed. If `accessKeyId` / `secretAccessKey` are omitted, the provider falls back to `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` environment variables.

### Google Vertex AI

```ts
// Option 1: pass an access token directly
createProvider({
  provider: "vertex",
  projectId: "my-gcp-project",
  location: "us-central1",          // optional, default "us-central1"
  accessToken: process.env.VERTEX_ACCESS_TOKEN,
  defaultModel: "gemini-2.0-flash",
})

// Option 2: service account JSON (auto-fetches + caches tokens)
createProvider({
  provider: "vertex",
  projectId: "my-gcp-project",
  serviceAccountJson: JSON.parse(process.env.GOOGLE_SA_JSON!),
})

// Option 3: gcloud CLI (falls back automatically)
// Just set projectId – the provider will run `gcloud auth print-access-token`
createProvider({
  provider: "vertex",
  projectId: "my-gcp-project",
})
```

### OpenAI-compatible

Works with any endpoint that mirrors the OpenAI Chat Completions API:

```ts
// Groq
createProvider({ provider: "openai-compatible", apiKey: "gsk_...", baseURL: "https://api.groq.com/openai/v1", defaultModel: "llama-3.3-70b-versatile" })

// Ollama (local)
createProvider({ provider: "openai-compatible", apiKey: "ollama", baseURL: "http://localhost:11434/v1", defaultModel: "llama3.2" })

// Together AI
createProvider({ provider: "openai-compatible", apiKey: "...", baseURL: "https://api.together.xyz/v1", defaultModel: "mistralai/Mixtral-8x7B-Instruct-v0.1" })

// vLLM
createProvider({ provider: "openai-compatible", apiKey: "token", baseURL: "http://vllm-host:8000/v1", defaultModel: "meta-llama/Llama-3.1-8B-Instruct" })
```

## Unified request schema

All providers consume the same `ChatCompletionRequest`:

```ts
type ChatCompletionRequest = {
  model: string;
  messages: UnifiedMessage[];     // system / user / assistant / tool
  temperature?: number;
  maxTokens?: number;
  topP?: number;
  stop?: string[];
  tools?: ToolDefinition[];
  toolChoice?: "auto" | "required" | "none" | { name: string };
  responseFormat?: {
    type: "json_schema" | "json_object" | "text";
    schema?: Record<string, any>;
    name?: string;
  };
  reasoning?: {
    effort?: "minimal" | "low" | "medium" | "high";
    budgetTokens?: number;
    includeThoughts?: boolean;
    providerExtras?: Record<string, any>;
  };
  stream?: boolean;
  extra?: Record<string, any>;   // provider-specific extras
};
```

## Native reasoning pass-through

The native provider layer accepts one unified reasoning shape and maps it to each provider's wire format.

```ts
const provider = createProvider({ provider: "openai", apiKey: process.env.OPENAI_API_KEY! });

const response = await provider.complete({
  model: "gpt-5",
  messages: [{ role: "user", content: "Compare these designs and justify the next step." }],
  reasoning: { effort: "high" },
});
```

Provider mapping:

| Provider | Mapping |
|---|---|
| OpenAI | `body.reasoning_effort = effort` |
| Azure OpenAI | Same as OpenAI (`AzureProvider` extends `OpenAIProvider`) |
| OpenAI-compatible | Same as OpenAI when the endpoint understands the field |
| Anthropic | `body.thinking = { type: "enabled", budget_tokens }` |
| Vertex / Gemini | `generationConfig.thinkingConfig = { thinkingBudget, includeThoughts }` |
| Bedrock | Currently ignored (no-op) |

Notes:

- If `budgetTokens` is omitted, Anthropic and Vertex derive a default from `effort`.
- `includeThoughts` currently affects Gemini/Vertex thought summaries.
- `providerExtras` is merged into the provider-specific reasoning object/body.
- Unsupported models/endpoints usually return a provider error instead of silently degrading.

### Messages

```ts
// Text
{ role: "user", content: "Hello!" }

// Multimodal (image)
{
  role: "user",
  content: [
    { type: "text", text: "Describe this image" },
    { type: "image", source: { type: "base64", mediaType: "image/png", data: "..." } },
    { type: "image", source: { type: "url", url: "https://..." } },
  ]
}

// Assistant with tool calls
{
  role: "assistant",
  content: null,
  toolCalls: [{ id: "call_1", name: "search", arguments: '{"q":"weather"}' }]
}

// Tool result
{ role: "tool", content: '{"temp":22}', toolCallId: "call_1" }
```

## Token usage

Every `ChatCompletionResponse` includes a normalized `TokenUsage`:

```ts
type TokenUsage = {
  inputTokens: number;         // prompt tokens
  outputTokens: number;        // completion tokens
  totalTokens: number;
  cachedInputTokens: number;   // cache read (all providers)
  cachedWriteTokens: number;   // cache write/creation (Anthropic, Bedrock)
  cachedOutputTokens: number;
  reasoningTokens: number;     // OpenAI o-series, Vertex Gemini thinking
};
```

`reasoningTokens` is especially useful when you enable native reasoning, because it shows how much inference budget the provider attributed to the thinking/reasoning path.

Provider-specific field mapping:

| Provider | `cachedInputTokens` source | `cachedWriteTokens` source | `reasoningTokens` source |
|---|---|---|---|
| OpenAI | `prompt_tokens_details.cached_tokens` | — | `completion_tokens_details.reasoning_tokens` |
| Anthropic | `cache_read_input_tokens` | `cache_creation_input_tokens` | — |
| Azure | same as OpenAI | — | same as OpenAI |
| Bedrock | `cacheReadInputTokenCount` | `cacheWriteInputTokenCount` | — |
| Vertex | `cachedContentTokenCount` | — | `thoughtsTokenCount` |

## Streaming

```ts
const provider = createProvider({ provider: "anthropic", apiKey: "..." });

for await (const chunk of provider.completeStream({
  model: "claude-sonnet-4-20250514",
  messages: [{ role: "user", content: "Write a haiku" }],
})) {
  if (chunk.delta.content) process.stdout.write(chunk.delta.content);
  if (chunk.usage) console.log("\nFinal usage:", chunk.usage);
}
```

Streaming is supported for OpenAI, Anthropic, Azure, OpenAI-compatible, and Vertex. Bedrock currently falls back to a single non-streaming response (Bedrock's binary event-stream protocol support is planned).

## Using with agent-sdk

`fromNativeProvider` wraps any provider as a `BaseChatModel` so it integrates seamlessly:

```ts
import { fromNativeProvider, createProvider, createSmartAgent } from "@cognipeer/agent-sdk";

const model = fromNativeProvider(
  createProvider({ provider: "anthropic", apiKey: "..." }),
  {
    model: "claude-sonnet-4-20250514",
    temperature: 0.3,
    maxTokens: 8192,
    reasoning: { effort: "medium" },
  },
);

const agent = createSmartAgent({
  model,
  tools: [...],
  runtimeProfile: "balanced",
});
```

The adapter automatically configures `model.capabilities` so the smart runtime can pick the correct structured output strategy (`native` vs `tool_based`) without manual configuration.

`fromNativeProvider(...)` also supports per-call overrides. The adapter default can be changed for one invocation only:

```ts
await model.invoke(messages, {
  reasoning: { effort: "low" },
  tool_choice: "none",
});
```

## Direct provider usage (without agent)

You can use providers standalone for one-shot completions, batch jobs, or embedding in your own loop:

```ts
const provider = createProvider({ provider: "openai", apiKey: "..." });

// Non-streaming
const res = await provider.complete({
  model: "gpt-4o",
  messages: [{ role: "user", content: "Summarize this article." }],
  maxTokens: 512,
});
console.log(res.content, res.usage, res.finishReason);

// With tools
const toolRes = await provider.complete({
  model: "gpt-4o",
  messages: [...],
  tools: [{ name: "search", description: "...", parameters: { type: "object", properties: { q: { type: "string" } } } }],
  toolChoice: "auto",
});
for (const tc of toolRes.toolCalls) {
  console.log(tc.id, tc.name, JSON.parse(tc.arguments));
}
```

## Error handling

All providers throw `ProviderError` on API failures:

```ts
import { ProviderError } from "@cognipeer/agent-sdk";

try {
  const res = await provider.complete({ ... });
} catch (err) {
  if (err instanceof ProviderError) {
    console.error(`${err.provider} error ${err.statusCode}:`, err.message);
    console.error("Response body:", err.responseBody);
  }
}
```

## Making this a separate package

The `src/providers/` folder is intentionally self-contained. It has no imports from the rest of the SDK except `BaseChatModel` (used only in `adapter.ts`). To extract it as a separate package:

1. Copy `src/providers/` into a new package root.
2. Replace the `BaseChatModel` import in `adapter.ts` with the type inline or a shared types package.
3. Add a `package.json` targeting Node 18.17+, ESM output via tsup.
4. Re-export from the new package's `index.ts`.

The provider layer has zero runtime dependencies — only Node.js built-ins (`crypto`, `child_process`).
