/**
 * Real-provider matrix (OPT-IN). Each provider's block runs only when its
 * credentials are present in the environment, so the suite is a no-op in CI
 * without keys. It exercises the cross-provider contract that mock models can't
 * prove: native tool-calling, structured output, and token streaming.
 *
 *   OPENAI_API_KEY=...        npm run test:matrix
 *   OPENAI_API_KEY=... OPENAI_BASE_URL=...   (an OpenAI-compatible gateway)
 *   ANTHROPIC_API_KEY=...     npm run test:matrix
 *   AZURE_OPENAI_API_KEY=... AZURE_OPENAI_ENDPOINT=... AZURE_OPENAI_DEPLOYMENT=...
 *   AWS_REGION=... AWS_ACCESS_KEY_ID=... AWS_SECRET_ACCESS_KEY=...
 *   GOOGLE_CLOUD_PROJECT=... GOOGLE_VERTEX_ACCESS_TOKEN=...
 */
import { describe, it, expect, beforeAll } from "vitest";
import { z } from "zod";
import { createSmartAgent, createTool, createProvider, fromNativeProvider } from "../../src/index.js";
import type { ProviderConfig } from "../../src/index.js";
import type { SmartAgentEvent } from "../../src/types.js";

type ProviderEntry = { name: string; enabled: boolean; build: () => any };

const env = process.env;

const PROVIDERS: ProviderEntry[] = [
  {
    name: "openai",
    enabled: !!env.OPENAI_API_KEY,
    // OPENAI_BASE_URL points this block at an OpenAI-compatible gateway. Without
    // honouring it the block gates on OPENAI_API_KEY and then sends that key to
    // api.openai.com — so a gateway token fails with a 401 from a host the run
    // never meant to touch, and the failure reads as a provider bug.
    build: () => model({
      provider: "openai",
      apiKey: env.OPENAI_API_KEY!,
      baseURL: env.OPENAI_BASE_URL,
      defaultModel: env.OPENAI_MODEL || env.PLUGIN_TEST_MODEL || "gpt-4o-mini",
    }),
  },
  {
    name: "anthropic",
    enabled: !!env.ANTHROPIC_API_KEY,
    build: () => model({ provider: "anthropic", apiKey: env.ANTHROPIC_API_KEY!, defaultModel: env.ANTHROPIC_MODEL || "claude-3-5-haiku-latest" }),
  },
  {
    name: "azure",
    enabled: !!(env.AZURE_OPENAI_API_KEY && env.AZURE_OPENAI_ENDPOINT && env.AZURE_OPENAI_DEPLOYMENT),
    build: () => model({ provider: "azure", apiKey: env.AZURE_OPENAI_API_KEY!, endpoint: env.AZURE_OPENAI_ENDPOINT!, deploymentName: env.AZURE_OPENAI_DEPLOYMENT!, defaultModel: env.AZURE_OPENAI_DEPLOYMENT! }),
  },
  {
    name: "bedrock",
    enabled: !!(env.AWS_REGION && env.AWS_ACCESS_KEY_ID && env.AWS_SECRET_ACCESS_KEY),
    build: () => model({ provider: "bedrock", region: env.AWS_REGION!, accessKeyId: env.AWS_ACCESS_KEY_ID!, secretAccessKey: env.AWS_SECRET_ACCESS_KEY!, sessionToken: env.AWS_SESSION_TOKEN, defaultModel: env.BEDROCK_MODEL || "anthropic.claude-3-5-haiku-20241022-v1:0" }),
  },
  {
    name: "vertex",
    enabled: !!(env.GOOGLE_CLOUD_PROJECT && (env.GOOGLE_VERTEX_ACCESS_TOKEN || env.GOOGLE_SERVICE_ACCOUNT_JSON)),
    build: () => model({ provider: "vertex", projectId: env.GOOGLE_CLOUD_PROJECT!, location: env.GOOGLE_CLOUD_LOCATION || "us-central1", accessToken: env.GOOGLE_VERTEX_ACCESS_TOKEN, serviceAccountJson: env.GOOGLE_SERVICE_ACCOUNT_JSON, defaultModel: env.VERTEX_MODEL || "gemini-2.0-flash" }),
  },
];

function model(cfg: ProviderConfig & { defaultModel?: string }) {
  return fromNativeProvider(createProvider(cfg as any), { model: (cfg as any).defaultModel });
}

const add = createTool({
  name: "add",
  description: "Add two integers and return the sum.",
  schema: z.object({ a: z.number(), b: z.number() }),
  func: async ({ a, b }) => ({ sum: a + b }),
});

const anyEnabled = PROVIDERS.some((p) => p.enabled);
(anyEnabled ? describe : describe.skip)("provider matrix (real APIs)", () => {
  for (const provider of PROVIDERS) {
    const d = provider.enabled ? describe : describe.skip;
    d(provider.name, () => {
      let m: any;
      beforeAll(() => { m = provider.build(); });

      it("calls a tool and uses its result", async () => {
        const events: SmartAgentEvent[] = [];
        const agent = createSmartAgent({ name: `${provider.name}-tool`, model: m, tools: [add], summarization: false, limits: { maxToolCalls: 3 } });
        const res = await agent.invoke(
          { messages: [{ role: "user", content: "Use the add tool to compute 21 + 21, then state the result." }] } as any,
          { onEvent: (e) => events.push(e) },
        );
        expect(res.content).toMatch(/42/);
        expect(events.some((e) => e.type === "tool_call" && (e as any).name === "add")).toBe(true);
      }, 60_000);

      it("returns structured output", async () => {
        const agent = createSmartAgent({
          name: `${provider.name}-struct`,
          model: m,
          outputSchema: z.object({ city: z.string() }),
          summarization: false,
        });
        const res = await agent.invoke({ messages: [{ role: "user", content: "What is the capital of France? Respond with the city." }] } as any);
        expect(res.output?.city ?? "").toMatch(/paris/i);
      }, 60_000);

      it("streams token deltas", async () => {
        let streamed = "";
        const agent = createSmartAgent({ name: `${provider.name}-stream`, model: m, summarization: false });
        const res = await agent.invoke(
          { messages: [{ role: "user", content: "Say the single word: hello" }] } as any,
          { stream: true, onStream: (c) => { streamed += c.text; } },
        );
        expect(streamed.length).toBeGreaterThan(0);
        expect(res.content.length).toBeGreaterThan(0);
      }, 60_000);
    });
  }
});
