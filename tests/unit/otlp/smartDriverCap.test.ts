/**
 * The smart driver's dangling-continuation strip block: a turn that ends with a
 * trace continuation no leg will take (the loop ran out of iterations right after
 * a summarization bounce) must export the held root once and must not hand the
 * continuation on, or the caller's next message would be recorded into this
 * turn's session.
 *
 * The summarizer is replaced by one that always "compresses" (a non-empty delta)
 * without ever shrinking the context, so every driver iteration is another
 * summarization pass and the iteration cap (30 at minimum) is what ends the turn.
 */
import { describe, expect, it, vi } from "vitest";
import { createSmartAgent, otlpSink } from "../../../src/index.js";
import { okResponse, spansOf } from "./helpers.js";

vi.mock("../../../src/nodes/contextSummarize.js", () => ({
  LAST_SUMMARIZATION_CALL_KEY: "__lastSummarizationCall",
  SUMMARIZATION_TRIGGER_KEY: "__summarizationTrigger",
  createContextSummarizeNode: () => async () => ({ ctx: {} }),
}));

describe("smart driver, iteration cap with a held trace continuation", () => {
  it("exports the root once and strips the continuation from the result", async () => {
    const bodies: any[] = [];
    const fetch = vi.fn(async (_url: string, init: any) => {
      bodies.push(JSON.parse(init.body));
      return okResponse();
    });
    let modelCalls = 0;
    const model: any = {
      modelName: "m",
      bindTools() { return model; },
      async invoke() { modelCalls += 1; return { role: "assistant", content: "never reached" }; },
    };
    const agent = createSmartAgent({
      name: "Capped",
      model,
      // Far over the threshold from the first message on, so the base agent bounces for summarization.
      summarization: { enable: true, maxTokens: 20, summaryPromptMaxTokens: 2000 },
      tracing: { enabled: true, sink: otlpSink({ endpoint: "https://c.example.test/v1/traces", fetch }) },
    } as any);
    const result: any = await agent.invoke({
      messages: [{ role: "user", content: "word ".repeat(400) }],
    } as any);

    // The cap ended the turn: the model was never asked for an answer.
    expect(modelCalls).toBe(0);
    // Nothing is handed on: the next message must open a new session.
    expect(result.state?.ctx?.__traceContinuation).toBeUndefined();

    // The root went out exactly once, with the close, and every parent resolves.
    const spans = bodies.flatMap(spansOf);
    const roots = spans.filter((s) => s.parentSpanId === "" && s.name.startsWith("invoke_agent"));
    expect(roots).toHaveLength(1);
    expect(roots[0].status.code).toBe(0);
    const ids = new Set(spans.map((s) => s.spanId));
    for (const span of spans) if (span !== roots[0]) expect(ids.has(span.parentSpanId), span.name).toBe(true);
  });
});
