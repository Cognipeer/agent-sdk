import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  formatTraceparent,
  parseTraceparent,
  readPersistedParent,
  resolveTraceParent,
  restoreParent,
  traceparentOf,
} from "../../../src/utils/otlp/context.js";
import { resetOtlpWarnings } from "../../../src/utils/otlp/env.js";
import { formatTraceparent as publicFormat, parseTraceparent as publicParse, traceparentOf as publicOf } from "../../../src/index.js";

const TRACE = "0af7651916cd43dd8448eb211c80319c";
const SPAN = "b7ad6b7169203331";

beforeEach(() => resetOtlpWarnings());
afterEach(() => vi.restoreAllMocks());

describe("parseTraceparent", () => {
  it("reads a valid header, trace-flags byte included", () => {
    expect(parseTraceparent(`00-${TRACE}-${SPAN}-01`)).toEqual({ traceId: TRACE, spanId: SPAN, flags: 1, sampled: true });
    expect(parseTraceparent(`00-${TRACE}-${SPAN}-00`)).toEqual({ traceId: TRACE, spanId: SPAN, flags: 0, sampled: false });
    // Other bits are kept; sampled is bit 0 only.
    expect(parseTraceparent(`00-${TRACE}-${SPAN}-03`)).toMatchObject({ flags: 3, sampled: true });
    expect(parseTraceparent(`00-${TRACE}-${SPAN}-02`)).toMatchObject({ flags: 2, sampled: false });
  });

  it.each([
    ["version ff", `ff-${TRACE}-${SPAN}-01`],
    ["all-zero trace id", `00-${"0".repeat(32)}-${SPAN}-01`],
    ["all-zero span id", `00-${TRACE}-${"0".repeat(16)}-01`],
    ["upper case", `00-${TRACE.toUpperCase()}-${SPAN}-01`],
    ["short trace id", `00-${TRACE.slice(1)}-${SPAN}-01`],
    ["long span id", `00-${TRACE}-${SPAN}0-01`],
    ["extra fields on version 00", `00-${TRACE}-${SPAN}-01-extra`],
    ["missing flags", `00-${TRACE}-${SPAN}`],
    ["not hex", `00-${"g".repeat(32)}-${SPAN}-01`],
    ["empty", ""],
  ])("rejects %s", (_name, header) => {
    expect(parseTraceparent(header)).toBeUndefined();
  });

  it("rejects a value that is not a string", () => {
    expect(parseTraceparent(undefined)).toBeUndefined();
    expect(parseTraceparent(42)).toBeUndefined();
  });

  it("accepts extra trailing fields on a future version", () => {
    expect(parseTraceparent(`01-${TRACE}-${SPAN}-01-what-the-future-holds`)).toEqual({ traceId: TRACE, spanId: SPAN, flags: 1, sampled: true });
  });
});

describe("formatTraceparent / traceparentOf", () => {
  it("writes version 00; flags default to sampled and an incoming byte is kept unchanged", () => {
    expect(formatTraceparent({ traceId: TRACE, spanId: SPAN })).toBe(`00-${TRACE}-${SPAN}-01`);
    expect(formatTraceparent({ traceId: TRACE, spanId: SPAN, sampled: false })).toBe(`00-${TRACE}-${SPAN}-00`);
    expect(formatTraceparent({ traceId: TRACE, spanId: SPAN, flags: 3 })).toBe(`00-${TRACE}-${SPAN}-03`);
  });

  it("traceparentOf(ctx) is 00-traceId-traceSpanId-01, the incoming flags when the run has them, undefined when untraced", () => {
    expect(traceparentOf({ traceId: TRACE, traceSpanId: SPAN })).toBe(`00-${TRACE}-${SPAN}-01`);
    expect(traceparentOf({ traceId: TRACE, traceSpanId: SPAN, traceFlags: 0 })).toBe(`00-${TRACE}-${SPAN}-00`);
    expect(traceparentOf({ traceSpanId: SPAN })).toBeUndefined();
    expect(traceparentOf({})).toBeUndefined();
    expect(traceparentOf(undefined)).toBeUndefined();
  });

  it("is part of the public surface", () => {
    expect(publicParse).toBe(parseTraceparent);
    expect(publicFormat).toBe(formatTraceparent);
    expect(publicOf).toBe(traceparentOf);
  });
});

describe("resolveTraceParent", () => {
  it("takes a header string or { traceparent, tracestate }", () => {
    expect(resolveTraceParent(`00-${TRACE}-${SPAN}-01`)).toEqual({ traceId: TRACE, spanId: SPAN, flags: 1, sampled: true, remote: true });
    expect(resolveTraceParent({ traceparent: `00-${TRACE}-${SPAN}-00`, tracestate: "vendor=x" })).toEqual({
      traceId: TRACE,
      spanId: SPAN,
      flags: 0,
      sampled: false,
      remote: true,
      traceState: "vendor=x",
    });
  });

  it("ignores nothing-at-all silently", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    expect(resolveTraceParent(undefined)).toBeUndefined();
    expect(resolveTraceParent(null)).toBeUndefined();
    expect(warn).not.toHaveBeenCalled();
  });

  it("a malformed value is ignored with exactly one warning, however often it comes", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    expect(resolveTraceParent("garbage")).toBeUndefined();
    expect(resolveTraceParent({ traceparent: "also garbage" })).toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("drops an unusable tracestate but keeps the parent", () => {
    expect(resolveTraceParent({ traceparent: `00-${TRACE}-${SPAN}-01`, tracestate: "x".repeat(600) })).not.toHaveProperty("traceState");
    expect(resolveTraceParent({ traceparent: `00-${TRACE}-${SPAN}-01`, tracestate: "bad\nvalue" })).not.toHaveProperty("traceState");
  });
});

describe("persisted parent", () => {
  it("round-trips through the plain-data form a continuation keeps", () => {
    const persisted = readPersistedParent({ spanId: SPAN, flags: 1, traceState: "v=1", extra: "ignored" });
    expect(persisted).toEqual({ spanId: SPAN, flags: 1, traceState: "v=1" });
    expect(restoreParent(persisted!, TRACE)).toEqual({ traceId: TRACE, spanId: SPAN, flags: 1, sampled: true, remote: true, traceState: "v=1" });
  });

  it("checks every field of what caller-held state hands back", () => {
    expect(readPersistedParent(undefined)).toBeUndefined();
    expect(readPersistedParent("x")).toBeUndefined();
    expect(readPersistedParent({ spanId: "nope", flags: 1 })).toBeUndefined();
    expect(readPersistedParent({ spanId: "0".repeat(16), flags: 1 })).toBeUndefined();
    expect(readPersistedParent({ spanId: SPAN, flags: 256 })).toBeUndefined();
    expect(readPersistedParent({ spanId: SPAN, flags: 1.5 })).toBeUndefined();
  });
});
