/**
 * `portkeyGateway`, driven for real.
 *
 * The plugin does not intercept anything — it builds the provider config that
 * routes model traffic through a gateway. A unit test can assert that config's
 * SHAPE, which is exactly the half that does not fail: the way this breaks is a
 * config `createProvider` rejects, or headers that never reach the wire.
 *
 * Portkey itself is not reachable from here, so the gateway under test is the
 * local OpenAI-compatible endpoint. That is not a test of Portkey — it is a
 * test that the config this plugin hands back is a working one, which is the
 * part the SDK owns.
 *
 *   OPENAI_BASE_URL=http://localhost:3000/api/client/v1 \
 *   OPENAI_API_KEY=… PLUGIN_TEST_MODEL=gpt-5.6-luna \
 *   npx vitest run tests/integration/pluginsProviderConfig.integration.test.ts
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { createAgent } from "../../src/index.js";
import { createProvider, fromNativeProvider } from "../../src/providers/index.js";
import { portkeyGateway } from "../../src/plugins/builtin/portkeyGuardrail.js";

const API_KEY = process.env.OPENAI_API_KEY;
const runReal = API_KEY ? describe : describe.skip;
const MODEL = process.env.PLUGIN_TEST_MODEL ?? "gpt-4o-mini";
const BASE_URL = process.env.OPENAI_BASE_URL;

afterEach(() => {
  vi.restoreAllMocks();
});

runReal("portkeyGateway produces a usable provider config", () => {
  it("drives a real model through the config it builds", async () => {
    // Every field except the host is what portkeyGateway decides; pointing the
    // host at a reachable endpoint is what makes the rest observable.
    const config = portkeyGateway({
      apiKey: API_KEY!,
      configId: "cfg_test",
      virtualKey: "vk_test",
      baseURL: BASE_URL,
      defaultModel: MODEL,
      // The gateway authenticates with x-portkey-api-key; this endpoint wants a
      // bearer, so the caller-supplied headers override — which is the
      // documented precedence.
      headers: { Authorization: `Bearer ${API_KEY}` },
    });

    expect(config.provider).toBe("openai-compatible");
    expect(config.defaultHeaders).toMatchObject({
      "x-portkey-api-key": API_KEY,
      "x-portkey-config": "cfg_test",
      "x-portkey-virtual-key": "vk_test",
    });

    const agent = createAgent({
      name: "GatewayAgent",
      model: fromNativeProvider(createProvider(config), { model: MODEL }),
    });

    const result = await agent.invoke({
      messages: [{ role: "user", content: "Reply with exactly one short sentence about rivers." }],
    });

    // `createProvider` accepted it and the round trip completed — the half a
    // shape assertion cannot reach.
    expect(result.content.length).toBeGreaterThan(0);
    expect(result.state?.usage?.perRequest.length).toBeGreaterThan(0);
  }, 90_000);

  it("puts the gateway headers on the wire", async () => {
    const realFetch = globalThis.fetch;
    const seen: Array<Record<string, string>> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init: RequestInit) => {
        seen.push((init.headers ?? {}) as Record<string, string>);
        return realFetch(url, init);
      }),
    );

    const agent = createAgent({
      name: "GatewayHeaders",
      model: fromNativeProvider(
        createProvider(
          portkeyGateway({
            apiKey: API_KEY!,
            configId: "cfg_headers",
            baseURL: BASE_URL,
            defaultModel: MODEL,
            headers: { Authorization: `Bearer ${API_KEY}` },
          }),
        ),
        { model: MODEL },
      ),
    });

    await agent.invoke({ messages: [{ role: "user", content: "Say hello in one word." }] });

    expect(seen.length).toBeGreaterThan(0);
    // A config whose headers never left the process would pass every shape
    // assertion and route nothing.
    expect(seen[0]["x-portkey-api-key"]).toBe(API_KEY);
    expect(seen[0]["x-portkey-config"]).toBe("cfg_headers");
  }, 90_000);

  it("refuses to build without an api key rather than routing unauthenticated", () => {
    const saved = process.env.PORTKEY_API_KEY;
    delete process.env.PORTKEY_API_KEY;
    try {
      expect(() => portkeyGateway({})).toThrow(/PORTKEY_API_KEY/);
    } finally {
      if (saved !== undefined) process.env.PORTKEY_API_KEY = saved;
    }
  });
});
