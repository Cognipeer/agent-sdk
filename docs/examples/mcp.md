# MCP Tools

This example connects a remote MCP tool server, discovers tools from it, and runs those tools inside the normal smart runtime.

<div class="example-meta"><a class="example-source-link" href="https://github.com/Cognipeer/agent-sdk/blob/main/examples/mcp-tavily/mcp_tavily.ts" target="_blank" rel="noreferrer">Open source: examples/mcp-tavily/mcp_tavily.ts</a></div>

## Use this when

- tool capabilities live outside your process
- you want remote tools to participate in the same planning and tracing loop as local tools
- you need a real MCP integration reference instead of a conceptual guide

## What it shows

- `MultiServerMCPClient` setup
- remote tool discovery
- `fromLangchainTools(...)` bridge into Agent SDK
- smart runtime planning over MCP tools

## Run it

```bash
cd examples
npm run example:mcp-tavily
```

## Core code

```ts
const client = new MultiServerMCPClient({
	throwOnLoadError: true,
	prefixToolNameWithServerName: true,
	useStandardContentBlocks: true,
	mcpServers: {
		"tavily-remote-mcp": {
			transport: "stdio",
			command: "npx",
			args: ["-y", "mcp-remote", `https://mcp.tavily.com/mcp/?tavilyApiKey=${TAVILY_API_KEY}`],
			env: {},
		},
	},
});

const tools = fromLangchainTools(await client.getTools());
const agent = createSmartAgent({
	model,
	tools,
	useTodoList: true,
	limits: { maxToolCalls: 10 },
	summarization: { enable: true, maxTokens: 6000 },
});
```

## Environment notes

This example expects the relevant provider credentials, including the Tavily API key and the model provider key used by the script.

## End-to-end flow

1. An MCP client is created with a Tavily-backed server definition.
2. The client discovers remote tools.
3. `fromLangchainTools(...)` adapts them into SDK-native tools.
4. A smart agent uses those tools with planning and summarization enabled.
5. The client is closed in a `finally` block after the run.

## Why this example matters

It proves that MCP tools do not need a separate orchestration path. They can live inside the same planning, tracing, and summarization loop as local tools.

## What to inspect

- the MCP client bootstrap
- tool discovery through `client.getTools()`
- conversion with `fromLangchainTools(...)`
- cleanup with `client.close()` in the `finally` block

## Production takeaway

This is the reference pattern when MCP is part of the production tool surface rather than a separate experimental path.

## Expected output

- discovered MCP tool names are printed before the run
- if credentials are present, the agent returns a short Tavily-backed summary
- if keys are missing, the script explains why the agent run is skipped

## Common failure modes

- `OPENAI_API_KEY` or `TAVILY_API_KEY` is missing
- the remote MCP transport fails to connect or load tools
- the example is interrupted before `client.close()` executes, leaving cleanup incomplete
