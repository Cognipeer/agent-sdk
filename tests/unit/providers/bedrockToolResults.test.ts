/**
 * Converse tool results and empty text:
 *  - `toolResult.status` is "error" when the host flagged the result;
 *  - images and documents in a result are Converse blocks, a JSON object is a `json`
 *    block, and anything else goes out as text;
 *  - output that is empty is sent as a placeholder, and blank text blocks (rejected by
 *    Converse) are dropped while a message always keeps at least one block.
 */

import { describe, it, expect } from "vitest";
import { BedrockProvider } from "../../../src/providers/bedrock.js";
import type { UnifiedMessage } from "../../../src/providers/types.js";

const OK = {
  output: { message: { content: [{ text: "ok" }] } },
  stopReason: "end_turn",
  usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
};

const CLAUDE = "anthropic.claude-sonnet-4-20250514-v1:0";
const LLAMA = "meta.llama3-70b-instruct-v1:0";

/** The JSON body the provider sends for these messages. */
async function sent(messages: UnifiedMessage[], model = CLAUDE): Promise<any> {
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
  });
  await p.complete({ model, messages });
  return body;
}

/** A user turn, one assistant turn that called a tool per result, then the results. */
const exchange = (...results: Array<Omit<UnifiedMessage, "role"> & { toolCallId: string }>): UnifiedMessage[] => [
  { role: "user", content: "go" },
  { role: "assistant", content: "", toolCalls: results.map((r) => ({ id: r.toolCallId, name: "lookup", arguments: "{}" })) },
  ...results.map((r) => ({ role: "tool" as const, ...r })),
];

const resultContent = (body: any, index = 0) => body.messages[2].content[index].toolResult.content;

describe("toolResult.status", () => {
  it("is error for a result the host flagged and success otherwise, in one user message", async () => {
    const body = await sent(exchange({ toolCallId: "t1", content: "boom", isError: true }, { toolCallId: "t2", content: "fine" }));
    // The assistant turn carries the two toolUse blocks and no empty text block.
    expect(body.messages[1]).toEqual({
      role: "assistant",
      content: [
        { toolUse: { toolUseId: "t1", name: "lookup", input: {} } },
        { toolUse: { toolUseId: "t2", name: "lookup", input: {} } },
      ],
    });
    expect(body.messages[2].content).toEqual([
      { toolResult: { toolUseId: "t1", content: [{ text: "boom" }], status: "error" } },
      { toolResult: { toolUseId: "t2", content: [{ text: "fine" }], status: "success" } },
    ]);
  });

  it("isError: false is the same as not set", async () => {
    const body = await sent(exchange({ toolCallId: "t1", content: "fine", isError: false }));
    expect(body.messages[2].content[0].toolResult.status).toBe("success");
  });
});

describe("toolResult content", () => {
  it.each([
    ["an empty string", ""],
    ["blank text", "  \n"],
    ["an empty parts list", []],
    ["blank text parts only", [{ type: "text", text: " " }]],
    ["no content at all", null],
  ])("%s is sent as (no output)", async (_name, content) => {
    const body = await sent(exchange({ toolCallId: "t1", content: content as any }));
    expect(resultContent(body)).toEqual([{ text: "(no output)" }]);
  });

  it("text stays the text itself", async () => {
    const body = await sent(exchange({ toolCallId: "t1", content: "  22 degrees  " }));
    expect(resultContent(body)).toEqual([{ text: "  22 degrees  " }]);
  });

  it("images and documents go out as Converse blocks, in order", async () => {
    const body = await sent(
      exchange({
        toolCallId: "t1",
        content: [
          { type: "text", text: "chart attached" },
          { type: "image", source: { type: "base64", mediaType: "image/jpeg", data: "AAAA" } },
          { type: "file", source: { type: "base64", mediaType: "application/pdf", data: "JVBER" }, fileName: "report.pdf" },
        ],
      }),
    );
    expect(resultContent(body)).toEqual([
      { text: "chart attached" },
      { image: { format: "jpeg", source: { bytes: "AAAA" } } },
      { document: { format: "pdf", name: "report", source: { bytes: "JVBER" } } },
    ]);
  });

  it("an image by URL has no Converse form: a visible reference is kept instead", async () => {
    const body = await sent(exchange({ toolCallId: "t1", content: [{ type: "image", source: { type: "url", url: "https://x.test/a.png" } }] }));
    expect(resultContent(body)).toEqual([{ text: "[image: https://x.test/a.png]" }]);
  });

  it("a model that takes no image in a tool result gets a note instead of a block", async () => {
    const body = await sent(
      exchange({
        toolCallId: "t1",
        content: [
          { type: "text", text: "see" },
          { type: "image", source: { type: "base64", mediaType: "image/png", data: "AAAA" } },
        ],
      }),
      LLAMA,
    );
    expect(resultContent(body)).toEqual([
      { text: "see" },
      { text: "[image attachment omitted: not supported in tool results by this model]" },
    ]);
  });

  it("a JSON object a host passed through is one json block", async () => {
    const body = await sent(exchange({ toolCallId: "t1", content: { city: "Paris", temp: 21, nested: { ok: true }, dropped: undefined } as any }));
    expect(resultContent(body)).toEqual([{ json: { city: "Paris", temp: 21, nested: { ok: true } } }]);
  });

  it("an array or a scalar is text: Converse takes only a JSON object in a json block", async () => {
    const body = await sent(
      exchange(
        { toolCallId: "t1", content: [1, 2, 3] as any },
        { toolCallId: "t2", content: [{ a: 1 }] as any },
        { toolCallId: "t3", content: 42 as any },
        { toolCallId: "t4", content: true as any },
      ),
    );
    expect(resultContent(body, 0)).toEqual([{ text: "[1,2,3]" }]);
    expect(resultContent(body, 1)).toEqual([{ text: '[{"a":1}]' }]);
    expect(resultContent(body, 2)).toEqual([{ text: "42" }]);
    expect(resultContent(body, 3)).toEqual([{ text: "true" }]);
  });
});

describe("empty user and assistant text", () => {
  it("an empty user message carries the placeholder", async () => {
    const body = await sent([{ role: "user", content: "" }]);
    expect(body.messages[0]).toEqual({ role: "user", content: [{ text: "(empty message)" }] });
  });

  it("an empty assistant message carries the placeholder", async () => {
    const body = await sent([
      { role: "user", content: "hi" },
      { role: "assistant", content: "  " },
      { role: "user", content: "again" },
    ]);
    expect(body.messages[1]).toEqual({ role: "assistant", content: [{ text: "(empty message)" }] });
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
    expect(body.messages[0].content).toEqual([{ text: "real" }]);
  });

  it("a message whose parts are all blank keeps one block: the placeholder", async () => {
    const body = await sent([{ role: "user", content: [{ type: "text", text: "" }] }]);
    expect(body.messages[0].content).toEqual([{ text: "(empty message)" }]);
  });

  it("a user message with only a URL image keeps a visible reference rather than nothing", async () => {
    const body = await sent([{ role: "user", content: [{ type: "image", source: { type: "url", url: "https://x.test/a.png" } }] }]);
    expect(body.messages[0].content).toEqual([{ text: "[image: https://x.test/a.png]" }]);
  });

  it("an assistant turn that called a tool needs no text block", async () => {
    const body = await sent(exchange({ toolCallId: "t1", content: "ok" }));
    expect(body.messages[1].content).toHaveLength(1);
    expect(body.messages[1].content[0]).toHaveProperty("toolUse");
  });

  it("non-blank text is sent as it is, untrimmed", async () => {
    const body = await sent([{ role: "user", content: "  hello  " }]);
    expect(body.messages[0].content).toEqual([{ text: "  hello  " }]);
  });
});
