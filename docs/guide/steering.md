# Steering (Mid-Run Input)

A run can take more input while it works. A person writes into the session from a chat or a channel ("also add #557", "which PRs are in?"), and the agent sees the message between its steps instead of after the whole turn, the way a coding assistant takes a message you type while it is busy.

The host owns the queue. The SDK only asks for what is waiting:

```ts
const queue: PendingInput[] = [];

const result = await agent.invoke(state, {
  drainPendingInputs: () => queue.splice(0, queue.length),
  onEvent: (e) => {
    if (e.type === "user_input") markDelivered(e.inputs.map((i) => i.id));
  },
});
```

## When the loop asks

- **Before each model call**, but only when no tool call is still unanswered. A user message never lands between an assistant `tool_call` and its `tool` result, so the transcript stays valid for every provider. On a resume that starts by running approved tools, the first ask comes after those tools ran.
- **Once more after a final answer**, when a next model call can still run: the run is not cancelled, the iteration cap is not reached and no execution budget (`maxWallClockMs`, `maxTotalOutputTokens`, `maxCostUsd`) is spent. If something arrived while the model wrote the answer, the loop appends it and goes on, so the person gets an answer in the same run. `finalAnswer` is emitted once, at the end. When it does not ask, what is waiting stays with the host.

The callback is told where it is asked: `drainPendingInputs({ stage, iteration })`, `stage` being `"before_model"` or `"after_final"`, and `iteration` the 1-based iteration of the model loop (a smart-agent turn that summarizes mid-turn starts a new loop, which counts from 1 again). A host that shows every answer as a message of its own can return nothing at `"after_final"`: the run then ends with the answer it has, and the host starts a new run with what is waiting (the result's `content` is only the last answer of a run, so an answer followed by taken input is otherwise one the host has to pick out of `result.messages`).

Request guardrails check the conversation as it stands before the loop asks, so a blocked request takes no input. Then they check each item it took by itself, as the latest message of the conversation up to that item, before the next model call.

Execution budgets are checked again right before every model call, after the callback and the request guardrails returned, so a slow callback never pushes a model call past a budget.

## What the loop does with an item

Each non-empty item becomes a user message:

```ts
{
  role: "user",
  content: item.content,
  metadata: { ...item.metadata, injected: true, inputId: item.id, inputSource: item.source, inputKind: item.kind ?? "message" },
}
```

It is part of the state from then on: it is in `result.messages`, in snapshots and in what summarization sees. Messages added in a `preModelCall` plugin hook are different: they reach that one model call only.

The loop emits one `user_input` event per batch (`iteration`, `stage: "before_model" | "after_final"`, `inputs`) and records a `user_input` trace event (ids always, content only with `logData`).

Returned items are consumed. The SDK does not hand them back; keep anything you still need in your own queue until the event arrives. A throwing callback is logged and treated as "nothing pending".

If the run stops after taking an item and before answering it (it was cancelled, or a budget ran out while the callback was running), the item stays in `result.messages` as the last user message, and the run says why it stopped: a `cancelled` event, or a `metadata` event with `limitBreached` and `state.ctx.__limitBreached`. Answer it with a new run from that state.

Put the sender into `content` when the model should know who wrote it (for example `[Anil · Slack · 17:42] also add #557`). Message `name` is not set, because some providers restrict it.

## Scope

- Only the agent's own loop asks. Sub-agents (`delegate_to`, `run_parallel`) and agents used as tools (`asTool`) never receive the callback.
- Structured-output runs (`outputSchema`) do not take input after their answer: one answer per run.
- Input that arrives after the run ended is the host's to start a new run with.
