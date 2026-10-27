/**
 * Converse cache checkpoints, beyond the SDK's own strategy:
 *  - the caller's `cacheControl` on a text part becomes a `cachePoint` block right after
 *    that content block (system, user, assistant; after the toolResult block for a
 *    tool result, which has no cachePoint member of its own);
 *  - the system checkpoint sits after the static system prompt, and the SDK's per-turn
 *    system messages (summary, memory, plugin context, reflection) come after it;
 *  - a request never carries more than 4 checkpoints: the caller's count first and win,
 *    the SDK's own only while slots remain, and a 1h one never follows a 5m one.
 */

import { describe, it, expect } from "vitest";
import { BedrockProvider } from "../../../src/providers/bedrock.js";
import type { ChatCompletionRequest, UnifiedMessage } from "../../../src/providers/types.js";

const OK = {
  output: { message: { content: [{ text: "ok" }] } },
  stopReason: "end_turn",
  usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
};

const CLAUDE = "anthropic.claude-sonnet-4-5-20250929-v1:0";
const NOVA = "amazon.nova-pro-v1:0";
const LLAMA = "meta.llama3-70b-instruct-v1:0";

const CP = { cachePoint: { type: "default" } };
const CP_1H = { cachePoint: { type: "default", ttl: "1h" } };

const TOOLS = [
  { name: "t1", description: "a", parameters: { type: "object", properties: {}, additionalProperties: false } },
  { name: "t2", description: "b", parameters: { type: "object", properties: {}, additionalProperties: false } },
];

const marked = (text: string, cacheControl: Record<string, unknown> = { type: "ephemeral" }) => ({ type: "text" as const, text, cacheControl });
const plain = (text: string) => ({ type: "text" as const, text });
const user = (...parts: Array<ReturnType<typeof marked> | ReturnType<typeof plain>>): UnifiedMessage => ({ role: "user", content: parts as any });
const system = (content: string, name?: string): UnifiedMessage => ({ role: "system", content, ...(name ? { name } : {}) });

/** The JSON body sent for a request (one user message unless the request says otherwise). */
async function sent(request: Partial<ChatCompletionRequest>, caching?: Record<string, unknown>, model = CLAUDE): Promise<any> {
  let body: any;
  const fetchImpl = (async (_url: unknown, init: any) => {
    body = JSON.parse(init.body);
    return new Response(JSON.stringify(OK), { status: 200 });
  }) as unknown as typeof fetch;
  const p = new BedrockProvider({
    provider: "bedrock",
    region: "us-east-1",
    accessKeyId: "AK",
    secretAccessKey: "SK",
    fetch: fetchImpl,
    retry: { maxRetries: 0 },
    ...(caching ? { prompt_caching: caching } : {}),
  } as any);
  await p.complete({ model, messages: [{ role: "user", content: "hi" }], ...request });
  return body;
}

/** How many `cachePoint` blocks a request body carries, wherever they are. */
function points(node: unknown): number {
  if (Array.isArray(node)) return node.reduce((n: number, x) => n + points(x), 0);
  if (node && typeof node === "object") {
    return Object.entries(node).reduce((n, [k, v]) => n + (k === "cachePoint" ? 1 : 0) + points(v), 0);
  }
  return 0;
}

describe("the caller's cacheControl on a text part", () => {
  it("is a cachePoint right after that block, with prompt caching off", async () => {
    const body = await sent({ messages: [user(marked("big document"), plain("question"))] });
    expect(body.messages[0].content).toEqual([{ text: "big document" }, CP, { text: "question" }]);
    expect(points(body)).toBe(1);
  });

  it("ttl is sent for 1h only: 5m is the default", async () => {
    const body = await sent({ messages: [user(marked("a", { type: "ephemeral", ttl: "1h" }), marked("b", { type: "ephemeral", ttl: "5m" }))] });
    expect(body.messages[0].content).toEqual([{ text: "a" }, CP_1H, { text: "b" }, CP]);
  });

  it("Nova takes no ttl: a 1h marker is a plain checkpoint there", async () => {
    const body = await sent({ messages: [user(marked("a", { type: "ephemeral", ttl: "1h" }))] }, undefined, NOVA);
    expect(body.messages[0].content).toEqual([{ text: "a" }, CP]);
  });

  it.each([
    ["anthropic.claude-sonnet-4-5-20250929-v1:0", true],
    ["us.anthropic.claude-opus-4-6-v1", true],
    ["global.anthropic.claude-haiku-4-5-20251001-v1:0", true],
    ["anthropic.claude-sonnet-5-5-v1:0", true],
    ["eu.anthropic.claude-fable-5-1-v1:0", true],
    ["anthropic.claude-mythos-5-v1:0", true],
    ["arn:aws:bedrock:us-east-1:123456789012:inference-profile/us.anthropic.claude-opus-4-8-v1:0", true],
    ["anthropic.claude-3-7-sonnet-20250219-v1:0", false],
    ["us.anthropic.claude-3-5-sonnet-20241022-v2:0", false],
    ["anthropic.claude-opus-4-1-20250805-v1:0", false],
    ["anthropic.claude-sonnet-4-20250514-v1:0", false],
    ["amazon.nova-pro-v1:0", false],
    ["arn:aws:bedrock:us-east-1:123456789012:application-inference-profile/abc123", false],
  ])("1h ttl on %s is sent: %s (per-part and provider default)", async (model, takes) => {
    const part = await sent({ messages: [user(marked("a", { type: "ephemeral", ttl: "1h" }))] }, undefined, model);
    expect(part.messages[0].content).toEqual([{ text: "a" }, takes ? CP_1H : CP]);
    const dflt = await sent({ messages: [user(plain("a"))] }, { enabled: true, ttl: "1h" }, model);
    expect(JSON.stringify(dflt).includes('"ttl"')).toBe(takes);
  });

  it("a model without explicit caching gets none, the caller's marker included", async () => {
    const body = await sent({ messages: [user(marked("doc"), plain("question"))] }, { enabled: true }, LLAMA);
    expect(body.messages[0].content).toEqual([{ text: "doc" }, { text: "question" }]);
    expect(points(body)).toBe(0);
  });

  it("works on an assistant text part, and before the toolUse of an assistant tool turn", async () => {
    const body = await sent({
      messages: [
        { role: "user", content: "hi" },
        { role: "assistant", content: [marked("earlier answer")] },
        { role: "user", content: "go" },
        { role: "assistant", content: [marked("let me look")], toolCalls: [{ id: "t1", name: "lookup", arguments: "{}" }] },
      ],
    });
    expect(body.messages[1].content).toEqual([{ text: "earlier answer" }, CP]);
    expect(body.messages[3].content).toEqual([{ text: "let me look" }, CP, { toolUse: { toolUseId: "t1", name: "lookup", input: {} } }]);
  });

  it("cuts the system prompt after a marked part, and sends it even with prompt caching off", async () => {
    const body = await sent({ messages: [{ role: "system", content: [marked("rules"), plain("more rules")] as any }, { role: "user", content: "hi" }] });
    expect(body.system).toEqual([{ text: "rules" }, CP, { text: "more rules" }]);
  });

  it("after a tool result, the toolResult block having no cachePoint of its own", async () => {
    const body = await sent({
      messages: [
        { role: "user", content: "go" },
        { role: "assistant", content: "", toolCalls: [{ id: "t1", name: "lookup", arguments: "{}" }] },
        { role: "tool", toolCallId: "t1", content: [marked("big result")] },
      ],
    });
    expect(body.messages[2].content).toEqual([
      { toolResult: { toolUseId: "t1", content: [{ text: "big result" }], status: "success" } },
      CP,
    ]);
  });

  it("is not sent on blank text: the block is left out with it", async () => {
    const body = await sent({ messages: [user(marked("   "), plain("question"))] });
    expect(body.messages[0].content).toEqual([{ text: "question" }]);
    expect(points(body)).toBe(0);
  });
});

describe("the system checkpoint sits after the static system prompt", () => {
  it("the SDK's per-turn system messages come after it", async () => {
    const body = await sent(
      { messages: [system("static rules"), system("memory: likes tea", "memory_context"), { role: "user", content: "hi" }] },
      { enabled: true },
    );
    expect(body.system).toEqual([{ text: "static rules" }, CP, { text: "memory: likes tea" }]);
    // And the rolling checkpoint at the end of the last user message.
    expect(body.messages[0].content).toEqual([{ text: "hi" }, CP]);
  });

  it.each(["context_summary", "memory_context", "plugin_context", "agent_reflection"])("%s is a per-turn block, never cached", async (name) => {
    const body = await sent({ messages: [system("static rules"), system("changes every turn", name), { role: "user", content: "hi" }] }, { enabled: true });
    expect(body.system).toEqual([{ text: "static rules" }, CP, { text: "changes every turn" }]);
  });

  it("a system message added after the conversation began is per-turn too", async () => {
    const body = await sent({ messages: [system("rules"), { role: "user", content: "hi" }, system("Answer in French.")] }, { enabled: true });
    expect(body.system).toEqual([{ text: "rules" }, CP, { text: "Answer in French." }]);
    // Only the user message is left in `messages`.
    expect(body.messages).toHaveLength(1);
  });

  it("with no static system prompt there is nothing to checkpoint in `system`", async () => {
    const body = await sent({ messages: [system("summary so far", "context_summary"), { role: "user", content: "hi" }] }, { enabled: true });
    expect(body.system).toEqual([{ text: "summary so far" }]);
  });

  it("with prompt caching off the system blocks carry no checkpoint, in their order", async () => {
    const body = await sent({ messages: [system("static rules"), system("memory: likes tea", "memory_context"), { role: "user", content: "hi" }] });
    expect(body.system).toEqual([{ text: "static rules" }, { text: "memory: likes tea" }]);
    expect(points(body)).toBe(0);
  });
});

describe("at most 4 checkpoints", () => {
  it("5 of the caller's: the earliest is dropped and the SDK adds none", async () => {
    const body = await sent(
      {
        messages: [system("sys"), user(marked("a"), marked("b"), marked("c"), marked("d"), marked("e"))],
        tools: TOOLS,
      },
      { enabled: true },
    );
    const shape = body.messages[0].content.map((b: any) => ("cachePoint" in b ? "|" : b.text)).join("");
    expect(shape).toBe("ab|c|d|e|");
    expect(body.system).toEqual([{ text: "sys" }]);
    expect(body.toolConfig.tools).toHaveLength(2);
    expect(points(body)).toBe(4);
  });

  it("3 of the caller's: the SDK gets the one slot left, in order system, tools, rolling tail", async () => {
    const body = await sent(
      { messages: [system("sys"), user(marked("a"), marked("b"), marked("c"))], tools: TOOLS },
      { enabled: true },
    );
    expect(body.system).toEqual([{ text: "sys" }, CP]);
    expect(body.toolConfig.tools).toHaveLength(2);
    expect(points(body)).toBe(4);
  });

  it("the SDK's own checkpoints still fill an empty budget: system, tools, rolling tail", async () => {
    const body = await sent({ messages: [system("sys"), { role: "user", content: "hi" }], tools: TOOLS }, { enabled: true });
    expect(body.system).toEqual([{ text: "sys" }, CP]);
    expect(body.toolConfig.tools).toHaveLength(3);
    expect(body.toolConfig.tools[2]).toEqual(CP);
    expect(body.messages[0].content).toEqual([{ text: "hi" }, CP]);
    expect(points(body)).toBe(3);
  });

  it("a cachePoint in a raw `extra.system` counts, and is never touched", async () => {
    const raw = [{ text: "raw" }, CP_1H];
    const body = await sent({ extra: { system: raw } }, { enabled: true });
    expect(body.system).toEqual([{ text: "raw" }, CP_1H]);
    // The SDK adds nothing to a block list it did not build, only its rolling checkpoint.
    expect(body.messages[0].content).toEqual([{ text: "hi" }, CP]);
    expect(points(body)).toBe(2);
  });
});

describe("a longer lifetime never follows a shorter one", () => {
  it("a 1h part after the SDK's 5m system checkpoint is sent as 5m", async () => {
    const body = await sent({ messages: [system("sys"), user(marked("doc", { type: "ephemeral", ttl: "1h" }))] }, { enabled: true });
    expect(body.system).toEqual([{ text: "sys" }, CP]);
    expect(body.messages[0].content).toEqual([{ text: "doc" }, CP]);
    expect(points(body)).toBe(2);
  });

  it("with a 1h provider default both stay 1h", async () => {
    const body = await sent(
      { messages: [system("sys"), user(marked("doc", { type: "ephemeral", ttl: "1h" }))] },
      { enabled: true, ttl: "1h" },
    );
    expect(body.system).toEqual([{ text: "sys" }, CP_1H]);
    expect(body.messages[0].content).toEqual([{ text: "doc" }, CP_1H]);
  });

  it("a caller's 1h part after the caller's 5m one is sent as 5m", async () => {
    const body = await sent({ messages: [user(marked("a"), marked("b", { type: "ephemeral", ttl: "1h" }))] });
    expect(body.messages[0].content).toEqual([{ text: "a" }, CP, { text: "b" }, CP]);
  });

  it("a raw checkpoint in `extra` is never rewritten", async () => {
    const rawMessages = [{ role: "user", content: [{ text: "raw" }, CP_1H] }];
    const body = await sent({ messages: [{ role: "system", content: [marked("rules")] as any }, { role: "user", content: "x" }], extra: { messages: rawMessages } });
    expect(body.system).toEqual([{ text: "rules" }, CP]);
    expect(body.messages[0].content).toEqual([{ text: "raw" }, CP_1H]);
  });
});
