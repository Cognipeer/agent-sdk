# Rewrite After Summary

This example shows a later invocation continuing successfully after earlier turns were already compacted.

<div class="example-meta"><a class="example-source-link" href="https://github.com/Cognipeer/agent-sdk/blob/main/examples/rewrite-summary/rewrite-summary.ts" target="_blank" rel="noreferrer">Open source: examples/rewrite-summary/rewrite-summary.ts</a></div>

## Use this when

- you need multi-turn continuity after summarization
- the agent may receive follow-up tasks after context has been rewritten
- you want to test whether summary quality is good enough for later work

## What it shows

- continuation after compaction
- answer rewriting or follow-up work using summarized history
- stable execution without replaying the entire raw session into context

## Run it

```bash
cd examples
npm run example:rewrite-summary
```

## Core code

```ts
const heavyEcho = createTool({
	name: "heavy_echo",
	description: "Echo back a very long string",
	schema: z.object({ text: z.string() }),
	func: async ({ text }) => ({ echoed: text + "-" + "X".repeat(4000) }),
});

const agent = createSmartAgent({
	model: fakeModel as any,
	tools: [heavyEcho],
	limits: { maxToolCalls: 5 },
	summarization: { enable: true, maxTokens: 200 },
});
```

## End-to-end flow

1. The first run produces a long tool result that forces compaction.
2. The returned messages are preserved as the next run's starting point.
3. A new user turn is appended.
4. The agent is invoked again on the summarized history.
5. The runtime continues instead of requiring a fresh conversation.

## Why it matters

This is the example to inspect when you care about quality after summarization, not just the existence of a summary record.

## Production takeaway

For product teams, this is the difference between summarization as a dead-end cleanup step and summarization as a real continuation strategy.

## Expected output

- the second invocation finishes with a final response such as `final after summarization`
- the example proves later-turn continuity after a prior compaction event

## Common failure modes

- you forget to carry forward `res.messages` into the next run, so there is no continuity to test
- summarization never triggers because the configured token budget is too generous for the demo