/**
 * Session lifecycle and context pressure against a REAL model.
 *
 * `plugins.integration.test.ts` proves that a policy decision survives a model
 * that makes its own choices. This file protects the other half: the SESSION
 * bracket. A smart run is not one `base.invoke()` — the driver re-enters the
 * base agent whenever it has to compact, structured output finalizes on its own
 * leg, and three concurrent `invoke()` calls share one agent instance and one
 * plugin host. Every one of those is a place where "fires once per run" can
 * quietly become "fires once per leg", or where two runs can end up sharing a
 * store. A scripted model cannot exercise them honestly, because whether
 * compaction happens at all depends on what the model chose to call and when.
 *
 *   OPENAI_BASE_URL=http://localhost:3000/api/client/v1 \
 *   OPENAI_API_KEY=sk-… PLUGIN_TEST_MODEL=gpt-5.6-luna \
 *   npx vitest run tests/integration/pluginsLifecycle.integration.test.ts
 *
 * Any OpenAI-compatible endpoint works. Skipped entirely without a key.
 *
 * Every assertion is about what the RUNTIME did — a hook count, a ledger row, a
 * field on `result` — never about the model's wording, so these hold across
 * models. Where a model's choice is load-bearing (it has to call a tool twice,
 * in sequence) the test asserts that premise explicitly before the behaviour it
 * actually guards, so a run that failed to set up the scenario reports THAT
 * rather than a confusing downstream failure.
 */

import { describe, it, expect, vi } from "vitest";
import { z } from "zod";

import { createAgent, createSmartAgent, createTool } from "../../src/index.js";
import { createProvider, fromNativeProvider } from "../../src/providers/index.js";
import { defineHook } from "../../src/plugins/define.js";
import { sessionMetrics } from "../../src/plugins/builtin/sessionMetrics.js";
import type { SessionMetrics } from "../../src/plugins/builtin/sessionMetrics.js";
import { toolPolicy } from "../../src/plugins/builtin/toolPolicy.js";
import type { AgentPlugin } from "../../src/plugins/types.js";
import type { AgentInvokeResult, Message, StructuredSummary } from "../../src/types.js";

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

const assistantText = (message: Message | undefined): string =>
  typeof message?.content === "string" ? message.content : JSON.stringify(message?.content ?? "");

// ─── Scenario 1-3: one compaction run, three behaviours ──────────────────────

/**
 * Compaction is expensive to provoke (four real model calls) and the three
 * behaviours below are three views of the SAME run — asserting them separately
 * against one recorded run is both cheaper and more honest than running the
 * same scenario three times and hoping the model behaved identically each time.
 */
type CompactionRun = {
  result: AgentInvokeResult;
  fetchedSections: string[];
  sessionStarts: Array<{ resumed: boolean }>;
  sessionEnds: Array<{ status: string }>;
  /** `iteration` restarts at 1 inside every base.invoke(). */
  modelCallIterations: number[];
  preCompacts: Array<{ reason: string; tokenCount: number; threshold: number; messageCount: number }>;
  postCompacts: Array<{ tokensBefore: number; tokensAfter: number; strategy: string; summary: StructuredSummary }>;
  finalAnswers: Array<{ content: string }>;
};

const FINAL_ANSWER_MARK = "[[reviewed-by-plugin]]";

/**
 * ~20k characters (~5k tokens by the SDK's heuristic counter) — comfortably
 * under the 32k-char hard cap so the payload reaches the transcript intact, and
 * large enough that TWO of them blow past the 9k-token trigger while ONE does
 * not. That gap is what makes the run compact exactly once.
 */
function dossierSection(section: string, next: string): string {
  const line = `Section ${section}: archived operational record entry, routine filler detail, no action required. `;
  const body = line.repeat(Math.ceil(20_000 / line.length));
  return `${body}\nNEXT_SECTION: ${next}`;
}

async function executeCompactionRun(): Promise<CompactionRun> {
  const fetchedSections: string[] = [];
  const dossierTool = createTool({
    name: "fetch_dossier",
    description:
      "Fetch ONE archived dossier section by name. The last line of the result is "
      + "'NEXT_SECTION: <name>' naming the section to fetch next, or 'none' when there is no next section.",
    schema: z.object({ section: z.string().describe("The single section name to fetch") }),
    func: async ({ section }: { section: string }) => {
      fetchedSections.push(section);
      return section === "alpha" ? dossierSection("alpha", "beta") : dossierSection(section, "none");
    },
  });

  const run: CompactionRun = {
    result: undefined as unknown as AgentInvokeResult,
    fetchedSections,
    sessionStarts: [],
    sessionEnds: [],
    modelCallIterations: [],
    preCompacts: [],
    postCompacts: [],
    finalAnswers: [],
  };

  const lifecycle: AgentPlugin = {
    name: "lifecycle-recorder",
    hooks: {
      sessionStart: ({ resumed }) => {
        run.sessionStarts.push({ resumed });
        return undefined;
      },
      sessionEnd: ({ status }) => {
        run.sessionEnds.push({ status });
      },
      preModelCall: ({ iteration }) => {
        run.modelCallIterations.push(iteration);
        return undefined;
      },
      preCompact: ({ reason, tokenCount, threshold, messages }) => {
        run.preCompacts.push({ reason, tokenCount, threshold, messageCount: messages.length });
        return undefined;
      },
      postCompact: ({ summary, tokensBefore, tokensAfter, strategy }) => {
        run.postCompacts.push({ summary, tokensBefore, tokensAfter, strategy });
      },
      preFinalAnswer: ({ content }) => {
        run.finalAnswers.push({ content });
        return { content: `${content} ${FINAL_ANSWER_MARK}` };
      },
    },
  };

  const agent = createSmartAgent({
    name: "CompactingAgent",
    model: realModel(),
    tools: [dossierTool],
    // The trigger sits between one dossier and two, so the base agent runs the
    // first tool call happily and bails for compaction after the second.
    summarization: { enable: true, maxTokens: 9_000, summaryPromptMaxTokens: 3_000 },
    limits: { maxToolCalls: 4 },
    plugins: [lifecycle],
  });

  run.result = await agent.invoke({
    messages: [
      {
        role: "user",
        content:
          "Fetch the dossier section 'alpha' with your fetch_dossier tool. Read the NEXT_SECTION line at the "
          + "end of the result and fetch that section too with the same tool. Call the tool for one section at a "
          + "time, never two sections in the same turn. When NEXT_SECTION is 'none', stop calling the tool and "
          + "reply with a single short sentence naming the sections you fetched.",
      },
    ],
  });

  return run;
}

let compactionRunPromise: Promise<CompactionRun> | undefined;
const compactionRun = () => (compactionRunPromise ??= executeCompactionRun());

runReal("session lifecycle under context pressure", () => {
  it("compacts a real run and still opens and closes the session exactly once", async () => {
    const run = await compactionRun();

    // Premise, asserted rather than assumed: the model really did make two
    // SEPARATE tool turns. One turn (or two calls in one turn) leaves every
    // compressable message inside the protected recent window and the
    // summarizer legitimately declines, which is a different scenario.
    expect(run.fetchedSections.length).toBeGreaterThanOrEqual(2);

    // Compaction ACTUALLY happened — a summary record was produced and applied.
    const summaryRecords = run.result.state?.summaryRecords ?? [];
    expect(summaryRecords.length).toBeGreaterThan(0);
    expect(Array.isArray(summaryRecords[0].stable_facts)).toBe(true);

    // The proof that the driver re-entered base.invoke(): `iteration` restarts
    // at 1 inside each base leg, so seeing 1 more than once means more than one
    // leg ran for this single logical turn.
    expect(run.modelCallIterations.filter((iteration) => iteration === 1).length).toBeGreaterThanOrEqual(2);

    // …and despite those legs, the session was bracketed exactly once. A plugin
    // that opened a span or a transaction on sessionStart must not be told the
    // run started twice.
    expect(run.sessionStarts).toEqual([{ resumed: false }]);
    expect(run.sessionEnds).toEqual([{ status: "success" }]);

    expect(run.result.content.length).toBeGreaterThan(0);
  }, 120_000);

  it("fires preCompact and postCompact on that run, and postCompact reports a real reduction", async () => {
    const run = await compactionRun();

    expect(run.preCompacts.length).toBeGreaterThan(0);
    const firstPre = run.preCompacts[0];
    expect(firstPre.reason).toBe("token_pressure");
    expect(firstPre.threshold).toBe(9_000);
    // The gate is only reached under genuine pressure.
    expect(firstPre.tokenCount).toBeGreaterThan(firstPre.threshold);
    expect(firstPre.messageCount).toBeGreaterThan(0);

    expect(run.postCompacts.length).toBeGreaterThan(0);
    const compaction = run.postCompacts[0];
    expect(compaction.strategy).toBe("builtin");
    // The whole point of a compaction pass: the transcript got smaller.
    expect(compaction.tokensAfter).toBeLessThan(compaction.tokensBefore);
    expect(compaction.summary).toBeDefined();

    // preCompact must precede postCompact for a pass that actually compacted:
    // a postCompact with no preCompact would mean the skip gate was bypassed.
    expect(run.preCompacts.length).toBeGreaterThanOrEqual(run.postCompacts.length);
  }, 120_000);

  it("fires preFinalAnswer exactly once on the multi-leg run, and its rewrite reaches result.content", async () => {
    const run = await compactionRun();

    // Base legs inherit the session and are mid-turn by definition; only the
    // smart driver's own leg — the one that returns the answer — may gate the
    // final answer. Firing per leg would run an output policy over a transcript
    // that is still being built.
    expect(run.finalAnswers).toHaveLength(1);
    expect(run.finalAnswers[0].content).not.toContain(FINAL_ANSWER_MARK);

    expect(run.result.content).toContain(FINAL_ANSWER_MARK);
    expect(run.result.content.startsWith(run.finalAnswers[0].content)).toBe(true);
  }, 120_000);
});

// ─── Structured output + a preFinalAnswer deny ───────────────────────────────

const capitalSchema = z.object({
  country: z.string().describe("The country asked about"),
  capital: z.string().describe("Its capital city"),
});

const CAPITAL_PROMPT = "What is the capital of France? Answer using the required structured format.";

runReal("preFinalAnswer deny with structured output", () => {
  it("returns the denial reason and NO parsed output, on a run that would otherwise produce one", async () => {
    // Control leg: the identical agent WITHOUT the denying plugin. Without it,
    // "output is undefined" could just mean the model never produced a parsable
    // payload, and the test would pass while guarding nothing.
    const control = createSmartAgent({
      name: "StructuredControlAgent",
      model: realModel(),
      outputSchema: capitalSchema,
      limits: { maxToolCalls: 3 },
    });
    const allowed = await control.invoke({ messages: [{ role: "user", content: CAPITAL_PROMPT }] });
    expect(allowed.output).toBeDefined();
    expect(typeof allowed.output?.capital).toBe("string");

    const denials: Array<{ hadOutput: boolean }> = [];
    const denied = createSmartAgent({
      name: "StructuredDeniedAgent",
      model: realModel(),
      outputSchema: capitalSchema,
      limits: { maxToolCalls: 3 },
      plugins: [
        defineHook(
          "preFinalAnswer",
          ({ output }) => {
            denials.push({ hadOutput: output !== undefined });
            return { decision: "deny", reason: "Geographic answers are not permitted by policy." };
          },
          { name: "final-answer-denier" },
        ),
      ],
    });

    const result = await denied.invoke({ messages: [{ role: "user", content: CAPITAL_PROMPT }] });

    expect(denials).toHaveLength(1);

    // The reason is what the caller gets…
    expect(result.content).toContain("Geographic answers are not permitted");
    // …and the payload the policy just refused must NOT be handed back through
    // the side door. Returning `output` next to a "blocked" `content` is the
    // exact leak this gate exists to prevent.
    expect(result.output).toBeUndefined();
    expect(result.outputError).toBeUndefined();
  }, 120_000);
});

// ─── Streaming vs. a postModelCall rewrite ───────────────────────────────────

runReal("streaming and postModelCall", () => {
  it("puts the rewrite in the transcript and the result, but not in the deltas already on the wire", async () => {
    const MARKER = "[[POST-MODEL-REWRITE]]";
    const deltas: string[] = [];
    const finalChunks: string[] = [];
    /** What the provider actually produced, captured before the rewrite. */
    let modelText = "";

    const agent = createAgent({
      name: "StreamingRewriteAgent",
      model: realModel(),
      plugins: [
        defineHook(
          "postModelCall",
          ({ message }) => {
            modelText = typeof message.content === "string" ? message.content : "";
            return { message: { ...message, content: `${modelText} ${MARKER}` } };
          },
          { name: "stream-rewriter" },
        ),
      ],
    });

    const result = await agent.invoke(
      { messages: [{ role: "user", content: "Reply with exactly one short sentence about the sea." }] },
      {
        stream: true,
        onStream: (chunk) => {
          (chunk.isFinal ? finalChunks : deltas).push(chunk.text);
        },
      },
    );

    // The run genuinely streamed rather than falling back to a single invoke.
    expect(deltas.length).toBeGreaterThan(1);

    // THE CAVEAT, asserted as the truth it is: `postModelCall` runs after the
    // provider stream is fully consumed, so every incremental delta the host
    // already forwarded to its UI predates the rewrite and cannot contain it.
    // A plugin that redacts in `postModelCall` therefore does NOT redact a
    // streaming UI — that needs a transport-level guardrail. What the hook does
    // guarantee is that the transcript, the result and the final chunk agree.
    expect(modelText.length).toBeGreaterThan(0);
    expect(deltas.join("")).toContain(modelText);
    expect(deltas.join("")).not.toContain(MARKER);

    expect(result.content).toContain(MARKER);
    const lastAssistant = [...result.messages].reverse().find((message) => message.role === "assistant");
    expect(assistantText(lastAssistant)).toContain(MARKER);

    // The one post-hook chunk: emitted from the finished content after the
    // gate, so a host that renders only `isFinal` sees the rewritten answer.
    expect(finalChunks).toHaveLength(1);
    expect(finalChunks[0]).toContain(MARKER);
    expect(finalChunks[0]).toBe(result.content);
  }, 90_000);

  /**
   * DEFECT (src/nodes/agentCore.ts, streaming branch of the model call): the
   * adapter's `stream()` yields text deltas AND, last, the fully assembled
   * assistant message. agentCore stores that final object as `streamedMessage`
   * but ALSO runs `extractText()` over it, so the entire answer is appended to
   * `streamedText` a second time and re-emitted as one more incremental chunk
   * through `onStream` and `onEvent({ type: "stream" })`.
   *
   * Any host that renders by concatenating incremental chunks — the ordinary
   * way to drive a streaming UI — therefore shows the whole answer twice. It is
   * invisible in `result.content` (the assembled message's own content wins),
   * which is why it survives; a plugin has nothing to do with it, so this test
   * deliberately runs with no plugins at all.
   *
   * Observed: deltas.join("") === modelText + modelText.
   * The fix is to skip `extractText` for a chunk already recognised as the
   * final assembled message.
   */
  it("emits each streamed character exactly once across the incremental chunks", async () => {
    const deltas: string[] = [];

    const agent = createAgent({ name: "PlainStreamingAgent", model: realModel() });

    const result = await agent.invoke(
      { messages: [{ role: "user", content: "Reply with exactly one short sentence about the sea." }] },
      {
        stream: true,
        onStream: (chunk) => {
          if (!chunk.isFinal) deltas.push(chunk.text);
        },
      },
    );

    expect(deltas.length).toBeGreaterThan(1);
    expect(deltas.join("")).toBe(result.content);
  }, 90_000);
});

// ─── Concurrency isolation ───────────────────────────────────────────────────

runReal("concurrent invokes on one agent instance", () => {
  it("gives each run its own store, its own runId and its own session bracket", async () => {
    const starts: string[] = [];
    const ends: Array<{ runId: string; status: string }> = [];
    const observed: Array<{ runId: string; callsSeenByThisRun: number }> = [];

    const isolation: AgentPlugin = {
      name: "run-isolation-probe",
      hooks: {
        sessionStart: (_input, ctx) => {
          starts.push(ctx.runId);
          return undefined;
        },
        postModelCall: (_input, ctx) => {
          // `ctx.store` is per plugin AND per run. If the host leaked one store
          // across concurrent invokes, the later runs would count 2 and 3.
          const store = ctx.store as { modelCalls?: number };
          store.modelCalls = (store.modelCalls ?? 0) + 1;
          observed.push({ runId: ctx.runId, callsSeenByThisRun: store.modelCalls });
          return undefined;
        },
        sessionEnd: ({ status }, ctx) => {
          ends.push({ runId: ctx.runId, status });
        },
      },
    };

    // ONE agent instance, one plugin host, three simultaneous invokes.
    const agent = createSmartAgent({
      name: "ConcurrentAgent",
      model: realModel(),
      limits: { maxToolCalls: 1 },
      plugins: [isolation],
    });

    const questions = ["Name one primary colour.", "Name one day of the week.", "Name one ocean."];
    const results = await Promise.all(
      questions.map((question) => agent.invoke({ messages: [{ role: "user", content: question }] })),
    );

    expect(results).toHaveLength(3);
    for (const result of results) expect(result.content.length).toBeGreaterThan(0);

    // Three distinct run ids, one sessionStart and one sessionEnd each.
    expect(starts).toHaveLength(3);
    expect(new Set(starts).size).toBe(3);
    for (const runId of starts) expect(runId).toMatch(/^run_/);

    expect(ends).toHaveLength(3);
    expect(new Set(ends.map((entry) => entry.runId))).toEqual(new Set(starts));
    expect(ends.every((entry) => entry.status === "success")).toBe(true);

    // Each of the three runs made exactly one model call and each SAW exactly
    // one — the isolation guarantee the whole session design rests on.
    expect(observed).toHaveLength(3);
    expect(observed.map((entry) => entry.callsSeenByThisRun)).toEqual([1, 1, 1]);
    expect(new Set(observed.map((entry) => entry.runId)).size).toBe(3);
  }, 120_000);
});

// ─── sessionMetrics against a real run ───────────────────────────────────────

runReal("sessionMetrics on a real run", () => {
  it("reports model calls, tool calls and denials that match what the runtime actually did", async () => {
    const emitted: SessionMetrics[] = [];

    const weather = vi.fn(async ({ city }: { city: string }) => ({ city, tempC: 21, condition: "clear" }));
    const weatherTool = createTool({
      name: "get_weather",
      description: "Return the current weather for a city.",
      schema: z.object({ city: z.string().describe("City name") }),
      func: weather,
    });

    const fileIncident = vi.fn(async ({ summary }: { summary: string }) => ({ filed: true, summary }));
    const incidentTool = createTool({
      name: "open_incident",
      description: "Open an incident report with a one-line summary.",
      schema: z.object({ summary: z.string().describe("One-line incident summary") }),
      func: fileIncident,
    });

    const agent = createSmartAgent({
      name: "MeteredAgent",
      model: realModel(),
      tools: [weatherTool, incidentTool],
      limits: { maxToolCalls: 4 },
      systemPrompt:
        "You always work in two steps: first call get_weather for the city, then call open_incident with a "
        + "one-line summary of what you found. Always attempt both tool calls, even if one of them fails.",
      plugins: [
        sessionMetrics({ sink: (metrics) => void emitted.push(metrics), includeToolBreakdown: true }),
        toolPolicy({
          rules: [
            {
              tool: "open_incident",
              action: "deny",
              reason: "Incident filing is disabled in this environment.",
            },
          ],
        }),
      ],
    });

    const result = await agent.invoke({
      messages: [
        {
          role: "user",
          content: "Check the weather in Istanbul, then open an incident about it, then tell me what happened.",
        },
      ],
    });

    // Premise: the run really did produce one execution and one denial.
    expect(weather).toHaveBeenCalled();
    expect(fileIncident).not.toHaveBeenCalled();

    const history = result.state?.toolHistory ?? [];
    const rejected = history.filter((entry) => entry.status === "rejected");
    const failed = history.filter((entry) => entry.status === "error");
    expect(rejected.length).toBeGreaterThanOrEqual(1);

    expect(emitted).toHaveLength(1);
    const record = emitted[0];

    expect(record.runId).toMatch(/^run_/);
    expect(record.agentName).toBe("MeteredAgent");
    expect(record.status).toBe("success");

    // Every count is reconciled against the ledger the SDK itself keeps, not
    // against a number the test picked: `usage.perRequest` has one row per
    // model call and `toolHistory` one row per attempt, denials included.
    expect(record.modelCalls).toBe(result.state?.usage?.perRequest.length ?? 0);
    expect(record.modelCalls).toBeGreaterThanOrEqual(2);
    expect(record.toolCalls).toBe(history.length);
    expect(record.deniedToolCalls).toBe(rejected.length);
    expect(record.failedToolCalls).toBe(failed.length);

    // A denied call never reaches postToolUse, so it cannot appear in the
    // per-tool execution breakdown — that column counts what RAN.
    expect(record.toolBreakdown?.open_incident).toBeUndefined();
    expect(record.toolBreakdown?.get_weather).toBe(weather.mock.calls.length);

    expect(record.durationMs).toBeGreaterThan(0);
    expect(record.totalTokens).toBeGreaterThan(0);
  }, 120_000);
});
