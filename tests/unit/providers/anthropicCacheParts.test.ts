/**
 * Prompt-cache breakpoints on the Messages API, beyond the SDK's own strategy:
 *  - the caller's `cacheControl` on a text part (user, assistant, system, inside a tool
 *    result) becomes `cache_control` on that block;
 *  - the system breakpoint sits after the static system prompt, and the SDK's per-turn
 *    system messages (summary, memory, plugin context, reflection) come after it;
 *  - a request never carries more than 4 breakpoints: the caller's count first and win,
 *    the SDK's own only while slots remain, and a 1h one never follows a 5m one.
 */

import { describe, it, expect } from "vitest";
import { AnthropicProvider } from "../../../src/providers/anthropic.js";
import { VertexProvider } from "../../../src/providers/vertex.js";
import type { ChatCompletionRequest, UnifiedMessage } from "../../../src/providers/types.js";

const OK = { id: "m", model: "c", content: [{ type: "text", text: "ok" }], stop_reason: "end_turn", usage: { input_tokens: 1, output_tokens: 1 } };
const EPH = { type: "ephemeral" };
const EPH_1H = { type: "ephemeral", ttl: "1h" };

const TOOLS = [
  { name: "t1", description: "a", parameters: { type: "object", properties: {}, additionalProperties: false } },
  { name: "t2", description: "b", parameters: { type: "object", properties: {}, additionalProperties: false } },
];

const marked = (text: string, cacheControl: Record<string, unknown> = { type: "ephemeral" }) => ({ type: "text" as const, text, cacheControl });
const plain = (text: string) => ({ type: "text" as const, text });
const user = (...parts: Array<ReturnType<typeof marked> | ReturnType<typeof plain>>): UnifiedMessage => ({ role: "user", content: parts as any });

/** The JSON body sent for a request (default model, no system, one user message). */
async function sent(request: Partial<ChatCompletionRequest>, caching?: Record<string, unknown>): Promise<any> {
  let body: any;
  const fetchImpl = (async (_url: unknown, init: any) => {
    body = JSON.parse(init.body);
    return new Response(JSON.stringify(OK), { status: 200 });
  }) as unknown as typeof fetch;
  const p = new AnthropicProvider({
    provider: "anthropic",
    apiKey: "k",
    fetch: fetchImpl,
    retry: { maxRetries: 0 },
    ...(caching ? { prompt_caching: caching } : {}),
  } as any);
  await p.complete({ model: "claude-sonnet-4-20250514", messages: [{ role: "user", content: "hi" }], ...request });
  return body;
}

/** How many `cache_control` markers a request body carries, nested ones included. */
function markers(node: unknown): number {
  if (Array.isArray(node)) return node.reduce((n: number, x) => n + markers(x), 0);
  if (node && typeof node === "object") {
    return Object.entries(node).reduce((n, [k, v]) => n + (k === "cache_control" && v != null ? 1 : 0) + markers(v), 0);
  }
  return 0;
}

describe("the caller's cacheControl on a text part", () => {
  it("is sent on that block, with prompt caching off", async () => {
    const body = await sent({ messages: [user(marked("big document"), plain("question"))] });
    expect(body.messages[0].content).toEqual([
      { type: "text", text: "big document", cache_control: EPH },
      { type: "text", text: "question" },
    ]);
    expect(body.cache_control).toBeUndefined();
    expect(markers(body)).toBe(1);
  });

  it("ttl is sent for 1h only: 5m is the default", async () => {
    const body = await sent({ messages: [user(marked("a", { type: "ephemeral", ttl: "1h" }), marked("b", { type: "ephemeral", ttl: "5m" }), marked("c"))] });
    expect(body.messages[0].content.map((b: any) => b.cache_control)).toEqual([EPH_1H, EPH, EPH]);
  });

  it("works on an assistant text part", async () => {
    const body = await sent({
      messages: [
        { role: "user", content: "hi" },
        { role: "assistant", content: [marked("earlier answer")] },
        { role: "user", content: "next" },
      ],
    });
    expect(body.messages[1].content).toEqual([{ type: "text", text: "earlier answer", cache_control: EPH }]);
  });

  it("works on text inside a tool result", async () => {
    const body = await sent({
      messages: [
        { role: "user", content: "go" },
        { role: "assistant", content: "", toolCalls: [{ id: "t1", name: "lookup", arguments: "{}" }] },
        { role: "tool", toolCallId: "t1", content: [marked("big result")] },
      ],
    });
    expect(body.messages[2].content[0]).toEqual({
      type: "tool_result",
      tool_use_id: "t1",
      content: [{ type: "text", text: "big result", cache_control: EPH }],
    });
  });

  it("cuts the system prompt after a marked part, and sends blocks even with prompt caching off", async () => {
    const body = await sent({
      messages: [{ role: "system", content: [marked("rules"), plain("more rules")] as any }, { role: "user", content: "hi" }],
    });
    expect(body.system).toEqual([
      { type: "text", text: "rules", cache_control: EPH },
      { type: "text", text: "more rules" },
    ]);
    expect(body.cache_control).toBeUndefined();
  });

  it("is not sent on blank text: the block is left out with it", async () => {
    const body = await sent({ messages: [user(marked("   "), plain("question"))] });
    expect(body.messages[0].content).toEqual([{ type: "text", text: "question" }]);
    expect(markers(body)).toBe(0);
  });

  it("does not stop the SDK from marking the end of the static system prompt", async () => {
    const body = await sent(
      { messages: [{ role: "system", content: [marked("core"), plain("rest")] as any }, { role: "user", content: "hi" }] },
      { enabled: true },
    );
    expect(body.system).toEqual([
      { type: "text", text: "core", cache_control: EPH },
      { type: "text", text: "rest", cache_control: EPH },
    ]);
    // Plus the top-level automatic one.
    expect(body.cache_control).toEqual(EPH);
    expect(markers(body)).toBe(3);
  });
});

describe("the system breakpoint sits after the static system prompt", () => {
  const system = (content: string, name?: string): UnifiedMessage => ({ role: "system", content, ...(name ? { name } : {}) });

  it("the SDK's per-turn system messages come after it", async () => {
    const body = await sent(
      { messages: [system("static rules"), system("memory: likes tea", "memory_context"), { role: "user", content: "hi" }] },
      { enabled: true },
    );
    expect(body.system).toEqual([
      { type: "text", text: "static rules", cache_control: EPH },
      { type: "text", text: "memory: likes tea" },
    ]);
    expect(body.cache_control).toEqual(EPH);
  });

  it.each(["context_summary", "memory_context", "plugin_context", "agent_reflection"])("%s is a per-turn block, never cached", async (name) => {
    const body = await sent({ messages: [system("static rules"), system("changes every turn", name), { role: "user", content: "hi" }] }, { enabled: true });
    expect(body.system[0]).toEqual({ type: "text", text: "static rules", cache_control: EPH });
    expect(body.system[1]).toEqual({ type: "text", text: "changes every turn" });
  });

  it("a system message added after the conversation began is per-turn too", async () => {
    const body = await sent(
      { messages: [system("rules"), { role: "user", content: "hi" }, system("Answer in French.")] },
      { enabled: true },
    );
    expect(body.system).toEqual([
      { type: "text", text: "rules", cache_control: EPH },
      { type: "text", text: "Answer in French." },
    ]);
    // Only the user message is left in `messages`.
    expect(body.messages).toHaveLength(1);
  });

  it("with no static system prompt there is nothing to mark in `system`", async () => {
    const body = await sent({ messages: [system("summary so far", "context_summary"), { role: "user", content: "hi" }] }, { enabled: true });
    expect(body.system).toEqual([{ type: "text", text: "summary so far" }]);
    // The top-level automatic one is still there.
    expect(body.cache_control).toEqual(EPH);
    expect(markers(body)).toBe(1);
  });

  it("with prompt caching off the system messages are one string, in their order", async () => {
    const body = await sent({ messages: [system("static rules"), system("memory: likes tea", "memory_context"), { role: "user", content: "hi" }] });
    expect(body.system).toBe("static rules\n\nmemory: likes tea");
  });
});

describe("at most 4 breakpoints", () => {
  it("5 of the caller's: the earliest is dropped and the SDK adds none", async () => {
    const body = await sent(
      {
        messages: [
          { role: "system", content: "sys" },
          user(marked("a"), marked("b"), marked("c"), marked("d"), marked("e")),
        ],
        tools: TOOLS,
      },
      { enabled: true },
    );
    expect(body.messages[0].content.map((b: any) => (b.cache_control ? "m" : "-")).join("")).toBe("-mmmm");
    expect(body.system).toEqual([{ type: "text", text: "sys" }]);
    expect(body.tools[1].cache_control).toBeUndefined();
    expect(body.cache_control).toBeUndefined();
    expect(markers(body)).toBe(4);
  });

  it("3 of the caller's: the SDK gets the one slot left, in order system, tools, top level", async () => {
    const body = await sent(
      {
        messages: [{ role: "system", content: "sys" }, user(marked("a"), marked("b"), marked("c"))],
        tools: TOOLS,
      },
      { enabled: true },
    );
    expect(body.system).toEqual([{ type: "text", text: "sys", cache_control: EPH }]);
    expect(body.tools[1].cache_control).toBeUndefined();
    expect(body.cache_control).toBeUndefined();
    expect(markers(body)).toBe(4);
  });

  it("a raw cache_control in `extra` counts, and is never touched", async () => {
    const body = await sent(
      { messages: [user(marked("a"), marked("b"), marked("c"))], extra: { cache_control: EPH_1H } },
      { enabled: true },
    );
    // 3 parts + the raw top-level one = 4: nothing is added, and the raw 1h stays after the 5m ones.
    expect(body.cache_control).toEqual(EPH_1H);
    expect(markers(body)).toBe(4);
  });

  it("the SDK's own markers still fill an empty budget: system, last tool, top level", async () => {
    const body = await sent({ messages: [{ role: "system", content: "sys" }, { role: "user", content: "hi" }], tools: TOOLS }, { enabled: true });
    expect(body.system).toEqual([{ type: "text", text: "sys", cache_control: EPH }]);
    expect(body.tools[1].cache_control).toEqual(EPH);
    expect(body.tools[0].cache_control).toBeUndefined();
    expect(body.cache_control).toEqual(EPH);
    expect(markers(body)).toBe(3);
  });
});

describe("a longer lifetime never follows a shorter one", () => {
  it("a 1h part after the SDK's 5m system breakpoint is sent as 5m", async () => {
    const body = await sent(
      { messages: [{ role: "system", content: "sys" }, user(marked("doc", { type: "ephemeral", ttl: "1h" }))] },
      { enabled: true },
    );
    expect(body.system[0].cache_control).toEqual(EPH);
    expect(body.messages[0].content[0].cache_control).toEqual(EPH);
    expect("ttl" in body.messages[0].content[0].cache_control).toBe(false);
    // The last block is marked already, so the top-level automatic one is not added.
    expect(body.cache_control).toBeUndefined();
    expect(markers(body)).toBe(2);
  });

  it("with a 1h provider default both stay 1h", async () => {
    const body = await sent(
      { messages: [{ role: "system", content: "sys" }, user(marked("doc", { type: "ephemeral", ttl: "1h" }))] },
      { enabled: true, ttl: "1h" },
    );
    expect(body.system[0].cache_control).toEqual(EPH_1H);
    expect(body.messages[0].content[0].cache_control).toEqual(EPH_1H);
  });

  it("a caller's 1h part after the caller's 5m one is sent as 5m", async () => {
    const body = await sent({ messages: [user(marked("a"), marked("b", { type: "ephemeral", ttl: "1h" }))] });
    expect(body.messages[0].content.map((b: any) => b.cache_control)).toEqual([EPH, EPH]);
  });

  it("a raw marker in `extra` is never rewritten", async () => {
    const raw = { role: "user", content: [{ type: "text", text: "raw", cache_control: EPH_1H }] };
    const body = await sent({ messages: [{ role: "system", content: [marked("rules")] as any }, { role: "user", content: "x" }], extra: { messages: [raw] } });
    expect(body.system[0].cache_control).toEqual(EPH);
    expect(body.messages[0].content[0].cache_control).toEqual(EPH_1H);
  });
});

describe("Claude on Vertex AI sends the same breakpoints", () => {
  it("the caller's markers and the SDK's system breakpoint reach the rawPredict body", async () => {
    const bodies: any[] = [];
    const fetchImpl = (async (_url: unknown, init: any) => {
      bodies.push(JSON.parse(init.body));
      return new Response(JSON.stringify(OK), { status: 200 });
    }) as unknown as typeof fetch;
    const p = new VertexProvider({
      provider: "vertex",
      projectId: "proj",
      location: "us-east5",
      accessToken: "tok",
      fetch: fetchImpl,
      retry: { maxRetries: 0 },
      prompt_caching: { enabled: true, strategy: "static" },
    } as any);
    await p.complete({
      model: "claude-sonnet-4-6",
      messages: [{ role: "system", content: "rules" }, user(marked("doc"), plain("question"))],
    });

    const body = bodies[0];
    expect(body.model).toBeUndefined();
    expect(body.system).toEqual([{ type: "text", text: "rules", cache_control: EPH }]);
    expect(body.messages[0].content).toEqual([
      { type: "text", text: "doc", cache_control: EPH },
      { type: "text", text: "question" },
    ]);
    // strategy "static": no top-level automatic caching.
    expect(body.cache_control).toBeUndefined();
    expect(markers(body)).toBe(2);
  });
});

describe("top-level automatic caching and a marked last block", () => {
  it("is left out when the last block carries a marker of another lifetime (that is a 400)", async () => {
    const body = await sent({ messages: [user(marked("big", { type: "ephemeral", ttl: "1h" }))] }, { enabled: true });
    expect(body.cache_control).toBeUndefined();
    expect(body.messages[0].content[0].cache_control).toEqual(EPH_1H);
  });

  it("is left out when the provider default is 1h and the last block's marker is 5m", async () => {
    const body = await sent({ messages: [user(marked("big"))] }, { enabled: true, ttl: "1h" });
    expect(body.cache_control).toBeUndefined();
    expect(body.messages[0].content[0].cache_control).toEqual(EPH);
  });

  it("is still sent when the last block carries a marker of the same lifetime (a no-op there)", async () => {
    const five = await sent({ messages: [user(marked("big"))] }, { enabled: true });
    expect(five.cache_control).toEqual(EPH);
    expect(five.messages[0].content[0].cache_control).toEqual(EPH);
    const hour = await sent({ messages: [user(marked("big", { type: "ephemeral", ttl: "1h" }))] }, { enabled: true, ttl: "1h" });
    expect(hour.cache_control).toEqual(EPH_1H);
    expect(hour.messages[0].content[0].cache_control).toEqual(EPH_1H);
  });

  it("is still sent when the last block of a tool result carries a marker of the same lifetime", async () => {
    const body = await sent(
      {
        messages: [
          { role: "user", content: "go" },
          { role: "assistant", content: "", toolCalls: [{ id: "t1", name: "lookup", arguments: "{}" }] },
          { role: "tool", toolCallId: "t1", content: [marked("big result")] },
        ],
      },
      { enabled: true },
    );
    expect(body.cache_control).toEqual(EPH);
    expect(body.messages[2].content[0].content[0].cache_control).toEqual(EPH);
  });

  it("is left out when the last block of a tool result carries one of another lifetime", async () => {
    const body = await sent(
      {
        messages: [
          { role: "user", content: "go" },
          { role: "assistant", content: "", toolCalls: [{ id: "t1", name: "lookup", arguments: "{}" }] },
          { role: "tool", toolCallId: "t1", content: [marked("big result", { type: "ephemeral", ttl: "1h" })] },
        ],
      },
      { enabled: true },
    );
    expect(body.cache_control).toBeUndefined();
    expect(body.messages[2].content[0].content[0].cache_control).toEqual(EPH_1H);
  });

  it("is added when the last block is not marked, after an earlier 1h marker", async () => {
    const body = await sent({ messages: [user(marked("big", { type: "ephemeral", ttl: "1h" }), plain("question"))] }, { enabled: true });
    expect(body.cache_control).toEqual(EPH);
    expect(body.messages[0].content[0].cache_control).toEqual(EPH_1H);
  });
});
