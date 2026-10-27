import { describe, it, expect, vi, afterEach } from "vitest";
import { generateKeyPairSync } from "node:crypto";
import { VertexProvider } from "../../../src/providers/vertex.js";
import { sanitizeGeminiSchema } from "../../../src/providers/utils/geminiSchema.js";
import type { ChatCompletionRequest } from "../../../src/providers/types.js";

// The gcloud fallback loads child_process lazily; a synchronous factory keeps the
// real CLI out of the tests.
vi.mock("child_process", () => ({ execFile: vi.fn() }));

// ─── helpers ─────────────────────────────────────────────────────────────────

type Call = { url: string; headers: Record<string, string>; body: any; raw: string };

const OK_BODY = { candidates: [{ content: { parts: [{ text: "ok" }] }, finishReason: "STOP" }], usageMetadata: {} };
const json = (o: any, status = 200) => new Response(JSON.stringify(o), { status, headers: { "content-type": "application/json" } });

type FakeOpts = {
  /** Responses of the OAuth token endpoint, in order (the last one repeats). */
  tokens?: Array<() => Response | Promise<Response>>;
  vertex?: () => Response;
};

/** A fake fetch that tells the OAuth token endpoint apart from the Vertex API. */
function fakeFetch(opts: FakeOpts = {}) {
  const calls: Call[] = [];
  const tokenCalls: Call[] = [];
  let tokenIdx = 0;
  const fn = (async (url: any, init: any) => {
    const raw = typeof init?.body === "string" ? init.body : "";
    let body: any = raw;
    try {
      body = JSON.parse(raw);
    } catch {
      /* form body */
    }
    const call: Call = { url: String(url), headers: init?.headers ?? {}, body, raw };
    if (call.url.startsWith("https://oauth2.googleapis.com/token")) {
      tokenCalls.push(call);
      const make = opts.tokens?.[Math.min(tokenIdx++, opts.tokens.length - 1)];
      return make ? make() : json({ access_token: `tok-${tokenCalls.length}`, expires_in: 3600 });
    }
    calls.push(call);
    return opts.vertex ? opts.vertex() : json(OK_BODY);
  }) as unknown as typeof fetch;
  return { fn, calls, tokenCalls };
}

const rsa = () =>
  generateKeyPairSync("rsa", {
    modulusLength: 2048,
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  }).privateKey;
const KEY_A = rsa();
const KEY_B = rsa();

let saCounter = 0;
/** A fresh service-account email per test: the token cache is process-wide. */
const freshEmail = () => `sa-${++saCounter}-${Math.random().toString(36).slice(2, 8)}@proj.iam.gserviceaccount.com`;
const saJson = (email: string, key = KEY_A) => JSON.stringify({ client_email: email, private_key: key });

const msgs = [{ role: "user" as const, content: "hi" }];
const bodyOf = (call: Call) => call.body;

function provider(fn: typeof fetch, extra: Record<string, any> = {}) {
  return new VertexProvider({ provider: "vertex", projectId: "proj", accessToken: "tok", fetch: fn, ...extra } as any);
}

afterEach(() => {
  vi.restoreAllMocks();
});

// ─── VTX-7: global location ──────────────────────────────────────────────────

describe("Vertex location 'global'", () => {
  it("chat uses the plain aiplatform.googleapis.com host", async () => {
    const { fn, calls } = fakeFetch();
    await provider(fn, { location: "global" }).complete({ model: "gemini-3-pro", messages: msgs });
    expect(calls[0].url).toBe(
      "https://aiplatform.googleapis.com/v1/projects/proj/locations/global/publishers/google/models/gemini-3-pro:generateContent",
    );
  });

  it("streaming uses the plain host too", async () => {
    const { fn, calls } = fakeFetch({
      vertex: () => new Response('data: {"candidates":[{"content":{"parts":[{"text":"a"}]},"finishReason":"STOP"}]}\n\n', { headers: { "content-type": "text/event-stream" } }),
    });
    for await (const _ of provider(fn, { location: "global" }).completeStream({ model: "gemini-3-pro", messages: msgs })) void _;
    expect(calls[0].url.startsWith("https://aiplatform.googleapis.com/v1/projects/proj/locations/global/")).toBe(true);
    expect(calls[0].url).toContain(":streamGenerateContent");
  });

  it("embeddings use the plain host", async () => {
    const { fn, calls } = fakeFetch({ vertex: () => json({ predictions: [{ embeddings: { values: [1] } }] }) });
    await provider(fn, { location: "global" }).embed({ model: "text-embedding-005", input: ["a"] });
    expect(calls[0].url).toBe("https://aiplatform.googleapis.com/v1/projects/proj/locations/global/publishers/google/models/text-embedding-005:predict");
  });

  it("every other location keeps its regional host", async () => {
    const { fn, calls } = fakeFetch();
    await provider(fn, { location: "europe-west4" }).complete({ model: "gemini-2.0-flash", messages: msgs });
    await provider(fn).complete({ model: "gemini-2.0-flash", messages: msgs });
    expect(calls[0].url.startsWith("https://europe-west4-aiplatform.googleapis.com/v1/projects/proj/locations/europe-west4/")).toBe(true);
    expect(calls[1].url.startsWith("https://us-central1-aiplatform.googleapis.com/")).toBe(true);
  });
});

// ─── VTX-6: shared service-account token cache ───────────────────────────────

describe("Vertex service-account token cache", () => {
  const sa = (email: string, key = KEY_A) => ({ serviceAccountJson: saJson(email, key), accessToken: undefined });

  it("is shared by provider instances: one token request for many providers", async () => {
    const email = freshEmail();
    const a = fakeFetch();
    const b = fakeFetch();
    await provider(a.fn, sa(email)).complete({ model: "gemini-2.0-flash", messages: msgs });
    await provider(b.fn, sa(email)).complete({ model: "gemini-2.0-flash", messages: msgs });
    expect(a.tokenCalls).toHaveLength(1);
    expect(b.tokenCalls).toHaveLength(0);
    expect(a.calls[0].headers.Authorization).toBe("Bearer tok-1");
    expect(b.calls[0].headers.Authorization).toBe("Bearer tok-1");
    expect(a.tokenCalls[0].raw).toContain("grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer");
  });

  it("concurrent calls share one in-flight refresh", async () => {
    const email = freshEmail();
    const slowToken = async () => {
      await new Promise((r) => setTimeout(r, 15));
      return json({ access_token: "slow-tok", expires_in: 3600 });
    };
    const fetches = [fakeFetch({ tokens: [slowToken] }), fakeFetch({ tokens: [slowToken] }), fakeFetch({ tokens: [slowToken] })];
    await Promise.all(fetches.map((f) => provider(f.fn, sa(email)).complete({ model: "gemini-2.0-flash", messages: msgs })));
    expect(fetches.reduce((n, f) => n + f.tokenCalls.length, 0)).toBe(1);
    for (const f of fetches) expect(f.calls[0].headers.Authorization).toBe("Bearer slow-tok");
  });

  it("refreshes once the token has expired, and reuses it before that", async () => {
    const email = freshEmail();
    let now = Date.now();
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const f = fakeFetch({
      tokens: [() => json({ access_token: "first", expires_in: 3600 }), () => json({ access_token: "second", expires_in: 3600 })],
    });
    const p = provider(f.fn, sa(email));
    await p.complete({ model: "gemini-2.0-flash", messages: msgs });
    now += 3000_000; // 50 min: still valid
    await p.complete({ model: "gemini-2.0-flash", messages: msgs });
    expect(f.tokenCalls).toHaveLength(1);
    now += 500_000; // 58m20s: inside the early-refresh margin of the 60 min lifetime
    await p.complete({ model: "gemini-2.0-flash", messages: msgs });
    expect(f.tokenCalls).toHaveLength(2);
    expect(f.calls.map((c) => c.headers.Authorization)).toEqual(["Bearer first", "Bearer first", "Bearer second"]);
  });

  it("honours a short expires_in from the token endpoint", async () => {
    const email = freshEmail();
    let now = Date.now();
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const f = fakeFetch({ tokens: [() => json({ access_token: "short", expires_in: 300 }), () => json({ access_token: "next", expires_in: 300 })] });
    const p = provider(f.fn, sa(email));
    await p.complete({ model: "gemini-2.0-flash", messages: msgs });
    now += 290_000; // inside the last tenth of the 300 s lifetime
    await p.complete({ model: "gemini-2.0-flash", messages: msgs });
    expect(f.tokenCalls).toHaveLength(2);
  });

  it("does not cache a failed refresh", async () => {
    const email = freshEmail();
    const f = fakeFetch({
      tokens: [() => new Response("denied", { status: 401 }), () => json({ access_token: "recovered", expires_in: 3600 })],
    });
    const p = provider(f.fn, sa(email));
    await expect(p.complete({ model: "gemini-2.0-flash", messages: msgs })).rejects.toThrow(/Failed to get Vertex access token: denied/);
    expect(f.calls).toHaveLength(0);
    await p.complete({ model: "gemini-2.0-flash", messages: msgs });
    expect(f.tokenCalls).toHaveLength(2);
    expect(f.calls[0].headers.Authorization).toBe("Bearer recovered");
  });

  it("does not share a token between two private keys that claim the same client_email", async () => {
    const email = freshEmail();
    const a = fakeFetch();
    const b = fakeFetch();
    await provider(a.fn, sa(email, KEY_A)).complete({ model: "gemini-2.0-flash", messages: msgs });
    await provider(b.fn, sa(email, KEY_B)).complete({ model: "gemini-2.0-flash", messages: msgs });
    expect(a.tokenCalls).toHaveLength(1);
    expect(b.tokenCalls).toHaveLength(1);
  });

  it("an explicit accessToken still works and never calls the token endpoint", async () => {
    const f = fakeFetch();
    await provider(f.fn, { accessToken: "explicit" }).complete({ model: "gemini-2.0-flash", messages: msgs });
    expect(f.tokenCalls).toHaveLength(0);
    expect(f.calls[0].headers.Authorization).toBe("Bearer explicit");
  });
});

// ─── VTX-15: non-blocking gcloud fallback ────────────────────────────────────

describe("Vertex gcloud fallback", () => {
  const noAuth = (fn: typeof fetch) => new VertexProvider({ provider: "vertex", projectId: "proj", fetch: fn } as any);
  const execMock = async () => {
    const cp: any = await import("child_process");
    return cp.execFile as ReturnType<typeof vi.fn>;
  };

  it("runs gcloud through execFile (no shell, 30 s default timeout) and caches the token on the instance", async () => {
    const execFile = await execMock();
    execFile.mockReset();
    execFile.mockImplementation((_cmd: string, _args: string[], _opts: any, cb: (e: any, out?: string, err?: string) => void) => {
      setTimeout(() => cb(null, "gcloud-tok\n", ""), 0);
      return {} as any;
    });
    const f = fakeFetch();
    const p = noAuth(f.fn);
    await p.complete({ model: "gemini-2.0-flash", messages: msgs });
    await p.complete({ model: "gemini-2.0-flash", messages: msgs });
    expect(execFile).toHaveBeenCalledTimes(1);
    const [cmd, args, opts] = execFile.mock.calls[0];
    expect(cmd).toBe("gcloud");
    expect(args).toEqual(["auth", "print-access-token"]);
    expect(opts.timeout).toBe(30_000); // R12: default raised from 10 s, configurable
    expect(opts.shell).toBe(process.platform === "win32");
    expect(f.calls.map((c) => c.headers.Authorization)).toEqual(["Bearer gcloud-tok", "Bearer gcloud-tok"]);
  });

  it("concurrent calls on one instance share one gcloud run", async () => {
    const execFile = await execMock();
    execFile.mockReset();
    execFile.mockImplementation((_c: string, _a: string[], _o: any, cb: (e: any, out?: string) => void) => {
      setTimeout(() => cb(null, "shared\n"), 10);
      return {} as any;
    });
    const f = fakeFetch();
    const p = noAuth(f.fn);
    await Promise.all([1, 2, 3].map(() => p.complete({ model: "gemini-2.0-flash", messages: msgs })));
    expect(execFile).toHaveBeenCalledTimes(1);
  });

  it("keeps the same error message when gcloud fails, and does not cache the failure", async () => {
    const execFile = await execMock();
    execFile.mockReset();
    execFile.mockImplementationOnce((_c: string, _a: string[], _o: any, cb: (e: any) => void) => {
      setTimeout(() => cb(new Error("gcloud: command not found")), 0);
      return {} as any;
    });
    execFile.mockImplementationOnce((_c: string, _a: string[], _o: any, cb: (e: any, out?: string) => void) => {
      setTimeout(() => cb(null, "later\n"), 0);
      return {} as any;
    });
    const f = fakeFetch();
    const p = noAuth(f.fn);
    await expect(p.complete({ model: "gemini-2.0-flash", messages: msgs })).rejects.toThrow(
      "No access token available. Provide accessToken, serviceAccountJson, or ensure gcloud CLI is authenticated.",
    );
    await p.complete({ model: "gemini-2.0-flash", messages: msgs });
    expect(f.calls[0].headers.Authorization).toBe("Bearer later");
  });

  it("an empty gcloud output counts as a failure", async () => {
    const execFile = await execMock();
    execFile.mockReset();
    execFile.mockImplementation((_c: string, _a: string[], _o: any, cb: (e: any, out?: string) => void) => {
      cb(null, "  \n");
      return {} as any;
    });
    await expect(noAuth(fakeFetch().fn).complete({ model: "gemini-2.0-flash", messages: msgs })).rejects.toThrow(/No access token available/);
  });
});

// ─── VTX-13: schema sanitizer ────────────────────────────────────────────────

describe("sanitizeGeminiSchema", () => {
  const deepFreeze = <T>(o: T): T => {
    if (o && typeof o === "object") {
      for (const v of Object.values(o)) deepFreeze(v);
      Object.freeze(o);
    }
    return o;
  };

  it("inlines $ref / $defs and drops $schema and additionalProperties", () => {
    const out = sanitizeGeminiSchema({
      $schema: "http://json-schema.org/draft-07/schema#",
      type: "object",
      additionalProperties: false,
      properties: { home: { $ref: "#/$defs/Addr" }, work: { $ref: "#/definitions/Addr" } },
      required: ["home"],
      $defs: { Addr: { type: "object", additionalProperties: false, properties: { street: { type: "string" } } } },
      definitions: { Addr: { type: "object", properties: { street: { type: "string" } } } },
    });
    expect(out).toEqual({
      type: "object",
      properties: {
        home: { type: "object", properties: { street: { type: "string" } } },
        work: { type: "object", properties: { street: { type: "string" } } },
      },
      required: ["home"],
    });
  });

  it("turns a recursive reference into a bare object instead of sending a pointer", () => {
    const out = sanitizeGeminiSchema({
      type: "object",
      properties: { child: { $ref: "#/$defs/Node", description: "the child" } },
      $defs: { Node: { type: "object", properties: { child: { $ref: "#/$defs/Node" } } } },
    });
    expect(out).toEqual({ type: "object", properties: { child: { type: "object", description: "the child" } } });
  });

  it("maps nullable shapes to nullable: true", () => {
    expect(sanitizeGeminiSchema({ type: ["string", "null"], description: "d" })).toEqual({ type: "string", nullable: true, description: "d" });
    expect(sanitizeGeminiSchema({ anyOf: [{ type: "integer" }, { type: "null" }] })).toEqual({ type: "integer", nullable: true });
    expect(sanitizeGeminiSchema({ anyOf: [{ type: "string" }, { type: "number" }, { type: "null" }] })).toEqual({
      anyOf: [{ type: "string" }, { type: "number" }],
      nullable: true,
    });
    expect(sanitizeGeminiSchema({ type: "string", enum: ["a", null] })).toEqual({ type: "string", enum: ["a"], nullable: true });
    expect(sanitizeGeminiSchema({ type: ["string", "number"] })).toEqual({ anyOf: [{ type: "string" }, { type: "number" }] });
  });

  it("maps const to a one-value enum and stringifies enum values", () => {
    expect(sanitizeGeminiSchema({ type: "string", const: "fixed" })).toEqual({ type: "string", enum: ["fixed"] });
    // R1 (deliberate change): an enum on a numeric node also carries format "enum".
    expect(sanitizeGeminiSchema({ type: "integer", const: 5 })).toEqual({ type: "integer", enum: ["5"], format: "enum" });
    expect(sanitizeGeminiSchema({ type: "integer", enum: [1, 2, 3] })).toEqual({ type: "integer", enum: ["1", "2", "3"], format: "enum" });
    // An enum next to a const: the enum is the narrower statement of the two sources, const is not added.
    expect(sanitizeGeminiSchema({ type: "string", enum: ["a", "b"], const: "a" })).toEqual({ type: "string", enum: ["a", "b"] });
  });

  it("keeps the keys the Schema object lists and drops the rest, at every depth", () => {
    const out = sanitizeGeminiSchema({
      $id: "urn:x",
      type: "object",
      title: "Search",
      description: "d",
      examples: [{ q: "a" }],
      properties: {
        q: { type: "string", format: "date-time", minLength: 1, maxLength: 9, pattern: "^a", default: "a", examples: ["a"], exclusiveMinimum: 0 },
        n: { type: "number", minimum: 0, maximum: 10, exclusiveMaximum: 11 },
        tags: {
          type: "array",
          minItems: 1,
          maxItems: 3,
          uniqueItems: true,
          items: { type: "object", additionalProperties: false, properties: { k: { type: "string", const: "x" }, v: { type: ["integer", "null"] } }, required: ["k"] },
        },
      },
      required: ["q"],
      propertyOrdering: ["q", "n", "tags"],
    });
    expect(out).toEqual({
      type: "object",
      title: "Search",
      description: "d",
      properties: {
        q: { type: "string", format: "date-time", minLength: 1, maxLength: 9, pattern: "^a", default: "a" },
        n: { type: "number", minimum: 0, maximum: 10 },
        tags: {
          type: "array",
          minItems: 1,
          maxItems: 3,
          items: { type: "object", properties: { k: { type: "string", enum: ["x"] }, v: { type: "integer", nullable: true } }, required: ["k"] },
        },
      },
      required: ["q"],
      propertyOrdering: ["q", "n", "tags"],
    });
  });

  it("does not read property NAMES as keywords", () => {
    const out = sanitizeGeminiSchema({
      type: "object",
      properties: { const: { type: "string" }, additionalProperties: { type: "boolean" }, type: { type: "string" }, enum: { type: "array", items: { type: "string" } } },
    });
    expect(Object.keys((out as any).properties)).toEqual(["const", "additionalProperties", "type", "enum"]);
    expect((out as any).properties.enum).toEqual({ type: "array", items: { type: "string" } });
  });

  it("sends oneOf as anyOf and merges a one-element allOf", () => {
    expect(sanitizeGeminiSchema({ oneOf: [{ type: "string" }, { type: "integer" }] })).toEqual({ anyOf: [{ type: "string" }, { type: "integer" }] });
    expect(sanitizeGeminiSchema({ description: "outer", allOf: [{ type: "object", properties: { a: { type: "string" } } }] })).toEqual({
      type: "object",
      description: "outer",
      properties: { a: { type: "string" } },
    });
  });

  it("never mutates its input, and is idempotent", () => {
    const input = deepFreeze({
      $schema: "x",
      type: "object",
      additionalProperties: false,
      properties: { a: { $ref: "#/$defs/A" }, b: { type: ["string", "null"], default: { k: [1] } }, c: { const: "z" } },
      $defs: { A: { type: "array", items: { type: "string" }, examples: [["x"]] } },
    });
    const snapshot = structuredClone(input);
    const once = sanitizeGeminiSchema(input);
    expect(input).toEqual(snapshot);
    expect(sanitizeGeminiSchema(once)).toEqual(once);
    // A default is copied, not shared with the input.
    expect((once as any).properties.b.default).toEqual({ k: [1] });
    expect((once as any).properties.b.default).not.toBe((input as any).properties.b.default);
  });

  it("returns non-object input as it is", () => {
    expect(sanitizeGeminiSchema(undefined as any)).toBeUndefined();
    expect(sanitizeGeminiSchema(null as any)).toBeNull();
  });
});

describe("Vertex request body: schemas", () => {
  const dirty = {
    $schema: "http://json-schema.org/draft-07/schema#",
    type: "object",
    additionalProperties: false,
    properties: { city: { type: ["string", "null"] }, unit: { const: "c" } },
    required: ["city"],
  };
  const clean = { type: "object", properties: { city: { type: "string", nullable: true }, unit: { enum: ["c"] } }, required: ["city"] };

  it("function declaration parameters are sanitized", async () => {
    const { fn, calls } = fakeFetch();
    await provider(fn).complete({ model: "gemini-2.0-flash", messages: msgs, tools: [{ name: "weather", description: "w", parameters: dirty }] });
    expect(bodyOf(calls[0]).tools[0].functionDeclarations[0].parameters).toEqual(clean);
  });

  it("the structured-output responseSchema is sanitized", async () => {
    const { fn, calls } = fakeFetch();
    await provider(fn).complete({ model: "gemini-2.0-flash", messages: msgs, responseFormat: { type: "json_schema", schema: dirty } });
    expect(bodyOf(calls[0]).generationConfig.responseMimeType).toBe("application/json");
    expect(bodyOf(calls[0]).generationConfig.responseSchema).toEqual(clean);
  });
});

describe("Vertex tool choice", () => {
  const tools = [
    { name: "get_weather", description: "w", parameters: { type: "object", properties: {} } },
    { name: "get_time", description: "t", parameters: { type: "object", properties: {} } },
  ];
  const configFor = async (toolChoice: ChatCompletionRequest["toolChoice"]) => {
    const { fn, calls } = fakeFetch();
    await provider(fn).complete({ model: "gemini-2.0-flash", messages: msgs, tools, toolChoice });
    return bodyOf(calls[0]).toolConfig;
  };

  it("a named function becomes ANY limited to that function", async () => {
    expect(await configFor({ name: "get_time" })).toEqual({ functionCallingConfig: { mode: "ANY", allowedFunctionNames: ["get_time"] } });
  });

  it("the string choices are unchanged", async () => {
    expect(await configFor("auto")).toEqual({ functionCallingConfig: { mode: "AUTO" } });
    expect(await configFor("required")).toEqual({ functionCallingConfig: { mode: "ANY" } });
    expect(await configFor("none")).toEqual({ functionCallingConfig: { mode: "NONE" } });
    expect(await configFor(undefined)).toBeUndefined();
  });
});

// ─── VTX-M1: functionResponse name ───────────────────────────────────────────

describe("Vertex functionResponse name", () => {
  const callsMsg = {
    role: "assistant" as const,
    content: "",
    toolCalls: [
      { id: "call_abc", name: "get_weather", arguments: '{"city":"Tokyo"}' },
      { id: "call_def", name: "get_time", arguments: "{}" },
    ],
  };

  it("is the function name of the call with the same toolCallId, even without a name on the message", async () => {
    const { fn, calls } = fakeFetch();
    await provider(fn).complete({
      model: "gemini-2.0-flash",
      messages: [
        { role: "user", content: "go" },
        callsMsg,
        { role: "tool", content: '{"temp":22}', toolCallId: "call_abc" },
        { role: "tool", content: "12:00", toolCallId: "call_def" },
      ],
    });
    const parts = bodyOf(calls[0]).contents[2].parts;
    expect(parts.map((p: any) => p.functionResponse.name)).toEqual(["get_weather", "get_time"]);
    expect(parts[0].functionResponse.response).toEqual({ temp: 22 });
    expect(parts[1].functionResponse.response).toEqual({ result: "12:00" });
  });

  it("the matching call wins over the name on the message; without a call the message name, then the id", async () => {
    const { fn, calls } = fakeFetch();
    await provider(fn).complete({
      model: "gemini-2.0-flash",
      messages: [
        { role: "user", content: "go" },
        callsMsg,
        { role: "tool", content: "{}", toolCallId: "call_abc", name: "stale_name" },
        { role: "tool", content: "{}", toolCallId: "unknown_1", name: "message_name" },
        { role: "tool", content: "{}", toolCallId: "unknown_2" },
      ],
    });
    const parts = bodyOf(calls[0]).contents[2].parts;
    expect(parts.map((p: any) => p.functionResponse.name)).toEqual(["get_weather", "message_name", "unknown_2"]);
  });

  it("only calls that came earlier in the conversation count", async () => {
    const { fn, calls } = fakeFetch();
    await provider(fn).complete({
      model: "gemini-2.0-flash",
      messages: [
        { role: "user", content: "go" },
        { role: "tool", content: "{}", toolCallId: "call_abc" },
        callsMsg,
      ],
    });
    expect(bodyOf(calls[0]).contents[1].parts[0].functionResponse.name).toBe("call_abc");
  });
});

// ─── VTX-M4: generationConfig ────────────────────────────────────────────────

describe("Vertex generationConfig sampling fields", () => {
  it("carries seed, presencePenalty and frequencyPenalty (zero and negative values included)", async () => {
    const { fn, calls } = fakeFetch();
    await provider(fn).complete({ model: "gemini-2.0-flash", messages: msgs, seed: 7, presencePenalty: 0.5, frequencyPenalty: -0.25 });
    expect(bodyOf(calls[0]).generationConfig).toEqual({ seed: 7, presencePenalty: 0.5, frequencyPenalty: -0.25 });

    await provider(fn).complete({ model: "gemini-2.0-flash", messages: msgs, seed: 0, presencePenalty: 0, frequencyPenalty: 0 });
    expect(bodyOf(calls[1]).generationConfig).toEqual({ seed: 0, presencePenalty: 0, frequencyPenalty: 0 });
  });

  it("adds nothing when the request has none of them", async () => {
    const { fn, calls } = fakeFetch();
    await provider(fn).complete({ model: "gemini-2.0-flash", messages: msgs, temperature: 0.2 });
    expect(bodyOf(calls[0]).generationConfig).toEqual({ temperature: 0.2 });
  });
});

describe("vertex passes the model to Gemini reasoning", () => {
  it("sends thinkingLevel (no budget) for Gemini 3 and a 128 floor for 2.5 Pro on effort none", async () => {
    const f = fakeFetch();
    const p = provider(f.fn);
    await p.complete({ model: "gemini-3-flash", messages: msgs, reasoning: { effort: "high" } } as any);
    const tc3 = bodyOf(f.calls[0]).generationConfig.thinkingConfig;
    expect(tc3.thinkingLevel).toBe("high");
    expect(tc3.thinkingBudget).toBeUndefined();

    await p.complete({ model: "gemini-2.5-pro", messages: msgs, reasoning: { effort: "none" } } as any);
    expect(bodyOf(f.calls[1]).generationConfig.thinkingConfig.thinkingBudget).toBe(128);
  });
});
