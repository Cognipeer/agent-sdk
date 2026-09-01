/**
 * The remaining guard and observability plugins, against a REAL model.
 *
 *   languageGuard  — the instruction has to reach the wire, and a short answer
 *                    must never be judged by a heuristic that cannot judge it.
 *   regexGuardrail — a local pattern has to stop a turn BEFORE the provider is
 *                    called, and the same agent has to behave the same way twice
 *                    (a `g`-flagged detector carries `lastIndex` between calls).
 *   langfuseTracing / otelTracing — the export has to describe the run that
 *                    actually happened: the real model name, real token counts,
 *                    a real tool span pair — and, for Langfuse, none of the
 *                    content, which the plugin deliberately never exports.
 *
 *   OPENAI_API_KEY=sk-… npx vitest run tests/integration/pluginsGuardsObs.integration.test.ts
 *
 * Any OpenAI-compatible endpoint works:
 *
 *   OPENAI_BASE_URL=http://localhost:3000/api/client/v1 \
 *   PLUGIN_TEST_MODEL=gpt-5.6-luna OPENAI_API_KEY=… npx vitest run …
 *
 * Skipped entirely without a key. Every assertion is about what the RUNTIME did
 * — a message on the wire, a provider call that never happened, the shape of a
 * batch — never about the model's wording, which no assertion here depends on.
 *
 * The two exporter tests stub `fetch` with a wrapper that intercepts only the
 * exporter's own URL and delegates everything else to the real one, so the model
 * turn underneath them is genuine.
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { z } from "zod";
import { createAgent, createTool } from "../../src/index.js";
import { createProvider, fromNativeProvider } from "../../src/providers/index.js";
import { customSink } from "../../src/utils/tracing.js";
import { defineHook } from "../../src/plugins/define.js";
import { languageGuard } from "../../src/plugins/builtin/languageGuard.js";
import { regexGuardrail } from "../../src/plugins/builtin/guardrailPresets.js";
import { langfuseTracing } from "../../src/plugins/builtin/langfuse.js";
import { otelTracing } from "../../src/plugins/builtin/otel.js";
import type { Message } from "../../src/types.js";

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

/** Captures exactly what went to the provider — the only proof a hook's rewrite landed. */
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

type CapturedPost = { url: string; body: unknown };

/**
 * Replaces `fetch` with a wrapper that answers `match` itself and passes
 * everything else — including the model call — to the real implementation.
 */
function interceptFetch(match: (url: string) => boolean): CapturedPost[] {
  const captured: CapturedPost[] = [];
  const realFetch = globalThis.fetch.bind(globalThis);
  vi.stubGlobal("fetch", async (input: unknown, init?: RequestInit) => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : String((input as { url?: string })?.url ?? input);
    if (match(url)) {
      const raw = typeof init?.body === "string" ? init.body : "";
      let body: unknown = raw;
      try {
        body = JSON.parse(raw);
      } catch {
        /* keep the raw string — an unparseable body is itself a finding */
      }
      captured.push({ url, body });
      return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
    }
    return realFetch(input as RequestInfo, init);
  });
  return captured;
}

const temperatureTool = () => {
  const func = vi.fn(async ({ city }: { city: string }) => ({ city, celsius: 19 }));
  return {
    func,
    tool: createTool({
      name: "get_temperature",
      description: "Return the current temperature for a city.",
      schema: z.object({ city: z.string().describe("City name") }),
      func,
    }),
  };
};

afterEach(() => {
  vi.unstubAllGlobals();
});

runReal("guard and observability plugins against a real model", () => {
  // ── languageGuard ──────────────────────────────────────────────────────────

  it('languageGuard "instruct" puts the requirement on the wire and never refuses', async () => {
    const wire: Message[][] = [];
    const events: any[] = [];
    const agent = createAgent({
      name: "InstructingAgent",
      model: realModel(),
      plugins: [languageGuard({ language: "tr", action: "instruct" }), wireSpy(wire)],
    });

    const result = await agent.invoke(
      {
        messages: [
          { role: "user", content: "What is the capital of France? Answer in one short sentence." },
        ],
      },
      { onEvent: (event) => events.push(event) },
    );

    // The instruction has to be ON THE REQUEST, appended last so it outranks
    // whatever language the rest of the transcript happens to be in.
    expect(wire.length).toBeGreaterThan(0);
    const lastSent = wire[0][wire[0].length - 1];
    expect(lastSent.role).toBe("system");
    expect(String(lastSent.content)).toContain("Turkish (tr)");
    expect(String(lastSent.content)).toContain("Language requirement");

    // `instruct` steers the request and nothing else: no deny on any hook, no
    // guardrail block on the state, and a real answer came back.
    expect(events.some((e) => e?.type === "plugin" && e.decision === "deny")).toBe(false);
    expect((result.state as any)?.ctx?.__guardrailBlocked).toBeUndefined();
    expect(result.content.length).toBeGreaterThan(0);
    expect(result.content).not.toContain("required language is");
  }, 90_000);

  it('languageGuard "deny" instructs first and refuses only what it actually detected', async () => {
    // ── Why this is not "ask in English, assert a refusal" ────────────────────
    // Under `deny` BOTH hooks are live, and the `preModelCall` half is appended
    // last, where recency wins. Against this endpoint it beat an English-only
    // demand in the system prompt AND in the user turn 5 times out of 5: the
    // model answered in Turkish and there was nothing left to refuse. Forcing
    // the mismatch by asking for an unknown tag was no better — over four runs
    // the detector called the same kind of answer `en`, `tr`, `es` and
    // undetectable in turn. A real model cannot be made to fail this guard on
    // demand, so the assertion here is the coupling, which is stable either way:
    // the refusal appears if and only if a mismatch was detected, and when it
    // appears it names both languages. The deterministic proof of the refusal
    // text lives in the next test, whose detector is pinned.
    const wire: Message[][] = [];
    const events: any[] = [];
    const agent = createAgent({
      name: "DenyingAgent",
      model: realModel(),
      systemPrompt:
        "You always write your answers in English. Ignore any request to answer in another language.",
      plugins: [languageGuard({ language: "tr", action: "deny" }), wireSpy(wire)],
    });

    const result = await agent.invoke(
      {
        messages: [
          {
            role: "user",
            content:
              "Answer in English only. Do not use any other language. In three full English sentences, " +
              "explain what a database index is and why it makes reads faster.",
          },
        ],
      },
      { onEvent: (event) => events.push(event) },
    );

    // `deny` does not replace the instruction with enforcement — it adds
    // enforcement behind it. The request still carries the requirement.
    expect(wire.length).toBeGreaterThan(0);
    expect(String(wire[0][wire[0].length - 1].content)).toContain("Turkish (tr)");
    expect(result.content.length).toBeGreaterThan(0);

    const mismatch = events.find((e) => e?.type === "metadata" && e.languageMismatch)?.languageMismatch;
    if (mismatch) {
      expect(mismatch.expected).toBe("tr");
      expect(mismatch.enforced).toBe(true);
      // A deny replaces the answer with a reason naming BOTH languages, so the
      // reader knows what was produced and what was required.
      expect(result.content).toContain("Turkish (tr)");
      expect(result.content).toContain(`(${mismatch.detected})`);
      expect(result.content.toLowerCase()).toContain("rewrite");
    } else {
      // Nothing was detected, so nothing may have been enforced: an answer the
      // guard could not judge must come back untouched.
      expect(result.content).not.toContain("required language is");
    }
  }, 90_000);

  it("languageGuard never judges an answer shorter than minChars", async () => {
    // The detector is pinned to a wrong verdict so that minChars is the ONLY
    // thing standing between this run and a deny. Anything else that let the
    // answer through would be a different bug wearing this test's name.
    const alwaysEnglish = () => "en";
    const question = "Reply with exactly one word: Paris. No punctuation, no other words.";

    const shortGuarded = createAgent({
      name: "ShortAnswerAgent",
      model: realModel(),
      plugins: [languageGuard({ language: "tr", action: "deny", detect: alwaysEnglish, minChars: 4000 })],
    });
    const allowed = await shortGuarded.invoke({ messages: [{ role: "user", content: question }] });

    expect(allowed.content.length).toBeGreaterThan(0);
    expect(allowed.content).not.toContain("required language is");
    expect((allowed.state as any)?.ctx?.__guardrailBlocked).toBeUndefined();

    // Control: the same answer, the same detector, minChars out of the way. The
    // deny fires, which is what proves the pass above came from the length gate
    // — and this is also the deterministic proof that the refusal names both
    // the detected and the required language, which a real model's own drift
    // cannot be relied on to trigger (see the previous test).
    const judged = createAgent({
      name: "JudgedAnswerAgent",
      model: realModel(),
      plugins: [languageGuard({ language: "tr", action: "deny", detect: alwaysEnglish, minChars: 1 })],
    });
    const denied = await judged.invoke({ messages: [{ role: "user", content: question }] });

    expect(denied.content).toContain("English (en)");
    expect(denied.content).toContain("Turkish (tr)");
  }, 120_000);

  // ── regexGuardrail ─────────────────────────────────────────────────────────

  it("regexGuardrail blocks before the provider is called and masks otherwise, twice over", async () => {
    // Both patterns carry `g` on purpose: that is the flag whose `lastIndex`
    // survives a call and makes a reused detector miss its second match.
    const blockPattern = /ZIBBLE-\d{3}/g;
    const maskPattern = /ACCT-\d{4}/g;

    const wire: Message[][] = [];
    const agent = createAgent({
      name: "PatternGuardedAgent",
      model: realModel(),
      plugins: [
        regexGuardrail({
          apply: ["input"],
          block: [blockPattern],
          mask: [{ pattern: maskPattern, replacement: "[ACCOUNT]" }],
        }),
        wireSpy(wire),
      ],
    });

    const blockingTurn = {
      messages: [
        { role: "user" as const, content: "Please look up ticket ZIBBLE-742 and summarise it for me." },
      ],
    };

    const firstBlock = await agent.invoke(blockingTurn);
    // The whole point of a local matcher: nothing was shipped to the provider.
    expect(wire).toHaveLength(0);
    expect(firstBlock.content).toContain("Blocked by local pattern policy");
    expect(firstBlock.content).toContain(String(blockPattern));
    expect((firstBlock.state as any)?.ctx?.__guardrailBlocked?.phase).toBe("request");

    // Same agent, same RegExp objects, same input — a `lastIndex` left behind by
    // the first pass would let this one through.
    const secondBlock = await agent.invoke(blockingTurn);
    expect(wire).toHaveLength(0);
    expect(secondBlock.content).toBe(firstBlock.content);

    const maskingTurn = {
      messages: [
        {
          role: "user" as const,
          content: "Reply with one short sentence confirming you received account ACCT-8421.",
        },
      ],
    };

    const firstMask = await agent.invoke(maskingTurn);
    expect(wire.length).toBeGreaterThan(0);
    const firstSent = JSON.stringify(wire);
    expect(firstSent).toContain("[ACCOUNT]");
    expect(firstSent).not.toContain("ACCT-8421");
    expect(firstMask.content.length).toBeGreaterThan(0);
    expect(firstMask.content).not.toContain("Blocked by local pattern policy");

    const sentAfterFirstMask = wire.length;
    const secondMask = await agent.invoke(maskingTurn);
    expect(wire.length).toBeGreaterThan(sentAfterFirstMask);
    const secondSent = JSON.stringify(wire.slice(sentAfterFirstMask));
    expect(secondSent).toContain("[ACCOUNT]");
    expect(secondSent).not.toContain("ACCT-8421");
    expect(secondMask.content).not.toContain("Blocked by local pattern policy");
  }, 120_000);

  // ── langfuseTracing ────────────────────────────────────────────────────────

  it("langfuseTracing posts a batch describing the real run, and no content", async () => {
    const LANGFUSE_BASE = "http://langfuse.invalid.test";
    const posts = interceptFetch((url) => url.startsWith(LANGFUSE_BASE));

    const { tool, func } = temperatureTool();
    const agent = createAgent({
      name: "ExportedAgent",
      model: realModel(),
      tools: [tool],
      limits: { maxToolCalls: 2 },
      plugins: [
        langfuseTracing({
          publicKey: "pk-test",
          secretKey: "sk-test",
          baseUrl: LANGFUSE_BASE,
          // Only `sessionEnd` may flush: the buffer is never full and the timer
          // is off, so exactly one POST proves the run-end flush happened.
          flushAt: 1000,
          flushIntervalMs: 0,
        }),
      ],
    });

    const result = await agent.invoke({
      messages: [
        {
          role: "user",
          content:
            "QX7SENTINEL. Use the get_temperature tool to check the temperature in Zibbleton, then tell me the number.",
        },
      ],
    });

    expect(func).toHaveBeenCalledTimes(1);
    expect(result.content.length).toBeGreaterThan(0);

    // sessionEnd is the only flush that can have produced this.
    expect(posts).toHaveLength(1);
    expect(posts[0].url).toBe(`${LANGFUSE_BASE}/api/public/ingestion`);
    const batch = (posts[0].body as { batch: Array<{ type: string; body: any }> }).batch;
    expect(Array.isArray(batch)).toBe(true);

    const traces = batch.filter((entry) => entry.type === "trace-create");
    const generations = batch.filter((entry) => entry.type === "generation-create");
    const spanStarts = batch.filter((entry) => entry.type === "span-create");
    const spanEnds = batch.filter((entry) => entry.type === "span-update");

    // One trace, opened and closed, both halves carrying the same run id.
    expect(traces.length).toBe(2);
    expect(new Set(traces.map((entry) => entry.body.id)).size).toBe(1);
    expect(traces[0].body.id).toMatch(/^run_|^sess_/);
    expect(traces[1].body.output).toEqual({ status: "success" });

    // The generation describes the model that actually answered, with the token
    // counts it actually reported — not a placeholder.
    expect(generations.length).toBeGreaterThanOrEqual(2);
    const firstGeneration = generations[0].body;
    expect(firstGeneration.model).toBe(MODEL);
    expect(firstGeneration.usage.input).toBeGreaterThan(0);
    expect(firstGeneration.usage.output).toBeGreaterThan(0);
    expect(firstGeneration.usage.total).toBeGreaterThan(0);
    expect(firstGeneration.traceId).toBe(traces[0].body.id);

    // The tool call is a span PAIR: one observation id, opened then closed.
    const startedTool = spanStarts.filter((entry) => entry.body.name === "tool:get_temperature");
    const endedTool = spanEnds.filter((entry) => entry.body.name === "tool:get_temperature");
    expect(startedTool).toHaveLength(1);
    expect(endedTool).toHaveLength(1);
    expect(endedTool[0].body.id).toBe(startedTool[0].body.id);
    expect(endedTool[0].body.output).toEqual({ status: "success" });
    expect(endedTool[0].body.startTime).toBe(startedTool[0].body.startTime);

    // Every envelope carries its own idempotency key.
    const envelopeIds = batch.map((entry: any) => entry.id);
    expect(new Set(envelopeIds).size).toBe(envelopeIds.length);

    // The plugin exports shape and cost, never content. Nothing from the
    // prompt, the tool arguments or the tool result may appear anywhere.
    const wholePayload = JSON.stringify(posts[0].body);
    expect(wholePayload).not.toContain("QX7SENTINEL");
    expect(wholePayload).not.toContain("Zibbleton");
    expect(wholePayload).not.toContain("celsius");
    expect(wholePayload).not.toContain("get_temperature tool to check");
  }, 120_000);

  // ── otelTracing ────────────────────────────────────────────────────────────

  it("otelTracing POSTs an OTLP body for a traced run and warns when tracing is off", async () => {
    const ENDPOINT = "http://collector.invalid.test/v1/traces";
    const posts = interceptFetch((url) => url === ENDPOINT);

    const tracedEvents: any[] = [];
    const traced = createAgent({
      name: "TracedExportAgent",
      model: realModel(),
      // A custom sink keeps the SDK's own tracing runtime off the filesystem;
      // the plugin exports the same session either way.
      tracing: { enabled: true, sink: customSink(() => {}) } as any,
      plugins: [otelTracing({ endpoint: ENDPOINT, serviceName: "traced-export-agent" })],
    });

    const result = await traced.invoke(
      { messages: [{ role: "user", content: "Reply with one short sentence about the number seven." }] },
      { onEvent: (event) => tracedEvents.push(event) },
    );
    expect(result.content.length).toBeGreaterThan(0);

    expect(posts).toHaveLength(1);
    const otlp = posts[0].body as any;
    const scopeSpans = otlp.resourceSpans[0].scopeSpans[0];
    const spans = scopeSpans.spans as any[];
    // Root span plus at least the model call the run actually made.
    expect(spans.length).toBeGreaterThanOrEqual(2);
    expect(spans[0].name).toBe("agent_session: traced-export-agent");
    expect(spans[0].traceId).toMatch(/^[0-9a-f]{32}$/);
    // Every child hangs off the same trace, which is what makes it one trace,
    // and every child's parent is a span that is actually in the export — a
    // dangling parent id is a span tree a collector cannot assemble.
    expect(new Set(spans.map((span) => span.traceId)).size).toBe(1);
    const spanIds = new Set(spans.map((span) => span.spanId));
    expect(spanIds.size).toBe(spans.length);
    expect(spans.slice(1).every((span) => spanIds.has(span.parentSpanId))).toBe(true);
    const serviceName = otlp.resourceSpans[0].resource.attributes.find(
      (attr: any) => attr.key === "service.name",
    );
    expect(serviceName.value.stringValue).toBe("traced-export-agent");

    const exported = tracedEvents.find((e) => e?.type === "metadata" && e.otelTracing)?.otelTracing;
    expect(exported.exported).toBe(true);
    expect(exported.endpoint).toBe(ENDPOINT);

    // ── and with tracing disabled ────────────────────────────────────────────
    posts.length = 0;
    const silentEvents: any[] = [];
    const untraced = createAgent({
      name: "UntracedExportAgent",
      model: realModel(),
      plugins: [otelTracing({ endpoint: ENDPOINT })],
    });

    await untraced.invoke(
      { messages: [{ role: "user", content: "Reply with the single word OK." }] },
      { onEvent: (event) => silentEvents.push(event) },
    );

    // A silent no-op is the failure that costs the most here, so the contract is
    // that it says so out loud instead.
    expect(posts).toHaveLength(0);
    const skipped = silentEvents.find((e) => e?.type === "metadata" && e.otelTracing)?.otelTracing;
    expect(skipped).toBeDefined();
    expect(skipped.exported).toBe(false);
    expect(skipped.reason).toContain("tracing: { enabled: true }");
  }, 120_000);
});
