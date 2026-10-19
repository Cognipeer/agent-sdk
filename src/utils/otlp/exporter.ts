/**
 * The OTLP/HTTP exporter: converts a trace session file, encodes it (JSON or
 * protobuf), optionally gzips it and POSTs it, with bounded retries.
 *
 * It never throws: a failure comes back as `{ ok: false, error }` and the caller
 * decides what that means (a sink marks the session partial, a plugin warns).
 * Retries follow the OTLP specification: 429, 502, 503, 504 and transport errors
 * or timeouts are retried with full-jitter exponential back-off (a server's
 * Retry-After wins); every other status is final, 404 and 500 included.
 *
 * `globalThis.fetch` is read when an export runs, not when the module loads or
 * the exporter is created, and the response is treated as the minimum a fetch
 * mock may offer (`ok`, `status`, `statusText`, `text`, `headers.get`).
 */

import { Buffer } from "node:buffer";
import { gzip } from "node:zlib";
import { promisify } from "node:util";
import type { TraceSessionFile } from "../../types.js";
import { countSpans, sessionToOtlp } from "./convert.js";
import { resolveContentOptions } from "./content.js";
import { currentEnv, resolveOtlpEnv } from "./env.js";
import { decodeExportTraceServiceResponse, encodeExportTraceServiceRequest } from "./protobuf.js";
import type {
  OtlpConvertOptions,
  OtlpExportOptions,
  OtlpExporter,
  OtlpExportResult,
  OtlpProtocol,
  OtlpRetryOptions,
} from "./types.js";

const gzipAsync = promisify(gzip);

const DEFAULT_TIMEOUT_MS = 10_000;
const RETRY_DEFAULTS: Required<OtlpRetryOptions> = {
  maxAttempts: 3,
  initialDelayMs: 250,
  maxDelayMs: 4_000,
  maxElapsedMs: 25_000,
};
const RETRYABLE_STATUS = new Set([429, 502, 503, 504]);

function retryPolicy(retry: OtlpExportOptions["retry"]): Required<OtlpRetryOptions> {
  if (retry === false) return { ...RETRY_DEFAULTS, maxAttempts: 1 };
  const merged = { ...RETRY_DEFAULTS, ...(retry ?? {}) };
  return { ...merged, maxAttempts: Math.max(1, Math.floor(merged.maxAttempts)) };
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Seconds or an HTTP date, as milliseconds from now; undefined when absent or unreadable. */
function retryAfterMs(response: any): number | undefined {
  let raw: unknown;
  try {
    raw = response?.headers?.get?.("retry-after");
  } catch {
    return undefined;
  }
  if (typeof raw !== "string" || raw.trim() === "") return undefined;
  const seconds = Number(raw);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const date = Date.parse(raw);
  return Number.isNaN(date) ? undefined : Math.max(0, date - Date.now());
}

type Attempt =
  | { kind: "ok"; status: number; response: any }
  | { kind: "http"; status: number; message: string; retryable: boolean; retryAfter?: number }
  | { kind: "network"; message: string };

async function attemptOnce(
  fetchFn: (input: string, init?: any) => Promise<any>,
  url: string,
  init: { method: string; headers: Record<string, string>; body: string | Uint8Array },
  timeoutMs: number,
): Promise<Attempt> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new Error(`timed out after ${timeoutMs} ms`));
    }, timeoutMs);
  });
  try {
    const pending = fetchFn(url, { ...init, signal: controller.signal });
    // The race below can be lost to the timeout; the abort then rejects `pending`.
    Promise.resolve(pending).catch(() => undefined);
    const response = await Promise.race([pending, timeout]);
    const status = typeof response?.status === "number" ? response.status : response?.ok ? 200 : 0;
    const ok = typeof response?.ok === "boolean" ? response.ok : status >= 200 && status < 300;
    if (ok) return { kind: "ok", status, response };

    let body = "";
    try {
      if (typeof response?.text === "function") body = String(await response.text());
    } catch {
      // The status line is enough.
    }
    const statusText = typeof response?.statusText === "string" && response.statusText ? ` ${response.statusText}` : "";
    return {
      kind: "http",
      status,
      message: `HTTP ${status}${statusText}${body ? ` - ${body.slice(0, 200)}` : ""}`,
      retryable: RETRYABLE_STATUS.has(status),
      retryAfter: retryAfterMs(response),
    };
  } catch (err) {
    return { kind: "network", message: err instanceof Error ? err.message : String(err) };
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/** `partial_success` from a successful response, or undefined. A body that cannot be read is not a failure. */
async function readPartialSuccess(
  response: any,
  protocol: OtlpProtocol,
): Promise<OtlpExportResult["partialSuccess"] | undefined> {
  try {
    if (protocol === "http/protobuf") {
      if (typeof response?.arrayBuffer !== "function") return undefined;
      const bytes = new Uint8Array(await response.arrayBuffer());
      if (bytes.length === 0) return undefined;
      const decoded = decodeExportTraceServiceResponse(bytes);
      return decoded && (decoded.rejectedSpans > 0 || decoded.message) ? decoded : undefined;
    }
    if (typeof response?.text !== "function") return undefined;
    const text = String(await response.text());
    if (!text.trim()) return undefined;
    const partial = JSON.parse(text)?.partialSuccess;
    if (!partial || typeof partial !== "object") return undefined;
    const rejectedSpans = Number(partial.rejectedSpans ?? 0);
    const message = typeof partial.errorMessage === "string" && partial.errorMessage ? partial.errorMessage : undefined;
    if (!(rejectedSpans > 0) && !message) return undefined;
    return { rejectedSpans: Number.isFinite(rejectedSpans) ? rejectedSpans : 0, ...(message ? { message } : {}) };
  } catch {
    return undefined;
  }
}

export function createOtlpExporter(options: OtlpExportOptions & { name?: string } = {}): OtlpExporter {
  const env = resolveOtlpEnv(currentEnv(), options);
  if (!env.endpoint && !env.disabled) {
    throw new Error(
      "[agent-sdk] OTLP export needs an `endpoint` (or OTEL_EXPORTER_OTLP_ENDPOINT / OTEL_EXPORTER_OTLP_TRACES_ENDPOINT in the environment).",
    );
  }

  const semconv = options.semconv ?? "both";
  const protocol = env.protocol;
  const compression = env.compression;
  const timeoutMs = env.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const policy = retryPolicy(options.retry);
  const serviceName = options.serviceName ?? env.serviceName;
  const resourceAttributes = { ...env.resourceAttributes, ...(options.resourceAttributes ?? {}) };
  const endpoint = env.endpoint ?? "";
  const content = resolveContentOptions(options.content);

  return {
    name: options.name ?? "otlp",
    endpoint,
    semconv,
    protocol,
    wantsContent: content.enabled,
    contentOptions: content,

    async exportSession(file: TraceSessionFile, run): Promise<OtlpExportResult> {
      try {
        if (env.disabled) {
          return { ok: true, skipped: true, reason: "disabled by the environment (OTEL_SDK_DISABLED / OTEL_TRACES_EXPORTER)", attempts: 0, spans: 0, bytes: 0 };
        }
        const convertOptions: OtlpConvertOptions = {
          semconv,
          serviceName,
          resourceAttributes,
          terminal: run.terminal,
          cancelled: run.cancelled,
          parent: run.parent,
          content,
        };
        const request = sessionToOtlp(file, convertOptions);
        const spans = countSpans(request);
        // Nothing to say (every span withheld, or an empty close): a collector
        // would answer such a request with an error the next run pays for.
        if (spans === 0) return { ok: true, skipped: true, reason: "no spans to export", attempts: 0, spans: 0, bytes: 0 };

        const fetchFn = (options.fetch ?? (typeof globalThis.fetch === "function" ? globalThis.fetch.bind(globalThis) : undefined)) as
          | ((input: string, init?: any) => Promise<any>)
          | undefined;
        if (!fetchFn) return { ok: false, attempts: 0, spans, bytes: 0, error: "OTLP export requires fetch to be available in this runtime." };

        let body: string | Uint8Array =
          protocol === "http/protobuf" ? encodeExportTraceServiceRequest(request) : JSON.stringify(request);
        const headers: Record<string, string> = {
          "content-type": protocol === "http/protobuf" ? "application/x-protobuf" : "application/json",
        };
        if (compression === "gzip") {
          body = await gzipAsync(typeof body === "string" ? Buffer.from(body, "utf8") : body);
          headers["content-encoding"] = "gzip";
        }
        Object.assign(headers, env.headers);
        const bytes = typeof body === "string" ? Buffer.byteLength(body, "utf8") : body.length;

        const started = Date.now();
        let attempts = 0;
        let lastError = "export failed";
        let lastStatus: number | undefined;
        for (;;) {
          attempts += 1;
          const remaining = policy.maxElapsedMs - (Date.now() - started);
          const outcome = await attemptOnce(
            fetchFn,
            env.endpoint!,
            { method: "POST", headers, body },
            Math.max(1, Math.min(timeoutMs, remaining)),
          );
          if (outcome.kind === "ok") {
            const partialSuccess = await readPartialSuccess(outcome.response, protocol);
            return { ok: true, attempts, status: outcome.status, spans, bytes, ...(partialSuccess ? { partialSuccess } : {}) };
          }
          lastError = outcome.message;
          lastStatus = outcome.kind === "http" ? outcome.status : undefined;
          const retryable = outcome.kind === "network" || outcome.retryable;
          if (!retryable || attempts >= policy.maxAttempts) break;

          const ceiling = Math.min(policy.maxDelayMs, policy.initialDelayMs * 2 ** (attempts - 1));
          const wait =
            outcome.kind === "http" && outcome.retryAfter !== undefined
              ? Math.min(outcome.retryAfter, policy.maxDelayMs)
              : Math.random() * ceiling;
          if (Date.now() - started + wait >= policy.maxElapsedMs) break;
          await sleep(wait);
        }
        return { ok: false, attempts, ...(lastStatus !== undefined ? { status: lastStatus } : {}), spans, bytes, error: lastError };
      } catch (err) {
        return { ok: false, attempts: 0, spans: 0, bytes: 0, error: err instanceof Error ? err.message : String(err) };
      }
    },
  };
}
