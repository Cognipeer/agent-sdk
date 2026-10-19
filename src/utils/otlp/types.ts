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
  /**
   * Prompt, response, tool-definition and tool argument/result content on the
   * spans (`gen_ai.input.messages` and friends). OFF by default and independent
   * of `tracing.logData`. `true` turns it on with the defaults.
   */
  content?: boolean | OtlpContentOptions;
  /** Injectable for tests; defaults to `globalThis.fetch`, read at export time. */
  fetch?: (input: string, init?: any) => Promise<any>;
};

/** What a span's content attributes are made of; `include` picks from this list. */
export type OtlpContentField = "system" | "input" | "output" | "tools" | "toolArgs" | "toolResults" | "sections";

export type OtlpContentRedactInfo = {
  field: OtlpContentField;
  eventType: string;
  spanId?: string;
  toolName?: string;
  model?: string;
};

export type OtlpContentOptions = {
  /** Default false. */
  enabled?: boolean;
  /** Default: every field. */
  include?: OtlpContentField[];
  /** Longer text is cut and marked `...[truncated N chars]`. Default 4096. */
  maxStringChars?: number;
  /** A message list keeps its most recent messages. Default 32. */
  maxMessages?: number;
  /**
   * An attribute whose JSON exceeds this is made smaller by dropping whole
   * messages (oldest first) or, failing that, replaced by `{"truncated":true}`.
   * JSON is never cut in the middle. Default 32768.
   */
  maxAttributeBytes?: number;
  /**
   * Runs on each captured field BEFORE the caps apply. Return the (possibly
   * masked) value, or `null` / `undefined` to leave the field out. A throw
   * leaves it out too (fail closed). It gets a private copy: mutating it does
   * not change the trace the file and other sinks hold.
   */
  redact?: (value: unknown, info: OtlpContentRedactInfo) => unknown;
  /** `json` (default): a JSON string. `structured`: OTLP AnyValue arrays and maps. */
  encoding?: "json" | "structured";
};

/** Content options with every default filled in. */
export type ResolvedOtlpContent = Required<Omit<OtlpContentOptions, "redact">> & {
  redact?: OtlpContentOptions["redact"];
};

/** A W3C parent of the root span: where the trace came from. */
export type TraceParent = {
  traceId: string;
  spanId: string;
  /** The incoming trace-flags byte, carried unchanged (bit 0 is `sampled`). */
  flags: number;
  sampled: boolean;
  /** True when the parent lives in another process (the usual case for a traceparent). */
  remote: boolean;
  traceState?: string;
};

/** A `traceparent` header value, or the pair of W3C headers. */
export type TraceParentInput = string | { traceparent: string; tracestate?: string };

export type OtlpConvertOptions = {
  semconv: OtlpSemconv;
  serviceName?: string;
  resourceAttributes?: Record<string, string>;
  /** True when this file ends the session: only then is the root span exported. */
  terminal: boolean;
  /** The run was cancelled: the root reports `partial`. */
  cancelled?: boolean;
  parent?: Pick<TraceParent, "spanId" | "remote" | "traceState"> & { flags?: number; sampled?: boolean };
  /** Content capture; absent or disabled means none leaves the process. */
  content?: ResolvedOtlpContent;
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
  /** The content options behind `wantsContent`, defaults filled in. */
  contentOptions?: ResolvedOtlpContent;
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
