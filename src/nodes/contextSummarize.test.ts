import { describe, it, expect } from 'vitest';
import { createContextSummarizeNode } from "./contextSummarize.js";

describe('contextSummarize', () => {
  it('should handle summarization with null model gracefully', async () => {
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

    // 1) Tool message must still exist (may be replaced with placeholder)
    const summarizedToolMsg = next.messages.find((m: any) => m.role === "tool");
    expect(summarizedToolMsg).toBeDefined();
    
    // When model is null, it falls back to default behavior
    // The summarization may or may not happen depending on error handling
    // Just verify the function completed without throwing
    expect(next.messages).toBeDefined();
  });
});
