
# Tool Development (Advanced)

This guide covers patterns and edge cases when authoring tools beyond the basic examples.

## Goals of a Good Tool
- Clear, concise purpose (single responsibility)
- Deterministic output structure
- Fast failure on invalid input
- Bounded payload size (avoid giant raw strings when possible)
- Helpful error surfaces (actionable error messages)

## Anatomy Recap
```ts
const weather = createTool({
  name: "weather_lookup",
  description: "Lookup current weather for a city",
  schema: z.object({ city: z.string().min(2), units: z.enum(["c","f"]).default("c") }),
  func: async ({ city, units }) => { /* ... */ return { city, units, temp: 21 }; }
});
```

Already have an existing LangChain or MCP tool? Wrap it via `fromLangchainTools([...])` and mix it with your custom tools:

```ts
import { fromLangchainTools } from "@cognipeer/agent-sdk";

const lcTools = await client.getTools();
const tools = [...fromLangchainTools(lcTools), weather];
```

`fromLangchainTools` keeps the input objects lazy—if `@langchain/core` is available the wrapper regenerates LangChain-compatible tools; otherwise it falls back to invoking them through the lightweight SDK contract.

## Input Validation
Rely on Zod for strong guarantees. Prefer transforming vague primitives into structured fields rather than post‑parsing inside `func`.

| Anti-Pattern | Improvement |
|--------------|------------|
| `z.string()` for numeric field | `z.number().int().min(0)` |
| Large union of literals but semantically same | Use enum + mapping |
| Opaque free-form JSON | Explicit object schema |

## Error Handling Strategy
Throw errors with a concise `message` – Smart Agent will surface them in the tool message. Avoid attaching huge stack traces as content.

```ts
if (!apiKey) throw new Error("MISSING_API_KEY: Set WEATHER_API_KEY env var");
```

Consider user-recoverable errors vs fatal:
- Recoverable (e.g. rate limit) – short message, model may retry with altered parameters.
- Fatal (schema misuse) – explicit message discouraging retry.

## Payload Size Control
Large tool results push token pressure higher. Techniques:
1. Return structured arrays with trimmed fields (title, url, score) rather than full documents.
2. Keep verbose/raw content behind an optional flag (e.g. `includeRaw: boolean`).
3. For binary / huge text: store externally, return reference ID.

## Idempotency & Caching
If your tool is deterministic for a given input, you can implement a lightweight memo cache external to the tool and return cached results. (Framework does not impose caching today.)

## Parallel Calls
`maxParallelTools` limits concurrency per turn. If your tool is resource heavy, document expected latency so users can tune this.

## Side Effects
Avoid unbounded side effects (writing files, mutating global state). Keep tools primarily query or pure transformation style.

## Security Guidelines
- Never echo secrets back.
- Sanitize user-provided URLs / paths.
- Enforce timeouts in long-running fetches.

## Testing Tools
Create a thin unit test harness:
```ts
const input = { city: "Berlin", units: "c" };
await expect(weather.func(input)).resolves.toMatchObject({ city: "Berlin" });
```
For fake/offline mode, stub network calls with deterministic fixtures.

## Observability
Emit relevant metadata within the returned object if it aids observability (e.g. `source: 'cache'`). Keep it concise.

## Human-in-the-loop approvals

Set `needsApproval: true` on any tool that should pause execution until a reviewer signs off. Optional helpers:

- `approvalPrompt`: short text for UI surfaces explaining what needs to be reviewed.
- `approvalDefaults`: arbitrary JSON you can use to pre-populate review forms.

When the model selects the tool, the SDK stores a pending entry in `state.pendingApprovals`. Your host app can present the request to a human and then resolve it. See the dedicated [Tool Approvals](/tool-approvals/) guide for end-to-end wiring, including `resolveToolApproval` usage, event payloads, and checkpoint integration.

## Per-tool execution limits

Set `maxExecutionsPerRun` when a tool should only succeed a fixed number of times within a single run:

```ts
const weather = createTool({
  name: "weather_lookup",
  description: "Lookup current weather for a city",
  schema: z.object({ city: z.string().min(2) }),
  func: async ({ city }) => ({ city, temp: 21 }),
  maxExecutionsPerRun: 3,
});
```

- `maxExecutionsPerRun: 3` means the fourth successful call is skipped with a tool message.
- `maxExecutionsPerRun: null` or omitting the field means unlimited usage.
- This limit is per tool and per run; it does not replace global controls like `limits.maxToolCalls` or `limits.maxParallelTools`.

## Patterns
| Pattern | Description | When to Use |
|---------|-------------|-------------|
| Delegation Tool | Wrap another agent (`agent.asTool()`) | Complex substeps |
| Handoff Tool | Transfer runtime (`agent.asHandoff()`) | Domain shift / expertise |
| Retrieval Tool | Thin API client returning structured hits | Search / knowledge |
| Aggregator Tool | Calls multiple internal functions then merges | Compose primitives |

## Failure Modes & Mitigation
| Failure | Mitigation |
|---------|-----------|
| Slow upstream API | Add timeout + partial fallback |
| Intermittent 500s | Basic retry with backoff (wrap inside `func`) |
| Large response | Summarize, or slice top-N before returning |
| Ambiguous user intent | Add disambiguation fields in schema |

## Anti-Patterns
- Returning full HTML pages or giant base64 blobs.
- Encoding additional JSON as a string inside an already JSON-returning tool.
- Overloading a tool to perform multiple unrelated tasks.

## Checklist Before Adding a Tool
- [ ] Name is action-oriented and unique
- [ ] Description clear for LLM selection
- [ ] Schema restrictive but ergonomic
- [ ] Errors are informative
- [ ] Output size bounded
- [ ] No secret leakage

