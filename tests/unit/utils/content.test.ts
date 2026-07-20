import { describe, it, expect } from "vitest";
import { contentToString, mergeContentsToString, safeStringify, extractMessageText } from "../../../src/utils/content.js";

describe("utils/content", () => {
  describe("contentToString", () => {
    it("returns empty string for null/undefined", () => {
      expect(contentToString(null as any)).toBe("");
      expect(contentToString(undefined as any)).toBe("");
    });

    it("passes through plain strings", () => {
      expect(contentToString("hello")).toBe("hello");
    });

    it("joins text parts with newlines", () => {
      const parts = [{ type: "text", text: "a" }, { type: "text", text: "b" }];
      expect(contentToString(parts as any)).toBe("a\nb");
    });

    it("renders image_url parts (object and string forms)", () => {
      expect(contentToString([{ type: "image_url", image_url: { url: "http://x/i.png", detail: "high" } }] as any))
        .toBe("[image:http://x/i.png detail=high]");
      expect(contentToString([{ type: "image_url", image_url: "http://y/j.png" }] as any))
        .toBe("[image:http://y/j.png]");
    });

    it("JSON-stringifies unknown part shapes and unknown objects", () => {
      expect(contentToString([{ type: "weird", foo: 1 }] as any)).toContain("\"foo\":1");
      expect(contentToString({ a: 1 } as any)).toBe("{\"a\":1}");
    });

    it("stringifies primitive parts", () => {
      expect(contentToString([5, true] as any)).toBe("5\ntrue");
    });
  });

  describe("mergeContentsToString", () => {
    it("merges mixed contents with newlines", () => {
      expect(mergeContentsToString(["x", [{ type: "text", text: "y" }]])).toBe("x\ny");
    });
  });

  describe("safeStringify", () => {
    it("returns '' for null/undefined and passes strings through", () => {
      expect(safeStringify(null)).toBe("");
      expect(safeStringify("raw")).toBe("raw");
    });
    it("stringifies objects, pretty when asked", () => {
      expect(safeStringify({ a: 1 })).toBe("{\"a\":1}");
      expect(safeStringify({ a: 1 }, true)).toContain("\n  \"a\": 1");
    });
    it("falls back to String() on circular structures", () => {
      const circular: any = {}; circular.self = circular;
      expect(typeof safeStringify(circular)).toBe("string");
    });
  });

  describe("extractMessageText", () => {
    it("handles missing message, string content, and part arrays", () => {
      expect(extractMessageText(undefined)).toBe("");
      expect(extractMessageText({ content: "hi" })).toBe("hi");
      expect(extractMessageText({ content: [{ text: "a" }, "b", { content: "c" }] })).toBe("abc");
      expect(extractMessageText({ content: { weird: true } })).toBe("");
    });
  });
});
