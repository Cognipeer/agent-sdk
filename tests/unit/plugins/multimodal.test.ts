/**
 * Multimodal input through the hook layer.
 *
 * A user turn is not always a string. When it carries an image, an audio clip
 * or a file alongside its text, every hook that rewrites "the text" has to put
 * the text back where it came from and leave the rest of the parts exactly as
 * they were. Getting this wrong is silent: the run still answers, it just
 * answers without the picture.
 */

import { describe, it, expect, vi } from "vitest";
import { createAgent } from "../../../src/agent.js";
import { defineHook } from "../../../src/plugins/define.js";
import { piiRedaction } from "../../../src/plugins/builtin/piiRedaction.js";
import { collectAttachments, mapTextParts } from "../../../src/utils/content.js";
import type { ContentPart, Message } from "../../../src/types.js";

const IMAGE_PART: ContentPart = {
  type: "image",
  source: { type: "base64", mediaType: "image/png", data: "aGVsbG8td29ybGQtcG5n" },
} as ContentPart;

const AUDIO_PART: ContentPart = {
  type: "audio",
  source: { type: "url", url: "https://example.com/clip.mp3", mediaType: "audio/mpeg" },
} as ContentPart;

const LEGACY_IMAGE_PART: ContentPart = {
  type: "image_url",
  image_url: { url: "https://example.com/photo.jpg", detail: "high" },
} as ContentPart;

function capturingModel(wire: Message[][]) {
  return {
    modelName: "mm-model",
    bindTools() {
      return this;
    },
    async invoke(messages: Message[]) {
      wire.push(messages.map((m) => ({ ...m })));
      return { role: "assistant", content: "described" };
    },
  } as any;
}

describe("content helpers", () => {
  it("rewrites only text parts and leaves media untouched", () => {
    const content: ContentPart[] = [
      { type: "text", text: "look at this" },
      IMAGE_PART,
      { type: "text", text: "and this" },
    ];

    const mapped = mapTextParts(content, (text) => text.toUpperCase());

    expect(mapped).toEqual([
      { type: "text", text: "LOOK AT THIS" },
      IMAGE_PART,
      { type: "text", text: "AND THIS" },
    ]);
    // The media part must be the same value, not a rebuilt lookalike.
    expect((mapped as ContentPart[])[1]).toBe(IMAGE_PART);
  });

  it("applies to a plain string content unchanged in shape", () => {
    expect(mapTextParts("hello", (t) => `${t}!`)).toBe("hello!");
  });

  it("normalizes both the unified and the legacy image shapes", () => {
    const attachments = collectAttachments([
      { type: "text", text: "hi" },
      IMAGE_PART,
      AUDIO_PART,
      LEGACY_IMAGE_PART,
    ]);

    expect(attachments).toHaveLength(3);
    expect(attachments[0]).toMatchObject({ kind: "image", mediaType: "image/png", sourceType: "base64" });
    expect(attachments[0].approxBytes).toBeGreaterThan(0);
    expect(attachments[1]).toMatchObject({
      kind: "audio",
      sourceType: "url",
      url: "https://example.com/clip.mp3",
    });
    expect(attachments[2]).toMatchObject({ kind: "image", sourceType: "url" });
  });

  it("reports nothing for text-only content", () => {
    expect(collectAttachments("just text")).toEqual([]);
    expect(collectAttachments([{ type: "text", text: "a" }])).toEqual([]);
  });
});

describe("hooks on a multimodal user turn", () => {
  it("keeps the image when a hook rewrites the text", async () => {
    const wire: Message[][] = [];
    const agent = createAgent({
      model: capturingModel(wire),
      plugins: [
        defineHook("userPromptSubmit", ({ text }) => ({ text: text.replace("secret", "[redacted]") }), {
          name: "redactor",
        }),
      ],
    });

    await agent.invoke({
      messages: [{ role: "user", content: [{ type: "text", text: "my secret note" }, IMAGE_PART] }],
    });

    const sent = wire[0][wire[0].length - 1];
    expect(Array.isArray(sent.content)).toBe(true);
    const parts = sent.content as ContentPart[];
    // The rewrite must not collapse a multi-part message into a bare string.
    expect(parts.some((p) => (p as any).type === "image")).toBe(true);
    expect(parts.find((p) => (p as any).type === "text")).toMatchObject({
      text: "my [redacted] note",
    });
  });

  it("gives the hook the parts and the attachments, not just the joined text", async () => {
    const seen: Array<{ text: string; attachmentKinds: string[]; hasContent: boolean }> = [];
    const agent = createAgent({
      model: capturingModel([]),
      plugins: [
        defineHook(
          "userPromptSubmit",
          ({ text, content, attachments }) => {
            seen.push({
              text,
              attachmentKinds: attachments.map((a) => a.kind),
              hasContent: Array.isArray(content),
            });
            return undefined;
          },
          { name: "inspector" },
        ),
      ],
    });

    await agent.invoke({
      messages: [
        { role: "user", content: [{ type: "text", text: "transcribe" }, AUDIO_PART, IMAGE_PART] },
      ],
    });

    expect(seen).toHaveLength(1);
    expect(seen[0].text).toBe("transcribe");
    expect(seen[0].attachmentKinds).toEqual(["audio", "image"]);
    expect(seen[0].hasContent).toBe(true);
  });

  it("lets a hook replace the whole content when it needs full control", async () => {
    const wire: Message[][] = [];
    const agent = createAgent({
      model: capturingModel(wire),
      plugins: [
        defineHook(
          "userPromptSubmit",
          ({ content }) => ({
            content: (content as ContentPart[]).filter((p) => (p as any).type !== "image"),
          }),
          { name: "image-stripper" },
        ),
      ],
    });

    await agent.invoke({
      messages: [{ role: "user", content: [{ type: "text", text: "ignore the picture" }, IMAGE_PART] }],
    });

    const parts = wire[0][wire[0].length - 1].content as ContentPart[];
    expect(parts.some((p) => (p as any).type === "image")).toBe(false);
    expect(parts).toHaveLength(1);
  });

  it("redacts PII across text parts without disturbing the attachments", async () => {
    const wire: Message[][] = [];
    const agent = createAgent({
      model: capturingModel(wire),
      plugins: [piiRedaction({ entities: ["EMAIL"] })],
    });

    await agent.invoke({
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "write to ada@example.com" },
            IMAGE_PART,
            { type: "text", text: "or to grace@example.com" },
          ],
        },
      ],
    });

    const parts = wire[0][wire[0].length - 1].content as ContentPart[];
    const texts = parts.filter((p) => (p as any).type === "text").map((p) => (p as any).text);
    expect(texts).toEqual(["write to [REDACTED:EMAIL]", "or to [REDACTED:EMAIL]"]);
    expect(parts.filter((p) => (p as any).type === "image")).toHaveLength(1);
    // Order must survive: the image sat between the two text parts.
    expect((parts[1] as any).type).toBe("image");
  });

  it("does not judge a media-only turn as empty text", async () => {
    const calls: string[] = [];
    const agent = createAgent({
      model: capturingModel([]),
      plugins: [
        defineHook(
          "userPromptSubmit",
          ({ text, attachments }) => {
            calls.push(`${JSON.stringify(text)}|${attachments.length}`);
            return undefined;
          },
          { name: "inspector" },
        ),
      ],
    });

    await agent.invoke({ messages: [{ role: "user", content: [IMAGE_PART] }] });

    // A picture with no caption still has to reach the hook, or a media policy
    // could never see the one turn that is nothing but media.
    expect(calls).toEqual(['""|1']);
  });
});

describe("mediaPolicy", () => {
  it("denies a turn whose attachment exceeds the size cap", async () => {
    const { mediaPolicy } = await import("../../../src/plugins/builtin/mediaPolicy.js");
    const func = vi.fn();
    const agent = createAgent({
      model: capturingModel([]),
      plugins: [mediaPolicy({ maxBytesPerAttachment: 4 })],
    });

    const result = await agent.invoke({
      messages: [{ role: "user", content: [{ type: "text", text: "look" }, IMAGE_PART] }],
    });

    expect(func).not.toHaveBeenCalled();
    expect(result.content).toMatch(/too large|size/i);
  });

  it("blocks a media kind that is not allowed", async () => {
    const { mediaPolicy } = await import("../../../src/plugins/builtin/mediaPolicy.js");
    const agent = createAgent({
      model: capturingModel([]),
      plugins: [mediaPolicy({ allow: ["image"] })],
    });

    const result = await agent.invoke({
      messages: [{ role: "user", content: [{ type: "text", text: "listen" }, AUDIO_PART] }],
    });

    expect(result.content).toMatch(/audio/i);
  });

  it("strips disallowed attachments instead of refusing when asked to", async () => {
    const { mediaPolicy } = await import("../../../src/plugins/builtin/mediaPolicy.js");
    const wire: Message[][] = [];
    const agent = createAgent({
      model: capturingModel(wire),
      plugins: [mediaPolicy({ allow: ["image"], action: "strip" })],
    });

    await agent.invoke({
      messages: [{ role: "user", content: [{ type: "text", text: "both" }, AUDIO_PART, IMAGE_PART] }],
    });

    const parts = wire[0][wire[0].length - 1].content as ContentPart[];
    expect(parts.some((p) => (p as any).type === "audio")).toBe(false);
    expect(parts.some((p) => (p as any).type === "image")).toBe(true);
  });

  it("allows a plain text turn through untouched", async () => {
    const { mediaPolicy } = await import("../../../src/plugins/builtin/mediaPolicy.js");
    const wire: Message[][] = [];
    const agent = createAgent({
      model: capturingModel(wire),
      plugins: [mediaPolicy({ allow: ["image"], maxAttachments: 1 })],
    });

    const result = await agent.invoke({ messages: [{ role: "user", content: "no media here" }] });

    expect(result.content).toBe("described");
    expect(wire[0][wire[0].length - 1].content).toBe("no media here");
  });
});
