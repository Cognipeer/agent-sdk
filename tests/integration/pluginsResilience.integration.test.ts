/**
 * Plugin layer against a REAL model — the failure paths.
 *
 * `plugins.integration.test.ts` proves the happy paths hold when a real model
 * is choosing the tool calls. This file asks the opposite question: when the
 * tool throws, the hook throws, the hook hangs, the guardrail service is down,
 * the caller aborts, the deadline passes, or the plugin cannot even start —
 * does the runtime still end the run cleanly, and does it end it the way the
 * plugin asked it to?
 *
 *   OPENAI_API_KEY=sk-… npx vitest run tests/integration/pluginsResilience.integration.test.ts
 *
 * Any OpenAI-compatible endpoint works:
 *
 *   OPENAI_BASE_URL=http://localhost:11434/v1 \
 *   PLUGIN_TEST_MODEL=qwen2.5 OPENAI_API_KEY=ignored npx vitest run …
 *
 * Skipped entirely without a key. Everything asserted here is a RUNTIME fact —
 * a spy that did or did not run, a transcript that has no dangling tool_call, a
 * ledger row, an event that fired exactly once — never a phrase the model chose.
 */

import { describe, it, expect, vi } from "vitest";
import { z } from "zod";

import { createAgent, createTool } from "../../src/index.js";
import { createProvider, fromNativeProvider } from "../../src/providers/index.js";
import { defineHook } from "../../src/plugins/define.js";
import { createGuardrailPlugin, customGuardrail } from "../../src/plugins/builtin/guardrail.js";
import type { AgentPlugin, PluginEvent } from "../../src/plugins/types.js";
import type { Message, SmartAgentEvent } from "../../src/types.js";

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

// ─── Shared helpers ──────────────────────────────────────────────────────────

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Collector that keeps the `plugin` events apart from the rest of the stream. */
function eventCollector() {
  const all: SmartAgentEvent[] = [];
  return {
    onEvent: (event: SmartAgentEvent) => {
      all.push(event);
    },
    all,
    plugins(): PluginEvent[] {
      return all.filter((e): e is SmartAgentEvent & PluginEvent => e.type === "plugin");
    },
  };
}

const toolMessages = (messages: Message[]) => messages.filter((m) => m.role === "tool");

/**
 * Every `tool_call` id the assistant emitted that no `role: "tool"` message
 * answered. A provider rejects the next request outright when this is non-empty,
 * so it is the single sharpest "did the run end cleanly" assertion available.
 */
function danglingToolCallIds(messages: Message[]): string[] {
  const answered = new Set(
    messages
      .filter((m) => m.role === "tool")
      .map((m) => m.tool_call_id)
      .filter((id): id is string => typeof id === "string"),
  );
  const dangling: string[] = [];
  for (const message of messages) {
    const calls = message.tool_calls as Array<{ id?: string }> | undefined;
    if (!Array.isArray(calls)) continue;
    for (const call of calls) {
      if (call?.id && !answered.has(call.id)) dangling.push(call.id);
    }
  }
  return dangling;
}

/** A tool the model is told to call, whose body is fully under the test's control. */
function scriptedTool(name: string, body: (args: { label: string }) => Promise<unknown>) {
  const func = vi.fn(body);
  const tool = createTool({
    name,
    description: `Run the ${name} job for a label. Always call this before answering.`,
    schema: z.object({ label: z.string().describe("Job label") }),
    func,
  });
  return { tool, func };
}

/** Counts sessionEnd firings and the status each one reported. */
function sessionEndProbe() {
  const statuses: string[] = [];
  const plugin = defineHook(
    "sessionEnd",
    ({ status }) => {
      statuses.push(status);
    },
    { name: "session-end-probe", priority: 900 },
  );
  return { plugin, statuses };
}

/** Records every transcript that actually went to the provider. */
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

const CALL_TOOL_PROMPT =
  'Call the tool with label "nightly" first. You must use the tool — do not answer from memory.';

// ─── 1. A tool that throws mid-run ───────────────────────────────────────────

runReal("a tool that throws mid-run", () => {
  /**
   * The error text is the leakiest string in a run: it lands in the transcript,
   * the history, the event stream and the trace. `postToolUse` used not to be
   * called on the failure path at all, so a redaction plugin saw everything
   * except the one payload most likely to carry a credential. This asserts the
   * whole chain — the hook is invoked with `error` set, its rewrite is what the
   * model reads, and the raw key never reaches the wire.
   */
  it("lets a postToolUse plugin redact the thrown error, records status \"error\", and still answers", async () => {
    const SECRET = "sk-live-4f2a9c7d1e0b8a6f3d5c";
    let calls = 0;
    const { tool, func } = scriptedTool("fetch_account", async ({ label }) => {
      calls += 1;
      // First attempt fails the way a real upstream fails: a 401 that quotes
      // the credential it rejected. Later attempts succeed so the model has a
      // way to recover instead of looping on a permanently broken tool.
      if (calls === 1) {
        throw new Error(`Upstream rejected the request (401) using api_key=${SECRET}`);
      }
      return { label, balance: 42, currency: "EUR" };
    });

    const seenByHook: Array<{ hadError: boolean; sawSecret: boolean }> = [];
    const redactor: AgentPlugin = {
      name: "error-redactor",
      priority: 10,
      // Pure redaction: declaring this keeps the plugin off the "might pause"
      // list, which is the only reason it would change tool scheduling.
      mayRequireApproval: false,
      hooks: {
        postToolUse: ({ output, error }) => {
          const text = typeof output === "string" ? output : JSON.stringify(output);
          seenByHook.push({ hadError: error instanceof Error, sawSecret: text.includes(SECRET) });
          const masked = text.replace(/sk-live-[A-Za-z0-9]+/g, "[REDACTED_API_KEY]");
          return masked === text ? undefined : { output: masked };
        },
      },
    };

    const wire: Message[][] = [];
    const agent = createAgent({
      name: "ThrowingToolAgent",
      model: realModel(),
      tools: [tool],
      limits: { maxToolCalls: 3 },
      plugins: [redactor, wireSpy(wire)],
    });

    const result = await agent.invoke({
      messages: [
        {
          role: "user",
          content: `Look up the account for label "nightly" with your tool and tell me the balance. ${CALL_TOOL_PROMPT}`,
        },
      ],
    });

    expect(func).toHaveBeenCalled();

    // The hook was handed the FAILURE, not just the successes.
    const errorObservation = seenByHook.find((entry) => entry.hadError);
    expect(errorObservation).toBeDefined();
    expect(errorObservation!.sawSecret).toBe(true);

    // The ledger tells the truth about what happened.
    const history = result.state?.toolHistory ?? [];
    expect(history.some((entry) => entry.status === "error")).toBe(true);

    // The redaction is worthless unless it beat the provider to the string.
    expect(wire.length).toBeGreaterThan(0);
    expect(JSON.stringify(wire)).not.toContain(SECRET);
    expect(JSON.stringify(result.messages)).not.toContain(SECRET);
    expect(JSON.stringify(result.state?.toolHistory ?? [])).not.toContain(SECRET);
    expect(JSON.stringify(result.messages)).toContain("[REDACTED_API_KEY]");

    // A thrown tool must not take the run down with it.
    expect(danglingToolCallIds(result.messages)).toEqual([]);
    expect(result.content.length).toBeGreaterThan(0);
  }, 120_000);
});

// ─── 2 & 3. A hook that throws ───────────────────────────────────────────────

runReal("a preToolUse hook that throws", () => {
  const throwingGate = (failureMode: "open" | "closed") =>
    defineHook(
      "preToolUse",
      () => {
        throw new Error("hook exploded while evaluating the call");
      },
      { name: "exploding-gate", failureMode, priority: 10 },
    );

  it("failureMode \"open\": the call goes through and a plugin event reports the error", async () => {
    const { tool, func } = scriptedTool("run_job", async ({ label }) => ({ label, status: "ok" }));
    const events = eventCollector();
    const probe = sessionEndProbe();

    const agent = createAgent({
      name: "FailOpenHookAgent",
      model: realModel(),
      tools: [tool],
      limits: { maxToolCalls: 2 },
      plugins: [throwingGate("open"), probe.plugin],
    });

    const result = await agent.invoke(
      { messages: [{ role: "user", content: `Run the job for label "nightly". ${CALL_TOOL_PROMPT}` }] },
      { onEvent: events.onEvent },
    );

    // Fail-open means the broken policy does not stand between the model and
    // the tool.
    expect(func).toHaveBeenCalled();

    const failures = events
      .plugins()
      .filter((e) => e.plugin === "exploding-gate" && e.hook === "preToolUse" && e.phase === "error");
    expect(failures.length).toBeGreaterThan(0);
    expect(failures[0].error?.message).toContain("hook exploded");

    expect(danglingToolCallIds(result.messages)).toEqual([]);
    expect(result.content.length).toBeGreaterThan(0);
    expect(probe.statuses).toEqual(["success"]);
  }, 120_000);

  it("failureMode \"closed\": the call is denied and the run still terminates cleanly", async () => {
    const { tool, func } = scriptedTool("run_job", async ({ label }) => ({ label, status: "ok" }));
    const events = eventCollector();
    const probe = sessionEndProbe();

    const agent = createAgent({
      name: "FailClosedHookAgent",
      model: realModel(),
      tools: [tool],
      limits: { maxToolCalls: 2 },
      plugins: [throwingGate("closed"), probe.plugin],
    });

    const result = await agent.invoke(
      { messages: [{ role: "user", content: `Run the job for label "nightly". ${CALL_TOOL_PROMPT}` }] },
      { onEvent: events.onEvent },
    );

    // A hook that cannot decide has not granted permission.
    expect(func).not.toHaveBeenCalled();

    const tools = toolMessages(result.messages);
    expect(tools.length).toBeGreaterThan(0);
    // One tool message per tool_call, and every tool_call answered: the
    // transcript the next provider call would see is valid.
    expect(danglingToolCallIds(result.messages)).toEqual([]);
    expect(tools.length).toBe(
      result.messages.reduce((count, message) => {
        const calls = message.tool_calls as Array<{ id?: string }> | undefined;
        return count + (Array.isArray(calls) ? calls.length : 0);
      }, 0),
    );

    // The denial names the plugin and says why, so an operator can tell a
    // policy refusal from a crash.
    const denialText = JSON.stringify(tools);
    expect(denialText).toContain("exploding-gate");
    expect(denialText).toContain("fail-closed");

    const history = result.state?.toolHistory ?? [];
    expect(history.length).toBeGreaterThan(0);
    expect(history.every((entry) => entry.status === "rejected")).toBe(true);

    expect(result.content.length).toBeGreaterThan(0);
    expect(probe.statuses).toEqual(["success"]);
  }, 120_000);
});

// ─── 4. A hook that hangs past its timeout ───────────────────────────────────

runReal("a preToolUse hook that hangs past its timeoutMs", () => {
  const hangingGate = (failureMode: "open" | "closed") =>
    defineHook(
      "preToolUse",
      async () => {
        await sleep(5_000);
        return { decision: "allow" as const };
      },
      { name: "hanging-gate", failureMode, timeoutMs: 250, priority: 10 },
    );

  it("fail-open lets the call through after the timeout, and reports phase \"timeout\"", async () => {
    const { tool, func } = scriptedTool("run_job", async ({ label }) => ({ label, status: "ok" }));
    const events = eventCollector();

    const agent = createAgent({
      name: "TimeoutOpenAgent",
      model: realModel(),
      tools: [tool],
      limits: { maxToolCalls: 2 },
      plugins: [hangingGate("open")],
    });

    const startedAt = Date.now();
    const result = await agent.invoke(
      { messages: [{ role: "user", content: `Run the job for label "nightly". ${CALL_TOOL_PROMPT}` }] },
      { onEvent: events.onEvent },
    );
    const elapsed = Date.now() - startedAt;

    expect(func).toHaveBeenCalled();

    const timeouts = events.plugins().filter((e) => e.plugin === "hanging-gate" && e.phase === "timeout");
    expect(timeouts.length).toBeGreaterThan(0);
    expect(timeouts[0].error?.message).toContain("timed out after 250ms");

    // The point of a per-handler timeout: the run does not wait out the hang.
    // One tool call at 5s each would already blow this, and the run also had
    // to make its model calls, so the ceiling is generous but still decisive.
    expect(elapsed).toBeLessThan(60_000);

    expect(danglingToolCallIds(result.messages)).toEqual([]);
    expect(result.content.length).toBeGreaterThan(0);
  }, 120_000);

  it("fail-closed denies the call once the timeout fires", async () => {
    const { tool, func } = scriptedTool("run_job", async ({ label }) => ({ label, status: "ok" }));
    const events = eventCollector();

    const agent = createAgent({
      name: "TimeoutClosedAgent",
      model: realModel(),
      tools: [tool],
      limits: { maxToolCalls: 2 },
      plugins: [hangingGate("closed")],
    });

    const result = await agent.invoke(
      { messages: [{ role: "user", content: `Run the job for label "nightly". ${CALL_TOOL_PROMPT}` }] },
      { onEvent: events.onEvent },
    );

    expect(func).not.toHaveBeenCalled();

    const timeouts = events.plugins().filter((e) => e.plugin === "hanging-gate" && e.phase === "timeout");
    expect(timeouts.length).toBeGreaterThan(0);

    const tools = toolMessages(result.messages);
    expect(tools.length).toBeGreaterThan(0);
    expect(JSON.stringify(tools)).toContain("timed out");
    expect((result.state?.toolHistory ?? []).every((entry) => entry.status === "rejected")).toBe(true);
    expect(danglingToolCallIds(result.messages)).toEqual([]);
    expect(result.content.length).toBeGreaterThan(0);
  }, 120_000);
});

// ─── 5. A guardrail whose transport is down ──────────────────────────────────

runReal("a guardrail transport that always rejects", () => {
  const deadTransport = () =>
    customGuardrail(() => {
      throw new Error("guardrail service unreachable: ECONNREFUSED 127.0.0.1:9");
    }, "dead-service");

  it("fail-closed blocks the turn before the model is ever called", async () => {
    const wire: Message[][] = [];
    const events = eventCollector();
    const probe = sessionEndProbe();

    const agent = createAgent({
      name: "GuardrailDownClosedAgent",
      model: realModel(),
      plugins: [
        createGuardrailPlugin({
          name: "unreachable-policy",
          apply: ["input"],
          transport: deadTransport(),
          // The default, spelled out because it is the whole subject here.
          failClosed: true,
        }),
        wireSpy(wire),
        probe.plugin,
      ],
    });

    const result = await agent.invoke(
      { messages: [{ role: "user", content: "Say the single word: pineapple." }] },
      { onEvent: events.onEvent },
    );

    // An input policy that could not run must not be bypassed — and the block
    // has to happen before the prompt reaches the provider, or the "block" is
    // cosmetic.
    expect(wire).toHaveLength(0);
    expect(result.content).toContain("unreachable-policy");
    expect(result.content).toContain("ECONNREFUSED");
    expect(result.messages.some((m) => m.role === "assistant")).toBe(true);
    expect(danglingToolCallIds(result.messages)).toEqual([]);
    expect(probe.statuses).toHaveLength(1);
  }, 90_000);

  it("the same config with failClosed:false lets the turn through", async () => {
    const wire: Message[][] = [];
    const events = eventCollector();
    const probe = sessionEndProbe();

    const agent = createAgent({
      name: "GuardrailDownOpenAgent",
      model: realModel(),
      plugins: [
        createGuardrailPlugin({
          name: "unreachable-policy",
          apply: ["input"],
          transport: deadTransport(),
          failClosed: false,
        }),
        wireSpy(wire),
        probe.plugin,
      ],
    });

    const result = await agent.invoke(
      { messages: [{ role: "user", content: "Say the single word: pineapple." }] },
      { onEvent: events.onEvent },
    );

    // Availability chosen over enforcement: the provider was reached and the
    // model answered.
    expect(wire.length).toBeGreaterThan(0);
    expect(result.content.length).toBeGreaterThan(0);
    expect(result.content).not.toContain("ECONNREFUSED");

    // The failure is still reported rather than swallowed silently.
    const errors = events
      .plugins()
      .filter((e) => e.plugin === "unreachable-policy" && e.phase === "error");
    expect(errors.length).toBeGreaterThan(0);
    expect(probe.statuses).toEqual(["success"]);
  }, 90_000);
});

// ─── 6 & 7. Cancellation and deadlines ───────────────────────────────────────

runReal("cancellation while a slow tool is running", () => {
  it("returns instead of hanging, marks ctx.__cancelled, and ends the session exactly once", async () => {
    const controller = new AbortController();
    const probe = sessionEndProbe();

    // Aborting from inside the tool body is what makes this deterministic:
    // the signal is guaranteed to flip while a tool execution is in flight,
    // which is the case a wall-clock timer can only approximate.
    const { tool, func } = scriptedTool("slow_job", async ({ label }) => {
      controller.abort();
      await sleep(1_500);
      return { label, status: "finished-anyway" };
    });

    const agent = createAgent({
      name: "AbortedAgent",
      model: realModel(),
      tools: [tool],
      limits: { maxToolCalls: 2 },
      plugins: [probe.plugin],
    });

    // Backstop so a model that refuses to call the tool fails the assertions
    // below rather than wedging the suite.
    const backstop = setTimeout(() => controller.abort(), 45_000);
    let result;
    try {
      result = await agent.invoke(
        { messages: [{ role: "user", content: `Run the slow job for label "nightly". ${CALL_TOOL_PROMPT}` }] },
        { cancellationToken: controller.signal },
      );
    } finally {
      clearTimeout(backstop);
    }

    expect(func).toHaveBeenCalled();

    const cancelled = result.state?.ctx?.__cancelled as { reason?: string; stage?: string } | undefined;
    expect(cancelled).toBeTruthy();
    expect(cancelled?.reason).toBe("aborted");

    expect(probe.statuses).toEqual(["cancelled"]);
  }, 120_000);

  /**
   * DEFECT (src/nodes/tools.ts): a cancellation raised mid-batch abandons the
   * remaining planned tool calls WITHOUT writing a `role: "tool"` message for
   * them, so `result.messages` comes back with an assistant turn whose
   * tool_calls are only partly answered.
   *
   * Both sibling paths go out of their way to avoid exactly this — the
   * `preToolUse` deny path pushes one tool message "so the tool_use is resolved
   * and the transcript stays valid", and so does a rejected approval. The
   * cancellation path (`checkCancellationStop`, and the guard at the top of
   * `runOne`) returns `{ status: "error" }` and pushes nothing.
   *
   * The transcript is what a caller persists and later resumes or replays, and
   * a dangling tool_call is a hard 400 on every OpenAI-compatible provider
   * ("an assistant message with 'tool_calls' must be followed by tool messages
   * responding to each tool_call_id"). Observed live: 2 tool_calls, 1 tool
   * message, 1 dangling id.
   *
   * Skipped, not weakened: unskip once cancellation resolves the calls it
   * skipped (a "Cancelled before execution" tool message, the same shape the
   * deny path uses).
   */
  it("resolves the tool calls it skipped, so the cancelled transcript stays valid", async () => {
    const controller = new AbortController();
    let executions = 0;
    const { tool, func } = scriptedTool("slow_job", async ({ label }) => {
      executions += 1;
      // Abort during the FIRST of the batch, so the siblings are abandoned
      // rather than merely never started.
      if (executions === 1) controller.abort();
      await sleep(800);
      return { label, status: "finished-anyway" };
    });

    const agent = createAgent({
      name: "AbortedBatchAgent",
      model: realModel(),
      tools: [tool],
      limits: { maxToolCalls: 4 },
    });

    const backstop = setTimeout(() => controller.abort(), 45_000);
    let result;
    try {
      result = await agent.invoke(
        {
          messages: [
            {
              role: "user",
              content:
                'Call slow_job twice in a single turn: once with label "alpha" and once with label "beta". Emit both tool calls together.',
            },
          ],
        },
        { cancellationToken: controller.signal },
      );
    } finally {
      clearTimeout(backstop);
    }

    expect(func).toHaveBeenCalled();
    expect(result.state?.ctx?.__cancelled).toBeTruthy();

    // The premise: the model really did emit a batch, so there was a sibling
    // left to abandon. Without this the assertion below passes vacuously.
    const plannedCalls = result.messages.reduce((count, message) => {
      const calls = message.tool_calls as Array<{ id?: string }> | undefined;
      return count + (Array.isArray(calls) ? calls.length : 0);
    }, 0);
    expect(plannedCalls).toBeGreaterThan(1);

    // Actual today: one dangling id — the sibling that never ran.
    expect(danglingToolCallIds(result.messages)).toEqual([]);
  }, 120_000);

  it("an invoke timeoutMs cancels the same way and reports reason \"timeout\"", async () => {
    const probe = sessionEndProbe();
    const { tool } = scriptedTool("slow_job", async ({ label }) => {
      await sleep(14_000);
      return { label, status: "finished-anyway" };
    });

    const agent = createAgent({
      name: "DeadlineAgent",
      model: realModel(),
      tools: [tool],
      limits: { maxToolCalls: 2 },
      plugins: [probe.plugin],
    });

    const startedAt = Date.now();
    const result = await agent.invoke(
      { messages: [{ role: "user", content: `Run the slow job for label "nightly". ${CALL_TOOL_PROMPT}` }] },
      { timeoutMs: 10_000 },
    );
    const elapsed = Date.now() - startedAt;

    const cancelled = result.state?.ctx?.__cancelled as { reason?: string; stage?: string } | undefined;
    expect(cancelled).toBeTruthy();
    expect(cancelled?.reason).toBe("timeout");

    // The deadline ends the run at the next checkpoint rather than letting it
    // keep looping: one slow tool, not two.
    expect(elapsed).toBeLessThan(60_000);
    expect(probe.statuses).toEqual(["cancelled"]);
  }, 120_000);
});

// ─── 8. A plugin whose setup throws ──────────────────────────────────────────

runReal("a plugin whose setup throws", () => {
  const brokenSetup = (failureMode: "open" | "closed"): AgentPlugin => ({
    name: "broken-boot",
    failureMode,
    setup: () => {
      throw new Error("could not reach the policy service during boot");
    },
    hooks: {
      sessionStart: () => undefined,
    },
  });

  it("fail-open builds the agent and runs without it", async () => {
    const probe = sessionEndProbe();
    const agent = createAgent({
      name: "BrokenSetupOpenAgent",
      model: realModel(),
      plugins: [brokenSetup("open"), probe.plugin],
    });

    const result = await agent.invoke({
      messages: [{ role: "user", content: "Reply with exactly one short sentence about the sea." }],
    });

    expect(result.content.length).toBeGreaterThan(0);
    expect(probe.statuses).toEqual(["success"]);
  }, 90_000);

  it("fail-closed rejects the invoke by name, and keeps rejecting on the next one", async () => {
    const probe = sessionEndProbe();
    const agent = createAgent({
      name: "BrokenSetupClosedAgent",
      model: realModel(),
      plugins: [brokenSetup("closed"), probe.plugin],
    });

    await expect(
      agent.invoke({ messages: [{ role: "user", content: "Say hello." }] }),
    ).rejects.toThrow(/broken-boot/);

    // The dangerous shape is a memoised setup that "succeeded" the second time
    // with empty contributions: the agent would then run unguarded, forever,
    // because the control that refused to start is simply absent.
    await expect(
      agent.invoke({ messages: [{ role: "user", content: "Say hello again." }] }),
    ).rejects.toThrow(/broken-boot/);

    // Setup failed before any run was opened, so no session was ever bracketed.
    expect(probe.statuses).toEqual([]);
  }, 90_000);
});
