import fs from "node:fs";
import path from "node:path";
import { Buffer } from "node:buffer";
import { nanoid } from "nanoid";
import crypto from "node:crypto";
import type {
  AgentRuntimeConfig,
  ResolvedTraceConfig,
  ResolvedTraceSink,
  SmartAgentOptions,
  SmartAgentTracingConfig,
  TraceDataSection,
  TraceEventRecord,
  TraceSessionConfigSnapshot,
  TraceSessionFile,
  TraceSessionRuntime,
  TraceSessionStatus,
  TraceSessionSummary,
  TraceSinkConfig,
  TraceSinkSnapshot,
  TraceResponseFormatSection,
  TraceToolCallSection,
  TraceToolDefinition,
  TraceToolDefinitionsSection,
  TracingMode,
} from "../types.js";

const DEFAULT_COGNIPEER_URL = "https://console.cognipeer.com/api/client/v1/tracing/sessions";

export function fileSink(path?: string): TraceSinkConfig {
  return { type: "file", path };
}

type CustomSinkArg =
  | ((event: TraceEventRecord) => void | Promise<void>)
  | {
    onEvent?: (event: TraceEventRecord) => void | Promise<void>;
    onSession?: (session: TraceSessionFile) => void | Promise<void>;
  };

export function customSink(handler: CustomSinkArg): TraceSinkConfig {
  if (typeof handler === "function") {
    return { type: "custom", onEvent: handler };
  }
  return {
    type: "custom",
    onEvent: typeof handler?.onEvent === "function" ? handler.onEvent : undefined,
    onSession: typeof handler?.onSession === "function" ? handler.onSession : undefined,
  };
}

export function cognipeerSink(apiKey: string): TraceSinkConfig;
export function cognipeerSink(url: string | undefined, apiKey: string): TraceSinkConfig;
export function cognipeerSink(first: string | undefined, second?: string): TraceSinkConfig {
  if (second === undefined) {
    const apiKey = first ?? "";
    return { type: "cognipeer", apiKey };
  }
  const url = typeof first === "string" && first.trim().length > 0 ? first.trim() : undefined;
  return { type: "cognipeer", url, apiKey: second };
}

export function httpSink(url: string, headers?: Record<string, string>): TraceSinkConfig {
  return { type: "http", url, headers };
}

/**
 * Create an OTLP/HTTP JSON sink that exports traces in OpenTelemetry format.
 * @param endpoint OTLP endpoint URL (e.g. "https://console.cognipeer.com/api/client/v1/traces")
 * @param headers Optional headers (e.g. { Authorization: "Bearer ..." })
 */
export function otlpSink(endpoint: string, headers?: Record<string, string>): TraceSinkConfig {
  return { type: "otlp", endpoint, headers };
}
function resolveLogsBaseDir(customPath?: string, ensureDirectory = true) {
  const root = process.cwd();
  const base = customPath && customPath.trim().length > 0 ? customPath : path.join(root, "logs");
  if (ensureDirectory) {
    ensureDir(base);
  }
  return base;
}

function coerceToString(value: unknown): string | undefined {
  if (value == null) return undefined;
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  if (typeof value === "function" && value.length === 0) {
    try {
      return coerceToString((value as () => unknown)());
    } catch {
      return undefined;
    }
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      const normalized = coerceToString(item);
      if (normalized) return normalized;
    }
    return undefined;
  }
  return undefined;
}

// Metadata extraction paths - defined once for DRY principle
const METADATA_PATHS = {
  model: [
    "model", "options.model", "params.model", "config.model", 
    "configuration.model", "metadata.model", "lc_kwargs.model",
    "metadata.modelName", "modelName", "lc_alias", "model_id", "id",
    "_model", "_modelName", "__model", "_modelId", "_llmType"
  ],
  provider: [
    "provider", "options.provider", "params.provider", "config.provider",
    "configuration.provider", "metadata.provider", "lc_kwargs.provider"
  ],
};

/** Safely extract nested object value using dot notation path */
function getNestedValue(obj: any, path: string): any {
  if (!obj || typeof path !== "string") return undefined;
  return path.split(".").reduce((current, key) => current?.[key], obj);
}

/** Unified metadata extraction - eliminates code duplication between model/provider extraction */
function extractMetadata(model: any, paths: string[]): string | undefined {
  if (!model) return undefined;
  
  // Direct extraction from model
  for (const path of paths) {
    const value = getNestedValue(model, path);
    const str = coerceToString(value);
    if (str) return str;
  }
  
  // Try LangChain wrapper (_lc property)
  const maybeLc = model?._lc;
  if (maybeLc) {
    for (const path of paths) {
      const value = getNestedValue(maybeLc, path);
      const str = coerceToString(value);
      if (str) return str;
    }
  }
  
  // Try client/api/service properties
  const maybeClient = model?.client || model?.api || model?.service;
  if (maybeClient) {
    for (const path of paths) {
      const value = getNestedValue(maybeClient, path);
      const str = coerceToString(value);
      if (str) return str;
    }
  }
  
  // Constructor name as last resort (filter out generic types)
  const constructorName = model?.constructor?.name;
  if (constructorName && !["Object", "Function"].includes(constructorName)) {
    return constructorName;
  }
  
  return undefined;
}

export function getModelName(model: any): string | undefined {
  return extractMetadata(model, METADATA_PATHS.model);
}

export function getProviderName(model: any): string | undefined {
  return extractMetadata(model, METADATA_PATHS.provider);
}

function inferModelFromMessages(messageList?: any[]): string | undefined {
  if (!Array.isArray(messageList)) return undefined;
  
  // Message-specific metadata paths for inference from history
  const messagePaths = [
    "metadata.model", "metadata.modelName", "response_metadata.model",
    "response_metadata.modelName", "usage_metadata.model", "model", "modelName"
  ];
  
  // Search backwards (most recent message has best info)
  for (let i = messageList.length - 1; i >= 0; i--) {
    const message = messageList[i];
    if (!message) continue;
    
    for (const path of messagePaths) {
      const value = getNestedValue(message, path);
      const str = coerceToString(value);
      if (str) return str;
    }
  }
  
  return undefined;
}

function inferProviderFromMessages(messageList?: any[]): string | undefined {
  if (!Array.isArray(messageList)) return undefined;
  
  // Message-specific paths for provider inference
  const messagePaths = [
    "metadata.provider", "response_metadata.provider", "usage_metadata.provider", "provider"
  ];
  
  // Search backwards (most recent message has best info)
  for (let i = messageList.length - 1; i >= 0; i--) {
    const message = messageList[i];
    if (!message) continue;
    
    for (const path of messagePaths) {
      const value = getNestedValue(message, path);
      const str = coerceToString(value);
      if (str) return str;
    }
  }
  
  return undefined;
}

const DEFAULT_TRACE_CONFIG = {
  enabled: false,
  logData: true,
} as const;

function ensureDir(p: string) {
  if (!fs.existsSync(p)) {
    fs.mkdirSync(p, { recursive: true });
  }
}

function withDefaults(config?: SmartAgentTracingConfig): ResolvedTraceConfig {
  const enabled = Boolean(config?.enabled);
  const logData = config?.logData ?? DEFAULT_TRACE_CONFIG.logData;
  const mode: TracingMode = config?.mode === "streaming" ? "streaming" : "batched";

  let sink: ResolvedTraceSink;
  try {
    sink = resolveSink(config?.sink);
  } catch (err) {
    if (typeof console !== "undefined" && typeof console.warn === "function") {
      console.warn("Invalid tracing sink configuration. Falling back to file sink.", err);
    }
    sink = resolveSink({ type: "file" });
  }

  return {
    enabled,
    logData,
    mode,
    sink,
  };
}

function resolveSink(sink?: TraceSinkConfig): ResolvedTraceSink {
  const candidate = sink ?? { type: "file" };
  switch (candidate.type) {
    case "file": {
      const baseDir = resolveLogsBaseDir(candidate.path, false);
      return { type: "file", baseDir };
    }
    case "custom": {
      const onEvent = typeof candidate.onEvent === "function" ? candidate.onEvent : undefined;
      const onSession = typeof candidate.onSession === "function" ? candidate.onSession : undefined;
      return { type: "custom", onEvent, onSession };
    }
    case "cognipeer": {
      const apiKey = typeof candidate.apiKey === "string" ? candidate.apiKey.trim() : "";
      if (!apiKey) {
        throw new Error("cognipeer sink requires a non-empty apiKey");
      }
      const url = typeof candidate.url === "string" && candidate.url.trim().length > 0
        ? candidate.url.trim()
        : DEFAULT_COGNIPEER_URL;
      return { type: "cognipeer", url, apiKey };
    }
    case "http": {
      const url = typeof candidate.url === "string" ? candidate.url.trim() : "";
      if (!url) {
        throw new Error("http sink requires a non-empty url");
      }
      const headers = candidate.headers ? { ...candidate.headers } : undefined;
      return headers ? { type: "http", url, headers } : { type: "http", url };
    }
    case "otlp": {
      const endpoint = typeof candidate.endpoint === "string" ? candidate.endpoint.trim() : "";
      if (!endpoint) {
        throw new Error("otlp sink requires a non-empty endpoint");
      }
      const headers = candidate.headers ? { ...candidate.headers } : undefined;
      return headers ? { type: "otlp", endpoint, headers } : { type: "otlp", endpoint };
    }
    default: {
      if (typeof console !== "undefined" && typeof console.warn === "function") {
        console.warn("Unknown tracing sink type. Falling back to file sink.", candidate);
      }
      return resolveSink({ type: "file" });
    }
  }
}

function snapshotSink(runtime: TraceSessionRuntime): TraceSinkSnapshot {
  const sink = runtime.resolvedConfig.sink;
  switch (sink.type) {
    case "file":
      return { type: "file", path: runtime.fileBaseDir || sink.baseDir };
    case "custom":
      return { type: "custom" };
    case "cognipeer":
      return { type: "cognipeer", url: sink.url };
    case "http":
      return { type: "http", url: sink.url };
    case "otlp":
      return { type: "otlp", endpoint: sink.endpoint };
    default:
      return { type: "custom" };
  }
}

function buildConfigSnapshot(runtime: TraceSessionRuntime): TraceSessionConfigSnapshot {
  return {
    enabled: runtime.resolvedConfig.enabled,
    logData: runtime.resolvedConfig.logData,
    sink: snapshotSink(runtime),
  };
}

// ─── Reliable HTTP transport for tracing sinks ──────────────────────────────
//
// Tracing posts used to be a single fetch with no timeout and no retry, so a
// transient network blip / 5xx / rate-limit silently lost the session. These
// helpers add a bounded retry with backoff + a per-attempt timeout. Retries are
// safe because the ingest is idempotent: start/end upsert by sessionId and the
// end payload carries the authoritative summary. Per-event posts opt OUT of
// retry (retry:false) because the events endpoint increments counts without
// dedup — the authoritative totals ride the retried `end`.

const TRACE_HTTP_MAX_ATTEMPTS = 4;
const TRACE_HTTP_ATTEMPT_TIMEOUT_MS = 8_000;
const TRACE_HTTP_RETRYABLE_STATUS = new Set([404, 408, 425, 429, 500, 502, 503, 504]);
const TRACE_HTTP_RETRY_BASE_MS = 250;
const TRACE_HTTP_RETRY_MAX_MS = 4_000;

class RetryableHttpError extends Error {
  readonly status: number;
  readonly retryAfterMs?: number;
  constructor(status: number, message: string, retryAfterMs?: number) {
    super(message);
    this.name = "RetryableHttpError";
    this.status = status;
    this.retryAfterMs = retryAfterMs;
  }
}

function traceSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function traceBackoffDelay(attempt: number, baseMs: number, maxMs: number): number {
  const exp = Math.min(maxMs, baseMs * 2 ** (attempt - 1));
  // Full jitter to avoid synchronized retries across many concurrent sessions.
  return Math.floor(Math.random() * exp);
}

function parseRetryAfterMs(headerValue: string | null | undefined): number | undefined {
  if (!headerValue) return undefined;
  const seconds = Number(headerValue);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const dateMs = Date.parse(headerValue);
  if (Number.isFinite(dateMs)) return Math.max(0, dateMs - Date.now());
  return undefined;
}

async function postJsonOnce(
  url: string,
  headers: Record<string, string> | undefined,
  body: unknown
): Promise<void> {
  const fetchFn = typeof globalThis.fetch === "function" ? globalThis.fetch.bind(globalThis) : undefined;
  if (!fetchFn) {
    throw new Error("HTTP sink requires fetch to be available in this runtime.");
  }

  const finalHeaders = { ...(headers || {}) } as Record<string, string>;
  if (!Object.keys(finalHeaders).some((key) => key.toLowerCase() === "content-type")) {
    finalHeaders["content-type"] = "application/json";
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TRACE_HTTP_ATTEMPT_TIMEOUT_MS);
  let response: Response;
  try {
    response = await fetchFn(url, {
      method: "POST",
      headers: finalHeaders,
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (err) {
    // Network error / timeout / abort — always transient.
    const message = err instanceof Error ? err.message : String(err);
    throw new RetryableHttpError(0, `network error - ${message}`);
  } finally {
    clearTimeout(timer);
  }

  if (response.ok) return;

  let responseText = "";
  try {
    responseText = await response.text();
  } catch {
    // ignore
  }
  const statusLine = `HTTP ${response.status}${response.statusText ? ` ${response.statusText}` : ""}`;
  const bodyPreview = responseText ? ` - ${responseText.slice(0, 200)}` : "";
  const message = `${statusLine}${bodyPreview}`;

  if (TRACE_HTTP_RETRYABLE_STATUS.has(response.status)) {
    throw new RetryableHttpError(response.status, message, parseRetryAfterMs(response.headers.get("retry-after")));
  }
  // Non-retryable (400/401/403/413/…): retrying will not help.
  throw new Error(message);
}

/**
 * POST JSON to a tracing endpoint with bounded retry + backoff. Pass
 * `{ retry: false }` for best-effort single-attempt delivery.
 */
async function postJsonReliable(
  url: string,
  headers: Record<string, string> | undefined,
  body: unknown,
  opts: { retry?: boolean } = {}
): Promise<void> {
  const maxAttempts = opts.retry === false ? 1 : TRACE_HTTP_MAX_ATTEMPTS;
  let lastError: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      await postJsonOnce(url, headers, body);
      return;
    } catch (err) {
      lastError = err;
      if (!(err instanceof RetryableHttpError) || attempt === maxAttempts) {
        if (typeof console !== "undefined" && typeof console.error === "function") {
          console.error("[Tracing] Failed to post:", err instanceof Error ? err.message : String(err));
        }
        throw err;
      }
      const wait = err.retryAfterMs ?? traceBackoffDelay(attempt, TRACE_HTTP_RETRY_BASE_MS, TRACE_HTTP_RETRY_MAX_MS);
      await traceSleep(Math.min(wait, TRACE_HTTP_RETRY_MAX_MS));
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

async function postTraceSession(
  url: string,
  headers: Record<string, string> | undefined,
  payload: TraceSessionFile
): Promise<void> {
  await postJsonReliable(url, headers, payload, { retry: true });
}

/**
 * POST a streaming session start to the remote endpoint
 */
async function postStreamingSessionStart(
  baseUrl: string,
  headers: Record<string, string> | undefined,
  payload: {
    sessionId: string;
    startedAt: string;
    agent?: { name?: string; version?: string; model?: string; provider?: string };
    metadata?: Record<string, string>;
    config?: TraceSessionConfigSnapshot;
  }
): Promise<void> {
  const url = `${baseUrl.replace(/\/$/, "")}/stream/${payload.sessionId}/start`;
  await postJsonReliable(url, headers, payload, { retry: true });
}

/**
 * POST a single event to the streaming endpoint. Best-effort, single attempt:
 * the Console events endpoint increments totalEvents/eventCounts without dedup,
 * so a retried event would inflate those counts. Authoritative token/summary
 * totals are delivered (and overwritten) by the retried session `end`, so a
 * dropped live event never corrupts the aggregates.
 */
async function postStreamingEvent(
  baseUrl: string,
  headers: Record<string, string> | undefined,
  sessionId: string,
  event: TraceEventRecord,
  metadata?: Record<string, string>
): Promise<void> {
  const url = `${baseUrl.replace(/\/$/, "")}/stream/${sessionId}/events`;
  await postJsonReliable(url, headers, { event, metadata }, { retry: false });
}

/**
 * POST session end to the streaming endpoint. This carries the authoritative
 * session summary, so it retries.
 */
async function postStreamingSessionEnd(
  baseUrl: string,
  headers: Record<string, string> | undefined,
  payload: {
    sessionId: string;
    endedAt: string;
    durationMs: number;
    status: TraceSessionStatus;
    summary: TraceSessionSummary;
    errors: Array<{ eventId: string; message: string; stack?: string; type?: string; timestamp?: string }>;
    metadata?: Record<string, string>;
  }
): Promise<void> {
  const url = `${baseUrl.replace(/\/$/, "")}/stream/${payload.sessionId}/end`;
  await postJsonReliable(url, headers, payload, { retry: true });
}

// ─── OTLP/HTTP JSON Export ──────────────────────────────────────────────────

/** Nanosecond timestamp from ISO date string */
function isoToUnixNano(iso: string): string {
  const ms = new Date(iso).getTime();
  // OTel uses fixed-point string nanoseconds (BigInt not needed for JSON)
  return `${ms}000000`;
}

/** Map agent/event status to OTel StatusCode: 0=UNSET, 1=OK, 2=ERROR */
function toOtlpStatusCode(status: string): number {
  if (status === "error") return 2;
  if (status === "success" || status === "completed") return 1;
  return 0; // UNSET for in_progress, skipped, retry, etc.
}

/** Map event type to OTel SpanKind: 0 UNSPECIFIED, 1 INTERNAL, 2 SERVER, 3 CLIENT */
function toOtlpSpanKind(type: string): number {
  switch (type) {
    case "ai_call":
      return 3; // CLIENT — outgoing LLM request
    case "tool_call":
      return 1; // INTERNAL
    case "agent_iteration":
      return 1; // INTERNAL
    default:
      return 1; // INTERNAL
  }
}

type OtlpKeyValue = { key: string; value: { stringValue?: string; intValue?: string; doubleValue?: number; boolValue?: boolean } };

function stringAttr(key: string, val: string | undefined): OtlpKeyValue | null {
  return val != null ? { key, value: { stringValue: val } } : null;
}

function intAttr(key: string, val: number | undefined): OtlpKeyValue | null {
  return val != null && !Number.isNaN(val) ? { key, value: { intValue: String(val) } } : null;
}

function doubleAttr(key: string, val: number | undefined): OtlpKeyValue | null {
  return val != null && !Number.isNaN(val) ? { key, value: { doubleValue: val } } : null;
}

/** Convert a single TraceEventRecord into an OTLP Span object. */
function eventToOtlpSpan(event: TraceEventRecord): Record<string, unknown> {
  const startNano = isoToUnixNano(event.timestamp);
  const endNano = event.durationMs != null
    ? `${new Date(new Date(event.timestamp).getTime() + event.durationMs).getTime()}000000`
    : startNano;

  const attrs: OtlpKeyValue[] = [
    stringAttr("cognipeer.event.type", event.type),
    stringAttr("cognipeer.event.label", event.label),
    intAttr("cognipeer.event.sequence", event.sequence),
    stringAttr("cognipeer.actor.scope", event.actor?.scope),
    stringAttr("cognipeer.actor.name", event.actor?.name),
    stringAttr("cognipeer.actor.role", event.actor?.role),
    stringAttr("cognipeer.model", event.model),
    intAttr("cognipeer.tokens.reasoning", event.reasoningTokens),
    stringAttr("cognipeer.finish_reason", event.finishReason),
    stringAttr("cognipeer.provider", event.provider),
    stringAttr("cognipeer.tool.details", event.toolDetails ? JSON.stringify(event.toolDetails) : undefined),
    intAttr("cognipeer.tokens.input", event.inputTokens),
    intAttr("cognipeer.tokens.output", event.outputTokens),
    intAttr("cognipeer.tokens.total", event.totalTokens),
    intAttr("cognipeer.tokens.cached_input", event.cachedInputTokens),
    intAttr("cognipeer.bytes.request", event.requestBytes),
    intAttr("cognipeer.bytes.response", event.responseBytes),
    stringAttr("cognipeer.tool.execution_id", event.toolExecutionId),
    stringAttr("cognipeer.retry_of", event.retryOf),
    stringAttr("cognipeer.event.id", event.id),
  ].filter(Boolean) as OtlpKeyValue[];

  // Add sections as a JSON string attribute if present
  if (event.data?.sections && event.data.sections.length > 0) {
    try {
      attrs.push({ key: "cognipeer.sections", value: { stringValue: JSON.stringify(event.data.sections) } });
    } catch { /* skip on serialization failures */ }
  }

  const span: Record<string, unknown> = {
    traceId: event.traceId,
    spanId: event.spanId,
    parentSpanId: event.parentSpanId || "",
    name: event.label || event.type,
    kind: toOtlpSpanKind(event.type),
    startTimeUnixNano: startNano,
    endTimeUnixNano: endNano,
    attributes: attrs,
    status: {
      code: toOtlpStatusCode(event.status),
      ...(event.status === "error" && event.error?.message ? { message: event.error.message } : {}),
    },
  };

  // Error events
  if (event.error) {
    span.events = [{
      timeUnixNano: startNano,
      name: "exception",
      attributes: [
        { key: "exception.message", value: { stringValue: event.error.message } },
        ...(event.error.stack ? [{ key: "exception.stacktrace", value: { stringValue: event.error.stack } }] : []),
      ],
    }];
  }

  return span;
}

/**
 * Convert a complete TraceSessionFile into an OTLP ExportTraceServiceRequest (JSON).
 * Produces a root span for the session and child spans for each event.
 */
export function traceSessionToOtlp(session: TraceSessionFile): Record<string, unknown> {
  const traceId = session.traceId || generateTraceId();
  const rootSpanId = session.rootSpanId || generateSpanId();
  const startNano = isoToUnixNano(session.startedAt);
  const endNano = session.endedAt ? isoToUnixNano(session.endedAt) : startNano;

  // Resource attributes
  const resourceAttrs: OtlpKeyValue[] = [
    { key: "service.name", value: { stringValue: session.agent?.name || "cognipeer-agent" } },
    stringAttr("service.version", session.agent?.version),
    stringAttr("cognipeer.session.id", session.sessionId),
    stringAttr("cognipeer.thread.id", session.threadId),
    stringAttr("cognipeer.agent.model", session.agent?.model),
    stringAttr("cognipeer.agent.provider", session.agent?.provider),
    ...Object.entries(session.metadata || {}).map(([key, value]) => stringAttr(`cognipeer.metadata.${key}`, value)),
  ].filter(Boolean) as OtlpKeyValue[];

  // Root span — represents the entire agent session
  const rootAttrs: OtlpKeyValue[] = [
    stringAttr("cognipeer.session.status", session.status),
    doubleAttr("cognipeer.session.duration_ms", session.durationMs),
    intAttr("cognipeer.session.total_input_tokens", session.summary.totalInputTokens),
    intAttr("cognipeer.session.total_output_tokens", session.summary.totalOutputTokens),
    intAttr("cognipeer.session.total_cached_input_tokens", session.summary.totalCachedInputTokens),
    intAttr("cognipeer.session.total_bytes_in", session.summary.totalBytesIn),
    intAttr("cognipeer.session.total_bytes_out", session.summary.totalBytesOut),
    intAttr("cognipeer.session.event_count", session.events.length),
  ].filter(Boolean) as OtlpKeyValue[];

  // Include event count breakdown
  if (session.summary.eventCounts) {
    for (const [key, count] of Object.entries(session.summary.eventCounts)) {
      rootAttrs.push({ key: `cognipeer.session.event_count.${key}`, value: { intValue: String(count) } });
    }
  }

  const rootSpan: Record<string, unknown> = {
    traceId,
    spanId: rootSpanId,
    parentSpanId: "",
    name: `agent_session: ${session.agent?.name || "agent"}`,
    kind: 1, // INTERNAL
    startTimeUnixNano: startNano,
    endTimeUnixNano: endNano,
    attributes: rootAttrs,
    status: {
      code: toOtlpStatusCode(session.status),
      ...(session.status === "error" && session.errors.length > 0
        ? { message: session.errors.map((e) => e.message).join("; ") }
        : {}),
    },
  };

  // Error events on root span
  if (session.errors.length > 0) {
    rootSpan.events = session.errors.map((err) => ({
      timeUnixNano: err.timestamp ? isoToUnixNano(err.timestamp) : startNano,
      name: "exception",
      attributes: [
        { key: "exception.message", value: { stringValue: err.message } },
        ...(err.stack ? [{ key: "exception.stacktrace", value: { stringValue: err.stack } }] : []),
        ...(err.type ? [{ key: "exception.type", value: { stringValue: err.type } }] : []),
      ],
    }));
  }

  // Child spans for each event — inherit traceId from session
  const childSpans = session.events.map((event) => {
    const span = eventToOtlpSpan({
      ...event,
      traceId: event.traceId || traceId,
      spanId: event.spanId || generateSpanId(),
      parentSpanId: event.parentSpanId || rootSpanId,
    });
    return span;
  });

  return {
    resourceSpans: [{
      resource: { attributes: resourceAttrs },
      scopeSpans: [{
        scope: {
          name: "cognipeer-agent-sdk",
          version: "1.0.0",
        },
        spans: [rootSpan, ...childSpans],
      }],
    }],
  };
}

/**
 * POST an OTLP ExportTraceServiceRequest (JSON) to the given endpoint.
 */
async function postOtlpTraces(
  endpoint: string,
  headers: Record<string, string> | undefined,
  payload: Record<string, unknown>
): Promise<void> {
  const fetchFn = typeof globalThis.fetch === "function" ? globalThis.fetch.bind(globalThis) : undefined;
  if (!fetchFn) {
    throw new Error("OTLP sink requires fetch to be available in this runtime.");
  }

  const finalHeaders: Record<string, string> = {
    "content-type": "application/json",
    ...(headers || {}),
  };

  try {
    const response = await fetchFn(endpoint, {
      method: "POST",
      headers: finalHeaders,
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      let responseText = "";
      try {
        responseText = await response.text();
      } catch { /* ignore */ }
      const statusLine = `HTTP ${response.status}${response.statusText ? ` ${response.statusText}` : ""}`;
      const bodyPreview = responseText ? ` - ${responseText.slice(0, 200)}` : "";
      throw new Error(`${statusLine}${bodyPreview}`);
    }
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    if (typeof console !== "undefined" && typeof console.error === "function") {
      console.error("[Tracing] OTLP export failed:", errMsg);
    }
    throw err;
  }
}

function createEmptySummary(): TraceSessionSummary {
  return {
    totalDurationMs: 0,
    totalInputTokens: 0,
    totalOutputTokens: 0,
    totalCachedInputTokens: 0,
    totalBytesIn: 0,
    totalBytesOut: 0,
    eventCounts: {},
  };
}

function generateSessionId(): string {
  return `sess_${nanoid(18)}`;
}

function generateEventId(sequence: number): string {
  return `evt_${String(sequence).padStart(4, "0")}_${nanoid(4)}`;
}

/** Generate a W3C-compatible trace ID (32 hex chars / 128-bit). */
export function generateTraceId(): string {
  return crypto.randomBytes(16).toString("hex");
}

/** Generate an OTel span ID (16 hex chars / 64-bit). */
export function generateSpanId(): string {
  return crypto.randomBytes(8).toString("hex");
}

function defaultEventLabel(type: string): string {
  switch (type) {
    case "ai_call":
      return "Assistant Response";
    case "tool_call":
      return "Tool Execution";
    case "session":
      return "Session Event";
    default:
      return type.replace(/_/g, " ").replace(/\b\w/g, (char) => char.toUpperCase());
  }
}

function ensureUniqueSections(eventId: string, sections?: TraceDataSection[]): TraceDataSection[] | undefined {
  if (!sections || sections.length === 0) return undefined;
  const labelCounts = new Map<string, number>();
  const normalized: TraceDataSection[] = [];
  let counter = 1;

  for (const section of sections) {
    const baseLabel = section.label?.trim().length ? section.label.trim() : defaultSectionLabel(section.kind);
    const nextCount = (labelCounts.get(baseLabel) || 0) + 1;
    labelCounts.set(baseLabel, nextCount);
    const finalLabel = nextCount > 1 ? `${baseLabel} (${nextCount})` : baseLabel;

    let id = section.id?.trim();
    if (!id) {
      id = `${section.kind}-${eventId}-${String(counter).padStart(2, "0")}`;
    }
    counter += 1;

    normalized.push({
      ...section,
      id,
      label: finalLabel,
    } as TraceDataSection);
  }

  return normalized;
}

function defaultSectionLabel(kind: TraceDataSection["kind"]): string {
  switch (kind) {
    case "message":
      return "Message";
    case "tool_call":
      return "Tool Call";
    case "tool_result":
      return "Tool Result";
    case "tool_response":
      return "Tool Response";
    case "summary":
      return "Summary";
    case "metadata":
      return "Details";
    case "tool_definitions":
      return "Tool Definitions";
    case "response_format":
      return "Response Format";
    default:
      return "Section";
  }
}

// ── Tool-definitions section (per-model-call tool menu) ──────────────────────
// Size discipline mirrors the Cognipeer console ingest contract: at most 128
// tools, name ≤200 chars, description ≤4000 chars, whole section ≤64KB —
// oversized entries drop `parameters` (marked truncated) before the list
// itself is trimmed. MCP-derived schemas can be enormous; the menu must never
// bloat the trace payload.
const TOOL_DEFINITIONS_MAX_TOOLS = 128;
const TOOL_DEFINITIONS_MAX_NAME_CHARS = 200;
const TOOL_DEFINITIONS_MAX_DESCRIPTION_CHARS = 4000;
const TOOL_DEFINITIONS_MAX_SECTION_BYTES = 64 * 1024;

function sectionByteSize(section: TraceToolDefinitionsSection): number {
  try {
    return Buffer.byteLength(JSON.stringify(section), "utf8");
  } catch {
    return Number.MAX_SAFE_INTEGER;
  }
}

/**
 * Build the `tool_definitions` section for one model call, or undefined when
 * nothing usable was supplied. Exported for provider/node code that assembles
 * sections itself.
 */
export function buildToolDefinitionsSection(
  toolDefinitions: Array<{ name: string; description?: string; parameters?: Record<string, any> }>,
): TraceToolDefinitionsSection | undefined {
  const tools: TraceToolDefinition[] = [];
  for (const entry of toolDefinitions) {
    if (!entry || typeof entry.name !== "string" || entry.name.trim().length === 0) continue;
    const tool: TraceToolDefinition = { name: entry.name.trim().slice(0, TOOL_DEFINITIONS_MAX_NAME_CHARS) };
    if (typeof entry.description === "string" && entry.description.length > 0) {
      tool.description = entry.description.slice(0, TOOL_DEFINITIONS_MAX_DESCRIPTION_CHARS);
    }
    if (entry.parameters && typeof entry.parameters === "object" && !Array.isArray(entry.parameters)) {
      // Snapshot, don't alias: the caller may mutate its schema object after
      // this call, and the section must record the menu AS SENT on this call.
      // JSON round-trip matches the section's eventual serialization (drops
      // functions/undefined) and keeps the delete-based truncation safe.
      try {
        tool.parameters = JSON.parse(JSON.stringify(entry.parameters));
      } catch {
        // Non-serializable (e.g. circular) schema: omit rather than alias.
      }
    }
    tools.push(tool);
    if (tools.length >= TOOL_DEFINITIONS_MAX_TOOLS) break;
  }
  if (tools.length === 0) return undefined;

  const section: TraceToolDefinitionsSection = {
    kind: "tool_definitions",
    label: "Tool Definitions",
    tools,
    ...(toolDefinitions.length > tools.length ? { truncated: true } : {}),
  };

  // Over budget: drop the largest parameters first (names/descriptions stay —
  // the menu's SHAPE matters more than every schema), then trim the list.
  if (sectionByteSize(section) > TOOL_DEFINITIONS_MAX_SECTION_BYTES) {
    const bySize = [...section.tools]
      .map((tool, index) => ({ index, size: tool.parameters ? sectionByteSize({ ...section, tools: [tool] }) : 0 }))
      .sort((a, b) => b.size - a.size);
    for (const { index } of bySize) {
      if (sectionByteSize(section) <= TOOL_DEFINITIONS_MAX_SECTION_BYTES) break;
      const tool = section.tools[index];
      if (tool?.parameters) {
        delete tool.parameters;
        tool.truncated = true;
        section.truncated = true;
      }
    }
    while (sectionByteSize(section) > TOOL_DEFINITIONS_MAX_SECTION_BYTES && section.tools.length > 1) {
      section.tools.pop();
      section.truncated = true;
    }
  }

  return section;
}

// ── Response-format section (per-model-call structured-output contract) ──────
// Same size discipline as the tool menu: a JSON Schema can be enormous, so the
// section keeps the identifying fields (type / schema name / strict) and drops
// only the schema body when it would blow the budget.
const RESPONSE_FORMAT_MAX_SECTION_BYTES = 64 * 1024;
const RESPONSE_FORMAT_MAX_NAME_CHARS = 200;

/**
 * Build the `response_format` section for one model call, or undefined when
 * nothing usable was supplied.
 *
 * Accepts either the invoke-options wrapper produced by
 * `NativeJsonSchemaStrategy.buildResponseFormat()` (`{ response_format: {…} }`)
 * or a bare `response_format` object, so callers can pass whatever they hold.
 * Exported for provider/node code that assembles sections itself.
 */
export function buildResponseFormatSection(
  responseFormat: Record<string, any> | undefined,
  strategy?: "native" | "tool_based",
): TraceResponseFormatSection | undefined {
  if (!responseFormat || typeof responseFormat !== "object" || Array.isArray(responseFormat)) return undefined;
  // Unwrap the invoke-options envelope when present.
  const raw = (responseFormat.response_format ?? responseFormat.responseFormat ?? responseFormat) as Record<string, any>;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;

  const type = typeof raw.type === "string" && raw.type.trim().length > 0 ? raw.type.trim() : undefined;
  const jsonSchema = (raw.json_schema ?? raw.jsonSchema) as Record<string, any> | undefined;
  // A bare `{ schema: … }` with no type still describes a JSON contract.
  const schemaSource = jsonSchema && typeof jsonSchema === "object" ? jsonSchema : raw;
  const schema = schemaSource.schema && typeof schemaSource.schema === "object" && !Array.isArray(schemaSource.schema)
    ? (schemaSource.schema as Record<string, any>)
    : undefined;
  if (!type && !schema) return undefined;

  const section: TraceResponseFormatSection = {
    kind: "response_format",
    label: "Response Format",
    type: type ?? (schema ? "json_schema" : "unknown"),
    ...(strategy ? { strategy } : {}),
    ...(typeof schemaSource.name === "string" && schemaSource.name.length > 0
      ? { schemaName: schemaSource.name.slice(0, RESPONSE_FORMAT_MAX_NAME_CHARS) }
      : {}),
    ...(typeof schemaSource.strict === "boolean" ? { strict: schemaSource.strict } : {}),
  };

  if (schema) {
    // Snapshot, don't alias: the caller may mutate the schema object after this
    // call, and the section must record the contract AS SENT on this call.
    try {
      section.schema = JSON.parse(JSON.stringify(schema));
    } catch {
      // Non-serializable (e.g. circular) schema: omit rather than alias.
    }
  }

  // Over budget: the schema body goes, the contract's identity stays — knowing
  // a strict `invoice_v2` schema was enforced is most of the diagnostic value.
  try {
    if (section.schema && Buffer.byteLength(JSON.stringify(section), "utf8") > RESPONSE_FORMAT_MAX_SECTION_BYTES) {
      delete section.schema;
      section.truncated = true;
    }
  } catch {
    delete section.schema;
    section.truncated = true;
  }

  return section;
}

function buildMessageLabel(role: string, index: number): string {
  const normalized = role?.trim().length ? role.trim() : "message";
  const base = `${normalized.charAt(0).toUpperCase()}${normalized.slice(1)} Message`;
  return index > 1 ? `${base} #${index}` : base;
}

function toDisplayString(value: any): string {
  const sanitized = sanitizeTracePayload(value);
  if (sanitized == null) return "";
  if (typeof sanitized === "string") return sanitized;
  if (Array.isArray(sanitized)) {
    return sanitized
      .map((item) => toDisplayString(item))
      .filter((part) => part && part.trim().length > 0)
      .join("\n");
  }
  if (typeof sanitized === "object") {
    if (typeof (sanitized as any).text === "string" && Object.keys(sanitized).length === 1) {
      return (sanitized as any).text;
    }
    if (typeof (sanitized as any).content === "string") {
      return (sanitized as any).content;
    }
    try {
      return JSON.stringify(sanitized, null, 2);
    } catch {
      return String(sanitized);
    }
  }
  return String(sanitized);
}

function parseToolArguments(args: any): any {
  if (args == null) return undefined;
  if (typeof args === "string") {
    try {
      return JSON.parse(args);
    } catch {
      return args;
    }
  }
  return args;
}

function collectToolCallSectionsFromMessage(message: any): TraceToolCallSection[] {
  const sections: TraceToolCallSection[] = [];
  if (!message) return sections;

  const addCall = (call: any) => {
    if (!call) return;
    const toolName = call?.name || call?.tool || call?.function?.name || call?.function_call?.name || "tool";
    const rawArgs = call?.arguments ?? call?.args ?? call?.input ?? call?.function?.arguments ?? call?.function_call?.arguments;
    const parsedArgs = parseToolArguments(rawArgs);
    const argumentsPayload = sanitizeTracePayload(parsedArgs ?? rawArgs ?? {});
    sections.push({
      kind: "tool_call",
      label: `Tool Call: ${toolName}`,
      tool: toolName,
      arguments: argumentsPayload,
    });
  };

  const directCalls = Array.isArray(message?.tool_calls) ? message.tool_calls : undefined;
  if (directCalls) {
    directCalls.forEach((call: any) => addCall(call));
  }

  return sections;
}

function convertMessageListToSections(messageList?: any[]): TraceDataSection[] | undefined {
  if (!Array.isArray(messageList) || messageList.length === 0) return undefined;
  const sections: TraceDataSection[] = [];
  const roleCounts = new Map<string, number>();

  for (const message of messageList) {
    if (!message) continue;

    const toolSections = collectToolCallSectionsFromMessage(message);
    if (toolSections.length > 0) {
      sections.push(...toolSections);
      continue;
    }

    const role = typeof message?.role === "string" ? message.role : "assistant";
    const next = (roleCounts.get(role) || 0) + 1;
    roleCounts.set(role, next);

    let content = toDisplayString(message?.content ?? "");
    if (!content || !content.trim().length) {
      if (toolSections.length > 0) {
        content = "[tool call]";
      } else if (typeof message?.content === "undefined" || message?.content === null) {
        continue;
      } else {
        content = toDisplayString(sanitizeTracePayload(message?.content));
        if (!content || !content.trim().length) continue;
      }
    }

    sections.push({
      kind: "message",
      label: buildMessageLabel(role, next),
      role,
      content,
      metadata: typeof message?.name === "string" ? { name: message.name } : undefined,
    });
  }

  return sections.length > 0 ? sections : undefined;
}

export function createTraceSession(opts: SmartAgentOptions): TraceSessionRuntime | undefined {
  const cfg = withDefaults(opts.tracing);
  if (!cfg.enabled) return undefined;

  // Prefer a caller-supplied session id (e.g. a task-run/chat id) so emitted
  // traces correlate with the caller's own identifiers; fall back to a random id.
  const providedSessionId = opts.tracing?.sessionId?.trim();
  const sessionId = providedSessionId || generateSessionId();
  const traceId = generateTraceId();
  const rootSpanId = generateSpanId();
  const runtime: TraceSessionRuntime = {
    sessionId,
    traceId,
    rootSpanId,
    threadId: opts.tracing?.threadId,
    configAgentName: opts.tracing?.agentName?.trim() || undefined,
    configMetadata: opts.tracing?.metadata && Object.keys(opts.tracing.metadata).length > 0
      ? opts.tracing.metadata
      : undefined,
    startedAt: Date.now(),
    resolvedConfig: cfg,
    events: [],
    summary: createEmptySummary(),
    status: "in_progress",
    errors: [],
    sessionStarted: false,
  };

  if (cfg.sink.type === "file") {
    const baseDir = cfg.sink.baseDir;
    ensureDir(baseDir);
    const sessionDir = path.join(baseDir, sessionId);
    ensureDir(sessionDir);
    runtime.fileBaseDir = baseDir;
    runtime.fileSessionDir = sessionDir;
  }

  return runtime;
}

/**
 * Start a streaming trace session. Should be called before recording events in streaming mode.
 * This sends the session start to the remote endpoint immediately.
 */
export async function startStreamingSession(
  session: TraceSessionRuntime | undefined,
  agentRuntime?: AgentRuntimeConfig
): Promise<void> {
  if (!session) return;
  if (session.resolvedConfig.mode !== "streaming") return;
  if (session.sessionStarted) return;

  const sink = session.resolvedConfig.sink;
  
  // Build agent info. A caller-supplied agentName (TracingConfig.agentName)
  // overrides the SmartAgent's own name so the same implementation can be
  // reported under distinct logical names.
  const resolvedAgentName = session.configAgentName || agentRuntime?.name || "unknown-agent";
  const agentInfo = (agentRuntime || session.configAgentName) ? {
    name: resolvedAgentName,
    version: agentRuntime?.version,
    model: getModelName(agentRuntime?.model) || "unknown-model",
    provider: getProviderName(agentRuntime?.model),
  } : undefined;

  session.agentInfo = agentInfo;
  
  const configSnapshot = buildConfigSnapshot(session);
  const startedAtIso = new Date(session.startedAt).toISOString();
  
  const payload = {
    sessionId: session.sessionId,
    threadId: session.threadId,
    startedAt: startedAtIso,
    agent: agentInfo,
    metadata: session.configMetadata,
    config: configSnapshot,
  };

  if (sink.type === "cognipeer" || sink.type === "http") {
    try {
      const headers = sink.type === "cognipeer"
        ? { Authorization: `Bearer ${sink.apiKey}` }
        : sink.headers;
      
      await postStreamingSessionStart(sink.url, headers, payload);
      session.sessionStarted = true;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      session.errors.push({
        eventId: "session_start",
        message,
        type: "sink",
        timestamp: startedAtIso,
      });
      // Don't throw - allow session to continue in degraded mode
      if (typeof console !== "undefined" && typeof console.warn === "function") {
        console.warn("[Tracing] Failed to start streaming session, falling back to batched:", message);
      }
    }
  } else if (sink.type === "custom" && typeof sink.onEvent === "function") {
    // For custom sinks in streaming mode, we mark as started and let events flow through
    session.sessionStarted = true;
  } else if (sink.type === "file") {
    // File sink in streaming mode - just mark as started, events will be written on finalize
    session.sessionStarted = true;
  }
}

export function recordTraceEvent(
  session: TraceSessionRuntime | undefined,
  event: {
    type: string;
    label?: string;
    timestamp?: string;
    actor?: TraceEventRecord["actor"];
    status?: TraceEventRecord["status"];
    /** Explicit parent span ID. Falls back to session.currentIterationSpanId when omitted. */
    parentSpanId?: string;
    durationMs?: number;
    inputTokens?: number;
    outputTokens?: number;
    totalTokens?: number;
    cachedInputTokens?: number;
    /** Subset of `outputTokens` spent on reasoning (see TraceEventRecord). */
    reasoningTokens?: number;
    /** Why the model stopped — `length` explains most truncated JSON. */
    finishReason?: string;
    requestBytes?: number;
    responseBytes?: number;
    model?: string;
    provider?: string;
    toolDetails?: TraceEventRecord["toolDetails"];
    toolExecutionId?: string;
    retryOf?: string;
    error?: { message: string; stack?: string } | null;
    messageList?: any[];
    /** Pre-built sections to use instead of auto-converting messageList */
    sections?: TraceDataSection[];
    /**
     * Tool MENU bound to this model call (`ai_call` events). Appended as a
     * `tool_definitions` section AFTER messageList/sections resolution, so it
     * composes with the auto-converted message sections instead of replacing
     * them. Size-capped; suppressed when logData is off.
     */
    toolDefinitions?: Array<{ name: string; description?: string; parameters?: Record<string, any> }>;
    /**
     * Structured-output CONTRACT bound to this model call (`ai_call` events),
     * appended as a `response_format` section next to the tool menu. Accepts
     * the `{ response_format: … }` invoke-options envelope or a bare
     * response_format object. Size-capped; suppressed when logData is off.
     */
    responseFormat?: Record<string, any>;
    /** Which structured-output strategy produced `responseFormat`. */
    responseFormatStrategy?: "native" | "tool_based";
    debug?: Record<string, any>;
  }
): TraceEventRecord | undefined {
  if (!session) return undefined;


  const sequence = session.events.length + 1;
  const id = generateEventId(sequence);
  const timestampIso = event.timestamp || new Date().toISOString();
  const status = event.status ?? "success";
  const baseLabel = event.label?.trim().length ? event.label.trim() : defaultEventLabel(event.type);
  const eventLabel = `${baseLabel} #${sequence}`;

  const durationMs = event.durationMs !== undefined ? Number(event.durationMs) : undefined;
  if (!Number.isNaN(durationMs ?? NaN) && durationMs !== undefined) {
    session.summary.totalDurationMs += durationMs;
  }

  const inputTokens = event.inputTokens !== undefined ? Number(event.inputTokens) : undefined;
  if (!Number.isNaN(inputTokens ?? NaN) && inputTokens !== undefined) {
    session.summary.totalInputTokens += inputTokens;
  }

  const outputTokens = event.outputTokens !== undefined ? Number(event.outputTokens) : undefined;
  if (!Number.isNaN(outputTokens ?? NaN) && outputTokens !== undefined) {
    session.summary.totalOutputTokens += outputTokens;
  }

  const cachedInputTokens = event.cachedInputTokens !== undefined ? Number(event.cachedInputTokens) : undefined;
  if (!Number.isNaN(cachedInputTokens ?? NaN) && cachedInputTokens !== undefined) {
    session.summary.totalCachedInputTokens += cachedInputTokens;
  }

  const reasoningTokens = event.reasoningTokens !== undefined ? Number(event.reasoningTokens) : undefined;
  const totalTokens = event.totalTokens !== undefined ? Number(event.totalTokens) : undefined;
  const requestBytes = event.requestBytes !== undefined ? Number(event.requestBytes) : undefined;
  if (!Number.isNaN(requestBytes ?? NaN) && requestBytes !== undefined) {
    session.summary.totalBytesIn += requestBytes;
  }

  const responseBytes = event.responseBytes !== undefined ? Number(event.responseBytes) : undefined;
  if (!Number.isNaN(responseBytes ?? NaN) && responseBytes !== undefined) {
    session.summary.totalBytesOut += responseBytes;
  }

  session.summary.eventCounts[event.type] = (session.summary.eventCounts[event.type] || 0) + 1;

  let sections: TraceDataSection[] | undefined;
  if (session.resolvedConfig.logData) {
    // Use pre-built sections if provided, otherwise auto-convert from messageList
    if (event.sections && event.sections.length > 0) {
      sections = ensureUniqueSections(id, event.sections);
    } else {
      const converted = convertMessageListToSections(event.messageList);
      sections = ensureUniqueSections(id, converted);
    }
    // The tool menu composes with (never replaces) the message sections; skip
    // when the caller already supplied a tool_definitions section explicitly.
    if (event.toolDefinitions && event.toolDefinitions.length > 0) {
      const existing = (sections ?? []).some((section) => section.kind === "tool_definitions");
      if (!existing) {
        const menuSection = buildToolDefinitionsSection(event.toolDefinitions);
        // Re-normalize so the menu section gets the standard id
        // (tool_definitions-<eventId>-NN) like every other section kind;
        // already-stamped sections keep their ids/labels.
        if (menuSection) sections = ensureUniqueSections(id, [...(sections ?? []), menuSection]);
      }
    }
    // Same composition rule for the structured-output contract: appended, and
    // skipped when the caller already encoded the section itself.
    if (event.responseFormat) {
      const existing = (sections ?? []).some((section) => section.kind === "response_format");
      if (!existing) {
        const formatSection = buildResponseFormatSection(event.responseFormat, event.responseFormatStrategy);
        if (formatSection) sections = ensureUniqueSections(id, [...(sections ?? []), formatSection]);
      }
    }
  }

  const resolvedModel = event.model ?? inferModelFromMessages(event.messageList);
  const resolvedProvider = event.provider ?? inferProviderFromMessages(event.messageList);

  // For ai_call events, always include token fields (even if undefined/0) for consistency
  const isAiCall = event.type === "ai_call";

  // Span hierarchy: traceId from session, unique spanId per event,
  // parentSpanId from explicit param or current iteration span
  const spanId = generateSpanId();
  const parentSpanId = event.parentSpanId || session.currentIterationSpanId || session.rootSpanId;
  
  const record: TraceEventRecord = {
    sessionId: session.sessionId,
    traceId: session.traceId,
    spanId,
    parentSpanId,
    id,
    type: event.type,
    label: eventLabel,
    sequence,
    timestamp: timestampIso,
    actor: event.actor,
    status,
    durationMs,
    ...(isAiCall ? {
      inputTokens: inputTokens ?? 0,
      outputTokens: outputTokens ?? 0,
      totalTokens: totalTokens ?? 0,
      cachedInputTokens: cachedInputTokens ?? 0,
    } : {
      ...(inputTokens !== undefined && { inputTokens }),
      ...(outputTokens !== undefined && { outputTokens }),
      ...(totalTokens !== undefined && { totalTokens }),
      ...(cachedInputTokens !== undefined && { cachedInputTokens }),
    }),
    // Absent, never zeroed for ai_call the way the four above are: a model
    // that does no reasoning and one whose provider reports nothing are
    // different facts, and a zero would erase the difference.
    ...(reasoningTokens !== undefined && !Number.isNaN(reasoningTokens) ? { reasoningTokens } : {}),
    ...(event.finishReason ? { finishReason: event.finishReason } : {}),
    requestBytes,
    responseBytes,
    model: resolvedModel,
    provider: resolvedProvider,
    toolDetails: session.resolvedConfig.logData ? sanitizeTracePayload(event.toolDetails) : undefined,
    toolExecutionId: event.toolExecutionId,
    retryOf: event.retryOf,
    error: event.error ?? (status === "error" ? { message: "Unknown error" } : undefined) ?? undefined,
    data: sections ? { sections } : undefined,
    debug: event.debug,
  };

  if (status === "error") {
    const errorInfo = event.error ?? { message: "Unknown error" };
    session.errors.push({
      eventId: id,
      message: errorInfo.message,
      stack: errorInfo.stack,
      type: event.type,
      timestamp: timestampIso,
    });
  }

  session.events.push(record);
  const sink = session.resolvedConfig.sink;
  if (sink.type === "custom" && typeof sink.onEvent === "function") {
    try {
      const cloned = JSON.parse(JSON.stringify(record));
      const result = sink.onEvent(cloned);
      if (result && typeof (result as PromiseLike<void>).then === "function") {
        (result as PromiseLike<void>).then(undefined, (error: unknown) => {
          if (typeof console !== "undefined" && typeof console.warn === "function") {
            console.warn("Trace custom sink onEvent rejected", error);
          }
        });
      }
    } catch (err) {
      if (typeof console !== "undefined" && typeof console.warn === "function") {
        console.warn("Trace custom sink onEvent failed", err);
      }
    }
  }

  // In streaming mode, send event immediately to HTTP sinks
  if (session.resolvedConfig.mode === "streaming" && session.sessionStarted) {
    if (sink.type === "cognipeer" || sink.type === "http") {
      const headers = sink.type === "cognipeer"
        ? { Authorization: `Bearer ${sink.apiKey}` }
        : sink.headers;
      
      // Fire and forget - don't block on event sending
      postStreamingEvent(sink.url, headers, session.sessionId, record, session.configMetadata).catch((err) => {
        const errMsg = err instanceof Error ? err.message : String(err);
        if (typeof console !== "undefined" && typeof console.warn === "function") {
          console.warn("[Tracing] Failed to send streaming event:", errMsg);
        }
        session.errors.push({
          eventId: record.id,
          message: errMsg,
          type: "sink",
          timestamp: timestampIso,
        });
      });
    }
  }

  return record;
}

export async function finalizeTraceSession(session: TraceSessionRuntime | undefined, params: {
  agentRuntime?: AgentRuntimeConfig;
  status?: TraceSessionStatus;
  error?: { message?: string; stack?: string } | null;
} = {}): Promise<TraceSessionFile | undefined> {
  if (!session) return undefined;

  const endedAtMs = Date.now();
  const endedAtIso = new Date(endedAtMs).toISOString();
  const durationMs = endedAtMs - session.startedAt;
  const startedAtIso = new Date(session.startedAt).toISOString();

  // Build agent info with safe defaults - single source of truth
  const buildAgentInfo = (runtime: AgentRuntimeConfig | undefined) => {
    if (!runtime) return undefined;
    return {
      name: runtime.name || "unknown-agent",
      version: runtime.version,
      model: getModelName(runtime.model) || "unknown-model",
      provider: getProviderName(runtime.model),
    };
  };

  const agentInfo = buildAgentInfo(params.agentRuntime);

  if (params.error) {
    session.errors.push({
      eventId: "session",
      message: params.error.message || "Unknown error",
      stack: params.error.stack,
      type: "session",
      timestamp: endedAtIso,
    });
  }

  const configSnapshot = buildConfigSnapshot(session);
  const initialStatus: TraceSessionStatus = params.status
    ? params.status
    : session.errors.length > 0
      ? "error"
      : "success";

  const buildPayload = (status: TraceSessionStatus): TraceSessionFile => ({
    sessionId: session.sessionId,
    traceId: session.traceId,
    rootSpanId: session.rootSpanId,
    threadId: session.threadId,
    startedAt: startedAtIso,
    endedAt: endedAtIso,
    durationMs,
    agent: agentInfo || session.agentInfo,
    metadata: session.configMetadata,
    config: configSnapshot,
    summary: session.summary,
    events: session.events,
    status,
    errors: session.errors,
  });

  const payloadForSink = buildPayload(initialStatus);
  let sinkFailed = false;
  const sink = session.resolvedConfig.sink;
  const isStreamingMode = session.resolvedConfig.mode === "streaming";

  if (sink.type === "otlp") {
    // OTLP/HTTP JSON export — convert session to ExportTraceServiceRequest and POST
    try {
      const otlpPayload = traceSessionToOtlp(payloadForSink);
      await postOtlpTraces(sink.endpoint, sink.headers, otlpPayload);
    } catch (err) {
      sinkFailed = true;
      const message = err instanceof Error ? err.message : String(err);
      session.errors.push({
        eventId: "sink",
        message,
        type: "sink",
        timestamp: endedAtIso,
      });
    }
  } else if (sink.type === "cognipeer" || sink.type === "http") {
    try {
      const headers = sink.type === "cognipeer"
        ? { Authorization: `Bearer ${sink.apiKey}` }
        : sink.headers;
      
      if (isStreamingMode && session.sessionStarted) {
        // In streaming mode, send session end instead of full session
        await postStreamingSessionEnd(sink.url, headers, {
          sessionId: session.sessionId,
          endedAt: endedAtIso,
          durationMs,
          status: initialStatus,
          summary: session.summary,
          errors: session.errors,
          metadata: session.configMetadata,
        });
      } else {
        // In batched mode (or if streaming never started), send full session
        await postTraceSession(sink.url, headers, payloadForSink);
      }
    } catch (err) {
      sinkFailed = true;
      const message = err instanceof Error ? err.message : String(err);
      
      session.errors.push({
        eventId: "sink",
        message,
        type: "sink",
        timestamp: endedAtIso,
      });
    }
  }

  const hadNonSinkErrors = session.errors.some((error) => error.type && error.type !== "sink");
  const hadSinkErrors = session.errors.some((error) => error.type === "sink");
  let status: TraceSessionStatus = params.status ?? (hadNonSinkErrors ? "error" : "success");
  if (status === "success" && (sinkFailed || hadSinkErrors)) {
    status = "partial";
  }

  let finalPayload = buildPayload(status);

  if (sink.type === "file" && session.fileSessionDir) {
    try {
      const filePath = path.join(session.fileSessionDir, "trace.session.json");
      await fs.promises.writeFile(filePath, JSON.stringify(finalPayload, null, 2), "utf8");
    } catch (err) {
      sinkFailed = true;
      const message = err instanceof Error ? err.message : String(err);
      session.errors.push({
        eventId: "sink",
        message,
        type: "sink",
        timestamp: endedAtIso,
      });
      if (status === "success") {
        status = "partial";
        finalPayload = buildPayload(status);
      }
    }
  }

  if (sink.type === "custom" && typeof sink.onSession === "function") {
    try {
      const cloned = JSON.parse(JSON.stringify(finalPayload));
      await sink.onSession(cloned);
    } catch (err) {
      sinkFailed = true;
      const message = err instanceof Error ? err.message : String(err);
      session.errors.push({
        eventId: "sink",
        message,
        type: "sink",
        timestamp: endedAtIso,
      });
      if (status === "success") {
        status = "partial";
        finalPayload = buildPayload(status);
      }
    }
  }

  if (!params.status) {
    const finalHadNonSinkErrors = session.errors.some((error) => error.type && error.type !== "sink");
    const hasSinkErrors = session.errors.some((error) => error.type === "sink");
    let computedStatus: TraceSessionStatus = finalHadNonSinkErrors ? "error" : "success";
    if (computedStatus === "success" && hasSinkErrors) {
      computedStatus = "partial";
    }
    if (computedStatus !== status) {
      status = computedStatus;
      finalPayload = buildPayload(status);
    }
  }

  return finalPayload;
}

export type { ResolvedTraceConfig };

export function sanitizeTracePayload(value: any): any {
  try {
    const cache = new WeakSet();
    const json = JSON.stringify(
      value,
      (_key, val) => {
        if (typeof val === "function") return `[Function ${val.name || "anonymous"}]`;
        if (typeof val === "bigint") return val.toString();
        if (val instanceof Error) return { message: val.message, stack: val.stack };
        if (val && typeof val === "object") {
          if (cache.has(val)) return "[Circular]";
          cache.add(val);
        }
        return val;
      },
      2
    );
    return JSON.parse(json);
  } catch {
    try {
      return typeof value === "string" ? value : String(value);
    } catch {
      return "[Unserializable]";
    }
  }
}

export function estimatePayloadBytes(value: any): number {
  try {
    const json = JSON.stringify(value);
    return Buffer.byteLength(json ?? "", "utf8");
  } catch {
    try {
      return Buffer.byteLength(String(value ?? ""), "utf8");
    } catch {
      return 0;
    }
  }
}
