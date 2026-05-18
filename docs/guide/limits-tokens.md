# Limits And Tokens

The SDK has several budget surfaces. Configure them together for production agents.

## Loop budgets

| Limit | What it caps |
|---|---|
| `maxToolCalls` | Total tool executions across the whole invoke |
| `maxParallelTools` | Concurrent non-approval tool executions per agent turn (profile-defined defaults: 1/2/3/4 for fast/balanced/deep/research) |
| `maxContextTokens` | Approximate ceiling for model-facing context (profile-defined) |

## Cost / latency budgets

| Limit | What it caps |
|---|---|
| `maxTotalOutputTokens` | Cumulative model output tokens across the invoke |
| `maxCostUsd` | Cumulative cost in USD — requires `costEstimator` on the agent options |
| `maxWallClockMs` | Total wall-clock time for the invoke |

Budget breaches emit a `metadata` event with `limitBreached: string` and exit the loop cleanly. Partial results stay on `result.content` and `result.state`.

```ts
const agent = createSmartAgent({
  model,
  tools,
  limits: {
    maxToolCalls: 20,
    maxParallelTools: 3,
    maxContextTokens: 30_000,
    maxTotalOutputTokens: 100_000,
    maxCostUsd: 1.00,
    maxWallClockMs: 5 * 60_000,
  },
  costEstimator: ({ modelName, inputTokens, outputTokens, cachedInputTokens }) => {
    // Plug in your own pricing table here.
    return 0;
  },
});
```

## Summarization knobs

Smart-agent summarization is controlled under `summarization`:

- `enable`
- `maxTokens` — fallback trigger when `summaryTriggerTokens` is not set
- `summaryTriggerTokens` — token threshold that fires compaction
- `summaryPromptMaxTokens` — caps the summarization prompt size
- `summaryCompressionRatioTarget`
- `summaryMode` — `"incremental"` (default) or `"full_rewrite"`
- `integrityCheck` — verifies stable facts survive across passes

## Pluggable token counter

The default counter is a character heuristic. For production accuracy, plug in a real tokenizer:

```ts
import { encoding_for_model } from "tiktoken";
const enc = encoding_for_model("gpt-4o");

const agent = createSmartAgent({
  model,
  tools,
  tokenCounter: (text) => enc.encode(text).length,
});
```

The counter is installed at the start of each `invoke(...)` and restored at the end.

## Rule of thumb

1. Set `maxContextTokens` for live conversation pressure.
2. Set `maxTotalOutputTokens` / `maxWallClockMs` / `maxCostUsd` for runaway protection.
3. Tune `summarization.summaryTriggerTokens` for compaction frequency.
4. Plug in `tokenCounter` once you ship to production.

See [Limits & Tokens](/limits-tokens/) for the full reference.
