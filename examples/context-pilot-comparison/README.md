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
