import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { sessionToOtlp } from "../../../src/utils/otlp/convert.js";
import { resolveContentOptions } from "../../../src/utils/otlp/content.js";
import { traceSessionToOtlp } from "../../../src/index.js";
import { genAiProviderName, errorTypeOf } from "../../../src/utils/otlp/semconv.js";
import type { OtlpConvertOptions, OtlpSemconv } from "../../../src/utils/otlp/types.js";
import type { TraceEventRecord, TraceSessionFile } from "../../../src/types.js";
import { FIXTURES, attrsOf, expectGolden, loadSession, resourceAttrsOf, spanByLabel, spansOf } from "./helpers.js";

const convert = (file: TraceSessionFile, semconv: OtlpSemconv = "both", extra: Partial<OtlpConvertOptions> = {}) =>
  sessionToOtlp(file, {
    semconv,
    terminal: file.status !== "paused" && file.status !== "in_progress",
    ...extra,
  });

const ns = (iso: string) => (BigInt(Date.parse(iso)) * 1_000_000n).toString();

/** A small session file around `events`. */
function fileOf(events: Array<Partial<TraceEventRecord>>, over: Partial<TraceSessionFile> = {}): TraceSessionFile {
  const full = events.map((e, i) => ({
    sessionId: "s",
    traceId: "t".repeat(32).replace(/t/g, "a"),
    id: `evt_${i + 1}`,
    type: "tool_call",
    label: `Event #${i + 1}`,
    sequence: i + 1,
    spanId: String(i + 1).padStart(16, "0").replace(/^0/, "b"),
    parentSpanId: "c".repeat(16),
    timestamp: "2026-10-19T12:00:05.000Z",
    status: "success",
    ...e,
  })) as TraceEventRecord[];
  return {
    sessionId: "s",
    traceId: "a".repeat(32),
    rootSpanId: "c".repeat(16),
    startedAt: "2026-10-19T12:00:00.000Z",
    endedAt: "2026-10-19T12:00:10.000Z",
    durationMs: 10_000,
    agent: { name: "Agent", model: "gpt-4o", provider: "openai" },
    config: { enabled: true, logData: true, sink: { type: "custom" } },
    summary: { totalDurationMs: 0, totalInputTokens: 0, totalOutputTokens: 0, totalCachedInputTokens: 0, totalBytesIn: 0, totalBytesOut: 0, eventCounts: { tool_call: full.length } },
    events: full,
    status: "success",
    errors: [],
    ...over,
  };
}

describe("golden fixtures", () => {
  const modes: OtlpSemconv[] = ["cognipeer", "gen_ai", "both"];
  for (const mode of modes) {
    it(`run-success in ${mode} mode matches its golden file`, () => {
      expectGolden(`run-success.${mode}.json`, convert(loadSession("run-success"), mode));
    });
  }
  it("run-error matches its golden file", () => {
    expectGolden("run-error.both.json", convert(loadSession("run-error")));
  });
  it("legs-paused: each leg matches its golden file", () => {
    expectGolden("legs-paused.leg1.both.json", convert(loadSession("legs-paused.leg1")));
    expectGolden("legs-paused.leg2.both.json", convert(loadSession("legs-paused.leg2")));
  });
  it("subagent-pending: each leg matches its golden file", () => {
    expectGolden("subagent-pending.leg1.both.json", convert(loadSession("subagent-pending.leg1")));
    expectGolden("subagent-pending.leg2.both.json", convert(loadSession("subagent-pending.leg2")));
  });
});

describe("run-success in both mode", () => {
  const request = convert(loadSession("run-success"));
  const spans = spansOf(request);

  it("names, kinds and operations follow the GenAI conventions", () => {
    const root = spans[0];
    expect(root.name).toBe("invoke_agent Support Agent");
    expect(root.kind).toBe(1);
    expect(attrsOf(root)).toMatchObject({
      "gen_ai.operation.name": "invoke_agent",
      "gen_ai.agent.name": "Support Agent",
      "gen_ai.agent.version": "1.2.0",
      "gen_ai.request.model": "gpt-4o",
      "gen_ai.conversation.id": "thread_42",
    });
    const chat = spanByLabel(request, "Assistant Response #2");
    expect(chat.name).toBe("chat gpt-4o");
    expect(chat.kind).toBe(3);
    const tool = spanByLabel(request, "Tool Execution - lookup_order #3");
    expect(tool.name).toBe("execute_tool lookup_order");
    expect(tool.kind).toBe(1);
    expect(attrsOf(tool)).toMatchObject({
      "gen_ai.operation.name": "execute_tool",
      "gen_ai.tool.name": "lookup_order",
      "gen_ai.tool.type": "function",
      "gen_ai.agent.name": "Support Agent",
    });
    // The iteration is plain bookkeeping: no operation, and no sequence number in its name.
    const iteration = spanByLabel(request, "Iteration 1 #1");
    expect(iteration.name).toBe("Iteration 1");
    expect(attrsOf(iteration)["gen_ai.operation.name"]).toBeUndefined();
  });

  it("every status is UNSET, every span local (flags 257), every parent resolves, array order is sequence order", () => {
    expect(spans.every((s) => s.status.code === 0)).toBe(true);
    expect(spans.every((s) => s.flags === 257)).toBe(true);
    const ids = new Set(spans.map((s) => s.spanId));
    for (const span of spans.slice(1)) expect(ids.has(span.parentSpanId), span.name).toBe(true);
    expect(spans[0].parentSpanId).toBe("");
    const sequences = spans.slice(1).map((s) => attrsOf(s)["cognipeer.event.sequence"]);
    expect(sequences).toEqual([...sequences].sort((a, b) => a - b));
  });

  it("chat spans carry normalized usage, finish reasons and the provider", () => {
    const chat = attrsOf(spanByLabel(request, "Assistant Response #2"));
    expect(chat).toMatchObject({
      "gen_ai.operation.name": "chat",
      "gen_ai.provider.name": "openai",
      "gen_ai.request.model": "gpt-4o",
      "gen_ai.response.finish_reasons": ["tool_calls"],
      "gen_ai.usage.input_tokens": 120,
      "gen_ai.usage.output_tokens": 30,
      "gen_ai.usage.cache_read.input_tokens": 40,
      "gen_ai.usage.reasoning.output_tokens": 5,
      "gen_ai.conversation.id": "thread_42",
    });
    // cache_write was not reported: absent, not zero.
    expect(chat["gen_ai.usage.cache_write.input_tokens"]).toBeUndefined();
    // The second call reported no cache hit: absent as well.
    expect(attrsOf(spanByLabel(request, "Assistant Response #5"))["gen_ai.usage.cache_read.input_tokens"]).toBeUndefined();
    // No usage on the root: children carry it, and backends sum across a trace.
    expect(Object.keys(attrsOf(spans[0])).filter((k) => k.startsWith("gen_ai.usage."))).toEqual([]);
  });

  it("the resource names the service and the SDK", () => {
    expect(resourceAttrsOf(request)).toMatchObject({
      "service.name": "Support Agent",
      "service.version": "1.2.0",
      "telemetry.sdk.name": "cognipeer-agent-sdk",
      "telemetry.sdk.language": "nodejs",
    });
    expect(request.resourceSpans[0].scopeSpans[0].scope.name).toBe("cognipeer-agent-sdk");
    // No schemaUrl: the pinned convention version is unpublished.
    expect((request.resourceSpans[0] as any).schemaUrl).toBeUndefined();
  });
});

describe("legacy cognipeer.* parity", () => {
  const legacy = JSON.parse(fs.readFileSync(path.join(FIXTURES, "legacy-keys.json"), "utf8"));
  const cognipeerOnly = (attrs: Record<string, any>) =>
    Object.fromEntries(Object.entries(attrs).filter(([key]) => key.startsWith("cognipeer.")));
  // The legacy capture read OTLP ints as strings and doubles as numbers: compare as text.
  const asLegacy = (attrs: Record<string, any>) => Object.fromEntries(Object.entries(attrs).map(([k, v]) => [k, String(v)]));
  const legacyText = (attrs: Record<string, any>) => Object.fromEntries(Object.entries(attrs).map(([k, v]) => [k, String(v)]));

  for (const name of ["run-success", "run-error"]) {
    for (const mode of ["cognipeer", "both"] as const) {
      it(`${name} in ${mode} mode keeps every legacy key and value; cognipeer.event.status is the one addition`, () => {
        // The legacy export carried the sections unconditionally; they are payload now, so parity holds with content capture on.
        const request = convert(loadSession(name), mode, { content: resolveContentOptions(true) });
        const spans = spansOf(request);
        const expected = legacy[name];
        expect(asLegacy(cognipeerOnly(resourceAttrsOf(request)))).toEqual(legacyText(expected.resource));

        const root = asLegacy(cognipeerOnly(attrsOf(spans[0])));
        // event_count is the cumulative total now; the same number for a session without earlier parts.
        expect(root).toEqual(legacyText(expected.root));

        for (const span of spans.slice(1)) {
          const attrs = asLegacy(cognipeerOnly(attrsOf(span)));
          const status = attrs["cognipeer.event.status"];
          delete attrs["cognipeer.event.status"];
          expect(status).toBeDefined();
          expect(attrs, span.name).toEqual(legacyText(expected.events[span.spanId]));
        }
      });
    }
  }
});

describe("vocabulary isolation", () => {
  const request = (mode: OtlpSemconv) => convert(loadSession("run-error"), mode);
  const everyKey = (req: any) => [
    ...req.resourceSpans[0].resource.attributes.map((a: any) => a.key),
    ...spansOf(req).flatMap((s) => [
      ...s.attributes.map((a) => a.key),
      ...(s.events ?? []).flatMap((e) => e.attributes.map((a) => a.key)),
    ]),
  ] as string[];

  it("gen_ai mode emits no cognipeer.* key anywhere", () => {
    expect(everyKey(request("gen_ai")).filter((k) => k.startsWith("cognipeer."))).toEqual([]);
  });

  it("cognipeer mode emits no gen_ai.* and no error.type key, and uses the legacy names", () => {
    const req = request("cognipeer");
    expect(everyKey(req).filter((k) => k.startsWith("gen_ai.") || k === "error.type")).toEqual([]);
    expect(spansOf(req)[0].name).toBe("agent_session: Support Agent");
    expect(spanByLabel(req, "Assistant Error #7").name).toBe("Assistant Error #7");
  });
});

describe("honest timing", () => {
  it("a record is stamped at completion: start = timestamp - durationMs, end = timestamp", () => {
    const file = fileOf([{ type: "ai_call", label: "Assistant Response #1", timestamp: "2026-10-19T12:00:05.000Z", durationMs: 2000 }]);
    const span = spansOf(convert(file))[1];
    expect(span.startTimeUnixNano).toBe(ns("2026-10-19T12:00:03.000Z"));
    expect(span.endTimeUnixNano).toBe(ns("2026-10-19T12:00:05.000Z"));
  });

  it("an iteration stamped at its start ends with its last child", () => {
    const iter = "d".repeat(16);
    const file = fileOf([
      { type: "agent_iteration", spanId: iter, timestamp: "2026-10-19T12:00:00.000Z" },
      { type: "ai_call", parentSpanId: iter, timestamp: "2026-10-19T12:00:09.000Z", durationMs: 3000 },
    ]);
    const [, iteration] = spansOf(convert(file));
    expect(iteration.startTimeUnixNano).toBe(ns("2026-10-19T12:00:00.000Z"));
    expect(iteration.endTimeUnixNano).toBe(ns("2026-10-19T12:00:09.000Z"));
  });

  it("the root starts with the session (or an earlier child) and ends with the later of endedAt and the last child", () => {
    const file = fileOf([{ type: "tool_call", timestamp: "2026-10-19T12:00:20.000Z", durationMs: 25_000 }]);
    const [root] = spansOf(convert(file));
    expect(root.startTimeUnixNano).toBe(ns("2026-10-19T11:59:55.000Z"));
    expect(root.endTimeUnixNano).toBe(ns("2026-10-19T12:00:20.000Z"));
    const plain = spansOf(convert(fileOf([{ timestamp: "2026-10-19T12:00:04.000Z", durationMs: 100 }])))[0];
    expect(plain.startTimeUnixNano).toBe(ns("2026-10-19T12:00:00.000Z"));
    expect(plain.endTimeUnixNano).toBe(ns("2026-10-19T12:00:10.000Z"));
  });

  it("an invalid timestamp falls back to the session start; a negative, NaN or missing duration is an instant; end is never before start", () => {
    const spans = spansOf(
      convert(
        fileOf([
          { timestamp: "not a date", durationMs: 50 },
          { durationMs: -5 },
          { durationMs: Number.NaN },
          { durationMs: undefined },
        ]),
      ),
    ).slice(1);
    expect(spans[0].endTimeUnixNano).toBe(ns("2026-10-19T12:00:00.000Z"));
    for (const span of spans.slice(1)) expect(span.startTimeUnixNano).toBe(span.endTimeUnixNano);
    for (const span of spans) expect(BigInt(span.endTimeUnixNano) >= BigInt(span.startTimeUnixNano)).toBe(true);
  });

  it("nanoseconds are integers: a fractional duration does not drift and a 2026 epoch stays exact", () => {
    const file = fileOf([{ timestamp: "2026-10-19T12:00:05.123Z", durationMs: 12.5 }]);
    const span = spansOf(convert(file))[1];
    expect(span.endTimeUnixNano).toBe("1792411205123000000");
    expect(span.startTimeUnixNano).toBe("1792411205110500000");
    expect(span.startTimeUnixNano).toMatch(/^\d+$/);
  });
});

describe("status and errors", () => {
  const failing = fileOf(
    [
      { type: "ai_call", label: "Assistant Error #1", status: "error", durationMs: 100, model: "gpt-4o", error: { message: "429 Too Many Requests", stack: "RateLimitError: 429 Too Many Requests\n    at x" } },
      { type: "tool_call", status: "skipped" },
      { type: "tool_call", status: "retry" },
      { type: "tool_approval", status: "pending", actor: { role: "approval", name: "x" } },
    ],
    { errors: [{ eventId: "evt_1", message: "429 Too Many Requests", type: "ai_call" }], status: "error" },
  );

  it("a failing span is ERROR with the message, error.type from the exception class, and one exception event", () => {
    const [root, failed] = spansOf(convert(failing));
    expect(failed.status).toEqual({ code: 2, message: "429 Too Many Requests" });
    expect(attrsOf(failed)["error.type"]).toBe("RateLimitError");
    expect(failed.events).toHaveLength(1);
    expect(failed.events![0]).toMatchObject({ name: "exception", timeUnixNano: failed.endTimeUnixNano });
    expect(attrsOf(failed.events![0])).toEqual({
      "exception.type": "RateLimitError",
      "exception.message": "429 Too Many Requests",
      "exception.stacktrace": "RateLimitError: 429 Too Many Requests\n    at x",
    });
    // An event-level error is not repeated on the root, which is not an error.
    expect(root.status.code).toBe(0);
    expect(root.events).toBeUndefined();
  });

  it("skipped, retry and pending are UNSET with no error.type", () => {
    const rest = spansOf(convert(failing)).slice(2);
    expect(rest.map((s) => s.status.code)).toEqual([0, 0, 0]);
    expect(rest.some((s) => "error.type" in attrsOf(s))).toBe(false);
    expect(rest.map((s) => attrsOf(s)["cognipeer.event.status"])).toEqual(["skipped", "retry", "pending"]);
  });

  it("a session-level error makes the root ERROR with exception events; the status message is capped", () => {
    const file = fileOf([], {
      status: "error",
      errors: [
        { eventId: "session", message: "x".repeat(5000), type: "session", stack: "TypeError: boom\n at y", timestamp: "2026-10-19T12:00:09.000Z" },
      ],
    });
    const [root] = spansOf(convert(file));
    expect(root.status.code).toBe(2);
    expect(root.status.message).toHaveLength(1024);
    expect(attrsOf(root)["error.type"]).toBe("TypeError");
    expect(root.events).toHaveLength(1);
    expect(attrsOf(root.events![0])["exception.type"]).toBe("TypeError");
    expect(root.events![0].timeUnixNano).toBe(ns("2026-10-19T12:00:09.000Z"));
  });

  it("error.type falls back to _OTHER; a recorded type wins", () => {
    expect(errorTypeOf({ stack: "no header here" })).toBe("_OTHER");
    expect(errorTypeOf(undefined)).toBe("_OTHER");
    expect(errorTypeOf({ type: "tool_error", stack: "Error: x" })).toBe("tool_error");
    expect(errorTypeOf({ stack: "AbortError: The operation was aborted" })).toBe("AbortError");
  });

  it("a cancelled run reports partial on the root, status UNSET", () => {
    const [root] = spansOf(convert(fileOf([]), "both", { cancelled: true }));
    expect(attrsOf(root)["cognipeer.session.status"]).toBe("partial");
    expect(root.status.code).toBe(0);
  });
});

describe("operation boundaries", () => {
  const request = convert(loadSession("run-error"));

  it("a blocked model call, a denied tool and a cache hit are plain INTERNAL spans without an operation", () => {
    for (const label of ["Assistant Blocked (plugin) #6", "Tool Denied - delete_user #4", "Tool Execution - get_prices #5"]) {
      const span = spanByLabel(request, label);
      expect(span.kind, label).toBe(1);
      expect(attrsOf(span)["gen_ai.operation.name"], label).toBeUndefined();
      expect(attrsOf(span)["gen_ai.usage.input_tokens"], label).toBeUndefined();
      expect(span.status.code, label).toBe(0);
    }
    expect(spanByLabel(request, "Tool Denied - delete_user #4").name).toBe("Tool Denied - delete_user");
  });

  it("an executed tool that failed is execute_tool with ERROR; a failed model call is chat with finish reason error and no usage", () => {
    const tool = spanByLabel(request, "Tool Error - lookup_order #3");
    expect(attrsOf(tool)).toMatchObject({ "gen_ai.operation.name": "execute_tool", "error.type": "TypeError" });
    expect(tool.status.code).toBe(2);
    const chat = spanByLabel(request, "Assistant Error #7");
    expect(attrsOf(chat)).toMatchObject({ "gen_ai.operation.name": "chat", "gen_ai.response.finish_reasons": ["error"], "error.type": "RateLimitError" });
    expect(attrsOf(chat)["gen_ai.usage.input_tokens"]).toBeUndefined();
  });

  it("gen_ai.tool.call.id appears only for a provider-supplied id", () => {
    const tool = spanByLabel(request, "Tool Error - lookup_order #3");
    expect(attrsOf(tool)["gen_ai.tool.call.id"]).toBeUndefined();
    const withId = fileOf([{ type: "tool_call", actor: { name: "t", role: "tool" }, ...({ toolCallId: "call_abc" } as object) }]);
    expect(attrsOf(spansOf(convert(withId))[1])["gen_ai.tool.call.id"]).toBe("call_abc");
  });

  it("plan, hook, metadata, approval, question and reflection records are INTERNAL without an operation", () => {
    const types = ["plan", "hook", "metadata", "tool_approval", "user_question", "reflection"];
    const spans = spansOf(convert(fileOf(types.map((type) => ({ type, label: `${type} #1` })))));
    for (const span of spans.slice(1)) {
      expect(span.kind).toBe(1);
      expect(attrsOf(span)["gen_ai.operation.name"]).toBeUndefined();
    }
  });

  it("enrichment fields, when a record has them, flow into the chat span", () => {
    const file = fileOf([
      {
        type: "ai_call",
        model: "claude-sonnet",
        provider: "anthropic",
        inputTokens: 10,
        outputTokens: 20,
        totalTokens: 30,
        cachedInputTokens: 90,
        finishReason: "tool_calls",
        ...({ cacheWriteTokens: 5, usageBasis: { inputExcludesCache: true }, responseId: "msg_1", responseModel: "claude-sonnet-4", rawFinishReason: "tool_use", streaming: true, outputType: "text" } as object),
      },
    ]);
    expect(attrsOf(spansOf(convert(file))[1])).toMatchObject({
      "gen_ai.provider.name": "anthropic",
      "gen_ai.response.id": "msg_1",
      "gen_ai.response.model": "claude-sonnet-4",
      "gen_ai.response.finish_reasons": ["tool_use"],
      "gen_ai.request.stream": true,
      "gen_ai.output.type": "text",
      // Anthropic reports input without the cache: the GenAI total includes it.
      "gen_ai.usage.input_tokens": 105,
      "gen_ai.usage.cache_read.input_tokens": 90,
      "gen_ai.usage.cache_write.input_tokens": 5,
      // The cognipeer vocabulary keeps today's number.
      "cognipeer.tokens.input": 10,
    });
  });

  it("a generation cancelled after it reached the provider stays a chat span, UNSET, finish reason error", () => {
    const file = fileOf([{ type: "ai_call", status: "skipped", ...({ skipReason: "cancelled" } as object) }]);
    const span = spansOf(convert(file))[1];
    expect(span.status.code).toBe(0);
    expect(attrsOf(span)).toMatchObject({ "gen_ai.operation.name": "chat", "gen_ai.response.finish_reasons": ["error"] });
  });

  it("a record with all-zero tokens reports no gen_ai.usage; a summarization reports it only when the model returned usage", () => {
    const zero = fileOf([{ type: "ai_call", inputTokens: 0, outputTokens: 0, totalTokens: 0, cachedInputTokens: 0 }]);
    expect(Object.keys(attrsOf(spansOf(convert(zero))[1])).filter((k) => k.startsWith("gen_ai.usage."))).toEqual([]);
    const summarize = (usageFromModel: boolean) =>
      attrsOf(spansOf(convert(fileOf([{ type: "summarization", inputTokens: 50, outputTokens: 10, totalTokens: 60, debug: { usageFromModel } }])))[1]);
    expect(summarize(true)["gen_ai.usage.input_tokens"]).toBe(50);
    expect(summarize(false)["gen_ai.usage.input_tokens"]).toBeUndefined();
    expect(summarize(false)["cognipeer.tokens.input"]).toBe(50);
  });
});

describe("provider names", () => {
  it("maps the SDK and LangChain hints to registry values and leaves unknown ones off", () => {
    const table: Array<[string | undefined, string | undefined]> = [
      ["openai", "openai"], ["ChatOpenAI", "openai"], ["azure", "azure.ai.openai"], ["AzureChatOpenAI", "azure.ai.openai"],
      ["anthropic", "anthropic"], ["bedrock", "aws.bedrock"], ["vertex", "gcp.vertex_ai"], ["gemini", "gcp.gemini"],
      ["google", "gcp.gen_ai"], ["mistral", "mistral"], ["groq", "groq"], ["x-ai", "x_ai"],
      ["jev", undefined], ["openai-compatible", undefined], ["SomethingElse", undefined], ["", undefined], [undefined, undefined],
    ];
    for (const [hint, expected] of table) expect(genAiProviderName(hint), String(hint)).toBe(expected);
  });
});

describe("legs", () => {
  const leg1 = convert(loadSession("legs-paused.leg1"));
  const leg2 = convert(loadSession("legs-paused.leg2"));

  it("a paused leg exports its own spans and no root; the terminal leg exports the root once", () => {
    const rootId = loadSession("legs-paused.leg1").rootSpanId!;
    expect(spansOf(leg1).some((s) => s.spanId === rootId)).toBe(false);
    expect(spansOf(leg2).filter((s) => s.spanId === rootId)).toHaveLength(1);
    expect(spansOf(leg2)[0].spanId).toBe(rootId);
  });

  it("the union of both requests has no duplicate (traceId, spanId)", () => {
    const keys = [...spansOf(leg1), ...spansOf(leg2)].map((s) => `${s.traceId}/${s.spanId}`);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("the root starts with the first part and ends after the last leg, the wait included", () => {
    const file1 = loadSession("legs-paused.leg1");
    const root = spansOf(leg2)[0];
    expect(root.startTimeUnixNano).toBe(ns(file1.startedAt));
    expect(BigInt(root.endTimeUnixNano)).toBeGreaterThanOrEqual(BigInt(ns("2026-10-19T12:01:03.000Z")));
  });

  it("the pending approval is exported UNSET, marked pending", () => {
    const pending = spansOf(leg1).find((s) => attrsOf(s)["cognipeer.event.type"] === "tool_approval")!;
    expect(pending.status.code).toBe(0);
    expect(attrsOf(pending)["cognipeer.event.status"]).toBe("pending");
  });

  it("event_count on the root is the cumulative total across parts", () => {
    const file2 = loadSession("legs-paused.leg2");
    expect(file2.events).toHaveLength(4);
    expect(attrsOf(spansOf(leg2)[0])["cognipeer.session.event_count"]).toBe(7);
  });

  it("traceSessionToOtlp infers terminal from the file status", () => {
    expect(spansOf(traceSessionToOtlp(loadSession("legs-paused.leg1") as TraceSessionFile)).length).toBe(spansOf(leg1).length);
    expect(spansOf(traceSessionToOtlp(loadSession("legs-paused.leg2"))).length).toBe(spansOf(leg2).length);
  });
});

describe("pending sub-agent spans", () => {
  const sub = "5555555555555555";

  it("leg 1 withholds the pending agent span; leg 2 exports it once, finished, covering both legs", () => {
    const leg1 = spansOf(convert(loadSession("subagent-pending.leg1")));
    const leg2 = spansOf(convert(loadSession("subagent-pending.leg2")));
    expect(leg1.some((s) => s.spanId === sub)).toBe(false);
    const finals = leg2.filter((s) => s.spanId === sub);
    expect(finals).toHaveLength(1);
    expect(finals[0].name).toBe("invoke_agent researcher");
    expect(finals[0].status.code).toBe(0);
    // Wall clock: from the first segment's start (wait included) to the end.
    expect(finals[0].startTimeUnixNano).toBe(ns("2026-10-19T12:00:02.100Z"));
    // The child's leg-2 work sits inside it, and the delegating tool call covers it.
    const inside = leg2.filter((s) => s.parentSpanId === sub);
    expect(inside.length).toBeGreaterThan(0);
    for (const s of inside) expect(BigInt(s.endTimeUnixNano) <= BigInt(finals[0].endTimeUnixNano)).toBe(true);
    const delegating = leg2.find((s) => s.spanId === finals[0].parentSpanId)!;
    expect(BigInt(delegating.startTimeUnixNano) <= BigInt(finals[0].startTimeUnixNano)).toBe(true);
    expect(BigInt(delegating.endTimeUnixNano) >= BigInt(finals[0].endTimeUnixNano)).toBe(true);
  });

  it("the sub-agent's tools name the sub-agent as their agent, even when its own span is withheld", () => {
    const leg2 = convert(loadSession("subagent-pending.leg2"));
    expect(attrsOf(spanByLabel(leg2, "Tool Execution - web_search #9"))["gen_ai.agent.name"]).toBe("researcher");
    expect(attrsOf(spanByLabel(leg2, "Tool Execution - delegate_to #12"))["gen_ai.agent.name"]).toBe("Support Agent");
  });

  it("two non-pending records with one span id are both exported; nothing else is folded", () => {
    const file = fileOf([
      { type: "tool_call", spanId: "e".repeat(16) },
      { type: "tool_call", spanId: "e".repeat(16) },
      { type: "span", status: "pending", spanId: "f".repeat(16), actor: { role: "subagent", name: "x" } },
    ]);
    // A leg that will be followed by another: the pending span waits for its final record.
    const spans = spansOf(convert(file, "both", { terminal: false }));
    expect(spans.filter((s) => s.spanId === "e".repeat(16))).toHaveLength(2);
    expect(spans.some((s) => s.spanId === "f".repeat(16))).toBe(false);
  });

  it("the terminal export writes a sub-agent span that is still pending, so its children have a parent", () => {
    const sub = "f".repeat(16);
    const file = fileOf([
      { type: "span", status: "pending", spanId: sub, parentSpanId: "c".repeat(16), actor: { role: "subagent", name: "x" }, label: "Sub-agent x #1" },
      { type: "agent_iteration", spanId: "1".repeat(16), parentSpanId: sub },
    ]);
    const spans = spansOf(convert(file));
    const ids = new Set([...spans.map((s) => s.spanId), ""]);
    for (const span of spans) expect(ids.has(span.parentSpanId), span.name).toBe(true);
    const pending = spans.find((s) => s.spanId === sub)!;
    expect(pending.status.code).toBe(0);
    expect(attrsOf(pending)["cognipeer.event.status"]).toBe("pending");
    // Folded first: a pending record a later record finished is not exported twice.
    const finished = fileOf([
      { type: "span", status: "pending", spanId: sub, actor: { role: "subagent", name: "x" } },
      { type: "span", status: "success", spanId: sub, actor: { role: "subagent", name: "x" } },
    ]);
    expect(spansOf(convert(finished)).filter((s) => s.spanId === sub)).toHaveLength(1);
  });

  it("a client tool the run paused on is a plain span, not an execute_tool; the resumed result is the execution", () => {
    const file = fileOf([
      { type: "tool_call", status: "pending", label: "Tool Execution - pick (client) #1", actor: { scope: "client", name: "pick", role: "tool" } },
      { type: "tool_call", status: "success", label: "Tool Execution - pick (client) #2", actor: { scope: "client", name: "pick", role: "tool" } },
    ]);
    const spans = spansOf(convert(file)).slice(1);
    const attrs = spans.map((s) => attrsOf(s));
    expect(attrs.filter((a) => a["gen_ai.operation.name"] === "execute_tool")).toHaveLength(1);
    expect(attrs[0]["gen_ai.operation.name"]).toBeUndefined();
    expect(attrs[0]["cognipeer.event.status"]).toBe("pending");
    expect(spans[0].status.code).toBe(0);
  });
});

describe("cognipeer.sections", () => {
  const withSections = () =>
    fileOf([
      {
        type: "ai_call",
        label: "Assistant Response #1",
        model: "gpt-4o",
        data: {
          sections: [
            { kind: "metadata", label: "Approval ids", data: { approvalId: "a1" }, identity: true },
            { kind: "message", label: "User", role: "user", content: "SECRET-PROMPT" },
          ],
        },
      },
    ]);
  const sectionsOfFirst = (request: any): any[] | undefined => {
    const raw = attrsOf(spansOf(request)[1])["cognipeer.sections"];
    return raw === undefined ? undefined : JSON.parse(raw);
  };

  it("without content only the identity sections are exported", () => {
    const list = sectionsOfFirst(traceSessionToOtlp(withSections()))!;
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ label: "Approval ids", identity: true });
    expect(JSON.stringify(traceSessionToOtlp(withSections()))).not.toContain("SECRET-PROMPT");
  });

  it("with content on the payload follows, through redact and caps; identity sections are never cut", () => {
    expect(sectionsOfFirst(traceSessionToOtlp(withSections(), { content: true }))).toHaveLength(2);
    const masked = traceSessionToOtlp(withSections(), { content: { enabled: true, redact: (value) => JSON.parse(JSON.stringify(value).replace("SECRET-PROMPT", "[MASKED]")) } });
    expect(JSON.stringify(masked)).not.toContain("SECRET-PROMPT");
    expect(JSON.stringify(masked)).toContain("[MASKED]");
    // A byte cap too small for the payload drops it (oldest sections first) and keeps the identity ones.
    const tiny = sectionsOfFirst(traceSessionToOtlp(withSections(), { content: { enabled: true, maxAttributeBytes: 150 } }))!;
    expect(tiny).toHaveLength(1);
    expect(tiny[0].identity).toBe(true);
  });
});

describe("W3C parent and trace state", () => {
  it("a remote parent sets the root's parent span id, flags 769 on the root, 257 elsewhere, and trace state on every span", () => {
    const spans = spansOf(
      convert(loadSession("run-success"), "both", { parent: { spanId: "b7ad6b7169203331", remote: true, traceState: "vendor=x" } }),
    );
    expect(spans[0].parentSpanId).toBe("b7ad6b7169203331");
    expect(spans[0].flags).toBe(769);
    expect(spans.slice(1).every((s) => s.flags === 257)).toBe(true);
    expect(spans.every((s) => s.traceState === "vendor=x")).toBe(true);
  });
});

describe("resource", () => {
  it("service.name precedence: explicit, then a resource attribute, then the agent name; custom attributes are merged", () => {
    const file = loadSession("run-success");
    const resource = (extra: Partial<OtlpConvertOptions>) => resourceAttrsOf(convert(file, "both", extra));
    expect(resource({})["service.name"]).toBe("Support Agent");
    expect(resource({ resourceAttributes: { "service.name": "from-attrs" } })["service.name"]).toBe("from-attrs");
    expect(resource({ serviceName: "explicit", resourceAttributes: { "service.name": "from-attrs", "deployment.environment": "prod" } })).toMatchObject({
      "service.name": "explicit",
      "deployment.environment": "prod",
    });
  });
});
