import { createContextSummarizeNode } from "./contextSummarize.js";

/**
 * Minimal regression test runner (no jest/vitest dependency in this package).
 * Run via: tsx src/nodes/contextSummarize.test.ts
 */
function assert(condition: any, message: string) {
  if (!condition) throw new Error(`Assertion failed: ${message}`);
}

async function run() {
  const summarizer = createContextSummarizeNode({
    summarization: true,
    limits: { summaryTokenLimit: 5000 },
    // We don't want to call a real model in tests. The node tolerates missing model.invoke
    // and will fall back to a default summary text.
    model: null as any,
  } as any);

  const execId = "exec_test_1";
  const state: any = {
    messages: [
      { role: "user", content: "hello" },
      {
        role: "assistant",
        content: "calling tool",
        tool_calls: [
          {
            id: "call_1",
            type: "function",
            function: { name: "search_in_knowledgebase", arguments: "{\"query\":\"x\"}" },
          },
        ],
      },
      {
        role: "tool",
        name: "search_in_knowledgebase",
        tool_call_id: "call_1",
        content: "RAW_TOOL_PAYLOAD: result A, result B",
      },
    ],
    toolHistory: [
      {
        executionId: execId,
        toolName: "search_in_knowledgebase",
        tool_call_id: "call_1",
        output: "RAW_TOOL_PAYLOAD: result A, result B",
        rawOutput: "RAW_TOOL_PAYLOAD: result A, result B",
        timestamp: new Date().toISOString(),
      },
    ],
    toolHistoryArchived: [],
    ctx: {},
  };

  const delta = await summarizer(state);
  const next = { ...state, ...delta };

  // 1) Tool message must be replaced with placeholder (still present)
  const summarizedToolMsg = next.messages.find((m: any) => m.role === "tool");
  assert(!!summarizedToolMsg, "tool message still exists");
  assert(
    typeof summarizedToolMsg.content === "string" && summarizedToolMsg.content.includes(execId),
    "tool message contains executionId so it is retrievable"
  );

  // 2) Archive must contain the live toolHistory entry so get_tool_response can find it
  const archivedMatch = (next.toolHistoryArchived || []).find((t: any) => t.executionId === execId);
  assert(!!archivedMatch, "toolHistory entry archived by executionId");
  assert(
    (archivedMatch.rawOutput || archivedMatch.output) === "RAW_TOOL_PAYLOAD: result A, result B",
    "archived payload preserved"
  );

  // 3) Live toolHistory should be cleared
  assert(Array.isArray(next.toolHistory) && next.toolHistory.length === 0, "toolHistory cleared after summarization");

  console.log("contextSummarize regression test: OK");
}

run().catch((e) => {
  console.error("contextSummarize regression test: FAILED");
  console.error(e);
  process.exit(1);
});
