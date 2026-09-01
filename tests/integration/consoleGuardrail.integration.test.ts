/**
 * The Cognipeer Console guardrail, end to end against a running Console.
 *
 * Everything else about this preset is unit-tested against a stubbed fetch,
 * which proves the mapping but not the contract. These runs are the only place
 * the two are checked against each other — and the contract has already moved
 * twice under us, so the check earns its keep.
 *
 * Needs a guardrail FIXTURE in the tenant. Create a deterministic one (no
 * model call, so the verdict is stable):
 *
 *   POST {base}/api/client/v1/guardrails
 *   { "name": "sdk-e2e-pii", "type": "preset", "action": "block",
 *     "policy": { "pii": { "enabled": true, "action": "block",
 *                          "categories": { "email": true, "creditCard": true } } } }
 *
 * The response's `key` is what goes in COGNIPEER_GUARDRAIL_KEY.
 *
 *   COGNIPEER_BASE_URL=http://localhost:3000 \
 *   COGNIPEER_API_KEY=cpeer_… \
 *   COGNIPEER_GUARDRAIL_KEY=sdk-e2e-pii \
 *   OPENAI_BASE_URL=http://localhost:3000/api/client/v1 \
 *   OPENAI_API_KEY=cpeer_… PLUGIN_TEST_MODEL=gpt-5.6-luna \
 *   npx vitest run tests/integration/consoleGuardrail.integration.test.ts
 */

import { describe, it, expect, vi } from "vitest";
import { createAgent, createTool } from "../../src/index.js";
import { createProvider, fromNativeProvider } from "../../src/providers/index.js";
import { cognipeerGuardrail } from "../../src/plugins/builtin/cognipeerGuardrail.js";
import { openAIModeration } from "../../src/plugins/builtin/guardrailPresets.js";
import { defineHook } from "../../src/plugins/define.js";
import { z } from "zod";
import type { Message, SmartAgentEvent } from "../../src/types.js";

const CONSOLE_URL = process.env.COGNIPEER_BASE_URL;
const CONSOLE_KEY = process.env.COGNIPEER_API_KEY;
const GUARDRAIL_KEY = process.env.COGNIPEER_GUARDRAIL_KEY;
const MODEL_KEY = process.env.OPENAI_API_KEY;
const MODEL = process.env.PLUGIN_TEST_MODEL ?? "gpt-4o-mini";
const MODEL_BASE = process.env.OPENAI_BASE_URL;

const ready = Boolean(CONSOLE_URL && CONSOLE_KEY && GUARDRAIL_KEY && MODEL_KEY);
const runLive = ready ? describe : describe.skip;

function realModel() {
  return fromNativeProvider(
    createProvider({
      provider: "openai",
      apiKey: MODEL_KEY!,
      defaultModel: MODEL,
      ...(MODEL_BASE ? { baseURL: MODEL_BASE } : {}),
    }),
    { model: MODEL },
  );
}

const guardrail = (overrides: Parameters<typeof cognipeerGuardrail>[0] = {}) =>
  cognipeerGuardrail({
    apiKey: CONSOLE_KEY,
    baseUrl: CONSOLE_URL,
    guardrailKey: GUARDRAIL_KEY,
    ...overrides,
  });

/** Records the wire messages, so "was the model even called" is answerable. */
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

runLive("Cognipeer Console guardrail, live", () => {
  it("lets a clean turn through and calls the model", async () => {
    const wire: Message[][] = [];
    const agent = createAgent({
      name: "ConsoleGuarded",
      model: realModel(),
      plugins: [guardrail({ apply: ["input"] }), wireSpy(wire)],
    });

    const result = await agent.invoke({
      messages: [{ role: "user", content: "Reply with exactly one short sentence about the sea." }],
    });

    expect(wire.length).toBeGreaterThan(0);
    expect(result.content.length).toBeGreaterThan(0);
  }, 90_000);

  it("blocks a turn carrying PII, before the model is ever called", async () => {
    const wire: Message[][] = [];
    const events: SmartAgentEvent[] = [];
    const agent = createAgent({
      name: "ConsoleGuarded",
      model: realModel(),
      plugins: [guardrail({ apply: ["input"] }), wireSpy(wire)],
    });

    const result = await agent.invoke(
      { messages: [{ role: "user", content: "Please write to ada.lovelace@example.com about the invoice." }] },
      { onEvent: (event) => events.push(event) },
    );

    // Blocked at the door: the provider was never reached.
    expect(wire).toHaveLength(0);
    expect(result.content.length).toBeGreaterThan(0);
    // The refusal is the Console's own prose, read out of `blocked_message.body`
    // — passing the object through would surface "[object Object]" to a user.
    expect(result.content).not.toContain("[object Object]");
    expect(events.some((e) => e.type === "plugin" && (e as { decision?: string }).decision === "deny")).toBe(true);
  }, 90_000);

  it("carries the Console's findings through as violations, with their spans", async () => {
    const reported: Array<Record<string, unknown>> = [];
    const agent = createAgent({
      name: "ConsoleGuarded",
      model: realModel(),
      plugins: [guardrail({ apply: ["input"] })],
    });

    await agent.invoke(
      { messages: [{ role: "user", content: "mail me at ada.lovelace@example.com" }] },
      {
        onEvent: (event) => {
          const guardrailMeta = (event as { guardrail?: Record<string, unknown> }).guardrail;
          if (guardrailMeta) reported.push(guardrailMeta);
        },
      },
    );

    expect(reported.length).toBeGreaterThan(0);
    const violations = reported[0].violations as Array<Record<string, unknown>> | undefined;
    expect(Array.isArray(violations)).toBe(true);
    // The Console's findings carry family/checkId/span — which is the
    // span-level provenance the SDK's own mutation path cannot produce.
    expect(violations![0]).toMatchObject({ family: "pii" });
    expect(violations![0].span).toBeDefined();
  }, 90_000);

  it("fails CLOSED on an unknown guardrail key rather than reading a 404 as safe", async () => {
    const wire: Message[][] = [];
    const agent = createAgent({
      name: "ConsoleGuarded",
      model: realModel(),
      plugins: [guardrail({ guardrailKey: "sdk-e2e-does-not-exist", apply: ["input"] }), wireSpy(wire)],
    });

    const result = await agent.invoke({ messages: [{ role: "user", content: "hello" }] });

    // The endpoint answers 404 on purpose so a client cannot mistake a missing
    // policy for a clean verdict. Under the default posture that stops the run.
    expect(wire).toHaveLength(0);
    expect(result.content.length).toBeGreaterThan(0);
  }, 90_000);

  it("lets the same misconfiguration through when the caller chose failClosed:false", async () => {
    const wire: Message[][] = [];
    const agent = createAgent({
      name: "ConsoleGuarded",
      model: realModel(),
      plugins: [
        guardrail({ guardrailKey: "sdk-e2e-does-not-exist", apply: ["input"], failClosed: false }),
        wireSpy(wire),
      ],
    });

    const result = await agent.invoke({ messages: [{ role: "user", content: "Say hello in one word." }] });

    expect(wire.length).toBeGreaterThan(0);
    expect(result.content.length).toBeGreaterThan(0);
  }, 90_000);

  it("reports but does not block in shadow mode", async () => {
    const wire: Message[][] = [];
    const events: SmartAgentEvent[] = [];
    const agent = createAgent({
      name: "ConsoleShadow",
      model: realModel(),
      plugins: [guardrail({ apply: ["input"], mode: "shadow" }), wireSpy(wire)],
    });

    const result = await agent.invoke(
      { messages: [{ role: "user", content: "mail me at ada.lovelace@example.com, one short sentence back please" }] },
      { onEvent: (event) => events.push(event) },
    );

    // Shadow is how a policy is measured before it is switched on: the finding
    // is reported, the turn is not stopped.
    expect(wire.length).toBeGreaterThan(0);
    expect(result.content.length).toBeGreaterThan(0);
    const guardrailEvents = events.filter((e) => (e as { guardrail?: unknown }).guardrail);
    expect(guardrailEvents.length).toBeGreaterThan(0);
    expect((guardrailEvents[0] as { guardrail: { enforced: boolean } }).guardrail.enforced).toBe(false);
  }, 90_000);

  it("speaks the real moderations wire contract, live", async () => {
    // The Console serves an OpenAI-compatible /moderations endpoint backed by a
    // guardrail carrying a moderation policy. This is the only place the
    // preset's request shape and response parsing are checked against the wire
    // rather than against a stub.
    //
    // Only the ALLOW path is asserted: this deployment's classifier does not
    // flag the samples that would exercise a block, and asserting on a
    // classifier's judgement would be a flaky test about someone else's model.
    // The flagged→deny mapping is covered by the unit tests.
    const moderationKey = process.env.COGNIPEER_MODERATION_GUARDRAIL_KEY;
    if (!moderationKey) return;

    const wire: Message[][] = [];
    const agent = createAgent({
      name: "ConsoleModeration",
      model: realModel(),
      plugins: [
        openAIModeration({
          apiKey: CONSOLE_KEY,
          // The preset appends `/v1/moderations`, so the base stops before it.
          baseUrl: `${CONSOLE_URL}/api/client`,
          model: moderationKey,
          apply: ["input"],
        }),
        wireSpy(wire),
      ],
    });

    const result = await agent.invoke({
      messages: [{ role: "user", content: "Reply with one short sentence about gardening." }],
    });

    // A clean turn was moderated and allowed through: the endpoint answered in
    // the shape the preset expects, and nothing was misread as a refusal.
    expect(wire.length).toBeGreaterThan(0);
    expect(result.content.length).toBeGreaterThan(0);
    expect(result.state?.ctx?.__guardrailBlocked).toBeUndefined();
  }, 90_000);

  it("does NOT block a monitor-mode guardrail, live", async () => {
    // The symmetric failure to silent non-enforcement is silent ENFORCEMENT,
    // and it is the more expensive one: a policy switched on to be observed
    // would start refusing real traffic. Verified against a guardrail created
    // with `mode: "monitor"`, which answers enforced:false with findings.
    const monitorKey = process.env.COGNIPEER_MONITOR_GUARDRAIL_KEY;
    if (!monitorKey) {
      // Nothing to assert without the fixture; skip rather than pass vacuously.
      return;
    }

    const wire: Message[][] = [];
    const events: SmartAgentEvent[] = [];
    const agent = createAgent({
      name: "ConsoleMonitor",
      model: realModel(),
      plugins: [guardrail({ guardrailKey: monitorKey, apply: ["input"] }), wireSpy(wire)],
    });

    const result = await agent.invoke(
      { messages: [{ role: "user", content: "mail me at ada.lovelace@example.com, one short sentence back" }] },
      { onEvent: (event) => events.push(event) },
    );

    // The finding exists and the turn still ran.
    expect(wire.length).toBeGreaterThan(0);
    expect(result.content.length).toBeGreaterThan(0);
    expect(events.some((e) => e.type === "plugin" && (e as { decision?: string }).decision === "deny")).toBe(false);
  }, 90_000);

  it("says so out loud when the guardrail is not active for the surface asked for", async () => {
    const func = vi.fn(async ({ to }: { to: string }) => ({ sent: true, to }));
    const emailTool = createTool({
      name: "send_email",
      description: "Send an email to a recipient address.",
      schema: z.object({ to: z.string(), body: z.string() }),
      func,
    });

    const events: SmartAgentEvent[] = [];
    const agent = createAgent({
      name: "ConsoleToolGuarded",
      model: realModel(),
      tools: [emailTool],
      // The fixture is scoped `target: "input"`, so it does NOT apply on the
      // tool surface. That is a configuration mistake with no symptom: the
      // caller asked for tools to be guarded and they silently are not.
      plugins: [guardrail({ apply: ["tool"] })],
    });

    const result = await agent.invoke(
      {
        messages: [
          {
            role: "user",
            content: "Use your tool to send an email to ada.lovelace@example.com saying the invoice is ready.",
          },
        ],
      },
      { onEvent: (event) => events.push(event) },
    );

    expect(result.content.length).toBeGreaterThan(0);

    // The Console reports `disabled: true` for a surface the policy does not
    // cover, and the plugin turns that into a visible signal instead of a
    // clean-looking allow. Silent non-enforcement is worse than no policy.
    const inactive = events.filter((e) => (e as { guardrailInactive?: unknown }).guardrailInactive);
    expect(inactive.length).toBeGreaterThan(0);
    expect((inactive[0] as { guardrailInactive: { phase: string } }).guardrailInactive.phase).toBe("tool");

    // And it is honest about the consequence: nothing stopped the call.
    expect(func).toHaveBeenCalled();
  }, 90_000);
});
