# Pause & Resume Example

This script demonstrates how to pause an agent run, capture its state snapshot, store it as JSON, and later resume from that snapshot.

## Highlights

- Uses `onStateChange` to stop execution after the model requests a tool call.
- Serializes the checkpoint with `agent.snapshot` + `JSON.stringify`.
- Resumes the run later with `agent.resume(snapshot)`.

## Run

From the `examples/` directory:

```bash
npm run example:pause-resume
```

Or directly:
```bash
npx tsx pause-resume/pause-resume.ts
```

You can replace the fake model with a real provider by wiring `createAgent` with your preferred model implementation.
