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

#### Choosing the upstream API: Chat Completions or Responses

`api` selects the upstream API on `OpenAIProvider`, `AzureProvider` and `OpenAICompatibleProvider`. The default is `"auto"`, which is exactly what 0.11 did, so upgrading changes nothing; `"chat"` and `"responses"` are explicit choices.

```ts
createProvider({
  provider: "openai",            // also "azure" and "openai-compatible"
  apiKey: process.env.OPENAI_API_KEY!,
  api: "responses",              // "auto" (default) | "chat" | "responses"
})
```

| `api` | Behaviour |
|---|---|
| `"auto"` (default) | Same as 0.11. OpenAI and Azure: Responses when the request carries `reasoning` and the model name looks like an o-series / gpt-5 model, otherwise Chat Completions. OpenAI-compatible: always Chat Completions (the model name is the server operator's, so it is never guessed). |
| `"chat"` | Every request goes to `/chat/completions` (Azure: the deployment route). `reasoning` is mapped to `reasoning_effort`. |
| `"responses"` | Every request goes to `/responses` (Azure: `/openai/responses`). `completeStream()` uses real SSE streaming: text, tool-call argument and reasoning-summary deltas arrive as they are produced, then one closing chunk carries usage and finish reason. Set `responsesStreaming: false` to make one non-streaming call emitted as a single chunk. Chat Completions spellings in `extra` that `/responses` rejects are re-spelled (`reasoning_effort` becomes `reasoning.effort`, `max_tokens` becomes `max_output_tokens`, `response_format` becomes `text.format`, `stream_options.include_usage` is dropped). |

Why offer explicit values: Responses is a different request shape (`input` instead of `messages`, `text.format` instead of `response_format`, flat tool objects) and a different response parse. Guessing it from a model name silently changed the transport for self-hosted servers and gateways that serve only one of the two. If your application has a per-model setting, pass it straight through:

```ts
createProvider({ provider: "openai-compatible", baseURL, apiKey, api: model.upstreamApi }) // "auto" | "chat" | "responses"
```

**Compatibility with 0.11.** Nothing to migrate: `api` defaults to `"auto"`, which keeps each class's 0.11 behaviour (OpenAI and Azure: name heuristic; OpenAI-compatible: Chat Completions). The deprecated `responsesApi` option still works: `"never"` is `api: "chat"`, `"always"` is `api: "responses"` (keeping its old single-call behaviour unless you also set `responsesStreaming: true`), `"auto"` is `api: "auto"`. When both are given, `api` wins; `responsesApi: "auto"` on an OpenAI-compatible provider opts it into the name heuristic.

##### Per-model opt-in (`responsesApiModels`)

Some models reason by default and reject function tools on Chat Completions, with or without a reasoning field (for example the GPT-6 family on an Azure `/openai/v1` endpoint: *"Function tools with reasoning_effort are not supported ... use /v1/responses"*). To send only those models to Responses, list them:

```ts
createProvider({
  provider: "openai",
  apiKey: process.env.AZURE_OPENAI_KEY!,
  baseURL: "https://my-resource.openai.azure.com/openai/v1",
  responsesApiModels: ["gpt-6.1-sol", /^gpt-6-/], // exact strings or RegExps
  responsesStreaming: true,                      // stream these models over SSE
})
```

For a listed model: requests go to `/responses` whether or not they carry `reasoning`; the `extra` re-spelling above applies; with `responsesStreaming: true` the stream is real SSE, otherwise one non-streaming call is emitted as one chunk. Unlisted models stay on Chat Completions. `api: "chat"` (or `responsesApi: "never"`) overrides the list. The list works on `OpenAIProvider`, `AzureProvider` and `OpenAICompatibleProvider` alike.

A RegExp covers families that do not exist yet, for example `/^gpt-(?:[6-9]|[1-9]\d+)(?!\d)/i` matches gpt-6, gpt-7.2-mini and gpt-10, but not gpt-5.x, gpt-4o or o3. Note that reasoning models on `/responses` also reject `temperature`, `top_p` and `stop`. Reasoning effort values in `extra` are passed through unvalidated, so which values a model accepts is the caller's configuration.

### Anthropic

```ts
createProvider({
  provider: "anthropic",
  apiKey: process.env.ANTHROPIC_API_KEY!,
  defaultModel: "claude-sonnet-4-20250514",
  anthropicVersion: "2023-06-01",      // optional, defaults to latest
  baseURL: "https://api.anthropic.com",
  prompt_caching: { enabled: true },   // see "Prompt caching" below
  retry: { maxRetries: 4, baseDelayMs: 500 }, // see "Retry & backoff" below
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

The default `apiVersion` (`2024-10-21`) is for Chat Completions only; it does not serve `/openai/responses`. With `api: "responses"` (or `responsesApiModels`) set a Responses-capable version, for example:

```ts
createProvider({
  provider: "azure",
  apiKey: process.env.AZURE_OPENAI_KEY!,
  endpoint: "https://my-resource.openai.azure.com",
  deploymentName: "gpt-5",
  apiVersion: "preview",            // or "v1" / a dated Responses-capable version
  api: "responses",                 // POST {endpoint}/openai/responses?api-version=preview
})
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
  prompt_caching: { enabled: true },   // see "Prompt caching" below
  retry: { maxRetries: 4 },            // see "Retry & backoff" below
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
  signal?: AbortSignal;          // hangs up the HTTP request / stream when it aborts
};
```

## Prompt caching

Long-running tool-heavy agents repeat the same system prompt and tool catalog on every turn. Anthropic and Bedrock (Converse) charge for those tokens unless you place a cache breakpoint, in which case cached tokens cost roughly 10% of normal input pricing.

Opt in on the provider config:

```ts
createProvider({
  provider: "anthropic",
  apiKey: process.env.ANTHROPIC_API_KEY!,
  prompt_caching: { enabled: true },
});
```

When enabled:

- **Anthropic** — the provider wraps the system prompt as a `[{ type: "text", text, cache_control: { type: "ephemeral" } }]` block and places a `cache_control: ephemeral` marker on the last tool definition. The cumulative effect caches `[system + all tool definitions]`, which is the largest stable prefix in a tool-heavy run.
- **Bedrock** — the provider appends `{ cachePoint: { type: "default" } }` blocks at the end of the `system` and `toolConfig.tools` arrays (Converse-API native shape).
- **OpenAI / Azure** — caching is automatic for prompts over the provider's threshold; no breakpoint configuration needed.

Cache hit/miss tokens flow back through `response.usage.cachedInputTokens` and `response.usage.cachedWriteTokens` regardless of which provider you use, so you can verify the cache is working from telemetry without provider-specific code.

When NOT to enable caching: short-lived runs (less than ~1k tokens of stable prefix), workflows whose system prompt is rewritten every turn, or test environments where you do not want cache eviction noise polluting traces.

## Retry & backoff

Native providers retry transient failures automatically. Defaults retry on `429` and `5xx` with exponential backoff and honour `Retry-After`. Configure per provider:

```ts
createProvider({
  provider: "openai",
  apiKey: "...",
  retry: {
    maxRetries: 3,              // default
    baseDelayMs: 500,           // default; doubled per attempt up to maxDelayMs
    maxDelayMs: 8000,           // default
    shouldRetry: (err, attempt) => err.status !== 401, // custom predicate
  },
});
```

The retry helper drains the response body between attempts so connections are reused. 4xx responses other than 429 surface immediately. Once `maxRetries` is exhausted, the final response is converted to a `ProviderError` like any other failure.

A cancelled call does not sit out a backoff delay or start another attempt: when the request's `signal` aborts, the wait ends and the call rejects with the abort error.

This is separate from per-tool `retry` policies on `createTool(...)` — provider retries cover the model call, tool retries cover external API calls inside your `func`.

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
| Anthropic | Older models: `body.thinking = { type: "enabled", budget_tokens }`. Claude 5.x: `thinking = { type: "adaptive", display: "summarized" }` plus `output_config.effort` |
| Vertex / Gemini | `generationConfig.thinkingConfig = { thinkingBudget, includeThoughts }` |
| Bedrock | Claude models: same shapes as Anthropic inside `additionalModelRequestFields`. Other models: ignored |

Notes:

- If `budgetTokens` is omitted, Anthropic and Vertex derive a default from `effort`.
- `includeThoughts` affects Gemini/Vertex thought summaries and Claude visible thinking. Claude 5.x models return an empty `thinking` text unless `thinking.display` is requested, so on the adaptive form the SDK sends `display: "summarized"` unless `includeThoughts` is `false`. The text is a summary of the reasoning, not the raw chain of thought. An explicit `extra.thinking` is never modified, and `providerExtras` can override `display` (for example another documented value).
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
| Anthropic | `cache_read_input_tokens` | `cache_creation_input_tokens` | `output_tokens_details.thinking_tokens` (when the API reports it) |
| Azure | same as OpenAI | — | same as OpenAI |
| Bedrock | `cacheReadInputTokens` (falls back to `cacheReadInputTokenCount`) | `cacheWriteInputTokens` (falls back to `cacheWriteInputTokenCount`) | — |
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

Streaming is supported for OpenAI, Anthropic, Azure, OpenAI-compatible, Vertex and Bedrock. Bedrock streams over ConverseStream (AWS binary event-stream).

### Cancellation

Pass `signal` and the provider hangs up when it aborts: the HTTP request is cancelled, an open stream is closed, and the call rejects with an `AbortError`. A stream whose consumer simply stops reading (a `break`, a `return`) is closed the same way, instead of staying open until the model finishes.

```ts
const controller = new AbortController();
setTimeout(() => controller.abort(), 5_000);

for await (const chunk of provider.completeStream({ model, messages, signal: controller.signal })) {
  // ...
}
```

Inside an agent you do not set this yourself. A run's `cancellationToken` (an `AbortSignal`, or any `{ isCancellationRequested }` token) reaches the model call: `fromNativeProvider` and `fromLangchainModel` turn it into a real `AbortSignal` for the request, so cancelling a turn stops the model rather than just ignoring what it still says. The run then ends with `state.ctx.__cancelled` set (`stage: "agent"`, reason `"aborted"` or `"cancelled"`) and a `cancelled` event — it is not thrown as a model error. Whatever text had already streamed is kept as the assistant turn; a tool call that had not finished streaming is dropped, so the transcript never holds an unanswered `tool_call`.

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
