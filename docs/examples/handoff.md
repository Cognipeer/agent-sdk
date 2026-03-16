# Handoff

This example demonstrates transfer of ownership from one agent to another, rather than a normal subroutine-style delegation.

<div class="example-meta"><a class="example-source-link" href="https://github.com/Cognipeer/agent-sdk/blob/main/examples/handoff/handoff.ts" target="_blank" rel="noreferrer">Open source: examples/handoff/handoff.ts</a></div>

## Use this when

- a downstream agent should take over the next stage of the conversation
- you want explicit handoff events in runtime telemetry
- agent identity should change, not just tool execution

## What it shows

- an agent exposed through `asHandoff(...)`
- transfer of responsibility instead of a normal tool return
- cleaner routing between specialist agents

## Run it

```bash
cd examples
npm run example:handoff
```

## Core code

```ts
const codingAgent = createAgent({
	name: "Coder",
	model,
	tools: [],
	systemPrompt: "Produce concise and clean code.",
});

const rootAgent = createAgent({
	name: "Root",
	model,
	tools: [],
	handoffs: [
		codingAgent.asHandoff({
			toolName: "delegate_code",
			description: "Delegate if code implementation is needed",
		}),
	],
});
```

## End-to-end flow

1. The root agent receives a request.
2. The runtime detects that code work should be delegated.
3. The configured handoff target is selected.
4. Ownership moves to the downstream agent.
5. Handoff events are emitted and the downstream agent completes the work.

## Why it matters

Use handoff when a downstream agent should own the next stage of work rather than act like a subroutine.

## How it differs from agent-as-tool

With `asTool(...)`, the child agent behaves like a callable helper. With `asHandoff(...)`, responsibility shifts to the downstream agent and the runtime emits explicit handoff events you can inspect.

## Production takeaway

Use handoff when role transition matters operationally, not just when you need another model call.

## Expected output

- the final content is produced after the downstream agent takes over
- collected events include one or more `handoff` entries

## Common failure modes

- the target agent is added as a tool instead of a handoff, so ownership never shifts
- provider credentials are missing because this example uses `ChatOpenAI` directly