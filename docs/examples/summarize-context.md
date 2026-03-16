# Archived Tool Retrieval

This example focuses on the missing half of summarization: recovering raw tool output after the runtime has already compacted it.

<div class="example-meta"><a class="example-source-link" href="https://github.com/Cognipeer/agent-sdk/blob/main/examples/summarize-context/summarize-context.ts" target="_blank" rel="noreferrer">Open source: examples/summarize-context/summarize-context.ts</a></div>

## Use this when

- tool outputs are too large to keep live forever
- the agent may need the exact raw payload later
- you want a retrieval path after archival rather than blind compression

## What it shows

- context tools created through `createContextTools(...)`
- retrieval of archived tool outputs through `get_tool_response`
- a workflow where compact live context and raw evidence coexist

## Run it

```bash
cd examples
npm run example:summarize-context
```

## Core code

```ts
const heavyTool = createTool({
	name: "heavy_tool",
	description: "Returns heavy content",
	schema: z.object({ id: z.number().min(1) }),
	func: async ({ id }) => ({ data: "X".repeat(50000), id }),
});

const stateRef = { toolHistory: [], toolHistoryArchived: [] } as any;
const contextTools = createContextTools(stateRef);

const agent = createSmartAgent({
	model,
	tools: [heavyTool, ...contextTools],
	limits: { maxToolCalls: 3, contextTokenLimit: 2000, summaryTokenLimit: 500 },
});
```

## End-to-end flow

1. A `heavy_tool` intentionally returns a massive payload.
2. Context tools are attached to the runtime.
3. The smart runtime summarizes or archives the large tool result.
4. The code locates the summarized tool message and extracts its `executionId`.
5. `get_tool_response` retrieves the original raw payload.

## Why it matters

Summarization is only operationally safe if the agent can recover raw evidence later. This example demonstrates that recovery path directly.

## What to inspect

- the intentionally huge `heavy_tool` payload
- `createContextTools(...)` adding `get_tool_response`
- the follow-up recovery path using `executionId` from the summarized tool message

## Production takeaway

This pattern is what lets you keep live context compact without sacrificing auditability or evidence recovery.

## Expected output

- the console shows shortened message metadata for the summarized run
- a recovered raw payload length is printed after `get_tool_response` succeeds
- the example demonstrates both compaction and post-compaction recovery in one pass

## Common failure modes

- summarization does not trigger because token limits are misconfigured
- you look for `executionId` on the wrong message and never call `get_tool_response` successfully
- the state reference used for `createContextTools(...)` is not aligned with runtime history expectations