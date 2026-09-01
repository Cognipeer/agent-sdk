/**
 * Plugin layer against a REAL model.
 *
 * The unit tests drive every hook with a scripted model, which proves the
 * wiring but not the thing that actually breaks in production: a real model
 * emits tool calls the test author did not choose, in an order nobody scripted,
 * and reacts to a denial in its own words. These runs are here to catch the
 * gap between "the hook fired" and "the agent still worked".
 *
 *   OPENAI_API_KEY=sk-… npx vitest run tests/integration/plugins.integration.test.ts
 *
 * Any OpenAI-compatible endpoint works — a gateway, a proxy, or a local server:
 *
 *   OPENAI_BASE_URL=http://localhost:11434/v1 \
 *   PLUGIN_TEST_MODEL=qwen2.5 OPENAI_API_KEY=ignored npx vitest run …
 *
 * Skipped entirely without a key. The assertions are written against BEHAVIOUR
 * (a tool did not run, a string never reached the wire) rather than against
 * particular wording, so they hold across models.
 */

import { describe, it, expect, vi } from "vitest";
import { z } from "zod";
import { createAgent, createSmartAgent, createTool } from "../../src/index.js";
import { createProvider, fromNativeProvider } from "../../src/providers/index.js";
import { customSink } from "../../src/utils/tracing.js";
import { defineHook } from "../../src/plugins/define.js";
import { piiRedaction } from "../../src/plugins/builtin/piiRedaction.js";
import { toolPolicy } from "../../src/plugins/builtin/toolPolicy.js";
import { budgetGuard } from "../../src/plugins/builtin/budgetGuard.js";
import { createGuardrailPlugin, customGuardrail } from "../../src/plugins/builtin/guardrail.js";
import type { Message, TraceEventRecord } from "../../src/types.js";

const API_KEY = process.env.OPENAI_API_KEY;
const runReal = API_KEY ? describe : describe.skip;
const MODEL = process.env.PLUGIN_TEST_MODEL ?? "gpt-4o-mini";

const BASE_URL = process.env.OPENAI_BASE_URL;

function realModel() {
  return fromNativeProvider(
    createProvider({
      provider: "openai",
      apiKey: API_KEY!,
      defaultModel: MODEL,
      ...(BASE_URL ? { baseURL: BASE_URL } : {}),
    }),
    { model: MODEL },
  );
}

/** Captures what actually went on the wire, which is the only proof of redaction. */
function wireSpy(sink: Message[][]) {
  return defineHook(
    "preModelCall",
    ({ messages }) => {
      sink.push(messages.map((m) => ({ ...m })));
      return undefined;
    },
    { name: "wire-spy", priority: 999 },
  );
}

const weatherTool = createTool({
  name: "get_weather",
  description: "Return the current weather for a city.",
  schema: z.object({ city: z.string().describe("City name") }),
  func: async ({ city }) => ({ city, tempC: 21, condition: "clear" }),
});

runReal("plugin layer against a real model", () => {
  it("redacts PII before it reaches the provider, and the run still answers", async () => {
    const wire: Message[][] = [];
    const agent = createAgent({
      name: "RedactingAgent",
      model: realModel(),
      plugins: [piiRedaction({ entities: ["EMAIL"] }), wireSpy(wire)],
    });

    const result = await agent.invoke({
      messages: [
        {
          role: "user",
          content:
            "My address is ada.lovelace@example.com. Reply with exactly one short sentence confirming you received a contact address, without repeating it.",
        },
      ],
    });

    expect(wire.length).toBeGreaterThan(0);
    const everythingSent = JSON.stringify(wire);
    expect(everythingSent).not.toContain("ada.lovelace@example.com");
    expect(everythingSent).toContain("[REDACTED:EMAIL]");

    expect(result.content.length).toBeGreaterThan(0);
    expect(result.content).not.toContain("ada.lovelace@example.com");
  }, 60_000);

  it("denies a tool the model genuinely wanted, and the model recovers", async () => {
    const func = vi.fn(async ({ city }: { city: string }) => ({ city, tempC: 21 }));
    const guardedTool = createTool({
      name: "get_weather",
      description: "Return the current weather for a city.",
      schema: z.object({ city: z.string() }),
      func,
    });

    const agent = createSmartAgent({
      name: "PolicyAgent",
      model: realModel(),
      tools: [guardedTool],
      limits: { maxToolCalls: 3 },
      plugins: [
        toolPolicy({
          rules: [
            {
              tool: "get_weather",
              action: "deny",
              reason: "Weather lookups are disabled in this environment. Tell the user you cannot check it.",
            },
          ],
        }),
      ],
    });

    const result = await agent.invoke({
      messages: [{ role: "user", content: "What is the weather in Istanbul right now? Use your tool." }],
    });

    expect(func).not.toHaveBeenCalled();

    // The denial has to reach the model as a tool result, not as a thrown error:
    // the transcript must stay valid and the run must still produce an answer.
    const toolMessages = result.messages.filter((m) => m.role === "tool");
    expect(toolMessages.length).toBeGreaterThan(0);
    expect(JSON.stringify(toolMessages)).toContain("disabled in this environment");

    const rejected = (result.state?.toolHistory ?? []).filter((entry) => entry.status === "rejected");
    expect(rejected.length).toBeGreaterThan(0);

    expect(result.content.length).toBeGreaterThan(0);
  }, 90_000);

  it("pauses a real tool call for approval and resumes it after the human says yes", async () => {
    const func = vi.fn(async ({ city }: { city: string }) => ({ city, tempC: 21, condition: "clear" }));
    const tool = createTool({
      name: "get_weather",
      description: "Return the current weather for a city.",
      schema: z.object({ city: z.string() }),
      func,
    });

    const agent = createAgent({
      name: "ApprovalAgent",
      model: realModel(),
      tools: [tool],
      plugins: [
        defineHook("preToolUse", ({ toolName }) => (toolName === "get_weather" ? { decision: "ask" } : undefined), {
          name: "ask-first",
        }),
      ],
    });

    const paused = await agent.invoke({
      messages: [{ role: "user", content: "Use your tool to check the weather in Ankara, then tell me." }],
    });

    const pending = paused.state?.pendingApprovals ?? [];
    expect(pending.length).toBe(1);
    expect(func).not.toHaveBeenCalled();

    const approved = agent.resolveToolApproval(paused.state!, {
      id: pending[0].id,
      approved: true,
    });
    const finished = await agent.invoke(approved);

    expect(func).toHaveBeenCalledTimes(1);
    expect(finished.content.toLowerCase()).toMatch(/21|clear|ankara/);
  }, 90_000);

  it("blocks a real response through a guardrail transport and reports it", async () => {
    const events: any[] = [];
    const agent = createAgent({
      name: "GuardedAgent",
      model: realModel(),
      plugins: [
        createGuardrailPlugin({
          name: "no-numbers-policy",
          apply: ["output"],
          transport: customGuardrail((request) =>
            /\d/.test(request.content)
              ? { action: "block", message: "Numeric content is not permitted by policy." }
              : { action: "allow" },
          ),
        }),
      ],
    });

    const result = await agent.invoke(
      { messages: [{ role: "user", content: "Reply with just the number 7, nothing else." }] },
      { onEvent: (event) => events.push(event) },
    );

    expect(result.content).toContain("Numeric content is not permitted");
    expect(events.some((e) => e.type === "plugin" && e.decision === "deny")).toBe(true);
  }, 60_000);

  it("puts hook decisions on the trace with the run's own trace id", async () => {
    const traceEvents: TraceEventRecord[] = [];
    const seenTraceIds: Array<string | undefined> = [];
    const seenRunIds: string[] = [];

    const agent = createSmartAgent({
      name: "TracedRealAgent",
      model: realModel(),
      tools: [weatherTool],
      limits: { maxToolCalls: 2 },
      tracing: {
        enabled: true,
        logData: true,
        sink: customSink((event: TraceEventRecord) => traceEvents.push(event)),
      } as any,
      plugins: [
        createGuardrailPlugin({
          name: "trace-correlated-guardrail",
          apply: ["input"],
          transport: {
            name: "spy",
            evaluate: (_requests, ctx) => {
              seenTraceIds.push(ctx.traceId);
              seenRunIds.push(ctx.runId);
              return [{ action: "allow" as const }];
            },
          },
        }),
        defineHook("preToolUse", ({ args }) => ({ args: { ...(args as any), city: "Istanbul" } }), {
          name: "city-normalizer",
          mayRequireApproval: false,
        }),
      ],
    });

    await agent.invoke({ messages: [{ role: "user", content: "Check the weather in istanbul with your tool." }] });

    const aiCalls = traceEvents.filter((e) => e.type === "ai_call");
    expect(aiCalls.length).toBeGreaterThan(0);

    const hookEvents = traceEvents.filter((e) => e.type === "hook");
    expect(hookEvents.length).toBeGreaterThan(0);
    expect(hookEvents.some((e) => e.label?.includes("city-normalizer"))).toBe(true);

    // Hook events share one traceId, which is what lets the console show a
    // policy decision on the same timeline as the model call.
    const traceIds = new Set(traceEvents.map((e) => e.traceId).filter(Boolean));
    expect(traceIds.size).toBe(1);

    // The INPUT guardrail runs before the first model call, which is where a
    // smart agent's trace session is created, so it legitimately sees no trace
    // id. `runId` is the join key that is always available.
    expect(seenTraceIds[0]).toBeUndefined();
    expect(seenRunIds[0]).toMatch(/^run_/);
  }, 90_000);

  it("stops a real run at a budget ceiling and reports the spend", async () => {
    const metrics: any[] = [];
    const agent = createSmartAgent({
      name: "BudgetedAgent",
      model: realModel(),
      tools: [weatherTool],
      limits: { maxToolCalls: 6 },
      plugins: [
        budgetGuard({ maxModelCalls: 1, onExceeded: "deny" }),
        defineHook("sessionEnd", ({ status, usage }) => {
          metrics.push({ status, calls: usage?.perRequest.length ?? 0 });
        }, { name: "metrics" }),
      ],
    });

    const result = await agent.invoke({
      messages: [
        {
          role: "user",
          content: "Check the weather in Istanbul, then Ankara, then Izmir, using your tool each time.",
        },
      ],
    });

    // The ceiling is one model call, so the run must stop long before it could
    // work through three cities.
    expect(result.state?.usage?.perRequest.length).toBeLessThanOrEqual(2);
    expect(metrics).toHaveLength(1);
  }, 90_000);
});
