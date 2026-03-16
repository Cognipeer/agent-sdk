# Guardrails

This example demonstrates policy enforcement before and after model execution.

<div class="example-meta"><a class="example-source-link" href="https://github.com/Cognipeer/agent-sdk/blob/main/examples/guardrails/guardrails.ts" target="_blank" rel="noreferrer">Open source: examples/guardrails/guardrails.ts</a></div>

## Use this when

- input must be blocked before it reaches the model
- output must be filtered before it reaches the user
- you want policy violations recorded in runtime state

## What it shows

- regex-based and code-based guardrail checks
- phase-aware interception before or after generation
- policy enforcement without rewriting core agent logic

## Run it

```bash
cd examples
npm run example:guardrails
```

## Core code

```ts
const passwordGuardrail = createRegexGuardrail(/password|secret/i, {
	guardrailId: "password-filter",
	guardrailTitle: "Sensitive Secret Filter",
	phases: [GuardrailPhase.Request],
	rule: { failureMessage: "Outbound request blocked: sensitive secret detected." },
});

const codeGuardrail = createCodeGuardrail({
	guardrailId: "code-ban",
	guardrailTitle: "No Code Responses",
	phases: [GuardrailPhase.Response],
	rule: { disposition: "block" },
});

const agent = createAgent({
	model: fakeModel,
	guardrails: [passwordGuardrail, codeGuardrail],
});
```

## End-to-end flow

1. A request guardrail scans user input for disallowed patterns.
2. A response guardrail checks model output after generation.
3. The runtime blocks or rewrites behavior according to the configured disposition.
4. Incidents are stored in state for inspection.

## Why it matters

Guardrails are useful when product policy must remain explicit and testable rather than hidden inside prompt wording.

## What to inspect

- request blocking before model execution
- response filtering after model generation
- incidents recorded on `state.guardrailResult`

## Production takeaway

Guardrails are strongest when they are explicit runtime policy. This example shows that enforcement path without mixing it into prompt wording.

## Expected output

- the first invocation prints a blocked request result
- the second invocation prints a filtered or blocked response result
- guardrail incidents are visible in state

## Common failure modes

- the regex or code rule is too weak, so the test input does not trigger the guardrail
- you inspect only final content and miss the richer guardrail incident data in state
