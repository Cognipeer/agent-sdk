
# Architecture

Smart Agent is intentionally minimal: a deterministic while-loop drives a set of pure(ish) node functions. No external graph runtime; the control flow decisions are explicit and testable.

## High-Level Flow

1. resolver – Validate & normalize initial state (messages, limits, counters).
2. (optional) contextSummarize – If token pressure predicted, summarize / archive oversized tool outputs.
3. agent – Invoke model with current system + conversation + tool schemas; capture proposed tool calls (if any).
4. tools – Execute tool calls (parallelism capped), append tool messages, update counters & history.
5. toolLimitFinalize – If tool call limit reached, inject a system finalization notice to force a direct answer on the next agent turn.
6. Exit – When agent returns an assistant message with no tool calls OR structured output finalization reached OR handoff resolution ends loop.

## Decision Logic

Decisions about summarization or finalize insertion are factored into small "decision factory" helpers (`graph/decisions.ts`). This keeps node code single‑purpose and makes it easy to unit test heuristics separately.

| Condition | Action |
|-----------|--------|
| Token budget would be exceeded next turn | Run contextSummarize before agent |
| Tool limit hit after executing tools | Inject finalize system message |
| No tool calls emitted by agent | Terminate loop |
| Structured output finalize flag set | Terminate loop with parsed result |

## Component Overview

| Component | Responsibility |
|-----------|----------------|
| smart/index.ts | Orchestrator: composes nodes, runs loop, manages summarization decisions, exposes `invoke`, `asTool`, `asHandoff`. |
| agent.ts | Minimal loop implementation used by `createAgent`; handles structured output parsing and handoff plumbing. |
| nodes/*.ts | Stateless(ish) transformation phases (resolver, agentCore, tools, contextSummarize, toolLimitFinalize). |
| tool.ts | `createTool` factory with Zod schema binding. |
| contextTools.ts | Built-in planning + retrieval tools (`manage_todo_list`, `get_tool_response`) |
| prompts.ts | System prompt construction & planning rules |
| utils/tokenManager.ts | Token budget heuristics & compaction sizing |
| utils/tracing.ts | Trace session lifecycle, event recording, sinks, and helper utilities |
| graph/decisions.ts | Summarization / finalize decision helpers |

## Message Flow (Conceptual Diagram)

```
┌──────────┐   ┌──────────────┐   ┌─────────┐   ┌─────────┐   ┌──────────────────┐
│  Input   │→→│   resolver    │→→│  agent   │→→│  tools   │→→│ summarize? / limit │
└──────────┘   └──────────────┘   └─────────┘   └─────────┘   └────────┬─────────┘
										   yes      │ no
										    │       │
										    ↓       │
									  ┌────────────┐  │
									  │contextSumm.│  │
									  └─────┬──────┘  │
										  │         │
										  └────────→(loop)
```

## Summarization Strategy

- Large tool outputs are stored in `toolHistory`. When compaction triggers, older heavy entries are summarized (rewritten) and moved to an archived list with a reversible reference (executionId).
- A companion tool `get_tool_response` allows the model to request raw unsummarized data for a specific execution id when needed, mitigating lossiness.
- Targets: `summarization.maxTokens` for when compaction should run, and `summarization.summaryPromptMaxTokens` for bounding summarization prompt size.

## Planning Mode

When `useTodoList: true`:
1. System prompt includes strict planning directives.
2. A hidden tool `manage_todo_list` is exposed so the model can CRUD plan items.
3. Plan diffs are emitted as `plan` events for observability.

## Structured Output Finalization

If `outputSchema` is provided, the system prompt instructs the model to either:
1. Produce intermediate reasoning / tool calls, or
2. Emit a final JSON object matching the schema.

When the framework detects a finalize state (e.g. no tool calls + valid JSON), it parses & validates via Zod and stores it under `ctx.__structuredOutputParsed`.

## Multi-Agent & Handoffs

- `agent.asTool()` – Wraps an agent as a tool; the primary agent can delegate a subproblem.
- `agent.asHandoff()` – Creates a tool signalling transfer of control. When invoked, the runtime switches to the target agent until it returns a final answer (or further delegation occurs).

Handoffs differ from simple delegation: the control flow "identity" (active runtime) changes, enabling distinct system prompts or tool sets mid-conversation.

## Token Heuristics

Default token counting uses a lightweight char-based approximation (≈4 chars ~ 1 token) to avoid provider-specific encoders. You can override counting externally if precision is required.

## Events & Observability

`onEvent` callback receives structured events (`tool_call`, `plan`, `summarization`, `metadata`, `finalAnswer`, `handoff`). This enables building realtime dashboards or CLI traces without parsing logs.

## Design Trade-offs

- Single loop vs state machine library: reduces cognitive overhead but pushes responsibility for edge-case termination into explicit conditions.
- Approximate tokens: faster & dependency-free, slight risk of earlier or later summarization than exact counts.
- Model-agnostic tools: relies on model supporting structured tool call emission; fallback is no tool usage.

## Future Extensions (Roadmap Ideas)

- Pluggable cost model for dynamic tool call budgeting.
- Retry middleware for flaky tool executions.
- Built-in evaluation harness for plan adherence.
- Richer structured output negotiation (multi-schema selection).

