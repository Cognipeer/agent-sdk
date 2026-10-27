/**
 * OpenAI-compatible provider extras: explicit prompt caching (`cache_control`
 * on Chat Completions text parts, for OpenRouter / LiteLLM routing to Claude)
 * and the opt-in `reasoning_content` replay (DeepSeek thinking mode).
 * OpenAI and Azure never get either field.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { OpenAIProvider } from "../../../src/providers/openai.js";
import { OpenAICompatibleProvider } from "../../../src/providers/openaiCompatible.js";
import { AzureProvider } from "../../../src/providers/azure.js";
import { clearLearnedModelRules } from "../../../src/models/index.js";
import type { ChatCompletionRequest, PromptCachingConfig, UnifiedMessage } from "../../../src/providers/types.js";

beforeEach(() => clearLearnedModelRules());

const OK = { id: "c", model: "m", choices: [{ message: { role: "assistant", content: "ok" }, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } };

function stub() {
  const bodies: any[] = [];
  const fetchImpl = (async (_u: any, init: any) => {
    bodies.push(JSON.parse(init.body));
    return new Response(JSON.stringify(OK), { status: 200 });
  }) as typeof fetch;
  return { bodies, fetchImpl };
}

async function compatBody(
  messages: UnifiedMessage[],
  extra: { prompt_caching?: PromptCachingConfig; replayReasoningContent?: boolean } = {},
  req: Partial<ChatCompletionRequest> = {},
): Promise<any> {
  const { bodies, fetchImpl } = stub();
  const p = new OpenAICompatibleProvider({
    provider: "openai-compatible", apiKey: "k", baseURL: "http://x/v1", fetch: fetchImpl, retry: { maxRetries: 0 }, ...extra,
  });
  await p.complete({ model: "anthropic/claude-sonnet-4", messages, ...req });
  return bodies[0];
}

const EPH = { type: "ephemeral" };
const EPH_1H = { type: "ephemeral", ttl: "1h" };
const countCC = (body: any) => JSON.stringify(body.messages).split("cache_control").length - 1;

const convo: UnifiedMessage[] = [
  { role: "system", content: "You are terse." },
  { role: "user", content: "first question" },
  { role: "assistant", content: "first answer" },
  { role: "user", content: "second question" },
];

describe("OpenAI-compatible prompt caching", () => {
  it("is off by default: strings stay strings, no cache_control", async () => {
    const body = await compatBody(convo);
    expect(body.messages).toEqual([
      { role: "system", content: "You are terse." },
      { role: "user", content: "first question" },
      { role: "assistant", content: "first answer" },
      { role: "user", content: "second question" },
    ]);
    expect(JSON.stringify(body)).not.toContain("cache_control");
  });

  it("enabled: false behaves like unset", async () => {
    const body = await compatBody(convo, { prompt_caching: { enabled: false } });
    expect(JSON.stringify(body)).not.toContain("cache_control");
  });

  it("static: marks the end of the system prompt, sent as a text part; nothing else changes", async () => {
    const body = await compatBody(convo, { prompt_caching: { enabled: true, strategy: "static" } });
    expect(body.messages[0]).toEqual({ role: "system", content: [{ type: "text", text: "You are terse.", cache_control: EPH }] });
    expect(body.messages[1].content).toBe("first question");
    expect(body.messages[3].content).toBe("second question");
    expect(countCC(body)).toBe(1);
  });

  it("auto (the default strategy): also marks the last text part of the last user message", async () => {
    const body = await compatBody(convo, { prompt_caching: { enabled: true } });
    expect(body.messages[0].content).toEqual([{ type: "text", text: "You are terse.", cache_control: EPH }]);
    expect(body.messages[1].content).toBe("first question");
    expect(body.messages[2].content).toBe("first answer");
    expect(body.messages[3].content).toEqual([{ type: "text", text: "second question", cache_control: EPH }]);
    expect(countCC(body)).toBe(2);
  });

  // Deliberate change: the auto tail marker goes on the last USER message only; a tool result stays clean.
  it("auto: a tool result at the tail is left clean; the marker stays on the user turn that opened the loop", async () => {
    const messages: UnifiedMessage[] = [
      { role: "system", content: "sys" },
      { role: "user", content: "look it up" },
      { role: "assistant", content: "", toolCalls: [{ id: "c1", name: "lookup", arguments: "{}" }] },
      { role: "tool", toolCallId: "c1", content: [{ type: "text", text: "part one" }, { type: "text", text: "part two" }] },
    ];
    const body = await compatBody(messages, { prompt_caching: { enabled: true } });
    expect(body.messages[1].content).toEqual([{ type: "text", text: "look it up", cache_control: EPH }]);
    expect(body.messages[3].content).toEqual([
      { type: "text", text: "part one" },
      { type: "text", text: "part two" },
    ]);
    expect(body.messages[3].tool_call_id).toBe("c1");
  });

  it("auto: the marker goes on the last text part even when an image follows it", async () => {
    const messages: UnifiedMessage[] = [
      { role: "user", content: [
        { type: "text", text: "what is this?" },
        { type: "image", source: { type: "url", url: "http://img/a.png" } },
      ] },
    ];
    const body = await compatBody(messages, { prompt_caching: { enabled: true } });
    expect(body.messages[0].content[0]).toEqual({ type: "text", text: "what is this?", cache_control: EPH });
    expect(body.messages[0].content[1].type).toBe("image_url");
  });

  it("ttl 1h is sent; the 5m default omits the field", async () => {
    const hour = await compatBody(convo, { prompt_caching: { enabled: true, ttl: "1h" } });
    expect(hour.messages[0].content[0].cache_control).toEqual(EPH_1H);
    expect(hour.messages[3].content[0].cache_control).toEqual(EPH_1H);
    const five = await compatBody(convo, { prompt_caching: { enabled: true, ttl: "5m" } });
    expect(five.messages[0].content[0].cache_control).toEqual(EPH);
  });

  it("static targets the last of the LEADING system messages; a later system message is left alone", async () => {
    const messages: UnifiedMessage[] = [
      { role: "system", content: "rules" },
      { role: "system", content: [{ type: "text", text: "persona a" }, { type: "text", text: "persona b" }] },
      { role: "user", content: "hi" },
      { role: "system", content: "reminder" },
    ];
    const body = await compatBody(messages, { prompt_caching: { enabled: true, strategy: "static" } });
    expect(body.messages[0].content).toBe("rules");
    expect(body.messages[1].content).toEqual([{ type: "text", text: "persona a" }, { type: "text", text: "persona b", cache_control: EPH }]);
    expect(body.messages[3].content).toBe("reminder");
    expect(countCC(body)).toBe(1);
  });

  it("no system prompt: static adds nothing, auto marks only the tail", async () => {
    const messages: UnifiedMessage[] = [{ role: "user", content: "hi" }];
    expect(countCC(await compatBody(messages, { prompt_caching: { enabled: true, strategy: "static" } }))).toBe(0);
    expect(countCC(await compatBody(messages, { prompt_caching: { enabled: true } }))).toBe(1);
  });

  it("empty text is never marked", async () => {
    const messages: UnifiedMessage[] = [{ role: "system", content: "  " }, { role: "user", content: "" }];
    expect(countCC(await compatBody(messages, { prompt_caching: { enabled: true } }))).toBe(0);
  });

  it("converts a string to a part only when a marker is added, and never mutates the caller's messages", async () => {
    const messages: UnifiedMessage[] = JSON.parse(JSON.stringify(convo));
    const before = JSON.stringify(messages);
    const body = await compatBody(messages, { prompt_caching: { enabled: true } });
    expect(JSON.stringify(messages)).toBe(before);
    const converted = body.messages.filter((m: any) => Array.isArray(m.content)).length;
    expect(converted).toBe(2);
  });

  it("caller's own cacheControl is kept and sent even with prompt_caching off", async () => {
    const messages: UnifiedMessage[] = [
      { role: "system", content: [{ type: "text", text: "big context", cacheControl: { type: "ephemeral", ttl: "1h" } }] },
      { role: "user", content: [{ type: "text", text: "q", cacheControl: { type: "ephemeral", ttl: "5m" } }] },
    ];
    const body = await compatBody(messages);
    expect(body.messages[0].content[0]).toEqual({ type: "text", text: "big context", cache_control: EPH_1H });
    // "5m" is the default lifetime: the field is left out
    expect(body.messages[1].content[0]).toEqual({ type: "text", text: "q", cache_control: EPH });
  });

  it("with prompt_caching on, a caller's marker on the system prompt is not duplicated or replaced", async () => {
    const messages: UnifiedMessage[] = [
      { role: "system", content: [{ type: "text", text: "sys", cacheControl: { type: "ephemeral", ttl: "1h" } }] },
      { role: "user", content: "q" },
    ];
    const body = await compatBody(messages, { prompt_caching: { enabled: true } });
    expect(body.messages[0].content).toEqual([{ type: "text", text: "sys", cache_control: EPH_1H }]);
    expect(body.messages[1].content).toEqual([{ type: "text", text: "q", cache_control: EPH }]);
    expect(countCC(body)).toBe(2);
  });

  it("at most 4 markers in total, the caller's included", async () => {
    const own = (text: string): UnifiedMessage => ({ role: "user", content: [{ type: "text", text, cacheControl: { type: "ephemeral" } }] });
    // 3 of the caller's: room for exactly 1 more, and the static prefix comes first
    const three: UnifiedMessage[] = [{ role: "system", content: "sys" }, own("a"), { role: "assistant", content: "x" }, own("b"), { role: "assistant", content: "y" }, own("c"), { role: "assistant", content: "z" }, { role: "user", content: "tail" }];
    const body3 = await compatBody(three, { prompt_caching: { enabled: true } });
    expect(countCC(body3)).toBe(4);
    expect(body3.messages[0].content).toEqual([{ type: "text", text: "sys", cache_control: EPH }]);
    expect(body3.messages[7].content).toBe("tail");

    // 4 of the caller's: none added
    const four: UnifiedMessage[] = [{ role: "system", content: "sys" }, own("a"), own("b"), own("c"), own("d"), { role: "user", content: "tail" }];
    const body4 = await compatBody(four, { prompt_caching: { enabled: true } });
    expect(countCC(body4)).toBe(4);
    expect(body4.messages[0].content).toBe("sys");
    expect(body4.messages[5].content).toBe("tail");

    // 5 of the caller's: all kept (we never strip), none added
    const five: UnifiedMessage[] = [{ role: "system", content: "sys" }, own("a"), own("b"), own("c"), own("d"), own("e")];
    expect(countCC(await compatBody(five, { prompt_caching: { enabled: true } }))).toBe(5);
  });

  it("never reaches the Responses API body", async () => {
    const p = new OpenAICompatibleProvider({ provider: "openai-compatible", apiKey: "k", baseURL: "http://x/v1", prompt_caching: { enabled: true } });
    const body = (p as any).buildResponsesBody({
      model: "m",
      messages: [{ role: "system", content: [{ type: "text", text: "s", cacheControl: { type: "ephemeral" } }] }, { role: "user", content: "q" }],
    });
    expect(JSON.stringify(body)).not.toContain("cache_control");
  });
});

describe("cache_control never goes to OpenAI or Azure", () => {
  const marked: UnifiedMessage[] = [
    { role: "system", content: [{ type: "text", text: "sys", cacheControl: { type: "ephemeral", ttl: "1h" } }] },
    { role: "user", content: [{ type: "text", text: "q", cacheControl: { type: "ephemeral" } }] },
  ];

  it("OpenAIProvider drops the field, keeps the text", async () => {
    const { bodies, fetchImpl } = stub();
    await new OpenAIProvider({ provider: "openai", apiKey: "k", fetch: fetchImpl, retry: { maxRetries: 0 } }).complete({ model: "gpt-4o", messages: marked });
    expect(JSON.stringify(bodies[0])).not.toContain("cache_control");
    expect(bodies[0].messages[0].content).toEqual([{ type: "text", text: "sys" }]);
    expect(bodies[0].messages[1].content).toEqual([{ type: "text", text: "q" }]);
  });

  it("AzureProvider drops the field, keeps the text", async () => {
    const { bodies, fetchImpl } = stub();
    await new AzureProvider({ provider: "azure", apiKey: "k", endpoint: "https://r.openai.azure.com", deploymentName: "d", fetch: fetchImpl, retry: { maxRetries: 0 } }).complete({ model: "gpt-4o", messages: marked });
    expect(JSON.stringify(bodies[0])).not.toContain("cache_control");
    expect(bodies[0].messages[0].content).toEqual([{ type: "text", text: "sys" }]);
  });
});

describe("OpenAI-compatible reasoning_content replay", () => {
  const loop: UnifiedMessage[] = [
    { role: "user", content: "weather in Ankara?" },
    { role: "assistant", content: "", toolCalls: [{ id: "c1", name: "weather", arguments: "{\"city\":\"Ankara\"}" }], reasoning: { summary: "I should call the weather tool." } },
    { role: "tool", toolCallId: "c1", content: "12C" },
  ];

  it("is off by default: the reasoning text is not sent", async () => {
    const body = await compatBody(loop);
    expect(body.messages[1]).not.toHaveProperty("reasoning_content");
    expect(JSON.stringify(body)).not.toContain("I should call");
  });

  it("on: assistant messages carrying reasoning text are sent with reasoning_content", async () => {
    const body = await compatBody(loop, { replayReasoningContent: true });
    expect(body.messages[1].reasoning_content).toBe("I should call the weather tool.");
    expect(body.messages[1].tool_calls).toHaveLength(1);
    expect(body.messages[0]).not.toHaveProperty("reasoning_content");
    expect(body.messages[2]).not.toHaveProperty("reasoning_content");
  });

  it("on: assistant messages without reasoning text get no field", async () => {
    const messages: UnifiedMessage[] = [
      { role: "user", content: "hi" },
      { role: "assistant", content: "hello" },
      { role: "assistant", content: "x", reasoning: { summary: "" } },
      { role: "assistant", content: "y", reasoning: { blocks: [{ type: "redacted_thinking", data: "zz" }] } },
      { role: "user", content: "again" },
    ];
    const body = await compatBody(messages, { replayReasoningContent: true });
    for (const m of body.messages) expect(m).not.toHaveProperty("reasoning_content");
  });

  it("OpenAI and Azure never send it", async () => {
    const a = stub();
    await new OpenAIProvider({ provider: "openai", apiKey: "k", fetch: a.fetchImpl }).complete({ model: "gpt-4o", messages: loop });
    expect(JSON.stringify(a.bodies[0])).not.toContain("reasoning_content");
    const b = stub();
    await new AzureProvider({ provider: "azure", apiKey: "k", endpoint: "https://r.openai.azure.com", deploymentName: "d", fetch: b.fetchImpl }).complete({ model: "gpt-4o", messages: loop });
    expect(JSON.stringify(b.bodies[0])).not.toContain("reasoning_content");
  });
});
