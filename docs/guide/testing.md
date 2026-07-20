---
title: Testing & Evaluation
permalink: /testing/
---

# Testing & Evaluation

The SDK is built to be tested deterministically. Because the model is just an object with an `invoke(messages, options?)` method, you can drive an agent with a **scripted mock model** in unit tests — no API key, no network, fully reproducible — and reserve real providers for an opt-in matrix.

## Scripted mock models

A mock model is any object with `bindTools()` and `invoke()`. Branch on the conversation to script multi-turn behaviour:

```ts
function callsToolThenDone(toolName: string, args: any) {
  return {
    modelName: "mock",
    bindTools() { return this; },
    async invoke(msgs) {
      // Once a tool result exists, finish; otherwise emit the tool call.
      if (msgs.some((m) => m.role === "tool")) return { role: "assistant", content: "done" };
      return { role: "assistant", content: "", tool_calls: [
        { id: "c1", type: "function", function: { name: toolName, arguments: JSON.stringify(args) } },
      ] };
    },
  } as any;
}
```

Keep mock models **stateless** (decide from `msgs`, not a turn counter) so they behave correctly when the same model object is reused — e.g. an [ad-hoc sub-agent](/guide/sub-agents) inherits the parent model, exactly as a real (stateless) LLM would.

## What to test deterministically

- **Tool loop** — the model emits a `tool_call`, the runtime executes it, the result comes back, the model finishes.
- **Structured output** — set `outputSchema` and assert `result.output`.
- **Pause / resume** — `needsApproval` tools and `ask_user_question` pause the run; resolve with `agent.resolveToolApproval(...)` / `agent.resolveUserQuestion(...)` and re-invoke. This works across a `snapshot(...)` → JSON → `restoreSnapshot(...)` round-trip.
- **Events** — pass `onEvent` and assert the `tool_call`, `subagent`, `plan`, `summarization`, etc. events you expect.
- **Sub-agents** — `delegate_to` / `spawn_subagent` / `spawn_subagents_parallel`, including nested HITL surfaced to the parent (see [Sub-Agents](/guide/sub-agents)).
- **Cancellation** — pass a `cancellationToken`; the mock model's `invoke(msgs, opts)` receives `opts.cancellationToken` / `opts.signal`, which proves propagation (including into children).

## The eval harness

For **behavioural quality** (not just "does it run"), the SDK ships a public eval harness. You supply cases and a per-profile agent factory; it scores recall, obsolete-fact dropping, tool trajectory, recovery, and an aggregate.

```ts
import { runSmartAgentEvalHarness, createSmartAgent } from "@cognipeer/agent-sdk";
import type { EvalCase, RuntimeProfile } from "@cognipeer/agent-sdk";

const cases: EvalCase[] = [
  {
    id: "recall-1",
    family: "recall",
    prompt: "The access code is BLUE42. What is the code?",
    expectedPhrases: ["BLUE42"],
    forbiddenPhrases: ["RED99"],
  },
];

const results = await runSmartAgentEvalHarness({
  profiles: ["fast", "balanced"] as RuntimeProfile[],
  cases,
  createAgent: (profile) => createSmartAgent({ model, runtimeProfile: profile }),
});

for (const r of results) {
  console.log(r.profileLabel, r.metrics.score, r.metrics.taskSuccess);
}
```

Each `EvalCase` may declare `expectedPhrases`, `forbiddenPhrases`, `expectedFacts` (checked against memory/summary records too), and `expectedToolNames`. A case passes when recall and obsolete-drop accuracy are both ≥ 0.8. Families: `recall`, `state_continuity`, `summarization_fidelity`, `context_rollover`, `query_focused_summary`.

Drive it with a scripted model in CI to guard the harness math, and with a real model to measure actual quality across [runtime profiles](/guide/runtime-profiles).

## Real-provider matrix (opt-in)

Mock models can't prove provider-specific behaviour (Anthropic signed-thinking, Bedrock tool-result pairing, streaming deltas). The repo's `tests/integration/providerMatrix.integration.test.ts` runs the same contract — tool-calling, structured output, streaming — against any provider whose credentials are present, and **skips** the rest:

```bash
OPENAI_API_KEY=...     npm run test:matrix   # openai block runs
ANTHROPIC_API_KEY=...  npm run test:matrix   # anthropic block runs
```

| Provider | Env vars |
|---|---|
| openai | `OPENAI_API_KEY` |
| anthropic | `ANTHROPIC_API_KEY` |
| azure | `AZURE_OPENAI_API_KEY`, `AZURE_OPENAI_ENDPOINT`, `AZURE_OPENAI_DEPLOYMENT` |
| bedrock | `AWS_REGION`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY` |
| vertex | `GOOGLE_CLOUD_PROJECT` + `GOOGLE_VERTEX_ACCESS_TOKEN` |

Build a model from a native provider with `fromNativeProvider(createProvider({ provider: "openai", apiKey, defaultModel }))` — see [Native Providers](/guide/native-providers).

## Commands & coverage

```bash
npm test              # all mock-based tests (no keys)
npm run test:coverage # with v8 coverage + thresholds
npm run test:critical # critical-feature integration suite
npm run test:real     # real OpenAI (OPENAI_API_KEY)
npm run test:matrix   # real-provider matrix (per-provider keys)
```

Coverage thresholds live in `vitest.config.ts` and are kept just below the current actuals so the floor enforces real coverage without being brittle. See [`tests/README.md`](https://github.com/Cognipeer/agent-sdk/blob/main/tests/README.md) for the contributor-facing test guide.
