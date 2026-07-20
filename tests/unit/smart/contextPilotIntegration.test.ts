/**
 * ContextPilot end-to-end integration test: exercises the real wiring
 * through createSmartAgent -> tools node -> toolHistory, using only default
 * ContextPilot configuration (nothing explicitly enabled by the caller).
 */

import { describe, it, expect } from "vitest";
import { createSmartAgent, createTool } from "../../../src/index.js";
import { z } from "zod";
import type { Message } from "../../../src/types.js";

function buildLargeSearchResults(): Array<{ id: number; title: string }> {
  return Array.from({ length: 25 }, (_, i) => ({
    id: i,
    title: i === 12 ? "target-widget-42 exact match" : `unrelated filler product ${i}`,
  }));
}

type DeterministicModel = {
  modelName: string;
  bindTools: () => DeterministicModel;
  invoke: (messages: Message[]) => Promise<Message>;
};

function createDeterministicModel(): DeterministicModel {
  let turn = 0;
  const model: DeterministicModel = {
    modelName: "deterministic-context-pilot-model",
    bindTools() {
      return model;
    },
    async invoke(): Promise<Message> {
      turn += 1;
      if (turn === 1) {
        return {
          role: "assistant",
          content: "",
          tool_calls: [{
            id: "call_search",
            type: "function",
            name: "search_items",
            args: { query: "target-widget-42" },
            function: { name: "search_items", arguments: JSON.stringify({ query: "target-widget-42" }) },
          }],
        };
      }
      return { role: "assistant", content: "Found target-widget-42." };
    },
  };
  return model;
}

describe("ContextPilot end-to-end wiring", () => {
  it("compresses a large tool output by default and keeps it recoverable via the CCR store", async () => {
    const searchItems = createTool({
      name: "search_items",
      description: "Search a large product catalog.",
      schema: z.object({ query: z.string() }),
      func: async () => buildLargeSearchResults(),
    });

    const model = createDeterministicModel();
    const agent = createSmartAgent({
      name: "ContextPilotAgent",
      model,
      tools: [searchItems],
      limits: { maxToolCalls: 4 },
    });

    const result = await agent.invoke({
      messages: [{ role: "user", content: "Find target-widget-42 in the catalog." }],
    });

    const toolHistory = result.state?.toolHistory || [];
    expect(toolHistory.length).toBe(1);
    const entry = toolHistory[0];

    expect(entry.contextPilot?.applied).toBe(true);
    expect(entry.contextPilot?.compressorUsed).toBe("jsonCrusher");
    expect(Array.isArray(entry.rawOutput)).toBe(true);
    expect((entry.rawOutput as any[]).length).toBe(25);
    expect(Array.isArray(entry.output)).toBe(true);
    expect((entry.output as any[]).length).toBeLessThan(25);

    // The relevant item (matching the user's query) should survive compression.
    const compressedHasTarget = (entry.output as any[]).some((item: any) => item?.title?.includes("target-widget-42"));
    expect(compressedHasTarget).toBe(true);

    // The dropped items must remain fully recoverable via the CCR store.
    const ccrHash = entry.contextPilot?.ccrHash;
    expect(ccrHash).toBeTruthy();
    const ccrStore = (result.state?.ctx as any)?.__contextPilot?.ccrStore;
    expect(ccrStore).toBeTruthy();
    const recovered = ccrStore.retrieve(ccrHash);
    expect(recovered).toEqual(entry.rawOutput);
  });

  it("can be disabled entirely via contextPilot: { enabled: false }", async () => {
    const searchItems = createTool({
      name: "search_items",
      description: "Search a large product catalog.",
      schema: z.object({ query: z.string() }),
      func: async () => buildLargeSearchResults(),
    });

    const model = createDeterministicModel();
    const agent = createSmartAgent({
      name: "ContextPilotDisabledAgent",
      model,
      tools: [searchItems],
      limits: { maxToolCalls: 4 },
      contextPilot: { enabled: false },
    });

    const result = await agent.invoke({
      messages: [{ role: "user", content: "Find target-widget-42 in the catalog." }],
    });

    const entry = (result.state?.toolHistory || [])[0];
    expect(entry.contextPilot).toBeUndefined();
    expect((entry.output as any[]).length).toBe(25);
  });
});

function extractCcrHash(content: unknown): string | undefined {
  const text = typeof content === "string" ? content : JSON.stringify(content ?? "");
  // The marker embeds `executionId="<hash>"`, but once the marker itself is
  // JSON-stringified as part of a tool response, those quotes are escaped
  // (`executionId=\"<hash>\"`) — allow an optional backslash before the quote.
  const match = /executionId=\\?"([a-f0-9]+)/.exec(text);
  return match?.[1];
}

describe("ContextPilot / recovery via the real get_tool_response tool", () => {
  it("lets the model recover the full dropped array through an actual get_tool_response tool call in a follow-up turn", async () => {
    // Note: the get_tool_response tool is only bound onto the model's tool
    // set once a recovery marker is already present in the *incoming*
    // message history (see syncRuntimeTools/hasToolResponseRecoveryReference
    // in src/smart/index.ts) — it cannot be called within the very same
    // reasoning turn that produced the compressed output. This mirrors real
    // usage: recovery happens in a follow-up agent.invoke() call once the
    // compressed marker is already visible in the conversation transcript.
    const searchItems = createTool({
      name: "search_items",
      description: "Search a large product catalog.",
      schema: z.object({ query: z.string() }),
      func: async () => buildLargeSearchResults(),
    });

    type Phase = "await_search_call" | "await_final_after_search" | "await_recovery_call" | "await_final_after_recovery";
    let phase: Phase = "await_search_call";
    const model: DeterministicModel = {
      modelName: "deterministic-two-phase-recovery-model",
      bindTools() {
        return model;
      },
      async invoke(messages: Message[]): Promise<Message> {
        if (phase === "await_search_call") {
          phase = "await_final_after_search";
          return {
            role: "assistant",
            content: "",
            tool_calls: [{
              id: "call_search",
              type: "function",
              name: "search_items",
              args: { query: "target-widget-42" },
              function: { name: "search_items", arguments: JSON.stringify({ query: "target-widget-42" }) },
            }],
          };
        }
        if (phase === "await_final_after_search") {
          phase = "await_recovery_call";
          return { role: "assistant", content: "Here are the top matching items (list may be partial)." };
        }
        if (phase === "await_recovery_call") {
          const lastSearchToolMessage = [...messages].reverse().find((m: any) => m.role === "tool" && m.name === "search_items");
          const ccrHash = extractCcrHash((lastSearchToolMessage as any)?.content);
          expect(ccrHash).toBeTruthy();
          phase = "await_final_after_recovery";
          return {
            role: "assistant",
            content: "",
            tool_calls: [{
              id: "call_recover",
              type: "function",
              name: "get_tool_response",
              args: { executionId: ccrHash },
              function: { name: "get_tool_response", arguments: JSON.stringify({ executionId: ccrHash }) },
            }],
          };
        }
        return { role: "assistant", content: "Recovered the full result set." };
      },
    };

    const agent = createSmartAgent({
      name: "ContextPilotRecoveryAgent",
      model,
      tools: [searchItems],
      limits: { maxToolCalls: 4 },
    });

    const firstResult = await agent.invoke({
      messages: [{ role: "user", content: "Find target-widget-42 in the catalog." }],
    });

    const searchEntry = (firstResult.state?.toolHistory || []).find((t: any) => t.toolName === "search_items");
    expect(searchEntry?.contextPilot?.applied).toBe(true);
    expect((searchEntry.output as any[]).length).toBeLessThan(25);

    const secondResult = await agent.invoke({
      messages: [
        ...firstResult.messages,
        { role: "user", content: "Actually, I need the full unfiltered list. Please retrieve it." },
      ],
      toolHistory: firstResult.state?.toolHistory,
      toolHistoryArchived: firstResult.state?.toolHistoryArchived,
      ctx: firstResult.state?.ctx,
    } as any);

    const toolHistory = secondResult.state?.toolHistory || [];
    const recoveryEntry = toolHistory.find((t: any) => t.toolName === "get_tool_response");

    expect(recoveryEntry).toBeTruthy();
    expect(recoveryEntry.args.executionId).toBe(searchEntry.contextPilot.ccrHash);
    // The recovered payload must be the full, uncompressed original array.
    expect(recoveryEntry.output).toEqual(searchEntry.rawOutput);
    expect((recoveryEntry.output as any[]).length).toBe(25);

    expect(secondResult.content).toContain("Recovered the full result set.");
  });
});

describe("ContextPilot / text compressor", () => {
  it("extractively compresses a long plain-text tool output, keeping the query-relevant sentence", async () => {
    const fillerSentences = Array.from(
      { length: 30 },
      (_, i) => `Filler observation number ${i} about unrelated routine warehouse activity.`,
    );
    fillerSentences.splice(15, 0, "The critical finding is report-alpha-99 shows a temperature breach.");
    const longText = fillerSentences.join(" ");

    const fetchReport = createTool({
      name: "fetch_report",
      description: "Fetch a long free-text report.",
      schema: z.object({ topic: z.string() }),
      func: async () => longText,
    });

    let turn = 0;
    const model: DeterministicModel = {
      modelName: "deterministic-text-model",
      bindTools() {
        return model;
      },
      async invoke(): Promise<Message> {
        turn += 1;
        if (turn === 1) {
          return {
            role: "assistant",
            content: "",
            tool_calls: [{
              id: "call_report",
              type: "function",
              name: "fetch_report",
              args: { topic: "temperature breach" },
              function: { name: "fetch_report", arguments: JSON.stringify({ topic: "temperature breach" }) },
            }],
          };
        }
        return { role: "assistant", content: "Found the temperature breach report." };
      },
    };

    const agent = createSmartAgent({
      name: "ContextPilotTextAgent",
      model,
      tools: [fetchReport],
      limits: { maxToolCalls: 4 },
    });

    const result = await agent.invoke({
      messages: [{ role: "user", content: "Summarize report-alpha-99 temperature breach." }],
    });

    const entry = (result.state?.toolHistory || [])[0];
    expect(entry.contextPilot?.applied).toBe(true);
    expect(entry.contextPilot?.compressorUsed).toBe("textCrusher");
    expect(typeof entry.output).toBe("string");
    expect((entry.output as string).length).toBeLessThan((entry.rawOutput as string).length);
    expect(entry.output as string).toContain("report-alpha-99");
    expect(entry.output as string).toContain('Use get_tool_response with executionId=');

    const ccrStore = (result.state?.ctx as any)?.__contextPilot?.ccrStore;
    const recovered = ccrStore.retrieve(entry.contextPilot.ccrHash);
    expect(recovered).toBe(entry.rawOutput);
  });
});

describe("ContextPilot / format-specific compressors", () => {
  it("compresses a large unified diff, keeping headers and +/- lines verbatim", async () => {
    const contextLine = (n: number) => ` unchanged context line ${n} with extra padding text to increase overall length`;
    const lines = [
      "diff --git a/file.txt b/file.txt",
      "--- a/file.txt",
      "+++ b/file.txt",
      "@@ -1,42 +1,42 @@",
      ...Array.from({ length: 40 }, (_, i) => contextLine(i)),
      "-old line that was removed",
      "+new line that was added",
    ];
    const diffText = lines.join("\n");

    const getDiff = createTool({
      name: "get_diff",
      description: "Return a large git diff.",
      schema: z.object({ ref: z.string() }),
      func: async () => diffText,
    });

    let turn = 0;
    const model: DeterministicModel = {
      modelName: "deterministic-diff-model",
      bindTools() { return model; },
      async invoke(): Promise<Message> {
        turn += 1;
        if (turn === 1) {
          return {
            role: "assistant",
            content: "",
            tool_calls: [{
              id: "call_diff",
              type: "function",
              name: "get_diff",
              args: { ref: "HEAD" },
              function: { name: "get_diff", arguments: JSON.stringify({ ref: "HEAD" }) },
            }],
          };
        }
        return { role: "assistant", content: "Reviewed the diff." };
      },
    };

    const agent = createSmartAgent({
      name: "ContextPilotDiffAgent",
      model,
      tools: [getDiff],
      limits: { maxToolCalls: 4 },
    });

    const result = await agent.invoke({ messages: [{ role: "user", content: "Review the latest diff." }] });
    const entry = (result.state?.toolHistory || [])[0];

    expect(entry.contextPilot?.applied).toBe(true);
    expect(entry.contextPilot?.compressorUsed).toBe("diffCompressor");
    expect(entry.output as string).toContain("-old line that was removed");
    expect(entry.output as string).toContain("+new line that was added");
    expect(entry.output as string).toContain("@@ -1,42 +1,42 @@");
  });

  it("compresses a large log, always preserving ERROR lines and the first/last line", async () => {
    const logLines: string[] = ["INFO job-runner: batch job started"];
    for (let i = 1; i <= 88; i += 1) {
      logLines.push(i === 5 ? "ERROR job-runner: item 5 failed validation" : `INFO job-runner: processing item ${i}`);
    }
    logLines.push("INFO job-runner: batch job finished");
    const logText = logLines.join("\n");

    const getLogs = createTool({
      name: "get_logs",
      description: "Return a large log file.",
      schema: z.object({ jobId: z.string() }),
      func: async () => logText,
    });

    let turn = 0;
    const model: DeterministicModel = {
      modelName: "deterministic-log-model",
      bindTools() { return model; },
      async invoke(): Promise<Message> {
        turn += 1;
        if (turn === 1) {
          return {
            role: "assistant",
            content: "",
            tool_calls: [{
              id: "call_logs",
              type: "function",
              name: "get_logs",
              args: { jobId: "job-1" },
              function: { name: "get_logs", arguments: JSON.stringify({ jobId: "job-1" }) },
            }],
          };
        }
        return { role: "assistant", content: "Found the failure at item 5." };
      },
    };

    const agent = createSmartAgent({
      name: "ContextPilotLogAgent",
      model,
      tools: [getLogs],
      limits: { maxToolCalls: 4 },
    });

    const result = await agent.invoke({ messages: [{ role: "user", content: "Why did job-1 fail?" }] });
    const entry = (result.state?.toolHistory || [])[0];

    expect(entry.contextPilot?.applied).toBe(true);
    expect(entry.contextPilot?.compressorUsed).toBe("logCompressor");
    expect(entry.output as string).toContain("ERROR job-runner: item 5 failed validation");
    expect(entry.output as string).toContain("INFO job-runner: batch job started");
    expect(entry.output as string).toContain("INFO job-runner: batch job finished");
  });

  it("compresses large grep/search results while preserving file diversity", async () => {
    const matchLines = Array.from(
      { length: 50 },
      (_, i) => `src/file${i % 5}.ts:${i + 1}:matched token at occurrence ${i}`,
    );
    const searchText = matchLines.join("\n");

    const grep = createTool({
      name: "grep_search",
      description: "Return large grep-style search results.",
      schema: z.object({ pattern: z.string() }),
      func: async () => searchText,
    });

    let turn = 0;
    const model: DeterministicModel = {
      modelName: "deterministic-search-model",
      bindTools() { return model; },
      async invoke(): Promise<Message> {
        turn += 1;
        if (turn === 1) {
          return {
            role: "assistant",
            content: "",
            tool_calls: [{
              id: "call_grep",
              type: "function",
              name: "grep_search",
              args: { pattern: "token" },
              function: { name: "grep_search", arguments: JSON.stringify({ pattern: "token" }) },
            }],
          };
        }
        return { role: "assistant", content: "Found matches across multiple files." };
      },
    };

    const agent = createSmartAgent({
      name: "ContextPilotSearchAgent",
      model,
      tools: [grep],
      limits: { maxToolCalls: 4 },
    });

    const result = await agent.invoke({ messages: [{ role: "user", content: "Search for token usages." }] });
    const entry = (result.state?.toolHistory || [])[0];

    expect(entry.contextPilot?.applied).toBe(true);
    expect(entry.contextPilot?.compressorUsed).toBe("searchCompressor");
    // File diversity: matches from more than one file must survive the cap.
    const distinctFiles = new Set(
      (entry.output as string)
        .split("\n")
        .filter((line: string) => line.startsWith("src/file"))
        .map((line: string) => line.split(":")[0]),
    );
    expect(distinctFiles.size).toBeGreaterThan(1);
  });
});

describe("ContextPilot / cross-turn duplicate detection", () => {
  it("flags the second identical tool response as a duplicate pointer instead of resending it", async () => {
    const uniqueReport =
      "Status report: warehouse zone 7 inventory count reconciled successfully with no discrepancies found this cycle.";
    // Sized between dedup.minChars (500) and compression.text.minChars (1200)
    // so only the cross-turn dedup path can trigger (not text compression).
    const paddedReport = `${uniqueReport} `.repeat(6).trim();
    expect(paddedReport.length).toBeGreaterThanOrEqual(500);
    expect(paddedReport.length).toBeLessThan(1200);

    const fetchStatus = createTool({
      name: "fetch_status_report",
      description: "Fetch a fixed status report.",
      schema: z.object({ zone: z.string() }),
      func: async () => paddedReport,
    });

    let turn = 0;
    const model: DeterministicModel = {
      modelName: "deterministic-dedup-model",
      bindTools() { return model; },
      async invoke(): Promise<Message> {
        turn += 1;
        if (turn === 1 || turn === 2) {
          return {
            role: "assistant",
            content: "",
            tool_calls: [{
              id: `call_status_${turn}`,
              type: "function",
              name: "fetch_status_report",
              args: { zone: "7" },
              function: { name: "fetch_status_report", arguments: JSON.stringify({ zone: "7" }) },
            }],
          };
        }
        return { role: "assistant", content: "Zone 7 is reconciled." };
      },
    };

    const agent = createSmartAgent({
      name: "ContextPilotDedupAgent",
      model,
      tools: [fetchStatus],
      limits: { maxToolCalls: 4 },
    });

    const result = await agent.invoke({ messages: [{ role: "user", content: "Check zone 7 status twice." }] });
    const toolHistory = (result.state?.toolHistory || []).filter((t: any) => t.toolName === "fetch_status_report");

    expect(toolHistory.length).toBe(2);
    expect(toolHistory[0].contextPilot).toBeUndefined();
    expect(toolHistory[1].contextPilot?.applied).toBe(true);
    expect(toolHistory[1].contextPilot?.duplicateOf).toBe(toolHistory[0].executionId);
    expect(toolHistory[1].output as string).toContain("DUPLICATE_TOOL_RESPONSE");
  });
});

describe("ContextPilot / cache alignment detection", () => {
  it("emits a metadata event when the system prompt contains volatile content", async () => {
    const events: any[] = [];
    const model: DeterministicModel = {
      modelName: "deterministic-no-tool-model",
      bindTools() { return model; },
      async invoke(): Promise<Message> {
        return { role: "assistant", content: "Acknowledged." };
      },
    };

    const agent = createSmartAgent({
      name: "ContextPilotCacheAlignmentAgent",
      model,
      tools: [],
      systemPrompt:
        "Session token sk-abcdefghijklmnopqrstuvwxyz123456 issued at 2026-07-20T10:00:00Z for request 123e4567-e89b-12d3-a456-426614174000.",
    });

    await agent.invoke(
      { messages: [{ role: "user", content: "Hello" }] },
      { onEvent: (event: any) => events.push(event) },
    );

    const cacheEvent = events.find((e) => e.type === "metadata" && e.reason === "context_pilot_cache_alignment");
    expect(cacheEvent).toBeTruthy();
    expect(cacheEvent.patternCounts).toBeTruthy();
    expect(Object.keys(cacheEvent.patternCounts).length).toBeGreaterThan(0);
  });
});

describe("ContextPilot / excludeTools bypass", () => {
  it("never compresses tools explicitly listed in contextPilot.excludeTools", async () => {
    const searchItems = createTool({
      name: "search_items",
      description: "Search a large product catalog.",
      schema: z.object({ query: z.string() }),
      func: async () => buildLargeSearchResults(),
    });

    const model = createDeterministicModel();
    const agent = createSmartAgent({
      name: "ContextPilotExcludeAgent",
      model,
      tools: [searchItems],
      limits: { maxToolCalls: 4 },
      contextPilot: { excludeTools: ["search_items"] },
    });

    const result = await agent.invoke({
      messages: [{ role: "user", content: "Find target-widget-42 in the catalog." }],
    });

    const entry = (result.state?.toolHistory || [])[0];
    expect(entry.contextPilot).toBeUndefined();
    expect((entry.output as any[]).length).toBe(25);
  });
});

describe("ContextPilot / profile-based aggressiveness", () => {
  function buildFortyItemCatalog(): Array<{ id: number; title: string }> {
    return Array.from({ length: 40 }, (_, i) => ({
      id: i,
      title: i === 20 ? "target-widget-42 exact match" : `unrelated filler product ${i}`,
    }));
  }

  it("the fast profile compresses more aggressively than the deep profile for the same payload", async () => {
    const runWithProfile = async (runtimeProfile: "fast" | "deep") => {
      const searchItems = createTool({
        name: "search_items",
        description: "Search a large product catalog.",
        schema: z.object({ query: z.string() }),
        func: async () => buildFortyItemCatalog(),
      });
      const model = createDeterministicModel();
      const agent = createSmartAgent({
        name: `ContextPilotProfileAgent-${runtimeProfile}`,
        model,
        tools: [searchItems],
        limits: { maxToolCalls: 4 },
        runtimeProfile,
      });
      const result = await agent.invoke({
        messages: [{ role: "user", content: "Find target-widget-42 in the catalog." }],
      });
      const entry = (result.state?.toolHistory || [])[0];
      expect(entry.contextPilot?.applied).toBe(true);
      return (entry.output as any[]).length;
    };

    const fastKeptCount = await runWithProfile("fast");
    const deepKeptCount = await runWithProfile("deep");

    // fast: targetRatio 0.25 -> ceil(40*0.25)=10 kept + 1 marker = 11
    // deep: targetRatio 0.5  -> ceil(40*0.5)=20 kept + 1 marker = 21
    expect(fastKeptCount).toBeLessThan(deepKeptCount);
  });
});
