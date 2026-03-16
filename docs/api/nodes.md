# Runtime Internals

This page is for debugging and implementation understanding. Most application code should start with the higher-level API pages first.

## Runtime phases

The runtime is organized around a small number of conceptual phases implemented as async functions.

| Phase | File | Responsibility |
|---|---|---|
| `resolver` | `nodes/resolver.ts` | Normalize inbound state, seed counters, attach runtime defaults. |
| `agentCore` | `nodes/agentCore.ts` | Bind tools when supported, invoke the model, append the assistant response, normalize usage. |
| `tools` | `nodes/tools.ts` | Execute tool calls, apply limits, record history, emit tool events, handle handoffs and structured finalize signals. |
| `contextSummarize` | `nodes/contextSummarize.ts` | Compact heavy history, archive large outputs, and write structured summaries. |
| `toolLimitFinalize` | `nodes/toolLimitFinalize.ts` | Inject a finalize notice when the global tool-call cap is reached. |

## How the smart runtime uses them

The smart wrapper composes around the base loop and decides when these phases should run, especially around:

- pre-turn summarization
- post-tool summarization
- memory sync
- plan synchronization
- watchdog-triggered compaction

## Why this structure matters

The design keeps the runtime easier to test and debug than graph-heavy orchestrators. Each phase returns state diffs instead of mutating arbitrary global runtime state.
