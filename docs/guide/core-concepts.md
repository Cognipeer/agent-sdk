# Core Concepts

Agent SDK is easiest to reason about when you treat it as a stateful runtime with a compact control loop, not as a prompt template with tools attached.

## 1. The runtime is state-first

`SmartState` is the real integration surface for the smart runtime. Messages matter, but operational correctness depends on more than the visible transcript.

Important fields include:

- `messages`
- `toolHistory`
- `toolHistoryArchived`
- `summaryRecords`
- `memoryFacts`
- `plan`
- `planVersion`

The practical implication is simple: if your app only renders the last assistant message, you are ignoring most of the runtime.

## 2. Plans are durable state, not just events

The canonical plan is stored on `state.plan` and versioned through `state.planVersion`.

```ts
state.plan?.steps
state.plan?.version
state.planVersion
```

`plan` events still emit `todoList` for compatibility and streaming UIs, but application state, persistence, and resume logic should treat `state.plan` as the source of truth.

This distinction prevents a common integration bug: rebuilding UI from ephemeral event payloads and drifting away from the canonical runtime state.

## 3. Planning is adaptive, not mandatory

The runtime does not force a plan for every request.

- Direct questions can answer immediately.
- Multi-step work can create a plan.
- Once a plan exists, updates should usually use `operation: "update"` rather than full rewrites.

That means planning is a runtime decision surface, not a universal behavior. If your product treats every user turn as a project plan, you are probably over-constraining the model.

## 4. Summarization is designed for recoverability

Large tool responses can be compacted into summaries while raw outputs remain retrievable through `get_tool_response`.

The important conceptual model is:

1. Context can be shortened.
2. Raw evidence is not necessarily lost.
3. Recovery is explicit through a tool, not hidden in private runtime state.

This keeps the agent cheaper to run while preserving auditability for workflows that need the original output later.

## 5. Profiles are layered operating modes

- built-in: `fast`, `balanced`, `deep`, `research`
- custom: `runtimeProfile: "custom"` plus `customProfile.extends`

Profiles are not marketing labels. They bundle tradeoffs around limits, summarization, memory, and delegation behavior. A custom profile is useful only when you can name which part of a built-in preset is wrong for your workload.

## 6. Tool history and archived tool history are different surfaces

| Surface | What it holds | When to read it |
|---|---|---|
| `toolHistory` | Tool executions still kept in active state | You need current-turn or recent-turn tool inspection |
| `toolHistoryArchived` | Older or summarized executions preserved for retrieval | You need lossless access after context compaction |

This separation matters because not every tool result should stay live in the model-facing context.

## 7. Events are observability signals, not your data model

The runtime can emit events such as `tool_call`, `plan`, `summarization`, `metadata`, `handoff`, and `finalAnswer`.

Use them for:

- Streaming UI updates
- Logging and analytics
- Real-time activity views

Do not use them as the only persistent record of execution. Persistent state should still come from `result.state`.

## Mental model to keep

If you remember only one rule, use this one:

> Messages are what the model sees. State is what your product depends on.

That is the conceptual split that explains most of the SDK design.
