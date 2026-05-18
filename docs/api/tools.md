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
- `cache?` — opt-in result cache (`true` or `{ keyFn?, ttlMs?, scope? }`). Identical args inside the same invoke skip re-execution and the cached value is replayed from `state.toolCache`.
- `retry?` — per-tool retry policy: `{ maxRetries?, backoffMs?, shouldRetry?, circuitBreakerThreshold? }`. Exponential backoff doubles `backoffMs` per attempt. After `circuitBreakerThreshold` consecutive failures the tool short-circuits with a breaker error for the rest of the invoke.

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

## Idempotent tool caching

When a tool is deterministic for a given input (e.g. file reads, web fetches, lookups), opt into the per-invoke cache:

```ts
const fetchPage = createTool({
  name: "fetch_page",
  description: "Fetch a static page",
  schema: z.object({ url: z.string().url() }),
  func: async ({ url }) => fetch(url).then((r) => r.text()),
  cache: true, // identical { url } within the same invoke replays the result
});
```

Advanced form:

```ts
cache: {
  keyFn: (args) => args.url, // canonicalize cache key
  ttlMs: 30_000,             // expire cached entries after 30s
}
```

The cache lives on `state.toolCache` and is scoped to the current invoke. Cached results are flagged with `fromCache: true` in `state.toolHistory`.

## Retry and circuit breaker

Per-tool retry policy with exponential backoff:

```ts
const search = createTool({
  name: "search",
  description: "External search API",
  schema: z.object({ q: z.string() }),
  func: async ({ q }) => searchClient.query(q),
  retry: {
    maxRetries: 3,
    backoffMs: 500,                  // doubles each attempt (500, 1000, 2000, ...)
    shouldRetry: (err) => !`${err?.message}`.includes("UNAUTHORIZED"),
    circuitBreakerThreshold: 5,      // open the breaker after 5 consecutive failures
  },
});
```

Once the breaker opens, subsequent calls to that tool within the same invoke short-circuit with a breaker error message — no model retries, no extra latency.

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
