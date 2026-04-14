# Adapters And Models

Adapters let you keep the runtime generic while still using LangChain models, MCP-hosted tools, or native provider SDKs.

The SDK ships two model integration paths:

| Path | Import | Dependency |
|---|---|---|
| **Native providers** | `createProvider` + `fromNativeProvider` | None – fetch only |
| **LangChain adapter** | `fromLangchainModel` | `@langchain/core` |

## Native Providers

Use `createProvider` + `fromNativeProvider` to talk to any supported LLM directly without any framework dependency. The unified schema maps every provider's wire format to `ChatCompletionRequest` / `ChatCompletionResponse`.

### Supported providers

| `provider` value | Service |
|---|---|
| `"openai"` | OpenAI Chat Completions |
| `"anthropic"` | Anthropic Messages API |
| `"azure"` | Azure OpenAI |
| `"bedrock"` | AWS Bedrock Converse API |
| `"vertex"` | Google Vertex AI (Gemini) |
| `"openai-compatible"` | Any OpenAI-compatible endpoint |

### `createProvider(config)`

```ts
import { createProvider, fromNativeProvider } from "@cognipeer/agent-sdk";

const provider = createProvider({
  provider: "openai",
  apiKey: process.env.OPENAI_API_KEY!,
  defaultModel: "gpt-4o",
});

// Use directly
const response = await provider.complete({
  model: "gpt-4o",
  messages: [{ role: "user", content: "Hello!" }],
});
console.log(response.content);
console.log(response.usage); // { inputTokens, outputTokens, cachedInputTokens, ... }

// Or wrap as BaseChatModel for agent-sdk
const model = fromNativeProvider(provider, { model: "gpt-4o" });
```

### Provider configurations

```ts
// OpenAI
createProvider({ provider: "openai", apiKey: "sk-...", defaultModel: "gpt-4o" })

// Anthropic
createProvider({ provider: "anthropic", apiKey: "sk-ant-...", defaultModel: "claude-sonnet-4-20250514" })

// Azure OpenAI
createProvider({
  provider: "azure",
  apiKey: "...",
  endpoint: "https://my-resource.openai.azure.com",
  deploymentName: "gpt-4o",
  apiVersion: "2024-10-21",
})

// AWS Bedrock (reads AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY env vars if not provided)
createProvider({
  provider: "bedrock",
  region: "us-east-1",
  accessKeyId: "AKID...",
  secretAccessKey: "...",
  defaultModel: "anthropic.claude-sonnet-4-20250514-v1:0",
})

// Google Vertex AI – access token
createProvider({
  provider: "vertex",
  projectId: "my-project",
  location: "us-central1",
  accessToken: process.env.VERTEX_TOKEN,
  defaultModel: "gemini-2.0-flash",
})

// Google Vertex AI – service account JSON (auto-generates token)
createProvider({
  provider: "vertex",
  projectId: "my-project",
  serviceAccountJson: JSON.parse(process.env.GOOGLE_SA_JSON!),
})

// OpenAI-compatible (Ollama, Groq, Together, Fireworks, vLLM, LiteLLM, …)
createProvider({
  provider: "openai-compatible",
  apiKey: "...",
  baseURL: "https://api.groq.com/openai/v1",
  defaultModel: "llama-3.3-70b-versatile",
})
```

### Token usage

All providers return a unified `TokenUsage` object:

```ts
type TokenUsage = {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  cachedInputTokens: number;  // prompt cache read (all providers)
  cachedWriteTokens: number;  // cache creation (Anthropic / Bedrock)
  cachedOutputTokens: number;
  reasoningTokens: number;    // OpenAI o-series / Vertex Gemini thinking
};
```

### Streaming

```ts
const provider = createProvider({ provider: "openai", apiKey: "..." });

for await (const chunk of provider.completeStream({ model: "gpt-4o", messages: [...] })) {
  if (chunk.delta.content) process.stdout.write(chunk.delta.content);
  if (chunk.usage) console.log("tokens:", chunk.usage.totalTokens);
}
```

### `fromNativeProvider(provider, options?)`

Wraps any native provider as a `BaseChatModel` so it works seamlessly with `createAgent` / `createSmartAgent`:

```ts
const model = fromNativeProvider(provider, {
  model: "gpt-4o",
  temperature: 0.7,
  maxTokens: 4096,
});

const agent = createSmartAgent({ model, tools: [...] });
```

The adapter automatically sets provider-appropriate `capabilities` (structured output mode, streaming support) so the runtime can pick the right strategy without manual configuration.

| Provider | `structuredOutput` | `streaming` |
|---|---|---|
| openai / azure / openai-compatible | `native` | `true` |
| anthropic | `tool_based` | `true` |
| bedrock | `tool_based` | `false`* |
| vertex | `native` | `true` |

\* Bedrock streaming uses a binary event-stream protocol; full support is planned.

---

## `fromLangchainModel(...)`

Wrap a LangChain chat model so it matches the SDK's model contract.

```ts
import { fromLangchainModel } from "@cognipeer/agent-sdk";
import { ChatOpenAI } from "@langchain/openai";

const model = fromLangchainModel(
  new ChatOpenAI({
    model: "gpt-4o-mini",
    apiKey: process.env.OPENAI_API_KEY,
  })
);
```

The adapter normalizes message shape and can bind tools when the underlying model supports it.

## `fromLangchainTools(...)`

Convert LangChain-compatible tools into SDK-native tools.

```ts
import { fromLangchainTools } from "@cognipeer/agent-sdk";

const sdkTools = fromLangchainTools(langchainTools);
```

This is the main bridge for MCP tooling as well.

## `withTools(...)`

`withTools(...)` is a thin helper that binds tools to models which support native tool binding.

```ts
const modelWithTools = withTools(model, tools);
```

In most app code you will not call it directly because the runtime handles binding automatically.

## MCP integration pattern

Use an MCP client to discover tools, then adapt them with `fromLangchainTools(...)`.

```ts
import { MultiServerMCPClient } from "@langchain/mcp-adapters";
import { fromLangchainTools } from "@cognipeer/agent-sdk";

const client = new MultiServerMCPClient({ /* ... */ });
const tools = fromLangchainTools(await client.getTools());
```

That keeps MCP tools inside the same runtime surface as local tools, approvals, and traces.

## Custom model contract

If you are not using LangChain, the model only needs an `invoke(messages)` method. `bindTools(...)` is optional but helpful.

```ts
const customModel = {
  async invoke(messages) {
    return {
      role: "assistant",
      content: "hello",
    };
  },
  bindTools(tools) {
    return this;
  },
};
```

The simpler this adapter stays, the easier your runtime becomes to reason about.

## Guidance

- prefer `fromLangchainModel(...)` for mainstream provider integrations
- prefer `fromLangchainTools(...)` for MCP or LangChain tool ecosystems
- implement a custom adapter only when you need a provider not already covered by your stack
- keep provider-specific auth and transport logic outside prompts
- [Agent API](/api/agent) - Agent configuration options
