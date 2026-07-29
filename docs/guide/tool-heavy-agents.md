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

## 3. Tool catalog size: use skills for progressive disclosure

When an agent has dozens or hundreds of possible tools, the tool catalog itself becomes part of the cost and quality problem. Put optional or domain-specific bundles behind skills so the model sees a cheap header first and binds concrete tools only when needed.

```ts
import { createSmartAgent, type Skill } from "@cognipeer/agent-sdk";

const jiraSkill: Skill = {
  key: "mcp:jira",
  title: "Jira",
  header: "search and update Jira issues when project work involves tickets",
  prompt: "Prefer read-only tools first. Use write tools only when the user asks to change Jira.",
  listToolIndex: () => jiraToolHeaders,
  bindTools: (names) => bindJiraTools(names),
  rankToolHeaders: (query, headers) => rankJiraTools(query, headers),
  defaultBindNames: ["jira_search_issues", "jira_get_issue"],
};

const agent = createSmartAgent({
  model,
  skills: [jiraSkill],
  skillPolicy: {
    maxOpenSkills: 2,
    maxBoundToolsPerSkill: 8,
    maxBoundToolsTotal: 24,
    modelTier: "large",
  },
});
```

Small skills bind all tools on `open_skill`. Large skills return a ranked tool index and require `bind_skill_tools` for the selected subset. See [Skills & Progressive Disclosure](./skills) for the full contract.

## 4. Idempotent reads: opt into tool caching

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

## 5. Resilience: retry policies

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

## 6. Safety: budget enforcement

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

## 7. Context survival: summarization

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
    retentionByTool: {
      // Critical tool whose recent results must stay verbatim
      read_skills: { output: "keep_full" },
    },
  },
});
```

When context is compacted, the raw payload remains recoverable via `get_tool_response` — the runtime injects that tool automatically once a recovery marker appears in the transcript.

### 7b. Tools whose *arguments* are the payload

Retention has **two axes**, because value density is per-tool. A search tool carries a
short query and returns the bulk; a file writer is the mirror image — it carries a
60k-char document chunk in its arguments and returns `{ok: true}`. Archiving responses
frees nothing on the second kind, so context keeps growing no matter how aggressive
`defaultPolicy` is, until the raw-policy clamp has to truncate.

Declare `retention` on the tool itself — the author knows whether the arguments are the
payload or just identity:

```ts
const appendToFile = createTool({
  name: "append_to_file",
  schema: z.object({ filePath: z.string(), mode: z.string(), content: z.string() }),
  func: appendImpl,
  retention: { input: "digest", output: "summarize_archive" },
});
```

`input: "digest"` is **field-level**, never whole-object. Only string fields over
`maxToolInputFieldChars` (default 2000) are replaced; every identifying scalar survives:

```jsonc
// before compaction
{ "filePath": "/reports/q3.md", "mode": "append", "content": "<61840 chars>" }

// after compaction
{ "filePath": "/reports/q3.md", "mode": "append",
  "content": { "__digest": { "chars": 61840, "sha256": "9f2ac1b4…",
                             "head": "# Q3 Revenue…",
                             "recover": "get_tool_response executionId=\"…\" part=\"input\"" } } }
```

That distinction is the point: the model can still state *what it did* ("appended to
`/reports/q3.md`"), it just cannot re-read the bytes — and it can page them back with
`get_tool_response({ executionId, part: "input" })`.

Guarantees worth relying on:

| Guarantee | Why |
| --- | --- |
| `input` defaults to `"keep"` | Argument digesting is always an explicit opt-in; upgrading changes nothing until you ask for it. |
| Control-plane and delegation tools are never digested | `response`, `manage_todo_list`, `ask_user_question`, `open_skill`, `bind_skill_tools`, `search_skills`, `get_tool_response`, `delegate_to`, `spawn_subagent*` — their arguments are how the loop steers itself, and they are small anyway. Config cannot override this. |
| The protected recent window is never digested | The model is still reasoning about its latest calls. |
| Turns carrying signed reasoning blocks are skipped | Anthropic/Bedrock extended thinking replays signed `thinking` blocks in the same assistant turn as their `tool_use`; that turn is left intact. |
| Rewrites stay valid JSON | Provider adapters (Bedrock's `toolUse` mapping) parse tool-call arguments. |
| `toolHistory` keeps the original | Digesting only rewrites the *model view*. |

A caller can override either axis per tool without touching the tool definition, and the
legacy single-axis `toolResponseRetentionByTool` map still works:

```ts
toolResponses: {
  retentionByTool: {
    create_text_file: { input: "digest" },   // opt a host tool in
    append_to_file:   { input: "keep" },     // ...or opt one back out
  },
  // Opt every non-protected tool in at once (rarely what you want):
  // defaultInputPolicy: "digest",
}
```

Resolution order, first match wins.

- **Output axis:** `criticalTools` → `retentionByTool[name].output` →
  `toolResponseRetentionByTool[name]` (legacy) → the tool's own `retention.output` →
  control-plane default → `defaultPolicy`.
- **Input axis:** control-plane/delegation → `criticalTools` → `retentionByTool[name].input`
  → the tool's own `retention.input` → `defaultInputPolicy`.

> **Prefer not routing bulk through arguments at all.** Digesting is damage control for an
> API shape that pushes payloads through the context. If you control the tool surface, a
> handle-based writer (`open_writer` → `append(handle, chunk)`) or writing from inside a
> sandbox keeps the payload out of the transcript entirely.

## 8. Reflection budget

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
      maxPerRun: 5,        // hard cap per invoke (run-scoped)
      everyNTurns: 3,      // reflect every 3 tool turns
    },
  },
});
```

### Cadence options

| Cadence | Fires |
| --- | --- |
| `off` | Never. |
| `every_turn` | Every loop turn. |
| `after_tool` | After any turn that ran tools. |
| `on_branch` | After a tool turn whose tool-name set differs from the previous tool turn (a genuine strategy change). |
| `initial_then_after_tool` | Once up-front as a planning note, then like `after_tool`. Default for `level: "medium"` / `"high"`. |

`level: "minimal"` selects native `effort: "minimal"` and disables reflection; `"low"` defaults to the `on_branch` cadence.

### Hooks and routing

Reflection exposes lifecycle hooks and an optional destination for the note:

```ts
reflection: {
  cadence: "after_tool",
  // Override the cadence decision entirely (throttles still apply on top).
  shouldReflect: ({ turn, ranToolsThisTurn }) => ranToolsThisTurn && turn % 2 === 0,
  // Customize the prompt body sent to the model.
  buildPrompt: ({ defaultPrompt, maxChars }) => `${defaultPrompt}\nKeep it under ${maxChars} chars.`,
  // Side-effect hook after each reflection record is produced.
  onReflection: (record) => myTimeline.push(record),
  // Route the note: "memory" (low-confidence MemoryFact), "plan" (plan.lastReflection), or "none".
  feedTo: "memory",
}
```

Near-identical consecutive reflections are suppressed automatically so the prompt does not accumulate restated insights.


## 9. Delegation: dispatch work to sub-agents safely

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

## 10. Concurrency-safe agents

The runtime now creates per-invoke plan / todo / tool-history references, so the same `agent` instance can serve many concurrent users without state crosstalk:

```ts
// Safe in a server context
await Promise.all([
  agent.invoke({ messages: [...] }),
  agent.invoke({ messages: [...] }),
  agent.invoke({ messages: [...] }),
]);
```

## 11. Observability

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
