# Jev guardrail engine example

Demonstrates using Jev (TypeSafe AI's decision model, served through the SDK's `JevProvider`) as the judge behind `agentVerdictRule`, instead of a guardian LLM.

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

`JevProvider` calls `POST https://api.typesafe.ai/v1/systemone` over `fetch`; there is nothing extra to install:

```bash
TYPESAFE_API_KEY=your-key npm run example:jev-guardrail
```

With the key set, the example drops the stub and the rule builds a `JevProvider` itself. Note that the conversation payload is sent to TypeSafe AI's API.

You can also use the provider directly: `createProvider({ provider: "jev", apiKey })` then `provider.systemOne({ state, questions })`.

## What to look at

- `allowed` — comes from `result.state?.guardrailResult.ok`
- `disposition` — `allow` / `warn` / `block`
- `probability` — the raw Jev `noul` value; the rule blocks when it is `>= threshold`
- `usage` — Jev token usage, for cost tracking parity with the LLM engine
