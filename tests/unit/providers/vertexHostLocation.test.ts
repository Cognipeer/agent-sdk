/**
 * Vertex: one host function for Gemini and Claude (the us / eu multi-regions have
 * `rep` hosts), a Claude call with no configured location goes to `global`, and the
 * gcloud fallback has a configurable timeout with a message of its own.
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { VertexProvider } from "../../../src/providers/vertex.js";
import { vertexClaudeHost } from "../../../src/providers/vertexAnthropic.js";

// The gcloud fallback loads child_process lazily; a synchronous factory keeps the
// real CLI out of the tests.
vi.mock("child_process", () => ({ execFile: vi.fn() }));

// ─── helpers ─────────────────────────────────────────────────────────────────

type Call = { url: string; body: any };

const GEMINI_OK = { candidates: [{ content: { parts: [{ text: "ok" }] }, finishReason: "STOP" }], usageMetadata: {} };
const CLAUDE_OK = {
  id: "msg_1",
  type: "message",
  model: "claude-sonnet-5-5",
  content: [{ type: "text", text: "hello" }],
  stop_reason: "end_turn",
  usage: { input_tokens: 1, output_tokens: 1 },
};
const json = (o: any, status = 200) => new Response(JSON.stringify(o), { status, headers: { "content-type": "application/json" } });
const sse = (events: Array<[string, any]>) =>
  new Response(events.map(([name, data]) => `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`).join(""), {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
const CLAUDE_STREAM: Array<[string, any]> = [
  ["message_start", { type: "message_start", message: { id: "msg_s", model: "claude-sonnet-5-5", usage: { input_tokens: 10, output_tokens: 1 } } }],
  ["content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }],
  ["content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hi" } }],
  ["content_block_stop", { type: "content_block_stop", index: 0 }],
  ["message_delta", { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 2 } }],
  ["message_stop", { type: "message_stop" }],
];

/** A fake fetch; `reply` sees the URL, so one provider can serve a Gemini and a Claude call. */
function fakeFetch(reply: (url: string) => Response) {
  const calls: Call[] = [];
  const fn = (async (url: any, init: any) => {
    calls.push({ url: String(url), body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined });
    return reply(String(url));
  }) as unknown as typeof fetch;
  return { fn, calls };
}
const byModelPublisher = (url: string) => json(url.includes("/publishers/anthropic/") ? CLAUDE_OK : GEMINI_OK);

function vertex(fn: typeof fetch, extra: Record<string, any> = {}) {
  return new VertexProvider({ provider: "vertex", projectId: "proj", accessToken: "tok", fetch: fn, retry: { maxRetries: 0 }, ...extra } as any);
}

const msgs = [{ role: "user" as const, content: "hi" }];
const gemini = { model: "gemini-3-flash-preview", messages: msgs };
const claude = { model: "claude-sonnet-5-5", messages: msgs };

afterEach(() => {
  vi.restoreAllMocks();
});

// ─── R2: one host function ───────────────────────────────────────────────────

describe("Vertex host for the us / eu multi-regions (Gemini)", () => {
  it.each([
    ["us", "https://aiplatform.us.rep.googleapis.com"],
    ["eu", "https://aiplatform.eu.rep.googleapis.com"],
  ])("chat on location %s", async (location, host) => {
    const { fn, calls } = fakeFetch(() => json(GEMINI_OK));
    await vertex(fn, { location }).complete(gemini);
    // The path keeps the multi-region name; only the host changes.
    expect(calls[0].url).toBe(`${host}/v1/projects/proj/locations/${location}/publishers/google/models/gemini-3-flash-preview:generateContent`);
  });

  it.each([
    ["us", "https://aiplatform.us.rep.googleapis.com"],
    ["eu", "https://aiplatform.eu.rep.googleapis.com"],
  ])("streaming on location %s", async (location, host) => {
    const { fn, calls } = fakeFetch(
      () => new Response('data: {"candidates":[{"content":{"parts":[{"text":"a"}]},"finishReason":"STOP"}]}\n\n', { status: 200, headers: { "content-type": "text/event-stream" } }),
    );
    for await (const _ of vertex(fn, { location }).completeStream(gemini)) void _;
    expect(calls[0].url).toBe(`${host}/v1/projects/proj/locations/${location}/publishers/google/models/gemini-3-flash-preview:streamGenerateContent?alt=sse`);
  });

  it.each([
    ["us", "https://aiplatform.us.rep.googleapis.com"],
    ["eu", "https://aiplatform.eu.rep.googleapis.com"],
  ])("embeddings on location %s", async (location, host) => {
    const { fn, calls } = fakeFetch(() => json({ predictions: [{ embeddings: { values: [1] } }] }));
    await vertex(fn, { location }).embed({ model: "text-embedding-005", input: ["a"] });
    expect(calls[0].url).toBe(`${host}/v1/projects/proj/locations/${location}/publishers/google/models/text-embedding-005:predict`);
  });

  it("global and regional locations keep their hosts", async () => {
    const g = fakeFetch(() => json(GEMINI_OK));
    await vertex(g.fn, { location: "global" }).complete(gemini);
    expect(g.calls[0].url.startsWith("https://aiplatform.googleapis.com/v1/projects/proj/locations/global/")).toBe(true);

    const r = fakeFetch(() => json(GEMINI_OK));
    await vertex(r.fn, { location: "europe-west4" }).complete(gemini);
    expect(r.calls[0].url.startsWith("https://europe-west4-aiplatform.googleapis.com/v1/projects/proj/locations/europe-west4/")).toBe(true);
  });

  it.each(["global", "us", "eu", "us-east5", "europe-west4"])("Gemini and Claude reach the same host for %s (vertexClaudeHost)", async (location) => {
    const { fn, calls } = fakeFetch(byModelPublisher);
    const p = vertex(fn, { location });
    await p.complete(gemini);
    await p.complete(claude);
    const hosts = calls.map((c) => new URL(c.url).host);
    expect(hosts[0]).toBe(hosts[1]);
    expect(hosts[0]).toBe(vertexClaudeHost(location));
    expect(calls[0].url).toContain(`/locations/${location}/publishers/google/`);
    expect(calls[1].url).toContain(`/locations/${location}/publishers/anthropic/`);
  });
});

// ─── R4: Claude with no location goes to global ──────────────────────────────

describe("Claude on Vertex: default location", () => {
  it("with no location configured Claude goes to global and Gemini keeps us-central1", async () => {
    const { fn, calls } = fakeFetch(byModelPublisher);
    const p = vertex(fn);
    await p.complete({ model: "gemini-2.0-flash", messages: msgs });
    await p.complete(claude);
    expect(calls[0].url).toBe("https://us-central1-aiplatform.googleapis.com/v1/projects/proj/locations/us-central1/publishers/google/models/gemini-2.0-flash:generateContent");
    expect(calls[1].url).toBe("https://aiplatform.googleapis.com/v1/projects/proj/locations/global/publishers/anthropic/models/claude-sonnet-5-5:rawPredict");
  });

  it("streaming goes to global too", async () => {
    const { fn, calls } = fakeFetch(() => sse(CLAUDE_STREAM));
    for await (const _ of vertex(fn).completeStream(claude)) void _;
    expect(calls[0].url).toBe("https://aiplatform.googleapis.com/v1/projects/proj/locations/global/publishers/anthropic/models/claude-sonnet-5-5:streamRawPredict");
  });

  it("the publisher path, a dated id and the default model route to global as well", async () => {
    const { fn, calls } = fakeFetch(() => json(CLAUDE_OK));
    const p = vertex(fn, { defaultModel: "claude-opus-5-5" });
    await p.complete({ model: "publishers/anthropic/models/claude-haiku-4-5-20251001", messages: msgs });
    await p.complete({ messages: msgs } as any);
    expect(calls[0].url).toBe("https://aiplatform.googleapis.com/v1/projects/proj/locations/global/publishers/anthropic/models/claude-haiku-4-5@20251001:rawPredict");
    expect(calls[1].url).toBe("https://aiplatform.googleapis.com/v1/projects/proj/locations/global/publishers/anthropic/models/claude-opus-5-5:rawPredict");
  });

  it("an explicit location is used as given for Claude, whichever it is", async () => {
    for (const location of ["us-east5", "us-central1", "europe-west1", "eu", "us", "global"]) {
      const { fn, calls } = fakeFetch(() => json(CLAUDE_OK));
      await vertex(fn, { location }).complete(claude);
      expect(calls[0].url, location).toBe(`https://${vertexClaudeHost(location)}/v1/projects/proj/locations/${location}/publishers/anthropic/models/claude-sonnet-5-5:rawPredict`);
    }
  });

  it("a blank location counts as not set", async () => {
    for (const location of ["", "   "]) {
      const { fn, calls } = fakeFetch(byModelPublisher);
      const p = vertex(fn, { location });
      await p.complete(claude);
      await p.complete({ model: "gemini-2.0-flash", messages: msgs });
      expect(calls[0].url, JSON.stringify(location)).toContain("/locations/global/publishers/anthropic/");
      expect(calls[1].url, JSON.stringify(location)).toContain("/locations/us-central1/publishers/google/");
    }
  });

  it("Gemini keeps us-central1 as its default for every call type", async () => {
    const chat = fakeFetch(() => json(GEMINI_OK));
    await vertex(chat.fn).complete(gemini);
    expect(chat.calls[0].url.startsWith("https://us-central1-aiplatform.googleapis.com/v1/projects/proj/locations/us-central1/")).toBe(true);

    const emb = fakeFetch(() => json({ predictions: [{ embeddings: { values: [1] } }] }));
    await vertex(emb.fn).embed({ model: "text-embedding-005", input: ["a"] });
    expect(emb.calls[0].url.startsWith("https://us-central1-aiplatform.googleapis.com/v1/projects/proj/locations/us-central1/")).toBe(true);
  });
});

// ─── R12: gcloud fallback timeout ────────────────────────────────────────────

describe("Vertex gcloud fallback timeout", () => {
  const noAuth = (fn: typeof fetch, extra: Record<string, any> = {}) =>
    new VertexProvider({ provider: "vertex", projectId: "proj", fetch: fn, retry: { maxRetries: 0 }, ...extra } as any);
  const execMock = async () => {
    const cp: any = await import("child_process");
    return cp.execFile as ReturnType<typeof vi.fn>;
  };
  const prints = (token: string) => (_cmd: string, _args: string[], _opts: any, cb: (e: any, out?: string, err?: string) => void) => {
    setTimeout(() => cb(null, `${token}\n`, ""), 0);
    return {} as any;
  };
  /** What Node hands back when its timeout kills the child. */
  const killed = () => Object.assign(new Error("Command failed: gcloud auth print-access-token"), { killed: true, signal: "SIGTERM", code: null });
  const fails = (error: any) => (_cmd: string, _args: string[], _opts: any, cb: (e: any) => void) => {
    setTimeout(() => cb(error), 0);
    return {} as any;
  };

  it("defaults to 30 seconds", async () => {
    const execFile = await execMock();
    execFile.mockReset();
    execFile.mockImplementation(prints("tok"));
    await noAuth(fakeFetch(() => json(GEMINI_OK)).fn).complete(gemini);
    expect(execFile.mock.calls[0][2].timeout).toBe(30_000);
  });

  it("gcloudTimeoutMs sets it (a fraction is rounded down)", async () => {
    const execFile = await execMock();
    for (const [configured, used] of [[120_000, 120_000], [1500.9, 1500], [1, 1]] as const) {
      execFile.mockReset();
      execFile.mockImplementation(prints("tok"));
      await noAuth(fakeFetch(() => json(GEMINI_OK)).fn, { gcloudTimeoutMs: configured }).complete(gemini);
      expect(execFile.mock.calls[0][2].timeout, String(configured)).toBe(used);
    }
  });

  it("a value that is not a positive finite number falls back to the default", async () => {
    const execFile = await execMock();
    for (const bad of [0, -5, Number.NaN, Number.POSITIVE_INFINITY, "5000", null, undefined]) {
      execFile.mockReset();
      execFile.mockImplementation(prints("tok"));
      await noAuth(fakeFetch(() => json(GEMINI_OK)).fn, { gcloudTimeoutMs: bad }).complete(gemini);
      expect(execFile.mock.calls[0][2].timeout, String(bad)).toBe(30_000);
    }
  });

  it("the timeout is not used when accessToken is given (gcloud is never run)", async () => {
    const execFile = await execMock();
    execFile.mockReset();
    await vertex(fakeFetch(() => json(GEMINI_OK)).fn, { gcloudTimeoutMs: 100 }).complete(gemini);
    expect(execFile).not.toHaveBeenCalled();
  });

  it("a killed child is reported as a timeout: gcloud named, the limit stated, the setting suggested", async () => {
    const execFile = await execMock();
    execFile.mockReset();
    execFile.mockImplementation(fails(killed()));
    const p = noAuth(fakeFetch(() => json(GEMINI_OK)).fn, { gcloudTimeoutMs: 45_000 });
    const error: any = await p.complete(gemini).catch((e) => e);
    expect(error).toMatchObject({ name: "ProviderError", provider: "vertex" });
    expect(error.message).toMatch(/gcloud timed out after 45000 ms/);
    expect(error.message).toContain("gcloudTimeoutMs");
    expect(error.message).toContain("accessToken");
    // Not the "not authenticated" message: that would send the reader to the wrong fix.
    expect(error.message).not.toContain("No access token available");
  });

  it("the default limit is the one named when none was configured", async () => {
    const execFile = await execMock();
    execFile.mockReset();
    execFile.mockImplementation(fails(killed()));
    await expect(noAuth(fakeFetch(() => json(GEMINI_OK)).fn).complete(gemini)).rejects.toThrow(/gcloud timed out after 30000 ms/);
  });

  it("a failure that is not a timeout keeps the original message", async () => {
    const execFile = await execMock();
    const expected = "No access token available. Provide accessToken, serviceAccountJson, or ensure gcloud CLI is authenticated.";
    for (const error of [
      new Error("gcloud: command not found"),
      Object.assign(new Error("spawn gcloud ENOENT"), { code: "ENOENT" }),
      Object.assign(new Error("Command failed"), { killed: false, signal: null, code: 3 }),
    ]) {
      execFile.mockReset();
      execFile.mockImplementation(fails(error));
      await expect(noAuth(fakeFetch(() => json(GEMINI_OK)).fn).complete(gemini)).rejects.toThrow(expected);
    }
  });

  it("a timeout is not cached: the next call runs gcloud again", async () => {
    const execFile = await execMock();
    execFile.mockReset();
    execFile.mockImplementationOnce(fails(killed()));
    execFile.mockImplementationOnce(prints("later"));
    const f = fakeFetch(() => json(GEMINI_OK));
    const p = noAuth(f.fn);
    await expect(p.complete(gemini)).rejects.toThrow(/gcloud timed out/);
    await p.complete(gemini);
    expect(execFile).toHaveBeenCalledTimes(2);
    expect(f.calls).toHaveLength(1);
  });

  it("applies to a Claude call as well: the same token handling", async () => {
    const execFile = await execMock();
    execFile.mockReset();
    execFile.mockImplementation(fails(killed()));
    await expect(noAuth(fakeFetch(() => json(CLAUDE_OK)).fn, { gcloudTimeoutMs: 7000 }).complete(claude)).rejects.toThrow(/gcloud timed out after 7000 ms/);
  });
});
