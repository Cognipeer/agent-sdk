# Tool Limit Finalize

This example demonstrates the runtime's controlled stop behavior when the agent wants to keep calling tools past the configured cap.

<div class="example-meta"><a class="example-source-link" href="https://github.com/Cognipeer/agent-sdk/blob/main/examples/tool-limit/tool-limit.ts" target="_blank" rel="noreferrer">Open source: examples/tool-limit/tool-limit.ts</a></div>

## Use this when

- you want a hard stop for unbounded tool recursion
- you need predictable finalization after over-tooling
- you want to understand how the runtime forces a direct answer

## What it shows

- global tool-call limit enforcement
- finalize behavior once the cap is reached
- direct answering without another tool round

## Run it

```bash
cd examples
npm run example:tool-limit
```

## Core code

```ts
const agent = createSmartAgent({
	model: realModel || (fakeModel as any),
	tools: [echo],
	limits: { maxToolCalls: 2, maxParallelTools: 2 },
});

const res = await agent.invoke({
	messages: [{ role: "user", content: "run tools until limit then finalize" }],
});
```

## End-to-end flow

1. The fake model proposes three tool calls.
2. The runtime only allows the configured maximum.
3. Once the limit is exhausted, the runtime injects a finalize notice.
4. The next assistant turn must answer directly instead of requesting more tools.

## Why it matters

Long-running agents need a controlled stop condition. This example shows the runtime forcing a final answer instead of allowing unbounded tool loops.

## What to inspect

- the fake model tries to call three tools
- the runtime cuts off execution after the configured cap
- a finalize notice is inserted so the next assistant turn answers directly

## Production takeaway

If an agent repeatedly over-tools, this mechanism is one of the simplest ways to prevent wasted budget and degraded latency.

## Expected output

- the final console output is a direct answer rather than another tool request
- the tool loop is cut off after the configured cap

## Common failure modes

- the fake model does not attempt enough tool calls, so finalize behavior is never exercised
- you set limits too high and accidentally bypass the scenario the example is meant to show