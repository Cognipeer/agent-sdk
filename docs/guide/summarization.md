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
- `summarization.groundDirectives` — keep a `user_directives` entry only when it traces back to a user message (default `true`; see below)
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

## User directives

Each summary carries `user_directives`: standing instructions the user gave
about how to work or answer ("always answer in Turkish", "never restart prod").
They are rendered first in the summary, as "User directives (still in force —
follow them)", so every later turn obeys them. That makes a wrong one costly:
it rewrites the agent's behaviour for the rest of the conversation.

A directive therefore has to trace back to something the user said:

- the default prompt asks for `{ directive, source_quote }`, the quote copied
  verbatim from a user message, in the user's language;
- the runtime keeps a directive only when its quote is found in a user message,
  or — for a directive without a quote — when most of its words (character
  pairs, for scripts written without spaces) occur in one user message;
- with a custom `promptTemplate`, which never asked for quotes, a quote-less
  directive is kept as before; only a quote it does give is checked;
- text from assistant, tool or system messages never qualifies, so an
  instruction inside a tool output or a fetched page cannot become one, and
  neither can the summarizer's own "reply in JSON" requirement;
- directives carried from an earlier summary are checked again on every pass.
  One the earlier pass had already traced (it has a recorded source) is kept
  even after its message is trimmed from state. One from a summary made before
  this check existed has no source: it must pass the check like a new one, so
  if its message is gone from state — or it translates the user's words and the
  summarizer gives no quote — it is dropped.

The quotes are stored in `summaryRecords[n].user_directive_sources`. Dropped
directives are reported on the `summarization` event (`droppedDirectives`), in
the integrity notes, and in the trace. Turn the check off with
`summarization: { groundDirectives: false }`.

Every user message reaches the summarizer, ahead of tool output: the prompt
budget is filled with user messages first (up to 60% of it; the first message
and the newest win when they do not all fit), then with the newest assistant
and tool messages. An oversized message keeps its start and its end.

## Events

`onEvent` receives `summarization` events that follow a pass from beginning to
end, so a UI can show it where it happened:

| Field | Meaning |
| --- | --- |
| `id` | The identity of the pass: its `summarize_context` tool-call id (`call_summary_<timestamp>_<suffix>`). The transcript marker carries the same one; pair a pass's events by `id`. |
| `phase` | `start` (just before the summarizer model call, empty `summary`), `done`, or `skipped` (a started pass that replaced nothing, or that failed: see `status`). Absent means `done`. |
| `pass` | Summaries so far + 1 (1-based). A `skipped` pass makes no summary, so the next pass repeats its number: use it for display, not as a key. |
| `trigger` | `pre_leg`, `mid_leg` or `post_tools`: where in the run loop the pass was asked for. |
| `status` / `error` | `ok`; `fallback` when the summarizer failed and the local fallback summary was used; `error` when the pass itself failed unexpectedly (the failure is then rethrown). `error` is the failure's message, clipped to 300 characters: provider text for operators and logs, not for end users. The trace keeps the whole message. |
| `compactedTools` | `{ toolCallId, toolName }` of the tool results this pass replaced. |

A pass that started ends with exactly one `done` or `skipped` event, a failed
summarizer included (and a pass that throws, with `skipped` and `status: error`).
Count passes by counting events whose `phase` is absent or `done`.

## Observability

Every pass is one `summarization` trace event, in the same session as the turn
it belongs to: the summarizer prompt, the model's raw reply, the summary it put
into the context, a `Compaction` section (messages compressed, tokens before
and after, messages sent to and left out of the summarizer, integrity) and a
`User directives` section (kept, with their sources, and dropped, with the
reason). The event carries the model and the token usage, so the summarizer's
cost is in the session totals. A failed call is one `error` event with the
fallback summary and no token counts.

The summarizer runs between two invokes of the base agent, when no trace
session is open; its event waits on `ctx` and is recorded at the start of the
next invoke. `postCompact` observers get the call itself (`call: { model,
usage, durationMs, messagesCompressed, fallback }`) — the `langfuseTracing`
plugin exports it as a `summarize_context` generation. With a LangChain model
the call runs as `runName: "summarize_context"`, tagged
`cognipeer:summarization`, so LangChain callbacks (LangSmith…) name it too.

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