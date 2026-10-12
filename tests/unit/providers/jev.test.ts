import { describe, it, expect, vi, afterEach } from "vitest";
import { createProvider, JevProvider, ProviderError } from "../../../src/providers/index.js";

afterEach(() => vi.unstubAllGlobals());

const ok = { answers: { q: { type: "noul", noul: 0.2 } }, usage: { input_tokens: 5, output_tokens: 1 } };

describe("JevProvider", () => {
  it("is created by the provider factory", () => {
    expect(createProvider({ provider: "jev", apiKey: "k" })).toBeInstanceOf(JevProvider);
  });

  it("POSTs System One with bearer auth, default model and a custom baseURL", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(ok), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const p = new JevProvider({ provider: "jev", apiKey: "k", baseURL: "https://jev.example/", defaultModel: "jev-mini" });

    const res = await p.systemOne({ state: "hi", questions: { q: { type: "noul" } } });

    expect(res.answers?.q?.noul).toBe(0.2);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://jev.example/v1/systemone");
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer k");
    expect(JSON.parse(init.body as string)).toMatchObject({ model: "jev-mini", state: "hi" });
  });

  it("a per-call model wins over the default", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(ok), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const p = new JevProvider({ provider: "jev", apiKey: "k", defaultModel: "a" });
    await p.systemOne({ state: "s", questions: {}, model: "b" });
    expect(JSON.parse((fetchMock.mock.calls[0] as any)[1].body).model).toBe("b");
  });

  it("raises ProviderError with the status on a non-2xx response", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("nope", { status: 401 })));
    const p = new JevProvider({ provider: "jev", apiKey: "bad" });
    await expect(p.systemOne({ state: "s", questions: {} })).rejects.toMatchObject({
      name: "ProviderError",
      provider: "jev",
      statusCode: 401,
    });
  });

  it("retries a 503 and then succeeds", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response("busy", { status: 503 }))
      .mockResolvedValueOnce(new Response(JSON.stringify(ok), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const p = new JevProvider({ provider: "jev", apiKey: "k", retry: { baseDelayMs: 1, maxDelayMs: 1 } });
    await expect(p.systemOne({ state: "s", questions: {} })).resolves.toBeTruthy();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("has no chat completion", async () => {
    const p = new JevProvider({ provider: "jev", apiKey: "k" });
    await expect(p.complete({ model: "m", messages: [] })).rejects.toBeInstanceOf(ProviderError);
  });
});
