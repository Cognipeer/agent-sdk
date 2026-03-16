# MCP

Model Context Protocol is a strong fit for autonomous agents because it turns external capabilities into discoverable tools instead of hard-coded SDK integrations.

## What MCP gives you here

With Agent SDK, MCP is mainly about one thing: turning remote tool servers into normal runtime tools that participate in the same planning, tracing, approvals, and summarization flow as local tools.

## Recommended setup

```ts
import { createSmartAgent, fromLangchainModel, fromLangchainTools } from "@cognipeer/agent-sdk";
import { ChatOpenAI } from "@langchain/openai";
import { MultiServerMCPClient } from "@langchain/mcp-adapters";

const client = new MultiServerMCPClient({
  throwOnLoadError: true,
  prefixToolNameWithServerName: true,
  useStandardContentBlocks: true,
  mcpServers: {
    "tavily-remote-mcp": {
      transport: "stdio",
      command: "npx",
      args: ["-y", "mcp-remote", `https://mcp.tavily.com/mcp/?tavilyApiKey=${process.env.TAVILY_API_KEY}`],
      env: {},
    },
  },
});

const tools = fromLangchainTools(await client.getTools());
const model = fromLangchainModel(new ChatOpenAI({ model: "gpt-4o-mini", apiKey: process.env.OPENAI_API_KEY }));

const agent = createSmartAgent({
  name: "MCP Explorer",
  model,
  tools,
  runtimeProfile: "balanced",
  planning: { mode: "todo" },
  limits: { maxToolCalls: 10, maxContextTokens: 12000 },
});
```

## Why this matters for autonomous agents

MCP becomes especially valuable when the agent needs to:

- discover tools from a remote server at runtime
- mix local and remote tools in one execution loop
- keep external actions inside the same approval and trace pipeline
- recover after large tool outputs are summarized

## Best practices

- prefer `planning.mode` over legacy `useTodoList`
- prefix server tool names so multi-server environments stay unambiguous
- expect some MCP tools to return large payloads and plan for summarization
- use tracing from day one so remote-tool failures are visible

## Common failure points

### Tool names are unclear

Enable server-prefixed names when you connect to multiple MCP servers.

### Outputs are too large

Use smart runtime summarization and `get_tool_response` for recovery instead of forcing huge raw payloads into every turn.

### Authentication is flaky

Treat MCP credentials like any other production secret and keep the auth surface outside prompts.

## Example to run

The repository includes an MCP example:

```bash
cd examples
npm run example:mcp-tavily
```
