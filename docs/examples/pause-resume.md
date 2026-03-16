# Pause And Resume

This example demonstrates resumable agent execution across process boundaries or delayed workflows.

<div class="example-meta"><a class="example-source-link" href="https://github.com/Cognipeer/agent-sdk/blob/main/examples/pause-resume/pause-resume.ts" target="_blank" rel="noreferrer">Open source: examples/pause-resume/pause-resume.ts</a></div>

## Use this when

- a run may pause between turns
- execution has to survive a refresh, queue, or worker boundary
- you need a serializable snapshot rather than a live in-memory object

## What it shows

- state capture through `onStateChange`
- snapshot serialization with `agent.snapshot(...)`
- continuation with `agent.resume(...)`

## Run it

```bash
cd examples
npm run example:pause-resume
```

## Core code

```ts
const firstRun = await agent.invoke(initialState, {
	onStateChange: checkpointOnFirstToolRequest,
	checkpointReason: "snapshot-after-first-turn",
});

const snapshot = agent.snapshot(firstRun.state, { tag: "paused-after-first-turn" });
const serialized = JSON.stringify(snapshot, null, 2);

const restoredSnapshot = JSON.parse(serialized);
const resumed = await agent.resume(restoredSnapshot);
```

## End-to-end flow

1. The agent starts normally.
2. `onStateChange` detects the first tool request and pauses execution.
3. The paused state is captured with `snapshot(...)`.
4. The snapshot is serialized as if persisted externally.
5. A later process restores the snapshot and resumes the run.

## Why it matters

Pause and resume is essential when the agent may wait on humans, external systems, or a workflow engine between turns.

## Look for

- what parts of state are persisted
- how resume restores the interrupted flow
- how the example avoids replaying the whole session from scratch

## Production takeaway

This is the pattern to follow for durable agent workflows. If you need reliability across requests, this example is more important than any pure prompt example.

## Expected output

- the first run pauses before tool execution
- a serialized snapshot is produced
- the resumed run prints the final weather answer

## Common failure modes

- your pause callback never returns `true`, so no checkpoint is created
- you snapshot a state that was never actually paused, so the example completes in one pass instead
