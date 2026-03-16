# Tools

This example is the best entry point for local tool authoring with real validation, environment checks, and external API usage.

<div class="example-meta"><a class="example-source-link" href="https://github.com/Cognipeer/agent-sdk/blob/main/examples/tools/tools.ts" target="_blank" rel="noreferrer">Open source: examples/tools/tools.ts</a></div>

## Use this when

- you need to define tools with Zod schemas
- you want to compare simple vs external-API-backed tool implementations
- you want to keep the focus on tool design rather than smart runtime behavior

## What it shows

- multiple locally defined tools
- Zod-backed input validation
- normal tool call and result flow through the runtime

## Run it

```bash
cd examples
npm run example:tools
```

## Core code

```ts
const echo = createTool({
	name: "echo",
	description: "Echo back",
	schema: z.object({ text: z.string().min(1) }),
	func: async ({ text }) => ({ echoed: text }),
});

const tavilySearch = createTool({
	name: "tavily_search",
	description: "Perform a web search via Tavily API and return top results.",
	schema: z.object({
		query: z.string().min(3),
		maxResults: z.number().int().min(1).max(10).nullable(),
		includeRaw: z.boolean().nullable(),
	}),
	func: async ({ query, maxResults, includeRaw }) => {
		return { items: [] };
	},
});

const agent = createAgent({
	model,
	tools: [echo, tavilySearch],
	limits: { maxToolCalls: 10 },
});
```

## End-to-end flow

1. The script validates required environment variables before the run.
2. Two tools are registered: a trivial `echo` and a more realistic `tavily_search`.
3. The agent receives a user request that may require search.
4. The runtime executes whichever tool the model chooses.
5. The final response is assembled from tool results.

## Why it matters

Read this before adapting external tools. It shows the clean native shape the rest of the runtime expects.

## How to read this example

- `echo` shows the smallest useful tool shape.
- `tavily_search` shows a more production-like tool with nullable options, environment checks, external HTTP calls, and structured return data.
- the agent stays on the base runtime so the example stays focused on tool authoring rather than planning behavior.

## Production takeaway

Good tools are typed, explicit, and operationally boring. This example is useful precisely because it keeps business logic inside tools instead of burying it inside prompts.

## Expected output

- the console prints a final summary response
- if Tavily is configured, the response may include web-search-backed material
- tracing can emit session data depending on your sink configuration

## Common failure modes

- `OPENAI_API_KEY` is not set: the script exits before a real run starts
- `TAVILY_API_KEY` is missing and the model tries to call `tavily_search`: the tool throws an explicit error
- Tavily responds with a non-200 status: the script surfaces the remote error text