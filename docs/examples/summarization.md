# Summarization

This example shows how the smart runtime compacts long or tool-heavy history before the active context window becomes unusable.

<div class="example-meta"><a class="example-source-link" href="https://github.com/Cognipeer/agent-sdk/blob/main/examples/summarization/summarization.ts" target="_blank" rel="noreferrer">Open source: examples/summarization/summarization.ts</a></div>

## Use this when

- the agent can run long enough to accumulate noisy history
- tool outputs are large enough to threaten context budget
- you want to understand summarization before adding retrieval or recovery

## What it shows

- summarization enabled in the runtime
- tool-heavy execution that creates context pressure
- summary records written into state

## Run it

```bash
cd examples
npm run example:summarization
```

## Core code

```ts
const agent = createSmartAgent({
	model,
	tools: [echo],
	limits: { maxToolCalls: 5 },
	summarization: { enable: true, maxTokens: 500 },
});

const res = await agent.invoke({
	messages: [{ role: "user", content: "Start a very long session to trigger summarization." }],
});
```

## End-to-end flow

1. The smart runtime is configured with summarization enabled.
2. The token budget is deliberately small to force compaction in a demo-sized run.
3. The agent accumulates enough context to trigger summarization.
4. The runtime rewrites the live context into a more compact form.
5. Execution continues with the summarized context.

## Why it matters

This is the example to read when your agent is expected to keep working after many large tool calls instead of failing under context growth.

## Look for

- changes in `state.summaryRecords`
- what gets compacted versus retained live
- how the final answer remains grounded after compaction

## Production takeaway

Summarization is not a cosmetic feature. It is what keeps long-running agents operational without making every turn pay the full cost of earlier history.

## Expected output

- the run completes with a final assistant answer
- state inspection shows summary-related records once compaction occurs
- the demo triggers summarization earlier than a production configuration would

## Common failure modes

- the summarization threshold is too high for the demo input: no compaction occurs and the example looks uneventful
- you expect raw tool recovery from this example alone: that behavior is demonstrated in `summarize-context`, not here