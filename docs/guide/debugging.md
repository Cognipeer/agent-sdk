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
		threadId: 'thread_my-workflow-1', // optional – groups sessions across agents
	},
});
```

Each `invoke` creates a new session directory under `logs/<SESSION_ID>/` and writes `trace.session.json` once the run finishes.

### Configuration

| Option | Description |
|--------|-------------|
| `enabled` | Required. Turn tracing on/off per agent. |
| `logData` | When `true`, include prompt/response/tool payloads alongside metrics. Set to `false` to store only metadata. |
| `threadId` | Optional thread identifier that groups sessions from multiple agents into a single logical workflow. Use the same `threadId` across agents that collaborate on the same task. |
| `sink` | Controls where finalized traces go. Defaults to `fileSink()` which writes `trace.session.json` under `[cwd]/logs/[session]/`. Swap in `httpSink(url, headers?)`, `cognipeerSink(apiKey, url?)`, `otlpSink(endpoint, headers?)`, or `customSink({ onEvent, onSession })` for remote delivery or custom processing. |

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
	"threadId": "thread_order-workflow-42",
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

## Operational tips

- **Retention** – traces are plain JSON. Rotate or purge `logs/` on a schedule if you generate many sessions.
- **Privacy** – disable `logData` when prompts contain sensitive information, or redact inside your own tooling before forwarding via your sink.
- **Streaming** – `mode` is currently `"batched"` for all sessions. Streaming hooks are reserved for future versions.
- **Correlation** – events include `sessionId`, `eventId`, `traceId`, and span hierarchy (`spanId`, `parentSpanId`), making it simple to join with other telemetry sources. Use `threadId` to correlate sessions across multiple agents participating in the same workflow.

## File layout

```
logs/
	sess_pK4y6xQd2Z9LcvGk/
		trace.session.json
```

Traces are safe to delete after ingestion. If you prefer remote storage, configure an `httpSink`/`cognipeerSink`/`otlpSink` and periodically clear the local directory.
