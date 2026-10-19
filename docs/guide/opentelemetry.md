# OpenTelemetry Export

The SDK exports a run's trace to any OTLP/HTTP collector (OpenTelemetry Collector, Grafana Tempo, Jaeger, Datadog, Honeycomb, Langfuse's OTLP endpoint, the Cognipeer Console). It speaks the [OpenTelemetry GenAI semantic conventions](https://github.com/open-telemetry/semantic-conventions-genai) next to the SDK's own `cognipeer.*` attributes, and it has no runtime dependency on the OpenTelemetry packages.

There are two ways to turn it on. They share one export path, so the output is identical.

```ts
import { createSmartAgent, otlpSink, otelTracing } from "@cognipeer/agent-sdk";

// 1. As the tracing sink
createSmartAgent({
  model,
  tracing: { enabled: true, sink: otlpSink("https://collector.example.com:4318/v1/traces", { authorization: "Bearer ..." }) },
});

// 2. As a plugin, next to the other plugins (tracing still has to be enabled)
createSmartAgent({
  model,
  tracing: { enabled: true },
  plugins: [otelTracing({ endpoint: "https://collector.example.com:4318/v1/traces" })],
});
```

`otelTracing` does not send anything itself: it contributes an exporter that the SDK runs when the trace session is finalized. Its `sessionEnd` observer only reports (a `metadata` event `{ otelTracing: { exported, endpoint, spans, terminal } }`, or a warning). With tracing off it says so instead of doing nothing. A sub-agent that inherits the plugin does not export; only the root session does.

## Export options

`otlpSink(options)` and `otelTracing(options)` take the same options (`otelTracing` also takes `name`).

| Option | Default | Meaning |
|---|---|---|
| `endpoint` | none | Full traces URL. Leave it out to use the `OTEL_*` environment (below). |
| `headers` | none | Auth and tenancy headers. |
| `protocol` | `http/json` (explicit endpoint), `http/protobuf` (env-driven) | `http/json` or `http/protobuf`. |
| `compression` | `none` | `gzip` compresses the body. |
| `timeoutMs` | `10000` | Per attempt. |
| `retry` | 3 attempts, 25 s budget | `false` sends once; or `{ maxAttempts, initialDelayMs, maxDelayMs, maxElapsedMs }`. |
| `semconv` | `both` | `cognipeer`, `gen_ai` or `both`. |
| `serviceName` | agent name | `service.name` of the resource. It does not rename spans. |
| `resourceAttributes` | none | Extra resource attributes. |
| `content` | off | Prompt and response content; see below. |

An export never throws and never fails the run. 429, 502, 503, 504 and transport errors are retried with full-jitter back-off (a server's `Retry-After` is honoured); other statuses are final. A response's `partial_success` is read defensively and reported. A request with no spans is not sent. A failing `otlp` sink marks the session `partial`; a failing plugin exporter is only reported.

## Environment variables

Without an explicit `endpoint` the exporter is configured the way every OpenTelemetry SDK is. With an explicit `endpoint` the environment is **not** consulted for destination-bound settings, so a collector's credentials never follow a run to another endpoint.

| Variable | Used |
|---|---|
| `OTEL_EXPORTER_OTLP_ENDPOINT` | env-driven only (`/v1/traces` is appended) |
| `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` | env-driven only, wins over the one above |
| `OTEL_EXPORTER_OTLP_HEADERS`, `..._TRACES_HEADERS` | env-driven only (explicit `headers` win) |
| `OTEL_EXPORTER_OTLP_PROTOCOL`, `..._TRACES_PROTOCOL` | env-driven only; `http/protobuf` (default) or `http/json`. `grpc` warns once and falls back to `http/protobuf` |
| `OTEL_EXPORTER_OTLP_COMPRESSION`, `..._TRACES_COMPRESSION` | env-driven only; `gzip` |
| `OTEL_EXPORTER_OTLP_TIMEOUT`, `..._TRACES_TIMEOUT` | env-driven only, milliseconds |
| `OTEL_SDK_DISABLED=true`, `OTEL_TRACES_EXPORTER=none` | env-driven only; nothing is sent |
| `OTEL_SERVICE_NAME`, `OTEL_RESOURCE_ATTRIBUTES` | both modes |

```bash
OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318 node app.js   # otlpSink() / otelTracing() with no endpoint
```

The default protocol therefore depends on the mode: **`http/protobuf` when the environment drives the exporter** (what the OpenTelemetry specification says), **`http/json` with an explicit endpoint** (the Cognipeer Console ingests JSON only). Set `protocol` to choose. The protobuf encoder is built in; `gzip` uses `node:zlib`.

## What a span looks like

With `semconv: "both"` (default) every span carries both vocabularies. `gen_ai` leaves out every `cognipeer.*` key; `cognipeer` leaves out every `gen_ai.*` key and `error.type`.

| Trace record | Span name | Kind | GenAI operation |
|---|---|---|---|
| session | `invoke_agent <agent>` | INTERNAL | `invoke_agent` |
| `ai_call`, `summarization` | `chat <model>` | CLIENT | `chat` |
| `tool_call` | `execute_tool <tool>` | INTERNAL | `execute_tool` |
| sub-agent `span` | `invoke_agent <sub-agent>` | INTERNAL | `invoke_agent` |
| iteration, plan, hook, approval, question, reflection, metadata | the SDK's label | INTERNAL | none |

A model call that never reached the provider (blocked by a plugin, cancelled before the call, short-circuited), a cache hit, a plugin short-circuit, a denied or skipped tool call are plain INTERNAL spans with no `gen_ai.operation.name`. A generation that reached the provider and was then cancelled stays a `chat` span with `finish_reasons ["error"]`. The SDK's label of every span is kept in `cognipeer.event.label`.

`chat` spans carry `gen_ai.provider.name` (only registry values: `openai`, `azure.ai.openai`, `anthropic`, `aws.bedrock`, `gcp.vertex_ai`, `gcp.gemini`, `gcp.gen_ai`, and so on; left off when unknown), `gen_ai.request.model`, `gen_ai.response.model`, `gen_ai.response.id`, `gen_ai.response.finish_reasons` (an array) and `gen_ai.usage.*`. Usage is normalized to the GenAI meaning: for Anthropic and Bedrock `input_tokens` includes cache reads and writes, for Vertex `output_tokens` includes reasoning tokens; cache and reasoning counts appear only when above zero, and `gen_ai.usage.*` is omitted when the provider reported no usage. `cognipeer.tokens.*` and the session totals are unchanged. `execute_tool` spans carry `gen_ai.tool.name`, `gen_ai.tool.type` and `gen_ai.tool.call.id` **only when the provider supplied the id** (the SDK's own `name_1` fallback ids are never exported).

### Status, timing and errors

- **Status is UNSET** for success, skipped, retried and pending work. Only a failure is `ERROR`, with `error.type` (the exception class, `_OTHER` when unknown), `status.message`, and one `exception` event on that span. The root gets exception events only for session-level errors. `cognipeer.event.status` keeps the SDK's own status (`success`, `error`, `skipped`, `pending`, `retry`).
- **Start times are true.** A record is stamped when it finishes, so a span starts at `timestamp - durationMs` and ends at `timestamp`. Iteration, sub-agent and root spans widen to cover their children. Times are exact nanoseconds.
- **Flags.** Every span has `flags` 257; a root with a remote parent 769 (the W3C sampled bit plus OTLP's has-parent / is-remote bits).

### Pauses and resumes (legs)

An approval or question pause ends one invoke and the resume is another. The exporter sends each leg's finished spans when the leg ends, and the **root span exactly once, with the leg that ends the run**, covering the whole run (the wait included). A sub-agent that pauses and resumes is one `invoke_agent` span with one id: while it is pending it is held back, and it is exported once from its final record, so every exported span's parent is an exported span. A run that is abandoned while paused is closed by `closeTraceContinuation(continuation, { tracing, exporters })`, which exports the held root through the OTLP exporters only (the SDK's smart driver calls it itself when it drops a dangling continuation or fails).

## Parent context (W3C Trace Context)

To make the run part of an existing distributed trace, pass the caller's header:

```ts
await agent.invoke(input, { traceParent: req.headers["traceparent"] });
// or { traceparent, tracestate }, or tracing: { parent: "00-<trace-id>-<span-id>-01" } for every run
```

The root span joins that trace as a child of that span. The incoming trace flags are carried unchanged; `sampled=0` suppresses the OTLP export only (file, Cognipeer, HTTP and custom sinks still record). The parent survives a pause/resume. Tools see `ToolCallContext.traceId`, and `parseTraceparent`, `formatTraceparent` and `traceparentOf(ctx)` are exported to forward the context to downstream calls. Invalid values are ignored with one warning.

## Prompt and response content

Content is **off by default** and independent of `tracing.logData`. Turn it on per exporter:

```ts
otlpSink({
  endpoint,
  content: {
    enabled: true,
    include: ["input", "output", "toolArgs", "toolResults"], // also "system", "tools"
    redact: (value, { field, toolName }) => (field === "toolArgs" ? null : maskPii(value)),
    maxStringChars: 4096, maxMessages: 32, maxAttributeBytes: 32768,
    encoding: "json", // or "structured"
  },
});
```

It fills `gen_ai.system_instructions`, `gen_ai.input.messages`, `gen_ai.output.messages`, `gen_ai.tool.definitions`, `gen_ai.tool.call.arguments` and `gen_ai.tool.call.result` (JSON string by default). The `redact` hook runs first, the caps second. Caps drop whole messages (oldest first) or substitute `{"truncated":true}`; JSON is never cut in the middle. A hook that throws leaves the field out. Content is built when the event is recorded, only when an exporter asked for it, and lives in a side channel that other sinks and persisted state never see.

## The Cognipeer Console

The Console reads OTLP/JSON only, so an explicit endpoint defaults to `http/json`. Keep the default `semconv: "both"` for it: the `cognipeer.*` attributes (`cognipeer.event.sequence`, `cognipeer.event.status`, the event type) carry what it needs to rebuild the session.

## Not covered

Metrics, the logs/events signal, OTLP/gRPC, span links, `server.address` and request parameters (`gen_ai.request.temperature` and friends), MCP `_meta` context injection, and the Agent Skills refinement of the conventions. The GenAI conventions are in development: this release follows the commit recorded as `GENAI_SEMCONV_COMMIT` (`547934a`), and no `schemaUrl` is set because that version is unpublished.
