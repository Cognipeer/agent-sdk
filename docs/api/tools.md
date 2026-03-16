# Tools And Context Tools

Tools are the action surface of the runtime. They should be typed, explicit, and easy to inspect in traces.

## `createTool(...)`

Use `createTool(...)` for the standard SDK tool shape.

```ts
import { createTool } from "@cognipeer/agent-sdk";
import { z } from "zod";

const search = createTool({
  name: "search_docs",
  description: "Search the docs index",
  schema: z.object({ query: z.string().min(1) }),
  func: async ({ query }) => ({ hits: [`result for ${query}`] }),
});
```

### Important fields

- `name`
- `description`
- `schema`
- `func`
- `needsApproval?`
- `approvalPrompt?`
- `approvalDefaults?`
- `maxExecutionsPerRun?`

## Approval-gated tools

If a tool is risky, mark it for approval:

```ts
const writeFile = createTool({
  name: "dangerous_write",
  description: "Write content to disk",
  schema: z.object({ path: z.string(), content: z.string() }),
  needsApproval: true,
  approvalPrompt: "Confirm the write is safe.",
  func: async ({ path, content }) => ({ ok: true, path, bytesWritten: content.length }),
});
```

The runtime pauses before execution, records a pending approval, and resumes after `resolveToolApproval(...)` is applied.

## Execution limits per tool

Use `maxExecutionsPerRun` when one specific tool should not be called indefinitely even if the global tool budget is still available.

## Non-SDK tools

You can also pass objects that expose `invoke`, `call`, `run`, or `func`. This is how LangChain and MCP-adapted tools integrate cleanly.

## Built-in context tools

`createSmartAgent(...)` may append runtime-managed tools:

- `manage_todo_list`
- `get_tool_response`
- `response` when `outputSchema` is active

### `manage_todo_list`

This is the planning tool for autonomous multi-step work.

- `write` creates or replaces the full plan
- `update` patches existing items by id
- `read` returns the current plan
- `expectedVersion` prevents stale writes from overwriting a newer plan

### `get_tool_response`

This is the recovery tool for summarized history. Use it when a large tool output has been archived and you need the raw execution payload again.

### `response`

This finalize tool is injected only when `outputSchema` is active. The model is expected to call it exactly once with the final JSON object.

## Tool authoring guidance

- validate inputs tightly with Zod
- return structured objects instead of long prose blobs
- throw actionable errors
- include source ids, cache flags, or other metadata when it improves downstream reasoning
- keep large outputs intentional, because they interact directly with summarization pressure
