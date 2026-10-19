import { describe, expect, it } from "vitest";
import {
  CAPTURE,
  attachCapturedContent,
  buildCapturedContent,
  capturedContentOf,
  contentAttributes,
  resolveContentOptions,
} from "../../../src/utils/otlp/content.js";
import { sessionToOtlp } from "../../../src/utils/otlp/convert.js";
import type { OtlpContentOptions } from "../../../src/utils/otlp/types.js";
import type { TraceEventRecord, TraceSessionFile } from "../../../src/types.js";
import { attrsOf, spansOf } from "./helpers.js";

// What a session holds: the export cap (4096) with headroom, so a hook sees secrets whole.
const LIMITS = { maxStringChars: 4096 * 4, maxMessages: 32 };
const opts = (content: OtlpContentOptions | boolean = true) => resolveContentOptions(content);
const json = (attrs: Record<string, any>, key: string) => JSON.parse(attrs[key]);

const conversation = [
  { role: "system", content: "You are terse." },
  { role: "user", content: "What is 2+2?" },
  {
    role: "assistant",
    content: "",
    tool_calls: [
      { id: "call_real", type: "function", function: { name: "calc", arguments: '{"a":2,"b":2}' } },
      { id: "calc_1", idSynthesized: true, type: "function", function: { name: "calc", arguments: "{}" } },
    ],
  },
  { role: "tool", tool_call_id: "call_real", name: "calc", content: '{"sum":4}' },
];

function recordWith(capture: Parameters<typeof buildCapturedContent>[0], over: Partial<TraceEventRecord> = {}) {
  const record = { type: "ai_call", spanId: "a".repeat(16), model: "m", provider: "openai", ...over } as TraceEventRecord;
  attachCapturedContent(record, buildCapturedContent(capture, LIMITS));
  return record;
}

describe("options", () => {
  it("are off by default and fill in the documented defaults", () => {
    expect(resolveContentOptions(undefined).enabled).toBe(false);
    expect(resolveContentOptions(false).enabled).toBe(false);
    expect(resolveContentOptions({}).enabled).toBe(false);
    expect(resolveContentOptions(true)).toMatchObject({
      enabled: true,
      maxStringChars: 4096,
      maxMessages: 32,
      maxAttributeBytes: 32768,
      encoding: "json",
      include: ["system", "input", "output", "tools", "toolArgs", "toolResults", "sections"],
    });
    expect(resolveContentOptions({ enabled: true, maxMessages: 0, maxStringChars: -1 })).toMatchObject({ maxMessages: 32, maxStringChars: 4096 });
  });
});

describe("what is captured", () => {
  it("splits system messages from the input and turns tool calls and results into GenAI parts", () => {
    const captured = buildCapturedContent({ input: conversation }, LIMITS);
    expect(captured.system).toEqual([{ type: "text", content: "You are terse." }]);
    expect(captured.input).toEqual([
      { role: "user", parts: [{ type: "text", content: "What is 2+2?" }] },
      {
        role: "assistant",
        parts: [
          { type: "tool_call", id: "call_real", name: "calc", arguments: { a: 2, b: 2 } },
          // An id the SDK made up is not passed off as the provider's.
          { type: "tool_call", name: "calc", arguments: {} },
        ],
      },
      { role: "tool", name: "calc", parts: [{ type: "tool_call_response", id: "call_real", response: { sum: 4 } }] },
    ]);
  });

  it("never captures reasoning parts, thinking blocks or base64 payloads", () => {
    const captured = buildCapturedContent(
      {
        input: [
          {
            role: "user",
            content: [
              { type: "text", text: "look" },
              { type: "image_url", image_url: { url: "data:image/png;base64,AAAA" + "B".repeat(5000) } },
            ],
          },
        ],
        output: {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "SECRET CHAIN OF THOUGHT" },
            { type: "text", text: "answer" },
          ],
          reasoning: { summary: "ALSO SECRET" },
        },
      },
      LIMITS,
    );
    const text = JSON.stringify(captured);
    expect(text).not.toContain("SECRET");
    expect(text).not.toContain("BBBB");
    expect(text).toContain("[image");
    expect(captured.output).toEqual({ role: "assistant", parts: [{ type: "text", content: "answer" }] });
  });

  it("coerces tool arguments to an object and wraps scalar results", () => {
    expect(buildCapturedContent({ toolArguments: '{"a":1}' }, LIMITS).toolArgs).toEqual({ a: 1 });
    expect(buildCapturedContent({ toolArguments: { a: 1 } }, LIMITS).toolArgs).toEqual({ a: 1 });
    expect(buildCapturedContent({ toolResult: "ok", hasToolResult: true }, LIMITS).toolResults).toEqual({ value: "ok" });
    expect(buildCapturedContent({ toolResult: [1, 2], hasToolResult: true }, LIMITS).toolResults).toEqual({ value: [1, 2] });
    expect(buildCapturedContent({ toolResult: { x: 1 }, hasToolResult: true }, LIMITS).toolResults).toEqual({ x: 1 });
  });

  it("a tool that did not complete has no result", () => {
    expect(buildCapturedContent({ toolArguments: { a: 1 } }, LIMITS)).not.toHaveProperty("toolResults");
  });

  it("is a copy: changing the transcript afterwards does not change it", () => {
    const messages: any[] = [{ role: "user", content: "before" }];
    const captured = buildCapturedContent({ input: messages }, LIMITS);
    messages[0].content = "after";
    messages.push({ role: "user", content: "later" });
    expect(captured.input).toEqual([{ role: "user", parts: [{ type: "text", content: "before" }] }]);
  });

  it("holds only what any exporter could still ask for", () => {
    const many = Array.from({ length: 100 }, (_, i) => ({ role: "user", content: `m${i}` }));
    const captured = buildCapturedContent({ input: many }, { maxStringChars: 10, maxMessages: 32 });
    expect(captured.input).toHaveLength(32);
    expect((captured.input![0].parts[0] as any).content).toBe("m68");
    expect(JSON.stringify(buildCapturedContent({ input: [{ role: "user", content: "x".repeat(50) }] }, { maxStringChars: 10, maxMessages: 32 }))).toContain("...[truncated 40 chars]");
  });

  it("survives unserialisable tool data instead of failing the run", () => {
    const cyclic: any = {};
    cyclic.self = cyclic;
    expect(() => buildCapturedContent({ toolArguments: cyclic, toolResult: cyclic, hasToolResult: true }, LIMITS)).not.toThrow();
  });
});

describe("the side channel", () => {
  it("is invisible to JSON, keys, spread and clones, and still readable by the exporter", () => {
    const record = recordWith({ input: conversation });
    expect(capturedContentOf(record)).toBeDefined();
    expect(JSON.stringify(record)).not.toContain("tool_call_response");
    expect(Object.keys(record)).not.toContain(String(CAPTURE));
    expect(Object.getOwnPropertySymbols({ ...record })).toEqual([]);
    expect(JSON.parse(JSON.stringify(record))).not.toHaveProperty("capture");
    expect(capturedContentOf(JSON.parse(JSON.stringify(record)))).toBeUndefined();
  });
});

describe("attributes", () => {
  it("none unless enabled", () => {
    const record = recordWith({ input: conversation });
    expect(contentAttributes("chat", record, "openai", opts(false))).toEqual([]);
    expect(contentAttributes("chat", record, "openai", undefined)).toEqual([]);
  });

  it("chat: input / output / tool definitions; system stays in the messages for a provider that takes it inline", () => {
    const record = recordWith(
      {
        input: conversation,
        output: { role: "assistant", content: "four" },
        toolDefinitions: [{ name: "calc", description: "adds", parameters: { type: "object" } }],
      },
      { finishReason: "stop" },
    );
    const attrs = attrsOf({ attributes: contentAttributes("chat", record, "openai", opts()) });
    expect(Object.keys(attrs).sort()).toEqual(["gen_ai.input.messages", "gen_ai.output.messages", "gen_ai.tool.definitions"]);
    const input = json(attrs, "gen_ai.input.messages");
    expect(input[0]).toEqual({ role: "system", parts: [{ type: "text", content: "You are terse." }] });
    expect(input).toHaveLength(4);
    expect(json(attrs, "gen_ai.output.messages")).toEqual([{ role: "assistant", parts: [{ type: "text", content: "four" }], finish_reason: "stop" }]);
    expect(json(attrs, "gen_ai.tool.definitions")).toEqual([{ type: "function", name: "calc", description: "adds", parameters: { type: "object" } }]);
  });

  it.each(["anthropic", "aws.bedrock", "gcp.vertex_ai", "gcp.gemini"])("chat on %s: system instructions are split out of the messages", (provider) => {
    const record = recordWith({ input: conversation });
    const attrs = attrsOf({ attributes: contentAttributes("chat", record, provider, opts()) });
    expect(json(attrs, "gen_ai.system_instructions")).toEqual([{ type: "text", content: "You are terse." }]);
    expect(json(attrs, "gen_ai.input.messages").map((m: any) => m.role)).toEqual(["user", "assistant", "tool"]);
  });

  it("output finish_reason uses the provider's word, tool_calls becoming tool_call", () => {
    const toolTurn = recordWith({ output: { role: "assistant", content: "" } }, { finishReason: "tool_calls" });
    expect(json(attrsOf({ attributes: contentAttributes("chat", toolTurn, "openai", opts()) }), "gen_ai.output.messages")[0].finish_reason).toBe("tool_call");
    const raw = recordWith({ output: { role: "assistant", content: "x" } }, { finishReason: "stop", rawFinishReason: "end_turn" });
    expect(json(attrsOf({ attributes: contentAttributes("chat", raw, "anthropic", opts()) }), "gen_ai.output.messages")[0].finish_reason).toBe("end_turn");
  });

  it("execute_tool: arguments and result", () => {
    const record = recordWith({ toolArguments: { a: 1 }, toolResult: "ok", hasToolResult: true }, { type: "tool_call", actor: { name: "calc" } });
    const attrs = attrsOf({ attributes: contentAttributes("execute_tool", record, undefined, opts()) });
    expect(json(attrs, "gen_ai.tool.call.arguments")).toEqual({ a: 1 });
    expect(json(attrs, "gen_ai.tool.call.result")).toEqual({ value: "ok" });
    const failed = recordWith({ toolArguments: { a: 1 } }, { type: "tool_call", actor: { name: "calc" } });
    expect(Object.keys(attrsOf({ attributes: contentAttributes("execute_tool", failed, undefined, opts()) }))).toEqual(["gen_ai.tool.call.arguments"]);
  });

  it("include limits the set", () => {
    const record = recordWith({ input: conversation, output: { role: "assistant", content: "four" }, toolDefinitions: [{ name: "calc" }] });
    const attrs = attrsOf({ attributes: contentAttributes("chat", record, "anthropic", opts({ enabled: true, include: ["output"] })) });
    expect(Object.keys(attrs)).toEqual(["gen_ai.output.messages"]);
  });

  describe("caps", () => {
    it("a 10000-char text is cut to 4096 chars and marked", () => {
      const record = recordWith({ input: [{ role: "user", content: "x".repeat(10_000) }] });
      const input = json(attrsOf({ attributes: contentAttributes("chat", record, "openai", opts()) }), "gen_ai.input.messages");
      expect(input[0].parts[0].content).toBe(`${"x".repeat(4096)}...[truncated 5904 chars]`);
    });

    it("100 messages keep the most recent 32", () => {
      const many = Array.from({ length: 100 }, (_, i) => ({ role: "user", content: `m${i}` }));
      const record = attachCaptured({ input: many });
      const input = json(attrsOf({ attributes: contentAttributes("chat", record, "anthropic", opts()) }), "gen_ai.input.messages");
      expect(input).toHaveLength(32);
      expect(input[0].parts[0].content).toBe("m68");
      expect(input[31].parts[0].content).toBe("m99");
    });

    it("an attribute over the byte cap drops whole messages, oldest first, and is always valid JSON", () => {
      const msgs = Array.from({ length: 10 }, (_, i) => ({ role: "user", content: `${i}`.repeat(1000) }));
      const record = attachCaptured({ input: msgs });
      const value = contentAttributes("chat", record, "anthropic", opts({ enabled: true, maxAttributeBytes: 3500 }))[0].value.stringValue!;
      expect(Buffer.byteLength(value)).toBeLessThanOrEqual(3500);
      const parsed = JSON.parse(value);
      expect(parsed.length).toBeLessThan(10);
      expect(parsed[parsed.length - 1].parts[0].content.startsWith("9")).toBe(true);
    });

    it("what cannot be made to fit becomes {\"truncated\":true}, never a sliced string", () => {
      const record = attachCaptured({ output: { role: "assistant", content: "y".repeat(4000) } });
      const attrs = contentAttributes("chat", record, "openai", opts({ enabled: true, maxAttributeBytes: 500 }));
      expect(attrs[0].value.stringValue).toBe('{"truncated":true}');
    });
  });

  describe("redaction", () => {
    it("runs before the caps, per field, and the stored record is unchanged", () => {
      const record = recordWith({ input: [{ role: "user", content: "my key is sk-abcdef0123456789" }] });
      const seen: string[] = [];
      const attrs = contentAttributes("chat", record, "openai", opts({
        enabled: true,
        redact: (value, info) => {
          seen.push(info.field);
          return JSON.parse(JSON.stringify(value).replace(/sk-[a-z0-9]+/g, "[REDACTED]"));
        },
      }));
      expect(seen).toEqual(["input"]);
      expect(attrs[0].value.stringValue).toContain("[REDACTED]");
      expect(attrs[0].value.stringValue).not.toContain("sk-abc");
      // The side channel still holds the original (the file sink never saw it anyway).
      expect(JSON.stringify(capturedContentOf(record))).toContain("sk-abcdef");
    });

    it("sees the value before it is capped", () => {
      const record = recordWith({ input: [{ role: "user", content: "z".repeat(10_000) }] });
      let length = 0;
      contentAttributes("chat", record, "openai", opts({ enabled: true, redact: (value) => { length = JSON.stringify(value).length; return value; } }));
      expect(length).toBeGreaterThan(5000);
    });

    it("gets a private copy: mutating it changes nothing", () => {
      const record = recordWith({ input: [{ role: "user", content: "keep me" }] });
      contentAttributes("chat", record, "openai", opts({ enabled: true, redact: (value: any) => { value[0].parts[0].content = "mutated"; return value; } }));
      expect(JSON.stringify(capturedContentOf(record))).toContain("keep me");
    });

    it("tells the hook the field, the event, the span, the tool and the model", () => {
      const record = recordWith({ toolArguments: { a: 1 }, hasToolResult: true, toolResult: 1 }, { type: "tool_call", actor: { name: "calc" }, model: undefined });
      const infos: any[] = [];
      contentAttributes("execute_tool", record, undefined, opts({ enabled: true, redact: (v, info) => { infos.push(info); return v; } }));
      expect(infos).toEqual([
        { field: "toolArgs", eventType: "tool_call", spanId: "a".repeat(16), toolName: "calc" },
        { field: "toolResults", eventType: "tool_call", spanId: "a".repeat(16), toolName: "calc" },
      ]);
    });

    it("null or undefined drops the field; a throw drops only that field (fail closed)", () => {
      const record = recordWith({ input: [{ role: "user", content: "a" }], output: { role: "assistant", content: "b" } });
      const dropOutput = contentAttributes("chat", record, "openai", opts({ enabled: true, redact: (v, info) => (info.field === "output" ? null : v) }));
      expect(dropOutput.map((a) => a.key)).toEqual(["gen_ai.input.messages"]);
      const throwOnInput = contentAttributes("chat", record, "openai", opts({
        enabled: true,
        redact: (v, info) => {
          if (info.field === "input") throw new Error("boom");
          return v;
        },
      }));
      expect(throwOnInput.map((a) => a.key)).toEqual(["gen_ai.output.messages"]);
    });
  });

  describe("encoding", () => {
    it("json (default) is a string; structured is OTLP arrays and maps", () => {
      const record = recordWith({ toolArguments: { a: 1, nested: { ok: true }, list: ["x"] } }, { type: "tool_call" });
      const asJson = contentAttributes("execute_tool", record, undefined, opts())[0].value;
      expect(typeof asJson.stringValue).toBe("string");
      const structured = contentAttributes("execute_tool", record, undefined, opts({ enabled: true, encoding: "structured" }))[0].value;
      expect(structured.kvlistValue).toBeDefined();
      expect(structured.stringValue).toBeUndefined();
      const byKey = Object.fromEntries(structured.kvlistValue!.values.map((kv) => [kv.key, kv.value]));
      expect(byKey.a).toEqual({ intValue: "1" });
      expect(byKey.nested.kvlistValue!.values).toEqual([{ key: "ok", value: { boolValue: true } }]);
      expect(byKey.list.arrayValue!.values).toEqual([{ stringValue: "x" }]);
    });
  });
});

describe("in the converter", () => {
  const file = (events: Array<Partial<TraceEventRecord>>): TraceSessionFile => ({
    sessionId: "s",
    traceId: "a".repeat(32),
    rootSpanId: "c".repeat(16),
    startedAt: "2026-10-19T12:00:00.000Z",
    endedAt: "2026-10-19T12:00:10.000Z",
    durationMs: 10_000,
    agent: { name: "A", model: "m" },
    config: { enabled: true, logData: false, sink: { type: "custom" } },
    summary: { totalDurationMs: 0, totalInputTokens: 0, totalOutputTokens: 0, totalCachedInputTokens: 0, totalBytesIn: 0, totalBytesOut: 0, eventCounts: {} },
    // Defaults go onto the record itself: a spread would drop the non-enumerable side channel.
    events: events.map((e, i) => Object.assign(e, {
      sessionId: "s", id: `e${i}`, type: "ai_call", label: `L #${i + 1}`, sequence: i + 1, spanId: `${i + 1}`.padStart(16, "b"),
      parentSpanId: "c".repeat(16), timestamp: "2026-10-19T12:00:05.000Z", status: "success", ...e,
    })) as TraceEventRecord[],
    status: "success",
    errors: [],
  });

  it("content attributes are on chat and execute_tool spans only when enabled, whatever logData says", () => {
    const chat = recordWith({ input: conversation, output: { role: "assistant", content: "four" } }, { model: "m" });
    const off = spansOf(sessionToOtlp(file([chat]), { semconv: "both", terminal: true }));
    expect(off.flatMap((s) => Object.keys(attrsOf(s))).filter((k) => /gen_ai\.(input|output|system|tool\.(definitions|call\.(arguments|result)))/.test(k))).toEqual([]);

    const on = spansOf(sessionToOtlp(file([chat]), { semconv: "both", terminal: true, content: opts() }));
    const chatSpan = on.find((s) => s.name === "chat m")!;
    expect(Object.keys(attrsOf(chatSpan))).toEqual(expect.arrayContaining(["gen_ai.input.messages", "gen_ai.output.messages"]));
    // Not in cognipeer-only mode: it is a GenAI vocabulary feature.
    const cognipeerOnly = spansOf(sessionToOtlp(file([chat]), { semconv: "cognipeer", terminal: true, content: opts() }));
    expect(cognipeerOnly.flatMap((s) => Object.keys(attrsOf(s))).filter((k) => k.startsWith("gen_ai."))).toEqual([]);
  });

  it("a blocked or short-circuited call, which never reached a provider, carries no content", () => {
    const blocked = recordWith({ input: conversation }, { skipReason: "blocked", status: "skipped" });
    const spans = spansOf(sessionToOtlp(file([blocked]), { semconv: "both", terminal: true, content: opts() }));
    expect(spans.flatMap((s) => Object.keys(attrsOf(s))).filter((k) => k.startsWith("gen_ai.input"))).toEqual([]);
  });
});

function attachCaptured(capture: Parameters<typeof buildCapturedContent>[0]) {
  return recordWith(capture);
}
