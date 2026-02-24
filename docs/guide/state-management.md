
# State Management

The smart agent loop keeps every piece of runtime context inside a `SmartState` object. This guide explains how to observe those transitions, intercept checkpoints with `onStateChange`, and persist/resume runs safely.

## Why state matters

A single invocation flows through multiple stages (planning, guardrails, model call, tool execution, finalize). Each stage mutates the shared state:

- `messages` collect the conversation and tool responses.
- `toolCallCount` tracks total tool executions to enforce limits.
- `ctx` stores system metadata such as pause markers, approval flags, and tracing sessions.
- `plan`, `summaries`, and `usage` capture planning rules, summarized transcripts, and provider-normalized token data.

Understanding these fields lets you build dashboards, checkpoints, or handoffs without guessing at internal implementation details.

## Listening with `onStateChange`

Use the `onStateChange` callback inside `agent.invoke` to react to state updates after each major stage. Return `true` to checkpoint execution; the loop attaches a `ctx.__paused` entry and returns immediately.

```ts
const invokeResult = await agent.invoke(initialState, {
  onStateChange(current) {
    const last = current.messages.at(-1);
    const isFirstToolCall = Array.isArray(last?.tool_calls) && !current.ctx?.__resumeStage;
    if (isFirstToolCall) {
      console.info("Checkpoint before running tools");
      return true; // triggers ctx.__paused with metadata
    }
    return false;
  },
  checkpointReason: "awaiting-review",
});
```

When you resume, `onStateChange` will continue to fire as the loop advances. The callback receives a *copy* of the evolving state, so avoid mutating it directly; instead, inspect fields and decide whether to checkpoint.

### Hook stages

The callback executes after:

1. Guardrails (pre-model) run
2. The model produces a response
3. Tools execute (if any)
4. Finalization and post-loop cleanup

Use this to:

- Pause for human approval before tools run
- Emit custom telemetry per iteration
- Cancel runs if state violates your business constraints

## Capturing checkpoints

When `onStateChange` returns `true`, the loop populates:

```ts
state.ctx.__paused = {
  stage: "after_tools", // or before_guardrails, after_loop, etc.
  iteration: 3,
  reason: "awaiting-review",
  timestamp: "2025-10-08T12:34:56.789Z"
};
```

At that point you can serialize the state:

```ts
const snapshot = agent.snapshot(invokeResult.state, { tag: "checkpoint-1" });
await storage.put(`runs/${snapshot.id}.json`, JSON.stringify(snapshot));
```

Later, reload the snapshot and resume:

```ts
const saved = JSON.parse(await storage.get(`runs/${id}.json`));
const resumed = await agent.resume(saved);
```

`agent.resume` automatically clears `ctx.__paused` and respects `ctx.__resumeStage` so the loop skips straight to the stage that was pending when the checkpoint was captured.

> Tip: Use tags (e.g. `tag: "approval"`) to label why a checkpoint exists. Metadata is stored alongside serialized state and is easy to query.

## Coordinating with approvals and guardrails

Checkpoints integrate seamlessly with other features:

- Human-in-the-loop approvals add `ctx.__awaitingApproval`; probe this flag inside `onStateChange` to differentiate deliberate pauses.
- Guardrails may block a run or inject extra assistant messages. Use the callback to emit alerts when `state.ctx.guardrailIncidents?.length > 0`.
- Structured output finalization sets `ctx.__finalizedDueToStructuredOutput`. Checkpoints after this stage are usually unnecessary because the run is effectively done.

## Debugging tips

- Keep callback logic side-effect free; status should derive from the provided state only.
- If you need to log intermediate states, throttle the output to avoid noisy logs during tool loops.
- Combine `onEvent` (streaming telemetry) with `onStateChange` (checkpoint control) for complete observability.

## Optional alternative memory structure (single-invocation)

You can enable a working-memory toolset to make single invocation runs more robust without introducing full long-term memory coupling:

- `wm_set_fact` / `wm_get_fact`
- `wm_add_decision`
- `wm_add_open_loop`
- `wm_snapshot`

These tools persist into `state.ctx.__workingMemory` during the invocation, helping the model keep track of validated facts, decisions, and pending loops in a structured form.

```ts
const agent = createSmartAgent({
  model,
  memory: {
    enableWorkingMemoryTools: true,
    ltm: {
      enabled: true,
      adapter: myLtmAdapter, // optional
    },
  },
});
```

If you provide an LTM adapter, an optional LTM toolset is exposed (`ltm_write`, `ltm_search`, plus optional `ltm_get` / `ltm_forget`). This keeps LTM separate from the core in-call memory flow.

Continue to [Core Concepts](/core-concepts/#1-state-container) for a field-by-field reference, or jump to [Tool Approvals](/tool-approvals/) to wire checkpoints into human review flows.
