/**
 * An attachment is not text. Anything that flattens a message to a string —
 * the token estimate, the summarizer's input, the trace display — used to fall
 * back to `JSON.stringify(part)` for a part it did not recognise, which writes
 * the whole base64 payload into the text: a ~400-token photo counted as ~18,000
 * tokens and tripped needless compaction, the summarizer read a wall of base64
 * (truncated to nothing useful) instead of learning a picture existed, and the
 * trace UI showed the same wall. They now use a short placeholder, and the
 * trace sections additionally carry the structured parts so a host can draw
 * the thumbnail.
 */
import { describe, expect, it } from "vitest";
import {
  contentPartToText,
  contentToString,
  describeContentPart,
  hasMediaPart,
  mediaKindOf,
} from "../../src/utils/content.js";
import { countMessagesTokens, defaultTokenCounter } from "../../src/utils/utilTokens.js";
import { createContextSummarizeNode } from "../../src/nodes/contextSummarize.js";
import { buildPromptSections, formatMessageContent, buildAssistantMessageSection } from "../../src/utils/traceSections.js";
import { createAgent } from "../../src/agent.js";
import { customSink } from "../../src/utils/tracing.js";

/** ~1 MB of base64: stringified, this is what the old code put into the text. */
const BASE64 = "QUJD".repeat(250_000);
const DATA_URL = `data:image/png;base64,${BASE64}`;

const imageUrlPart = (extra: Record<string, unknown> = {}) => ({ type: "image_url", image_url: { url: DATA_URL }, ...extra });

describe("describeContentPart", () => {
  it("names an image by its own name first, then its file id, then its media type", () => {
    expect(describeContentPart(imageUrlPart({ name: "photo.png", fileId: "file_1" }))).toBe("[image: photo.png]");
    expect(describeContentPart(imageUrlPart({ fileId: "file_1" }))).toBe("[image: file_1]");
    expect(describeContentPart(imageUrlPart())).toBe("[image: image/png]");
  });

  it("reads the media type from every shape an image arrives in", () => {
    expect(describeContentPart({ type: "image_url", image_url: { base64: "AAAA", media_type: "image/webp" } })).toBe("[image: image/webp]");
    expect(describeContentPart({ type: "image", source: { type: "base64", mediaType: "image/jpeg", data: "AAAA" } })).toBe("[image: image/jpeg]");
    expect(describeContentPart({ type: "image", source: { type: "base64", media_type: "image/gif", data: "AAAA" } })).toBe("[image: image/gif]");
    expect(describeContentPart({ type: "input_image", image_url: DATA_URL })).toBe("[image: image/png]");
    expect(describeContentPart({ inlineData: { mimeType: "image/png", data: "AAAA" } })).toBe("[image: image/png]");
  });

  it("covers audio, video and files with their own kind", () => {
    expect(describeContentPart({ type: "audio", source: { type: "base64", mediaType: "audio/wav", data: "AAAA" } })).toBe("[audio: audio/wav]");
    expect(describeContentPart({ type: "input_audio", input_audio: { data: "AAAA", format: "mp3" } })).toBe("[audio: audio/mp3]");
    expect(describeContentPart({ type: "video", source: { type: "url", url: "https://x.test/clip.mp4" } })).toBe("[video: clip.mp4]");
    expect(describeContentPart({ type: "file", source: { type: "base64", mediaType: "application/pdf", data: "AAAA" }, fileName: "report.pdf" })).toBe("[file: report.pdf]");
    expect(describeContentPart({ type: "file", file: { filename: "sheet.xlsx", file_data: "AAAA" } })).toBe("[file: sheet.xlsx]");
    expect(describeContentPart({ type: "input_file", file_id: "file_9" })).toBe("[file: file_9]");
    expect(describeContentPart({ inlineData: { mimeType: "application/pdf", data: "AAAA" } })).toBe("[file: application/pdf]");
  });

  it("names a stored-file reference by its id, and a URL by its file name without the query", () => {
    expect(describeContentPart({ type: "image_url", image_url: { url: "session-file://file_abc123" } })).toBe("[image: file_abc123]");
    expect(describeContentPart({ type: "image_url", image_url: { url: "https://cdn.test/a/b/cat.png?sig=SECRET" } })).toBe("[image: cat.png]");
  });

  it("is just the kind when nothing can be named, and flattens a long or multi-line label", () => {
    expect(describeContentPart({ type: "image_url", image_url: {} })).toBe("[image]");
    expect(describeContentPart({ type: "image", name: "a\nb]c" })).toBe("[image: a b c]");
    expect(describeContentPart({ type: "image", name: "x".repeat(500) })!.length).toBeLessThan(100);
  });

  it("is undefined for text, strings and anything that is not a media part", () => {
    expect(describeContentPart({ type: "text", text: "hi" })).toBeUndefined();
    expect(describeContentPart("hi")).toBeUndefined();
    expect(describeContentPart(null)).toBeUndefined();
    expect(describeContentPart({ type: "tool_use", id: "t", name: "x", input: {} })).toBeUndefined();
    expect(describeContentPart({ type: "weird", foo: 1 })).toBeUndefined();
    expect(mediaKindOf({ type: "text", text: "hi" })).toBeUndefined();
  });

  it("hasMediaPart tells a text-only array from one with an attachment", () => {
    expect(hasMediaPart("text")).toBe(false);
    expect(hasMediaPart([{ type: "text", text: "a" }])).toBe(false);
    expect(hasMediaPart([{ type: "text", text: "a" }, imageUrlPart()])).toBe(true);
  });
});

describe("contentPartToText / contentToString", () => {
  it("renders an attachment as its placeholder and everything else as before", () => {
    expect(contentPartToText("plain")).toBe("plain");
    expect(contentPartToText({ type: "text", text: "t" })).toBe("t");
    expect(contentPartToText(imageUrlPart({ name: "photo.png" }))).toBe("[image: photo.png]");
    expect(contentPartToText({ type: "weird", foo: 1 })).toBe("{\"type\":\"weird\",\"foo\":1}");
    expect(contentPartToText({ type: "weird", foo: 1 }, () => "custom")).toBe("custom");
  });

  it("contentToString no longer inlines a data URL, but still shows a remote URL", () => {
    const text = contentToString([{ type: "text", text: "look" }, imageUrlPart({ name: "photo.png" })]);
    expect(text).toBe("look\n[image: photo.png]");
    expect(text.length).toBeLessThan(100);
    expect(contentToString([{ type: "image_url", image_url: { url: "http://x/i.png", detail: "high" } }])).toBe("[image:http://x/i.png detail=high]");
    expect(contentToString([{ type: "image", source: { type: "base64", mediaType: "image/png", data: BASE64 } }])).toBe("[image: image/png]");
  });
});

describe("token estimation", () => {
  const withImage = (part: Record<string, unknown>) => [
    { role: "user", content: [{ type: "text", text: "What is in this photo?" }, part] },
  ];

  it("does not count the payload of an image", () => {
    const tokens = countMessagesTokens(withImage(imageUrlPart({ name: "photo.png" })));
    expect(tokens).toBeLessThan(40);
  });

  it("is the same for a tiny image and a huge one", () => {
    const tiny = countMessagesTokens(withImage({ type: "image_url", image_url: { url: "data:image/png;base64,QUJD" } }));
    const huge = countMessagesTokens(withImage(imageUrlPart()));
    expect(huge).toBe(tiny);
  });

  it("covers the unified image shape, audio and files too", () => {
    for (const part of [
      { type: "image", source: { type: "base64", mediaType: "image/png", data: BASE64 } },
      { type: "audio", source: { type: "base64", mediaType: "audio/wav", data: BASE64 } },
      { type: "file", source: { type: "base64", mediaType: "application/pdf", data: BASE64 }, fileName: "r.pdf" },
      { type: "image_url", image_url: { base64: BASE64, media_type: "image/png" } },
    ]) {
      expect(countMessagesTokens(withImage(part))).toBeLessThan(50);
    }
  });

  it("counts the placeholder, nothing more", () => {
    const placeholder = "[image: photo.png]";
    const counted = countMessagesTokens(withImage(imageUrlPart({ name: "photo.png" })));
    const asText = countMessagesTokens([{ role: "user", content: ["What is in this photo?", placeholder].join("\n") }]);
    expect(counted).toBe(asText + 0);
    expect(defaultTokenCounter(placeholder)).toBeGreaterThan(0);
  });

  it("still counts tool_use blocks and unknown parts by their JSON (those are real tokens)", () => {
    const tokens = countMessagesTokens([
      { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "search", input: { q: "x".repeat(400) } }] },
    ]);
    expect(tokens).toBeGreaterThan(90);
  });
});

describe("summarizer input", () => {
  function summarizerWith(captured: string[]) {
    return createContextSummarizeNode({
      summarization: true,
      model: {
        async invoke(messages: any[]) {
          captured.push(messages.map((m) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content))).join("\n"));
          return { role: "assistant", content: JSON.stringify({ stable_facts: [], active_goals: [], open_questions: [], discarded_obsolete: [], rawSummary: "ok" }) };
        },
      },
    } as any);
  }

  const baseState = (userContent: unknown): any => ({
    messages: [
      { role: "user", content: userContent },
      { role: "assistant", content: "calling", tool_calls: [{ id: "c1", type: "function", function: { name: "t", arguments: "{}" } }] },
      { role: "tool", name: "t", tool_call_id: "c1", content: "RESULT ONE" },
      { role: "assistant", content: "calling again", tool_calls: [{ id: "c2", type: "function", function: { name: "t", arguments: "{}" } }] },
      { role: "tool", name: "t", tool_call_id: "c2", content: "RESULT TWO" },
    ],
    summaries: [],
    summaryRecords: [],
    ctx: {},
  });

  it("tells the summarizer a picture was there, without the picture", async () => {
    const captured: string[] = [];
    const delta = await summarizerWith(captured)(baseState([
      { type: "text", text: "Compare these three documents with the attached photo" },
      imageUrlPart({ name: "photo.png" }),
    ]));
    expect(delta.messages).toBeDefined();
    expect(captured).toHaveLength(1);
    expect(captured[0]).toContain("Compare these three documents with the attached photo");
    expect(captured[0]).toContain("[image: photo.png]");
    // None of the payload, and nothing shaped like the old JSON dump.
    expect(captured[0]).not.toContain("QUJDQUJD");
    expect(captured[0]).not.toContain("image_url");
    expect(captured[0].length).toBeLessThan(5_000);
  });

  it("keeps the budget for the conversation: a huge image does not crowd the text out", async () => {
    const captured: string[] = [];
    await summarizerWith(captured)(baseState([
      imageUrlPart(),
      { type: "text", text: "the question that matters" },
    ]));
    expect(captured[0]).toContain("the question that matters");
  });

  it("still flattens ordinary parts the way it did", async () => {
    const captured: string[] = [];
    await summarizerWith(captured)(baseState([{ type: "text", text: "alpha" }, { type: "text", text: "beta" }]));
    expect(captured[0]).toContain("USER: alpha beta");
  });
});

describe("trace sections", () => {
  const userWithImage = {
    role: "user",
    content: [{ type: "text", text: "what is this?" }, imageUrlPart({ name: "photo.png" })],
  };

  it("formatMessageContent / buildPromptSections show the placeholder and carry the structured parts", () => {
    expect(formatMessageContent(userWithImage.content)).toBe("what is this?\n[image: photo.png]");
    const [section] = buildPromptSections([userWithImage]) as any[];
    expect(section.content).toBe("what is this?\n[image: photo.png]");
    expect(section.parts).toHaveLength(2);
    expect(section.parts[0]).toEqual({ type: "text", text: "what is this?" });
    expect(section.parts[1]).toMatchObject({ type: "image_url", name: "photo.png" });
    expect(section.parts[1].image_url.url).toBe(DATA_URL);
  });

  it("a text-only message gets no parts field at all", () => {
    const [plain] = buildPromptSections([{ role: "user", content: "hello" }]) as any[];
    expect("parts" in plain).toBe(false);
    const [arr] = buildPromptSections([{ role: "user", content: [{ type: "text", text: "hello" }] }]) as any[];
    expect("parts" in arr).toBe(false);
    expect("parts" in buildAssistantMessageSection({ content: "answer" })!).toBe(false);
  });

  it("the sections an agent emits for a multimodal turn name the image and carry its parts", async () => {
    const events: any[] = [];
    const agent = createAgent({
      name: "Vision",
      model: { modelName: "m", async invoke() { return { role: "assistant", content: "a cat" }; } } as any,
      tracing: { enabled: true, logData: true, sink: customSink((e) => events.push(e)) },
    });
    await agent.invoke({ messages: [userWithImage as any] } as any);

    const aiCall = events.find((e) => e.type === "ai_call" && String(e.label).startsWith("Assistant Response"));
    expect(aiCall).toBeDefined();
    const sections: any[] = aiCall.data?.sections ?? [];
    const userSection = sections.find((s) => s.kind === "message" && s.role === "user");
    expect(userSection).toBeDefined();

    // The string field stays, readable, and small.
    expect(userSection.content).toBe("what is this?\n[image: photo.png]");
    expect(JSON.stringify(userSection.content)).not.toContain("QUJDQUJD");

    // The structured parts ride along for a host that wants a thumbnail.
    expect(userSection.parts.map((p: any) => p.type)).toEqual(["text", "image_url"]);
    expect(userSection.parts[1].name).toBe("photo.png");
    expect(userSection.parts[1].image_url.url).toBe(DATA_URL);

    // The assistant's plain answer carries no parts.
    const assistantSection = sections.find((s) => s.kind === "message" && s.role === "assistant");
    expect(assistantSection.content).toBe("a cat");
    expect("parts" in assistantSection).toBe(false);
  });

  it("an image with no other text still produces a readable, non-empty section", async () => {
    const events: any[] = [];
    const agent = createAgent({
      name: "VisionOnly",
      model: { modelName: "m", async invoke() { return { role: "assistant", content: "ok" }; } } as any,
      tracing: { enabled: true, logData: true, sink: customSink((e) => events.push(e)) },
    });
    await agent.invoke({ messages: [{ role: "user", content: [imageUrlPart({ fileId: "file_7" })] }] } as any);
    const aiCall = events.find((e) => e.type === "ai_call" && String(e.label).startsWith("Assistant Response"));
    const userSection = (aiCall.data.sections as any[]).find((s) => s.role === "user");
    expect(userSection.content).toBe("[image: file_7]");
    expect(userSection.parts).toHaveLength(1);
  });
});
