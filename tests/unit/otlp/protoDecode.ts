/**
 * Test-only: decode OTLP/protobuf with protobufjs against the vendored
 * opentelemetry-proto files, and bring the result into the OTLP/JSON model the
 * converter produces, so the two can be compared with toEqual.
 */
import path from "node:path";
import protobuf from "protobufjs";
import { FIXTURES } from "./helpers.js";

const PROTO_ROOT = path.join(FIXTURES, "proto");

let cached: protobuf.Root | undefined;
function root(): protobuf.Root {
  if (cached) return cached;
  const r = new protobuf.Root();
  r.resolvePath = (_origin, target) => (path.isAbsolute(target) ? target : path.join(PROTO_ROOT, target));
  r.loadSync("opentelemetry/proto/collector/trace/v1/trace_service.proto", { keepCase: false });
  cached = r;
  return r;
}

export function requestType(): protobuf.Type {
  return root().lookupType("opentelemetry.proto.collector.trace.v1.ExportTraceServiceRequest");
}

export function responseType(): protobuf.Type {
  return root().lookupType("opentelemetry.proto.collector.trace.v1.ExportTraceServiceResponse");
}

const hex = (b64: string | undefined): string => (b64 ? Buffer.from(b64, "base64").toString("hex") : "");

function anyValue(v: any): any {
  if (v.arrayValue) return { arrayValue: { values: (v.arrayValue.values ?? []).map(anyValue) } };
  if (v.kvlistValue) return { kvlistValue: { values: (v.kvlistValue.values ?? []).map(keyValue) } };
  return { ...v };
}
const keyValue = (kv: any) => ({ key: kv.key ?? "", value: anyValue(kv.value ?? {}) });

export function decodeRequest(bytes: Uint8Array): any {
  const type = requestType();
  const message = type.decode(bytes);
  const obj: any = type.toObject(message, { longs: String, enums: Number, bytes: String, defaults: false });
  return {
    resourceSpans: (obj.resourceSpans ?? []).map((rs: any) => ({
      resource: { attributes: (rs.resource?.attributes ?? []).map(keyValue) },
      scopeSpans: (rs.scopeSpans ?? []).map((ss: any) => ({
        scope: { name: ss.scope?.name ?? "", version: ss.scope?.version ?? "" },
        spans: (ss.spans ?? []).map((s: any) => ({
          traceId: hex(s.traceId),
          spanId: hex(s.spanId),
          parentSpanId: hex(s.parentSpanId),
          ...(s.traceState ? { traceState: s.traceState } : {}),
          flags: s.flags ?? 0,
          name: s.name ?? "",
          kind: s.kind ?? 0,
          startTimeUnixNano: String(s.startTimeUnixNano ?? "0"),
          endTimeUnixNano: String(s.endTimeUnixNano ?? "0"),
          attributes: (s.attributes ?? []).map(keyValue),
          ...(s.events?.length
            ? {
                events: s.events.map((e: any) => ({
                  timeUnixNano: String(e.timeUnixNano ?? "0"),
                  name: e.name ?? "",
                  attributes: (e.attributes ?? []).map(keyValue),
                })),
              }
            : {}),
          status: { code: s.status?.code ?? 0, ...(s.status?.message ? { message: s.status.message } : {}) },
        })),
      })),
      ...(rs.schemaUrl ? { schemaUrl: rs.schemaUrl } : {}),
    })),
  };
}

export function encodeResponse(partial: { rejectedSpans?: number; errorMessage?: string } | undefined): Uint8Array {
  const type = responseType();
  return type.encode(type.fromObject(partial ? { partialSuccess: partial } : {})).finish();
}
