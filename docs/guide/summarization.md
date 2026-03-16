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
- `summarization.maxTokens`
- `summarization.summaryTriggerTokens`
- `summarization.summaryMode`
- `context.toolResponsePolicy`
- `toolResponses.largeResponsePolicy`

## Recovery after compaction

When large tool outputs are summarized and archived, the runtime keeps a recovery path through `get_tool_response`.

That means an autonomous agent can continue with compact context, then fetch raw evidence again if it later needs the original output.

## State surfaces to inspect

- `state.summaryRecords`
- `state.toolHistoryArchived`
- `state.watchdog`

These surfaces tell you not only that summarization happened, but also what kind of context pressure the runtime was managing.

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