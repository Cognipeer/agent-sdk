/**
 * Prompt-cache breakpoints in `utils/content.ts`: `cacheControlOf` reads one off a
 * part, and the helpers that rewrite the text of a message (the write-back half of
 * every text hook) must not lose it.
 */

import { describe, it, expect } from "vitest";
import { cacheControlOf, mapTextParts, replaceTextContent } from "../../../src/utils/content.js";

describe("cacheControlOf", () => {
  it("reads the unified spelling and Anthropic's", () => {
    expect(cacheControlOf({ type: "text", text: "x", cacheControl: { type: "ephemeral" } })).toEqual({ type: "ephemeral" });
    expect(cacheControlOf({ type: "text", text: "x", cache_control: { type: "ephemeral" } })).toEqual({ type: "ephemeral" });
  });

  it("keeps a 5m or 1h lifetime and drops any other", () => {
    expect(cacheControlOf({ cacheControl: { type: "ephemeral", ttl: "5m" } })).toEqual({ type: "ephemeral", ttl: "5m" });
    expect(cacheControlOf({ cacheControl: { type: "ephemeral", ttl: "1h" } })).toEqual({ type: "ephemeral", ttl: "1h" });
    expect(cacheControlOf({ cacheControl: { type: "ephemeral", ttl: "2h" } })).toEqual({ type: "ephemeral" });
    expect(cacheControlOf({ cacheControl: { type: "ephemeral", ttl: 300 } })).toEqual({ type: "ephemeral" });
  });

  it("prefers the unified spelling when a part has both", () => {
    expect(cacheControlOf({ cacheControl: { type: "ephemeral", ttl: "1h" }, cache_control: { type: "ephemeral", ttl: "5m" } })).toEqual({ type: "ephemeral", ttl: "1h" });
  });

  it("is undefined for anything that is not an ephemeral marker", () => {
    expect(cacheControlOf(undefined)).toBeUndefined();
    expect(cacheControlOf(null)).toBeUndefined();
    expect(cacheControlOf("text")).toBeUndefined();
    expect(cacheControlOf(["a"])).toBeUndefined();
    expect(cacheControlOf({})).toBeUndefined();
    expect(cacheControlOf({ cacheControl: "ephemeral" })).toBeUndefined();
    expect(cacheControlOf({ cacheControl: { type: "persistent" } })).toBeUndefined();
    expect(cacheControlOf({ cacheControl: { ttl: "1h" } })).toBeUndefined();
  });

  it("returns a fresh object: the part's own marker is never handed out", () => {
    const marker = { type: "ephemeral", ttl: "1h" };
    const read = cacheControlOf({ cacheControl: marker });
    expect(read).toEqual(marker);
    expect(read).not.toBe(marker);
  });
});

describe("a rewrite of the text keeps the breakpoint", () => {
  const marked = { type: "text", text: "doc", cacheControl: { type: "ephemeral", ttl: "1h" } };

  it("mapTextParts rewrites the text and leaves the marker (and the other parts) alone", () => {
    const image = { type: "image", source: { type: "url", url: "http://i/a.png" } };
    const out = mapTextParts([marked, image, { type: "text", text: "tail", cache_control: { type: "ephemeral" } }], (t) => t.toUpperCase()) as any[];
    expect(out[0]).toEqual({ type: "text", text: "DOC", cacheControl: { type: "ephemeral", ttl: "1h" } });
    expect(out[1]).toBe(image);
    expect(out[2]).toEqual({ type: "text", text: "TAIL", cache_control: { type: "ephemeral" } });
  });

  it("replaceTextContent with one text part keeps its marker", () => {
    const out = replaceTextContent([marked], "new text") as any[];
    expect(out).toEqual([{ type: "text", text: "new text", cacheControl: { type: "ephemeral", ttl: "1h" } }]);
  });

  it("replaceTextContent keeps a marker written the Anthropic way", () => {
    const out = replaceTextContent([{ type: "text", text: "a", cache_control: { type: "ephemeral" } }], "b") as any[];
    expect(out).toEqual([{ type: "text", text: "b", cache_control: { type: "ephemeral" } }]);
  });

  it("with several text parts the first takes the text, and the marker of a part merged away moves to it", () => {
    const out = replaceTextContent(
      [{ type: "text", text: "a" }, { type: "text", text: "b", cacheControl: { type: "ephemeral" } }, { type: "text", text: "c", cache_control: { type: "ephemeral", ttl: "1h" } }],
      "merged",
    ) as any[];
    // The last marker the dropped parts carried: it covered the longest prefix.
    expect(out).toEqual([{ type: "text", text: "merged", cacheControl: { type: "ephemeral", ttl: "1h" } }]);
  });

  it("the first part's own marker wins over the ones of the parts merged away", () => {
    const out = replaceTextContent([marked, { type: "text", text: "b", cacheControl: { type: "ephemeral" } }], "merged") as any[];
    expect(out).toEqual([{ type: "text", text: "merged", cacheControl: { type: "ephemeral", ttl: "1h" } }]);
  });

  it("a first marker that is no marker is replaced by a real one from a merged part", () => {
    const out = replaceTextContent([{ type: "text", text: "a", cacheControl: { type: "persistent" } }, { type: "text", text: "b", cacheControl: { type: "ephemeral" } }], "merged") as any[];
    expect(out).toEqual([{ type: "text", text: "merged", cacheControl: { type: "ephemeral" } }]);
  });

  it("merged parts without any marker add none", () => {
    const out = replaceTextContent([{ type: "text", text: "a" }, { type: "text", text: "b" }], "merged") as any[];
    expect(out).toEqual([{ type: "text", text: "merged" }]);
    expect(out[0]).not.toHaveProperty("cacheControl");
  });

  it("media parts keep their positions around the merged text", () => {
    const image = { type: "image", source: { type: "url", url: "http://i/a.png" } };
    const file = { type: "file", source: { type: "url", url: "http://i/a.pdf" } };
    const out = replaceTextContent([image, { type: "text", text: "a" }, file, { type: "text", text: "b", cacheControl: { type: "ephemeral" } }], "merged") as any[];
    expect(out).toHaveLength(3);
    expect(out[0]).toBe(image);
    expect(out[1]).toEqual({ type: "text", text: "merged", cacheControl: { type: "ephemeral" } });
    expect(out[2]).toBe(file);
  });

  it("does not mutate the caller's parts", () => {
    const parts = [{ type: "text", text: "a" }, { type: "text", text: "b", cacheControl: { type: "ephemeral" } }];
    const before = JSON.stringify(parts);
    replaceTextContent(parts, "merged");
    mapTextParts(parts, (t) => t + "!");
    expect(JSON.stringify(parts)).toBe(before);
  });

  it("string content and content with no text part are unchanged in behaviour", () => {
    expect(replaceTextContent("old", "new")).toBe("new");
    const image = { type: "image", source: { type: "url", url: "http://i/a.png" } };
    expect(replaceTextContent([image], "new")).toEqual([{ type: "text", text: "new" }, image]);
    expect(replaceTextContent([image], "")).toEqual([image]);
  });
});
