---
title: Architecture
nav_order: 4
permalink: /architecture/
---

# Architecture

The SDK is intentionally built around a small deterministic loop. The architecture is less about inventing a graph runtime and more about making runtime decisions explicit, inspectable, and easy to override.

## 1. Two layers, one execution model

There are two architectural layers:

| Layer | Responsibility |
|---|---|
| `createAgent` | Minimal agent loop: resolve, call model, execute tools, enforce limits, finalize. |
| `createSmartAgent` | Wraps the base agent with profiles, planning tools, memory sync, context policy, and summarization. |

The smart runtime does not replace the base loop. It composes around it.

## 2. High-level flow

1. Normalize input and runtime configuration.
2. Sync memory facts and seed the runtime system message when needed.
3. Decide whether pre-agent context compaction is needed.
4. Delegate a full turn to the base agent.
5. Re-sync plan, summaries, and memory.
6. If needed, compact again and continue.
7. Exit when the model returns a final answer or structured output finalizes.

## 3. Smart runtime control loop

From an operator perspective, the smart loop does five important things around the base agent:

1. Resolves a profile into concrete runtime limits and policies.
2. Injects context tools like `manage_todo_list` and `get_tool_response`.
3. Builds model-facing messages from raw conversation plus summaries and memory facts.
4. Synchronizes mutable runtime state back onto `SmartState` after every delegated base-agent turn.
5. Re-enters the loop when token pressure requires additional summarization.

## 4. Base agent loop

Inside the base loop, the flow is still intentionally small:

1. Resolve state and runtime settings.
2. Run request guardrails if configured.
3. Invoke the model.
4. Execute approved tool calls.
5. Re-enter until a final assistant answer or structured finalize condition is reached.

This is why the package is easier to debug than graph-heavy alternatives. The core path is compact enough to inspect with traces and state snapshots.

## 5. Key design points

- Runtime profiles resolve first.
- Custom profiles layer on top of a built-in base profile.
- Planning is adaptive rather than mandatory.
- Durable plan state is synchronized onto `state.plan`.
- Raw messages remain separate from model-shaped messages.
- Memory reads happen before turns; summary facts can be written back after compaction.
- Trace sessions can finish as `partial` when a sink degrades but the session still finalizes.

## 6. Core components

| Component | Responsibility |
|---|---|
| `smart/index.ts` | Orchestrates the smart wrapper around the base agent, including memory sync, summarization decisions, and plan synchronization. |
| `smart/runtimeConfig.ts` | Resolves built-in presets and merges custom overrides into a concrete runtime config. |
| `smart/contextPolicy.ts` | Shapes model-facing context from raw messages, summaries, budgets, and memory facts. |
| `contextTools.ts` | Defines `manage_todo_list`, `get_tool_response`, and the rules around plan mutation. |
| `nodes/contextSummarize.ts` | Performs compaction when token pressure demands it. |
| `agent.ts` | Implements the minimal loop with resolver, guardrails, model invocation, tools, and finalize stages. |
| `utils/tracing.ts` | Captures structured traces and finalizes sessions across file or remote sinks. |

## 7. Where branding should live in the docs system

For this documentation site, the brand hierarchy should mirror the architecture hierarchy:

- Parent brand in the nav as a compact endorsement marker.
- Product brand as the primary identifier in the page title, hero, sidebar, and API references.
- Parent brand repeated only where product context matters, such as the homepage hero or footer.

This keeps the SDK visually autonomous while still making platform ownership obvious.

## 8. What to memorize

If you need a one-line summary of the architecture, use this:

> The base agent executes turns. The smart runtime decides how that execution should be prepared, compacted, synchronized, and observed.

For the public integration surface, start with [API](/api/).
