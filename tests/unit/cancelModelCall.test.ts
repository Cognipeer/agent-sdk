/**
 * End to end through the agent loop: cancelling a run while the model is still
 * answering must (1) hang up on the provider and (2) report the run as
 * cancelled — not throw the abort as a model error, not run half-streamed tool
 * calls, and not look like a normally completed turn.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { createAgent } from "../../src/agent.js";
import { createSmartAgent } from "../../src/smart/index.js";
import { createTool } from "../../src/tool.js";
import { customSink } from "../../src/utils/tracing.js";
import { createProvider, fromNativeProvider } from "../../src/providers/index.js";
import { startSlowModelServer, until, type SlowModelServer } from "../setup/mocks/slowModelServer.js";

let server: SlowModelServer;

beforeAll(async () => {
  server = await startSlowModelServer({ chunks: 80, chunkGapMs: 25, slowJsonMs: 3_000 });
});

afterAll(async () => {
  await server.close();
});

afterEach(() => {
  server.reset();
  vi.restoreAllMocks();
});

function modelAt(path = "") {
  return fromNativeProvider(
    createProvider({ provider: "openai", apiKey: "k", baseURL: `${server.baseURL}${path}` }),
    { model: "m" },
  );
}

const userTurn = { messages: [{ role: "user", content: "go" }] } as any;

describe("createAgent: a cancelled model call", () => {
  it("streaming: hangs up on the provider and reports the run as cancelled with the text so far", async () => {
    const controller = new AbortController();
    const events: any[] = [];
    const traces: any[] = [];
    let chunks = 0;
    const agent = createAgent({
      name: "Cancellable",
      model: modelAt(),
      tracing: { enabled: true, logData: true, sink: customSink((e) => traces.push(e)) },
    });

    const result = await agent.invoke(userTurn, {
      stream: true,
      cancellationToken: controller.signal,
      onEvent: (e) => events.push(e),
      onStream: () => {
        chunks += 1;
        if (chunks === 3) controller.abort();
      },
    });

    const cancelled = (result.state as any).ctx.__cancelled;
    expect(cancelled).toMatchObject({ stage: "agent", reason: "aborted" });
    expect(events.filter((e) => e.type === "cancelled")).toEqual([{ type: "cancelled", stage: "agent", reason: "aborted" }]);

    // The text that had streamed is the assistant turn; nothing is left half-open.
    const last = result.messages.at(-1) as any;
    expect(last.role).toBe("assistant");
    expect(last.content).toMatch(/^w0 w1 /);
    expect(last.tool_calls).toBeUndefined();

    await until(() => server.hits[0]?.closedEarly === true);
    expect(server.hits[0].finished).toBe(false);
    expect(server.hits[0].written).toBeLessThan(80);
    expect(server.hits).toHaveLength(1);

    // Not a failure: no error trace for the aborted call.
    expect(traces.some((t) => String(t.label).startsWith("Assistant Error"))).toBe(false);
    const cancelledCall = traces.find((t) => t.type === "ai_call" && String(t.label).startsWith("Assistant Cancelled"));
    expect(cancelledCall).toBeDefined();
    // "skipped", not "error": the caller ended the call, it did not fail.
    expect(cancelledCall.status).toBe("skipped");
  });

  it("streaming: a token that only exposes a flag cancels the same way", async () => {
    const token = { isCancellationRequested: false };
    let chunks = 0;
    const agent = createAgent({ name: "TokenCancel", model: modelAt() });
    const result = await agent.invoke(userTurn, {
      stream: true,
      cancellationToken: token,
      onStream: () => {
        chunks += 1;
        if (chunks === 3) token.isCancellationRequested = true;
      },
    });
    expect((result.state as any).ctx.__cancelled).toMatchObject({ stage: "agent", reason: "cancelled" });
    await until(() => server.hits[0]?.closedEarly === true);
    expect(server.hits[0].written).toBeLessThan(80);
  });

  it("not streaming: the in-flight request is aborted and the run resolves as cancelled", async () => {
    const controller = new AbortController();
    const events: any[] = [];
    const agent = createAgent({ name: "Blocking", model: modelAt("/slow-json") });
    const started = Date.now();
    setTimeout(() => controller.abort(), 150);

    const result = await agent.invoke(userTurn, {
      cancellationToken: controller.signal,
      onEvent: (e) => events.push(e),
    });

    expect(Date.now() - started).toBeLessThan(2_000);
    expect((result.state as any).ctx.__cancelled).toMatchObject({ stage: "agent", reason: "aborted" });
    expect(events.some((e) => e.type === "cancelled")).toBe(true);
    // Nothing was said, so nothing is appended: no empty assistant turn.
    expect(result.messages).toHaveLength(1);
    await until(() => server.hits[0]?.closedEarly === true);
    expect(server.hits[0].finished).toBe(false);
  });

  it("not streaming: a flag-only token cancels the in-flight request", async () => {
    const token = { isCancellationRequested: false };
    const agent = createAgent({ name: "BlockingToken", model: modelAt("/slow-json") });
    setTimeout(() => { token.isCancellationRequested = true; }, 150);
    const result = await agent.invoke(userTurn, { cancellationToken: token });
    expect((result.state as any).ctx.__cancelled).toMatchObject({ stage: "agent", reason: "cancelled" });
    await until(() => server.hits[0]?.closedEarly === true);
  });

  it("a half-streamed tool call is dropped: the tool never runs and no tool_call is left unanswered", async () => {
    const controller = new AbortController();
    const func = vi.fn(async () => "found");
    const lookup = createTool({
      name: "lookup",
      description: "look something up",
      schema: z.object({ q: z.string() }),
      func,
    });
    let chunks = 0;
    const agent = createAgent({ name: "ToolCancel", model: modelAt("/tool-stream"), tools: [lookup] });

    const result = await agent.invoke(userTurn, {
      stream: true,
      cancellationToken: controller.signal,
      // The tool call carries no text, so cancel from the wire: after a moment.
      onProgress: () => {
        chunks += 1;
        if (chunks === 1) setTimeout(() => controller.abort(), 200);
      },
    });

    expect((result.state as any).ctx.__cancelled).toBeTruthy();
    expect(func).not.toHaveBeenCalled();
    const danglingCalls = (result.messages as any[]).filter((m) => m.role === "assistant" && m.tool_calls?.length);
    expect(danglingCalls).toHaveLength(0);
    await until(() => server.hits[0]?.closedEarly === true);
  });

  it("a run nobody cancels is untouched: finished stream, no cancel flag, signal never fires", async () => {
    const controller = new AbortController();
    const quick = await startSlowModelServer({ chunks: 4, chunkGapMs: 5 });
    try {
      const agent = createAgent({
        name: "Calm",
        model: fromNativeProvider(createProvider({ provider: "openai", apiKey: "k", baseURL: quick.baseURL }), { model: "m" }),
      });
      const result = await agent.invoke(userTurn, { stream: true, cancellationToken: controller.signal });
      expect((result.state as any).ctx.__cancelled).toBeUndefined();
      expect(result.content).toBe("w0 w1 w2 w3 ");
      expect(quick.hits[0].finished).toBe(true);
    } finally {
      await quick.close();
    }
  });
});

describe("createSmartAgent: a cancelled model call", () => {
  it("resolves as cancelled and does not start another model call", async () => {
    const controller = new AbortController();
    let chunks = 0;
    const agent = createSmartAgent({ name: "SmartCancel", model: modelAt() } as any);

    const result = await agent.invoke(userTurn, {
      stream: true,
      cancellationToken: controller.signal,
      onStream: () => {
        chunks += 1;
        if (chunks === 3) controller.abort();
      },
    });

    expect((result.state as any).ctx.__cancelled).toMatchObject({ stage: "agent", reason: "aborted" });
    await until(() => server.hits[0]?.closedEarly === true);
    expect(server.hits).toHaveLength(1);
  });
});
