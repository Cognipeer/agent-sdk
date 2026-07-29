---
title: Limits & Tokens
nav_order: 11
permalink: /limits-tokens/
---

# Limits And Token Management

The SDK ships several budget surfaces. Use them together; one budget alone is rarely enough for production agents.

## Limit knobs

`limits` is configured on the agent options and can be overridden per-call via `InvokeConfig.limits`.

| Limit | Default | What it caps |
|---|---|---|
| `maxToolCalls` | 50 (base) / profile-defined (smart) | Total tool executions across the whole invoke. Once reached, additional tool calls are skipped and the toolLimitFinalize message asks the model to answer directly. |
| `maxParallelTools` | profile-defined (1 for `fast`, 2 for `balanced`, 3 for `deep`, 4 for `research`) | Concurrent non-approval tool executions per agent turn. Approval-required tools always run sequentially. |
| `maxContextTokens` | profile-defined | Approximate ceiling used by the smart runtime when assembling model-facing messages. |
| `maxTotalOutputTokens` | unset (disabled) | Cumulative output tokens across the whole invoke. When exceeded, the loop emits a `metadata.limitBreached` event and exits gracefully. |
| `maxCostUsd` | unset (disabled) | Cumulative cost in USD. Requires `costEstimator` on the agent options — otherwise treated as a no-op. |
| `maxWallClockMs` | unset (disabled) | Total wall-clock time for the invoke. Equivalent to `InvokeConfig.timeoutMs` but lives on the agent definition for server-side defaults. |

```ts
const agent = createSmartAgent({
  model,
  tools,
  limits: {
    maxToolCalls: 20,
    maxParallelTools: 4,
    maxContextTokens: 30000,
    maxTotalOutputTokens: 100_000,
    maxWallClockMs: 5 * 60_000,
    maxCostUsd: 1.0,
  },
  costEstimator: ({ modelName, inputTokens, outputTokens, cachedInputTokens }) => {
    // Plug your own pricing table here — the SDK has no built-in pricing.
    if (modelName?.startsWith("gpt-4o-mini")) {
      return (inputTokens - (cachedInputTokens || 0)) * 0.15e-6
        + (cachedInputTokens || 0) * 0.075e-6
        + outputTokens * 0.60e-6;
    }
    return 0;
  },
});
```

Budget breaches surface as a `metadata` event with `limitBreached: string` and end the loop cleanly. Partial results are still returned on `result.content` and `result.state`.

## Parallel tool execution

`maxParallelTools` is honoured by the tools node when the model issues multiple tool calls in a single turn. The runtime:

- Runs tools that declare `needsApproval: true` sequentially (the first pending approval short-circuits the turn).
- Fans out the remaining tools across a bounded worker pool whose width is `min(maxParallelTools, plannedToolCount)`.
- Preserves the `tool_use → tool_result` order in the appended messages regardless of completion order, so Bedrock / Anthropic strict-pairing is not broken.

If a tool throws inside a worker, the rejection is propagated and the loop terminates with the surfaced error.

## Tool call limit finalize

When the assistant proposes tool calls but `toolCallCount >= maxToolCalls`, the tools node:

1. Emits `tool_call` events with `phase: "skipped"` for the overflow calls.
2. Appends tool response messages noting the skip.
3. Injects a system message asking the model to answer directly on the next turn.

## Summarization flow

Summarization is enabled by default for smart agents. It activates when:

```
estimatedTokens(messages) > summarization.summaryTriggerTokens
```

`summaryTriggerTokens` falls back to `maxTokens` and then to `limits.maxContextTokens` if not set.

Steps:

1. Build a bounded summarization prompt (capped by `summaryPromptMaxTokens`).
2. Optionally include the previous structured summary (hierarchical chaining).
3. Rewrite older tool messages according to the resolved retention policy:
   - `keep_full`, `keep_structured`, `summarize_archive` (default), or `drop`.
   - Critical tools and per-tool overrides set to `keep_full` are skipped.
   - Separately, tool-call **arguments** are field-level digested for tools that opted in
     with `retention: { input: "digest" }` (default `keep`, so nothing happens implicitly).
     Only oversized string fields are replaced; identifying scalars survive, and the
     original is recoverable with `get_tool_response({ executionId, part: "input" })`.
4. Append a synthetic assistant/tool pair labelled `summarize_context` containing the structured summary.
5. Persist the structured summary on `state.summaryRecords` and the latest text on `state.summaries`.

Disable summarization entirely via `summarization: false`.

If the summarizer cannot compress anything (all remaining tool responses are critical / `keep_full`), the runtime sets `__summarizationExhausted` and falls through to a normal model call. The flag is automatically cleared the next time a tool produces new output that *can* be compacted.

## Pluggable token counter

The default token estimator uses a character heuristic (~4 chars/token ASCII, ~1.5 chars/token CJK). For production accuracy you can swap in tiktoken, `@anthropic-ai/tokenizer`, or any function that returns a token count for a string.

```ts
import { encoding_for_model } from "tiktoken";
const enc = encoding_for_model("gpt-4o");

const agent = createSmartAgent({
  model,
  tools,
  tokenCounter: (text) => enc.encode(text).length,
});
```

The counter is installed at the start of each `invoke(...)` and restored at the end, so concurrent invokes do not poison each other's state.

You can also install it globally:

```ts
import { setTokenCounter, defaultTokenCounter } from "@cognipeer/agent-sdk";

setTokenCounter((text) => enc.encode(text).length);
// ... later, to restore:
setTokenCounter(undefined); // or setTokenCounter(defaultTokenCounter);
```

## Tips

- Return concise tool payloads to minimize summarization churn. Keep the raw content accessible via `get_tool_response`.
- Increase `summaryTriggerTokens` if summarization fires too frequently. Lower it if you want earlier compaction.
- Use `summarization.promptTemplate` to enforce domain-specific summary structure (project facts, ids, KPIs).
- For long user-provided context, pre-summarize before passing into the agent.
- Set `maxTotalOutputTokens` and `maxWallClockMs` even when you do not strictly need them — they prevent runaway agents in production.
- Plug in `costEstimator` and `maxCostUsd` if your agent runs against expensive frontier models.
- Monitor `summarization` and `metadata.limitBreached` events to visualize compaction frequency and budget breaches.
