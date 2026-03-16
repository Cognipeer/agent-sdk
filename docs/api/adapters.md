# Adapters And Models

Adapters let you keep the runtime generic while still using LangChain models, MCP-hosted tools, or custom provider SDKs.

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
