import { afterEach, describe, expect, it, vi } from "vitest";
import { createTraceSession, finalizeTraceSession, startStreamingSession } from "../../src/utils/tracing.js";
import type { AgentRuntimeConfig, SmartAgentOptions, TracingConfig } from "../../src/types.js";

function makeAgentOptions(tracing: TracingConfig): SmartAgentOptions {
  return {
    model: { id: "test-model", provider: "test-provider" },
    tracing,
  };
}

function makeRuntime(): AgentRuntimeConfig {
  return {
    model: { id: "test-model", provider: "test-provider" },
    tools: [],
    name: "trace-unit-agent",
    version: "1.0.0",
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("tracing degraded session handling", () => {
  it("marks the session partial when streaming startup fails but finalize falls back to batched upload", async () => {
    const fetchMock = vi.fn()
      .mockRejectedValueOnce(new Error("stream start offline"))
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        statusText: "OK",
        text: async () => "",
      });

    vi.stubGlobal("fetch", fetchMock as typeof fetch);

    const tracing: TracingConfig = {
      enabled: true,
      mode: "streaming",
      sink: {
        type: "http",
        url: "https://trace.example.test/sessions",
      },
    };

    const session = createTraceSession(makeAgentOptions(tracing));
    expect(session).toBeDefined();

    await startStreamingSession(session, makeRuntime());

    expect(session?.sessionStarted).toBe(false);
    expect(session?.errors.some((error) => error.type === "sink")).toBe(true);

    const result = await finalizeTraceSession(session, {
      agentRuntime: makeRuntime(),
    });

    expect(result?.status).toBe("partial");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0]?.[0]).toContain("/stream/");
    expect(fetchMock.mock.calls[1]?.[0]).toBe("https://trace.example.test/sessions");
  });
});