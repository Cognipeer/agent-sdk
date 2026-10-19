import { gunzipSync } from "node:zlib";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createOtlpExporter } from "../../../src/utils/otlp/exporter.js";
import type { OtlpExportOptions } from "../../../src/utils/otlp/types.js";
import { decodeRequest, encodeResponse } from "./protoDecode.js";
import { errorResponse, loadSession, okResponse } from "./helpers.js";

const URL = "https://collector.example.test/v1/traces";
const file = () => loadSession("run-success");

type Call = { url: string; init: any; at: number };

/** A fetch that answers from `script` in order (the last answer repeats) and records each call. */
function scripted(script: Array<() => any>) {
  const calls: Call[] = [];
  const fetch = vi.fn(async (url: string, init: any) => {
    calls.push({ url, init, at: Date.now() });
    const step = script[Math.min(calls.length - 1, script.length - 1)];
    return step();
  });
  return { fetch, calls };
}

const exporterWith = (options: OtlpExportOptions) => createOtlpExporter({ endpoint: URL, ...options });
const bodyOf = (call: Call) => JSON.parse(call.init.body);

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("encoding and headers", () => {
  it("posts JSON with content-type application/json and the configured headers", async () => {
    const { fetch, calls } = scripted([() => okResponse()]);
    const result = await exporterWith({ fetch, headers: { "x-api-key": "k", authorization: "Bearer t" } }).exportSession(file(), { terminal: true });
    expect(result).toMatchObject({ ok: true, attempts: 1, status: 200, spans: 6 });
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(URL);
    expect(calls[0].init.method).toBe("POST");
    expect(calls[0].init.headers).toMatchObject({ "content-type": "application/json", "x-api-key": "k", authorization: "Bearer t" });
    expect(bodyOf(calls[0]).resourceSpans[0].scopeSpans[0].spans).toHaveLength(6);
    expect(result.bytes).toBe(Buffer.byteLength(calls[0].init.body));
  });

  it("posts protobuf with content-type application/x-protobuf that decodes to the same spans", async () => {
    const { fetch, calls } = scripted([() => okResponse()]);
    await exporterWith({ fetch, protocol: "http/protobuf" }).exportSession(file(), { terminal: true });
    expect(calls[0].init.headers["content-type"]).toBe("application/x-protobuf");
    const decoded = decodeRequest(calls[0].init.body);
    expect(decoded.resourceSpans[0].scopeSpans[0].spans).toHaveLength(6);
    expect(decoded.resourceSpans[0].scopeSpans[0].spans[0].name).toBe("invoke_agent Support Agent");
  });

  it("gzip sets Content-Encoding and gunzip gives the identity body, for both protocols", async () => {
    for (const protocol of ["http/json", "http/protobuf"] as const) {
      const plain = scripted([() => okResponse()]);
      const zipped = scripted([() => okResponse()]);
      await exporterWith({ fetch: plain.fetch, protocol }).exportSession(file(), { terminal: true });
      await exporterWith({ fetch: zipped.fetch, protocol, compression: "gzip" }).exportSession(file(), { terminal: true });
      expect(zipped.calls[0].init.headers["content-encoding"]).toBe("gzip");
      expect(plain.calls[0].init.headers["content-encoding"]).toBeUndefined();
      const unzipped = gunzipSync(zipped.calls[0].init.body);
      expect(Buffer.from(unzipped).equals(Buffer.from(plain.calls[0].init.body))).toBe(true);
    }
  });
});

describe("retries", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  const run = async (options: OtlpExportOptions, script: Array<() => any>) => {
    const { fetch, calls } = scripted(script);
    const pending = exporterWith({ fetch, ...options }).exportSession(file(), { terminal: true });
    await vi.runAllTimersAsync();
    return { result: await pending, calls };
  };

  it("503 then 200 is two attempts", async () => {
    const { result, calls } = await run({}, [() => errorResponse(503, "Unavailable"), () => okResponse()]);
    expect(result).toMatchObject({ ok: true, attempts: 2 });
    expect(calls).toHaveLength(2);
  });

  it("429 with Retry-After: 2 waits at least 2000 ms; a huge Retry-After is capped at maxDelayMs", async () => {
    const waited = await run({}, [() => errorResponse(429, "", { "retry-after": "2" }), () => okResponse()]);
    expect(waited.calls[1].at - waited.calls[0].at).toBeGreaterThanOrEqual(2000);
    const capped = await run({ retry: { maxDelayMs: 1500 } }, [() => errorResponse(429, "", { "retry-after": "60" }), () => okResponse()]);
    expect(capped.calls[1].at - capped.calls[0].at).toBe(1500);
  });

  it("a Retry-After HTTP date is honoured", async () => {
    vi.setSystemTime(new Date("2026-10-19T12:00:00.000Z"));
    const { calls } = await run({}, [
      () => errorResponse(503, "", { "retry-after": "Mon, 19 Oct 2026 12:00:03 GMT" }),
      () => okResponse(),
    ]);
    expect(calls[1].at - calls[0].at).toBe(3000);
  });

  it("502 and 504 are retried", async () => {
    for (const status of [502, 504]) {
      const { calls } = await run({}, [() => errorResponse(status), () => okResponse()]);
      expect(calls, String(status)).toHaveLength(2);
    }
  });

  it("400, 401, 404 and 500 are final: one attempt", async () => {
    for (const status of [400, 401, 404, 500]) {
      const { result, calls } = await run({}, [() => errorResponse(status, "nope")]);
      expect(calls, String(status)).toHaveLength(1);
      expect(result).toMatchObject({ ok: false, attempts: 1, status });
      expect(result.error).toContain(`HTTP ${status} nope`);
    }
  });

  it("a network error is retried up to maxAttempts, then reported as ok:false", async () => {
    const { result, calls } = await run({}, [() => { throw new Error("ECONNRESET"); }]);
    expect(calls).toHaveLength(3);
    expect(result).toMatchObject({ ok: false, attempts: 3, error: "ECONNRESET" });
  });

  it("retry:false sends once; maxAttempts is honoured", async () => {
    expect((await run({ retry: false }, [() => errorResponse(503)])).calls).toHaveLength(1);
    expect((await run({ retry: { maxAttempts: 2 } }, [() => errorResponse(503)])).calls).toHaveLength(2);
  });

  it("full jitter: the wait is random(0, min(maxDelay, initial * 2^(attempt-1)))", async () => {
    const random = vi.spyOn(Math, "random");
    random.mockReturnValue(0.999);
    const high = await run({}, [() => errorResponse(503), () => errorResponse(503), () => okResponse()]);
    const gap1 = high.calls[1].at - high.calls[0].at;
    const gap2 = high.calls[2].at - high.calls[1].at;
    expect(gap1).toBeGreaterThan(240);
    expect(gap1).toBeLessThanOrEqual(250);
    expect(gap2).toBeGreaterThan(490);
    expect(gap2).toBeLessThanOrEqual(500);
    random.mockReturnValue(0);
    const none = await run({}, [() => errorResponse(503), () => okResponse()]);
    expect(none.calls[1].at - none.calls[0].at).toBe(0);
  });

  it("a fetch that never answers is given up on at timeoutMs, even if it ignores the abort signal", async () => {
    const { result, calls } = await run({ timeoutMs: 1000, retry: false }, [() => new Promise(() => undefined)]);
    expect(calls).toHaveLength(1);
    expect(result).toMatchObject({ ok: false, attempts: 1 });
    expect(result.error).toMatch(/timed out after 1000 ms/);
  });

  it("the abort signal reaches fetch", async () => {
    let signal: AbortSignal | undefined;
    const fetch = vi.fn((_url: string, init: any) => {
      signal = init.signal;
      return new Promise((_, reject) => init.signal.addEventListener("abort", () => reject(new Error("aborted by signal"))));
    });
    const pending = exporterWith({ fetch, timeoutMs: 500, retry: false }).exportSession(file(), { terminal: true });
    await vi.runAllTimersAsync();
    const result = await pending;
    expect(signal?.aborted).toBe(true);
    expect(result.ok).toBe(false);
  });

  it("maxElapsedMs bounds the whole export: no wait that would overrun it is started", async () => {
    const { result, calls } = await run({ retry: { maxAttempts: 10, initialDelayMs: 4000, maxDelayMs: 4000, maxElapsedMs: 5000 } }, [
      () => errorResponse(429, "", { "retry-after": "4" }),
    ]);
    // 0s attempt 1, wait 4s, attempt 2 at 4s, the next 4s wait would end at 8s > 5s: stop.
    expect(calls).toHaveLength(2);
    expect(result.ok).toBe(false);
  });
});

describe("partial success", () => {
  it("surfaces rejected spans from a JSON response while the export stays ok", async () => {
    const { fetch } = scripted([() => okResponse(JSON.stringify({ partialSuccess: { rejectedSpans: "2", errorMessage: "bad" } }))]);
    const result = await exporterWith({ fetch }).exportSession(file(), { terminal: true });
    expect(result).toMatchObject({ ok: true, partialSuccess: { rejectedSpans: 2, message: "bad" } });
  });

  it("surfaces rejected spans from a protobuf response", async () => {
    const bytes = encodeResponse({ rejectedSpans: 3, errorMessage: "nope" });
    const { fetch } = scripted([
      () => ({ ...okResponse(), arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) }),
    ]);
    const result = await exporterWith({ fetch, protocol: "http/protobuf" }).exportSession(file(), { terminal: true });
    expect(result).toMatchObject({ ok: true, partialSuccess: { rejectedSpans: 3, message: "nope" } });
  });

  it("a body that cannot be read is success: invalid JSON, wrong shape, a throwing text(), an empty object", async () => {
    const bodies: Array<() => any> = [
      () => okResponse("<html>not json</html>"),
      () => okResponse(JSON.stringify([1, 2])),
      () => ({ ...okResponse(), text: async () => { throw new Error("stream error"); } }),
      () => okResponse("{}"),
      () => okResponse(JSON.stringify({ partialSuccess: { rejectedSpans: 0 } })),
      () => ({ ok: true, status: 200 }),
    ];
    for (const body of bodies) {
      const { fetch } = scripted([body]);
      const result = await exporterWith({ fetch }).exportSession(file(), { terminal: true });
      expect(result.ok).toBe(true);
      expect(result.partialSuccess).toBeUndefined();
    }
  });
});

describe("skipping, laziness and never throwing", () => {
  it("sends nothing when there are no spans: a close with no events on a non-terminal leg", async () => {
    const { fetch, calls } = scripted([() => okResponse()]);
    const empty = { ...file(), events: [], status: "paused" as const };
    const result = await exporterWith({ fetch }).exportSession(empty, { terminal: false });
    expect(calls).toHaveLength(0);
    expect(result).toMatchObject({ ok: true, skipped: true, spans: 0, attempts: 0 });
  });

  it("sends nothing when every span is withheld (a lone pending sub-agent span)", async () => {
    const { fetch, calls } = scripted([() => okResponse()]);
    const only = {
      ...file(),
      status: "paused" as const,
      events: [{ ...file().events[0], type: "span", status: "pending" as const, actor: { role: "subagent", name: "x" } }],
    };
    const result = await exporterWith({ fetch }).exportSession(only, { terminal: false });
    expect(calls).toHaveLength(0);
    expect(result.skipped).toBe(true);
  });

  it("reads globalThis.fetch when exporting, not when created", async () => {
    const exporter = createOtlpExporter({ endpoint: URL });
    const { fetch, calls } = scripted([() => okResponse()]);
    vi.stubGlobal("fetch", fetch);
    const result = await exporter.exportSession(file(), { terminal: true });
    expect(result.ok).toBe(true);
    expect(calls).toHaveLength(1);
  });

  it("without any fetch it reports a failure instead of throwing", async () => {
    vi.stubGlobal("fetch", undefined);
    const result = await createOtlpExporter({ endpoint: URL }).exportSession(file(), { terminal: true });
    expect(result).toMatchObject({ ok: false });
    expect(result.error).toMatch(/requires fetch/);
  });

  it("tolerates the smallest fetch mock: only ok, status, statusText, text and headers.get", async () => {
    const mock = vi.fn(async () => ({ ok: true, status: 200, statusText: "OK", text: async () => "", headers: { get: () => null } }));
    const failing = vi.fn(async () => ({ ok: false, status: 503, statusText: "Unavailable", text: async () => "down", headers: { get: () => null } }));
    expect((await exporterWith({ fetch: mock as any }).exportSession(file(), { terminal: true })).ok).toBe(true);
    expect((await exporterWith({ fetch: failing as any, retry: false }).exportSession(file(), { terminal: true })).error).toBe("HTTP 503 Unavailable - down");
  });

  it("never throws: a fetch that throws synchronously, a converter failure", async () => {
    const throwing = vi.fn(() => { throw new Error("sync boom"); });
    const a = await exporterWith({ fetch: throwing as any, retry: false }).exportSession(file(), { terminal: true });
    expect(a).toMatchObject({ ok: false, error: "sync boom" });
    const b = await exporterWith({ fetch: scripted([() => okResponse()]).fetch }).exportSession(null as any, { terminal: true });
    expect(b.ok).toBe(false);
  });
});
