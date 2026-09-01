/**
 * Where a redacted value must NOT still exist.
 *
 * A `postToolUse` rewrite that only fixes the transcript is a lie: the verdict
 * says "redacted" while the original sits one tool call away. The agent ships
 * `get_tool_response` specifically so a model can page a full payload back —
 * an invited, documented path — so a redaction that skips it is not bypassed
 * by accident, it is bypassed by design.
 *
 * A tool output has SIX copies in this runtime, and a mutation has to reach
 * every one of them:
 *   1. the transcript message the model reads
 *   2. `toolHistory[].output`
 *   3. `toolHistory[].rawOutput`      ← what get_tool_response returns
 *   4. the per-run tool cache          ← what a repeat call serves
 *   5. the `tool_call` event's `result`
 *   6. the trace event's payload
 *
 * These tests pin all six. They are the regression guard for a bypass that was
 * real in the published 0.9.4 build, where the hook ran before `rawOutput` was
 * written from the pre-hook value.
 */

import { describe, it, expect, vi } from "vitest";
import { z } from "zod";
import { createAgent } from "../../../src/agent.js";
import { createSmartAgent } from "../../../src/smart/index.js";
import { createTool } from "../../../src/tool.js";
import { customSink } from "../../../src/utils/tracing.js";
import { defineHook } from "../../../src/plugins/define.js";
import { piiRedaction } from "../../../src/plugins/builtin/piiRedaction.js";
import type { SmartAgentEvent, TraceEventRecord } from "../../../src/types.js";

const SECRET = "sk-live-51H8vQm2xKpLzR9tNwYbEfGhJkMnOpQr";

const secretTool = (func = vi.fn(async () => ({ service: "billing", apiKey: SECRET }))) =>
  createTool({
    name: "read_config",
    description: "Read a service configuration.",
    schema: z.object({ service: z.string() }),
    func,
  });

/** Calls read_config, then answers. */
function callsToolThenAnswers(times = 1) {
  let turn = 0;
  return {
    modelName: "redaction-model",
    bindTools() {
      return this;
    },
    async invoke() {
      turn += 1;
      if (turn <= times) {
        return {
          role: "assistant",
          content: "",
          tool_calls: [
            {
              id: `call_${turn}`,
              type: "function",
              function: { name: "read_config", arguments: JSON.stringify({ service: "billing" }) },
            },
          ],
        };
      }
      return { role: "assistant", content: "done" };
    },
  } as never;
}

/** Masks anything that looks like the secret, on the raw tool output. */
const redactor = defineHook(
  "postToolUse",
  ({ output }) => {
    const text = typeof output === "string" ? output : JSON.stringify(output);
    if (!text || !text.includes(SECRET)) return undefined;
    return { output: JSON.parse(text.split(SECRET).join("[REDACTED]")) };
  },
  { name: "secret-redactor", mayRequireApproval: false },
);

describe("a postToolUse redaction reaches every copy of the value", () => {
  it("does not leave the original in toolHistory.rawOutput", async () => {
    const agent = createAgent({
      model: callsToolThenAnswers(),
      tools: [secretTool()],
      plugins: [redactor],
    });

    const result = await agent.invoke({ messages: [{ role: "user", content: "read the billing config" }] });

    const entry = result.state!.toolHistory!.find((h) => h.toolName === "read_config")!;
    expect(entry).toBeDefined();
    // `rawOutput` is what get_tool_response hands back. Written from the
    // PRE-hook value it would carry the secret while the transcript looked clean.
    expect(JSON.stringify(entry.rawOutput)).not.toContain(SECRET);
    expect(JSON.stringify(entry.output)).not.toContain(SECRET);
    expect(JSON.stringify(entry.rawOutput)).toContain("[REDACTED]");
  });

  it("does not leave the original anywhere in the returned transcript", async () => {
    const agent = createAgent({
      model: callsToolThenAnswers(),
      tools: [secretTool()],
      plugins: [redactor],
    });

    const result = await agent.invoke({ messages: [{ role: "user", content: "read the billing config" }] });

    expect(JSON.stringify(result.messages)).not.toContain(SECRET);
    expect(JSON.stringify(result.state)).not.toContain(SECRET);
  });

  it("hands the model the redacted value through get_tool_response", async () => {
    // The recovery tool is injected by createSmartAgent AFTER the caller's tool
    // list, so a host cannot wrap it — which is exactly why the redaction has
    // to be durable rather than guarded at the call site.
    let turn = 0;
    const model = {
      modelName: "recovery-model",
      bindTools() {
        return this;
      },
      async invoke() {
        turn += 1;
        if (turn === 1) {
          return {
            role: "assistant",
            content: "",
            tool_calls: [
              {
                id: "call_read",
                type: "function",
                function: { name: "read_config", arguments: JSON.stringify({ service: "billing" }) },
              },
            ],
          };
        }
        if (turn === 2) {
          // The model now pages the "full" payload back.
          return {
            role: "assistant",
            content: "",
            tool_calls: [
              {
                id: "call_recover",
                type: "function",
                function: {
                  name: "get_tool_response",
                  arguments: JSON.stringify({ toolName: "read_config" }),
                },
              },
            ],
          };
        }
        return { role: "assistant", content: "done" };
      },
    } as never;

    const agent = createSmartAgent({
      model,
      tools: [secretTool()],
      limits: { maxToolCalls: 4 },
      plugins: [redactor],
    });

    const result = await agent.invoke({
      messages: [{ role: "user", content: "read the billing config, then recover the full response" }],
    });

    const recovered = result.messages.filter(
      (m) => m.role === "tool" && m.name === "get_tool_response",
    );
    // Either the recovery ran and returned the redacted value, or it did not run
    // at all — what must never happen is the secret coming back.
    expect(JSON.stringify(recovered)).not.toContain(SECRET);
    expect(JSON.stringify(result.messages)).not.toContain(SECRET);
  });

  it("caches the redacted value, so a repeat call cannot serve the original", async () => {
    const func = vi.fn(async () => ({ service: "billing", apiKey: SECRET }));
    const cached = createTool({
      name: "read_config",
      description: "Read a service configuration.",
      schema: z.object({ service: z.string() }),
      func,
      cache: true,
    });

    const agent = createAgent({
      model: callsToolThenAnswers(2),
      tools: [cached],
      limits: { maxToolCalls: 4 },
      plugins: [redactor],
    });

    const result = await agent.invoke({ messages: [{ role: "user", content: "read it twice" }] });

    // Second call served from cache — the cache must hold the post-hook value.
    expect(func).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(result.state!.toolHistory)).not.toContain(SECRET);
    expect(JSON.stringify(result.messages)).not.toContain(SECRET);
  });

  it("does not emit the original on the event stream", async () => {
    const events: SmartAgentEvent[] = [];
    const agent = createAgent({
      model: callsToolThenAnswers(),
      tools: [secretTool()],
      plugins: [redactor],
    });

    await agent.invoke(
      { messages: [{ role: "user", content: "read the billing config" }] },
      { onEvent: (event) => events.push(event) },
    );

    expect(JSON.stringify(events)).not.toContain(SECRET);
  });

  it("does not write the original to the trace", async () => {
    const traceEvents: TraceEventRecord[] = [];
    const agent = createAgent({
      model: callsToolThenAnswers(),
      tools: [secretTool()],
      tracing: {
        enabled: true,
        logData: true,
        sink: customSink((event: TraceEventRecord) => traceEvents.push(event)),
      } as never,
      plugins: [redactor],
    });

    await agent.invoke({ messages: [{ role: "user", content: "read the billing config" }] });

    expect(traceEvents.length).toBeGreaterThan(0);
    expect(JSON.stringify(traceEvents)).not.toContain(SECRET);
  });

  it("holds for the shipped piiRedaction plugin too, not just a hand-written hook", async () => {
    const emailTool = createTool({
      name: "read_config",
      description: "Read a service configuration.",
      schema: z.object({ service: z.string() }),
      func: async () => ({ owner: "ada.lovelace@example.com" }),
    });

    const agent = createAgent({
      model: callsToolThenAnswers(),
      tools: [emailTool],
      plugins: [piiRedaction({ entities: ["EMAIL"] })],
    });

    const result = await agent.invoke({ messages: [{ role: "user", content: "read the billing config" }] });

    const entry = result.state!.toolHistory!.find((h) => h.toolName === "read_config")!;
    expect(JSON.stringify(entry.rawOutput)).not.toContain("ada.lovelace@example.com");
    expect(JSON.stringify(result.messages)).not.toContain("ada.lovelace@example.com");
  });
});
