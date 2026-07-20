import { describe, it, expect } from "vitest";
import {
  summarizeToolOutput,
  extractToolItems,
  formatMessageContent,
  buildPromptSections,
  extractToolCalls,
  buildAssistantMessageSection,
  buildLastUserMessageSections,
  buildToolCallTurnSections,
  buildFinalAgentSections,
  buildAssistantResponseSections,
  buildSummarizationSections,
} from "../../../src/utils/traceSections.js";

describe("utils/traceSections", () => {
  describe("summarizeToolOutput", () => {
    it("handles null, strings, arrays (with overflow), and objects", () => {
      expect(summarizeToolOutput(null)).toBe("");
      expect(summarizeToolOutput("  hi  ")).toBe("hi");
      const arr = summarizeToolOutput([1, 2, 3, 4, 5]);
      expect(arr).toContain("1. 1");
      expect(arr).toContain("+2 more");
      expect(summarizeToolOutput({ items: ["a"] })).toContain("a");
      expect(summarizeToolOutput({ k: "v" })).toContain("\"k\":\"v\"");
    });

    it("truncates long strings with an ellipsis", () => {
      const long = "x".repeat(600);
      expect(summarizeToolOutput(long).endsWith("…")).toBe(true);
    });
  });

  describe("extractToolItems", () => {
    it("returns undefined for non-list output", () => {
      expect(extractToolItems({ foo: 1 })).toBeUndefined();
    });
    it("maps array items to {title,url,snippet}, capped at 5", () => {
      const items = extractToolItems([
        { title: "T1", url: "http://u", content: "body" },
        "plain",
        { description: "d" },
        {}, {}, {}, {},
      ]);
      expect(items).toHaveLength(5);
      expect(items![0]).toMatchObject({ title: "T1", url: "http://u" });
      expect(items![1].snippet).toContain("plain");
    });
    it("reads items from output.items", () => {
      expect(extractToolItems({ items: [{ snippet: "s" }] })).toHaveLength(1);
    });
  });

  describe("formatMessageContent", () => {
    it("handles strings, part arrays, objects, and primitives", () => {
      expect(formatMessageContent(null)).toBe("");
      expect(formatMessageContent("s")).toBe("s");
      expect(formatMessageContent([{ text: "a" }, "b", { content: "c" }])).toBe("a\nb\nc");
      expect(formatMessageContent({ text: "t" })).toBe("t");
      expect(formatMessageContent({ a: 1 })).toContain("\"a\": 1");
      expect(formatMessageContent(7 as any)).toBe("7");
    });
  });

  describe("buildPromptSections", () => {
    it("labels messages by role with numbering after the first", () => {
      const sections = buildPromptSections([
        { role: "system", content: "sys" },
        { role: "user", content: "u1" },
        { role: "user", content: "u2", name: "alice" },
      ]);
      expect(sections.map((s: any) => s.label)).toEqual(["System Message", "User Message", "User Message #2"]);
      expect((sections[2] as any).metadata).toEqual({ name: "alice" });
    });
    it("returns [] for non-arrays", () => {
      expect(buildPromptSections(null as any)).toEqual([]);
    });
  });

  describe("extractToolCalls", () => {
    it("reads tool_calls, additional_kwargs, and function_call", () => {
      const calls = extractToolCalls({
        tool_calls: [{ id: "1", name: "search", arguments: JSON.stringify({ q: "x" }) }],
        function_call: { name: "legacy", arguments: "{}" },
      });
      expect(calls.map((c) => c.tool)).toContain("search");
      expect(calls.map((c) => c.tool)).toContain("legacy");
      expect(calls[0].arguments).toEqual({ q: "x" });
    });
    it("derives a tool name from function.name and falls back to index", () => {
      const calls = extractToolCalls({ tool_calls: [{ function: { name: "fx", arguments: "{}" } }, {}] });
      expect(calls[0].tool).toBe("fx");
      expect(calls[1].tool).toBe("tool_2");
    });
  });

  describe("buildAssistantMessageSection / buildAssistantResponseSections", () => {
    it("returns null for empty content and a section otherwise", () => {
      expect(buildAssistantMessageSection({ content: "" })).toBeNull();
      const s = buildAssistantMessageSection({ content: "answer" }, { label: "AI" });
      expect(s).toMatchObject({ kind: "message", role: "assistant", label: "AI", content: "answer" });
    });
    it("combines assistant content + tool calls", () => {
      const sections = buildAssistantResponseSections({ content: "hi", tool_calls: [{ name: "t", arguments: "{}" }] });
      expect(sections.some((s: any) => s.kind === "message")).toBe(true);
      expect(sections.some((s: any) => s.kind === "tool_call")).toBe(true);
      expect(buildAssistantResponseSections(null)).toEqual([]);
    });
  });

  describe("buildLastUserMessageSections / turn sections", () => {
    it("picks the last user message", () => {
      const sections = buildLastUserMessageSections([
        { role: "user", content: "first" },
        { role: "assistant", content: "a" },
        { role: "user", content: "last" },
      ]);
      expect((sections[0] as any).content).toBe("last");
    });

    it("buildToolCallTurnSections returns [] without tool calls and includes them when present", () => {
      expect(buildToolCallTurnSections([{ role: "user", content: "u" }], { content: "no tools" })).toEqual([]);
      const sections = buildToolCallTurnSections(
        [{ role: "user", content: "u" }],
        { tool_calls: [{ name: "search", arguments: "{}" }] },
      );
      expect(sections.some((s: any) => s.kind === "tool_call")).toBe(true);
    });

    it("buildFinalAgentSections assembles user + tool calls + responses + assistant", () => {
      const messages = [
        { role: "user", content: "do it" },
        { role: "assistant", content: "", tool_calls: [{ id: "c1", name: "search", arguments: JSON.stringify({ q: "x" }) }] },
        { role: "tool", name: "search", tool_call_id: "c1", content: JSON.stringify({ items: [{ title: "R", url: "http://r" }] }) },
      ];
      const sections = buildFinalAgentSections(messages, { content: "final answer" });
      const kinds = sections.map((s: any) => s.kind);
      expect(kinds).toContain("tool_call");
      expect(kinds).toContain("tool_response");
      expect(kinds).toContain("message");
      expect(buildFinalAgentSections([{ role: "user", content: "x" }], { content: "y" })).toEqual([]);
    });
  });

  describe("buildSummarizationSections", () => {
    it("produces summary + metadata (+ optional prompt) sections with reduction stats", () => {
      const sections = buildSummarizationSections({
        summaryText: "compact",
        previousSummary: "older",
        messagesCompressed: 4,
        tokenCountBefore: 1000,
        tokenCountAfter: 250,
        inputTokens: 10,
        durationMs: 5,
        promptMessages: [{ role: "system", content: "prompt" }],
      });
      const summary = sections.find((s: any) => s.kind === "summary") as any;
      const meta = sections.find((s: any) => s.kind === "metadata") as any;
      expect(summary.content).toBe("compact");
      expect(meta.data.tokensSaved).toBe(750);
      expect(meta.data.reductionPercent).toBe(75);
      expect(meta.data.previousSummaryLength).toBe(5);
      expect(sections.some((s: any) => s.kind === "message")).toBe(true);
    });
  });
});
