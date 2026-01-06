# Structured Output Example

This example shows how to use `outputSchema` with `createAgent` to get typed, Zod-validated results from the agent.

## What it does
- Defines a Zod schema for the expected final answer
- Instructs the model to return only JSON
- Parses and validates the final content into `res.output`

## Run

From the `examples/` directory:

```bash
# Set your API key (optional - uses fake model if not set)
export OPENAI_API_KEY=sk-...

# Run the example
npm run example:structured-output
```

Or directly:
```bash
OPENAI_API_KEY=... npx tsx structured-output/structured-output.ts
```

## Expected output

When parsing succeeds, you'll see typed fields printed:

```
Title: Structured Output
Bullets: [ 'a', 'b', 'c' ]
```

If the model doesn't return valid JSON, you'll get the raw string in `res.content`.
