/**
 * W3C Trace Context helpers: reading the `traceparent` / `tracestate` a caller
 * passes in, and writing one for a downstream call (an HTTP request, an MCP
 * `_meta`) a tool makes from inside a traced run.
 */

import type { TraceParent, TraceParentInput } from "./types.js";
import { warnOnce } from "./env.js";

// version-traceid-parentid-flags. Version 00 has exactly these four fields; a
// later version may add fields after them, which a reader ignores.
const TRACEPARENT = /^([0-9a-f]{2})-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})(-.*)?$/;
const ALL_ZERO_TRACE = /^0{32}$/;
const ALL_ZERO_SPAN = /^0{16}$/;
const MAX_TRACESTATE = 512;

export type ParsedTraceparent = {
  traceId: string;
  spanId: string;
  /** The trace-flags byte, unchanged. */
  flags: number;
  sampled: boolean;
};

/**
 * Reads a `traceparent` header. Returns undefined for anything the W3C
 * specification calls invalid: upper case, wrong lengths, version `ff`,
 * all-zero ids, extra fields on version 00.
 */
export function parseTraceparent(header: unknown): ParsedTraceparent | undefined {
  if (typeof header !== "string") return undefined;
  const match = TRACEPARENT.exec(header.trim());
  if (!match) return undefined;
  const [, version, traceId, spanId, flagsHex, rest] = match;
  if (version === "ff") return undefined;
  // Version 00 is exactly four fields; only a newer version may carry more.
  if (version === "00" && rest) return undefined;
  if (ALL_ZERO_TRACE.test(traceId) || ALL_ZERO_SPAN.test(spanId)) return undefined;
  const flags = parseInt(flagsHex, 16);
  return { traceId, spanId, flags, sampled: (flags & 0x01) === 0x01 };
}

/**
 * Writes a version 00 `traceparent`. `flags` is the trace-flags byte (default
 * `01`, sampled); pass the incoming byte to propagate a decision unchanged.
 */
export function formatTraceparent(parts: { traceId: string; spanId: string; sampled?: boolean; flags?: number }): string {
  const flags = typeof parts.flags === "number" ? parts.flags & 0xff : parts.sampled === false ? 0 : 1;
  return `00-${parts.traceId}-${parts.spanId}-${flags.toString(16).padStart(2, "0")}`;
}

/**
 * The `traceparent` for a call a tool makes inside a traced run: the tool call's
 * own span is the parent. Takes the `ToolCallContext` a tool receives, and is
 * undefined when the run is not traced (there is nothing to propagate).
 */
export function traceparentOf(ctx: { traceId?: string; traceSpanId?: string; traceFlags?: number } | undefined): string | undefined {
  if (!ctx?.traceId || !ctx.traceSpanId) return undefined;
  return formatTraceparent({ traceId: ctx.traceId, spanId: ctx.traceSpanId, flags: ctx.traceFlags ?? 1 });
}

function cleanTraceState(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  // Printable ASCII only (a header value), and bounded: it is copied onto every span.
  if (!trimmed || trimmed.length > MAX_TRACESTATE || !/^[\x20-\x7e]+$/.test(trimmed)) return undefined;
  return trimmed;
}

/**
 * Turns what the caller passed (`TracingConfig.parent`, `InvokeConfig.traceParent`)
 * into a TraceParent. Invalid input is ignored with one warning: a bad header
 * from a client must not fail the run it rides on.
 */
export function resolveTraceParent(input: TraceParentInput | undefined | null): TraceParent | undefined {
  if (input === undefined || input === null) return undefined;
  const header = typeof input === "string" ? input : input?.traceparent;
  const parsed = parseTraceparent(header);
  if (!parsed) {
    warnOnce("[agent-sdk] Ignoring an invalid W3C traceparent; the trace starts a new root.");
    return undefined;
  }
  const traceState = typeof input === "object" ? cleanTraceState(input.tracestate) : undefined;
  return {
    traceId: parsed.traceId,
    spanId: parsed.spanId,
    flags: parsed.flags,
    sampled: parsed.sampled,
    remote: true,
    ...(traceState ? { traceState } : {}),
  };
}

/** The plain-data form kept on a TraceContinuation: no trace id (the session has its own). */
export function persistedParentOf(parent: TraceParent | undefined): { spanId: string; flags: number; traceState?: string } | undefined {
  if (!parent) return undefined;
  return { spanId: parent.spanId, flags: parent.flags, ...(parent.traceState ? { traceState: parent.traceState } : {}) };
}

/** Reads a persisted parent back; it arrives from caller-held state, so every field is checked. */
export function readPersistedParent(value: unknown): { spanId: string; flags: number; traceState?: string } | undefined {
  if (!value || typeof value !== "object") return undefined;
  const raw = value as Record<string, unknown>;
  if (typeof raw.spanId !== "string" || !/^[0-9a-f]{16}$/.test(raw.spanId) || ALL_ZERO_SPAN.test(raw.spanId)) return undefined;
  const flags = Number(raw.flags);
  if (!Number.isInteger(flags) || flags < 0 || flags > 0xff) return undefined;
  const traceState = cleanTraceState(raw.traceState);
  return { spanId: raw.spanId, flags, ...(traceState ? { traceState } : {}) };
}

/** The TraceParent a persisted parent stands for, in the continuation's own trace. */
export function restoreParent(
  persisted: { spanId: string; flags: number; traceState?: string },
  traceId: string,
): TraceParent {
  return {
    traceId,
    spanId: persisted.spanId,
    flags: persisted.flags,
    sampled: (persisted.flags & 0x01) === 0x01,
    remote: true,
    ...(persisted.traceState ? { traceState: persisted.traceState } : {}),
  };
}
