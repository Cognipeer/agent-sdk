# Planning for Autonomous Agents

Planning in Agent SDK is designed for autonomous or semi-autonomous agents that need to own a multi-step workflow, not for every chat interaction.

## When planning should be on

Use `planning: { mode: "todo" }` when the agent is expected to:

- inspect a codebase before changing it
- delegate to sub-agents or specialist tools
- recover from failures and continue with a revised sequence
- persist visible task progress to a UI or execution log

Leave planning off when the task is basically one lookup, one transform, or one answer.

## Enable it

```ts
const agent = createSmartAgent({
  model,
  tools,
  runtimeProfile: "balanced",
  planning: { mode: "todo", replanPolicy: "on_failure" },
});
```

`useTodoList: true` still works, but `planning.mode` is the preferred API for new code.

## The planning contract

When planning is active, the smart runtime exposes `manage_todo_list`.

It supports:

- `read`
- `write`
- `update`

`write` creates the initial plan or replaces it entirely. `update` patches existing items by id and is the normal path once a plan already exists.

```ts
{
  operation: "update",
  expectedVersion: 3,
  todoList: [
    { id: 1, status: "completed", evidence: "workspace inspected" },
    { id: 2, status: "in-progress", evidence: "rewriting MCP docs" },
  ],
}
```

## What the runtime enforces

- keep at most one item `in-progress`
- keep ids unique
- keep `write` ids sequential from `1`
- prefer `update` over repeated `write`
- recover from version mismatch with `read` and a fresh `update`

This matters for autonomous agents because plans are not just narration. They become a synchronization contract between the model, the runtime, and any UI or persistence layer around it.

## Durable state vs event payloads

Use `state.plan` for the durable source of truth.

Listen to `plan` events only for transient UI updates.

```ts
await agent.invoke(state, {
  onEvent: (event) => {
    if (event.type === "plan") {
      console.log(event.operation, event.version, event.todoList);
    }
  },
});
```

For product integrations, this rule keeps your autonomous agent stable across refresh, resume, and trace replay:

> `state.plan` is authoritative. `plan` events are just signals.

## How planning behaves in practice

Planning is adaptive, not mandatory.

- simple direct answers usually skip planning
- multi-step edits, delegation, and recovery flows tend to create a plan
- explicit user requests for a plan also trigger it

That behavior is especially useful for autonomous agents because it avoids paying the planning tax on trivial work while still making longer executions explicit and inspectable.

## Good usage pattern

1. Start with a smart runtime profile such as `balanced`.
2. Turn on `planning.mode: "todo"` only for agent flows that actually require coordination.
3. Persist `result.state.plan` if your UI or service needs recovery.
4. Use traces and plan events to explain what the agent is doing while it works.
