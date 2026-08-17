/**
 * Unit tests for per-model-call structured-output contract emission.
 *
 * The `response_format` section records WHETHER the model was required to
 * return JSON on one ai_call and against WHICH schema — carried per event
 * (a run can enforce a schema on its final turn only) and matching the
 * Cognipeer console ingest contract (kind, label, type, schema, caps).
 */

import { describe, it, expect } from "vitest";
import { createTraceSession, recordTraceEvent, buildResponseFormatSection } from "../../src/utils/tracing.js";
import type { SmartAgentOptions, TraceResponseFormatSection, TracingConfig } from "../../src/types.js";

function makeSession(logData: boolean) {
  const tracing: TracingConfig = {
    enabled: true,
    mode: "batched",
    logData,
    sink: { type: "file" },
  };
  const opts: SmartAgentOptions = {
    model: { id: "test-model", provider: "test-provider" } as SmartAgentOptions["model"],
    tracing,
  };
  const session = createTraceSession(opts);
  expect(session).toBeDefined();
  return session!;
}

const SCHEMA = {
  type: "object",
  properties: { total: { type: "number" }, currency: { type: "string" } },
  required: ["total", "currency"],
  additionalProperties: false,
};

/** Exactly the shape `NativeJsonSchemaStrategy.buildResponseFormat()` returns. */
const INVOKE_ENVELOPE = {
  response_format: {
    type: "json_schema",
    json_schema: { name: "invoice_v2", strict: true, schema: SCHEMA },
  },
};

function findFormatSection(sections: Array<{ kind: string }> | undefined): TraceResponseFormatSection | undefined {
  return sections?.find((s) => s.kind === "response_format") as TraceResponseFormatSection | undefined;
}

describe("response_format trace section", () => {
  it("unwraps the invoke-options envelope the SDK actually passes", () => {
    const section = buildResponseFormatSection(INVOKE_ENVELOPE, "native");
    expect(section).toMatchObject({
      kind: "response_format",
      type: "json_schema",
      strategy: "native",
      schemaName: "invoice_v2",
      strict: true,
      schema: SCHEMA,
    });
  });

  it("accepts a bare response_format object too", () => {
    const section = buildResponseFormatSection(INVOKE_ENVELOPE.response_format);
    expect(section?.type).toBe("json_schema");
    expect(section?.schemaName).toBe("invoice_v2");
    expect(section?.strategy).toBeUndefined();
  });

  it("records json_object mode, which has no schema at all", () => {
    const section = buildResponseFormatSection({ type: "json_object" }, "native");
    expect(section).toMatchObject({ type: "json_object", strategy: "native" });
    expect(section?.schema).toBeUndefined();
  });

  it("snapshots the schema instead of aliasing the caller's object", () => {
    const mutable = { type: "object", properties: { a: { type: "string" } } } as Record<string, any>;
    const section = buildResponseFormatSection({ type: "json_schema", json_schema: { name: "n", schema: mutable } });
    mutable.properties.a.type = "number";
    expect((section!.schema as any).properties.a.type).toBe("string");
  });

  it("appends the contract alongside message and tool-menu sections", () => {
    const session = makeSession(true);
    const event = recordTraceEvent(session, {
      type: "ai_call",
      messageList: [{ role: "user", content: "total this invoice" }],
      toolDefinitions: [{ name: "lookup_rate" }],
      responseFormat: INVOKE_ENVELOPE,
      responseFormatStrategy: "native",
    });
    const sections = event?.data?.sections;
    expect(sections?.some((s) => s.kind === "message")).toBe(true);
    expect(sections?.some((s) => s.kind === "tool_definitions")).toBe(true);
    const format = findFormatSection(sections);
    expect(format?.label).toContain("Response Format");
    expect(format?.schemaName).toBe("invoice_v2");
    expect(format?.strategy).toBe("native");
  });

  it("does not duplicate an explicitly supplied response_format section", () => {
    const session = makeSession(true);
    const event = recordTraceEvent(session, {
      type: "ai_call",
      sections: [{ kind: "response_format", label: "Response Format", type: "json_object" }],
      responseFormat: INVOKE_ENVELOPE,
    });
    const formats = event?.data?.sections?.filter((s) => s.kind === "response_format") ?? [];
    expect(formats).toHaveLength(1);
    expect((formats[0] as TraceResponseFormatSection).type).toBe("json_object");
  });

  it("suppresses the contract entirely when logData is off", () => {
    const session = makeSession(false);
    const event = recordTraceEvent(session, {
      type: "ai_call",
      messageList: [{ role: "user", content: "hi" }],
      responseFormat: INVOKE_ENVELOPE,
    });
    expect(event?.data).toBeUndefined();
  });

  it("drops an oversized schema but keeps the contract's identity", () => {
    const giant = "x".repeat(70 * 1024);
    const section = buildResponseFormatSection({
      type: "json_schema",
      json_schema: { name: "huge", strict: true, schema: { type: "object", description: giant } },
    }, "native");
    expect(section?.schema).toBeUndefined();
    expect(section?.truncated).toBe(true);
    expect(section?.schemaName).toBe("huge");
    expect(section?.strict).toBe(true);
  });

  it("returns undefined when there is no contract to record", () => {
    expect(buildResponseFormatSection(undefined)).toBeUndefined();
    expect(buildResponseFormatSection({})).toBeUndefined();
    expect(buildResponseFormatSection({ response_format: {} })).toBeUndefined();
  });
});
