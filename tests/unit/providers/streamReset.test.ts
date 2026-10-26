/**
 * A `reset: true` chunk starts the answer over inside one stream (a host that
 * retries a call cut off by its output limit): the final message holds only the
 * new attempt, thinking blocks included, while usage stays cumulative.
 */

import { describe, it, expect } from "vitest";
import { fromNativeProvider } from "../../../src/providers/adapter.js";

const usage = (input: number, output: number) => ({
  inputTokens: input,
  outputTokens: output,
  totalTokens: input + output,
  cachedInputTokens: 0,
  cachedWriteTokens: 0,
  cachedOutputTokens: 0,
  reasoningTokens: 0,
});

function retryingProvider() {
  return {
    providerName: "openai-compatible",
    defaultModel: "fake",
    async complete() { throw new Error("not used"); },
    async *completeStream() {
      // First attempt: thinking only, then the output limit.
      yield { id: "a1", model: "fake", delta: { reasoning: { summary: "first thoughts", blocks: [{ type: "thinking", text: "first thoughts", signature: "sig-1" }] } } };
      yield { id: "a1", model: "fake", delta: { toolCalls: [{ id: "c1", name: "write_file", arguments: "{\"pa" }] } };
      yield { id: "a1", model: "fake", delta: {}, usage: usage(100, 50), finishReason: "length", rawFinishReason: "max_tokens" };
      // The retry.
      yield { id: "a2", model: "fake", delta: {}, reset: true };
      yield { id: "a2", model: "fake", delta: { reasoning: { summary: "second thoughts", blocks: [{ type: "thinking", text: "second thoughts", signature: "sig-2" }] } } };
      yield { id: "a2", model: "fake", delta: { content: "the answer" } };
      yield { id: "a2", model: "fake", delta: {}, usage: usage(200, 80), finishReason: "stop", rawFinishReason: "end_turn" };
    },
  } as any;
}

async function finalMessage(provider: any) {
  const model: any = fromNativeProvider(provider);
  let last: any;
  for await (const part of model.stream([{ role: "user", content: "go" }])) {
    if (part && typeof part === "object" && part.role === "assistant") last = part;
  }
  return last;
}

describe("stream reset chunk", () => {
  it("keeps only the retry's text, tool calls, thinking and finish reason", async () => {
    const msg = await finalMessage(retryingProvider());
    expect(msg.content).toBe("the answer");
    expect(msg.tool_calls ?? []).toHaveLength(0);
    expect(msg.reasoning?.blocks).toEqual([{ type: "thinking", text: "second thoughts", signature: "sig-2" }]);
    expect(msg.reasoning?.text ?? msg.reasoning?.summary ?? "").not.toContain("first thoughts");
    expect(msg.response_metadata?.finish_reason).toBe("stop");
  });

  it("keeps the last cumulative usage", async () => {
    const msg = await finalMessage(retryingProvider());
    expect(msg.usage.prompt_tokens).toBe(200);
    expect(msg.usage.completion_tokens).toBe(80);
  });
});
