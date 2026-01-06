# Guardrails example

This sample demonstrates how to attach conversation guardrails to an agent. It configures:

- A request guardrail that blocks any outbound message containing the words `password` or `secret`.
- A response guardrail that blocks assistant replies containing code snippets.

## Run

From the `examples/` directory:

```bash
npm run example:guardrails
```

Or directly:
```bash
npx tsx guardrails/guardrails.ts
```

The script prints the final assistant message and the guardrail incidents captured for both a blocked request and a filtered response.
