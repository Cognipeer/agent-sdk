# Tracing & observability

The SDK ships with a structured tracing pipeline that records every agent invocation as JSON. Traces capture model/tool calls, timing, token usage, and (optionally) full payloads so you can drive dashboards, analytics, or remote monitoring.

## Quick start

Enable tracing when creating your agent:

```ts
const agent = createSmartAgent({
	model,
	tools,
	tracing: {
		enabled: true,
		logData: true,
	},
});
```

Each `invoke` creates a new session directory under `logs/<SESSION_ID>/` and writes `trace.session.json` once the run finishes.

### Configuration

| Option | Description |
|--------|-------------|
| `enabled` | Required. Turn tracing on/off per agent. |
| `logData` | When `true`, include prompt/response/tool payloads alongside metrics. Set to `false` to store only metadata. |
| `sink` | Controls where finalized traces go. Defaults to `fileSink()` which writes `trace.session.json` under `[cwd]/logs/[session]/`. Swap in `httpSink(url, headers?)`, `cognipeerSink(apiKey, url?)`, `otlpSink(endpoint, headers?)`, or `customSink({ onEvent, onSession })` for remote delivery or custom processing. `otlpSink` exports OpenTelemetry GenAI spans: see the [OpenTelemetry guide](/guide/opentelemetry). |

Example with an HTTP sink:

```ts
const agent = createSmartAgent({
	model,
	tools,
	tracing: {
		enabled: true,
		logData: false,
		sink: httpSink("https://observability.example.com/trace", {
			Authorization: `Bearer ${process.env.TRACE_TOKEN}`,
		}),
	},
});
```

## Session payload

`trace.session.json` summarises the entire invocation:

- **Session metadata** – `sessionId`, start/end timestamps, duration, and resolved tracing config (logData flag plus a sanitized sink summary).
- **Agent runtime** – name, version, model, and provider (when available).
- **Summary** – aggregated token counts, byte totals, and per-event classifications.
- **Events** – ordered list of model/tool/summarization events. Each record carries a stable `eventId`, a human-friendly `label`, status (`success`, `error`, `retry`, `skipped`), flattened metrics (`durationMs`, `inputTokens`, `outputTokens`, `requestBytes`, etc.), and optional tool identifiers.
- **Errors** – flattened list of noteworthy errors (either per-event or session-level) for quick surfacing.

When `logData` is `true`, payload sections expose sanitized snapshots under a `data.sections` array. Each section is one of a handful of kinds (`message`, `tool_call`, `tool_result`, `summary`, `metadata`) with concise, user-facing labels. Circular references, functions, and bigints are handled automatically. Prefer `customSink({ onEvent })` if you want a realtime feed of recorded events.

### Example structure

```json
{
	"sessionId": "sess_pK4y6xQd2Z9LcvGk",
	"startedAt": "2025-09-29T08:15:30.123Z",
	"endedAt": "2025-09-29T08:15:35.412Z",
	"durationMs": 5289,
	"agent": { "name": "SupportAgent", "version": "2025.09", "model": "gpt-4.1-mini", "provider": "openai" },
	"config": { "enabled": true, "logData": true, "sink": { "type": "file", "path": ".../logs" } },
	"summary": { "totalDurationMs": 3120, "totalInputTokens": 812, "totalOutputTokens": 431, "totalCachedInputTokens": 48, "totalBytesIn": 18240, "totalBytesOut": 9211, "eventCounts": { "ai_call": 2, "tool_call": 1 } },
	"events": [
		{
			"id": "evt_0001_abcd",
			"sessionId": "sess_pK4y6xQd2Z9LcvGk",
			"type": "ai_call",
			"label": "Assistant Response #1",
			"sequence": 1,
			"timestamp": "2025-09-29T08:15:30.987Z",
			"actor": { "scope": "agent", "name": "SupportAgent", "role": "assistant", "version": "2025.09" },
			"status": "success",
			"durationMs": 1780,
			"inputTokens": 320,
			"outputTokens": 198,
			"totalTokens": 518,
			"cachedInputTokens": 12,
			"requestBytes": 14280,
			"responseBytes": 9211,
			"model": "gpt-4.1-mini",
			"provider": "openai",
			"data": {
				"sections": [
					{
						"id": "message-evt_0001_abcd-01",
						"kind": "message",
						"label": "User Prompt",
						"role": "user",
						"content": "How do I reset my password?"
					},
					{
						"id": "message-evt_0001_abcd-02",
						"kind": "message",
						"label": "Assistant Response",
						"role": "assistant",
						"content": "Here are the steps to reset your password..."
					}
				]
			}
		}
	],
	"status": "success",
	"errors": []
}
```

### Sub-agents in traces

A sub-agent (`delegate_to`, `spawn_subagent`, `spawn_subagents_parallel`, and an `asTool` child that has no tracing of its own) records into its parent's session, so one trace holds the whole run:

```
agent_iteration  Iteration 1                  (parent)
  tool_call      Tool Execution - delegate_to
    span         Sub-agent worker              actor { scope: "agent", name: "worker", role: "subagent" }
      agent_iteration  Iteration 1             (the child numbers its own)
        ai_call        actor.name = "worker"
        tool_call      the child's own tool
```

The `span` carries a `Sub-agent` metadata section (`id`, `name`, `mode`, `parallel`, `depth`, `parentToolCallId`, `status`, and the `SubagentDef.metadata` you set); with `logData` on it also has the `Task` and `Result` messages. Tokens stay on the `ai_call` events, so session totals include the children without counting them twice. A child that pauses for approval or a question records its span as `pending` (under the parent's iteration). When the run ends, the SAME span (same `spanId`) is recorded again, finished, under the resumed `delegate_to` call, with a wall-clock `durationMs` that covers the whole run from its first segment (the wait included) and `segments` in its `Sub-agent` section. Each segment of a child's run also opens with a `running` record of the span (under the parent's iteration, no `durationMs`), so a trace stored as it streams has the group the child's steps point at while the child works. Records are append-only, so a reader draws one record per `spanId`: the highest `sequence`, dropping earlier `pending` and `running` ones (`foldSupersededSpans(events)` does it; `summary.eventCounts` still counts every record written). The child's iterations, tool calls and the approval request and decision all hang under that one span. An `asTool` child with its own `tracing` keeps its own session.

## Operational tips

- **Retention** – traces are plain JSON. Rotate or purge `logs/` on a schedule if you generate many sessions.
- **Privacy** – disable `logData` when prompts contain sensitive information, or redact inside your own tooling before forwarding via your sink.
- **Streaming** – `mode` is currently `"batched"` for all sessions. Streaming hooks are reserved for future versions.
- **Correlation** – events include `sessionId`, `eventId`, `traceId`, and span hierarchy (`spanId`, `parentSpanId`; a sub-agent that paused and resumed repeats its `spanId` on its `running`, `pending` and final records, so fold with `foldSupersededSpans` before joining on it) for cross-system telemetry joins.

## File layout

```
logs/
	sess_pK4y6xQd2Z9LcvGk/
		trace.session.json
```

Traces are safe to delete after ingestion. If you prefer remote storage, configure an `httpSink`/`cognipeerSink`/`otlpSink` (see [OpenTelemetry Export](/guide/opentelemetry)) and periodically clear the local directory.
