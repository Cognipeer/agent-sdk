/**
 * Types of the OTLP trace pipeline: the OTLP/JSON wire model the converter
 * produces, and the public option / result types of the exporter.
 */

// ─── OTLP/JSON model ────────────────────────────────────────────────────────

export type OtlpAnyValue = {
  stringValue?: string;
  boolValue?: boolean;
  /** int64 travels as a decimal string in OTLP/JSON. */
  intValue?: string;
  doubleValue?: number;
  arrayValue?: { values: OtlpAnyValue[] };
  kvlistValue?: { values: OtlpKeyValue[] };
  /** Base64 in OTLP/JSON. */
  bytesValue?: string;
};

export type OtlpKeyValue = { key: string; value: OtlpAnyValue };

export type OtlpSpanEvent = {
  timeUnixNano: string;
  name: string;
  attributes: OtlpKeyValue[];
};

export type OtlpSpan = {
  traceId: string;
  spanId: string;
  /** Empty string for a root. */
  parentSpanId: string;
  traceState?: string;
  /** W3C trace flags plus the OTLP "has/is remote parent" bits (0x100 / 0x200). */
  flags: number;
  name: string;
  /** 1 INTERNAL, 2 SERVER, 3 CLIENT. */
  kind: number;
  startTimeUnixNano: string;
  endTimeUnixNano: string;
  attributes: OtlpKeyValue[];
  events?: OtlpSpanEvent[];
  status: { code: number; message?: string };
};

export type OtlpExportTraceServiceRequest = {
  resourceSpans: Array<{
    resource: { attributes: OtlpKeyValue[] };
    scopeSpans: Array<{
      scope: { name: string; version: string };
      spans: OtlpSpan[];
    }>;
    schemaUrl?: string;
  }>;
};

// ─── Options ────────────────────────────────────────────────────────────────

/**
 * Which attribute vocabulary the spans carry. `cognipeer` is the SDK's own
 * `cognipeer.*` keys, `gen_ai` the OpenTelemetry GenAI semantic conventions,
 * `both` (the default) emits the two side by side.
 */
export type OtlpSemconv = "cognipeer" | "gen_ai" | "both";

export type OtlpProtocol = "http/json" | "http/protobuf";

export type OtlpRetryOptions = {
  /** Attempts in total, the first included. Default 3. */
  maxAttempts?: number;
  /** First back-off ceiling. Default 250 ms. */
  initialDelayMs?: number;
  /** Back-off ceiling, also the cap on a server's Retry-After. Default 4000 ms. */
  maxDelayMs?: number;
  /** Budget for the whole export, attempts and waits included. Default 25000 ms. */
  maxElapsedMs?: number;
};

export type OtlpExportOptions = {
  /**
   * Full traces endpoint (e.g. `https://collector:4318/v1/traces`). Leave it out
   * to configure the exporter from the standard `OTEL_EXPORTER_OTLP_*`
   * environment variables.
   */
  endpoint?: string;
  headers?: Record<string, string>;
  /** Default `http/json` with an explicit endpoint, `http/protobuf` in env-driven mode. */
  protocol?: OtlpProtocol;
  /** Default `none`. */
  compression?: "gzip" | "none";
  /** Per attempt. Default 10000 ms. */
  timeoutMs?: number;
  /** `false` sends once. */
  retry?: false | OtlpRetryOptions;
  /** Default `both`. */
  semconv?: OtlpSemconv;
  /** `service.name` on the resource. */
  serviceName?: string;
  resourceAttributes?: Record<string, string>;
  /** Injectable for tests; defaults to `globalThis.fetch`, read at export time. */
  fetch?: (input: string, init?: any) => Promise<any>;
};

/** A W3C parent of the root span: where the trace came from. */
export type TraceParent = {
  traceId: string;
  spanId: string;
  sampled: boolean;
  /** True when the parent lives in another process (the usual case for a traceparent). */
  remote: boolean;
  traceState?: string;
};

export type OtlpConvertOptions = {
  semconv: OtlpSemconv;
  serviceName?: string;
  resourceAttributes?: Record<string, string>;
  /** True when this file ends the session: only then is the root span exported. */
  terminal: boolean;
  /** The run was cancelled: the root reports `partial`. */
  cancelled?: boolean;
  parent?: Pick<TraceParent, "spanId" | "remote" | "traceState"> & { sampled?: boolean };
};

export type OtlpExportResult = {
  ok: boolean;
  attempts: number;
  status?: number;
  /** Spans in the request (0 when the export was skipped). */
  spans: number;
  /** Size of the body that was sent. */
  bytes: number;
  error?: string;
  /** True when nothing was sent: no spans, or exporting is disabled by the environment. */
  skipped?: boolean;
  reason?: string;
  partialSuccess?: { rejectedSpans: number; message?: string };
};

export type OtlpExporter = {
  name: string;
  endpoint: string;
  semconv: OtlpSemconv;
  protocol: OtlpProtocol;
  /** True when this exporter asks for prompt/response content to be captured. */
  wantsContent: boolean;
  exportSession(
    file: import("../../types.js").TraceSessionFile,
    options: { terminal: boolean; cancelled?: boolean; parent?: OtlpConvertOptions["parent"] },
  ): Promise<OtlpExportResult>;
};

/** What one exporter did when a session was finalized. */
export type OtlpExportReport = {
  exporter: string;
  endpoint: string;
  /** True for the exporter derived from `tracing.sink`, false for a plugin's. */
  sink: boolean;
  terminal: boolean;
  result: OtlpExportResult;
};
