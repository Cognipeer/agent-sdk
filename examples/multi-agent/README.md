# Multi-agent example

Shows delegating work to a secondary agent via `agent.asTool()`.

Notes:
- Uses adapter-wrapped model (`fromLangchainModel`) when OPENAI_API_KEY present, otherwise fake model.
- Messages are plain `{ role, content }` objects.

## Run

From the `examples/` directory:

```bash
# Set your API key (optional - uses fake model if not set)
export OPENAI_API_KEY=sk-...

# Run the example
npm run example:multi-agent
```

Or directly:
```bash
OPENAI_API_KEY=... npx tsx multi-agent/multi-agent.ts
```
