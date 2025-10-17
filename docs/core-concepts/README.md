---
title: Core Concepts
nav_order: 4
permalink: /core-concepts/
---

# Core Concepts

This page distills the mental model of `@cognipeer/agent-sdk` before you dive into the detailed guides.

> **Note:** The SDK provides two agent types: `createAgent` (minimal loop using `AgentState`) and `createSmartAgent` (batteries-included using `SmartState` which extends `AgentState`). This guide focuses on `SmartAgent` features. For basic agent usage, see the [Agent API docs](../api/agent.md).

## 1. State container
A `SmartState` object flows through the loop. Key fields:
- `messages`: Conversation list (user, assistant, tool, system)
- `toolCallCount`: Aggregate count across the invocation
- `toolHistory` / `toolHistoryArchived`: Raw + summarized tool outputs
- `summaries`: Summarization messages (compressed context)
- `plan` / `planVersion`: Planning/TODO metadata
- `usage`: Aggregated usage (provider‐normalized where possible)
- `agent`: Active runtime metadata (name, tools, limits) – swaps on handoff
- `ctx`: Scratchpad for system internals (structured output flags, event hooks)

## 2. Nodes (phases)
Each node is a pure-ish async function that receives the state and returns deltas:
- **resolver** – normalizes incoming state, seeds counters, wires runtime.
- **agentCore** – invokes the model, optionally binding tools, and appends the assistant response.
- **tools** – executes proposed tool calls (respecting global and per-turn limits).
- **contextSummarize** *(conditional)* – archives heavy tool outputs and writes summaries when token pressure is high.
- **toolLimitFinalize** – injects a system notice when the global tool-call cap is hit.

## 3. Tools

Tools are any object satisfying a minimal contract (`invoke`/`call`/`func`). Use `createTool({ name, schema, func })` for convenience; schemas are Zod and outputs are serialized directly to tool messages.

Guidelines:
- Validate inputs strictly (Zod will throw on invalid args).
- Return concise structured objects – the framework can summarize large blobs later.
- Throw informative errors for recoverable vs fatal failures.

## 4. Planning helpers

When `useTodoList: true`, the smart agent injects:
- `manage_todo_list` – CRUD the structured plan (must keep exactly one item `in-progress`).
- Planning system prompt block with strict rules (plan first, update after every action, never reveal plan text).

`plan` events fire whenever the TODO list is written, carrying the latest list and version.

## 5. Structured output finalize

Provide `outputSchema` (Zod). The framework:
- Adds a hidden `response` tool instructing the model to call it exactly once with the final JSON.
- Stores the parsed result in `state.ctx.__structuredOutputParsed` and surfaces it via `result.output`.
- Falls back to attempting to parse JSON from the final assistant message if the model skips the finalize tool.

## 6. Multi-agent composition
- `agent.asTool({ toolName })` wraps an agent so another agent can delegate to it like any other tool.
- `agent.asHandoff()` creates a handoff descriptor; when invoked, the runtime switches to the target agent until it returns a final answer.

## 7. Limits

`AgentLimits` control throughput and summarization (also exported as `SmartAgentLimits` for backward compatibility):
- `maxToolCalls` – total tool executions allowed per invocation.
- `maxParallelTools` – concurrent tool executions per agent turn.
- `maxToken` – token threshold before the next model call; exceeding it triggers `contextSummarize`.
- `contextTokenLimit` – target token budget for the live transcript.
- `summaryTokenLimit` – target size of each generated summary (per chunk).

## 8. Summarization lifecycle
1. Estimate token usage using `countApproxTokens` (~4 chars per token).
2. When over budget, chunk the transcript (keeping tool-call groups together).
3. Ask the model to summarize each chunk; iteratively merge partials.
4. Replace tool responses in `messages` with `SUMMARIZED executionId:'...'` markers.
5. Move originals to `toolHistoryArchived` so `get_tool_response` can fetch them later.
6. Emit a `summarization` event with the merged summary and archive count.

## 9. Pause & resume runs

Long-running or supervised sessions often need to pause mid-flight and resume later. The loop supports this in two ways:

- `invoke({ onStateChange })` lets you break out after any major stage. If the callback returns `true`, the loop sets `state.ctx.__paused` with metadata and returns immediately.
- `agent.snapshot(state)` *(or the exported `captureSnapshot(state)` helper)* produces a JSON-serialisable snapshot that strips internal callbacks. Persist it to disk, then call `agent.resume(snapshot)` or `agent.invoke(restoreSnapshot(snapshot))` when you want to continue.

When resuming, the agent inspects `state.ctx.__resumeStage` to skip straight to tool execution if the previous run stopped before tools executed. You rarely need to touch this flag manually; `resolveToolApproval` and `captureSnapshot` set it appropriately.

```ts
const result = await agent.invoke(state, {
	onStateChange(current) {
		const last = current.messages.at(-1);
		return !current.ctx?.__resumeStage && Array.isArray(last?.tool_calls);
	},
	checkpointReason: "waiting-for-review",
});

if (result.state?.ctx?.__paused) {
	const snapshot = agent.snapshot(result.state, { tag: "checkpoint" });
	// persist snapshot (JSON.stringify) and resume later
}

📚 For deeper patterns (checkpoint metadata, resume flow, and telemetry ideas) see [State Management](/state-management/).
```

## 10. Human approvals for tools

Any tool can opt into human-in-the-loop gating by setting `needsApproval: true` when created. The tool call is registered in `state.pendingApprovals` and execution halts until you resolve it.

- `pendingApprovals` contains entries keyed by the tool-call id (`toolCallId`) and a generated `id`.
- Use `agent.resolveToolApproval(state, { id, approved, approvedArgs?, decidedBy?, comment? })` to record the decision. Approved calls will run on the next turn; rejected calls append a rejection message back to the agent.
- The event stream emits `tool_approval` events for pending, approved, and rejected statuses.

```ts
const pending = state.pendingApprovals?.[0];
if (pending) {
	const updated = agent.resolveToolApproval(state, {
		id: pending.id,
		approved: true,
		decidedBy: "on-call",
		comment: "Safe to execute",
	});
	const resumed = await agent.invoke(updated);
}
```

Optional metadata (`approvalPrompt`, `approvalDefaults`) can be attached to tools to help drive reviewer UIs.

📚 Need an end-to-end review workflow? Visit [Tool Approvals](/tool-approvals/) for guidance on events, UI hints, and checkpoint coordination.

## 11. Events & observability

## 12. Events
`onEvent` (per-invoke via `InvokeConfig`) surfaces:
- `tool_call` lifecycle events (start/success/error/skipped).
- `plan` write/read events from `manage_todo_list`.
- `summarization` notifications when context is compacted.
- `metadata` with model name, limits, and normalized usage per turn.
- `handoff` announcements when control switches to another runtime.
- `finalAnswer` with the final assistant content.

Enable `tracing.enabled` to persist JSON trace sessions under `logs/[session]/`. Set `logData: false` for metrics-only mode or swap in a sink (`httpSink`, `cognipeerSink`, `customSink`) to ship traces to your observability API.

## 12. Usage tracking

Each assistant turn can contribute provider usage (if available). `normalizeUsage` maps the raw provider object into a consistent shape. Aggregated totals are stored in `state.usage.totals[modelName]` and emitted in `metadata` events.

---
Continue with **Architecture** for a deeper structural view or **Tools** to start authoring capabilities.
