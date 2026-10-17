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
			toolName: "handoff_to_coder",
			description:
				"Transfer the conversation to the Coder agent, which will write the code and answer the user. " +
				"Call only when the user needs code written; Root stops responding after this call.",
		}),
	],
});
```

## End-to-end flow

1. The root agent receives a request.
2. The model calls the handoff tool (`handoff_to_coder({ reason })`).
3. The tool result says `Handoff complete: control transferred to Coder. Reason: <reason>. Coder now answers the user.`
4. The runtime swaps the active agent: from the next model call the target's model, tools and system prompt are in effect, and the system prompt gets a short preamble naming who handed the conversation over (not the `reason`; see below).
5. A `handoff` event (`{ from, to, toolName }`) is emitted and the downstream agent answers the user.

## What the handoff tells each side

- **The source** gets a tool description that says control transfers and it must stop. Without a `description`, `asHandoff(...)` and the `handoffs` option use the same default: "Transfer this conversation to <target> and STOP. After this call you do not answer again this turn; ...". Write your own when the routing rule is specific, and keep the "control transfers, stop" part.
- **The target** is told on the wire only (the transcript you get back is not changed; it needs a leading system message, which every smart agent and every agent with a `systemPrompt` has) that the conversation was handed to it, by whom, and to answer the user directly. The `reason` is whatever the model put in the tool's `reason` argument, so the default schema asks for the goal and the facts the next agent needs. It reaches the target as part of the handoff tool result (capped at 500 characters, on one line), never in the system prompt: it is model-written text and must not carry the weight of an instruction. A custom `schema` without a `reason` field simply drops that sentence.

## Scope: one `invoke()`

A handoff lasts for the `invoke()` it happened in. The next `invoke()` starts again at the originating agent, with its own tools and system prompt (the handoff markers `ctx.__handoffActive` / `ctx.__handoffInfo` are cleared), even when you continue with the returned messages. If the specialist should keep the conversation across turns, route to it yourself on the next call; a handoff does not persist ownership. The originating agent's skill and sub-agent catalog does not follow the conversation to the target.

## Why it matters

Use handoff when a downstream agent should own the next stage of work rather than act like a subroutine.

## How it differs from agent-as-tool

With `asTool(...)`, the child agent behaves like a callable helper. With `asHandoff(...)`, responsibility shifts to the downstream agent and the runtime emits explicit handoff events you can inspect.

## Production takeaway

Use handoff when role transition matters operationally, not just when you need another model call.

## Expected output

- the final content is produced after the downstream agent takes over
- collected events include one or more `handoff` entries

## Handoff or sub-agent?

A handoff **gives the conversation away**: the target answers the user and the source does not speak again in that invoke. A [sub-agent](/sub-agents/) (`delegate_to`) is a subroutine: it returns a result to the orchestrator, which writes the final answer. Name handoff tools `handoff_to_<agent>` so neither the model nor the reader mistakes one for a delegation, and never reuse `delegate_to` / `spawn_subagent` for them.

## Common failure modes

- the target agent is added as a tool instead of a handoff, so ownership never shifts
- the handoff tool is described like a delegation ("delegate if ...") and the source keeps talking, or the target answers "handoff done" instead of the user's request
- expecting the specialist to still own the conversation on the next `invoke()`; the handoff is scoped to one invoke
- provider credentials are missing because this example uses `ChatOpenAI` directly