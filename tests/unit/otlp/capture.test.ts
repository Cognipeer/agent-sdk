/**
 * Content capture through real runs: off by default, built at record time only
 * when an exporter asked, redacted before it is capped, and invisible to every
 * other sink.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { createAgent, createOtlpExporter, createTool, otlpSink } from "../../../src/index.js";
import { defineHook } from "../../../src/plugins/define.js";
import type { AgentPlugin } from "../../../src/plugins/types.js";
import {
  createTraceSession,
  customSink,
  finalizeTraceSession,
  recordOrDeferTraceEvent,
  recordTraceEvent,
} from "../../../src/utils/tracing.js";
import { capturedContentOf } from "../../../src/utils/otlp/content.js";
import type { OtlpContentOptions } from "../../../src/utils/otlp/types.js";
import type { Message, TraceEventRecord, TraceSessionFile } from "../../../src/types.js";
import { attrsOf, okResponse, spansOf } from "./helpers.js";

afterEach(() => vi.restoreAllMocks());

const call = (id: string, name: string, args: Record<string, unknown> = {}) => ({
  id, type: "function", function: { name, arguments: JSON.stringify(args) },
});

function scripted(name: string, script: Array<Partial<Message> & Record<string, any>>) {
  let turn = 0;
  const model: any = {
    modelName: name,
    bindTools() { return model; },
    async invoke() { return { role: "assistant", content: "", ...script[Math.min(turn++, script.length - 1)] }; },
  };
  return model;
}

function harness(opts: { content?: boolean | OtlpContentOptions; logData?: boolean; plugins?: AgentPlugin[] } = {}) {
  const bodies: any[] = [];
  const fetch = vi.fn(async (_url: string, init: any) => {
    bodies.push(JSON.parse(init.body));
    return okResponse();
  });
  const sessions: TraceSessionFile[] = [];
  const events: TraceEventRecord[] = [];
  return {
    bodies, sessions, events, fetch,
    options: {
      plugins: [{ name: "otlp", traceExporters: [createOtlpExporter({ endpoint: "https://c.example.test/v1/traces", fetch, content: opts.content })] }, ...(opts.plugins ?? [])],
      tracing: {
        enabled: true,
        logData: opts.logData ?? true,
        sink: customSink({ onEvent: (e) => { events.push(e); }, onSession: (s) => { sessions.push(s); } }),
      },
    },
    spans: () => bodies.flatMap(spansOf),
    chat: () => bodies.flatMap(spansOf).find((s) => s.name.startsWith("chat "))!,
    tool: (name: string) => bodies.flatMap(spansOf).find((s) => s.name === `execute_tool ${name}`)!,
  };
}

const go = (text = "the SECRET-PROMPT question") => ({ messages: [{ role: "user", content: text }] }) as any;
const lookup = () => createTool({ name: "lookup", description: "finds things", schema: z.object({ q: z.string() }), func: async () => ({ found: "SECRET-RESULT" }) });
const CONTENT_KEYS = /^gen_ai\.(input\.messages|output\.messages|system_instructions|tool\.definitions|tool\.call\.arguments|tool\.call\.result)$/;
const contentKeys = (spans: any[]) => spans.flatMap((s) => Object.keys(attrsOf(s))).filter((k) => CONTENT_KEYS.test(k));

describe("off by default", () => {
  it("no content option: no gen_ai content attribute anywhere, and the body carries no prompt text", async () => {
    const h = harness({ logData: false });
    await createAgent({ name: "A", model: scripted("m", [{ tool_calls: [call("t1", "lookup", { q: "x" })] }, { content: "done" }]), tools: [lookup()], ...h.options }).invoke(go());
    expect(contentKeys(h.spans())).toEqual([]);
    expect(JSON.stringify(h.bodies)).not.toContain("SECRET-PROMPT");
    expect(JSON.stringify(h.bodies)).not.toContain("SECRET-RESULT");
  });

  it("logData alone adds cognipeer.sections only, never the gen_ai content attributes", async () => {
    const h = harness({ logData: true });
    await createAgent({ name: "A", model: scripted("m", [{ content: "done" }]), ...h.options }).invoke(go());
    expect(contentKeys(h.spans())).toEqual([]);
    expect(attrsOf(h.chat())["cognipeer.sections"]).toBeDefined();
  });

  it("nothing is held on the records when no exporter asked", () => {
    const session = createTraceSession({ tracing: { enabled: true, sink: customSink({}) } } as any)!;
    expect(session.captureContent).toBeUndefined();
    const record = recordTraceEvent(session, { type: "ai_call", capture: { input: [{ role: "user", content: "hi" }] } })!;
    expect(capturedContentOf(record)).toBeUndefined();
  });
});

describe("on", () => {
  it("emits the prompt, the answer, the tool menu, the tool arguments and result - with logData off, and no cognipeer.sections", async () => {
    const h = harness({ content: true, logData: false });
    await createAgent({ name: "A", model: scripted("m", [{ tool_calls: [call("t1", "lookup", { q: "needle" })] }, { content: "final answer" }]), tools: [lookup()], ...h.options }).invoke(go());

    const spans = h.spans();
    expect(spans.some((s) => attrsOf(s)["cognipeer.sections"] !== undefined)).toBe(false);
    const firstChat = spans.find((s) => s.name === "chat m")!;
    const attrs = attrsOf(firstChat);
    const input = JSON.parse(attrs["gen_ai.input.messages"]);
    expect(input.at(-1)).toEqual({ role: "user", parts: [{ type: "text", content: "the SECRET-PROMPT question" }] });
    expect(JSON.parse(attrs["gen_ai.output.messages"])[0].parts[0]).toMatchObject({ type: "tool_call", id: "t1", name: "lookup", arguments: { q: "needle" } });
    const tools = JSON.parse(attrs["gen_ai.tool.definitions"]);
    expect(tools.map((t: any) => t.name)).toContain("lookup");

    const tool = attrsOf(h.tool("lookup"));
    expect(JSON.parse(tool["gen_ai.tool.call.arguments"])).toEqual({ q: "needle" });
    expect(JSON.parse(tool["gen_ai.tool.call.result"])).toEqual({ found: "SECRET-RESULT" });

    // The second turn's prompt holds the tool call and its answer, in order.
    const secondInput = JSON.parse(attrsOf(spans.filter((s) => s.name === "chat m")[1])["gen_ai.input.messages"]);
    expect(secondInput.map((m: any) => m.role)).toEqual(expect.arrayContaining(["user", "assistant", "tool"]));
  });

  it("an exporter derived from the otlp sink counts too, not only plugin-contributed ones", async () => {
    const bodies: any[] = [];
    const fetch = vi.fn(async (_u: string, init: any) => { bodies.push(JSON.parse(init.body)); return okResponse(); });
    await createAgent({
      name: "A",
      model: scripted("m", [{ content: "hi" }]),
      tracing: { enabled: true, logData: false, sink: otlpSink({ endpoint: "https://c.example.test/v1/traces", fetch, content: true }) },
    }).invoke(go());
    const chat = bodies.flatMap(spansOf).find((s) => s.name === "chat m")!;
    expect(attrsOf(chat)["gen_ai.input.messages"]).toContain("SECRET-PROMPT");
  });

  it("include limits what leaves", async () => {
    const h = harness({ content: { enabled: true, include: ["output"] } });
    await createAgent({ name: "A", model: scripted("m", [{ content: "answer" }]), ...h.options }).invoke(go());
    expect(Object.keys(attrsOf(h.chat())).filter((k) => CONTENT_KEYS.test(k))).toEqual(["gen_ai.output.messages"]);
  });

  it("a failed tool has its arguments and no result", async () => {
    const h = harness({ content: true });
    const boom = createTool({ name: "boom", description: "d", schema: z.object({ q: z.string() }), func: async () => { throw new Error("nope"); } });
    await createAgent({ name: "A", model: scripted("m", [{ tool_calls: [call("t1", "boom", { q: "x" })] }, { content: "done" }]), tools: [boom], ...h.options }).invoke(go());
    const attrs = attrsOf(h.tool("boom"));
    expect(attrs["gen_ai.tool.call.arguments"]).toBeDefined();
    expect(attrs["gen_ai.tool.call.result"]).toBeUndefined();
  });

  it("an exporter that did not ask gets none, even next to one that did", async () => {
    const quiet: any[] = [];
    const quietFetch = vi.fn(async (_u: string, init: any) => { quiet.push(JSON.parse(init.body)); return okResponse(); });
    const h = harness({ content: true, logData: false });
    h.options.plugins.push({ name: "quiet", traceExporters: [createOtlpExporter({ endpoint: "https://q.example.test/v1/traces", fetch: quietFetch })] });
    await createAgent({ name: "A", model: scripted("m", [{ content: "hi" }]), ...h.options }).invoke(go());
    expect(contentKeys(h.spans()).length).toBeGreaterThan(0);
    expect(contentKeys(quiet.flatMap(spansOf))).toEqual([]);
    expect(JSON.stringify(quiet)).not.toContain("SECRET-PROMPT");
  });

  it("is what the provider was sent: a preModelCall hook's injection is in, the raw transcript is not the source", async () => {
    const h = harness({
      content: true,
      plugins: [defineHook("preModelCall", ({ messages }) => ({ messages: [...messages, { role: "user", content: "INJECTED-BY-HOOK" } as Message] }), { name: "inject" })],
    });
    await createAgent({ name: "A", model: scripted("m", [{ content: "hi" }]), ...h.options }).invoke(go());
    const input = attrsOf(h.chat())["gen_ai.input.messages"];
    expect(input).toContain("INJECTED-BY-HOOK");
  });

  it("is after the redaction plugins: postToolUse and postModelCall rewrites are what is captured", async () => {
    const h = harness({
      content: true,
      plugins: [
        defineHook("postToolUse", () => ({ output: { found: "[masked]" } }), { name: "mask-tool" }),
        defineHook("postModelCall", ({ message }) => ({ message: { ...(message as any), content: (message as any).content.replace("SECRET-ANSWER", "[masked]") } }), { name: "mask-answer" }),
      ],
    });
    await createAgent({
      name: "A",
      model: scripted("m", [{ tool_calls: [call("t1", "lookup", { q: "x" })] }, { content: "the SECRET-ANSWER" }]),
      tools: [lookup()],
      ...h.options,
    }).invoke(go());
    const body = JSON.stringify(h.bodies);
    expect(body).not.toContain("SECRET-RESULT");
    expect(body).not.toContain("SECRET-ANSWER");
    expect(body).toContain("[masked]");
  });
});

describe("redact hook", () => {
  it("masks what is exported", async () => {
    const h = harness({
      content: { enabled: true, redact: (value) => JSON.parse(JSON.stringify(value).replace(/SECRET-PROMPT/g, "[REDACTED]")) },
      logData: false,
    });
    await createAgent({ name: "A", model: scripted("m", [{ content: "hi" }]), ...h.options }).invoke(go());
    expect(attrsOf(h.chat())["gen_ai.input.messages"]).toContain("[REDACTED]");
    expect(JSON.stringify(h.bodies)).not.toContain("SECRET-PROMPT");
  });

  it("a throwing hook leaves that field out and the export still succeeds", async () => {
    const h = harness({ content: { enabled: true, redact: (value, info) => { if (info.field === "input") throw new Error("bad hook"); return value; } } });
    await createAgent({ name: "A", model: scripted("m", [{ content: "hi" }]), ...h.options }).invoke(go());
    const attrs = attrsOf(h.chat());
    expect(attrs["gen_ai.input.messages"]).toBeUndefined();
    expect(attrs["gen_ai.output.messages"]).toBeDefined();
    expect(h.fetch).toHaveBeenCalledTimes(1);
  });
});

describe("isolation", () => {
  it("custom-sink events, the session payload and its JSON carry no captured content (logData off)", async () => {
    const h = harness({ content: true, logData: false });
    await createAgent({ name: "A", model: scripted("m", [{ tool_calls: [call("t1", "lookup", { q: "x" })] }, { content: "done" }]), tools: [lookup()], ...h.options }).invoke(go());
    expect(JSON.stringify(h.events)).not.toContain("SECRET-PROMPT");
    expect(JSON.stringify(h.events)).not.toContain("SECRET-RESULT");
    expect(JSON.stringify(h.sessions)).not.toContain("SECRET-PROMPT");
    expect(JSON.stringify(h.sessions)).not.toContain("SECRET-RESULT");
    // The exporter did get it.
    expect(JSON.stringify(h.bodies)).toContain("SECRET-PROMPT");
  });

  it("a record's content is out of Object.keys, spread and JSON, yet the finalized session still hands it to the exporter", async () => {
    const bodies: any[] = [];
    const fetch = vi.fn(async (_u: string, init: any) => { bodies.push(JSON.parse(init.body)); return okResponse(); });
    const exporter = createOtlpExporter({ endpoint: "https://x/v1/traces", fetch, content: true });
    const session = createTraceSession({ tracing: { enabled: true, sink: customSink({}) } } as any, undefined, { exporters: [exporter] })!;
    const record = recordTraceEvent(session, { type: "ai_call", model: "m", durationMs: 1, capture: { input: [{ role: "user", content: "hello there" }] } })!;
    expect(capturedContentOf(record)).toBeDefined();
    expect(JSON.stringify(record)).not.toContain("hello there");
    expect(Object.getOwnPropertySymbols(record).filter((s) => Object.keys(record).includes(String(s)))).toEqual([]);
    await finalizeTraceSession(session, { agentRuntime: { name: "A" } as any });
    expect(JSON.stringify(bodies)).toContain("hello there");
  });

  it("content is never parked on ctx with a deferred trace event", () => {
    const held = recordOrDeferTraceEvent({}, { type: "summarization", capture: { input: [{ role: "user", content: "SECRET-PROMPT" }] } }, { tracingEnabled: true })!;
    expect(JSON.stringify(held)).not.toContain("SECRET-PROMPT");
  });

  it("summarization content is not captured", async () => {
    const exporter = createOtlpExporter({ endpoint: "https://x/v1/traces", content: true });
    const session = createTraceSession({ tracing: { enabled: true, sink: customSink({}) } } as any, undefined, { exporters: [exporter] })!;
    const record = recordTraceEvent(session, { type: "summarization", model: "m" })!;
    expect(capturedContentOf(record)).toBeUndefined();
  });

  it("record-time holds the widest cap any exporter allows, with headroom for redaction", () => {
    const small = createOtlpExporter({ endpoint: "https://x/v1/traces", content: { enabled: true, maxStringChars: 100, maxMessages: 3 } });
    const wide = createOtlpExporter({ endpoint: "https://y/v1/traces", content: { enabled: true, maxStringChars: 1000, maxMessages: 10 } });
    const off = createOtlpExporter({ endpoint: "https://z/v1/traces" });
    const session = createTraceSession({ tracing: { enabled: true, sink: customSink({}) } } as any, undefined, { exporters: [small, wide, off] })!;
    expect(session.captureLimits).toEqual({ maxStringChars: 4000, maxMessages: 10 });
  });
});
