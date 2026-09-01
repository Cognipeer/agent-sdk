/**
 * Hook decisions on the trace timeline.
 *
 * The question these guard is the one an operator actually asks the console:
 * "this run stopped — where, and why?". A guardrail that denies a turn is
 * invisible in a trace that only records ai_call and tool_call, so the run just
 * appears to end.
 */

import { describe, it, expect, vi } from "vitest";
import { z } from "zod";
import { createAgent } from "../../../src/agent.js";
import { createSmartAgent } from "../../../src/smart/index.js";
import { createTool } from "../../../src/tool.js";
import { customSink } from "../../../src/utils/tracing.js";
import { defineHook } from "../../../src/plugins/define.js";
import { createGuardrailPlugin, customGuardrail } from "../../../src/plugins/builtin/guardrail.js";
import type { TraceEventRecord } from "../../../src/types.js";

function collectingTracing(events: TraceEventRecord[], logData = true) {
  return {
    enabled: true,
    logData,
    sink: customSink((event: TraceEventRecord) => {
      events.push(event);
    }),
  } as any;
}

const answeringModel = (content = "done") =>
  ({
    modelName: "trace-model",
    bindTools() {
      return this;
    },
    async invoke() {
      return { role: "assistant", content };
    },
  }) as any;

describe("plugin decisions on the trace", () => {
  it("records a preToolUse deny as a hook event naming the plugin and the reason", async () => {
    const events: TraceEventRecord[] = [];
    const func = vi.fn(async () => "SHOULD NOT RUN");
    const tool = createTool({
      name: "deploy",
      description: "deploy",
      schema: z.object({ env: z.string() }),
      func,
    });

    let turn = 0;
    const model = {
      modelName: "trace-model",
      bindTools() {
        return this;
      },
      async invoke() {
        turn += 1;
        if (turn === 1) {
          return {
            role: "assistant",
            content: "",
            tool_calls: [
              {
                id: "call_1",
                type: "function",
                function: { name: "deploy", arguments: JSON.stringify({ env: "prod" }) },
              },
            ],
          };
        }
        return { role: "assistant", content: "understood" };
      },
    } as any;

    const agent = createAgent({
      name: "TracedAgent",
      model,
      tools: [tool],
      tracing: collectingTracing(events),
      plugins: [
        defineHook("preToolUse", () => ({ decision: "deny", reason: "prod deploys need a ticket" }), {
          name: "change-policy",
        }),
      ],
    });

    await agent.invoke({ messages: [{ role: "user", content: "deploy to prod" }] });

    expect(func).not.toHaveBeenCalled();

    const hookEvents = events.filter((event) => event.type === "hook");
    expect(hookEvents).toHaveLength(1);
    const [hook] = hookEvents;

    // The trace runtime appends " #<sequence>" to every label.
    expect(hook.label).toMatch(/^Hook: change-policy → preToolUse/);
    expect(hook.actor?.name).toBe("change-policy");
    expect(hook.actor?.scope).toBe("plugin");
    // A policy deny is the guardrail working, not a system failure — an "error"
    // status here would flip the whole session's status for a healthy run.
    expect(hook.status).toBe("skipped");

    const section = hook.data?.sections.find((s: any) => s.kind === "metadata") as any;
    expect(section.data.decision).toBe("deny");
    expect(section.data.reason).toContain("prod deploys need a ticket");
  });

  it("keeps the session status clean when a hook denies", async () => {
    const sessions: any[] = [];
    const agent = createAgent({
      model: answeringModel(),
      tracing: {
        enabled: true,
        logData: true,
        sink: customSink({ onSession: (session) => sessions.push(session) }),
      } as any,
      plugins: [
        defineHook("userPromptSubmit", () => ({ decision: "deny", reason: "blocked" }), {
          name: "input-policy",
        }),
      ],
    });

    await agent.invoke({ messages: [{ role: "user", content: "anything" }] });

    expect(sessions).toHaveLength(1);
    expect(sessions[0].status).toBe("success");
  });

  it("holds an input-guardrail decision until the trace session exists, rather than dropping it", async () => {
    // userPromptSubmit runs before the first model call, which is where the
    // trace session is created. The record has to wait, not disappear — a
    // blocked run is exactly the one worth seeing on the timeline.
    const events: TraceEventRecord[] = [];
    const agent = createSmartAgent({
      name: "SmartTraced",
      model: answeringModel("hello"),
      tracing: collectingTracing(events),
      plugins: [
        defineHook("userPromptSubmit", ({ text }) => ({ text: text.replace(/secret/gi, "[redacted]") }), {
          name: "input-redactor",
        }),
      ],
    });

    await agent.invoke({ messages: [{ role: "user", content: "my secret is 42" }] });

    const hookEvents = events.filter((event) => event.type === "hook");
    expect(hookEvents).toHaveLength(1);
    expect(hookEvents[0].label).toMatch(/^Hook: input-redactor → userPromptSubmit/);
    const section = hookEvents[0].data?.sections.find((s: any) => s.kind === "metadata") as any;
    expect(section.data.mutated).toBe(true);
  });

  it("records nothing for handlers that change nothing", async () => {
    const events: TraceEventRecord[] = [];
    const agent = createAgent({
      model: answeringModel(),
      tracing: collectingTracing(events),
      plugins: [defineHook("preModelCall", () => undefined, { name: "observer" })],
    });

    await agent.invoke({ messages: [{ role: "user", content: "hi" }] });

    expect(events.filter((event) => event.type === "hook")).toHaveLength(0);
  });

  it("carries no token counts, so session totals are not double-counted", async () => {
    const events: TraceEventRecord[] = [];
    const agent = createAgent({
      model: answeringModel(),
      tracing: collectingTracing(events),
      plugins: [
        defineHook("postModelCall", ({ message }) => ({ message: { ...message, content: "rewritten" } }), {
          name: "rewriter",
        }),
      ],
    });

    await agent.invoke({ messages: [{ role: "user", content: "hi" }] });

    const [hook] = events.filter((event) => event.type === "hook");
    expect(hook).toBeDefined();
    expect(hook.inputTokens).toBeUndefined();
    expect(hook.outputTokens).toBeUndefined();
    expect(hook.totalTokens).toBeUndefined();
    // durationMs is accumulated into the session total, which already covers
    // the model call this hook ran inside; the real number rides in the section.
    expect(hook.durationMs).toBeUndefined();
  });

  it("omits hook payload sections when logData is off", async () => {
    const events: TraceEventRecord[] = [];
    const agent = createAgent({
      model: answeringModel(),
      tracing: collectingTracing(events, false),
      plugins: [
        defineHook("userPromptSubmit", () => ({ decision: "deny", reason: "contains a customer id" }), {
          name: "input-policy",
        }),
      ],
    });

    await agent.invoke({ messages: [{ role: "user", content: "cus_123" }] });

    const [hook] = events.filter((event) => event.type === "hook");
    expect(hook).toBeDefined();
    expect(hook.data).toBeUndefined();
  });
});

describe("guardrail plugin trace correlation", () => {
  it("hands the run's traceId to the guardrail service", async () => {
    const seen: Array<{ traceId?: string }> = [];
    const agent = createAgent({
      model: answeringModel(),
      tracing: { enabled: true, logData: true, sink: customSink(() => {}) } as any,
      plugins: [
        createGuardrailPlugin({
          name: "correlating-guardrail",
          apply: ["input"],
          transport: {
            name: "spy",
            evaluate: (_requests, ctx) => {
              seen.push({ traceId: ctx.traceId });
              return [{ action: "allow" as const }];
            },
          },
        }),
      ],
    });

    await agent.invoke({ messages: [{ role: "user", content: "hello" }] });

    expect(seen).toHaveLength(1);
    // Without this the console cannot line a guardrail decision up with the
    // run it belongs to.
    expect(seen[0].traceId).toMatch(/^[0-9a-f]{8,}$/i);
  });

  it("puts a guardrail block on the timeline with the service's reason", async () => {
    const events: TraceEventRecord[] = [];
    const agent = createAgent({
      model: answeringModel(),
      tracing: collectingTracing(events),
      plugins: [
        createGuardrailPlugin({
          name: "policy-service",
          apply: ["input"],
          transport: customGuardrail(() => ({
            action: "block",
            message: "PII policy violation: national id",
          })),
        }),
      ],
    });

    const result = await agent.invoke({ messages: [{ role: "user", content: "my id is ..." }] });

    expect(result.content).toContain("PII policy violation");
    const [hook] = events.filter((event) => event.type === "hook");
    expect(hook.label).toMatch(/^Hook: policy-service → userPromptSubmit/);
    const section = hook.data?.sections.find((s: any) => s.kind === "metadata") as any;
    expect(section.data.reason).toContain("PII policy violation");
  });
});
