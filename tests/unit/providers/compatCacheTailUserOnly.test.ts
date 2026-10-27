/**
 * OpenAI-compatible `prompt_caching` (auto): the tail marker goes on the last USER
 * message only. OpenRouter and LiteLLM document `cache_control` on system and user
 * text parts, never on a tool result, so a tool result at the tail is left alone and
 * the marker stays on the user turn that opened the tool loop (which also keeps the
 * cached prefix stable while the loop grows).
 */
import { beforeEach, describe, expect, it } from "vitest";
import { OpenAICompatibleProvider, applyCacheMarkers } from "../../../src/providers/openaiCompatible.js";
import type { UnifiedMessage } from "../../../src/providers/types.js";
import { clearLearnedModelRules } from "../../../src/index.js";

beforeEach(() => clearLearnedModelRules());

const AUTO = { strategy: "auto" as const, ttl: "5m" as const };
const EPH = { type: "ephemeral" };
const OK = { id: "c", model: "m", choices: [{ message: { role: "assistant", content: "ok" }, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } };

const marked = (messages: UnifiedMessage[]): number =>
  messages.reduce((n, m) => n + (Array.isArray(m.content) ? m.content.filter((p) => p.type === "text" && p.cacheControl).length : 0), 0);

const call = (n: number): UnifiedMessage => ({ role: "assistant", content: "", toolCalls: [{ id: `c${n}`, name: "lookup", arguments: "{}" }] });
const result = (n: number, content: UnifiedMessage["content"] = `result ${n}`): UnifiedMessage => ({ role: "tool", toolCallId: `c${n}`, content });
const loop: UnifiedMessage[] = [
  { role: "system", content: "sys" },
  { role: "user", content: "look it up" },
  call(1),
  result(1),
];

describe("applyCacheMarkers, strategy auto", () => {
  it("a tool result at the tail is left alone; the marker stays on the user turn that opened the loop", () => {
    const out = applyCacheMarkers(loop, AUTO);
    expect(out[3]).toBe(loop[3]);
    expect(out[2]).toBe(loop[2]);
    expect(out[1].content).toEqual([{ type: "text", text: "look it up", cacheControl: { type: "ephemeral" } }]);
    expect(out[0].content).toEqual([{ type: "text", text: "sys", cacheControl: { type: "ephemeral" } }]);
    expect(marked(out)).toBe(2);
    // the caller's messages are never mutated
    expect(loop[1].content).toBe("look it up");
  });

  it("a tool result with several text parts stays clean", () => {
    const messages = [...loop.slice(0, 3), result(1, [{ type: "text", text: "part one" }, { type: "text", text: "part two" }])];
    const out = applyCacheMarkers(messages, AUTO);
    expect(out[3]).toBe(messages[3]);
    expect(marked(out)).toBe(2);
  });

  it("with several user messages only the last one is marked, tool results after it or not", () => {
    const messages: UnifiedMessage[] = [
      { role: "system", content: "sys" },
      { role: "user", content: "first" },
      { role: "assistant", content: "a1" },
      { role: "user", content: "second" },
      call(1),
      result(1),
      call(2),
      result(2),
    ];
    const out = applyCacheMarkers(messages, AUTO);
    expect(out[1]).toBe(messages[1]);
    expect(out[3].content).toEqual([{ type: "text", text: "second", cacheControl: { type: "ephemeral" } }]);
    for (const i of [2, 4, 5, 6, 7]) expect(out[i]).toBe(messages[i]);
    expect(marked(out)).toBe(2);
  });

  it("the last user message is the one that is tried: a user turn without text is not skipped over", () => {
    const messages: UnifiedMessage[] = [
      { role: "system", content: "sys" },
      { role: "user", content: "first" },
      { role: "assistant", content: "a1" },
      { role: "user", content: [{ type: "image", source: { type: "url", url: "http://img/a.png" } }] },
    ];
    const out = applyCacheMarkers(messages, AUTO);
    expect(out[1]).toBe(messages[1]);
    expect(out[3]).toBe(messages[3]);
    expect(marked(out)).toBe(1);
  });

  it("a conversation with no user message marks the system prompt only", () => {
    const out = applyCacheMarkers([{ role: "system", content: "sys" }, call(1), result(1)], AUTO);
    expect(marked(out)).toBe(1);
    expect(out[2]).toEqual(result(1));
  });

  it("the caller's own marker on the tail tool result stays, and counts towards the limit", () => {
    const own = result(1, [{ type: "text", text: "r", cacheControl: { type: "ephemeral", ttl: "1h" } }]);
    const messages = [...loop.slice(0, 3), own];
    const out = applyCacheMarkers(messages, AUTO);
    expect(out[3]).toBe(own);
    expect(marked(out)).toBe(3);
  });

  it("the ttl rides on the user marker", () => {
    const out = applyCacheMarkers(loop, { strategy: "auto", ttl: "1h" });
    expect(out[1].content).toEqual([{ type: "text", text: "look it up", cacheControl: { type: "ephemeral", ttl: "1h" } }]);
  });

  it("static is unaffected: the system prompt only", () => {
    const out = applyCacheMarkers(loop, { strategy: "static", ttl: "5m" });
    expect(out[1]).toBe(loop[1]);
    expect(out[3]).toBe(loop[3]);
    expect(marked(out)).toBe(1);
  });
});

describe("on the wire", () => {
  async function wire(messages: UnifiedMessage[]): Promise<any> {
    const bodies: any[] = [];
    const fn = (async (_u: any, init: any) => {
      bodies.push(JSON.parse(init.body));
      return new Response(JSON.stringify(OK), { status: 200 });
    }) as typeof fetch;
    const p = new OpenAICompatibleProvider({
      provider: "openai-compatible", apiKey: "k", baseURL: "http://x/v1", fetch: fn, retry: { maxRetries: 0 }, prompt_caching: { enabled: true },
    });
    await p.complete({ model: "anthropic/claude-sonnet-4", messages });
    return bodies[0];
  }

  it("the user turn carries cache_control; the tool result is a plain message with its id", async () => {
    const body = await wire(loop);
    expect(body.messages[0].content).toEqual([{ type: "text", text: "sys", cache_control: EPH }]);
    expect(body.messages[1].content).toEqual([{ type: "text", text: "look it up", cache_control: EPH }]);
    expect(body.messages[3]).toEqual({ role: "tool", content: "result 1", tool_call_id: "c1" });
    expect(JSON.stringify(body.messages).split("cache_control").length - 1).toBe(2);
  });

  it("the marker does not move while the tool loop grows, so the cached prefix is the same on every turn", async () => {
    const first = await wire(loop);
    const second = await wire([...loop, call(2), result(2)]);
    expect(JSON.stringify(second.messages.slice(0, 4))).toBe(JSON.stringify(first.messages));
    expect(JSON.stringify(second.messages).split("cache_control").length - 1).toBe(2);
  });
});
