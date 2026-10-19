/**
 * Standard `OTEL_*` environment configuration for the OTLP exporter.
 *
 * Two modes, decided by whether the caller gave an endpoint:
 *
 * - env-driven (no explicit endpoint): the endpoint, headers, protocol, timeout
 *   and compression come from the environment, the way every OpenTelemetry SDK
 *   behaves. The default protocol is `http/protobuf`, as the OpenTelemetry
 *   specification says.
 * - explicit endpoint: the environment is NOT consulted for anything that is
 *   bound to a destination. A collector's `Authorization` header must not follow
 *   a run to a different endpoint, and a protocol picked for the operator's
 *   collector must not be forced on one that does not speak it (the Console's
 *   ingest route reads JSON only). The default protocol is `http/json`.
 *   `OTEL_SERVICE_NAME` and `OTEL_RESOURCE_ATTRIBUTES` describe the process, not
 *   the destination, so they apply in both modes.
 *
 * Read when an exporter is created, never at import time.
 */

import type { OtlpExportOptions, OtlpProtocol } from "./types.js";

export type ResolvedOtlpEnv = {
  /** True when no explicit endpoint was given and the environment drives the rest. */
  envDriven: boolean;
  endpoint?: string;
  headers: Record<string, string>;
  protocol: OtlpProtocol;
  compression: "gzip" | "none";
  timeoutMs?: number;
  serviceName?: string;
  resourceAttributes: Record<string, string>;
  /** `OTEL_SDK_DISABLED` / `OTEL_TRACES_EXPORTER=none` in env-driven mode. */
  disabled: boolean;
};

type Env = Record<string, string | undefined>;

const warned = new Set<string>();

/** One console.warn per distinct message for the life of the process. */
export function warnOnce(message: string): void {
  if (warned.has(message)) return;
  warned.add(message);
  if (typeof console !== "undefined" && typeof console.warn === "function") console.warn(message);
}

/** Test hook: forget what was warned about. */
export function resetOtlpWarnings(): void {
  warned.clear();
}

function pick(env: Env, ...names: string[]): string | undefined {
  for (const name of names) {
    const value = env[name];
    if (typeof value === "string" && value.trim().length > 0) return value.trim();
  }
  return undefined;
}

function decode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/** `a=b,c=d%20e` to `{ a: "b", c: "d e" }` (the W3C baggage-like list OTEL_* variables use). */
export function parseKeyValueList(raw: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!raw) return out;
  for (const part of raw.split(",")) {
    const index = part.indexOf("=");
    if (index <= 0) continue;
    const key = part.slice(0, index).trim();
    if (!key) continue;
    out[key] = decode(part.slice(index + 1).trim());
  }
  return out;
}

function tracesEndpointFrom(base: string): string {
  return `${base.replace(/\/+$/, "")}/v1/traces`;
}

function protocolFrom(raw: string | undefined, fallback: OtlpProtocol): OtlpProtocol {
  if (!raw) return fallback;
  const value = raw.toLowerCase();
  if (value === "http/protobuf" || value === "http/json") return value;
  warnOnce(
    value === "grpc"
      ? `[agent-sdk] OTLP/gRPC is not supported; exporting over ${fallback} instead.`
      : `[agent-sdk] OTLP protocol "${raw}" is not supported (use http/json or http/protobuf); falling back to ${fallback}.`,
  );
  return fallback;
}

export function resolveOtlpEnv(env: Env, explicit: OtlpExportOptions): ResolvedOtlpEnv {
  const explicitEndpoint = typeof explicit.endpoint === "string" ? explicit.endpoint.trim() : "";
  const envDriven = explicitEndpoint.length === 0;

  const resourceAttributes = parseKeyValueList(pick(env, "OTEL_RESOURCE_ATTRIBUTES"));
  const serviceName = pick(env, "OTEL_SERVICE_NAME");

  if (!envDriven) {
    return {
      envDriven,
      endpoint: explicitEndpoint,
      headers: { ...(explicit.headers ?? {}) },
      protocol: explicit.protocol ?? "http/json",
      compression: explicit.compression ?? "none",
      timeoutMs: explicit.timeoutMs,
      serviceName,
      resourceAttributes,
      disabled: false,
    };
  }

  const tracesEndpoint = pick(env, "OTEL_EXPORTER_OTLP_TRACES_ENDPOINT");
  const baseEndpoint = pick(env, "OTEL_EXPORTER_OTLP_ENDPOINT");
  const endpoint = tracesEndpoint ?? (baseEndpoint ? tracesEndpointFrom(baseEndpoint) : undefined);

  // Signal-specific variables win over the general ones; explicit headers win over both.
  const envHeaders = {
    ...parseKeyValueList(pick(env, "OTEL_EXPORTER_OTLP_HEADERS")),
    ...parseKeyValueList(pick(env, "OTEL_EXPORTER_OTLP_TRACES_HEADERS")),
  };
  const timeoutRaw = pick(env, "OTEL_EXPORTER_OTLP_TRACES_TIMEOUT", "OTEL_EXPORTER_OTLP_TIMEOUT");
  const timeout = timeoutRaw !== undefined ? Number(timeoutRaw) : undefined;
  const compressionRaw = pick(env, "OTEL_EXPORTER_OTLP_TRACES_COMPRESSION", "OTEL_EXPORTER_OTLP_COMPRESSION")?.toLowerCase();

  return {
    envDriven,
    endpoint,
    headers: { ...envHeaders, ...(explicit.headers ?? {}) },
    protocol: explicit.protocol ?? protocolFrom(pick(env, "OTEL_EXPORTER_OTLP_TRACES_PROTOCOL", "OTEL_EXPORTER_OTLP_PROTOCOL"), "http/protobuf"),
    compression: explicit.compression ?? (compressionRaw === "gzip" ? "gzip" : "none"),
    timeoutMs: explicit.timeoutMs ?? (timeout !== undefined && Number.isFinite(timeout) && timeout > 0 ? timeout : undefined),
    serviceName,
    resourceAttributes,
    disabled:
      pick(env, "OTEL_SDK_DISABLED")?.toLowerCase() === "true" ||
      pick(env, "OTEL_TRACES_EXPORTER")?.toLowerCase() === "none",
  };
}

/** `process.env`, or an empty environment where there is no process (an edge runtime). */
export function currentEnv(): Env {
  return typeof process !== "undefined" && process.env ? process.env : {};
}
