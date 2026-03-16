# Multi-Agent

This example shows how to compose specialist agents without adopting a separate graph or workflow framework.

<div class="example-meta"><a class="example-source-link" href="https://github.com/Cognipeer/agent-sdk/blob/main/examples/multi-agent/multi-agent.ts" target="_blank" rel="noreferrer">Open source: examples/multi-agent/multi-agent.ts</a></div>

## Use this when

- one agent should delegate a sub-problem to another
- specialist behavior should stay modular
- you want orchestration that still looks like ordinary tool use

## What it shows

- child agents exposed as tools or routed collaborators
- role-based decomposition of work
- one runtime coordinating multiple specialized responsibilities

## Run it

```bash
cd examples
npm run example:multi-agent
```

## Core code

```ts
const specialist = createAgent({
	name: "Specialist",
	model: secondaryModel,
	tools: [summarize],
	limits: { maxToolCalls: 3 },
});

const specialistTool = specialist.asTool({
	toolName: "specialist_agent",
	description: "Delegate complex sub-question to specialist agent",
});

const primary = createAgent({
	name: "Primary",
	model: primaryModel,
	tools: [specialistTool],
	limits: { maxToolCalls: 4 },
});
```

## End-to-end flow

1. A specialist agent is created with its own tools and prompt.
2. That agent is exposed as a normal tool.
3. The primary agent calls the specialist tool when it needs help.
4. The specialist solves the sub-task and returns control.
5. The primary agent continues and finalizes the answer.

## When to use this pattern

Use it when a single prompt is no longer enough, but you still want orchestration that stays close to the normal agent loop.

## Look for

- where specialist agents are created
- how the parent agent delegates
- what state is preserved across the composed workflow

## Production takeaway

This pattern is often enough for specialist orchestration. Many teams do not need a heavier multi-node graph until much later.

## Expected output

- the primary agent finishes with a final content message
- delegation happens through the specialist tool path
- the example stays understandable even with fake models

## Common failure modes

- the specialist tool name does not match what the parent model tries to call
- you assume handoff semantics, but this example uses agent-as-tool delegation instead
