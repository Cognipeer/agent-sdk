import fs from "node:fs";
import path from "node:path";
import { expect } from "vitest";
import { SDK_VERSION } from "../../../src/version.js";
import type { TraceSessionFile } from "../../../src/types.js";

export const FIXTURES = path.resolve(__dirname, "../../fixtures/otlp");

export function loadSession(name: string): TraceSessionFile {
  return JSON.parse(fs.readFileSync(path.join(FIXTURES, `${name}.session.json`), "utf8")) as TraceSessionFile;
}

/** The real SDK version replaced by a placeholder, so a release bump does not rewrite every golden. */
export function normalize<T>(value: T): T {
  return JSON.parse(JSON.stringify(value).split(`"${SDK_VERSION}"`).join('"<sdk-version>"')) as T;
}

/**
 * Compares `value` with the committed golden file; `UPDATE_OTLP_GOLDEN=1` rewrites
 * the file instead (review the diff before committing).
 */
export function expectGolden(fileName: string, value: unknown): void {
  const file = path.join(FIXTURES, fileName);
  const normalized = normalize(value);
  if (process.env.UPDATE_OTLP_GOLDEN === "1") fs.writeFileSync(file, `${JSON.stringify(normalized, null, 2)}\n`);
  expect(normalized).toEqual(JSON.parse(fs.readFileSync(file, "utf8")));
}

export type AnySpan = {
  traceId: string;
  spanId: string;
  parentSpanId: string;
  name: string;
  kind: number;
  flags: number;
  traceState?: string;
  startTimeUnixNano: string;
  endTimeUnixNano: string;
  attributes: Array<{ key: string; value: any }>;
  events?: Array<{ name: string; timeUnixNano: string; attributes: Array<{ key: string; value: any }> }>;
  status: { code: number; message?: string };
};

export const spansOf = (request: any): AnySpan[] => request.resourceSpans[0].scopeSpans[0].spans;

/** Attribute values as plain JS: strings, ints as numbers, arrays flattened. */
export function attrsOf(span: { attributes: Array<{ key: string; value: any }> }): Record<string, any> {
  const read = (v: any): any => {
    if (v.stringValue !== undefined) return v.stringValue;
    if (v.intValue !== undefined) return Number(v.intValue);
    if (v.doubleValue !== undefined) return v.doubleValue;
    if (v.boolValue !== undefined) return v.boolValue;
    if (v.arrayValue) return v.arrayValue.values.map(read);
    return v;
  };
  return Object.fromEntries(span.attributes.map((a) => [a.key, read(a.value)]));
}

export const resourceAttrsOf = (request: any): Record<string, any> => attrsOf(request.resourceSpans[0].resource);

export function spanByLabel(request: any, label: string): AnySpan {
  const found = spansOf(request).find((s) => attrsOf(s)["cognipeer.event.label"] === label);
  if (!found) throw new Error(`no span with label ${label}`);
  return found;
}

/** A fetch mock returning the minimum a response may offer. */
export function okResponse(body = "") {
  return { ok: true, status: 200, statusText: "OK", text: async () => body, headers: { get: () => null } };
}
export function errorResponse(status: number, statusText = "", headers: Record<string, string> = {}) {
  return {
    ok: false,
    status,
    statusText,
    text: async () => "",
    headers: { get: (name: string) => headers[name.toLowerCase()] ?? null },
  };
}
