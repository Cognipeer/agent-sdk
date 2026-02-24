import { describe, expect, it, vi } from "vitest";
import { createWorkingMemoryTools, createLtmTools } from "../../src/memory/tools.js";

describe("memory tools", () => {
  it("working memory tools should set/get/snapshot facts", async () => {
    const stateRef: any = { state: { messages: [], ctx: {} } };
    const tools = createWorkingMemoryTools(stateRef);

    const setFact = tools.find((t) => t.name === "wm_set_fact");
    const getFact = tools.find((t) => t.name === "wm_get_fact");
    const snapshot = tools.find((t) => t.name === "wm_snapshot");

    expect(setFact).toBeDefined();
    expect(getFact).toBeDefined();
    expect(snapshot).toBeDefined();

    await setFact!.invoke?.({ key: "project", value: "agent-sdk", confidence: 0.9, source: "user" });
    const fact = await getFact!.invoke?.({ key: "project" });

    expect((fact as any).record.value).toBe("agent-sdk");
    expect((fact as any).record.confidence).toBe(0.9);

    const snap = await snapshot!.invoke?.({});
    expect((snap as any).facts.project.value).toBe("agent-sdk");
  });

  it("working memory tools should track decisions and open loops", async () => {
    const stateRef: any = { state: { messages: [], ctx: {} } };
    const tools = createWorkingMemoryTools(stateRef);

    const addDecision = tools.find((t) => t.name === "wm_add_decision");
    const addLoop = tools.find((t) => t.name === "wm_add_open_loop");
    const snapshot = tools.find((t) => t.name === "wm_snapshot");

    await addDecision!.invoke?.({ decision: "use adapter", rationale: "pluggable" });
    await addLoop!.invoke?.({ item: "write docs", status: "open" });

    const snap = await snapshot!.invoke?.({});
    expect((snap as any).decisions.length).toBe(1);
    expect((snap as any).openLoops.length).toBe(1);
  });

  it("ltm tools should delegate to adapter", async () => {
    const adapter = {
      write: vi.fn(async () => ({ ok: true, id: "1" })),
      search: vi.fn(async () => [{ id: "1", value: "hello", score: 0.9 }]),
      get: vi.fn(async () => ({ id: "1", value: "hello" })),
      forget: vi.fn(async () => ({ ok: true })),
    };

    const tools = createLtmTools(adapter as any);
    const write = tools.find((t) => t.name === "ltm_write");
    const search = tools.find((t) => t.name === "ltm_search");
    const get = tools.find((t) => t.name === "ltm_get");
    const forget = tools.find((t) => t.name === "ltm_forget");

    await write!.invoke?.({ value: "hello" });
    await search!.invoke?.({ query: "hello" });
    await get!.invoke?.({ id: "1" });
    await forget!.invoke?.({ id: "1" });

    expect(adapter.write).toHaveBeenCalledTimes(1);
    expect(adapter.search).toHaveBeenCalledTimes(1);
    expect(adapter.get).toHaveBeenCalledTimes(1);
    expect(adapter.forget).toHaveBeenCalledTimes(1);
  });
});
