# Jev guardrail engine example

Demonstrates using [Jev](https://www.npmjs.com/package/@typesafe-ai/sdk) (TypeSafe AI's decision model) as the judge behind `agentVerdictRule`, instead of a guardian LLM.

The guardrail is attached the normal way, through `createAgent({ guardrails: [...] })`:

```ts
agentVerdictRule({
  engine: "jev",
  jev: { threshold: 0.5 },
})
```

## Run

From the `examples/` directory:

```bash
npm run example:jev-guardrail
```

By default it runs **offline** with a stub client, so no API key is needed — you still see the full allow/block flow, the probability, and the token usage.

## Against the real Jev API

`@typesafe-ai/sdk` is an optional peer dependency, imported dynamically only when `engine: "jev"` is used:

```bash
npm install @typesafe-ai/sdk
TYPESAFE_API_KEY=your-key npm run example:jev-guardrail
```

With the key set, the example drops the stub and lets the rule build a real `TypeSafeClient`.

## What to look at

- `allowed` — comes from `result.state?.guardrailResult.ok`
- `disposition` — `allow` / `warn` / `block`
- `probability` — the raw Jev `noul` value; the rule blocks when it is `>= threshold`
- `usage` — Jev token usage, for cost tracking parity with the LLM engine
