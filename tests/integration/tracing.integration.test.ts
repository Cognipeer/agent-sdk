/**
 * Integration Tests for Tracing (Batched & Streaming)
 *
 * These tests hit a real Cognipeer Console / cgate tracing ingest. The ingest
 * path is the SDK's own default shape: `{base}/api/client/v1/tracing/sessions`
 * (see DEFAULT_COGNIPEER_URL in src/utils/tracing.ts), plus the streaming
 * sub-routes `/stream/{sessionId}/{start,events,end}`.
 *
 * Prerequisites:
 *   1. An ingest reachable at the base URL (cgate `npm run dev`, or a local
 *      Console instance on http://localhost:3000).
 *   2. A valid API token in the environment.
 *
 * Env vars (the CGATE_* names are the originals and still take precedence; the
 * COGNIPEER_* names are accepted so a run configured for the Console ingest
 * works without a second set of variables):
 *   CGATE_API_TOKEN / COGNIPEER_API_KEY  – bearer token (required; suite skips without it)
 *   CGATE_BASE_URL  / COGNIPEER_BASE_URL – ingest origin (default: http://localhost:3001)
 *
 *   CGATE_API_TOKEN=<token> npx vitest run tests/integration/tracing.integration.test.ts
 *   COGNIPEER_BASE_URL=http://localhost:3000 COGNIPEER_API_KEY=<token> npx vitest run …
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import {
  createTraceSession,
  recordTraceEvent,
  finalizeTraceSession,
  startStreamingSession,
} from "../../src/utils/tracing.js";
import type {
  TracingConfig,
  SmartAgentOptions,
  AgentRuntimeConfig,
  TraceSessionRuntime,
} from "../../src/types.js";

/* ------------------------------------------------------------------ */
/*  Helpers                                                           */
/* ------------------------------------------------------------------ */

const CGATE_BASE_URL =
  process.env.CGATE_BASE_URL || process.env.COGNIPEER_BASE_URL || "http://localhost:3001";
const TRACING_URL = `${CGATE_BASE_URL.replace(/\/$/, "")}/api/client/v1/tracing/sessions`;
const API_TOKEN = process.env.CGATE_API_TOKEN || process.env.COGNIPEER_API_KEY || "";

/** Generous per-test budget: each test does several real HTTP round-trips. */
const TEST_TIMEOUT_MS = 60_000;

function skipIfNoToken() {
  if (!API_TOKEN) {
    console.warn(
      "\n⚠️  No tracing ingest token set – skipping tracing integration tests.\n" +
        "   Run with:  CGATE_API_TOKEN=<token> npx vitest run tests/integration/tracing.integration.test.ts\n" +
        "   or:        COGNIPEER_BASE_URL=<origin> COGNIPEER_API_KEY=<token> npx vitest run …\n"
    );
    return true;
  }
  return false;
}

/* ------------------------------------------------------------------ */
/*  Ingest delivery recorder                                          */
/*                                                                    */
/*  The tracing helpers deliberately swallow sink failures so a broken */
/*  ingest never breaks an agent run. That means asserting only on the */
/*  returned session object would let these tests pass against an      */
/*  endpoint that rejected every POST. We wrap globalThis.fetch (which */
/*  src/utils/tracing.ts resolves per call) to record the real request */
/*  URLs and response statuses, and assert the ingest actually         */
/*  accepted the traffic.                                             */
/* ------------------------------------------------------------------ */

type IngestCall = { url: string; status: number; error?: string };

let ingestCalls: IngestCall[] = [];
let originalFetch: typeof globalThis.fetch | undefined;

function installIngestRecorder() {
  if (originalFetch) return;
  originalFetch = globalThis.fetch.bind(globalThis);
  globalThis.fetch = (async (input: any, init?: any) => {
    const url = typeof input === "string" ? input : input?.url ?? String(input);
    const isIngest = typeof url === "string" && url.startsWith(TRACING_URL);
    try {
      const response = await originalFetch!(input, init);
      if (isIngest) ingestCalls.push({ url, status: response.status });
      return response;
    } catch (err) {
      if (isIngest) {
        ingestCalls.push({ url, status: 0, error: err instanceof Error ? err.message : String(err) });
      }
      throw err;
    }
  }) as typeof globalThis.fetch;
}

function restoreIngestRecorder() {
  if (originalFetch) {
    globalThis.fetch = originalFetch;
    originalFetch = undefined;
  }
}

/** Ingest calls whose URL ends with the given sub-path, for a given session. */
function callsFor(sessionId: string, suffix?: string): IngestCall[] {
  return ingestCalls.filter(
    (call) => call.url.includes(sessionId) && (suffix === undefined || call.url.endsWith(suffix))
  );
}

/** Assert every recorded ingest POST was accepted (2xx), with a useful message. */
function expectAllIngestCallsAccepted(calls: IngestCall[]) {
  const rejected = calls.filter((call) => call.status < 200 || call.status >= 300);
  expect(
    rejected,
    `tracing ingest rejected ${rejected.length} request(s): ${JSON.stringify(rejected)}`
  ).toEqual([]);
}

/** Build a minimal SmartAgentOptions for creating a trace session */
function makeAgentOpts(tracing: TracingConfig): SmartAgentOptions {
  return {
    model: { id: "test-model", provider: "test-provider" },
    tracing,
  };
}

/** Build a minimal AgentRuntimeConfig for finalizing */
function makeRuntime(): AgentRuntimeConfig {
  return {
    model: { id: "test-model", provider: "test-provider" },
    tools: [],
    name: "tracing-test-agent",
    version: "1.0.0",
  };
}

/** Record a few fake events to a session to simulate an agent run */
function recordSampleEvents(session: TraceSessionRuntime) {
  // 1) ai_call event
  recordTraceEvent(session, {
    type: "ai_call",
    label: "LLM Response",
    status: "success",
    durationMs: 1234,
    inputTokens: 100,
    outputTokens: 50,
    totalTokens: 150,
    cachedInputTokens: 20,
    model: "gpt-4o",
    provider: "openai",
    actor: { scope: "agent", name: "tracing-test-agent", role: "assistant", version: "1.0.0" },
    messageList: [
      { role: "system", content: "You are a helpful assistant." },
      { role: "user", content: "What is 2+2?" },
      { role: "assistant", content: "2+2 equals 4." },
    ],
  });

  // 2) tool_call event
  recordTraceEvent(session, {
    type: "tool_call",
    label: "Tool: calculator",
    status: "success",
    durationMs: 56,
    actor: { scope: "tool", name: "calculator", role: "tool" },
    toolExecutionId: "exec_001",
    sections: [
      {
        kind: "tool_call",
        label: "Tool Call: calculator",
        tool: "calculator",
        arguments: { expression: "2+2" },
      },
      {
        kind: "tool_result",
        label: "Tool Result: calculator",
        tool: "calculator",
        output: "4",
      },
    ],
  });

  // 3) second ai_call
  recordTraceEvent(session, {
    type: "ai_call",
    label: "Final Answer",
    status: "success",
    durationMs: 890,
    inputTokens: 200,
    outputTokens: 30,
    totalTokens: 230,
    cachedInputTokens: 100,
    model: "gpt-4o",
    provider: "openai",
    actor: { scope: "agent", name: "tracing-test-agent", role: "assistant", version: "1.0.0" },
    messageList: [
      { role: "assistant", content: "The answer is 4." },
    ],
  });
}

/* ------------------------------------------------------------------ */
/*  Batched Mode Tests                                                */
/* ------------------------------------------------------------------ */

describe("Tracing Integration – Batched Mode", () => {
  const shouldSkip = skipIfNoToken();

  beforeAll(() => {
    if (shouldSkip) return;
    console.log(`🔗 Testing against: ${TRACING_URL}`);
    console.log(`🔑 Token: ${API_TOKEN.slice(0, 8)}...`);
    installIngestRecorder();
  });

  afterAll(() => restoreIngestRecorder());
  beforeEach(() => {
    ingestCalls = [];
  });

  it.skipIf(shouldSkip)("should create session, record events, and POST full session to cgate", async () => {
    const tracingConfig: TracingConfig = {
      enabled: true,
      mode: "batched",
      logData: true,
      sink: {
        type: "http",
        url: TRACING_URL,
        headers: { Authorization: `Bearer ${API_TOKEN}` },
      },
    };

    // 1. Create session
    const session = createTraceSession(makeAgentOpts(tracingConfig));
    expect(session).toBeDefined();
    expect(session!.sessionId).toMatch(/^sess_/);
    expect(session!.resolvedConfig.mode).toBe("batched");

    console.log(`  📦 Batched session: ${session!.sessionId}`);

    // 2. Record events
    recordSampleEvents(session!);
    expect(session!.events.length).toBe(3);

    // 3. Finalize – this POSTs the full session to cgate
    const result = await finalizeTraceSession(session, {
      agentRuntime: makeRuntime(),
    });

    expect(result).toBeDefined();
    expect(result!.sessionId).toBe(session!.sessionId);
    expect(result!.events.length).toBe(3);
    expect(result!.status).toBe("success");
    expect(result!.summary.totalInputTokens).toBe(300);
    expect(result!.summary.totalOutputTokens).toBe(80);

    // 4. The ingest must actually have received and accepted the session.
    //    Batched mode delivers the whole session in exactly one POST.
    expect(ingestCalls.map((call) => call.url)).toEqual([TRACING_URL]);
    expectAllIngestCallsAccepted(ingestCalls);

    console.log(`  ✅ Batched session finalized: status=${result!.status}, events=${result!.events.length}`);
  }, TEST_TIMEOUT_MS);

  it.skipIf(shouldSkip)("should handle session with errors", async () => {
    const tracingConfig: TracingConfig = {
      enabled: true,
      mode: "batched",
      logData: true,
      sink: {
        type: "http",
        url: TRACING_URL,
        headers: { Authorization: `Bearer ${API_TOKEN}` },
      },
    };

    const session = createTraceSession(makeAgentOpts(tracingConfig));
    expect(session).toBeDefined();

    console.log(`  📦 Batched error session: ${session!.sessionId}`);

    // Record a success event
    recordTraceEvent(session!, {
      type: "ai_call",
      label: "LLM Call",
      status: "success",
      durationMs: 500,
      inputTokens: 50,
      outputTokens: 25,
      totalTokens: 75,
      model: "gpt-4o",
      provider: "openai",
      messageList: [
        { role: "user", content: "Hello" },
        { role: "assistant", content: "Hi!" },
      ],
    });

    // Record an error event
    recordTraceEvent(session!, {
      type: "tool_call",
      label: "Failed Tool Call",
      status: "error",
      durationMs: 100,
      error: { message: "Tool execution failed", stack: "Error: Tool execution failed\n    at test" },
      actor: { scope: "tool", name: "broken_tool" },
    });

    const result = await finalizeTraceSession(session, {
      agentRuntime: makeRuntime(),
      status: "error",
      error: { message: "Agent run failed due to tool error" },
    });

    expect(result).toBeDefined();
    expect(result!.status).toBe("error");
    expect(result!.errors.length).toBeGreaterThanOrEqual(1);

    expect(ingestCalls.map((call) => call.url)).toEqual([TRACING_URL]);
    expectAllIngestCallsAccepted(ingestCalls);

    console.log(`  ✅ Error session finalized: status=${result!.status}, errors=${result!.errors.length}`);
  }, TEST_TIMEOUT_MS);
});

/* ------------------------------------------------------------------ */
/*  Streaming Mode Tests                                              */
/* ------------------------------------------------------------------ */

describe("Tracing Integration – Streaming Mode", () => {
  const shouldSkip = skipIfNoToken();

  beforeAll(() => {
    if (shouldSkip) return;
    console.log(`🔗 Testing streaming against: ${TRACING_URL}/stream/...`);
    console.log(`🔑 Token: ${API_TOKEN.slice(0, 8)}...`);
    installIngestRecorder();
  });

  afterAll(() => restoreIngestRecorder());
  beforeEach(() => {
    ingestCalls = [];
  });

  it.skipIf(shouldSkip)("should start session, stream events, and end session on cgate", async () => {
    const tracingConfig: TracingConfig = {
      enabled: true,
      mode: "streaming",
      logData: true,
      sink: {
        type: "http",
        url: TRACING_URL,
        headers: { Authorization: `Bearer ${API_TOKEN}` },
      },
    };

    // 1. Create session
    const session = createTraceSession(makeAgentOpts(tracingConfig));
    expect(session).toBeDefined();
    expect(session!.resolvedConfig.mode).toBe("streaming");

    console.log(`  🌊 Streaming session: ${session!.sessionId}`);

    // 2. Start streaming session (POSTs to /stream/{sessionId}/start)
    await startStreamingSession(session, makeRuntime());
    expect(session!.sessionStarted).toBe(true);

    console.log(`  ✅ Session started on cgate`);

    // 3. Record events – each one fires off to /stream/{sessionId}/events
    recordSampleEvents(session!);
    expect(session!.events.length).toBe(3);

    // Give a moment for fire-and-forget event posts to complete
    await new Promise((resolve) => setTimeout(resolve, 1500));

    console.log(`  ✅ ${session!.events.length} events streamed`);

    // 4. Finalize – POSTs to /stream/{sessionId}/end
    const result = await finalizeTraceSession(session, {
      agentRuntime: makeRuntime(),
    });

    expect(result).toBeDefined();
    expect(result!.sessionId).toBe(session!.sessionId);
    expect(result!.status).toBe("success");
    expect(result!.summary.totalInputTokens).toBe(300);
    expect(result!.summary.totalOutputTokens).toBe(80);

    // Streaming mode must have hit the three distinct ingest routes: one
    // /start, one /events POST per recorded event, and one /end.
    const sessionId = session!.sessionId;
    expect(callsFor(sessionId, `/stream/${sessionId}/start`).length).toBe(1);
    expect(callsFor(sessionId, `/stream/${sessionId}/events`).length).toBe(3);
    expect(callsFor(sessionId, `/stream/${sessionId}/end`).length).toBe(1);
    expectAllIngestCallsAccepted(callsFor(sessionId));

    console.log(`  ✅ Streaming session ended: status=${result!.status}`);
  }, TEST_TIMEOUT_MS);

  it.skipIf(shouldSkip)("should stream events individually and verify order", async () => {
    const tracingConfig: TracingConfig = {
      enabled: true,
      mode: "streaming",
      logData: true,
      sink: {
        type: "http",
        url: TRACING_URL,
        headers: { Authorization: `Bearer ${API_TOKEN}` },
      },
    };

    const session = createTraceSession(makeAgentOpts(tracingConfig));
    expect(session).toBeDefined();

    console.log(`  🌊 Streaming order test session: ${session!.sessionId}`);

    await startStreamingSession(session, makeRuntime());
    expect(session!.sessionStarted).toBe(true);

    // Record events one at a time with small delays
    for (let i = 1; i <= 5; i++) {
      recordTraceEvent(session!, {
        type: "ai_call",
        label: `Step ${i}`,
        status: "success",
        durationMs: 100 * i,
        inputTokens: 10 * i,
        outputTokens: 5 * i,
        totalTokens: 15 * i,
        model: "gpt-4o",
        provider: "openai",
        messageList: [
          { role: "user", content: `Question ${i}` },
          { role: "assistant", content: `Answer ${i}` },
        ],
      });
      // Small delay between events
      await new Promise((resolve) => setTimeout(resolve, 200));
    }

    expect(session!.events.length).toBe(5);

    // Wait for all fire-and-forget posts
    await new Promise((resolve) => setTimeout(resolve, 2000));

    const result = await finalizeTraceSession(session, {
      agentRuntime: makeRuntime(),
    });

    expect(result).toBeDefined();
    expect(result!.events.length).toBe(5);
    expect(result!.status).toBe("success");

    // Verify sequence ordering
    for (let i = 0; i < result!.events.length; i++) {
      expect(result!.events[i].sequence).toBe(i + 1);
    }

    // Each of the 5 events was streamed as its own accepted POST.
    const sessionId = session!.sessionId;
    expect(callsFor(sessionId, `/stream/${sessionId}/start`).length).toBe(1);
    expect(callsFor(sessionId, `/stream/${sessionId}/events`).length).toBe(5);
    expect(callsFor(sessionId, `/stream/${sessionId}/end`).length).toBe(1);
    expectAllIngestCallsAccepted(callsFor(sessionId));

    console.log(`  ✅ 5 events streamed in order, session ended`);
  }, TEST_TIMEOUT_MS);
});

/* ------------------------------------------------------------------ */
/*  Cognipeer Sink Tests                                              */
/* ------------------------------------------------------------------ */

describe("Tracing Integration – Cognipeer Sink", () => {
  const shouldSkip = skipIfNoToken();

  beforeAll(() => {
    if (shouldSkip) return;
    installIngestRecorder();
  });

  afterAll(() => restoreIngestRecorder());
  beforeEach(() => {
    ingestCalls = [];
  });

  it.skipIf(shouldSkip)("should work with cognipeerSink helper (batched)", async () => {
    const tracingConfig: TracingConfig = {
      enabled: true,
      mode: "batched",
      logData: true,
      sink: {
        type: "cognipeer",
        apiKey: API_TOKEN,
        url: TRACING_URL,
      },
    };

    const session = createTraceSession(makeAgentOpts(tracingConfig));
    expect(session).toBeDefined();

    console.log(`  📦 Cognipeer sink batched session: ${session!.sessionId}`);

    recordSampleEvents(session!);

    const result = await finalizeTraceSession(session, {
      agentRuntime: makeRuntime(),
    });

    expect(result).toBeDefined();
    expect(result!.status).toBe("success");

    expect(ingestCalls.map((call) => call.url)).toEqual([TRACING_URL]);
    expectAllIngestCallsAccepted(ingestCalls);

    console.log(`  ✅ Cognipeer sink batched: status=${result!.status}`);
  }, TEST_TIMEOUT_MS);

  it.skipIf(shouldSkip)("should work with cognipeerSink helper (streaming)", async () => {
    const tracingConfig: TracingConfig = {
      enabled: true,
      mode: "streaming",
      logData: true,
      sink: {
        type: "cognipeer",
        apiKey: API_TOKEN,
        url: TRACING_URL,
      },
    };

    const session = createTraceSession(makeAgentOpts(tracingConfig));
    expect(session).toBeDefined();

    console.log(`  🌊 Cognipeer sink streaming session: ${session!.sessionId}`);

    await startStreamingSession(session, makeRuntime());
    expect(session!.sessionStarted).toBe(true);

    recordSampleEvents(session!);

    await new Promise((resolve) => setTimeout(resolve, 1500));

    const result = await finalizeTraceSession(session, {
      agentRuntime: makeRuntime(),
    });

    expect(result).toBeDefined();
    expect(result!.status).toBe("success");

    const sessionId = session!.sessionId;
    expect(callsFor(sessionId, `/stream/${sessionId}/start`).length).toBe(1);
    expect(callsFor(sessionId, `/stream/${sessionId}/events`).length).toBe(3);
    expect(callsFor(sessionId, `/stream/${sessionId}/end`).length).toBe(1);
    expectAllIngestCallsAccepted(callsFor(sessionId));

    console.log(`  ✅ Cognipeer sink streaming: status=${result!.status}`);
  }, TEST_TIMEOUT_MS);
});
