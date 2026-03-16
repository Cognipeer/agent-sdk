# Planning And TODOs

This example shows the smart runtime in planning mode and is the first example to open when the agent must own multi-step work.

<div class="example-meta"><a class="example-source-link" href="https://github.com/Cognipeer/agent-sdk/blob/main/examples/todo-planning/todo.ts" target="_blank" rel="noreferrer">Open source: examples/todo-planning/todo.ts</a></div>

## Use this when

- the agent needs to coordinate more than one step
- you want visible plan state instead of implicit reasoning
- you need to understand how `manage_todo_list` fits into the runtime

## What it shows

- `planning: { mode: "todo" }`
- durable plan updates on `state.plan`
- plan events emitted during execution
- multi-step progress instead of one-shot answering

## Run it

```bash
cd examples
npm run example:todo-planning
```

## Core code

```ts
const agent = createSmartAgent({
	model,
	tools: [echo],
	useTodoList: true,
	limits: { maxToolCalls: 5 },
	tracing: { enabled: true },
});

const res = await agent.invoke({
	messages: [{ role: "user", content: "Plan and execute: echo 'hi' then confirm done." }],
});
```

## End-to-end flow

1. The smart runtime is created with planning enabled.
2. The user asks for a multi-step action.
3. The runtime exposes `manage_todo_list` to the model.
4. The model writes or updates the plan as it works.
5. The final durable plan is stored on `result.state.plan`.

## Why it matters

This is the reference example when the agent needs to own work over multiple steps. The important design point is that the plan is durable state, not just streamed narration.

## Look for

- `manage_todo_list` calls
- `write` vs `update` behavior
- how progress is reflected in `result.state.plan`

## Production takeaway

If your UI or service needs to recover, inspect, or explain agent progress, this example is more relevant than raw reasoning traces. The plan is the integration surface.

## Expected output

- the final assistant message confirms the planned work completed
- traces or event logging show plan creation and updates
- `result.state.plan` contains the durable todo structure

## Common failure modes

- you expect a plan but the task is phrased too simply: adaptive planning may decide not to create one
- you inspect streamed events only and miss `result.state.plan`, which is the authoritative state surface
