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

  it("keeps more items with each successive built-in profile (fast < balanced < deep < research)", async () => {
    const runWithProfile = async (runtimeProfile: "fast" | "balanced" | "deep" | "research") => {
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

    const fastCount = await runWithProfile("fast");
    const balancedCount = await runWithProfile("balanced");
    const deepCount = await runWithProfile("deep");
    const researchCount = await runWithProfile("research");

    expect(fastCount).toBeLessThan(balancedCount);
    expect(balancedCount).toBeLessThan(deepCount);
    expect(deepCount).toBeLessThan(researchCount);
  });
});

describe("ContextPilot / relevance scoring drives retention (Faz 1)", () => {
  it("keeps the item matching the *current* query rather than a fixed position, across two distinct queries", async () => {
    // Special items are placed near the end (indices 28/29 of 30) so that the
    // "first 10 original-order" tie-broken fillers (always indices 0-9, see
    // relevance.ts's stable sort over 0-scored items) never accidentally
    // include the *other* query's target item.
    function buildCatalog(): Array<{ id: number; title: string }> {
      return Array.from({ length: 30 }, (_, i) => {
        if (i === 28) return { id: i, title: "alpha-widget-77 rare component" };
        if (i === 29) return { id: i, title: "beta-sensor-13 rare component" };
        return { id: i, title: `unrelated filler product ${i}` };
      });
    }

    const runWithQuery = async (query: string) => {
      const searchItems = createTool({
        name: "search_items",
        description: "Search a large product catalog.",
        schema: z.object({ query: z.string() }),
        func: async () => buildCatalog(),
      });
      let turn = 0;
      const model: DeterministicModel = {
        modelName: "deterministic-relevance-model",
        bindTools() { return model; },
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
                args: { query },
                function: { name: "search_items", arguments: JSON.stringify({ query }) },
              }],
            };
          }
          return { role: "assistant", content: `Found ${query}.` };
        },
      };
      const agent = createSmartAgent({
        name: "ContextPilotRelevanceAgent",
        model,
        tools: [searchItems],
        limits: { maxToolCalls: 4 },
      });
      const result = await agent.invoke({ messages: [{ role: "user", content: `Find ${query} in the catalog.` }] });
      const entry = (result.state?.toolHistory || [])[0];
      expect(entry.contextPilot?.applied).toBe(true);
      return entry.output as Array<{ title: string }>;
    };

    const alphaKept = await runWithQuery("alpha-widget-77");
    expect(alphaKept.some((item) => item?.title?.includes("alpha-widget-77"))).toBe(true);
    expect(alphaKept.some((item) => item?.title?.includes("beta-sensor-13"))).toBe(false);

    const betaKept = await runWithQuery("beta-sensor-13");
    expect(betaKept.some((item) => item?.title?.includes("beta-sensor-13"))).toBe(true);
    expect(betaKept.some((item) => item?.title?.includes("alpha-widget-77"))).toBe(false);
  });
});

describe("ContextPilot / CCR store lifecycle (Faz 2)", () => {
  it("expires a stored original once its TTL elapses", async () => {
    const searchItems = createTool({
      name: "search_items",
      description: "Search a large product catalog.",
      schema: z.object({ query: z.string() }),
      func: async () => buildLargeSearchResults(),
    });

    const model = createDeterministicModel();
    const agent = createSmartAgent({
      name: "ContextPilotTtlAgent",
      model,
      tools: [searchItems],
      limits: { maxToolCalls: 4 },
      contextPilot: { ccr: { ttlMs: 30 } },
    });

    const result = await agent.invoke({
      messages: [{ role: "user", content: "Find target-widget-42 in the catalog." }],
    });

    const entry = (result.state?.toolHistory || [])[0];
    const ccrHash = entry.contextPilot?.ccrHash;
    const ccrStore = (result.state?.ctx as any)?.__contextPilot?.ccrStore;
    expect(ccrHash).toBeTruthy();
    expect(ccrStore.retrieve(ccrHash)).toEqual(entry.rawOutput);

    await new Promise((resolve) => setTimeout(resolve, 60));

    expect(ccrStore.retrieve(ccrHash)).toBeUndefined();
  });

  it("evicts the oldest CCR entry once maxEntries is exceeded, across two turns sharing the same ctx", async () => {
    const buildVariant = (label: string) => Array.from({ length: 25 }, (_, i) => ({
      id: i,
      title: i === 12 ? `target-${label}-unique-marker` : `${label} filler product ${i}`,
    }));

    const searchA = createTool({
      name: "search_a",
      description: "Search catalog A.",
      schema: z.object({ query: z.string() }),
      func: async () => buildVariant("alpha"),
    });
    const searchB = createTool({
      name: "search_b",
      description: "Search catalog B.",
      schema: z.object({ query: z.string() }),
      func: async () => buildVariant("beta"),
    });

    type Phase = "call_a" | "final_a" | "call_b" | "final_b";
    let phase: Phase = "call_a";
    const model: DeterministicModel = {
      modelName: "deterministic-eviction-model",
      bindTools() { return model; },
      async invoke(): Promise<Message> {
        if (phase === "call_a") {
          phase = "final_a";
          return {
            role: "assistant",
            content: "",
            tool_calls: [{
              id: "call_a1",
              type: "function",
              name: "search_a",
              args: { query: "alpha" },
              function: { name: "search_a", arguments: JSON.stringify({ query: "alpha" }) },
            }],
          };
        }
        if (phase === "final_a") {
          phase = "call_b";
          return { role: "assistant", content: "Found alpha results." };
        }
        if (phase === "call_b") {
          phase = "final_b";
          return {
            role: "assistant",
            content: "",
            tool_calls: [{
              id: "call_b1",
              type: "function",
              name: "search_b",
              args: { query: "beta" },
              function: { name: "search_b", arguments: JSON.stringify({ query: "beta" }) },
            }],
          };
        }
        return { role: "assistant", content: "Found beta results." };
      },
    };

    const agent = createSmartAgent({
      name: "ContextPilotEvictionAgent",
      model,
      tools: [searchA, searchB],
      limits: { maxToolCalls: 4 },
      contextPilot: { ccr: { maxEntries: 1 } },
    });

    const firstResult = await agent.invoke({ messages: [{ role: "user", content: "Search catalog A." }] });
    const entryA = (firstResult.state?.toolHistory || []).find((t: any) => t.toolName === "search_a");
    expect(entryA?.contextPilot?.applied).toBe(true);
    const hashA = entryA.contextPilot.ccrHash;
    const ccrStore = (firstResult.state?.ctx as any)?.__contextPilot?.ccrStore;
    expect(ccrStore.retrieve(hashA)).toEqual(entryA.rawOutput);

    const secondResult = await agent.invoke({
      messages: [...firstResult.messages, { role: "user", content: "Now search catalog B." }],
      toolHistory: firstResult.state?.toolHistory,
      toolHistoryArchived: firstResult.state?.toolHistoryArchived,
      ctx: firstResult.state?.ctx,
    } as any);

    const entryB = (secondResult.state?.toolHistory || []).find((t: any) => t.toolName === "search_b");
    expect(entryB?.contextPilot?.applied).toBe(true);
    const hashB = entryB.contextPilot.ccrHash;

    // maxEntries: 1 means storing hashB must evict the older hashA entry (LRU).
    expect(ccrStore.retrieve(hashB)).toEqual(entryB.rawOutput);
    expect(ccrStore.retrieve(hashA)).toBeUndefined();
  });
});

describe("ContextPilot / JSON compressor custom configuration (Faz 3)", () => {
  it("respects a custom targetRatio and minItems override", async () => {
    const items = Array.from({ length: 50 }, (_, i) => ({
      id: i,
      title: i === 0 ? "target-widget-42 exact match" : `unrelated filler product ${i}`,
    }));

    const searchItems = createTool({
      name: "search_items",
      description: "Search a large product catalog.",
      schema: z.object({ query: z.string() }),
      func: async () => items,
    });

    const model = createDeterministicModel();
    const agent = createSmartAgent({
      name: "ContextPilotJsonConfigAgent",
      model,
      tools: [searchItems],
      limits: { maxToolCalls: 4 },
      contextPilot: { compression: { json: { targetRatio: 0.1, minItems: 10 } } },
    });

    const result = await agent.invoke({
      messages: [{ role: "user", content: "Find target-widget-42 in the catalog." }],
    });

    const entry = (result.state?.toolHistory || [])[0];
    expect(entry.contextPilot?.applied).toBe(true);
    // ceil(50 * 0.1) = 5 kept items + 1 marker entry = 6
    expect((entry.output as any[]).length).toBe(6);
    expect((entry.output as any[]).some((item: any) => item?.title?.includes("target-widget-42"))).toBe(true);
  });
});

describe("ContextPilot / format-compressor custom configuration (Faz 4)", () => {
  it("respects a smaller diff.contextLines override", async () => {
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
      modelName: "deterministic-diff-config-model",
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
      name: "ContextPilotDiffConfigAgent",
      model,
      tools: [getDiff],
      limits: { maxToolCalls: 4 },
      contextPilot: { compression: { diff: { contextLines: 1 } } },
    });

    const result = await agent.invoke({ messages: [{ role: "user", content: "Review the latest diff." }] });
    const entry = (result.state?.toolHistory || [])[0];

    expect(entry.contextPilot?.applied).toBe(true);
    // Exclude the trailing ContextPilot note line, which also mentions the
    // phrase "unchanged context line(s)" in its explanatory text.
    const contextLineCount = (entry.output as string)
      .split("\n")
      .filter((line: string) => line.startsWith(" unchanged context line")).length;
    expect(contextLineCount).toBe(1);
    expect(entry.output as string).toContain("-old line that was removed");
    expect(entry.output as string).toContain("+new line that was added");
  });

  it("respects a smaller log.maxLines override while still preserving the ERROR line", async () => {
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
      modelName: "deterministic-log-config-model",
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
      name: "ContextPilotLogConfigAgent",
      model,
      tools: [getLogs],
      limits: { maxToolCalls: 4 },
      contextPilot: { compression: { log: { maxLines: 20 } } },
    });

    const result = await agent.invoke({ messages: [{ role: "user", content: "Why did job-1 fail?" }] });
    const entry = (result.state?.toolHistory || [])[0];

    expect(entry.contextPilot?.applied).toBe(true);
    expect(entry.output as string).toContain("ERROR job-runner: item 5 failed validation");
    const keptLogLines = (entry.output as string).split("\n").filter((line: string) => line.startsWith("INFO") || line.startsWith("ERROR"));
    expect(keptLogLines.length).toBeLessThanOrEqual(20);
  });

  it("respects a smaller search.maxMatches override", async () => {
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
      modelName: "deterministic-search-config-model",
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
      name: "ContextPilotSearchConfigAgent",
      model,
      tools: [grep],
      limits: { maxToolCalls: 4 },
      contextPilot: { compression: { search: { maxMatches: 8 } } },
    });

    const result = await agent.invoke({ messages: [{ role: "user", content: "Search for token usages." }] });
    const entry = (result.state?.toolHistory || [])[0];

    expect(entry.contextPilot?.applied).toBe(true);
    const keptMatchLines = (entry.output as string).split("\n").filter((line: string) => line.startsWith("src/file"));
    expect(keptMatchLines.length).toBeLessThanOrEqual(8);
  });
});

describe("ContextPilot / dedup & cache-alignment configuration (Faz 5)", () => {
  it("does not flag cross-turn duplicates when dedup.enabled is false", async () => {
    const uniqueReport =
      "Status report: warehouse zone 7 inventory count reconciled successfully with no discrepancies found this cycle.";
    const paddedReport = `${uniqueReport} `.repeat(6).trim();

    const fetchStatus = createTool({
      name: "fetch_status_report",
      description: "Fetch a fixed status report.",
      schema: z.object({ zone: z.string() }),
      func: async () => paddedReport,
    });

    let turn = 0;
    const model: DeterministicModel = {
      modelName: "deterministic-dedup-disabled-model",
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
      name: "ContextPilotDedupDisabledAgent",
      model,
      tools: [fetchStatus],
      limits: { maxToolCalls: 4 },
      contextPilot: { dedup: { enabled: false } },
    });

    const result = await agent.invoke({ messages: [{ role: "user", content: "Check zone 7 status twice." }] });
    const toolHistory = (result.state?.toolHistory || []).filter((t: any) => t.toolName === "fetch_status_report");

    expect(toolHistory.length).toBe(2);
    expect(toolHistory[0].contextPilot).toBeUndefined();
    expect(toolHistory[1].contextPilot).toBeUndefined();
    expect(toolHistory[1].output as string).toBe(paddedReport);
  });

  it("suppresses the cache-alignment metadata event when cacheAlignment.enabled is false", async () => {
    const events: any[] = [];
    const model: DeterministicModel = {
      modelName: "deterministic-no-tool-model",
      bindTools() { return model; },
      async invoke(): Promise<Message> {
        return { role: "assistant", content: "Acknowledged." };
      },
    };

    const agent = createSmartAgent({
      name: "ContextPilotCacheAlignmentDisabledAgent",
      model,
      tools: [],
      systemPrompt:
        "Session token sk-abcdefghijklmnopqrstuvwxyz123456 issued at 2026-07-20T10:00:00Z for request 123e4567-e89b-12d3-a456-426614174000.",
      contextPilot: { cacheAlignment: { enabled: false } },
    });

    await agent.invoke(
      { messages: [{ role: "user", content: "Hello" }] },
      { onEvent: (event: any) => events.push(event) },
    );

    const cacheEvent = events.find((e) => e.type === "metadata" && e.reason === "context_pilot_cache_alignment");
    expect(cacheEvent).toBeUndefined();
  });
});

describe("ContextPilot / get_tool_response not-found handling (Faz 6)", () => {
  it("reports a clear not-found message when a marker's executionId has since expired from the CCR store", async () => {
    const searchItems = createTool({
      name: "search_items",
      description: "Search a large product catalog.",
      schema: z.object({ query: z.string() }),
      func: async () => buildLargeSearchResults(),
    });

    type Phase = "await_search_call" | "await_final_after_search" | "await_recovery_call" | "await_final";
    let phase: Phase = "await_search_call";
    let capturedHash: string | undefined;
    const model: DeterministicModel = {
      modelName: "deterministic-expired-recovery-model",
      bindTools() { return model; },
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
          capturedHash = extractCcrHash((lastSearchToolMessage as any)?.content);
          expect(capturedHash).toBeTruthy();
          phase = "await_final";
          return {
            role: "assistant",
            content: "",
            tool_calls: [{
              id: "call_recover",
              type: "function",
              name: "get_tool_response",
              args: { executionId: capturedHash },
              function: { name: "get_tool_response", arguments: JSON.stringify({ executionId: capturedHash }) },
            }],
          };
        }
        return { role: "assistant", content: "Could not recover the expired entry." };
      },
    };

    const agent = createSmartAgent({
      name: "ContextPilotExpiredRecoveryAgent",
      model,
      tools: [searchItems],
      limits: { maxToolCalls: 4 },
      contextPilot: { ccr: { ttlMs: 30 } },
    });

    const firstResult = await agent.invoke({
      messages: [{ role: "user", content: "Find target-widget-42 in the catalog." }],
    });

    // Let the CCR entry's short TTL elapse before the model attempts recovery.
    await new Promise((resolve) => setTimeout(resolve, 60));

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
    expect(recoveryEntry.args.executionId).toBe(capturedHash);
    expect(recoveryEntry.output).toBe("Execution not found. Please check the executionId.");
    expect(secondResult.content).toContain("Could not recover the expired entry.");
  });
});

describe("ContextPilot / deep relevance-scoring battery (Faz 1)", () => {
  it("prefers items matching more distinct query terms over items matching fewer (multi-term BM25 preference)", async () => {
    // 17 zero-overlap filler items + 3 graded-relevance items placed at the
    // end (so the "first N zero-score" tie-broken fillers never collide with
    // them — see the earlier relevance test for why index position matters).
    const items = [
      ...Array.from({ length: 17 }, (_, i) => ({ id: i, title: `unrelated filler product ${i}` })),
      { id: 17, title: "red leather wallet premium edition" }, // matches all 3 query terms
      { id: 18, title: "red wallet basic edition" }, // matches 2 query terms
      { id: 19, title: "leather bag basic edition" }, // matches 1 query term
    ];
    expect(items.length).toBe(20);

    const searchItems = createTool({
      name: "search_items",
      description: "Search a large product catalog.",
      schema: z.object({ query: z.string() }),
      func: async () => items,
    });

    let turn = 0;
    const model: DeterministicModel = {
      modelName: "deterministic-multiterm-relevance-model",
      bindTools() { return model; },
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
              args: { query: "red leather wallet" },
              function: { name: "search_items", arguments: JSON.stringify({ query: "red leather wallet" }) },
            }],
          };
        }
        return { role: "assistant", content: "Found the best matching wallet." };
      },
    };

    const agent = createSmartAgent({
      name: "ContextPilotMultiTermRelevanceAgent",
      model,
      tools: [searchItems],
      limits: { maxToolCalls: 4 },
      // 20 items, minItems 10, targetRatio 0.1 -> keepCount = ceil(20*0.1) = 2.
      contextPilot: { compression: { json: { targetRatio: 0.1, minItems: 10 } } },
    });

    const result = await agent.invoke({
      messages: [{ role: "user", content: "Find a red leather wallet." }],
    });

    const entry = (result.state?.toolHistory || [])[0];
    expect(entry.contextPilot?.applied).toBe(true);
    const keptTitles = (entry.output as Array<{ title?: string }>)
      .map((item) => item?.title)
      .filter((title): title is string => typeof title === "string");

    // Top-2 by BM25 score must be the 3-term and 2-term matches; the
    // 1-term match ("leather bag") must be dropped in favor of them.
    expect(keptTitles.some((title) => title.includes("red leather wallet premium"))).toBe(true);
    expect(keptTitles.some((title) => title.includes("red wallet basic"))).toBe(true);
    expect(keptTitles.some((title) => title.includes("leather bag basic"))).toBe(false);
  });

  it("scores relevance against the latest user message in a resumed conversation, ignoring an earlier stale question", async () => {
    const items = [
      ...Array.from({ length: 26 }, (_, i) => ({ id: i, title: `unrelated filler product ${i}` })),
      { id: 26, title: "red-gadget-1 legacy item" }, // matches the *stale* first question
      { id: 27, title: "blue-widget-99 current item" }, // matches the *latest* question
    ];
    expect(items.length).toBe(28);

    const searchItems = createTool({
      name: "search_items",
      description: "Search a large product catalog.",
      schema: z.object({ query: z.string() }),
      func: async () => items,
    });

    let turn = 0;
    const model: DeterministicModel = {
      modelName: "deterministic-latest-query-model",
      bindTools() { return model; },
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
              args: { query: "blue widget" },
              function: { name: "search_items", arguments: JSON.stringify({ query: "blue widget" }) },
            }],
          };
        }
        return { role: "assistant", content: "Found blue-widget-99." };
      },
    };

    const agent = createSmartAgent({
      name: "ContextPilotLatestQueryAgent",
      model,
      tools: [searchItems],
      limits: { maxToolCalls: 4 },
    });

    // Seed a resumed conversation: an earlier (now stale) question about
    // "red gadgets" is already in history, followed by a newer question
    // about "blue widgets" that the model actually acts on.
    const result = await agent.invoke({
      messages: [
        { role: "user", content: "Tell me about red gadgets." },
        { role: "assistant", content: "Sure, let me check that for you." },
        { role: "user", content: "Actually, forget that — find blue widgets instead." },
      ],
    });

    const entry = (result.state?.toolHistory || [])[0];
    expect(entry.contextPilot?.applied).toBe(true);
    const keptTitles = (entry.output as Array<{ title?: string }>)
      .map((item) => item?.title)
      .filter((title): title is string => typeof title === "string");

    expect(keptTitles.some((title) => title.includes("blue-widget-99"))).toBe(true);
    expect(keptTitles.some((title) => title.includes("red-gadget-1"))).toBe(false);
  });

  it("ignores stopwords in the query so a filler item repeating them isn't spuriously boosted", async () => {
    const items = [
      ...Array.from({ length: 26 }, (_, i) => ({ id: i, title: `unrelated filler product ${i}` })),
      // Repeats stopwords ("the", "for", "of") many times but shares no real
      // content words with the query — must NOT be favored by scoring. Placed
      // near the end (like the query-target item) so it never collides with
      // the "first N zero-score" tie-broken fillers that always fill out the
      // remaining kept slots.
      { id: 26, title: "the for of the of the for the of filler item" },
      { id: 27, title: "red-gadget-home-special exact match" },
    ];
    expect(items.length).toBe(28);

    const searchItems = createTool({
      name: "search_items",
      description: "Search a large product catalog.",
      schema: z.object({ query: z.string() }),
      func: async () => items,
    });

    let turn = 0;
    const model: DeterministicModel = {
      modelName: "deterministic-stopword-model",
      bindTools() { return model; },
      async invoke(): Promise<Message> {
        turn += 1;
        if (turn === 1) {
          const query = "the red gadget for the of home";
          return {
            role: "assistant",
            content: "",
            tool_calls: [{
              id: "call_search",
              type: "function",
              name: "search_items",
              args: { query },
              function: { name: "search_items", arguments: JSON.stringify({ query }) },
            }],
          };
        }
        return { role: "assistant", content: "Found red-gadget-home-special." };
      },
    };

    const agent = createSmartAgent({
      name: "ContextPilotStopwordAgent",
      model,
      tools: [searchItems],
      limits: { maxToolCalls: 4 },
    });

    const result = await agent.invoke({
      messages: [{ role: "user", content: "the red gadget for the of home" }],
    });

    const entry = (result.state?.toolHistory || [])[0];
    expect(entry.contextPilot?.applied).toBe(true);
    const keptTitles = (entry.output as Array<{ title?: string }>)
      .map((item) => item?.title)
      .filter((title): title is string => typeof title === "string");

    expect(keptTitles.some((title) => title.includes("red-gadget-home-special"))).toBe(true);
    expect(keptTitles.some((title) => title.startsWith("the for of the of the"))).toBe(false);
  });
});

describe("ContextPilot / relevance scoring edge cases (Faz 1)", () => {
  it("applies BM25 document-length normalization: a short precise match outranks a long document diluting the same term matches", async () => {
    // Both A and B contain the exact same query terms with the same raw term
    // frequency (1 each) — the ONLY difference is document length. BM25's
    // length-normalization term (the `b` parameter) must penalize the term
    // match diluted across a much longer document.
    const items = [
      ...Array.from({ length: 20 }, (_, i) => ({ id: i, title: `unrelated filler product ${i}` })),
      {
        id: 20,
        title:
          "widget-99 mention buried amid many other completely unrelated padding words that inflate the overall document length substantially for this listing",
      },
      { id: 21, title: "widget-99" },
    ];
    expect(items.length).toBe(22);

    const searchItems = createTool({
      name: "search_items",
      description: "Search a large product catalog.",
      schema: z.object({ query: z.string() }),
      func: async () => items,
    });

    let turn = 0;
    const model: DeterministicModel = {
      modelName: "deterministic-length-norm-model",
      bindTools() { return model; },
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
              args: { query: "widget-99" },
              function: { name: "search_items", arguments: JSON.stringify({ query: "widget-99" }) },
            }],
          };
        }
        return { role: "assistant", content: "Found widget-99." };
      },
    };

    const agent = createSmartAgent({
      name: "ContextPilotLengthNormAgent",
      model,
      tools: [searchItems],
      limits: { maxToolCalls: 4 },
      // 22 items, ceil(22*0.04) = 1 -> forces a single strict winner between
      // the short and long documents (fillers all score 0 and can't compete).
      contextPilot: { compression: { json: { targetRatio: 0.04, minItems: 20 } } },
    });

    const result = await agent.invoke({ messages: [{ role: "user", content: "Find widget-99." }] });
    const entry = (result.state?.toolHistory || [])[0];
    expect(entry.contextPilot?.applied).toBe(true);
    expect(entry.contextPilot?.droppedItems).toBe(21);

    const keptTitles = (entry.output as Array<{ title?: string }>)
      .map((item) => item?.title)
      .filter((title): title is string => typeof title === "string");

    expect(keptTitles).toEqual(["widget-99"]);
  });

  it("does not let keyword-stuffing on one term beat a distinct multi-term match (BM25 term-frequency saturation)", async () => {
    // C repeats a single query term many times; D matches all 3 distinct
    // query terms exactly once each. BM25's saturating term-frequency curve
    // (governed by k1) means repetition has diminishing returns, so a
    // genuine multi-term match should still win over single-term stuffing.
    const items = [
      ...Array.from({ length: 20 }, (_, i) => ({ id: i, title: `unrelated filler product ${i}` })),
      { id: 20, title: "gadget gadget gadget gadget gadget gadget gadget gadget gadget gadget gadget gadget gadget gadget gadget" },
      { id: 21, title: "gadget widget premium special" },
    ];
    expect(items.length).toBe(22);

    const searchItems = createTool({
      name: "search_items",
      description: "Search a large product catalog.",
      schema: z.object({ query: z.string() }),
      func: async () => items,
    });

    let turn = 0;
    const model: DeterministicModel = {
      modelName: "deterministic-saturation-model",
      bindTools() { return model; },
      async invoke(): Promise<Message> {
        turn += 1;
        if (turn === 1) {
          const query = "gadget widget premium";
          return {
            role: "assistant",
            content: "",
            tool_calls: [{
              id: "call_search",
              type: "function",
              name: "search_items",
              args: { query },
              function: { name: "search_items", arguments: JSON.stringify({ query }) },
            }],
          };
        }
        return { role: "assistant", content: "Found gadget widget premium special." };
      },
    };

    const agent = createSmartAgent({
      name: "ContextPilotSaturationAgent",
      model,
      tools: [searchItems],
      limits: { maxToolCalls: 4 },
      // Same 1-slot forcing trick as the length-normalization test above.
      contextPilot: { compression: { json: { targetRatio: 0.04, minItems: 20 } } },
    });

    const result = await agent.invoke({ messages: [{ role: "user", content: "Find gadget widget premium item." }] });
    const entry = (result.state?.toolHistory || [])[0];
    expect(entry.contextPilot?.applied).toBe(true);

    const keptTitles = (entry.output as Array<{ title?: string }>)
      .map((item) => item?.title)
      .filter((title): title is string => typeof title === "string");

    expect(keptTitles).toEqual(["gadget widget premium special"]);
  });

  it("falls back to original document order when the latest user message has no scorable (non-stopword) content", async () => {
    // Every token in this query is filtered by the BM25 tokenizer's stopword
    // list, so queryTokens.length === 0 and every item must score a neutral
    // 1 — retention then depends entirely on the stable-sort tie-break,
    // which must preserve original array order (first N survive).
    const items = Array.from({ length: 20 }, (_, i) => ({ id: i, title: `catalog entry number ${i} with distinct content` }));

    const searchItems = createTool({
      name: "search_items",
      description: "Search a large product catalog.",
      schema: z.object({ query: z.string() }),
      func: async () => items,
    });

    let turn = 0;
    const model: DeterministicModel = {
      modelName: "deterministic-empty-query-model",
      bindTools() { return model; },
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
              args: { query: "the of and it as this that" },
              function: { name: "search_items", arguments: JSON.stringify({ query: "the of and it as this that" }) },
            }],
          };
        }
        return { role: "assistant", content: "Here is the catalog." };
      },
    };

    const agent = createSmartAgent({
      name: "ContextPilotEmptyQueryAgent",
      model,
      tools: [searchItems],
      limits: { maxToolCalls: 4 },
      // 20 items, minItems 20, targetRatio 0.25 -> keepCount = ceil(20*0.25) = 5.
      contextPilot: { compression: { json: { targetRatio: 0.25, minItems: 20 } } },
    });

    // The latest user message itself is stopword-only, so extractLatestUserQuery
    // must feed a query with zero scorable tokens into the relevance scorer.
    const result = await agent.invoke({ messages: [{ role: "user", content: "The of and it as this that" }] });
    const entry = (result.state?.toolHistory || [])[0];
    expect(entry.contextPilot?.applied).toBe(true);

    const keptIds = (entry.output as Array<{ id?: number }>)
      .map((item) => item?.id)
      .filter((id): id is number => typeof id === "number");

    expect(keptIds).toEqual([0, 1, 2, 3, 4]);
  });
});

describe("ContextPilot / text compressor relevance depth (Faz 1)", () => {
  it("ranks sentences by degree of relevance, keeping the exact multi-term match over partial-overlap decoys", async () => {
    // textCrusher always keeps a floor of at least 3 sentences (see
    // `Math.max(3, ...)` in textCrusher.ts), so a clean ranking test needs
    // *four* graded-relevance candidates (query has 4 non-stopword terms:
    // database, connection, timeout, production) so the single weakest
    // partial match gets pushed out of that floor by the other three.
    const fillerSentences = Array.from(
      { length: 30 },
      (_, i) => `Routine observation number ${i} about ordinary warehouse shelving activity with no anomalies.`,
    );
    const target = "The production database connection experienced a timeout during a spike in nightly batch traffic."; // 4/4 terms
    const decoyThreeTerms = "A database connection timeout was logged in the archived staging environment."; // 3/4 terms
    const decoyTwoTerms = "The production server encountered a memory issue unrelated to any database concern."; // 2/4 terms
    const decoyOneTerm = "The connection pool exhausted during a routine batch job overnight."; // 1/4 terms — weakest, must be dropped
    fillerSentences.splice(8, 0, decoyOneTerm);
    fillerSentences.splice(16, 0, decoyTwoTerms);
    fillerSentences.splice(22, 0, decoyThreeTerms);
    fillerSentences.splice(27, 0, target);
    const longText = fillerSentences.join(" ");
    expect(longText.length).toBeGreaterThan(1200);

    const fetchReport = createTool({
      name: "fetch_incident_report",
      description: "Fetch a long free-text incident report.",
      schema: z.object({ topic: z.string() }),
      func: async () => longText,
    });

    let turn = 0;
    const model: DeterministicModel = {
      modelName: "deterministic-sentence-relevance-model",
      bindTools() { return model; },
      async invoke(): Promise<Message> {
        turn += 1;
        if (turn === 1) {
          return {
            role: "assistant",
            content: "",
            tool_calls: [{
              id: "call_report",
              type: "function",
              name: "fetch_incident_report",
              args: { topic: "database connection timeout" },
              function: { name: "fetch_incident_report", arguments: JSON.stringify({ topic: "database connection timeout" }) },
            }],
          };
        }
        return { role: "assistant", content: "Found the production database connection timeout." };
      },
    };

    const agent = createSmartAgent({
      name: "ContextPilotSentenceRelevanceAgent",
      model,
      tools: [fetchReport],
      limits: { maxToolCalls: 4 },
      // Force a tight keep ratio so only the very best-matching sentence(s) survive.
      contextPilot: { compression: { text: { targetRatio: 0.06, minChars: 1200 } } },
    });

    const result = await agent.invoke({
      messages: [{ role: "user", content: "database connection timeout in production" }],
    });

    const entry = (result.state?.toolHistory || [])[0];
    expect(entry.contextPilot?.applied).toBe(true);
    expect(entry.contextPilot?.compressorUsed).toBe("textCrusher");

    const compressed = entry.output as string;
    expect(compressed).toContain(target);
    expect(compressed).toContain(decoyThreeTerms);
    expect(compressed).toContain(decoyTwoTerms);
    // The weakest (single-term) partial match must lose out to the other
    // three stronger candidates under the fixed keep-floor of 3.
    expect(compressed).not.toContain(decoyOneTerm);
  });
});

describe("ContextPilot / full pipeline grand integration (Faz 7)", () => {
  it("wires relevance scoring, JSON+log compression, cross-turn dedup, cache alignment, and CCR recovery together across two invokes sharing one runtime", async () => {
    const searchItems = createTool({
      name: "search_items",
      description: "Search a large product catalog.",
      schema: z.object({ query: z.string() }),
      func: async () => buildLargeSearchResults(),
    });

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

    type Phase =
      | "call_search"
      | "call_logs"
      | "final_first_invoke"
      | "call_search_duplicate"
      | "call_recover"
      | "final_second_invoke";
    let phase: Phase = "call_search";
    let capturedSearchHash: string | undefined;
    const model: DeterministicModel = {
      modelName: "deterministic-grand-pipeline-model",
      bindTools() { return model; },
      async invoke(messages: Message[]): Promise<Message> {
        if (phase === "call_search") {
          phase = "call_logs";
          return {
            role: "assistant",
            content: "",
            tool_calls: [{
              id: "call_search_1",
              type: "function",
              name: "search_items",
              args: { query: "target-widget-42" },
              function: { name: "search_items", arguments: JSON.stringify({ query: "target-widget-42" }) },
            }],
          };
        }
        if (phase === "call_logs") {
          // Capture the CCR hash now, while exactly one (non-duplicate)
          // search_items tool message exists in history — by the later
          // recovery phase a second (duplicate-pointer) search_items tool
          // message will also be present, so re-scanning then would be
          // ambiguous about which "executionId" it points to.
          const searchToolMessage = messages.find((m: any) => m.role === "tool" && m.name === "search_items");
          capturedSearchHash = extractCcrHash((searchToolMessage as any)?.content);
          expect(capturedSearchHash).toBeTruthy();
          phase = "final_first_invoke";
          return {
            role: "assistant",
            content: "",
            tool_calls: [{
              id: "call_logs_1",
              type: "function",
              name: "get_logs",
              args: { jobId: "job-1" },
              function: { name: "get_logs", arguments: JSON.stringify({ jobId: "job-1" }) },
            }],
          };
        }
        if (phase === "final_first_invoke") {
          phase = "call_search_duplicate";
          return { role: "assistant", content: "Found target-widget-42 and the item-5 log failure." };
        }
        if (phase === "call_search_duplicate") {
          phase = "call_recover";
          return {
            role: "assistant",
            content: "",
            tool_calls: [{
              id: "call_search_2",
              type: "function",
              name: "search_items",
              args: { query: "target-widget-42" },
              function: { name: "search_items", arguments: JSON.stringify({ query: "target-widget-42" }) },
            }],
          };
        }
        if (phase === "call_recover") {
          expect(capturedSearchHash).toBeTruthy();
          phase = "final_second_invoke";
          return {
            role: "assistant",
            content: "",
            tool_calls: [{
              id: "call_recover_1",
              type: "function",
              name: "get_tool_response",
              args: { executionId: capturedSearchHash },
              function: { name: "get_tool_response", arguments: JSON.stringify({ executionId: capturedSearchHash }) },
            }],
          };
        }
        return { role: "assistant", content: "Session complete: retrieved the full catalog." };
      },
    };

    const events: any[] = [];
    const agent = createSmartAgent({
      name: "ContextPilotGrandPipelineAgent",
      model,
      tools: [searchItems, getLogs],
      limits: { maxToolCalls: 6 },
      systemPrompt:
        "Session token sk-abcdefghijklmnopqrstuvwxyz123456 issued at 2026-07-20T10:00:00Z for request 123e4567-e89b-12d3-a456-426614174000.",
    });

    // --- First invoke: search_items (JSON crush) + get_logs (log compress) ---
    const firstResult = await agent.invoke(
      { messages: [{ role: "user", content: "Find target-widget-42, then check job-1's logs." }] },
      { onEvent: (event: any) => events.push(event) },
    );

    const firstToolHistory = firstResult.state?.toolHistory || [];
    expect(firstToolHistory.length).toBe(2);

    const searchEntry = firstToolHistory.find((t: any) => t.toolName === "search_items");
    expect(searchEntry?.contextPilot?.applied).toBe(true);
    expect(searchEntry?.contextPilot?.compressorUsed).toBe("jsonCrusher");
    expect((searchEntry.output as any[]).some((item: any) => item?.title?.includes("target-widget-42"))).toBe(true);

    const logsEntry = firstToolHistory.find((t: any) => t.toolName === "get_logs");
    expect(logsEntry?.contextPilot?.applied).toBe(true);
    expect(logsEntry?.contextPilot?.compressorUsed).toBe("logCompressor");
    expect(logsEntry.output as string).toContain("ERROR job-runner: item 5 failed validation");

    // --- Second invoke: duplicate search (dedup) + CCR recovery ---
    const secondResult = await agent.invoke(
      {
        messages: [
          ...firstResult.messages,
          { role: "user", content: "Search target-widget-42 again, then retrieve the full unfiltered list." },
        ],
        toolHistory: firstResult.state?.toolHistory,
        toolHistoryArchived: firstResult.state?.toolHistoryArchived,
        ctx: firstResult.state?.ctx,
      } as any,
      { onEvent: (event: any) => events.push(event) },
    );

    const secondToolHistory = secondResult.state?.toolHistory || [];
    expect(secondToolHistory.length).toBe(4);

    const duplicateSearchEntry = secondToolHistory[2];
    expect(duplicateSearchEntry.toolName).toBe("search_items");
    expect(duplicateSearchEntry.contextPilot?.applied).toBe(true);
    expect(duplicateSearchEntry.contextPilot?.duplicateOf).toBe(searchEntry.executionId);
    expect(duplicateSearchEntry.output as string).toContain("DUPLICATE_TOOL_RESPONSE");

    const recoveryEntry = secondToolHistory[3];
    expect(recoveryEntry.toolName).toBe("get_tool_response");
    expect(recoveryEntry.args.executionId).toBe(searchEntry.contextPilot.ccrHash);
    expect(recoveryEntry.output).toEqual(searchEntry.rawOutput);
    expect((recoveryEntry.output as any[]).length).toBe(25);
    expect(secondResult.content).toContain("Session complete: retrieved the full catalog.");

    // --- Cross-cutting integrity checks ---
    // The cache-alignment warning must fire exactly once across the whole
    // two-invoke session (not once per invoke), since the "already warned"
    // flag is carried on the shared, forwarded ctx.
    const cacheEvents = events.filter((e) => e.type === "metadata" && e.reason === "context_pilot_cache_alignment");
    expect(cacheEvents.length).toBe(1);

    // The CCR store and dedup tracker are the *same* runtime instance across
    // both invokes, proving ContextPilot's state is truly wired end-to-end
    // rather than reconstructed per turn.
    const firstRuntime = (firstResult.state?.ctx as any)?.__contextPilot;
    const secondRuntime = (secondResult.state?.ctx as any)?.__contextPilot;
    expect(secondRuntime.ccrStore).toBe(firstRuntime.ccrStore);
    expect(secondRuntime.dedupTracker).toBe(firstRuntime.dedupTracker);
  });

  it("generalizes to diff+search compressors, an excludeTools bypass, and a non-default profile, still wiring dedup and CCR recovery correctly", async () => {
    const contextLine = (n: number) => ` unchanged context line ${n} with extra padding text to increase overall length`;
    const diffText = [
      "diff --git a/service.ts b/service.ts",
      "--- a/service.ts",
      "+++ b/service.ts",
      "@@ -1,42 +1,42 @@",
      ...Array.from({ length: 40 }, (_, i) => contextLine(i)),
      "-old implementation removed",
      "+new implementation added",
    ].join("\n");

    const getDiff = createTool({
      name: "get_diff",
      description: "Return a large git diff.",
      schema: z.object({ ref: z.string() }),
      func: async () => diffText,
    });

    const matchLines = Array.from(
      { length: 50 },
      (_, i) => `src/module${i % 5}.ts:${i + 1}:matched symbol at occurrence ${i}`,
    );
    const searchText = matchLines.join("\n");

    const grepSearch = createTool({
      name: "grep_search",
      description: "Return large grep-style search results.",
      schema: z.object({ pattern: z.string() }),
      func: async () => searchText,
    });

    // This tool is explicitly excluded — its output must survive both
    // invokes completely untouched by ContextPilot (no compression, no
    // dedup pointer, even though it's called twice with identical output).
    const rawStatus = createTool({
      name: "raw_status",
      description: "Return a fixed raw status string, never to be touched by ContextPilot.",
      schema: z.object({ probe: z.string() }),
      func: async () => "STATUS_OK ".repeat(80).trim(),
    });

    type Phase =
      | "call_diff"
      | "call_search"
      | "call_raw_status"
      | "final_first_invoke"
      | "call_search_duplicate"
      | "call_raw_status_again"
      | "call_recover"
      | "final_second_invoke";
    let phase: Phase = "call_diff";
    let capturedDiffHash: string | undefined;
    const model: DeterministicModel = {
      modelName: "deterministic-grand-pipeline-v2-model",
      bindTools() { return model; },
      async invoke(messages: Message[]): Promise<Message> {
        if (phase === "call_diff") {
          phase = "call_search";
          return {
            role: "assistant",
            content: "",
            tool_calls: [{
              id: "call_diff_1",
              type: "function",
              name: "get_diff",
              args: { ref: "HEAD" },
              function: { name: "get_diff", arguments: JSON.stringify({ ref: "HEAD" }) },
            }],
          };
        }
        if (phase === "call_search") {
          const diffToolMessage = messages.find((m: any) => m.role === "tool" && m.name === "get_diff");
          capturedDiffHash = extractCcrHash((diffToolMessage as any)?.content);
          expect(capturedDiffHash).toBeTruthy();
          phase = "call_raw_status";
          return {
            role: "assistant",
            content: "",
            tool_calls: [{
              id: "call_search_1",
              type: "function",
              name: "grep_search",
              args: { pattern: "symbol" },
              function: { name: "grep_search", arguments: JSON.stringify({ pattern: "symbol" }) },
            }],
          };
        }
        if (phase === "call_raw_status") {
          phase = "final_first_invoke";
          return {
            role: "assistant",
            content: "",
            tool_calls: [{
              id: "call_raw_status_1",
              type: "function",
              name: "raw_status",
              args: { probe: "1" },
              function: { name: "raw_status", arguments: JSON.stringify({ probe: "1" }) },
            }],
          };
        }
        if (phase === "final_first_invoke") {
          phase = "call_search_duplicate";
          return { role: "assistant", content: "Reviewed the diff, the matches, and the status." };
        }
        if (phase === "call_search_duplicate") {
          phase = "call_raw_status_again";
          return {
            role: "assistant",
            content: "",
            tool_calls: [{
              id: "call_search_2",
              type: "function",
              name: "grep_search",
              args: { pattern: "symbol" },
              function: { name: "grep_search", arguments: JSON.stringify({ pattern: "symbol" }) },
            }],
          };
        }
        if (phase === "call_raw_status_again") {
          phase = "call_recover";
          return {
            role: "assistant",
            content: "",
            tool_calls: [{
              id: "call_raw_status_2",
              type: "function",
              name: "raw_status",
              args: { probe: "2" },
              function: { name: "raw_status", arguments: JSON.stringify({ probe: "2" }) },
            }],
          };
        }
        if (phase === "call_recover") {
          expect(capturedDiffHash).toBeTruthy();
          phase = "final_second_invoke";
          return {
            role: "assistant",
            content: "",
            tool_calls: [{
              id: "call_recover_1",
              type: "function",
              name: "get_tool_response",
              args: { executionId: capturedDiffHash },
              function: { name: "get_tool_response", arguments: JSON.stringify({ executionId: capturedDiffHash }) },
            }],
          };
        }
        return { role: "assistant", content: "Session complete: recovered the full diff." };
      },
    };

    const agent = createSmartAgent({
      name: "ContextPilotGrandPipelineAgentV2",
      model,
      tools: [getDiff, grepSearch, rawStatus],
      limits: { maxToolCalls: 8 },
      runtimeProfile: "deep",
      contextPilot: { excludeTools: ["raw_status"] },
    });

    const firstResult = await agent.invoke({
      messages: [{ role: "user", content: "Review the diff, search for the symbol, then check status." }],
    });

    const firstToolHistory = firstResult.state?.toolHistory || [];
    expect(firstToolHistory.length).toBe(3);

    const diffEntry = firstToolHistory.find((t: any) => t.toolName === "get_diff");
    expect(diffEntry?.contextPilot?.applied).toBe(true);
    expect(diffEntry?.contextPilot?.compressorUsed).toBe("diffCompressor");

    const searchEntry = firstToolHistory.find((t: any) => t.toolName === "grep_search");
    expect(searchEntry?.contextPilot?.applied).toBe(true);
    expect(searchEntry?.contextPilot?.compressorUsed).toBe("searchCompressor");

    const rawStatusEntry = firstToolHistory.find((t: any) => t.toolName === "raw_status");
    expect(rawStatusEntry?.contextPilot).toBeUndefined();
    expect(rawStatusEntry.output as string).toBe("STATUS_OK ".repeat(80).trim());

    // --- Second invoke: duplicate search (dedup) + excluded-tool repeat (no dedup) + CCR recovery ---
    const secondResult = await agent.invoke({
      messages: [
        ...firstResult.messages,
        { role: "user", content: "Search for the symbol again, recheck status, then retrieve the full diff." },
      ],
      toolHistory: firstResult.state?.toolHistory,
      toolHistoryArchived: firstResult.state?.toolHistoryArchived,
      ctx: firstResult.state?.ctx,
    } as any);

    const secondToolHistory = secondResult.state?.toolHistory || [];
    expect(secondToolHistory.length).toBe(6);

    const duplicateSearchEntry = secondToolHistory[3];
    expect(duplicateSearchEntry.toolName).toBe("grep_search");
    expect(duplicateSearchEntry.contextPilot?.applied).toBe(true);
    expect(duplicateSearchEntry.contextPilot?.duplicateOf).toBe(searchEntry.executionId);
    expect(duplicateSearchEntry.output as string).toContain("DUPLICATE_TOOL_RESPONSE");

    // The excluded tool's repeated identical call must NOT be flagged as a
    // duplicate, even though its output is byte-identical both times.
    const secondRawStatusEntry = secondToolHistory[4];
    expect(secondRawStatusEntry.toolName).toBe("raw_status");
    expect(secondRawStatusEntry.contextPilot).toBeUndefined();
    expect(secondRawStatusEntry.output as string).toBe("STATUS_OK ".repeat(80).trim());

    const recoveryEntry = secondToolHistory[5];
    expect(recoveryEntry.toolName).toBe("get_tool_response");
    expect(recoveryEntry.args.executionId).toBe(diffEntry.contextPilot.ccrHash);
    expect(recoveryEntry.output).toBe(diffEntry.rawOutput);
    expect(secondResult.content).toContain("Session complete: recovered the full diff.");
  });
});
