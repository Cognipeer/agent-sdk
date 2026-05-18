---
title: Tool-Heavy & Long-Running Agents
permalink: /tool-heavy-agents/
---

# Tool-Heavy / Long-Running Agents

This guide covers the practical knobs that matter when an agent runs for tens of turns, dispatches many tool calls, and has to do it cheaply enough to put into production.

If you are building a coding-style agent, a research agent, or any workflow that loops through dozens of tool calls, start here.

## 1. Cost: enable prompt caching

Long agents repeat the same system prompt and tool catalog on every turn. Without caching that is hundreds of redundant prompt tokens per turn.

```ts
import { createProvider } from "@cognipeer/agent-sdk";

const provider = createProvider({
  provider: "anthropic",
  apiKey: process.env.ANTHROPIC_API_KEY!,
  prompt_caching: { enabled: true },
});
```

This places cache breakpoints on the stable prefix `[system + tools]`. Anthropic charges roughly 10% of normal input pricing for cache hits; Bedrock applies the same model via `cachePoint` blocks.

OpenAI / Azure cache automatically once the prompt exceeds the provider's threshold — no breakpoint configuration needed.

Verify the cache is working by inspecting `response.usage.cachedInputTokens` and `cachedWriteTokens`, surfaced uniformly across providers.

## 2. Throughput: parallel tool execution

When the model issues multiple tool calls in a single turn (e.g. "read these 5 files"), serial execution wastes wall-clock time and burns the user's patience.

```ts
const agent = createSmartAgent({
  model,
  tools,
  runtimeProfile: "deep",            // already defaults to 3
  limits: { maxParallelTools: 4 },   // bump higher if your tools are I/O bound
});
```

Approval-required tools still run sequentially so the first pending approval can short-circuit the turn. Order of tool results is preserved (Bedrock / Anthropic strict-pairing safe).

## 3. Idempotent reads: opt into tool caching

If the agent re-reads the same file, fetches the same URL, or looks up the same id within a single invoke, the cache pays for itself:

```ts
const fetchFile = createTool({
  name: "fetch_file",
  description: "Read a static file by path",
  schema: z.object({ path: z.string() }),
  func: async ({ path }) => fs.promises.readFile(path, "utf8"),
  cache: { keyFn: (a) => a.path }, // dedupe by path; ignore irrelevant args
});
```

Cached hits are recorded with `fromCache: true` on `state.toolHistory` so you can audit them.

Do NOT enable `cache` for non-deterministic tools (live API state, time-sensitive lookups). The agent will not see fresh results.

## 4. Resilience: retry policies

External APIs flake. Declare retry directly on the tool:

```ts
const search = createTool({
  name: "search",
  description: "Search API",
  schema: z.object({ q: z.string() }),
  func: async ({ q }) => client.search(q),
  retry: {
    maxRetries: 3,
    backoffMs: 250,                              // doubles each attempt
    shouldRetry: (err) => !`${err}`.includes("UNAUTHORIZED"),
    circuitBreakerThreshold: 5,                  // open after N consecutive failures
  },
});
```

Provider-level retries (429 / 5xx) are already automatic — see [Native Providers](./native-providers).

## 5. Safety: budget enforcement

Always set hard ceilings on production agents. They cost roughly the same to declare as they save when things go wrong.

```ts
const agent = createSmartAgent({
  model,
  tools,
  limits: {
    maxToolCalls: 25,
    maxParallelTools: 4,
    maxContextTokens: 40_000,
    maxTotalOutputTokens: 80_000,
    maxWallClockMs: 5 * 60_000,
    maxCostUsd: 1.00,
  },
  costEstimator: ({ modelName, inputTokens, outputTokens, cachedInputTokens }) => {
    // Plug in your real pricing table here.
    if (modelName?.startsWith("claude-")) {
      return (inputTokens - (cachedInputTokens || 0)) * 3e-6
        + (cachedInputTokens || 0) * 0.3e-6
        + outputTokens * 15e-6;
    }
    return 0;
  },
});
```

A breach emits a `metadata` event with `limitBreached: string` and exits the loop cleanly. `result.content` and `result.state` still contain whatever the agent managed to produce.

## 6. Context survival: summarization

Tool-heavy agents accumulate massive payloads. Configure summarization so the model can keep thinking when context pressure builds:

```ts
const agent = createSmartAgent({
  model,
  tools,
  summarization: {
    summaryTriggerTokens: 30_000,
    summaryMode: "incremental",
  },
  toolResponses: {
    defaultPolicy: "summarize_archive",
    toolResponseRetentionByTool: {
      // Critical tool whose recent results must stay verbatim
      read_skills: "keep_full",
    },
  },
});
```

When context is compacted, the raw payload remains recoverable via `get_tool_response` — the runtime injects that tool automatically once a recovery marker appears in the transcript.

## 7. Reflection budget

If you enable `reasoning.reflection` to give the agent a post-tool think-pause, cap it so a 50-turn run does not produce 50 extra model calls:

```ts
const agent = createSmartAgent({
  model,
  tools,
  reasoning: {
    enabled: true,
    level: "medium",
    reflection: {
      cadence: "after_tool",
      maxPerRun: 5,        // hard cap
      everyNTurns: 3,      // reflect every 3 tool turns
    },
  },
});
```

## 8. Delegation: dispatch work to sub-agents safely

For multi-agent workflows, runtime delegation policy is enforced — not just documented in the prompt:

```ts
const codingAgent = createSmartAgent({ /* ... */ });
const reviewerAgent = createSmartAgent({ /* ... */ });

const parent = createSmartAgent({
  model,
  tools: [
    codingAgent.asTool({ toolName: "delegate_coding", description: "..." }),
    reviewerAgent.asTool({ toolName: "delegate_review", description: "..." }),
  ],
  customProfile: {
    extends: "research",
    delegation: {
      mode: "automatic",
      maxDelegationDepth: 2,
      maxChildCalls: 6,
      childContextPolicy: "scoped",
    },
  },
});
```

Refused delegations (depth/budget exceeded, `mode: "off"`) return a structured error to the parent model instead of silently looping.

## 9. Concurrency-safe agents

The runtime now creates per-invoke plan / todo / tool-history references, so the same `agent` instance can serve many concurrent users without state crosstalk:

```ts
// Safe in a server context
await Promise.all([
  agent.invoke({ messages: [...] }),
  agent.invoke({ messages: [...] }),
  agent.invoke({ messages: [...] }),
]);
```

## 10. Observability

Always enable tracing for long-running agents. The structured event stream and trace session are how you debug "why did this run cost $4?":

```ts
const agent = createSmartAgent({
  model,
  tools,
  tracing: { enabled: true, logData: false }, // metrics only, no payload capture
});
```

Watch for these events:

- `summarization` — how often the runtime had to compact context
- `tool_call` with `phase: "error"` — flaky tools or broken contracts
- `metadata.limitBreached` — budget tripped
- `reflection` — how much reflection cost you paid

## Recommended starting point for tool-heavy agents

```ts
const agent = createSmartAgent({
  model: fromNativeProvider(
    createProvider({
      provider: "anthropic",
      apiKey: process.env.ANTHROPIC_API_KEY!,
      prompt_caching: { enabled: true },
      retry: { maxRetries: 4 },
    }),
    { model: "claude-sonnet-4-20250514", maxTokens: 8192 },
  ),
  tools,
  runtimeProfile: "deep",
  planning: { mode: "todo", replanPolicy: "on_failure" },
  reasoning: {
    enabled: true,
    level: "medium",
    reflection: { cadence: "after_tool", maxPerRun: 5, everyNTurns: 3 },
  },
  limits: {
    maxToolCalls: 25,
    maxTotalOutputTokens: 80_000,
    maxWallClockMs: 5 * 60_000,
    maxCostUsd: 1.00,
  },
  costEstimator: myCostTable,
  tracing: { enabled: true },
});
```

This is the configuration shape that survives real production load.
