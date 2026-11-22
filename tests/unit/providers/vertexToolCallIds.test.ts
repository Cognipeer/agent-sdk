/**
 * The id of a Gemini function call that came without one (CC-360).
 *
 * Gemini often sends `functionCall` with no `id`, and the provider makes one up. The id used to be `call_<position>`,
 * which starts at 0 again in every response: two different calls in one conversation both became `call_0`. A consumer
 * that keys a call by its id (tool results, approvals, a cache of answers such as a device's replay cache) then mixed
 * them up. An id made up now is `call_<scope>_<position>`, with a scope that is new for every response or stream, and
 * it travels with the call through approval, resume and a retried resume.
 */

import { describe, it, expect } from "vitest";
import { z } from "zod";
import { VertexProvider } from "../../../src/providers/vertex.js";
import { fromNativeProvider } from "../../../src/providers/adapter.js";
import { createSmartAgent, createTool } from "../../../src/index.js";

// ─── helpers ─────────────────────────────────────────────────────────────────

const MODEL = "gemini-3-flash-preview";
const SYNTHESIZED = /^call_[0-9a-z]{12}_\d+$/;

const json = (o: any) => new Response(JSON.stringify(o), { status: 200, headers: { "content-type": "application/json" } });
const sseOf = (...objs: any[]) =>
  new Response(objs.map((o) => `data: ${JSON.stringify(o)}\n\n`).join(""), { status: 200, headers: { "content-type": "text/event-stream" } });
const gemini = (parts: any[], finishReason = "STOP") => ({ candidates: [{ content: { role: "model", parts }, finishReason }], usageMetadata: {} });
const fnCall = (name: string, args: Record<string, unknown>, id?: string) => ({ functionCall: { name, args, ...(id ? { id } : {}) } });

async function collect<T>(it: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const x of it) out.push(x);
  return out;
}

/** A provider whose every answer is built by `reply` from the request (streamed as one SSE chunk when asked to stream). */
function vertexAnswering(reply: (body: any) => any) {
  const fn = (async (url: any, init: any) => {
    const body = JSON.parse(init.body);
    const answer = reply(body);
    return String(url).includes("streamGenerateContent") ? sseOf(answer) : json(answer);
  }) as unknown as typeof fetch;
  return new VertexProvider({ provider: "vertex", projectId: "proj", accessToken: "tok", fetch: fn, retry: { maxRetries: 0 } } as any);
}

/** Function responses the request carries after the person's last message. */
function resultsSinceLastUserText(body: any): number {
  const contents: any[] = body.contents ?? [];
  let count = 0;
  for (let i = contents.length - 1; i >= 0; i -= 1) {
    const parts: any[] = contents[i].parts ?? [];
    if (contents[i].role === "user" && parts.some((p) => typeof p.text === "string")) break;
    count += parts.filter((p) => p.functionResponse).length;
  }
  return count;
}

/** The model asks for `read_file {path: "same.txt"}` (no id) `calls` times after each user message, then answers. */
function modelThatReadsSameFile(calls: number) {
  return vertexAnswering((body) =>
    resultsSinceLastUserText(body) < calls ? gemini([fnCall("read_file", { path: "same.txt" })]) : gemini([{ text: "done" }]),
  );
}

const user = (content: string) => ({ role: "user" as const, content });
const persist = (state: any) => JSON.parse(JSON.stringify({ ...state, agent: undefined }));
const pendingOf = (state: any) => (state?.pendingApprovals || []).filter((a: any) => a.status === "pending");
const toolMessages = (state: any) => (state?.messages ?? []).filter((m: any) => m.role === "tool");

/** A read tool that records the call id it is given. */
function recordingReadTool(seen: string[]) {
  return createTool({
    name: "read_file",
    description: "Read a file.",
    schema: z.object({ path: z.string() }),
    func: async ({ path }: { path: string }, ctx?: { toolCallId?: string }) => {
      seen.push(ctx?.toolCallId ?? "<none>");
      return `contents of ${path} (${seen.length})`;
    },
  });
}

// ─── the provider ────────────────────────────────────────────────────────────

describe("Vertex: an id made up for a function call is unique to its response", () => {
  it("non-streaming: two responses get two ids, both marked as made up", async () => {
    const provider = vertexAnswering(() => gemini([fnCall("read_file", { path: "same.txt" })]));
    const first = await provider.complete({ model: MODEL, messages: [user("read")] });
    const second = await provider.complete({ model: MODEL, messages: [user("read")] });
    const [a] = first.toolCalls;
    const [b] = second.toolCalls;
    expect(a.id).toMatch(SYNTHESIZED);
    expect(b.id).toMatch(SYNTHESIZED);
    expect(a.id).not.toBe(b.id);
    expect(a.idSynthesized).toBe(true);
    expect(b.idSynthesized).toBe(true);
  });

  it("non-streaming: the calls of one response share its scope and differ by position", async () => {
    const provider = vertexAnswering(() => gemini([fnCall("read_file", { path: "a" }), fnCall("read_file", { path: "b" })]));
    const { toolCalls } = await provider.complete({ model: MODEL, messages: [user("read")] });
    expect(toolCalls).toHaveLength(2);
    const [scopeA, posA] = toolCalls[0].id.split("_").slice(1);
    const [scopeB, posB] = toolCalls[1].id.split("_").slice(1);
    expect(scopeA).toBe(scopeB);
    expect([posA, posB]).toEqual(["0", "1"]);
  });

  it("an id Gemini sends is kept as is and is not marked as made up", async () => {
    const provider = vertexAnswering(() => gemini([fnCall("read_file", { path: "a" }, "fc-7")]));
    const { toolCalls } = await provider.complete({ model: MODEL, messages: [user("read")] });
    expect(toolCalls[0].id).toBe("fc-7");
    expect(toolCalls[0].idSynthesized).toBeUndefined();
  });

  it("streaming: calls in separate chunks of one stream get one scope; another stream gets another", async () => {
    const chunk = (parts: any[], finishReason?: string) => ({ candidates: [{ content: { role: "model", parts }, ...(finishReason ? { finishReason } : {}) }] });
    const fn = (async () =>
      sseOf(chunk([fnCall("read_file", { path: "a" })]), chunk([fnCall("read_file", { path: "b" })], "STOP"))) as unknown as typeof fetch;
    const provider = new VertexProvider({ provider: "vertex", projectId: "proj", accessToken: "tok", fetch: fn, retry: { maxRetries: 0 } } as any);
    const idsOf = async () =>
      (await collect(provider.completeStream({ model: MODEL, messages: [user("read")] })))
        .flatMap((c) => c.delta.toolCalls ?? [])
        .map((tc) => tc.id as string);
    const first = await idsOf();
    const second = await idsOf();
    expect(first).toHaveLength(2);
    expect(second).toHaveLength(2);
    for (const id of [...first, ...second]) expect(id).toMatch(SYNTHESIZED);
    expect(new Set(first.map((id) => id.split("_")[1])).size).toBe(1);
    expect(first[0]).not.toBe(first[1]);
    expect(first[0].split("_")[1]).not.toBe(second[0].split("_")[1]);
  });
});

// ─── through an agent ────────────────────────────────────────────────────────

describe.each([
  { mode: "invoke", config: undefined },
  { mode: "stream", config: { stream: true } },
])("an agent on Vertex ($mode): identical calls without ids run as separate invocations", ({ config }) => {
  it("two responses in one run, same arguments: two runs of the tool with two ids, each result paired with its call", async () => {
    const seen: string[] = [];
    const agent = createSmartAgent({ model: fromNativeProvider(modelThatReadsSameFile(2), { model: MODEL }), tools: [recordingReadTool(seen)] } as never);
    const result: any = await agent.invoke({ messages: [user("Read same.txt twice.")] } as never, config as never);

    expect(seen).toHaveLength(2);
    expect(new Set(seen).size).toBe(2);
    for (const id of seen) expect(id).toMatch(SYNTHESIZED);
    const callIds = (result.state.messages as any[]).flatMap((m) => (m.tool_calls ?? []).map((tc: any) => tc.id));
    expect(callIds).toEqual(seen);
    expect(toolMessages(result.state).map((m: any) => m.tool_call_id)).toEqual(seen);
  });

  it("two turns of one conversation, same arguments: each turn's call has its own id", async () => {
    const seen: string[] = [];
    const agent = createSmartAgent({ model: fromNativeProvider(modelThatReadsSameFile(1), { model: MODEL }), tools: [recordingReadTool(seen)] } as never);
    const first: any = await agent.invoke({ messages: [user("Read same.txt.")] } as never, config as never);
    const second: any = await agent.invoke({ messages: [...first.state.messages, user("Read it again.")] } as never, config as never);

    expect(second.state.messages.at(-1).content).toBe("done");
    expect(seen).toHaveLength(2);
    expect(seen[0]).not.toBe(seen[1]);
  });
});

describe("an agent on Vertex: a call that waits for approval keeps its id", () => {
  it("the approved call runs with the id it was approved under, and a retried resume runs under the same id", async () => {
    const seen: string[] = [];
    // A consumer that keys work by call id, like a device's replay cache: the same id is answered once.
    const answers = new Map<string, string>();
    let executions = 0;
    const tool = createTool({
      name: "read_file",
      description: "Read a file on the person's device.",
      schema: z.object({ path: z.string() }),
      needsApproval: true,
      func: async ({ path }: { path: string }, ctx?: { toolCallId?: string }) => {
        const id = ctx?.toolCallId ?? "<none>";
        seen.push(id);
        const known = answers.get(id);
        if (known) return known;
        executions += 1;
        const answer = `contents of ${path} (run ${executions})`;
        answers.set(id, answer);
        return answer;
      },
    });
    const agent: any = createSmartAgent({ model: fromNativeProvider(modelThatReadsSameFile(1), { model: MODEL }), tools: [tool] } as never);

    const paused: any = await agent.invoke({ messages: [user("Read same.txt.")] } as never);
    const pending = pendingOf(paused.state);
    expect(pending).toHaveLength(1);
    const approvedId = pending[0].toolCallId;
    expect(approvedId).toMatch(SYNTHESIZED);

    const approved = agent.resolveToolApproval(persist(paused.state), { id: pending[0].id, approved: true });
    const resumed: any = await agent.invoke(persist(approved));
    // The same resume again, as a server would retry it after losing the first answer.
    const retried: any = await agent.invoke(persist(approved));

    expect(seen).toEqual([approvedId, approvedId]);
    expect(executions).toBe(1);
    for (const result of [resumed, retried]) {
      const [toolMessage] = toolMessages(result.state);
      expect(toolMessage.tool_call_id).toBe(approvedId);
      expect(toolMessage.content).toContain("run 1");
    }
  });
});
