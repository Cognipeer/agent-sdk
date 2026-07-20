/**
 * ContextPilot unit tests: relevance scoring, CCR store, dedup tracker,
 * cache alignment detection, JSON/text/diff/log/search compressors, and the
 * top-level pipeline orchestrator (compressToolOutput).
 */

import { describe, it, expect } from "vitest";
import {
  tokenize,
  scoreItemsByRelevance,
  selectTopIndicesInOrder,
} from "../../../src/smart/contextPilot/relevance.js";
import { CCRStore } from "../../../src/smart/contextPilot/ccrStore.js";
import { DedupTracker } from "../../../src/smart/contextPilot/dedup.js";
import { detectVolatileContent } from "../../../src/smart/contextPilot/cacheAligner.js";
import { compressJsonOutput } from "../../../src/smart/contextPilot/jsonCrusher.js";
import { compressTextOutput } from "../../../src/smart/contextPilot/textCrusher.js";
import {
  compressDiffOutput,
  compressLogOutput,
  compressSearchOutput,
  detectTextFormat,
} from "../../../src/smart/contextPilot/formatCompressors.js";
import {
  compressToolOutput,
  createContextPilotRuntime,
  extractLatestUserQuery,
} from "../../../src/smart/contextPilot/pipeline.js";
import type { ResolvedContextPilotConfig } from "../../../src/smart/contextPilot/types.js";

function fullConfig(overrides: Partial<ResolvedContextPilotConfig> = {}): ResolvedContextPilotConfig {
  return {
    enabled: true,
    compression: {
      json: { enabled: true, targetRatio: 0.3, minItems: 10 },
      text: { enabled: true, targetRatio: 0.5, minChars: 200 },
      diff: { enabled: true, contextLines: 2 },
      log: { enabled: true, maxLines: 10 },
      search: { enabled: true, maxMatches: 10 },
    },
    ccr: { enabled: true, ttlMs: 30 * 60 * 1000, maxEntries: 500 },
    cacheAlignment: { enabled: true, warnOnVolatilePrompt: true },
    dedup: { enabled: true, minChars: 50 },
    excludeTools: [],
    ...overrides,
  };
}

describe("ContextPilot / relevance", () => {
  it("tokenizes and filters stopwords/short tokens", () => {
    const tokens = tokenize("The quick brown fox jumps over a lazy dog");
    expect(tokens).not.toContain("the");
    expect(tokens).not.toContain("a");
    expect(tokens).toContain("quick");
    expect(tokens).toContain("brown");
  });

  it("scores documents higher when they match the query terms", () => {
    const docs = [
      "invoice payment processing error for user 42",
      "unrelated weather forecast for tomorrow",
      "payment invoice failed due to insufficient funds",
    ];
    const scores = scoreItemsByRelevance(docs, "invoice payment error");
    expect(scores[0]).toBeGreaterThan(scores[1]);
    expect(scores[2]).toBeGreaterThan(scores[1]);
  });

  it("returns neutral scores when the query is empty", () => {
    const scores = scoreItemsByRelevance(["a b c", "d e f"], "");
    expect(scores).toEqual([1, 1]);
  });

  it("selects the top-N indices while preserving original order", () => {
    const scores = [0.1, 0.9, 0.5, 0.8, 0.2];
    const top3 = selectTopIndicesInOrder(scores, 3);
    expect(top3).toEqual([1, 2, 3]); // indices of the 3 highest scores, sorted ascending
  });
});

describe("ContextPilot / CCRStore", () => {
  it("stores and retrieves a value by its hash", () => {
    const store = new CCRStore();
    const hash = store.store({ foo: "bar" });
    expect(store.retrieve(hash)).toEqual({ foo: "bar" });
    expect(store.has(hash)).toBe(true);
  });

  it("returns undefined for unknown hashes", () => {
    const store = new CCRStore();
    expect(store.retrieve("deadbeef00000000")).toBeUndefined();
  });

  it("expires entries after their TTL", async () => {
    const store = new CCRStore({ ttlMs: 5 });
    const hash = store.store("expiring value");
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(store.retrieve(hash)).toBeUndefined();
  });

  it("evicts the oldest entry once maxEntries is exceeded", () => {
    const store = new CCRStore({ maxEntries: 2 });
    const h1 = store.store("one");
    store.store("two");
    store.store("three");
    expect(store.size).toBe(2);
    expect(store.retrieve(h1)).toBeUndefined();
  });
});

describe("ContextPilot / DedupTracker", () => {
  it("returns undefined the first time content is seen, and the original entry afterwards", () => {
    const tracker = new DedupTracker();
    const first = tracker.checkAndRegister("identical payload", "exec-1", "search");
    expect(first).toBeUndefined();
    const second = tracker.checkAndRegister("identical payload", "exec-2", "search");
    expect(second).toEqual({ executionId: "exec-1", toolName: "search" });
  });

  it("treats different content as distinct", () => {
    const tracker = new DedupTracker();
    tracker.checkAndRegister("payload A", "exec-1", "search");
    const result = tracker.checkAndRegister("payload B", "exec-2", "search");
    expect(result).toBeUndefined();
  });
});

describe("ContextPilot / cacheAligner", () => {
  it("detects UUIDs, ISO8601 timestamps, and JWTs", () => {
    const text = [
      "request-id: 123e4567-e89b-12d3-a456-426614174000",
      "timestamp: 2024-01-15T10:30:00Z",
      "token: eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U",
    ].join("\n");
    const findings = detectVolatileContent(text);
    const patterns = findings.map((f) => f.pattern);
    expect(patterns).toContain("uuid");
    expect(patterns).toContain("iso8601");
    expect(patterns).toContain("jwt");
  });

  it("returns no findings for stable text", () => {
    const findings = detectVolatileContent("You are a helpful assistant that answers questions concisely.");
    expect(findings).toEqual([]);
  });
});

describe("ContextPilot / jsonCrusher", () => {
  it("compresses a large array to the top-relevance items and keeps them recoverable via CCR", () => {
    const store = new CCRStore();
    const items = Array.from({ length: 30 }, (_, i) => ({
      id: i,
      text: i === 5 ? "critical invoice payment error" : `filler record number ${i}`,
    }));
    const result = compressJsonOutput(items, "invoice payment error", { enabled: true, targetRatio: 0.2, minItems: 10 }, store);
    expect(result.applied).toBe(true);
    expect(result.compressorUsed).toBe("jsonCrusher");
    expect(result.droppedItems).toBeGreaterThan(0);
    expect(result.ccrHash).toBeDefined();

    const recovered = store.retrieve(result.ccrHash!);
    expect(recovered).toEqual(items);

    const outputArray = result.output as any[];
    const relevantItemStillPresent = outputArray.some((item: any) => item?.text?.includes("critical invoice"));
    expect(relevantItemStillPresent).toBe(true);
  });

  it("does not compress arrays below minItems", () => {
    const store = new CCRStore();
    const items = [{ id: 1 }, { id: 2 }];
    const result = compressJsonOutput(items, "query", { enabled: true, targetRatio: 0.2, minItems: 10 }, store);
    expect(result.applied).toBe(false);
    expect(result.output).toBe(items);
  });

  it("compresses the dominant array field of an object payload", () => {
    const store = new CCRStore();
    const payload = {
      meta: { total: 25 },
      results: Array.from({ length: 25 }, (_, i) => ({ id: i, snippet: `result ${i}` })),
    };
    const result = compressJsonOutput(payload, "result", { enabled: true, targetRatio: 0.2, minItems: 10 }, store);
    expect(result.applied).toBe(true);
    expect((result.output as any).meta).toEqual({ total: 25 });
    expect(Array.isArray((result.output as any).results)).toBe(true);
  });
});

describe("ContextPilot / textCrusher", () => {
  it("compresses long text by keeping the most relevant sentences", () => {
    const store = new CCRStore();
    const sentences = Array.from({ length: 20 }, (_, i) =>
      i === 10 ? "The payment gateway returned a critical authorization error." : `This is filler sentence number ${i}.`
    );
    const text = sentences.join(" ");
    const result = compressTextOutput(text, "payment authorization error", { enabled: true, targetRatio: 0.3, minChars: 50 }, store);
    expect(result.applied).toBe(true);
    expect(result.compressorUsed).toBe("textCrusher");
    expect(typeof result.output).toBe("string");
    expect((result.output as string)).toContain("authorization error");
    expect(result.ccrHash).toBeDefined();
    expect(store.retrieve(result.ccrHash!)).toBe(text);
  });

  it("skips short text below minChars", () => {
    const store = new CCRStore();
    const text = "Too short to compress.";
    const result = compressTextOutput(text, "query", { enabled: true, targetRatio: 0.3, minChars: 200 }, store);
    expect(result.applied).toBe(false);
    expect(result.output).toBe(text);
  });
});

describe("ContextPilot / formatCompressors", () => {
  it("detects diff, log, search, and plain text formats", () => {
    const diff = "diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1,3 +1,3 @@\n-old\n+new\n context";
    const log = Array.from({ length: 20 }, (_, i) => `[INFO] step ${i} completed`).join("\n") + "\n[ERROR] failure occurred";
    const search = "src/foo.ts:12:  const bar = baz();\nsrc/foo.ts:13:  return bar;";
    expect(detectTextFormat(diff)).toBe("diff");
    expect(detectTextFormat(log)).toBe("log");
    expect(detectTextFormat(search)).toBe("search");
    expect(detectTextFormat("just some plain prose about nothing in particular")).toBe("text");
  });

  it("compressDiffOutput trims unchanged context lines beyond the configured window", () => {
    const store = new CCRStore();
    const lines = [
      "diff --git a/file.ts b/file.ts",
      "--- a/file.ts",
      "+++ b/file.ts",
      "@@ -1,40 +1,40 @@",
      ...Array.from({ length: 40 }, (_, i) => ` unchanged line number ${i} with some extra padding text`),
      "-removed line",
      "+added line",
    ];
    const result = compressDiffOutput(lines.join("\n"), { enabled: true, contextLines: 2 }, store);
    expect(result.applied).toBe(true);
    expect(result.compressorUsed).toBe("diffCompressor");
    expect((result.output as string)).toContain("+added line");
  });

  it("compressLogOutput keeps error/warning lines and trims low-priority ones", () => {
    const store = new CCRStore();
    const lines = ["START", ...Array.from({ length: 30 }, (_, i) => `[DEBUG] trace step ${i}`), "[ERROR] critical failure", "END"];
    const result = compressLogOutput(lines.join("\n"), { enabled: true, maxLines: 10 }, store);
    expect(result.applied).toBe(true);
    expect((result.output as string)).toContain("[ERROR] critical failure");
    expect((result.output as string)).toContain("START");
    expect((result.output as string)).toContain("END");
  });

  it("compressSearchOutput caps matches per file for diversity", () => {
    const store = new CCRStore();
    const lines: string[] = [];
    for (let i = 0; i < 20; i += 1) lines.push(`src/noisy.ts:${i}: match`);
    for (let i = 0; i < 5; i += 1) lines.push(`src/other.ts:${i}: match`);
    const result = compressSearchOutput(lines.join("\n"), { enabled: true, maxMatches: 10 }, store);
    expect(result.applied).toBe(true);
    const outputText = result.output as string;
    expect(outputText).toContain("src/other.ts");
  });
});

describe("ContextPilot / pipeline", () => {
  it("compressToolOutput routes JSON payloads through jsonCrusher", () => {
    const config = fullConfig();
    const runtime = createContextPilotRuntime(config);
    const output = Array.from({ length: 20 }, (_, i) => ({ id: i, text: `record ${i}` }));
    const result = compressToolOutput({ toolName: "search_tool", output, query: "record", executionId: "exec-1", config, runtime });
    expect(result.compressorUsed).toBe("jsonCrusher");
  });

  it("respects excludeTools and disabled config", () => {
    const config = fullConfig({ excludeTools: ["critical_tool"] });
    const runtime = createContextPilotRuntime(config);
    const output = Array.from({ length: 20 }, (_, i) => ({ id: i }));
    const result = compressToolOutput({ toolName: "critical_tool", output, query: "", executionId: "exec-1", config, runtime });
    expect(result.applied).toBe(false);

    const disabledConfig = fullConfig({ enabled: false });
    const runtime2 = createContextPilotRuntime(disabledConfig);
    const result2 = compressToolOutput({ toolName: "any_tool", output, query: "", executionId: "exec-2", config: disabledConfig, runtime: runtime2 });
    expect(result2.applied).toBe(false);
  });

  it("flags cross-turn duplicate tool outputs with a pointer instead of full content", () => {
    const config = fullConfig();
    const runtime = createContextPilotRuntime(config);
    // Long enough to clear dedup.minChars (50) but short enough to stay under
    // compression.text.minChars (200) and non-repetitive so textCrusher's own
    // sentence-level dedup doesn't kick in — isolates the cross-turn dedup path.
    const uniqueText = "This is a unique non-repeating tool response about warehouse inventory levels.";
    const first = compressToolOutput({ toolName: "fetch_url", output: uniqueText, query: "", executionId: "exec-1", config, runtime });
    expect(first.applied).toBe(false); // first occurrence, no dup yet, too short for text compression

    const second = compressToolOutput({ toolName: "fetch_url", output: uniqueText, query: "", executionId: "exec-2", config, runtime });
    expect(second.applied).toBe(true);
    expect(second.duplicateOf).toBe("exec-1");
    expect(second.output).toContain("DUPLICATE_TOOL_RESPONSE");
  });

  it("extractLatestUserQuery returns the most recent user message text", () => {
    const messages = [
      { role: "system", content: "sys" },
      { role: "user", content: "first question" },
      { role: "assistant", content: "answer" },
      { role: "user", content: "second question" },
    ] as any;
    expect(extractLatestUserQuery(messages)).toBe("second question");
  });
});
