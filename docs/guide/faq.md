# FAQ

## Should I start with `createAgent` or `createSmartAgent`?

Start with `createSmartAgent` unless you have a strong reason to own prompt construction, planning, summarization, and memory behavior yourself. `createAgent` is better for minimal loops, testing, or lower-level orchestration.

## When does summarization run?

Summarization depends on the smart runtime configuration and context pressure. The primary context budget knob is `limits.maxContextTokens`.

## How do I disable summarization?

Pass `summarization: false` to `createSmartAgent(...)`.

## Why did the agent skip planning?

Planning is adaptive. Simple direct answers or single straightforward tool lookups often skip plan creation unless the user explicitly asks for a plan.

## Are planning events the source of truth?

No. Treat `state.plan` as the canonical planning surface. `plan` events are useful for UI updates and streaming, but they are not the durable state model.

## Where is the current plan stored?

On `state.plan`. The `plan` event still exposes `todoList` for compatibility, but `state.plan` is the durable state surface.

## How do I inspect raw tool outputs after summarization?

Call `get_tool_response` with the relevant `executionId`.

## What runtime profile should I pick first?

Use `balanced` first. Move to `fast` for latency-sensitive tasks, `deep` for heavier inspection, and `research` for long-running agents with broader context and delegation needs.

## Do built-in profiles automatically enable planning?

No. Built-in profiles currently default planning to `off`. Turn on `planning.mode: "todo"` when the workflow really needs autonomous multi-step coordination.

## When should I use MCP?

Use MCP when tool capabilities live outside your process or need to be discovered from remote tool servers. MCP tools can still participate in planning, tracing, approvals, and summarization through the normal runtime.

## How do pause and resume work?

Use `onStateChange` to checkpoint, then persist a snapshot with `agent.snapshot(...)`. Later, restore it with `agent.resume(...)`. This is useful for long-running or human-in-the-loop agent flows.

## How do tool approvals work?

Mark a tool with `needsApproval: true`. The runtime pauses before execution, records the pending approval, and resumes after `resolveToolApproval(...)` returns an approved state.

## What happens when the tool-call limit is reached?

The runtime injects a finalize signal so the next assistant turn must answer directly without calling more tools.

## Why is tracing marked `partial`?

At least one sink operation failed, but the session still completed and was finalized.

## Does structured output replace the normal assistant message?

No. You still receive `result.content`. When `outputSchema` succeeds, you also get a parsed value on `result.output`.
