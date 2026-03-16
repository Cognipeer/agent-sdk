# Structured Output

This example shows how to require schema-shaped final output without giving up the normal assistant response flow.

<div class="example-meta"><a class="example-source-link" href="https://github.com/Cognipeer/agent-sdk/blob/main/examples/structured-output/structured-output.ts" target="_blank" rel="noreferrer">Open source: examples/structured-output/structured-output.ts</a></div>

## Use this when

- downstream code needs a typed object
- post-processing free-form text is too brittle
- you want strong validation at the final response boundary

## What it shows

- `outputSchema` on the agent
- the injected finalize `response` tool
- parsed output on `result.output`

## Run it

```bash
cd examples
npm run example:structured-output
```

## Core code

```ts
const ResultSchema = z.object({
	title: z.string(),
	bullets: z.array(z.string()).min(1),
});

const agent = createAgent({
	model,
	outputSchema: ResultSchema,
});

const res = await agent.invoke({
	messages: [{ role: "user", content: "Generate 3 bullet points with a title about AI" }],
});
```

## End-to-end flow

1. A Zod schema defines the final shape.
2. The agent runs with `outputSchema` enabled.
3. The model produces a final response.
4. The runtime parses it against the schema.
5. Typed output becomes available on `res.output`.

## Why it matters

Structured output is the cleanest path when downstream code needs a predictable object instead of post-processing free-form text.

## What to inspect

- the Zod schema definition
- `res.output` when parsing succeeds
- fallback to `res.content` when parsing does not succeed

## Production takeaway

If another service consumes the result, this pattern is usually better than asking the model for JSON and hoping it behaves.

## Expected output

- when parsing succeeds, the console prints `Title:` and `Bullets:` from `res.output`
- when parsing fails, the script falls back to raw assistant content

## Common failure modes

- the model returns shape-invalid JSON, so `res.output` is empty and only `res.content` is available
- your schema changes but the prompt still asks for the old shape
