/**
 * Runtime profiles (fast / balanced / deep / research) against a REAL model.
 *
 *   OPENAI_API_KEY=sk-… npx vitest run tests/integration/smartAgentProfiles.integration.test.ts
 *
 * Any OpenAI-compatible endpoint works — a gateway, a proxy, or a local server:
 *
 *   OPENAI_BASE_URL=http://localhost:11434/v1 \
 *   PLUGIN_TEST_MODEL=qwen2.5 OPENAI_API_KEY=ignored npx vitest run …
 *
 * Skipped entirely without a key.
 */

import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { createSmartAgent, createTool } from '../../src/index.js';
import { createProvider, fromNativeProvider } from '../../src/providers/index.js';
import type { RuntimeProfile, SmartState } from '../../src/types.js';

const API_KEY = process.env.OPENAI_API_KEY;
const runReal = API_KEY ? describe : describe.skip;
const MODEL = process.env.PLUGIN_TEST_MODEL ?? 'gpt-4o-mini';
const BASE_URL = process.env.OPENAI_BASE_URL;

function realModel() {
  return fromNativeProvider(
    createProvider({
      provider: 'openai',
      apiKey: API_KEY!,
      defaultModel: MODEL,
      ...(BASE_URL ? { baseURL: BASE_URL } : {}),
    }),
    { model: MODEL },
  );
}

runReal('Smart Agent V2 Profiles', () => {
  const profiles: RuntimeProfile[] = ['fast', 'balanced', 'deep', 'research'];

  for (const profile of profiles) {
    it(`should execute long-session flow with profile=${profile}`, async () => {
      const projectSnapshot = createTool({
        name: 'project_snapshot',
        description: 'Return a verbose project snapshot for a named codebase',
        schema: z.object({ code: z.enum(['ORBIT', 'NOVA']) }),
        func: async ({ code }) => ({
          code,
          owner: code === 'ORBIT' ? 'Ada Lovelace' : 'Grace Hopper',
          risk: code === 'ORBIT' ? 'low' : 'medium',
          details: `${code} detailed snapshot `.repeat(500),
        }),
      });

      const agent = createSmartAgent({
        name: `Profile-${profile}`,
        model: realModel(),
        runtimeProfile: profile,
        tools: [projectSnapshot],
        // The `deep`/`research` profiles allow 40-80 tool calls by default,
        // which on a real endpoint is minutes of wall clock for a two-lookup
        // task. Four still leaves room for the two the scenario needs plus a
        // retry, so nothing the test asserts is out of reach.
        limits: { maxToolCalls: 4 },
        summarization: {
          summaryTriggerTokens: 400,
          maxTokens: 700,
          summaryPromptMaxTokens: 900,
        },
        toolResponses: {
          maxToolResponseChars: 320,
          maxToolResponseTokens: 120,
        },
      });

      const result = await agent.invoke({
        messages: [{
          role: 'user',
          content: 'Use project_snapshot for ORBIT and NOVA. Then tell me the owner and risk for each project in one short answer.',
        }],
      } as SmartState);

      const lowered = result.content.toLowerCase();
      const retainedText = JSON.stringify(result.state?.toolHistory || []).toLowerCase();
      expect(lowered.includes('orbit') || retainedText.includes('orbit')).toBe(true);
      expect(lowered.includes('nova') || retainedText.includes('nova')).toBe(true);
      expect(result.state?.toolHistory?.length).toBeGreaterThanOrEqual(2);
      expect(result.state?.toolHistory?.some((entry: any) => JSON.stringify(entry.rawOutput || entry.output).includes('Ada Lovelace'))).toBe(true);
    }, 90000);
  }
});