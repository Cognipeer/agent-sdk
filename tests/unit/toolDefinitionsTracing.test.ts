/**
 * Unit tests for per-model-call tool-menu emission on trace events.
 *
 * The `tool_definitions` section records WHICH tools the model was offered on
 * one ai_call — carried per event (menus can change between iterations) and
 * matching the Cognipeer console ingest contract (kind, label, tools[], caps).
 */

import { describe, it, expect } from "vitest";
import { createTraceSession, recordTraceEvent, buildToolDefinitionsSection } from "../../src/utils/tracing.js";
import type { SmartAgentOptions, TraceToolDefinitionsSection, TracingConfig } from "../../src/types.js";

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

const MENU = [
  { name: "search_flights", description: "Search flights", parameters: { type: "object", properties: { city: { type: "string" } } } },
  { name: "book_flight", parameters: { type: "object", properties: { id: { type: "string" } } } },
];

function findMenuSection(sections: Array<{ kind: string }> | undefined): TraceToolDefinitionsSection | undefined {
  return sections?.find((s) => s.kind === "tool_definitions") as TraceToolDefinitionsSection | undefined;
}

describe("tool_definitions trace section", () => {
  it("appends the menu alongside auto-converted message sections", () => {
    const session = makeSession(true);
    const event = recordTraceEvent(session, {
      type: "ai_call",
      messageList: [
        { role: "user", content: "book me a flight" },
        { role: "assistant", content: "sure" },
      ],
      toolDefinitions: MENU,
    });
    const sections = event?.data?.sections;
    expect(sections?.some((s) => s.kind === "message")).toBe(true);
    const menu = findMenuSection(sections);
    expect(menu).toBeDefined();
    expect(menu!.label).toContain("Tool Definitions");
    expect(menu!.tools.map((t) => t.name)).toEqual(["search_flights", "book_flight"]);
    expect(menu!.tools[0].parameters).toEqual(MENU[0].parameters);
  });

  it("does not duplicate an explicitly supplied tool_definitions section", () => {
    const session = makeSession(true);
    const event = recordTraceEvent(session, {
      type: "ai_call",
      sections: [
        { kind: "tool_definitions", label: "Tool Definitions", tools: [{ name: "custom_tool" }] },
      ],
      toolDefinitions: MENU,
    });
    const menus = event?.data?.sections?.filter((s) => s.kind === "tool_definitions") ?? [];
    expect(menus).toHaveLength(1);
    expect((menus[0] as TraceToolDefinitionsSection).tools.map((t) => t.name)).toEqual(["custom_tool"]);
  });

  it("suppresses the menu entirely when logData is off", () => {
    const session = makeSession(false);
    const event = recordTraceEvent(session, {
      type: "ai_call",
      messageList: [{ role: "user", content: "hi" }],
      toolDefinitions: MENU,
    });
    expect(event?.data).toBeUndefined();
  });

  it("caps oversized menus: drops parameters first, marks truncation", () => {
    const giant = "x".repeat(70 * 1024);
    const section = buildToolDefinitionsSection([
      { name: "big_tool", parameters: { type: "object", properties: { blob: { type: "string", description: giant } } } },
      { name: "small_tool", parameters: { type: "object", properties: {} } },
    ]);
    expect(section).toBeDefined();
    expect(section!.truncated).toBe(true);
    const big = section!.tools.find((t) => t.name === "big_tool");
    expect(big?.parameters).toBeUndefined();
    expect(big?.truncated).toBe(true);
    // The small tool's schema survives.
    expect(section!.tools.find((t) => t.name === "small_tool")?.parameters).toBeDefined();
  });

  it("enforces the 128-tool cap and skips nameless entries", () => {
    const many = Array.from({ length: 200 }, (_, i) => ({ name: `tool_${i}` }));
    const section = buildToolDefinitionsSection([{ name: "" }, ...many]);
    expect(section!.tools).toHaveLength(128);
    expect(section!.truncated).toBe(true);
  });

  it("returns undefined for an empty or unusable menu", () => {
    expect(buildToolDefinitionsSection([])).toBeUndefined();
    expect(buildToolDefinitionsSection([{ name: "" }])).toBeUndefined();
  });
});
