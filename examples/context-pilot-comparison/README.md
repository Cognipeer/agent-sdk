# ContextPilot A/B comparison

Runs the exact same conversation twice against `createSmartAgent` — once with
`contextPilot: { enabled: false }` (baseline, pre-ContextPilot behavior) and
once with it enabled — using a deterministic fake model, so results are
reproducible with no API key required.

Scenario: search a 40-item catalog for "target-widget-42", repeat the exact
same search (to exercise cross-turn dedup), then recover the full original
data via `get_tool_response` in a follow-up turn (ContextPilot run only).

## Run

```bash
npm run example:context-pilot-comparison
```

## What it measures

- **Chars/tokens sent to the model** for the two `search_items` calls, with
  vs. without ContextPilot.
- **Cross-turn dedup**: whether the identical second call was replaced with a
  pointer instead of the full payload again.
- **Data safety**: whether the full original (uncompressed) 40-item catalog
  is still recoverable via `get_tool_response` after compression/dedup.

## Sample output

```
┌─────────┬───────────────────────────────────┬─────────────────────┬───────────────┬──────────────────────┬─────────────────────┐
│ (index) │ Scenario                          │ search_items calls  │ Deduped calls │ Chars sent to model  │ Approx tokens sent  │
├─────────┼───────────────────────────────────┼─────────────────────┼───────────────┼──────────────────────┼─────────────────────┤
│ 0       │ 'WITHOUT ContextPilot (baseline)' │ 2                   │ 0             │ 19972                │ 4993                │
│ 1       │ 'WITH ContextPilot'               │ 2                   │ 1             │ 3830                 │ 958                 │
└─────────┴───────────────────────────────────┴─────────────────────┴───────────────┴──────────────────────┴─────────────────────┘
Token reduction: 81% fewer chars sent to the model (19972 -> 3830 chars) across the identical 2-call scenario.
Cross-turn dedup: baseline sent the duplicate search result in full again (0 deduped), ContextPilot replaced it with a pointer (1 deduped).
Data safety: despite compressing/deduping, the full original 40-item catalog was SUCCESSFULLY recovered via get_tool_response in a follow-up turn.
```

Numbers will vary slightly with catalog size/content, but the shape of the
result (large token reduction + dedup + guaranteed recoverability) is
deterministic given the fixed fake model and fixed catalog in this example.

## Real-model variant (real API keys, real scenario)

`real-scenario-comparison.ts` runs the same kind of A/B test but against a
**real** OpenAI-compatible model, loading credentials from the repo root
`.env` (`OPENAI_API_KEY`, `OPENAI_BASE_URL`, `OPENAI_MODEL` — see
`.env.example`). Nothing about the model's behavior is scripted: it's asked
to investigate a production incident by searching a realistic ~180-line
server log (deterministic content, so both runs see the exact same raw log)
and report the root cause + timestamp.

```bash
npm run example:context-pilot-real-comparison
```

This makes real API calls (small cost + latency). Sample real run:

```
Scenario                          Log chars sent  Prompt tokens  Completion tokens  Total tokens  Latency (ms)  Found root cause
WITHOUT ContextPilot (baseline)   12039           4719           94                 4813          9104          yes
WITH ContextPilot                 6316            2785           91                 2876          5118          yes
```

- **41% fewer real prompt tokens** (4719 → 2785) for the identical prompt + tool.
- **Latency dropped** (9104ms → 5118ms) since less input has to be processed.
- **Correctness preserved**: both runs independently and correctly named the
  exact root cause (payment-gateway connection-pool exhaustion) and the exact
  timestamp — because the log compressor always keeps ERROR/WARN lines
  regardless of the length budget.

## Full real-model benchmark (all 7 Faz phases, real API keys)

`full-real-benchmark.ts` covers all 7 ContextPilot phases in one run, using 5
representative real-model scenarios (not a literal re-run of all 31 unit
tests — pure-algorithm edge cases like BM25 scoring math or CCR TTL/eviction
timing are caller-independent and don't need real-model re-verification; this
benchmark instead re-validates every *caller-visible* behavior end-to-end
against a real model):

| Scenario | Phases covered |
| --- | --- |
| 1. `search_parts` exact-match lookup, custom JSON `targetRatio` | Faz 1 (relevance scoring) + Faz 3 (compression config) |
| 2. `search_tickets`, then a fresh follow-up turn demanding the full unfiltered list | Faz 2 (CCR store) + Faz 6 (`get_tool_response` recovery) |
| 3. `get_diff` + `search_logs` + `grep_codebase` root-cause investigation | Faz 4 (format-specific diff/log/grep compressors) |
| 4. `lookup_order`, then a **fresh** follow-up turn asking the same question again | Faz 5 (cross-turn dedup + cache-alignment warning) |
| 5. `get_diff` + `grep_codebase` + excluded `raw_status` tool, `runtimeProfile: "deep"` | Faz 7 (grand integration: exclude-list + recovery + profile scaling) |

Each scenario runs twice (`contextPilot.enabled: false` vs `true`) against
the real model, with real prompt-token counts read from
`result.state.usage.totals`. Scenarios 2, 4 and 5 make a **second** real
invoke (sharing `ctx`/`toolHistory` with the first) to exercise cross-turn
recovery/dedup — that follow-up's token cost is reported in its own column so
it doesn't unfairly inflate the "on" side of the primary reduction number
(baseline only ever needs 1 invoke, since there's nothing to recover/dedup).

```bash
npm run example:context-pilot-full-benchmark
```

This makes ~50-60 real API calls (higher cost + latency than the other two
demos — expect it to take a few minutes). Sample real run:

```
Phase       Scenario                                            Prompt tok (off)  Prompt tok (on)  Reduction %  Follow-up (on only)  Latency off (ms)  Latency on (ms)
Faz 1 + 3   Relevance scoring + custom JSON targetRatio          1798              1053             41%          -                     6149              4577
Faz 2 + 6   CCR store + real get_tool_response recovery          1550              1109             28%          2891                  4794              12864
Faz 4       diff + log + grep format-specific compressors        4339              2567             41%          -                     8585              13429
Faz 5       Cross-turn dedup + cache-alignment warning           1697              1238             27%          922                   7566              10243
Faz 7       Grand integration: exclude-list + profile scaling    2240              1550             31%          3795                  6106              12328

Overall real prompt-token reduction across all 5 phases: 35% (11624 -> 7517 tokens).
All correctness checks passed: YES.
```

- **35% overall real prompt-token reduction** across all 7 Faz phases, using
  only real API calls — no scripted/fake model anywhere in this file.
- **All correctness checks passed**, including the two that are easy to get
  wrong with a real model: cross-turn dedup only has something to catch if
  the model genuinely re-calls the tool, and real models will happily answer
  from their own conversational memory instead of re-invoking a tool if the
  previous turn's transcript is replayed to them. Scenario 4 works around
  this by giving the follow-up turn a **fresh** conversation (no assistant
  memory of the previous answer, only `ctx`/`toolHistory` shared) so the
  model has no choice but to call `lookup_order` again — which is exactly
  what a real duplicate-call situation looks like in practice (e.g. two
  independent user turns that happen to need the same lookup).

