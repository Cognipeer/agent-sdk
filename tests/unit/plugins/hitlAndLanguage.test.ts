/**
 * Human-in-the-loop transport (`webhookApproval`) and `languageGuard`.
 *
 * The language plugin is driven through a real `createPluginHost` run handle,
 * for the reason the other built-in suites give: the composition rules are what
 * make a deny or a message rewrite mean anything.
 *
 * `webhookApproval` registers no hooks — it only fills the `approvalTransport`
 * slot — so its behaviour is exercised against the slot contract directly
 * (`request()` returns a resolution, or `null` to leave the run paused). The
 * runtime does not call that slot yet; these tests pin the contract so the day
 * the tools node consumes it, the transport already behaves.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createPluginHost,
  detectLanguage,
  languageGuard,
  webhookApproval,
} from "../../../src/plugins/index.js";
import type { AgentPlugin, HookContext, PluginLogger, PluginRunHost } from "../../../src/plugins/index.js";
import type { Message, PendingToolApproval, SmartAgentEvent, SmartState } from "../../../src/types.js";

afterEach(() => {
  vi.restoreAllMocks();
  // `restoreAllMocks` does not undo `stubGlobal`, and the whole suite shares one
  // process — a leaked `fetch` would poison every later file.
  vi.unstubAllGlobals();
});

// ─── Harness ─────────────────────────────────────────────────────────────────

const silentLogger: PluginLogger = { debug: () => {}, warn: () => {}, error: () => {} };

function harness(plugins: AgentPlugin[]): { run: PluginRunHost; events: SmartAgentEvent[] } {
  const events: SmartAgentEvent[] = [];
  const host = createPluginHost(plugins, { logger: silentLogger });
  const run = host.beginRun({
    runId: "run-1",
    agentName: "test-agent",
    getState: () => ({ messages: [] }) as SmartState,
    emit: (event) => events.push(event),
  });
  return { run, events };
}

const modelInput = (messages: Message[]) => ({
  messages,
  tools: [],
  params: {},
  model: null,
  iteration: 1,
});

const metadataEvents = (events: SmartAgentEvent[]): Array<Record<string, unknown>> =>
  events.filter((event) => (event as { type?: string }).type === "metadata") as never;

type FetchCall = [string, { method?: string; headers?: Record<string, string>; body?: string }];

function stubFetch(impl: (url: string, init: FetchCall[1]) => Promise<unknown>) {
  const mock = vi.fn(impl);
  vi.stubGlobal("fetch", mock as unknown as typeof fetch);
  return mock;
}

const jsonResponse = (body: unknown) => ({
  ok: true,
  status: 200,
  statusText: "OK",
  json: async () => body,
  text: async () => JSON.stringify(body),
});

// ─── webhookApproval ─────────────────────────────────────────────────────────

const APPROVAL_URL = "https://hooks.example.com/approvals";

const pendingApproval = (overrides: Partial<PendingToolApproval> = {}): PendingToolApproval => ({
  id: "appr_1",
  toolCallId: "call_1",
  toolName: "shell",
  args: { command: "rm -rf /var/tmp/build" },
  status: "pending",
  requestedAt: "2026-01-01T00:00:00.000Z",
  ...overrides,
});

const hookCtx = (overrides: Partial<HookContext> = {}): HookContext => ({
  runId: "run-1",
  agentName: "test-agent",
  hookName: "notification",
  state: { messages: [] } as unknown as SmartState,
  store: {},
  emit: () => {},
  logger: silentLogger,
  depth: 0,
  ...overrides,
});

/** The plugin's whole surface is the slot; reach for it the way the host would. */
function transportOf(plugin: AgentPlugin) {
  const transport = plugin.provides?.approvalTransport;
  if (!transport) throw new Error("plugin does not fill the approvalTransport slot");
  return transport;
}

describe("webhookApproval: slot wiring", () => {
  it("fills the approvalTransport slot on the host", () => {
    const host = createPluginHost([webhookApproval({ url: APPROVAL_URL })], { logger: silentLogger });
    expect(typeof host.slots.approvalTransport?.request).toBe("function");
    // No hooks: installing it must not put the plugin on the tool path.
    expect(host.has("preToolUse")).toBe(false);
  });

  it("refuses to share the slot, because two transports means an unanswerable approval", () => {
    expect(() =>
      createPluginHost(
        [
          webhookApproval({ url: APPROVAL_URL }),
          webhookApproval({ url: "https://other.example.com/approvals", name: "secondary-approval" }),
        ],
        { logger: silentLogger },
      ),
    ).toThrow(/Slot "approvalTransport" is claimed by both/);
  });
});

describe("webhookApproval: delivery", () => {
  it("POSTs the pending approval and resolves straight from the response", async () => {
    const fetchMock = stubFetch(async () =>
      jsonResponse({ status: "approved", decidedBy: "ops@example.com", comment: "one-off cleanup" }),
    );

    const resolution = await transportOf(webhookApproval({ url: APPROVAL_URL })).request(
      pendingApproval(),
      hookCtx(),
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(APPROVAL_URL);
    expect(init.method).toBe("POST");
    expect(init.headers?.["content-type"]).toBe("application/json");
    expect(JSON.parse(init.body as string)).toEqual({
      type: "tool_approval_request",
      runId: "run-1",
      agentName: "test-agent",
      depth: 0,
      approval: {
        id: "appr_1",
        toolCallId: "call_1",
        toolName: "shell",
        args: { command: "rm -rf /var/tmp/build" },
        requestedAt: "2026-01-01T00:00:00.000Z",
      },
    });
    expect(resolution).toEqual({
      id: "appr_1",
      approved: true,
      decidedBy: "ops@example.com",
      comment: "one-off cleanup",
    });
  });

  it("keeps the id of the approval it asked about, not the one the response claims", async () => {
    stubFetch(async () => jsonResponse({ approved: true, id: "appr_someone_else" }));

    const resolution = await transportOf(webhookApproval({ url: APPROVAL_URL })).request(
      pendingApproval({ id: "appr_42" }),
      hookCtx(),
    );

    expect(resolution?.id).toBe("appr_42");
  });

  it("leaves the run paused when the webhook is unreachable", async () => {
    stubFetch(async () => {
      throw new Error("ECONNREFUSED");
    });

    const resolution = await transportOf(webhookApproval({ url: APPROVAL_URL })).request(
      pendingApproval(),
      hookCtx(),
    );

    // A delivery failure is not a "no": nobody saw the request.
    expect(resolution).toBeNull();
  });

  it("leaves the run paused when the response carries no decision and nothing can be polled", async () => {
    const fetchMock = stubFetch(async () => jsonResponse({ status: "pending" }));

    const resolution = await transportOf(webhookApproval({ url: APPROVAL_URL })).request(
      pendingApproval(),
      hookCtx(),
    );

    expect(resolution).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("webhookApproval: polling", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  const polling = (overrides: Record<string, unknown> = {}) =>
    transportOf(
      webhookApproval({
        url: APPROVAL_URL,
        pollUrl: (pending) => `${APPROVAL_URL}/${pending.id}`,
        pollIntervalMs: 1000,
        timeoutMs: 5000,
        ...overrides,
      }),
    );

  it("polls the status endpoint until a human decides", async () => {
    let polls = 0;
    const fetchMock = stubFetch(async (_url, init) => {
      if (init.method === "POST") return jsonResponse({ status: "pending" });
      polls += 1;
      return polls < 3
        ? jsonResponse({ status: "pending" })
        : jsonResponse({ decision: "rejected", comment: "not against production" });
    });

    const promise = polling().request(pendingApproval(), hookCtx());
    await vi.advanceTimersByTimeAsync(3000);

    await expect(promise).resolves.toEqual({
      id: "appr_1",
      approved: false,
      comment: "not against production",
    });
    expect(polls).toBe(3);
    expect(fetchMock.mock.calls[1][0]).toBe(`${APPROVAL_URL}/appr_1`);
    expect(fetchMock.mock.calls[1][1].method).toBe("GET");
  });

  it("keeps polling through a transient poll failure", async () => {
    let polls = 0;
    stubFetch(async (_url, init) => {
      if (init.method === "POST") return jsonResponse({ status: "pending" });
      polls += 1;
      if (polls === 1) throw new Error("502 bad gateway");
      return jsonResponse({ approved: true });
    });

    const promise = polling().request(pendingApproval(), hookCtx());
    await vi.advanceTimersByTimeAsync(2000);

    await expect(promise).resolves.toEqual({ id: "appr_1", approved: true });
  });

  it("returns null when the budget expires, so the host still owns the decision", async () => {
    stubFetch(async () => jsonResponse({ status: "pending" }));

    const promise = polling().request(pendingApproval(), hookCtx());
    await vi.advanceTimersByTimeAsync(6000);

    await expect(promise).resolves.toBeNull();
  });

  it('rejects on timeout only under onTimeout: "reject"', async () => {
    stubFetch(async () => jsonResponse({ status: "pending" }));

    const promise = polling({ onTimeout: "reject" }).request(pendingApproval(), hookCtx());
    await vi.advanceTimersByTimeAsync(6000);

    const resolution = await promise;
    expect(resolution).toMatchObject({ id: "appr_1", approved: false, decidedBy: "webhook-approval" });
    expect(resolution?.comment).toContain("no approval decision within 5000ms");
  });

  it("stops polling the moment the run is cancelled", async () => {
    const controller = new AbortController();
    const fetchMock = stubFetch(async () => jsonResponse({ status: "pending" }));

    // `reject` is on deliberately: cancellation is not a timeout, so it must
    // still come back as null rather than manufacturing a refusal.
    const promise = polling({ onTimeout: "reject" }).request(
      pendingApproval(),
      hookCtx({ signal: controller.signal }),
    );
    await vi.advanceTimersByTimeAsync(1500);
    const callsBeforeAbort = fetchMock.mock.calls.length;

    controller.abort();
    await expect(promise).resolves.toBeNull();

    await vi.advanceTimersByTimeAsync(10_000);
    expect(fetchMock.mock.calls.length).toBe(callsBeforeAbort);
  });
});

// ─── languageGuard: detection ────────────────────────────────────────────────

const TURKISH = "Merhaba, bu bir deneme metnidir ve her şey yolunda görünüyor.";
const ENGLISH = "Thank you for reaching out. I will review the document and get back to you tomorrow.";
const GERMAN = "Ich habe die Nachricht erhalten und werde mich morgen darum kümmern.";
const FRENCH = "Je vous remercie pour votre message et je reviendrai vers vous demain.";
const SPANISH = "Gracias por su mensaje, le responderé mañana con más detalles.";
const ARABIC = "مرحبا، شكرا لك على رسالتك وسوف أرد عليك غدا إن شاء الله.";

describe("detectLanguage", () => {
  it("reads the language of a normal paragraph", () => {
    expect(detectLanguage(TURKISH)).toBe("tr");
    expect(detectLanguage(ENGLISH)).toBe("en");
    expect(detectLanguage(GERMAN)).toBe("de");
    expect(detectLanguage(FRENCH)).toBe("fr");
    expect(detectLanguage(SPANISH)).toBe("es");
    expect(detectLanguage(ARABIC)).toBe("ar");
  });

  it("is not fooled into English by a fenced code block in Turkish prose", () => {
    const answer = `${TURKISH}\n\n\`\`\`ts\nconst value = items.filter((it) => it.ok && it.id !== null);\n\`\`\``;
    expect(detectLanguage(answer)).toBe("tr");
  });

  it("says nothing when there is nothing to go on", () => {
    expect(detectLanguage("Ok.")).toBeUndefined();
    expect(detectLanguage("42 + 7 = 49")).toBeUndefined();
  });
});

// ─── languageGuard: hooks ────────────────────────────────────────────────────

describe("languageGuard", () => {
  it('instructs on every model call and does NOT deny a mismatch under "instruct"', async () => {
    const { run, events } = harness([languageGuard({ language: "tr" })]);

    const call = await run.runGate("preModelCall", modelInput([{ role: "user", content: "Summarize this" }]));
    expect(call.decision).toBe("allow");
    expect(call.mutated).toBe(true);
    const injected = call.input.messages[call.input.messages.length - 1];
    expect(injected.role).toBe("system");
    expect(injected.content).toContain("Turkish (tr)");

    // The instruction is the fix; the final answer is only reported on.
    const final = await run.runGate("preFinalAnswer", { content: ENGLISH });
    expect(final.decision).toBe("allow");
    expect(metadataEvents(events).find((event) => event.languageMismatch)?.languageMismatch).toMatchObject({
      expected: "tr",
      detected: "en",
      enforced: false,
    });
  });

  it("re-instructing the same transcript does not stack instructions", async () => {
    const { run } = harness([languageGuard({ language: "tr" })]);

    const first = await run.runGate("preModelCall", modelInput([{ role: "user", content: "Merhaba" }]));
    const second = await run.runGate("preModelCall", modelInput(first.input.messages));

    expect(second.mutated).toBe(false);
    expect(second.input.messages).toHaveLength(2);
  });

  it('denies a mismatched answer under "deny", naming both languages', async () => {
    const { run } = harness([languageGuard({ language: "tr-TR", action: "deny" })]);

    const result = await run.runGate("preFinalAnswer", { content: ENGLISH });

    expect(result.decision).toBe("deny");
    expect(result.deniedBy).toBe("language-guard");
    expect(result.reason).toContain("English (en)");
    // "tr-TR" and "tr" are the same requirement, and the reason says which.
    expect(result.reason).toContain("Turkish (tr)");
  });

  it("allows an answer that is already in the required language", async () => {
    const { run, events } = harness([languageGuard({ language: "tr", action: "deny" })]);

    expect((await run.runGate("preFinalAnswer", { content: TURKISH })).decision).toBe("allow");
    expect(metadataEvents(events).some((event) => event.languageMismatch)).toBe(false);
  });

  it("never judges an answer shorter than minChars", async () => {
    const { run } = harness([languageGuard({ language: "tr", action: "deny" })]);

    // Unmistakably English, and unmistakably too short to be evidence of drift.
    const short = await run.runGate("preFinalAnswer", { content: "Done, and it is in the file." });
    expect(short.decision).toBe("allow");

    // The same sentence, long enough to judge, is refused — so the short case
    // passed on length, not because the detector was blind to it.
    const long = await run.runGate("preFinalAnswer", { content: ENGLISH });
    expect(long.decision).toBe("deny");
  });

  it("reads the required language per run, and stays out of the way when there is none", async () => {
    const { run } = harness([
      languageGuard({ language: (ctx) => (ctx.runId === "run-1" ? undefined : "tr"), action: "deny" }),
    ]);

    const call = await run.runGate("preModelCall", modelInput([{ role: "user", content: "hi" }]));
    expect(call.mutated).toBe(false);
    expect((await run.runGate("preFinalAnswer", { content: ENGLISH })).decision).toBe("allow");
  });
});
