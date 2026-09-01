/**
 * Guardrail presets: openAIModeration, azureContentSafety, bedrockGuardrail and
 * regexGuardrail.
 *
 * A preset is only three decisions — where it posts, how it authenticates, and
 * how it reads the answer — so that is what these tests pin: the exact URL and
 * auth header, a flagged response becoming a deny with a message an operator
 * can act on, a clean response staying out of the way, and shadow mode
 * reporting without enforcing.
 *
 * Everything runs through a real `createPluginHost` handle rather than by
 * calling the hook directly: fail-closed and the deny escalation live in the
 * host, and a preset that only works when its hook is called by hand is not the
 * program that ships.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  azureContentSafety,
  bedrockGuardrail,
  createPluginHost,
  openAIModeration,
  regexGuardrail,
} from "../../../src/plugins/index.js";
import type { AgentPlugin, PluginLogger, PluginRunHost } from "../../../src/plugins/index.js";
import type { AIMessage, Message, SmartAgentEvent, SmartState } from "../../../src/types.js";

afterEach(() => {
  vi.restoreAllMocks();
  // `restoreAllMocks` does not undo `stubGlobal`, and the whole suite shares one
  // process — a leaked `fetch` would poison every later file.
  vi.unstubAllGlobals();
});

// ─── Harness ─────────────────────────────────────────────────────────────────

const silentLogger: PluginLogger = { debug: () => {}, warn: () => {}, error: () => {} };

type Harness = {
  host: ReturnType<typeof createPluginHost>;
  run: PluginRunHost;
  events: SmartAgentEvent[];
};

function harness(plugins: AgentPlugin[]): Harness {
  const events: SmartAgentEvent[] = [];
  const host = createPluginHost(plugins, { logger: silentLogger });
  const run = host.beginRun({
    runId: "run-1",
    agentName: "test-agent",
    getState: () => ({ messages: [] }) as SmartState,
    emit: (event) => events.push(event),
  });
  return { host, run, events };
}

const userMessage = (text: string): Message => ({ role: "user", content: text });

const assistantMessage = (text: string) => ({
  message: { role: "assistant", content: text } as AIMessage,
  durationMs: 5,
  iteration: 1,
  shortCircuited: false,
});

const metadataEvents = (events: SmartAgentEvent[]): Array<Record<string, unknown>> =>
  events.filter((event) => (event as { type?: string }).type === "metadata") as never;

const jsonResponse = (body: unknown) => ({
  ok: true,
  status: 200,
  statusText: "OK",
  json: async () => body,
  text: async () => JSON.stringify(body),
});

type FetchCall = [string, { method?: string; headers?: Record<string, string>; body?: string }];

function stubFetch(impl: (url: string, init: FetchCall[1]) => Promise<unknown>) {
  const mock = vi.fn(impl);
  vi.stubGlobal("fetch", mock as unknown as typeof fetch);
  return mock;
}

/** Restore env exactly, so no global survives the test. */
function withoutEnv(keys: string[], fn: () => void): void {
  const saved = new Map<string, string | undefined>();
  for (const key of keys) {
    saved.set(key, process.env[key]);
    delete process.env[key];
  }
  try {
    fn();
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

const submit = (run: PluginRunHost, text: string) =>
  run.runGate("userPromptSubmit", { text, message: userMessage(text) });

// ─── openAIModeration ────────────────────────────────────────────────────────

const flaggedModeration = {
  id: "modr-1",
  model: "omni-moderation-latest",
  results: [
    {
      flagged: true,
      categories: { violence: true, hate: false, "self-harm": true },
      category_scores: { violence: 0.98, hate: 0.01, "self-harm": 0.71 },
    },
  ],
};

const cleanModeration = {
  results: [{ flagged: false, categories: { violence: false }, category_scores: { violence: 0.0001 } }],
};

describe("openAIModeration", () => {
  it("throws a clear error when no api key is available", () => {
    withoutEnv(["OPENAI_API_KEY"], () => {
      expect(() => openAIModeration()).toThrow(
        /openAIModeration requires an apiKey \(pass `apiKey` or set OPENAI_API_KEY\)/,
      );
    });
  });

  it("posts to /v1/moderations with a bearer token and the default model", async () => {
    const fetchMock = stubFetch(async () => jsonResponse(cleanModeration));
    const plugin = openAIModeration({ apiKey: "sk-test", baseUrl: "https://api.openai.com/" });
    expect(plugin.name).toBe("openai-moderation");
    expect(plugin.priority).toBe(22);
    // Verdicts are allow/block/mask only, so a tool call never pauses here.
    expect(plugin.mayRequireApproval).toBe(false);

    const { run } = harness([plugin]);
    const gate = await submit(run, "hello there");

    expect(gate.decision).toBe("allow");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://api.openai.com/v1/moderations");
    expect(init.method).toBe("POST");
    expect(init.headers?.Authorization).toBe("Bearer sk-test");
    expect(JSON.parse(init.body!)).toEqual({ model: "omni-moderation-latest", input: ["hello there"] });
  });

  it("denies a flagged result and names the flagged categories", async () => {
    stubFetch(async () => jsonResponse(flaggedModeration));
    const { run, events } = harness([openAIModeration({ apiKey: "sk-test" })]);

    const gate = await submit(run, "something awful");

    expect(gate.decision).toBe("deny");
    expect(gate.deniedBy).toBe("openai-moderation");
    expect(gate.reason).toContain("violence");
    expect(gate.reason).toContain("self-harm");
    // A category the service scored but did not flag must not appear.
    expect(gate.reason).not.toContain("hate");

    const reported = metadataEvents(events).find((event) => event.guardrail);
    expect(reported?.guardrail).toMatchObject({ plugin: "openai-moderation", action: "block", enforced: true });
  });

  it("guards the model's answer too, and can replace it instead of failing the turn", async () => {
    stubFetch(async () => jsonResponse(flaggedModeration));
    const { run } = harness([
      openAIModeration({ apiKey: "sk-test", model: "text-moderation-stable", action: "mask", maskWith: "[redacted]" }),
    ]);

    const gate = await run.runGate("postModelCall", assistantMessage("something awful"));

    expect(gate.decision).toBe("allow");
    expect(gate.mutated).toBe(true);
    expect((gate.input.message as AIMessage).content).toBe("[redacted]");
  });

  it("shadow mode reports the block without enforcing it", async () => {
    stubFetch(async () => jsonResponse(flaggedModeration));
    const { run, events } = harness([openAIModeration({ apiKey: "sk-test", mode: "shadow" })]);

    const gate = await submit(run, "something awful");

    expect(gate.decision).toBe("allow");
    expect(gate.mutated).toBe(false);
    const reported = metadataEvents(events).find((event) => event.guardrail);
    expect(reported?.guardrail).toMatchObject({ action: "block", enforced: false });
  });

  it("treats an unrecognised response body as a failure rather than an allow", async () => {
    stubFetch(async () => jsonResponse({ error: { message: "quota exceeded" } }));
    const { run } = harness([openAIModeration({ apiKey: "sk-test", retries: 0 })]);

    const gate = await submit(run, "hello");

    // Fail-closed by default: nothing actually moderated this text.
    expect(gate.decision).toBe("deny");
    expect(gate.reason).toContain("fail-closed");
  });
});

// ─── azureContentSafety ──────────────────────────────────────────────────────

const azureAnalysis = (severities: Record<string, number>) => ({
  categoriesAnalysis: Object.entries(severities).map(([category, severity]) => ({ category, severity })),
});

describe("azureContentSafety", () => {
  it("throws a clear error when the endpoint or key is missing", () => {
    withoutEnv(["AZURE_CONTENT_SAFETY_ENDPOINT", "AZURE_CONTENT_SAFETY_KEY"], () => {
      expect(() => azureContentSafety()).toThrow(/requires an endpoint/);
      expect(() => azureContentSafety({ endpoint: "https://cs.example.com" })).toThrow(/requires an apiKey/);
    });
  });

  it("posts to the analyze path with the subscription-key header", async () => {
    const fetchMock = stubFetch(async () => jsonResponse(azureAnalysis({ Hate: 0, Violence: 2 })));
    const plugin = azureContentSafety({ endpoint: "https://cs.example.com/", apiKey: "azure-key" });
    expect(plugin.name).toBe("azure-content-safety");
    expect(plugin.priority).toBe(23);

    const { run } = harness([plugin]);
    const gate = await submit(run, "hello there");

    expect(gate.decision).toBe("allow");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://cs.example.com/contentsafety/text:analyze?api-version=2024-09-01");
    expect(init.method).toBe("POST");
    expect(init.headers?.["Ocp-Apim-Subscription-Key"]).toBe("azure-key");
    expect(init.headers?.Authorization).toBeUndefined();
    expect(JSON.parse(init.body!)).toEqual({
      text: "hello there",
      categories: ["Hate", "SelfHarm", "Sexual", "Violence"],
      outputType: "FourSeverityLevels",
    });
  });

  it("blocks only once a requested category reaches the threshold", async () => {
    stubFetch(async () => jsonResponse(azureAnalysis({ Hate: 2, Violence: 6 })));
    const { run } = harness([
      azureContentSafety({ endpoint: "https://cs.example.com", apiKey: "azure-key", severityThreshold: 4 }),
    ]);

    const gate = await submit(run, "something awful");

    expect(gate.decision).toBe("deny");
    expect(gate.reason).toContain("Violence severity 6");
    // Below the threshold, so it is not part of the explanation.
    expect(gate.reason).not.toContain("Hate");
  });

  it("ignores a severe category the caller did not ask for", async () => {
    stubFetch(async () => jsonResponse(azureAnalysis({ Hate: 6, Violence: 0 })));
    const { run } = harness([
      azureContentSafety({
        endpoint: "https://cs.example.com",
        apiKey: "azure-key",
        categories: ["Violence"],
        severityThreshold: 4,
      }),
    ]);

    expect((await submit(run, "hello")).decision).toBe("allow");
  });

  it("honours shadow mode and a caller-supplied api version", async () => {
    const fetchMock = stubFetch(async () => jsonResponse(azureAnalysis({ Violence: 6 })));
    const { run, events } = harness([
      azureContentSafety({
        endpoint: "https://cs.example.com",
        apiKey: "azure-key",
        apiVersion: "2023-10-01",
        mode: "shadow",
      }),
    ]);

    const gate = await submit(run, "something awful");

    expect(gate.decision).toBe("allow");
    expect(fetchMock.mock.calls[0][0]).toContain("api-version=2023-10-01");
    expect(metadataEvents(events).find((event) => event.guardrail)?.guardrail).toMatchObject({
      action: "block",
      enforced: false,
    });
  });

  it("falls back to the forgiving envelope parser for an unfamiliar body", async () => {
    // The Azure shape is unverified, so a body that does not carry
    // `categoriesAnalysis` must still be read rather than crash the run.
    stubFetch(async () => jsonResponse({ blocked: true, reason: "custom gateway policy" }));
    const { run } = harness([azureContentSafety({ endpoint: "https://cs.example.com", apiKey: "azure-key" })]);

    const gate = await submit(run, "hello");

    expect(gate.decision).toBe("deny");
    expect(gate.reason).toContain("custom gateway policy");
  });
});

// ─── bedrockGuardrail ────────────────────────────────────────────────────────

const bedrockConfig = {
  guardrailIdentifier: "gr-123",
  guardrailVersion: "1",
  region: "us-west-2",
  credentials: { accessKeyId: "AKIAEXAMPLE", secretAccessKey: "secret" },
};

const bedrockIntervened = {
  action: "GUARDRAIL_INTERVENED",
  outputs: [{ text: "I cannot help with that." }],
  assessments: [
    { topicPolicy: { topics: [{ name: "Legal Advice", type: "DENY", action: "BLOCKED" }] } },
  ],
};

describe("bedrockGuardrail", () => {
  it("throws when the guardrail id, version or credentials are missing", () => {
    expect(() => bedrockGuardrail({ guardrailIdentifier: "gr-1", guardrailVersion: "" })).toThrow(
      /requires both `guardrailIdentifier` and `guardrailVersion`/,
    );
    withoutEnv(["AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_SESSION_TOKEN"], () => {
      expect(() => bedrockGuardrail({ guardrailIdentifier: "gr-1", guardrailVersion: "1" })).toThrow(
        /requires AWS credentials/,
      );
    });
  });

  it("posts a SigV4-signed request to the ApplyGuardrail endpoint", async () => {
    const fetchMock = stubFetch(async () => jsonResponse({ action: "NONE", outputs: [] }));
    const plugin = bedrockGuardrail(bedrockConfig);
    expect(plugin.name).toBe("bedrock-guardrail");
    expect(plugin.priority).toBe(24);

    const { run } = harness([plugin]);
    const gate = await submit(run, "hello there");

    expect(gate.decision).toBe("allow");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://bedrock-runtime.us-west-2.amazonaws.com/guardrail/gr-123/version/1/apply");
    expect(init.method).toBe("POST");
    expect(init.headers?.Authorization).toMatch(/^AWS4-HMAC-SHA256 /);
    // The signature is only meaningful if it names this request's region,
    // service and the headers it actually covers.
    expect(init.headers?.Authorization).toContain("Credential=AKIAEXAMPLE/");
    expect(init.headers?.Authorization).toContain("/us-west-2/bedrock/aws4_request");
    expect(init.headers?.Authorization).toMatch(/SignedHeaders=[^,]*host/);
    expect(init.headers?.["x-amz-date"]).toMatch(/^\d{8}T\d{6}Z$/);
    expect(JSON.parse(init.body!)).toEqual({ source: "INPUT", content: [{ text: { text: "hello there" } }] });
  });

  it("grades the model's own output on the OUTPUT side and denies an intervention", async () => {
    const fetchMock = stubFetch(async () => jsonResponse(bedrockIntervened));
    const { run } = harness([bedrockGuardrail(bedrockConfig)]);

    const gate = await run.runGate("postModelCall", assistantMessage("here is some legal advice"));

    expect(JSON.parse(fetchMock.mock.calls[0][1].body!).source).toBe("OUTPUT");
    expect(gate.decision).toBe("deny");
    expect(gate.deniedBy).toBe("bedrock-guardrail");
    expect(gate.reason).toContain("Legal Advice");
  });

  it("forwards a session token and honours shadow mode", async () => {
    const fetchMock = stubFetch(async () => jsonResponse(bedrockIntervened));
    const { run, events } = harness([
      bedrockGuardrail({
        ...bedrockConfig,
        credentials: { ...bedrockConfig.credentials, sessionToken: "session-token" },
        mode: "shadow",
      }),
    ]);

    const gate = await submit(run, "something the policy hates");

    expect(gate.decision).toBe("allow");
    expect(fetchMock.mock.calls[0][1].headers?.["x-amz-security-token"]).toBe("session-token");
    expect(metadataEvents(events).find((event) => event.guardrail)?.guardrail).toMatchObject({
      action: "block",
      enforced: false,
    });
  });

  it("retries a 503 with a freshly signed request", async () => {
    let attempts = 0;
    const fetchMock = stubFetch(async () => {
      attempts += 1;
      return attempts === 1
        ? { ok: false, status: 503, statusText: "Service Unavailable", json: async () => ({}), text: async () => "busy" }
        : jsonResponse({ action: "NONE" });
    });
    const { run } = harness([bedrockGuardrail({ ...bedrockConfig, retries: 1 })]);

    expect((await submit(run, "hello")).decision).toBe("allow");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    // Each attempt carries its own Authorization header rather than replaying
    // the first one's.
    expect(fetchMock.mock.calls[0][1].headers?.Authorization).toMatch(/^AWS4-HMAC-SHA256 /);
    expect(fetchMock.mock.calls[1][1].headers?.Authorization).toMatch(/^AWS4-HMAC-SHA256 /);
  });
});

// ─── regexGuardrail ──────────────────────────────────────────────────────────

describe("regexGuardrail", () => {
  it("denies on a blocking pattern and names it, without touching the network", async () => {
    const fetchMock = stubFetch(async () => jsonResponse({}));
    const plugin = regexGuardrail({ block: [/ssh-rsa\s+[A-Za-z0-9+/]+/] });
    expect(plugin.name).toBe("regex-guardrail");
    // Ahead of the 20-25 network band, so a local match is never shipped out.
    expect(plugin.priority).toBe(18);

    const { run } = harness([plugin]);
    const gate = await submit(run, "here is my key ssh-rsa AAAAB3Nza");

    expect(gate.decision).toBe("deny");
    expect(gate.reason).toContain("ssh-rsa");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("masks rather than blocks when only mask rules match", async () => {
    const { run } = harness([
      regexGuardrail({ mask: [{ pattern: /\b\d{3}-\d{2}-\d{4}\b/g, replacement: "[ssn]" }] }),
    ]);

    const gate = await submit(run, "ssn 123-45-6789 and 987-65-4321");

    expect(gate.decision).toBe("allow");
    expect(gate.mutated).toBe(true);
    // `g` is forced on, so the second occurrence is masked too.
    expect(gate.input.text).toBe("ssn [ssn] and [ssn]");
  });

  it("blocks in preference to masking when both match", async () => {
    const { run } = harness([
      regexGuardrail({
        block: [/password/i],
        mask: [{ pattern: /\d+/g, replacement: "#" }],
      }),
    ]);

    const gate = await submit(run, "password 1234");
    expect(gate.decision).toBe("deny");
  });

  it("substitutes a replacement literally, not as a substitution pattern", async () => {
    const { run } = harness([
      regexGuardrail({ mask: [{ pattern: /secret/g, replacement: "$& $1 [x]" }] }),
    ]);

    const gate = await submit(run, "the secret");
    expect(gate.input.text).toBe("the $& $1 [x]");
  });

  it("survives a stateful `g` pattern across two calls", async () => {
    // A shared `g`/`y` regex keeps `lastIndex` between calls: reusing the same
    // object would start the second scan past the match and silently allow it.
    const sticky = /token-\d+/g;
    const masked = { pattern: /card-\d+/g, replacement: "[card]" };
    const { run } = harness([regexGuardrail({ block: [sticky], mask: [masked] })]);

    const first = await submit(run, "a token-111 here");
    expect(first.decision).toBe("deny");

    // Different text so the per-run memo cannot answer it, and long enough that
    // a leaked `lastIndex` would land past the match.
    const second = await submit(run, "a much longer sentence with token-222 near the end");
    expect(second.decision).toBe("deny");

    const third = await submit(run, "pay with card-4242 now");
    expect(third.input.text).toBe("pay with [card] now");
    const fourth = await submit(run, "a much longer line that pays with card-9999 at the very end");
    expect(fourth.input.text).toBe("a much longer line that pays with [card] at the very end");
    // The caller's own regexes were never advanced.
    expect(sticky.lastIndex).toBe(0);
    expect(masked.pattern.lastIndex).toBe(0);
  });

  it("shadow mode reports without denying or masking", async () => {
    const { run, events } = harness([
      regexGuardrail({ block: [/password/i], mode: "shadow" }),
    ]);

    const gate = await submit(run, "my password is hunter2");

    expect(gate.decision).toBe("allow");
    expect(gate.mutated).toBe(false);
    expect(metadataEvents(events).find((event) => event.guardrail)?.guardrail).toMatchObject({
      plugin: "regex-guardrail",
      action: "block",
      enforced: false,
    });
  });

  it("allows everything when configured with no patterns at all", async () => {
    const { run } = harness([regexGuardrail()]);
    const gate = await submit(run, "anything goes");
    expect(gate.decision).toBe("allow");
    expect(gate.mutated).toBe(false);
  });
});
