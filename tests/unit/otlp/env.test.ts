import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseKeyValueList, resetOtlpWarnings, resolveOtlpEnv } from "../../../src/utils/otlp/env.js";
import { createOtlpExporter } from "../../../src/utils/otlp/exporter.js";
import { otlpSink, withDefaults } from "../../../src/utils/tracing.js";

beforeEach(() => {
  resetOtlpWarnings();
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("resolveOtlpEnv: env-driven mode (no explicit endpoint)", () => {
  it("builds the traces URL from OTEL_EXPORTER_OTLP_ENDPOINT, with or without a trailing slash", () => {
    expect(resolveOtlpEnv({ OTEL_EXPORTER_OTLP_ENDPOINT: "http://h:4318" }, {}).endpoint).toBe("http://h:4318/v1/traces");
    expect(resolveOtlpEnv({ OTEL_EXPORTER_OTLP_ENDPOINT: "http://h:4318/" }, {}).endpoint).toBe("http://h:4318/v1/traces");
  });

  it("OTEL_EXPORTER_OTLP_TRACES_ENDPOINT is used as is and wins", () => {
    const env = { OTEL_EXPORTER_OTLP_ENDPOINT: "http://h:4318", OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: "http://t:9/custom/path" };
    expect(resolveOtlpEnv(env, {}).endpoint).toBe("http://t:9/custom/path");
  });

  it("parses headers (percent-decoded), the signal-specific list wins, explicit headers win over both", () => {
    const env = {
      OTEL_EXPORTER_OTLP_ENDPOINT: "http://h",
      OTEL_EXPORTER_OTLP_HEADERS: "a=b,c=d%20e,shared=general",
      OTEL_EXPORTER_OTLP_TRACES_HEADERS: "shared=traces",
    };
    expect(resolveOtlpEnv(env, {}).headers).toEqual({ a: "b", c: "d e", shared: "traces" });
    expect(resolveOtlpEnv(env, { headers: { a: "explicit" } }).headers).toEqual({ a: "explicit", c: "d e", shared: "traces" });
  });

  it("honours timeout, compression and protocol; the protocol defaults to http/protobuf", () => {
    const env = {
      OTEL_EXPORTER_OTLP_ENDPOINT: "http://h",
      OTEL_EXPORTER_OTLP_TIMEOUT: "2500",
      OTEL_EXPORTER_OTLP_COMPRESSION: "gzip",
      OTEL_EXPORTER_OTLP_PROTOCOL: "http/json",
    };
    expect(resolveOtlpEnv(env, {})).toMatchObject({ timeoutMs: 2500, compression: "gzip", protocol: "http/json" });
    expect(resolveOtlpEnv({ OTEL_EXPORTER_OTLP_ENDPOINT: "http://h" }, {})).toMatchObject({ protocol: "http/protobuf", compression: "none" });
    expect(resolveOtlpEnv({ OTEL_EXPORTER_OTLP_ENDPOINT: "http://h", OTEL_EXPORTER_OTLP_PROTOCOL: "http/json" }, { protocol: "http/protobuf" }).protocol).toBe("http/protobuf");
  });

  it("grpc warns once (module-level memo, across calls) and falls back to http/protobuf", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const env = { OTEL_EXPORTER_OTLP_ENDPOINT: "http://h", OTEL_EXPORTER_OTLP_PROTOCOL: "grpc" };
    expect(resolveOtlpEnv(env, {}).protocol).toBe("http/protobuf");
    expect(resolveOtlpEnv(env, {}).protocol).toBe("http/protobuf");
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toMatch(/gRPC is not supported/);
  });

  it("OTEL_SDK_DISABLED=true and OTEL_TRACES_EXPORTER=none disable the exporter", () => {
    expect(resolveOtlpEnv({ OTEL_SDK_DISABLED: "true" }, {}).disabled).toBe(true);
    expect(resolveOtlpEnv({ OTEL_TRACES_EXPORTER: "none" }, {}).disabled).toBe(true);
    expect(resolveOtlpEnv({ OTEL_SDK_DISABLED: "false" }, {}).disabled).toBe(false);
  });
});

describe("resolveOtlpEnv: explicit endpoint", () => {
  const env = {
    OTEL_EXPORTER_OTLP_ENDPOINT: "http://operators-collector:4318",
    OTEL_EXPORTER_OTLP_HEADERS: "authorization=Bearer secret",
    OTEL_EXPORTER_OTLP_PROTOCOL: "http/protobuf",
    OTEL_EXPORTER_OTLP_COMPRESSION: "gzip",
    OTEL_EXPORTER_OTLP_TIMEOUT: "1",
    OTEL_SDK_DISABLED: "true",
    OTEL_SERVICE_NAME: "svc",
    OTEL_RESOURCE_ATTRIBUTES: "deployment.environment=prod,team=a%2Cb",
  };

  it("does not use the destination-bound variables: the operator's Authorization header, protocol, compression, timeout, disable switch", () => {
    const resolved = resolveOtlpEnv(env, { endpoint: "https://console.example/api/client/v1/traces" });
    expect(resolved).toMatchObject({
      envDriven: false,
      endpoint: "https://console.example/api/client/v1/traces",
      headers: {},
      protocol: "http/json",
      compression: "none",
      disabled: false,
    });
    expect(resolved.timeoutMs).toBeUndefined();
  });

  it("still reads OTEL_SERVICE_NAME and OTEL_RESOURCE_ATTRIBUTES, which describe the process", () => {
    const resolved = resolveOtlpEnv(env, { endpoint: "https://x/v1/traces" });
    expect(resolved.serviceName).toBe("svc");
    expect(resolved.resourceAttributes).toEqual({ "deployment.environment": "prod", team: "a,b" });
  });

  it("parseKeyValueList skips entries without a key or an equals sign", () => {
    expect(parseKeyValueList("a=1,,=x,novalue,b=2=3")).toEqual({ a: "1", b: "2=3" });
    expect(parseKeyValueList(undefined)).toEqual({});
  });
});

describe("createOtlpExporter and otlpSink read the environment when created", () => {
  it("an exporter with no endpoint and no environment throws a clear error", () => {
    expect(() => createOtlpExporter({})).toThrow(/needs an `endpoint`/);
  });

  it("OTEL_SERVICE_NAME names the resource unless serviceName is given", async () => {
    vi.stubEnv("OTEL_SERVICE_NAME", "from-env");
    const bodies: any[] = [];
    const fetch = async (_url: string, init: any) => {
      bodies.push(JSON.parse(init.body));
      return { ok: true, status: 200, statusText: "OK", text: async () => "", headers: { get: () => null } };
    };
    const file = (await import("./helpers.js")).loadSession("run-success");
    await createOtlpExporter({ endpoint: "http://x/v1/traces", fetch }).exportSession(file, { terminal: true });
    await createOtlpExporter({ endpoint: "http://x/v1/traces", serviceName: "explicit", fetch }).exportSession(file, { terminal: true });
    const names = bodies.map((b) => b.resourceSpans[0].resource.attributes.find((a: any) => a.key === "service.name").value.stringValue);
    expect(names).toEqual(["from-env", "explicit"]);
  });

  it("otlpSink without an endpoint resolves it from OTEL_EXPORTER_OTLP_ENDPOINT, and keeps http/protobuf", () => {
    vi.stubEnv("OTEL_EXPORTER_OTLP_ENDPOINT", "http://collector:4318/");
    const sink = withDefaults({ enabled: true, sink: otlpSink({ semconv: "gen_ai" }) }).sink;
    expect(sink).toMatchObject({ type: "otlp", endpoint: "http://collector:4318/v1/traces" });
    expect((sink as any).exporter).toMatchObject({ protocol: "http/protobuf", semconv: "gen_ai" });
  });

  it("an explicitly empty endpoint, or none anywhere, falls back to the file sink with a warning", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    expect(withDefaults({ enabled: true, sink: otlpSink("   ") }).sink.type).toBe("file");
    expect(withDefaults({ enabled: true, sink: otlpSink() }).sink.type).toBe("file");
    expect(warn).toHaveBeenCalledTimes(2);
  });

  it("OTEL_SDK_DISABLED in env-driven mode makes exports a skipped no-op", async () => {
    vi.stubEnv("OTEL_SDK_DISABLED", "true");
    const fetch = async () => {
      throw new Error("must not be called");
    };
    const exporter = createOtlpExporter({ fetch });
    const result = await exporter.exportSession((await import("./helpers.js")).loadSession("run-success"), { terminal: true });
    expect(result).toMatchObject({ ok: true, skipped: true, spans: 0 });
  });

  it("OTEL_SDK_DISABLED is ignored with an explicit endpoint", async () => {
    vi.stubEnv("OTEL_SDK_DISABLED", "true");
    const calls: string[] = [];
    const fetch = async (url: string) => {
      calls.push(url);
      return { ok: true, status: 200, statusText: "OK", text: async () => "", headers: { get: () => null } };
    };
    const result = await createOtlpExporter({ endpoint: "http://x/v1/traces", fetch }).exportSession((await import("./helpers.js")).loadSession("run-success"), { terminal: true });
    expect(result.ok).toBe(true);
    expect(calls).toEqual(["http://x/v1/traces"]);
  });
});
