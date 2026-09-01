/**
 * Operational built-ins: `sessionMetrics` and `mcp`.
 *
 * Both are driven through the real machinery rather than by calling their hooks
 * directly, because what they claim is only true when the machinery cooperates:
 * `sessionMetrics` reports numbers the SDK writes into `state.usage` and
 * `state.toolHistory` during an actual run, and `mcp` is a `setup` + disposer
 * plugin, so nothing about its lifecycle is observable unless a host opens and
 * closes it.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { createAgent, createTool } from "../../../src/index.js";
import { createPluginHost, mcp, sessionMetrics } from "../../../src/plugins/index.js";
import type { AgentPlugin, PluginLogger, SessionMetrics } from "../../../src/plugins/index.js";
import type { Message, ToolInterface } from "../../../src/types.js";

afterEach(() => {
  vi.restoreAllMocks();
});

const silentLogger: PluginLogger = { debug: () => {}, warn: () => {}, error: () => {} };

// ─── Fakes ───────────────────────────────────────────────────────────────────

type ScriptTurn = { text: string } | { tool: string; args: Record<string, unknown>; id?: string };

/** Fixed usage per turn, so the token assertions are exact arithmetic. */
const TURN_USAGE = {
  prompt_tokens: 10,
  completion_tokens: 5,
  prompt_tokens_details: { cached_tokens: 4 },
};

function scriptedModel(turns: ScriptTurn[]) {
  const boundMenus: string[][] = [];
  let index = 0;

  const model: any = {
    modelName: "scripted-model",
    bindTools(tools: any[]) {
      boundMenus.push(tools.map((tool: any) => tool?.name));
      return this;
    },
    async invoke() {
      const turn = turns[Math.min(index, turns.length - 1)];
      index += 1;
      if ("text" in turn) return { role: "assistant", content: turn.text, usage: TURN_USAGE };
      return {
        role: "assistant",
        content: "",
        usage: TURN_USAGE,
        tool_calls: [
          {
            id: turn.id ?? `call_${index}`,
            type: "function",
            function: { name: turn.tool, arguments: JSON.stringify(turn.args) },
          },
        ],
      };
    },
  };

  return { model, boundMenus };
}

function echoTool(name: string, impl?: (args: any) => unknown) {
  return createTool({
    name,
    description: `${name} (test tool)`,
    schema: z.object({ message: z.string() }),
    func: async (args: any) => (impl ? impl(args) : `${name}:${args.message}`),
  });
}

/** Refuses one tool by name, exactly the way a policy plugin would. */
function denyPlugin(toolName: string): AgentPlugin {
  return {
    name: `deny-${toolName}`,
    mayRequireApproval: false,
    hooks: {
      preToolUse: ({ toolName: called }) =>
        called === toolName ? { decision: "deny", reason: "not allowed here" } : undefined,
    },
  };
}

// ─── sessionMetrics ──────────────────────────────────────────────────────────

describe("sessionMetrics", () => {
  it("emits one record per run with the model, tool and token counts of the real run", async () => {
    const emitted: SessionMetrics[] = [];
    const { model } = scriptedModel([
      { tool: "search", args: { message: "hello" }, id: "tc_1" },
      { tool: "search", args: { message: "again" }, id: "tc_2" },
      { text: "done" },
    ]);

    const agent = createAgent({
      name: "metered",
      model,
      tools: [echoTool("search")],
      limits: { maxToolCalls: 5 },
      plugins: [sessionMetrics({ sink: (metrics) => void emitted.push(metrics), includeToolBreakdown: true })],
    } as any);

    const result = await agent.invoke({ messages: [{ role: "user", content: "go" } as Message] } as any);
    expect(result.content).toBe("done");

    expect(emitted).toHaveLength(1);
    const [metrics] = emitted;
    expect(metrics.status).toBe("success");
    expect(metrics.agentName).toBe("metered");
    expect(typeof metrics.runId).toBe("string");
    expect(metrics.modelCalls).toBe(3);
    expect(metrics.toolCalls).toBe(2);
    expect(metrics.failedToolCalls).toBe(0);
    expect(metrics.deniedToolCalls).toBe(0);
    expect(metrics.toolBreakdown).toEqual({ search: 2 });
    expect(metrics.durationMs).toBeGreaterThanOrEqual(0);

    // Token totals come from `state.usage`, so they match what the host bills.
    expect(metrics.inputTokens).toBe(30);
    expect(metrics.outputTokens).toBe(15);
    expect(metrics.cachedInputTokens).toBe(12);
    expect(metrics.totalTokens).toBe(45);
    expect(metrics.estimatedCostUsd).toBeUndefined(); // no estimator configured
  });

  it("counts a denied call as denied and a throwing call as failed", async () => {
    const emitted: SessionMetrics[] = [];
    const { model } = scriptedModel([
      { tool: "danger", args: { message: "rm -rf" }, id: "tc_1" },
      { tool: "flaky", args: { message: "boom" }, id: "tc_2" },
      { text: "stopped" },
    ]);

    const agent = createAgent({
      name: "mixed",
      model,
      tools: [
        echoTool("danger"),
        echoTool("flaky", () => {
          throw new Error("tool exploded");
        }),
      ],
      limits: { maxToolCalls: 5 },
      plugins: [
        sessionMetrics({ sink: (metrics) => void emitted.push(metrics), includeToolBreakdown: true }),
        denyPlugin("danger"),
      ],
    } as any);

    await agent.invoke({ messages: [{ role: "user", content: "go" } as Message] } as any);

    const [metrics] = emitted;
    expect(metrics.toolCalls).toBe(2);
    // The two failure modes are NOT interchangeable: a denial is the policy
    // working, an error is the tool breaking, and an on-call dashboard that
    // conflates them pages the wrong team.
    expect(metrics.deniedToolCalls).toBe(1);
    expect(metrics.failedToolCalls).toBe(1);
    // A denied call never reaches `postToolUse`, so it is absent from the
    // per-tool breakdown while still being counted as an attempt above.
    expect(metrics.toolBreakdown).toEqual({ flaky: 1 });
  });

  it("prices the run when a cost estimator is supplied", async () => {
    const emitted: SessionMetrics[] = [];
    const { model } = scriptedModel([{ text: "hi" }]);

    const agent = createAgent({
      name: "priced",
      model,
      plugins: [
        sessionMetrics({
          sink: (metrics) => void emitted.push(metrics),
          costEstimator: ({ inputTokens, outputTokens }) => inputTokens * 0.001 + outputTokens * 0.002,
        }),
      ],
    } as any);

    await agent.invoke({ messages: [{ role: "user", content: "go" } as Message] } as any);

    expect(emitted[0].modelCalls).toBe(1);
    expect(emitted[0].estimatedCostUsd).toBeCloseTo(0.02, 10);
  });

  it("a sink that throws does not fail the run", async () => {
    // The failure is reported through the host logger, which is `console.warn`
    // by default; silenced here so the expected warning is not read as noise.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { model } = scriptedModel([{ text: "answered anyway" }]);
    const agent = createAgent({
      name: "broken-sink",
      model,
      plugins: [
        sessionMetrics({
          sink: () => {
            throw new Error("metrics pipeline down");
          },
        }),
      ],
    } as any);

    const result = await agent.invoke({ messages: [{ role: "user", content: "go" } as Message] } as any);
    expect(result.content).toBe("answered anyway");
    expect(warn).toHaveBeenCalled();
  });
});

// ─── mcp ─────────────────────────────────────────────────────────────────────

describe("mcp", () => {
  it("contributes the discovered tools to the agent's bound menu", async () => {
    const remote = echoTool("remote_search");
    const { model, boundMenus } = scriptedModel([{ text: "ok" }]);

    const agent = createAgent({
      name: "mcp-agent",
      model,
      tools: [echoTool("local")],
      plugins: [mcp({ connect: async () => ({ tools: [remote] }) })],
    } as any);

    await agent.invoke({ messages: [{ role: "user", content: "go" } as Message] } as any);

    expect(boundMenus[0]).toEqual(expect.arrayContaining(["local", "remote_search"]));
  });

  it("prefixes discovered tools without mutating the caller's objects", async () => {
    const remote = echoTool("search");
    const host = createPluginHost([mcp({ connect: async () => ({ tools: [remote] }), prefix: "docs" })], {
      logger: silentLogger,
    });

    await host.setup({ model: null });

    const [contributed] = host.contributions.tools;
    expect(contributed.name).toBe("docs__search");
    // The connection is shared by every agent built from this plugin, so the
    // server's own tool object must come back untouched.
    expect(remote.name).toBe("search");
    expect(contributed).not.toBe(remote);

    // The rename is cosmetic: execution still runs the original implementation.
    const output = await (contributed as ToolInterface).invoke!({ message: "hi" });
    expect(output).toBe("search:hi");
  });

  it("closes the session when the agent is disposed", async () => {
    const close = vi.fn(async () => {});
    const connect = vi.fn(async () => ({ tools: [echoTool("remote")], close }));
    const { model } = scriptedModel([{ text: "ok" }]);

    const agent = createAgent({
      name: "closer",
      model,
      plugins: [mcp({ connect })],
    } as any);

    await agent.invoke({ messages: [{ role: "user", content: "go" } as Message] } as any);
    expect(connect).toHaveBeenCalledTimes(1);
    expect(close).not.toHaveBeenCalled();

    await agent.dispose!();
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("a failed connect is fail-open by default and fatal when fail-closed", async () => {
    const failing = () => Promise.reject(new Error("stdio transport refused"));

    const open = createPluginHost([mcp({ connect: failing })], { logger: silentLogger });
    await open.setup({ model: null });
    // The agent still builds — it simply has none of this server's tools.
    expect(open.contributions.tools).toEqual([]);

    const closed = createPluginHost([mcp({ connect: failing, failureMode: "closed" })], {
      logger: silentLogger,
    });
    await expect(closed.setup({ model: null })).rejects.toThrow(
      /Plugin "mcp" failed to set up and is fail-closed: stdio transport refused/,
    );
  });

  it("bounds a hanging connect with timeoutMs instead of stalling construction", async () => {
    const host = createPluginHost(
      [mcp({ connect: () => new Promise(() => {}), timeoutMs: 20, failureMode: "closed" })],
      { logger: silentLogger },
    );

    await expect(host.setup({ model: null })).rejects.toThrow(/MCP connect timed out after 20ms/);
  });

  it("shares one session across the hosts that inherit the plugin", async () => {
    const close = vi.fn(async () => {});
    const connect = vi.fn(async () => ({ tools: [echoTool("remote")], close }));
    const plugin = mcp({ connect });

    // What delegation looks like: a child agent builds its own host over the
    // same plugin object.
    const parent = createPluginHost([plugin], { logger: silentLogger });
    const child = createPluginHost([plugin], { logger: silentLogger });
    await parent.setup({ model: null });
    await child.setup({ model: null });

    expect(connect).toHaveBeenCalledTimes(1);

    // The child letting go must not close the server the parent is still using.
    await child.dispose();
    expect(close).not.toHaveBeenCalled();

    await parent.dispose();
    expect(close).toHaveBeenCalledTimes(1);
  });
});
