import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { decodeExportTraceServiceResponse, encodeExportTraceServiceRequest } from "../../../src/utils/otlp/protobuf.js";
import { sessionToOtlp } from "../../../src/utils/otlp/convert.js";
import type { OtlpExportTraceServiceRequest, OtlpAnyValue } from "../../../src/utils/otlp/types.js";
import { FIXTURES, loadSession } from "./helpers.js";
import { decodeRequest, encodeResponse } from "./protoDecode.js";

/** Every encoder branch in one request. */
function allFields(): OtlpExportTraceServiceRequest {
  const trace = "0af7651916cd43dd8448eb211c80319c";
  const value = (v: OtlpAnyValue) => ({ key: "k", value: v });
  return {
    resourceSpans: [
      {
        resource: { attributes: [{ key: "service.name", value: { stringValue: "svc" } }] },
        scopeSpans: [
          {
            scope: { name: "cognipeer-agent-sdk", version: "1.2.3" },
            spans: [
              {
                traceId: trace,
                spanId: "b7ad6b7169203331",
                parentSpanId: "00f067aa0ba902b7",
                traceState: "vendor=x,other=y",
                flags: 0x301,
                name: "invoke_agent Everything",
                kind: 3,
                startTimeUnixNano: "1792411205110500000",
                endTimeUnixNano: "1792411205123000000",
                attributes: [
                  value({ stringValue: "" }),
                  value({ stringValue: "héllo \u{1F600}" }),
                  value({ boolValue: false }),
                  value({ boolValue: true }),
                  value({ intValue: "0" }),
                  value({ intValue: "127" }),
                  value({ intValue: "128" }),
                  value({ intValue: "2147483648" }),
                  value({ intValue: "9007199254740993" }),
                  value({ intValue: "-1" }),
                  value({ intValue: "-9223372036854775808" }),
                  value({ doubleValue: 0 }),
                  value({ doubleValue: -1.5e-7 }),
                  value({ bytesValue: Buffer.from([0, 1, 2, 255]).toString("base64") }),
                  value({ arrayValue: { values: [{ stringValue: "a" }, { intValue: "2" }, { arrayValue: { values: [] } }] } }),
                  value({ kvlistValue: { values: [{ key: "n", value: { kvlistValue: { values: [{ key: "deep", value: { boolValue: false } }] } } }] } }),
                ],
                events: [
                  {
                    timeUnixNano: "1792411205123000000",
                    name: "exception",
                    attributes: [{ key: "exception.message", value: { stringValue: "boom" } }],
                  },
                ],
                status: { code: 2, message: "boom" },
              },
              {
                traceId: trace,
                spanId: "1111111111111111",
                parentSpanId: "",
                flags: 0x101,
                name: "plain",
                kind: 1,
                startTimeUnixNano: "1",
                endTimeUnixNano: "1",
                attributes: [],
                status: { code: 0 },
              },
            ],
          },
        ],
        schemaUrl: "https://opentelemetry.io/schemas/1.40.0",
      },
    ],
  };
}

describe("OTLP/protobuf encoder", () => {
  it("decodes (protobufjs, vendored opentelemetry-proto) to exactly the JSON model", () => {
    const request = allFields();
    expect(decodeRequest(encodeExportTraceServiceRequest(request))).toEqual(request);
  });

  it("the all-fields request encodes to the committed bytes", () => {
    const hex = Buffer.from(encodeExportTraceServiceRequest(allFields())).toString("hex");
    const file = path.join(FIXTURES, "all-fields.pb.hex");
    if (process.env.UPDATE_OTLP_GOLDEN === "1") {
      fs.writeFileSync(file, `${hex}\n`);
      fs.writeFileSync(path.join(FIXTURES, "all-fields.json"), `${JSON.stringify(allFields(), null, 2)}\n`);
    }
    expect(hex).toBe(fs.readFileSync(file, "utf8").trim());
    expect(JSON.parse(fs.readFileSync(path.join(FIXTURES, "all-fields.json"), "utf8"))).toEqual(allFields());
  });

  it("round-trips every converted golden fixture", () => {
    for (const name of ["run-success", "run-error", "legs-paused.leg1", "legs-paused.leg2", "subagent-pending.leg1", "subagent-pending.leg2"]) {
      const file = loadSession(name);
      const request = sessionToOtlp(file, { semconv: "both", terminal: file.status !== "paused" && file.status !== "in_progress" });
      expect(decodeRequest(encodeExportTraceServiceRequest(request)), name).toEqual(request);
    }
  });

  it("writes false, 0 and the empty string: oneof members are values, not defaults", () => {
    const one = (v: OtlpAnyValue): OtlpExportTraceServiceRequest => ({
      resourceSpans: [{ resource: { attributes: [{ key: "k", value: v }] }, scopeSpans: [] }],
    });
    for (const v of [{ stringValue: "" }, { boolValue: false }, { intValue: "0" }, { doubleValue: 0 }]) {
      const decoded = decodeRequest(encodeExportTraceServiceRequest(one(v)));
      expect(decoded.resourceSpans[0].resource.attributes[0].value).toEqual(v);
    }
  });

  it("varints: 0, 127, 128, 2^31, 2^53+1 and -1 (ten bytes)", () => {
    const encodeInt = (n: string) =>
      Buffer.from(
        encodeExportTraceServiceRequest({
          resourceSpans: [{ resource: { attributes: [{ key: "k", value: { intValue: n } }] }, scopeSpans: [] }],
        }),
      );
    // Resource message ends with: tag(0x18=field 3 varint) + varint; the request is wrapped in two length prefixes.
    const tail = (n: string) => encodeInt(n).toString("hex");
    expect(tail("0").endsWith("1800")).toBe(true);
    expect(tail("127").endsWith("187f")).toBe(true);
    expect(tail("128").endsWith("188001")).toBe(true);
    expect(tail("2147483648").endsWith("18" + "80".repeat(4) + "08")).toBe(true);
    expect(tail("9007199254740993").endsWith("18" + "81" + "80".repeat(6) + "10")).toBe(true);
    expect(tail("-1").endsWith("18" + "ffffffffffffffffff01")).toBe(true);
    for (const n of ["0", "127", "128", "2147483648", "9007199254740993", "-1", "-9223372036854775808", "9223372036854775807"]) {
      const decoded = decodeRequest(encodeInt(n));
      expect(decoded.resourceSpans[0].resource.attributes[0].value.intValue, n).toBe(n);
    }
  });

  it("Span.flags is a fixed32 and start/end are fixed64 (little endian)", () => {
    const bytes = Buffer.from(encodeExportTraceServiceRequest(allFields()));
    // flags field 16, wire type 5: tag 0x85 0x01, then 4 little-endian bytes of 0x301.
    expect(bytes.includes(Buffer.from([0x85, 0x01, 0x01, 0x03, 0x00, 0x00]))).toBe(true);
    // start field 7, wire type 1: tag 0x39 then 8 bytes.
    expect(bytes.includes(Buffer.concat([Buffer.from([0x39]), Buffer.from((1792411205110500000n).toString(16).padStart(16, "0"), "hex").reverse()]))).toBe(true);
  });

  it("decodes ExportTracePartialSuccess (rejected_spans, error_message) from a response", () => {
    expect(decodeExportTraceServiceResponse(encodeResponse({ rejectedSpans: 2, errorMessage: "bad spans" }))).toEqual({ rejectedSpans: 2, message: "bad spans" });
    expect(decodeExportTraceServiceResponse(encodeResponse(undefined))).toBeUndefined();
    expect(decodeExportTraceServiceResponse(new Uint8Array(0))).toBeUndefined();
    expect(() => decodeExportTraceServiceResponse(new Uint8Array([0x0a, 0x05, 0x01]))).toThrow();
  });
});
