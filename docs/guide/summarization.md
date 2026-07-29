# Summarization And Context

Summarization in Agent SDK is built for autonomous agents that may run long enough to outgrow the model-facing context window.

## Why this exists

Autonomous agents tend to accumulate:

- large tool outputs
- repeated tool call traces
- intermediate assistant turns
- memory and planning context

Without compaction, that state becomes expensive, noisy, and eventually unusable.

## What summarization actually does

The smart runtime can compact conversation and tool history when the configured context budget is under pressure.

The important part is what it does not do:

- it does not blindly erase the past
- it does not require the application to manually rewrite messages
- it does not remove recovery options for archived tool outputs

## Key knobs

```ts
const agent = createSmartAgent({
  model,
  tools,
  summarization: {
    enable: true,
    maxTokens: 24000,
    summaryTriggerTokens: 17000,
    summaryMode: "incremental",
  },
  context: {
    policy: "hybrid",
    toolResponsePolicy: "summarize_archive",
  },
});
```

Important fields:

- `summarization.enable`
- `summarization.maxTokens` — output ceiling (and the fallback trigger when `summaryTriggerTokens` is omitted)
- `summarization.summaryTriggerTokens` — token threshold that triggers compaction; falls back to `maxTokens`, then to `limits.maxContextTokens`
- `summarization.summaryMode` — `"incremental"` (default) chains the prior summary; `"full_rewrite"` discards it
- `summarization.summaryPromptMaxTokens` — caps the summarization prompt size
- `summarization.integrityCheck` — verifies stable facts survive across passes (default `true`)
- `context.toolResponsePolicy` — retention applied when the summarizer rewrites tool messages
- `toolResponses.defaultPolicy` — same as above; takes precedence over `context.toolResponsePolicy`
- `toolResponses.retentionByTool` — two-axis per-tool override (`{ input, output }`), highest priority
- `toolResponses.toolResponseRetentionByTool` — legacy single-axis (output-only) map; still honored
- `toolResponses.defaultInputPolicy` — `keep` (default) or `digest` for tool-call **arguments**
- `toolResponses.criticalTools` — tool names that are never reduced (defaults include `response`, `manage_todo_list`, `get_tool_response`)

Argument retention is its own axis: tools whose arguments carry a bulk payload (file
writes, document chunks) opt in with `retention: { input: "digest" }` so compaction can
reclaim the payload field while keeping every identifying scalar. See
[Tool-heavy agents &sect;7b](/guide/tool-heavy-agents/) for the full contract.

## How the trigger interacts with the loop

The base agent checks the threshold on every iteration before invoking the model. When the conversation token count exceeds `summaryTriggerTokens`:

1. The base agent sets `__needsSummarization` and breaks out so the smart wrapper can run compaction.
2. The smart wrapper runs the summarizer.
3. If the summarizer cannot compress anything (e.g. every remaining tool response is `keep_full`), the runtime sets `__summarizationExhausted` and falls through to a normal model call instead of deadlocking.
4. As soon as a new compactable tool result is appended on a later turn, the runtime automatically clears `__summarizationExhausted` so future compaction can fire again.

This keeps the loop progressive even when retention policies temporarily lock out compaction.

## Recovery after compaction

When large tool outputs are summarized and archived, the runtime keeps a recovery path through `get_tool_response`.

That means an autonomous agent can continue with compact context, then fetch raw evidence again if it later needs the original output.

## State surfaces to inspect

- `state.summaryRecords`
- `state.toolHistoryArchived`

These surfaces tell you not only that summarization happened, but also which evidence remains available for later recovery.

## When autonomous agents benefit most

Summarization is especially helpful when the agent:

- performs repeated search or retrieval
- calls MCP tools that return large payloads
- uses multi-step planning over a longer session
- needs resume and recovery without replaying every raw tool result into live context

## When to disable it

You can turn summarization off for debugging or short deterministic runs:

```ts
const agent = createSmartAgent({
  model,
  tools,
  summarization: false,
});
```

That is usually appropriate only when the task is short or when you are inspecting exact raw transcripts for debugging.

## Design rule to remember

Summarization is not a cosmetic feature. It is a runtime survival mechanism for agents that need to think and act across longer horizons.