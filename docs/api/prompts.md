# Prompting And Planning

Smart agents shape model behavior through a generated system prompt. That prompt is where autonomous planning and execution discipline are taught.

## `buildSystemPrompt(...)`

```ts
import { buildSystemPrompt } from "@cognipeer/agent-sdk";

const prompt = buildSystemPrompt(
  "Keep answers short and cite sources.",
  "todo",
  "ResearchHelper",
);
```

## What the prompt adds

- agent identity
- general execution rules
- planning rules when planning is enabled
- optional extra instructions from `systemPrompt`

## Planning instructions matter most for autonomous agents

When planning is enabled, the prompt teaches the model to:

- create a plan only when the task is genuinely multi-step or explicitly requested
- skip planning for direct Q&A or one-step lookups
- use `write` only for initial creation or full rewrite
- prefer `update` for status, evidence, and progress changes
- include `expectedVersion` when possible
- recover from version mismatch with `read` plus retry instead of destructive rewrite

These are the behaviors that make smart planning useful for autonomous agents rather than just decorative task narration.

## Adding extra instructions

```ts
const agent = createSmartAgent({
  model,
  tools,
  systemPrompt: "Prefer terse answers and mention tradeoffs explicitly.",
});
```

Use this for domain-specific constraints, tone, output expectations, or operational policy.

## Full prompt escape hatch

If you provide a leading `system` message in `invoke(...)`, the smart runtime will not prepend another one. That is the right escape hatch when you intentionally want full system-prompt control.
