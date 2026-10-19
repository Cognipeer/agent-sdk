/**
 * A dependency-free OTLP/protobuf encoder for ExportTraceServiceRequest, plus a
 * reader for the one response field the exporter looks at (partial_success).
 *
 * It encodes the OTLP/JSON model the converter produces, so there is one source
 * of truth for what a span contains and two serializations of it. Field numbers
 * are those of opentelemetry-proto v1.x (trace.proto, common.proto,
 * resource.proto, trace_service.proto); the test suite decodes the output with
 * protobufjs against the vendored .proto files.
 *
 * Only ES2020 APIs are used (BigInt, DataView.setBigUint64, TextEncoder).
 */

import { Buffer } from "node:buffer";
import type {
  OtlpAnyValue,
  OtlpExportTraceServiceRequest,
  OtlpKeyValue,
  OtlpSpan,
  OtlpSpanEvent,
} from "./types.js";

const WIRE_VARINT = 0;
const WIRE_FIXED64 = 1;
const WIRE_LEN = 2;
const WIRE_FIXED32 = 5;

const textEncoder = new TextEncoder();

class Writer {
  private buf = new Uint8Array(128);
  private len = 0;
  private view = new DataView(this.buf.buffer);

  private ensure(extra: number): void {
    if (this.len + extra <= this.buf.length) return;
    let size = this.buf.length * 2;
    while (size < this.len + extra) size *= 2;
    const next = new Uint8Array(size);
    next.set(this.buf.subarray(0, this.len));
    this.buf = next;
    this.view = new DataView(next.buffer);
  }

  byte(value: number): void {
    this.ensure(1);
    this.buf[this.len++] = value;
  }

  varint(value: number | bigint): void {
    if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) {
      // Plain arithmetic: bit operators would truncate to 32 bits.
      let n = value;
      while (n >= 128) {
        this.byte((n % 128) | 128);
        n = Math.floor(n / 128);
      }
      this.byte(n);
      return;
    }
    // Negative int64 are two's complement, ten bytes.
    let n = BigInt.asUintN(64, BigInt(value));
    while (n >= 128n) {
      this.byte(Number(n & 127n) | 128);
      n >>= 7n;
    }
    this.byte(Number(n));
  }

  tag(field: number, wire: number): void {
    this.varint(field * 8 + wire);
  }

  raw(bytes: Uint8Array): void {
    this.ensure(bytes.length);
    this.buf.set(bytes, this.len);
    this.len += bytes.length;
  }

  fixed64(value: bigint): void {
    this.ensure(8);
    this.view.setBigUint64(this.len, BigInt.asUintN(64, value), true);
    this.len += 8;
  }

  fixed32(value: number): void {
    this.ensure(4);
    this.view.setUint32(this.len, value >>> 0, true);
    this.len += 4;
  }

  double(value: number): void {
    this.ensure(8);
    this.view.setFloat64(this.len, value, true);
    this.len += 8;
  }

  finish(): Uint8Array {
    return this.buf.slice(0, this.len);
  }
}

// ─── Field helpers ─────────────────────────────────────────────────────────

function lenField(w: Writer, field: number, bytes: Uint8Array): void {
  w.tag(field, WIRE_LEN);
  w.varint(bytes.length);
  w.raw(bytes);
}

function stringField(w: Writer, field: number, value: string | undefined): void {
  if (!value) return;
  lenField(w, field, textEncoder.encode(value));
}

function hexBytes(hex: string | undefined, bytes: number): Uint8Array | undefined {
  if (!hex) return undefined;
  const out = new Uint8Array(bytes);
  // A malformed id keeps its valid prefix and pads with zeros rather than
  // throwing: the converter generates ids, so this only guards hand-built input.
  for (let i = 0; i < bytes; i++) {
    const pair = hex.slice(i * 2, i * 2 + 2);
    const value = /^[0-9a-fA-F]{2}$/.test(pair) ? parseInt(pair, 16) : 0;
    out[i] = value;
  }
  return out;
}

function base64Bytes(value: string): Uint8Array {
  return new Uint8Array(Buffer.from(value, "base64"));
}

// ─── Messages ──────────────────────────────────────────────────────────────

function encodeAnyValue(value: OtlpAnyValue): Uint8Array {
  const w = new Writer();
  // oneof members are written even when empty or zero: "" and 0 and false
  // are values here, not defaults to elide.
  if (value.stringValue !== undefined) {
    lenField(w, 1, textEncoder.encode(value.stringValue));
  } else if (value.boolValue !== undefined) {
    w.tag(2, WIRE_VARINT);
    w.varint(value.boolValue ? 1 : 0);
  } else if (value.intValue !== undefined) {
    w.tag(3, WIRE_VARINT);
    w.varint(BigInt(value.intValue));
  } else if (value.doubleValue !== undefined) {
    w.tag(4, WIRE_FIXED64);
    w.double(value.doubleValue);
  } else if (value.arrayValue !== undefined) {
    const inner = new Writer();
    for (const item of value.arrayValue.values) lenField(inner, 1, encodeAnyValue(item));
    lenField(w, 5, inner.finish());
  } else if (value.kvlistValue !== undefined) {
    const inner = new Writer();
    for (const kv of value.kvlistValue.values) lenField(inner, 1, encodeKeyValue(kv));
    lenField(w, 6, inner.finish());
  } else if (value.bytesValue !== undefined) {
    lenField(w, 7, base64Bytes(value.bytesValue));
  }
  return w.finish();
}

function encodeKeyValue(kv: OtlpKeyValue): Uint8Array {
  const w = new Writer();
  stringField(w, 1, kv.key);
  lenField(w, 2, encodeAnyValue(kv.value));
  return w.finish();
}

function encodeSpanEvent(event: OtlpSpanEvent): Uint8Array {
  const w = new Writer();
  w.tag(1, WIRE_FIXED64);
  w.fixed64(BigInt(event.timeUnixNano));
  stringField(w, 2, event.name);
  for (const attr of event.attributes) lenField(w, 3, encodeKeyValue(attr));
  return w.finish();
}

function encodeSpan(span: OtlpSpan): Uint8Array {
  const w = new Writer();
  const traceId = hexBytes(span.traceId, 16);
  if (traceId) lenField(w, 1, traceId);
  const spanId = hexBytes(span.spanId, 8);
  if (spanId) lenField(w, 2, spanId);
  stringField(w, 3, span.traceState);
  const parent = hexBytes(span.parentSpanId, 8);
  if (parent) lenField(w, 4, parent);
  stringField(w, 5, span.name);
  if (span.kind) {
    w.tag(6, WIRE_VARINT);
    w.varint(span.kind);
  }
  w.tag(7, WIRE_FIXED64);
  w.fixed64(BigInt(span.startTimeUnixNano));
  w.tag(8, WIRE_FIXED64);
  w.fixed64(BigInt(span.endTimeUnixNano));
  for (const attr of span.attributes) lenField(w, 9, encodeKeyValue(attr));
  for (const event of span.events ?? []) lenField(w, 11, encodeSpanEvent(event));
  const status = new Writer();
  stringField(status, 2, span.status.message);
  if (span.status.code) {
    status.tag(3, WIRE_VARINT);
    status.varint(span.status.code);
  }
  lenField(w, 15, status.finish());
  if (span.flags) {
    w.tag(16, WIRE_FIXED32);
    w.fixed32(span.flags);
  }
  return w.finish();
}

/** ExportTraceServiceRequest as protobuf bytes. */
export function encodeExportTraceServiceRequest(request: OtlpExportTraceServiceRequest): Uint8Array {
  const w = new Writer();
  for (const rs of request.resourceSpans) {
    const resourceSpans = new Writer();

    const resource = new Writer();
    for (const attr of rs.resource.attributes) lenField(resource, 1, encodeKeyValue(attr));
    lenField(resourceSpans, 1, resource.finish());

    for (const ss of rs.scopeSpans) {
      const scopeSpans = new Writer();
      const scope = new Writer();
      stringField(scope, 1, ss.scope.name);
      stringField(scope, 2, ss.scope.version);
      lenField(scopeSpans, 1, scope.finish());
      for (const span of ss.spans) lenField(scopeSpans, 2, encodeSpan(span));
      lenField(resourceSpans, 2, scopeSpans.finish());
    }
    stringField(resourceSpans, 3, rs.schemaUrl);
    lenField(w, 1, resourceSpans.finish());
  }
  return w.finish();
}

// ─── Response ──────────────────────────────────────────────────────────────

class Reader {
  private pos = 0;
  constructor(private readonly bytes: Uint8Array) {}

  get done(): boolean {
    return this.pos >= this.bytes.length;
  }

  varint(): bigint {
    let result = 0n;
    let shift = 0n;
    for (;;) {
      if (this.pos >= this.bytes.length) throw new Error("truncated varint");
      const byte = this.bytes[this.pos++];
      result |= BigInt(byte & 127) << shift;
      if ((byte & 128) === 0) return result;
      shift += 7n;
      if (shift > 70n) throw new Error("varint too long");
    }
  }

  slice(length: number): Uint8Array {
    if (this.pos + length > this.bytes.length) throw new Error("truncated field");
    const out = this.bytes.subarray(this.pos, this.pos + length);
    this.pos += length;
    return out;
  }

  skip(wire: number): void {
    if (wire === WIRE_VARINT) this.varint();
    else if (wire === WIRE_FIXED64) this.slice(8);
    else if (wire === WIRE_FIXED32) this.slice(4);
    else if (wire === WIRE_LEN) this.slice(Number(this.varint()));
    else throw new Error(`unsupported wire type ${wire}`);
  }
}

/**
 * Reads ExportTraceServiceResponse.partial_success. Returns undefined when the
 * body carries none; throws on a malformed body (the caller treats that as
 * success, a response it cannot read is not a failed export).
 */
export function decodeExportTraceServiceResponse(
  bytes: Uint8Array,
): { rejectedSpans: number; message?: string } | undefined {
  const top = new Reader(bytes);
  let result: { rejectedSpans: number; message?: string } | undefined;
  while (!top.done) {
    const key = Number(top.varint());
    const field = key >>> 3;
    const wire = key & 7;
    if (field === 1 && wire === WIRE_LEN) {
      const inner = new Reader(top.slice(Number(top.varint())));
      let rejected = 0n;
      let message: string | undefined;
      while (!inner.done) {
        const innerKey = Number(inner.varint());
        const innerField = innerKey >>> 3;
        const innerWire = innerKey & 7;
        if (innerField === 1 && innerWire === WIRE_VARINT) rejected = BigInt.asIntN(64, inner.varint());
        else if (innerField === 2 && innerWire === WIRE_LEN) message = new TextDecoder().decode(inner.slice(Number(inner.varint())));
        else inner.skip(innerWire);
      }
      result = { rejectedSpans: Number(rejected), ...(message ? { message } : {}) };
    } else {
      top.skip(wire);
    }
  }
  return result;
}
