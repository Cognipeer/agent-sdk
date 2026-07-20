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

## True branch-vs-branch variant (real pre-ContextPilot commit vs real feature/context-pilot commit)

Every demo above compares the **same checked-out code** with
`contextPilot.enabled` toggled on/off — a valid way to isolate the feature's
effect, since `enabled: false` short-circuits every ContextPilot code path at
the very top of `compressToolOutput()`. But it isn't literally running the
code as it existed *before* this feature branch was written.

`branch-real-comparison.ts` closes that gap: it dynamically imports **two
separately built SDK versions** —

- the real pre-ContextPilot code, built from the actual git commit where
  `feature/context-pilot` diverged from `main` (found via
  `git merge-base feature/context-pilot main`) — no `contextPilot` option
  exists in that build at all, no CCR store, no dedup tracker, no
  format-specific compressors;
- the current `feature/context-pilot` branch, with `contextPilot: { enabled: true }`.

Both runs use the exact same real model, same tool data, same prompts — the
only variable is which actual commit's compiled SDK is executing.

**One-time setup** (creates a sibling git worktree + builds it):

```bash
cd agent-sdk
git worktree add --detach ../agent-sdk-baseline "$(git merge-base feature/context-pilot main)"
cd ../agent-sdk-baseline && npm install && npm run build
```

**Run:**

```bash
npm run example:context-pilot-branch-comparison
```

Sample real run:

```
Phase       Scenario                                   Prompt tok (BEFORE)  Prompt tok (AFTER)  Reduction %  Follow-up (BEFORE)  Follow-up (AFTER)  Latency BEFORE (ms)  Latency AFTER (ms)
Faz 1 + 3   Catalog lookup (50 items)                  1798                  1053                41%          -                    -                   4662                  4154
Faz 2 + 6   Search + full-list follow-up (45 items)     1550                  1109                28%          1304                 2867                11944                 11445
Faz 4       diff + log + grep investigation             4339                  2567                41%          -                    -                   8038                  9505
Faz 5       Repeat lookup_order across 2 invokes        1605                  1146                29%          1605                 833                 8569                  8703
Faz 7       diff + grep + excluded raw_status           2240                  1550                31%          -                    3813                6493                  16965

Overall real prompt-token reduction, real pre-ContextPilot commit vs real feature/context-pilot commit: 36% (11532 -> 7425 tokens).
All correctness checks passed: YES.
```

This **36%** reduction (real BEFORE-commit vs real AFTER-commit) closely
matches the **35%** reduction from the config-toggle version above — the two
independent measurement methods agree, which cross-validates the result: the
token savings are a real effect of the ContextPilot feature itself, not an
artifact of how the comparison was constructed.

## Heavy / research-style scenarios (multi-tool investigation + long session)

Uses the same dual-SDK-import (real BEFORE commit vs real AFTER branch)
methodology as `branch-real-comparison.ts`, but with two intentionally
heavier, more realistic scenarios:

- **Scenario 6 — incident investigation (7 tools, single conversation):**
  the model is asked to investigate an intermittent payments outage using
  every available tool (`search_logs`, `search_metrics`, `get_pool_diff`,
  `get_config_diff`, `grep_codebase`, `search_docs`, `search_tickets`) and
  write a full incident report. Data is deliberately noisy/large: 250 lines
  of logs, 60 metric samples (1 anomalous spike), a real diff + an unrelated
  red-herring diff, a 45-line grep result, a ~90-line runbook (with the fix
  buried in it), and 40 support tickets (1 relevant). A follow-up turn then
  asks for the *exact* total metric-sample count to test compression/dedup
  recovery under an aggregate/count-style query.
- **Scenario 7 — long 4-turn session:** 4 sequential turns (KB search,
  account lookup, billing history, then a repeat KB search + full-session
  summary), replaying the growing conversation each turn, measuring
  **cumulative** prompt tokens per turn to show the compounding effect of
  ContextPilot across a long session.

**Run:**

```bash
npm run example:context-pilot-heavy-comparison
```

Sample real run (Scenario 6):

```
Prompt tok (BEFORE) 22084 -> (AFTER) 11558   (48% reduction)
Follow-up turn       (BEFORE) 3107 -> (AFTER) 1172
Recovery turn        (BEFORE) 2604 -> (AFTER) 3856
All correctness checks passed: YES.
```

Sample real run (Scenario 7, per turn):

```
Turn 1: 2532 -> 1773 (30%)
Turn 2: 2314 -> 1704 (26%)
Turn 3: 4977 -> 3759 (24%)
Turn 4: 6890 -> 8019 (-16%, AFTER worse this run)
Cumulative: 16713 -> 15255 (9% reduction this run)
```

**Two honest, non-obvious findings from this round of testing** (not bugs —
both were verified via isolated repro scripts and root-caused before being
accepted as real, expected behavior):

1. **`get_tool_response` is only available once a recovery marker (e.g.
   `DUPLICATE_TOOL_RESPONSE`, `ARCHIVED_TOOL_RESPONSE`) is already present in
   the *input* messages at invoke start** (`hasToolResponseRecoveryReference`
   in `contextTools.ts`, gated in `smart/index.ts`'s `syncRuntimeTools`). If a
   duplicate is discovered *during* the same turn (e.g. the model repeats a
   tool call and immediately gets a dedup pointer back), the recovery tool is
   correctly **not yet injected for that turn** — the model can only recover
   the data on a **subsequent** turn, once the marker is visible in history.
   Scenario 6 verified this directly: turn 2 (same-turn) correctly reports
   the recovery tool as unavailable; turn 3 (marker now in history) 
   successfully recovers the exact count (60).
2. **Scenario 7's turn-4 compounding result is not perfectly stable run to
   run.** Most runs show healthy reductions across all 4 turns (one run:
   30/27/25/35%, cumulative 30%; another: 30/65/32/40%, cumulative 43%), but
   at least one run showed turn 4 costing *more* tokens for AFTER than
   BEFORE (-16%), driven by real, non-deterministic model behavior (whether
   the model chooses to re-issue the `search_kb` call in the final turn) —
   when it does, that extra tool round-trip plus the now-injected
   `get_tool_response` tool schema add real prompt-token overhead on top of
   an already-large turn-4 history. This is flagged here rather than
   glossed over: ContextPilot's savings are consistently strong in
   aggregate/early turns, but the *final* turn of a long compounding session
   can occasionally see reduced or negative savings depending on real model
   behavior, and this is worth keeping in mind rather than treating the
   reduction percentage as a hard guarantee on every single turn.


