/**
 * Tool results and empty text on the Messages API: the `is_error` flag, a placeholder
 * for output that is empty (the API rejects an empty text block), parts inside a result,
 * and blank text in user / assistant messages.
 */

import { describe, it, expect } from "vitest";
import { AnthropicProvider, EMPTY_MESSAGE_TEXT, EMPTY_TOOL_RESULT_TEXT } from "../../../src/providers/anthropic.js";
import type { UnifiedMessage } from "../../../src/providers/types.js";

const OK = { id: "m", model: "c", content: [{ type: "text", text: "ok" }], stop_reason: "end_turn", usage: { input_tokens: 1, output_tokens: 1 } };

/** The JSON body the provider sends for these messages. */
async function sent(messages: UnifiedMessage[]): Promise<any> {
  let body: any;
  const fetchImpl = (async (_url: unknown, init: any) => {
    body = JSON.parse(init.body);
    return new Response(JSON.stringify(OK), { status: 200 });
  }) as unknown as typeof fetch;
  const p = new AnthropicProvider({ provider: "anthropic", apiKey: "k", fetch: fetchImpl, retry: { maxRetries: 0 } });
  await p.complete({ model: "claude-sonnet-4-20250514", messages });
  return body;
}

/** A user turn, one assistant turn that called a tool per result, then the results. */
const exchange = (...results: Array<Omit<UnifiedMessage, "role"> & { toolCallId: string }>): UnifiedMessage[] => [
  { role: "user", content: "go" },
  { role: "assistant", content: "", toolCalls: results.map((r) => ({ id: r.toolCallId, name: "lookup", arguments: "{}" })) },
  ...results.map((r) => ({ role: "tool" as const, ...r })),
];

describe("placeholders", () => {
  it("are the documented strings", () => {
    expect(EMPTY_TOOL_RESULT_TEXT).toBe("(no output)");
    expect(EMPTY_MESSAGE_TEXT).toBe("(empty message)");
  });
});

describe("tool_result is_error", () => {
  it("is set on a result the host flagged, and absent otherwise", async () => {
    const body = await sent(exchange({ toolCallId: "t1", content: "boom", isError: true }, { toolCallId: "t2", content: "fine" }));
    // The assistant turn carries the two tool_use blocks and no empty text block.
    expect(body.messages[1].content.map((b: any) => b.type)).toEqual(["tool_use", "tool_use"]);
    // Both results answer that turn, in ONE user message.
    const results = body.messages[2].content;
    expect(results).toEqual([
      { type: "tool_result", tool_use_id: "t1", content: "boom", is_error: true },
      { type: "tool_result", tool_use_id: "t2", content: "fine" },
    ]);
    expect("is_error" in results[1]).toBe(false);
  });

  it("isError: false is the same as not set", async () => {
    const body = await sent(exchange({ toolCallId: "t1", content: "fine", isError: false }));
    expect("is_error" in body.messages[2].content[0]).toBe(false);
  });

  it("an error result with no output still says so", async () => {
    const body = await sent(exchange({ toolCallId: "t1", content: "", isError: true }));
    expect(body.messages[2].content[0]).toEqual({ type: "tool_result", tool_use_id: "t1", content: "(no output)", is_error: true });
  });
});

describe("tool_result content", () => {
  it.each([
    ["an empty string", ""],
    ["blank text", "  \n"],
    ["an empty parts list", []],
    ["blank text parts only", [{ type: "text", text: " " }]],
    ["no content at all", null],
  ])("%s is sent as (no output)", async (_name, content) => {
    const body = await sent(exchange({ toolCallId: "t1", content: content as any }));
    expect(body.messages[2].content[0]).toEqual({ type: "tool_result", tool_use_id: "t1", content: "(no output)" });
  });

  it("text stays the text itself", async () => {
    const body = await sent(exchange({ toolCallId: "t1", content: "  22 degrees  " }));
    expect(body.messages[2].content[0].content).toBe("  22 degrees  ");
  });

  it("parts go out as blocks: text and an image", async () => {
    const body = await sent(
      exchange({
        toolCallId: "t1",
        content: [
          { type: "text", text: "chart attached" },
          { type: "image", source: { type: "base64", mediaType: "image/png", data: "AAAA" } },
        ],
      }),
    );
    expect(body.messages[2].content[0].content).toEqual([
      { type: "text", text: "chart attached" },
      { type: "image", source: { type: "base64", media_type: "image/png", data: "AAAA" } },
    ]);
  });

  it("blank text parts are left out of the blocks", async () => {
    const body = await sent(
      exchange({
        toolCallId: "t1",
        content: [
          { type: "text", text: "" },
          { type: "text", text: "kept" },
        ],
      }),
    );
    expect(body.messages[2].content[0].content).toEqual([{ type: "text", text: "kept" }]);
  });

  it("a JSON value a host passed through goes out as its JSON text", async () => {
    const body = await sent(exchange({ toolCallId: "t1", content: { temp: 21 } as any }, { toolCallId: "t2", content: [{ a: 1 }] as any }));
    expect(body.messages[2].content[0].content).toBe('{"temp":21}');
    expect(body.messages[2].content[1].content).toBe('[{"a":1}]');
  });
});

describe("empty user and assistant text", () => {
  it("an empty user message carries the placeholder", async () => {
    const body = await sent([{ role: "user", content: "" }]);
    expect(body.messages[0]).toEqual({ role: "user", content: "(empty message)" });
  });

  it("an empty assistant message carries the placeholder", async () => {
    const body = await sent([
      { role: "user", content: "hi" },
      { role: "assistant", content: "  " },
      { role: "user", content: "again" },
    ]);
    expect(body.messages[1]).toEqual({ role: "assistant", content: "(empty message)" });
  });

  it("blank text parts are dropped and the others kept", async () => {
    const body = await sent([
      {
        role: "user",
        content: [
          { type: "text", text: "  " },
          { type: "text", text: "real" },
        ],
      },
    ]);
    expect(body.messages[0].content).toEqual([{ type: "text", text: "real" }]);
  });

  it("a message whose parts are all blank keeps one block: the placeholder", async () => {
    const body = await sent([{ role: "user", content: [{ type: "text", text: "" }] }]);
    expect(body.messages[0].content).toEqual([{ type: "text", text: "(empty message)" }]);
  });

  it("an assistant turn with only unsigned thinking (nothing to replay) carries the placeholder", async () => {
    const body = await sent([
      { role: "user", content: "hi" },
      { role: "assistant", content: "", reasoning: { blocks: [{ type: "thinking", text: "hmm" }] } },
      { role: "user", content: "again" },
    ]);
    expect(body.messages[1].content).toEqual([{ type: "text", text: "(empty message)" }]);
  });

  it("an assistant turn with signed thinking replays it and needs no placeholder", async () => {
    const body = await sent([
      { role: "user", content: "hi" },
      { role: "assistant", content: "", reasoning: { blocks: [{ type: "thinking", text: "hmm", signature: "SIG" }] } },
      { role: "user", content: "again" },
    ]);
    expect(body.messages[1].content).toEqual([{ type: "thinking", thinking: "hmm", signature: "SIG" }]);
  });
});
