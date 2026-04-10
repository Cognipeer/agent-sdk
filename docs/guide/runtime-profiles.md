# Runtime Profiles

Runtime profiles are the fastest way to shape how an autonomous agent behaves without tuning dozens of knobs by hand.

## Why profiles exist

Each built-in profile bundles tradeoffs across:

- tool call budget
- context budget
- summarization thresholds
- memory read/write policy
- delegation depth

That makes profiles operational presets, not just marketing labels.

## Built-in profiles

| Profile | Best for | Tool budget | Context budget | Delegation |
|---|---|---:|---:|---|
| `fast` | Short tasks, fast UI turnarounds, mostly direct answers | 4 | 12000 | off |
| `balanced` | Default product integrations and general autonomous workflows | 8 | 24000 | role-based |
| `deep` | Heavier investigation, larger context windows, more tool-heavy work | 14 | 42000 | role-based |
| `research` | Long-running research agents with broad context and stronger delegation | 20 | 56000 | automatic |

## Practical differences

| Profile | Last turns kept | Child context policy | Memory scope | Summarization trigger |
|---|---:|---|---|---:|
| `fast` | 6 | `minimal` | `session` | 9000 |
| `balanced` | 8 | `scoped` | `session` | 17000 |
| `deep` | 12 | `scoped` | `workspace` | 30000 |
| `research` | 20 | `full` | `workspace` | 42000 |

## Important default to remember

All built-in profiles currently default planning to `off`.

That is intentional. Autonomous planning is powerful, but it should be enabled because your workflow needs it, not because the profile silently turned it on.

## Recommended starting point

Start here unless you know otherwise:

```ts
const agent = createSmartAgent({
  model,
  tools,
  runtimeProfile: "balanced",
  planning: { mode: "todo" },
});
```

Use that as the baseline for autonomous product work. Move up to `deep` or `research` only when you can explain why the extra context and delegation are needed.

## Custom profiles

If a built-in profile is close but not right, extend it:

```ts
const agent = createSmartAgent({
  model,
  tools,
  runtimeProfile: "custom",
  customProfile: {
    extends: "balanced",
    limits: { maxToolCalls: 10, maxContextTokens: 18000 },
    planning: { mode: "todo" },
    context: { lastTurnsToKeep: 10 },
  },
});
```

Use custom profiles to tune behavior, not to discard the built-in operating assumptions without reason.

## How to choose well

- Choose `fast` if latency matters more than broad exploration.
- Choose `balanced` if the agent is a product feature and not a research sandbox.
- Choose `deep` if the agent must inspect more material before it acts.
- Choose `research` if the agent is explicitly allowed to branch, search, and delegate more aggressively.

## Common mistake

The common failure mode is starting with `custom` too early. You lose the benefit of tested presets and end up debugging self-inflicted configuration drift.