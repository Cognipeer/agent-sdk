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
  TraceContinuation,
  TraceDataSection,
  TraceErrorRecord,
  TraceEventRecord,
  TraceMessagePart,
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
import { describeContentPart, hasMediaPart } from "./content.js";
import { createOtlpExporter } from "./otlp/exporter.js";
import { sessionToOtlp } from "./otlp/convert.js";
import type {
  OtlpConvertOptions,
  OtlpExportOptions,
  OtlpExporter,
  OtlpExportResult,
  OtlpExportTraceServiceRequest,
} from "./otlp/types.js";

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
 * Create an OTLP/HTTP sink that exports traces in OpenTelemetry format (JSON or
 * protobuf; GenAI and `cognipeer.*` attributes side by side by default).
 * @param endpoint OTLP traces endpoint (e.g. "https://console.cognipeer.com/api/client/v1/traces").
 *   Leave it out to configure the exporter from the standard `OTEL_EXPORTER_OTLP_*` environment variables.
 * @param headers Optional headers (e.g. { Authorization: "Bearer ..." })
 * @param options Protocol, compression, timeout, retry, semconv, service name.
 */
export function otlpSink(
  endpoint?: string,
  headers?: Record<string, string>,
  options?: Omit<OtlpExportOptions, "endpoint" | "headers">,
): TraceSinkConfig;
export function otlpSink(options: OtlpExportOptions): TraceSinkConfig;
export function otlpSink(
  first?: string | OtlpExportOptions,
  headers?: Record<string, string>,
  options?: Omit<OtlpExportOptions, "endpoint" | "headers">,
): TraceSinkConfig {
  if (first !== null && typeof first === "object") return { type: "otlp", ...first };
  return { type: "otlp", endpoint: first, headers, ...(options ?? {}) };
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

export function withDefaults(config?: SmartAgentTracingConfig): ResolvedTraceConfig {
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
      // An endpoint that was given must be real; one that was left out comes from
      // the OTEL_EXPORTER_OTLP_* environment (and is an error if that is empty too).
      const given = candidate.endpoint;
      if (given !== undefined && (typeof given !== "string" || given.trim().length === 0)) {
        throw new Error("otlp sink requires a non-empty endpoint");
      }
      let exporter: OtlpExporter;
      try {
        exporter = createOtlpExporter({ ...candidate, endpoint: given?.trim() });
      } catch {
        throw new Error("otlp sink requires a non-empty endpoint");
      }
      const headers = candidate.headers ? { ...candidate.headers } : undefined;
      return headers
        ? { type: "otlp", endpoint: exporter.endpoint, headers, exporter }
        : { type: "otlp", endpoint: exporter.endpoint, exporter };
    }
    default: {
      if (typeof console !== "undefined" && typeof console.warn === "function") {
        console.warn("Unknown tracing sink type. Falling back to file sink.", candidate);
      }
      return resolveSink({ type: "file" });
    }
  }
}

function withoutUserinfo(endpoint: string): string {
  try {
    const url = new URL(endpoint);
    if (!url.username && !url.password) return endpoint;
    url.username = "";
    url.password = "";
    return url.toString();
  } catch {
    return endpoint;
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
      // The endpoint the exporter resolved (it may come from the environment), without credentials.
      return { type: "otlp", endpoint: withoutUserinfo(sink.endpoint) };
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

// ─── OTLP export ────────────────────────────────────────────────────────────
//
// The conversion, encoders and exporter live in ./otlp. `traceSessionToOtlp` is
// the one-shot form: a session file in, an ExportTraceServiceRequest out.

/**
 * Convert a TraceSessionFile into an OTLP ExportTraceServiceRequest (JSON model).
 * The root span is part of it only when the file ends the session: a `paused` or
 * `in_progress` file holds one leg of a longer run and yields its own spans only.
 */
export function traceSessionToOtlp(
  session: TraceSessionFile,
  options: Partial<OtlpConvertOptions> = {},
): OtlpExportTraceServiceRequest {
  return sessionToOtlp(session, {
    semconv: "both",
    terminal: session.status !== "paused" && session.status !== "in_progress",
    ...options,
  });
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
  // All-zero is the invalid id in W3C Trace Context.
  for (;;) {
    const id = crypto.randomBytes(16).toString("hex");
    if (/[1-9a-f]/.test(id)) return id;
  }
}

/** Generate an OTel span ID (16 hex chars / 64-bit). */
export function generateSpanId(): string {
  for (;;) {
    const id = crypto.randomBytes(8).toString("hex");
    if (/[1-9a-f]/.test(id)) return id;
  }
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

/**
 * The structured parts of a message, for a host that wants to RENDER them (a
 * thumbnail for an image) rather than read the text. Only produced when the
 * message carries a non-text part — a plain-text message has nothing to add to
 * its `content` string. Text parts are kept, in place, so the order a person
 * sees is the order the model saw.
 */
export function structuredMessageParts(content: any): TraceMessagePart[] | undefined {
  if (!hasMediaPart(content)) return undefined;
  const cloned = sanitizeTracePayload(content);
  if (!Array.isArray(cloned)) return undefined;
  return cloned.map((part) => (typeof part === "string" ? { type: "text", text: part } : part)) as TraceMessagePart[];
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
    // An attachment is displayed by name / media type. Its JSON is the whole
    // encoded payload, which the structured `parts` of the section already carry
    // for hosts that want to draw it.
    const media = describeContentPart(sanitized);
    if (media) return media;
    // A text part is its text. Without the `type` case a multimodal message
    // showed its prose as `{ "type": "text", "text": … }`.
    if (typeof (sanitized as any).text === "string"
      && (Object.keys(sanitized).length === 1 || (sanitized as any).type === "text")) {
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

/**
 * The message sections `recordTraceEvent` builds from a `messageList`, for a
 * caller that needs them next to sections of its own (an event takes either
 * `sections` or `messageList`, not both).
 */
export function traceSectionsFromMessages(messageList?: any[]): TraceDataSection[] {
  return convertMessageListToSections(messageList) ?? [];
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

    const parts = structuredMessageParts(message?.content);
    sections.push({
      kind: "message",
      label: buildMessageLabel(role, next),
      role,
      content,
      ...(parts ? { parts } : {}),
      metadata: typeof message?.name === "string" ? { name: message.name } : undefined,
    });
  }

  return sections.length > 0 ? sections : undefined;
}

/**
 * Reads a `ctx.__traceContinuation` value back, or undefined when it is not
 * one. It arrives from caller-persisted state, so every field is checked.
 */
export function readTraceContinuation(value: unknown): TraceContinuation | undefined {
  if (!value || typeof value !== "object") return undefined;
  const raw = value as Record<string, unknown>;
  if (raw.v !== 1 || typeof raw.sessionId !== "string" || raw.sessionId.length === 0) return undefined;
  const nextSequence = Number(raw.nextSequence);
  const startedAt = Number(raw.startedAt);
  const part = Number(raw.part);
  if (!Number.isInteger(nextSequence) || nextSequence < 1) return undefined;
  if (!Number.isFinite(startedAt) || !Number.isInteger(part) || part < 1) return undefined;
  const summary = raw.summary && typeof raw.summary === "object"
    ? { ...createEmptySummary(), ...(raw.summary as Partial<TraceSessionSummary>) }
    : createEmptySummary();
  summary.eventCounts = { ...((raw.summary as TraceSessionSummary | undefined)?.eventCounts ?? {}) };
  return {
    v: 1,
    sessionId: raw.sessionId,
    traceId: typeof raw.traceId === "string" ? raw.traceId : undefined,
    rootSpanId: typeof raw.rootSpanId === "string" ? raw.rootSpanId : undefined,
    threadId: typeof raw.threadId === "string" ? raw.threadId : undefined,
    startedAt,
    nextSequence,
    part,
    summary,
    errors: Array.isArray(raw.errors) ? (raw.errors as TraceErrorRecord[]) : [],
  };
}

/** Where `session` leaves off, for the invoke that will continue it. */
export function traceContinuationOf(session: TraceSessionRuntime): TraceContinuation {
  return {
    v: 1,
    sessionId: session.sessionId,
    traceId: session.traceId,
    rootSpanId: session.rootSpanId,
    threadId: session.threadId,
    startedAt: session.startedAt,
    nextSequence: (session.sequenceOffset ?? 0) + session.events.length + 1,
    part: session.part ?? 1,
    summary: JSON.parse(JSON.stringify(session.summary)),
    // Sink failures belong to the part that hit them; carrying them on would
    // mark every later part `partial`.
    errors: session.errors.filter((error) => error.type !== "sink"),
  };
}

/**
 * Opens the trace session for one invoke. With `continuation`, the invoke
 * resumes a run that paused (tool approval, question to the user) or a turn
 * the smart agent split into legs: it records into the same session — same
 * ids, the next sequence numbers, totals carried forward — so one turn reads
 * as one session however many invokes it took.
 */
export function createTraceSession(
  opts: SmartAgentOptions,
  continuation?: TraceContinuation,
  extras?: { exporters?: OtlpExporter[] },
): TraceSessionRuntime | undefined {
  const cfg = withDefaults(opts.tracing);
  if (!cfg.enabled) return undefined;

  // Prefer a caller-supplied session id (e.g. a task-run/chat id) so emitted
  // traces correlate with the caller's own identifiers; fall back to a random id.
  const providedSessionId = opts.tracing?.sessionId?.trim();
  const sessionId = continuation?.sessionId || providedSessionId || generateSessionId();
  const traceId = continuation?.traceId || generateTraceId();
  const rootSpanId = continuation?.rootSpanId || generateSpanId();
  const runtime: TraceSessionRuntime = {
    sessionId,
    traceId,
    rootSpanId,
    threadId: continuation?.threadId ?? opts.tracing?.threadId,
    configAgentName: opts.tracing?.agentName?.trim() || undefined,
    configMetadata: opts.tracing?.metadata && Object.keys(opts.tracing.metadata).length > 0
      ? opts.tracing.metadata
      : undefined,
    startedAt: continuation?.startedAt ?? Date.now(),
    resolvedConfig: cfg,
    events: [],
    summary: continuation ? continuation.summary : createEmptySummary(),
    status: "in_progress",
    errors: continuation ? [...continuation.errors] : [],
    // A continued session was announced by its first part; announcing it
    // again would reset a streaming receiver's copy.
    sessionStarted: Boolean(continuation),
    sequenceOffset: continuation ? continuation.nextSequence - 1 : 0,
    part: continuation ? continuation.part + 1 : 1,
    ...(extras?.exporters?.length ? { exporters: [...extras.exporters] } : {}),
    exportReports: [],
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
    /** Pre-allocated span ID, for an event whose children are recorded before it is. */
    spanId?: string;
    durationMs?: number;
    /** False for a span that wraps events already counted, so the totals do not take the time twice. */
    countDuration?: boolean;
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
    /** Identity sections kept even when logData is off; the caller vouches they carry no payload. */
    alwaysSections?: TraceDataSection[];
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


  const sequence = (session.sequenceOffset ?? 0) + session.events.length + 1;
  const id = generateEventId(sequence);
  const timestampIso = event.timestamp || new Date().toISOString();
  const status = event.status ?? "success";
  const baseLabel = event.label?.trim().length ? event.label.trim() : defaultEventLabel(event.type);
  const eventLabel = `${baseLabel} #${sequence}`;

  const durationMs = event.durationMs !== undefined ? Number(event.durationMs) : undefined;
  // A sub-agent's own events happen inside the delegating tool_call, which
  // already holds that wall time; so does a span that says it wraps counted events.
  if (!Number.isNaN(durationMs ?? NaN) && durationMs !== undefined && event.countDuration !== false && !isSubagentTraceScope(session)) {
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

  if (event.alwaysSections?.length) {
    sections = ensureUniqueSections(id, [...event.alwaysSections, ...(sections ?? [])]);
  }

  const resolvedModel = event.model ?? inferModelFromMessages(event.messageList);
  const resolvedProvider = event.provider ?? inferProviderFromMessages(event.messageList);

  // For ai_call events, always include token fields (even if undefined/0) for consistency
  const isAiCall = event.type === "ai_call";

  // Span hierarchy: traceId from session, unique spanId per event,
  // parentSpanId from explicit param or current iteration span
  const spanId = event.spanId || generateSpanId();
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

/** An event held for the next trace session: the same input `recordTraceEvent` takes. */
export type DeferredTraceEvent = Parameters<typeof recordTraceEvent>[1];

/** Where events wait on `ctx` while no trace session is open to take them. */
export const DEFERRED_TRACE_EVENTS_KEY = "__deferredTraceEvents";

/**
 * True when `session` still accepts events. The smart agent runs a turn as
 * several invokes ("legs") and does its own work — context summarization — in
 * between them; at that point the previous leg has already handed its session
 * to the sink, and the next leg has not opened one yet.
 */
export function isTraceSessionOpen(session: TraceSessionRuntime | undefined): session is TraceSessionRuntime {
  return Boolean(session) && !session!.closed;
}

const SUBAGENT_TRACE_SCOPE = Symbol("subagentTraceScope");

export type SubagentTraceScopeInfo = {
  agentSpanId: string;
  name: string;
  spawnId?: string;
  mode?: string;
  /** False when no human can answer a pause in this run (parallel fan-out, asTool). */
  hitl?: boolean;
  /** Iterations the sub-agent has opened so far; numbers its own "Iteration n". */
  iterations: number;
};

/**
 * A view of `parent` for one sub-agent run. Everything goes through to the
 * parent — events, sequence numbers, totals, errors, the sink — so the child
 * records into the parent's session. Only two things are the scope's own:
 * `rootSpanId` is the child's agent span (where its iterations and any event
 * without a better parent land), and `currentIterationSpanId` is a private slot.
 * A shared slot would let the child's iteration become the parent's current one
 * after the child returns, and let parallel children overwrite each other's.
 */
export function createSubagentTraceScope(
  parent: TraceSessionRuntime,
  info: { agentSpanId: string; name: string; spawnId?: string; mode?: string; hitl?: boolean; iterations?: number },
): TraceSessionRuntime {
  const scope: SubagentTraceScopeInfo = { ...info, iterations: info.iterations ?? 0 };
  let currentIterationSpanId: string | undefined;
  return new Proxy(parent, {
    get(target, prop) {
      if (prop === SUBAGENT_TRACE_SCOPE) return scope;
      if (prop === "rootSpanId") return scope.agentSpanId;
      if (prop === "currentIterationSpanId") return currentIterationSpanId;
      return Reflect.get(target, prop);
    },
    set(target, prop, value) {
      if (prop === "currentIterationSpanId") {
        currentIterationSpanId = value;
        return true;
      }
      return Reflect.set(target, prop, value);
    },
  });
}

/** The scope info when `session` is a sub-agent's view of its parent's session. */
export function subagentTraceScopeOf(session: TraceSessionRuntime | undefined): SubagentTraceScopeInfo | undefined {
  if (!session) return undefined;
  return (session as any)[SUBAGENT_TRACE_SCOPE] as SubagentTraceScopeInfo | undefined;
}

/** False when `session` is a run nobody can pause for, so a request recorded there could never be decided. */
export function canPauseForHuman(session: TraceSessionRuntime | undefined): boolean {
  return subagentTraceScopeOf(session)?.hitl !== false;
}

export function isSubagentTraceScope(session: TraceSessionRuntime | undefined): boolean {
  return subagentTraceScopeOf(session) !== undefined;
}

/**
 * Records the span that groups one sub-agent run under the tool call (or the
 * iteration) that started it. No token fields: the child's own `ai_call`
 * events already carry them into the session totals, and repeating them here
 * would count the run twice.
 */
export function recordSubagentSpan(
  session: TraceSessionRuntime,
  span: {
    spanId: string;
    parentSpanId?: string;
    name: string;
    status: TraceEventRecord["status"];
    durationMs: number;
    error?: string;
    /** Identity and outcome of the run, always recorded. */
    info: Record<string, any>;
    /** The brief the sub-agent was given and what it answered; recorded under `logData`. */
    task?: string;
    result?: string;
  },
): void {
  const sections: TraceDataSection[] = [];
  if (session.resolvedConfig.logData) {
    if (span.task !== undefined) sections.push({ kind: "message", label: "Task", role: "user", content: span.task });
    if (span.result) sections.push({ kind: "message", label: "Result", role: "assistant", content: span.result });
  }
  recordTraceEvent(session, {
    type: "span",
    spanId: span.spanId,
    parentSpanId: span.parentSpanId,
    label: `Sub-agent ${span.name}`,
    actor: { scope: "agent", name: span.name, role: "subagent" },
    status: span.status,
    durationMs: span.durationMs,
    // The child's own calls and the delegating tool_call already hold this time.
    countDuration: false,
    ...(span.error ? { error: { message: span.error } } : {}),
    // The Console reads which sub-agent ran from here, so it survives logData off.
    alwaysSections: [{ kind: "metadata", label: "Sub-agent", data: sanitizeTracePayload(span.info) }],
    sections,
  });
}

/**
 * The records a reader should draw. A sub-agent that pauses for a human (an
 * approval or a question) and later resumes is ONE run recorded in several
 * segments, and records are append-only: each pause records the run's agent span
 * `pending`, and the segment that ends the run records it again under the SAME
 * `spanId`, finished, with `durationMs` covering the run from its first segment
 * (so the span is drawn over its children from every segment, the wait included). The rule for a
 * reader: for each `spanId` the record with the highest `sequence` wins, and an
 * earlier record of that id is dropped only when it is `pending`. Nothing else is
 * ever dropped, so a repeated id on records that are not `pending` comes back
 * untouched. Order is preserved.
 *
 * The session summary is not rewritten: `eventCounts` keeps counting every record
 * that was written, which is what the file holds.
 */
export function foldSupersededSpans<T extends { spanId?: string; sequence?: number; status?: string }>(
  events: readonly T[],
): T[] {
  const rank = (event: T, index: number) =>
    typeof event.sequence === "number" && Number.isFinite(event.sequence) ? event.sequence : index;
  const winner = new Map<string, number>();
  for (let i = 0; i < events.length; i++) {
    const id = events[i].spanId;
    if (!id) continue;
    const current = winner.get(id);
    if (current === undefined || rank(events[i], i) >= rank(events[current], current)) winner.set(id, i);
  }
  return events.filter((event, i) => !(event.spanId && event.status === "pending" && winner.get(event.spanId) !== i));
}

/**
 * Records `event` into the open session on `ctx`, or — when there is none —
 * returns a copy of `ctx` holding it for the next invoke to record. Returns
 * undefined when nothing on ctx changed (recorded, or tracing is off).
 */
export function recordOrDeferTraceEvent(
  ctx: Record<string, any> | undefined,
  event: DeferredTraceEvent,
  options: { tracingEnabled: boolean },
): Record<string, any> | undefined {
  const session = ctx?.__traceSession as TraceSessionRuntime | undefined;
  if (isTraceSessionOpen(session)) {
    recordTraceEvent(session, event);
    return undefined;
  }
  // Tracing off: no invoke will ever open a session to take the event.
  if (!options.tracingEnabled) return undefined;
  const held = Array.isArray(ctx?.[DEFERRED_TRACE_EVENTS_KEY]) ? ctx![DEFERRED_TRACE_EVENTS_KEY] : [];
  return {
    ...(ctx || {}),
    [DEFERRED_TRACE_EVENTS_KEY]: [...held, { ...event, timestamp: event.timestamp ?? new Date().toISOString() }],
  };
}

/**
 * Records events another invoke held for this one (see `recordOrDeferTraceEvent`),
 * in the order they happened. They keep their own timestamps; they get this
 * session's next sequence numbers, which is where they belong — after what the
 * previous leg recorded, before anything this one does.
 */
export function replayDeferredTraceEvents(session: TraceSessionRuntime | undefined, deferred: unknown): void {
  if (!session || !Array.isArray(deferred)) return;
  for (const event of deferred) {
    if (event && typeof event === "object" && typeof (event as DeferredTraceEvent).type === "string") {
      recordTraceEvent(session, event as DeferredTraceEvent);
    }
  }
}

export async function finalizeTraceSession(session: TraceSessionRuntime | undefined, params: {
  agentRuntime?: AgentRuntimeConfig;
  status?: TraceSessionStatus;
  error?: { message?: string; stack?: string; name?: string } | null;
  /** The run was cancelled by the caller: the exported root reports `partial`. */
  cancelled?: boolean;
  /**
   * Hand the session to the OTLP exporters only (the `otlp` sink and plugin
   * exporters), not to the file, cognipeer, http or custom sinks. Used to close
   * a trace whose last leg paused and will never resume.
   */
  exportOnly?: boolean;
} = {}): Promise<TraceSessionFile | undefined> {
  if (!session) return undefined;
  session.closed = true;

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
      ...(params.error.name ? { errorName: params.error.name } : {}),
      timestamp: endedAtIso,
    } as TraceErrorRecord);
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
    ...((session.part ?? 1) > 1
      ? { continuation: { part: session.part!, firstSequence: (session.sequenceOffset ?? 0) + 1 } }
      : {}),
  });

  const payloadForSink = buildPayload(initialStatus);
  let sinkFailed = false;
  const sink = session.resolvedConfig.sink;
  const isStreamingMode = session.resolvedConfig.mode === "streaming";

  // OTLP: the `otlp` sink and any exporter a plugin contributed share one path.
  // A paused or mid-turn leg exports its own spans; the root goes out with the
  // leg that ends the session. A failing SINK fails the session's delivery as
  // before; a failing plugin exporter is only reported (observability fails open).
  const terminal = initialStatus !== "paused" && initialStatus !== "in_progress";
  const exportTargets: Array<{ exporter: OtlpExporter; isSink: boolean }> = [];
  if (sink.type === "otlp") exportTargets.push({ exporter: sink.exporter, isSink: true });
  // A sub-agent's scoped view is never finalized; the guard keeps a stray call from exporting the parent twice.
  if (!isSubagentTraceScope(session)) {
    for (const exporter of session.exporters ?? []) exportTargets.push({ exporter, isSink: false });
  }
  if (exportTargets.length > 0) {
    const results = await Promise.all(
      exportTargets.map(async ({ exporter }): Promise<OtlpExportResult> => {
        try {
          return await exporter.exportSession(payloadForSink, {
            terminal,
            cancelled: params.cancelled,
            parent: session.parent,
          });
        } catch (err) {
          // Exporters do not throw; a third-party one might.
          return { ok: false, attempts: 0, spans: 0, bytes: 0, error: err instanceof Error ? err.message : String(err) };
        }
      }),
    );
    results.forEach((result, index) => {
      const { exporter, isSink } = exportTargets[index];
      (session.exportReports ??= []).push({ exporter: exporter.name, endpoint: exporter.endpoint, sink: isSink, terminal, result });
      if (result.ok) return;
      const message = result.error ?? "OTLP export failed";
      if (isSink) {
        sinkFailed = true;
        session.errors.push({ eventId: "sink", message, type: "sink", timestamp: endedAtIso });
        if (typeof console !== "undefined" && typeof console.error === "function") {
          console.error("[Tracing] OTLP export failed:", message);
        }
      } else if (typeof console !== "undefined" && typeof console.warn === "function") {
        console.warn(`[Tracing] OTLP exporter "${exporter.name}" failed:`, message);
      }
    });
  }

  if (params.exportOnly) {
    return buildPayload(payloadForSink.status);
  }

  if (sink.type === "cognipeer" || sink.type === "http") {
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
      // A continued session's file already holds the earlier parts' events.
      let filePayload: TraceSessionFile = finalPayload;
      if (finalPayload.continuation) {
        try {
          const previous = JSON.parse(await fs.promises.readFile(filePath, "utf8")) as TraceSessionFile;
          const earlier = (previous.events ?? []).filter((event) => event.sequence < finalPayload.continuation!.firstSequence);
          filePayload = { ...finalPayload, events: [...earlier, ...finalPayload.events] };
          delete filePayload.continuation;
        } catch {
          // No earlier file (removed, or another machine): write this part alone.
        }
      }
      await fs.promises.writeFile(filePath, JSON.stringify(filePayload, null, 2), "utf8");
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

/**
 * Closes the trace of a run whose last leg paused (or bounced for summarization)
 * and will not be resumed: the root span, held back until a leg ends the
 * session, is exported now. Only the OTLP exporters are called (the `otlp` sink
 * from `tracing`, and `exporters`); the file, cognipeer, http and custom sinks
 * already have everything this session recorded.
 *
 * `events` are trace events that were held for a next leg that never came
 * (see `recordOrDeferTraceEvent`); they are recorded before the close.
 * Returns undefined when `continuation` is not one, or nothing would export it.
 */
export async function closeTraceContinuation(
  continuation: unknown,
  params: {
    tracing?: SmartAgentTracingConfig;
    exporters?: OtlpExporter[];
    /** How the run ended. Default `partial`: it stopped before an answer. */
    status?: "success" | "partial" | "error";
    error?: { message?: string; stack?: string; name?: string } | null;
    agentRuntime?: AgentRuntimeConfig;
    events?: unknown;
  } = {},
): Promise<TraceSessionFile | undefined> {
  const parsed = readTraceContinuation(continuation);
  if (!parsed) return undefined;
  const tracing = { ...(params.tracing ?? {}), enabled: true } as SmartAgentTracingConfig;
  const hasOtlpSink = withDefaults(tracing).sink.type === "otlp";
  if (!hasOtlpSink && !(params.exporters?.length)) return undefined;

  const session = createTraceSession({ tracing } as SmartAgentOptions, parsed, { exporters: params.exporters });
  if (!session) return undefined;
  replayDeferredTraceEvents(session, params.events);
  const status = params.status ?? "partial";
  return finalizeTraceSession(session, {
    agentRuntime: params.agentRuntime,
    status,
    error: status === "error" ? params.error ?? { message: "The run ended in an error before it could be resumed." } : null,
    exportOnly: true,
  });
}

export type { ResolvedTraceConfig };

export function sanitizeTracePayload(value: any): any {
  // JSON.stringify(undefined) returns the real JS `undefined`, not a JSON
  // string — JSON.parse(undefined) then coerces its argument to the string
  // "undefined" and throws a SyntaxError, which used to fall into the catch
  // below and come back out as the *string* "undefined" (String(undefined)).
  // That string then flows into the wire payload looking like real content
  // (and downstream consumers that spread it as a record split it into
  // single-character indexed keys). Absent must stay absent.
  if (value === undefined) return undefined;
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
