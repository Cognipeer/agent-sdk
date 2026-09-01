/**
 * File-sink tracing per runtime profile, against a REAL model.
 *
 *   OPENAI_API_KEY=sk-… npx vitest run tests/integration/profileTraceDiagnostics.integration.test.ts
 *
 * Any OpenAI-compatible endpoint works — a gateway, a proxy, or a local server:
 *
 *   OPENAI_BASE_URL=http://localhost:11434/v1 \
 *   PLUGIN_TEST_MODEL=qwen2.5 OPENAI_API_KEY=ignored npx vitest run …
 *
 * Skipped entirely without a key. Traces are written under a per-run temp
 * directory (never into the repo) and removed again in `afterAll`.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
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

function latestSessionDir(baseDir: string): string | undefined {
  if (!fs.existsSync(baseDir)) return undefined;
  const sessions = fs.readdirSync(baseDir)
    .filter((entry) => entry.startsWith('sess_'))
    .map((entry) => ({
      entry,
      mtimeMs: fs.statSync(path.join(baseDir, entry)).mtimeMs,
    }))
    .sort((left, right) => right.mtimeMs - left.mtimeMs);
  return sessions[0]?.entry;
}

runReal('Profile Trace Diagnostics', () => {
  // Traces land in a throwaway temp directory so a run never leaves artefacts
  // behind in the working tree.
  let traceRoot: string;

  beforeAll(() => {
    traceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'profile-trace-diagnostics-'));
  });

  afterAll(() => {
    if (traceRoot) fs.rmSync(traceRoot, { recursive: true, force: true });
  });

  const profiles: RuntimeProfile[] = ['deep', 'research'];

  for (const profile of profiles) {
    it(`should record trace logs for profile=${profile}`, async () => {
      const baseDir = path.join(traceRoot, profile);

      const fetchProjectSnapshot = createTool({
        name: 'fetch_project_snapshot',
        description: 'Return a large project snapshot with canonical fact lines.',
        schema: z.object({ project: z.enum(['orbit', 'nova']) }),
        func: async ({ project }) => {
          const fact = project === 'orbit'
            ? 'PROJECT_FACT|code=ORBIT|owner=Ada Lovelace|risk=low|milestone=design'
            : 'PROJECT_FACT|code=NOVA|owner=Grace Hopper|risk=medium|milestone=blocked';
          return `${fact}\n${'Detailed archived payload '.repeat(220)}`;
        },
      });

      const agent = createSmartAgent({
        name: `Trace-${profile}`,
        model: realModel(),
        runtimeProfile: profile,
        tools: [fetchProjectSnapshot],
        // `deep`/`research` default to 40-80 tool calls; the scenario needs two
        // lookups per turn, so six is ample and keeps a real run bounded.
        limits: { maxToolCalls: 6 },
        summarization: {
          summaryTriggerTokens: 380,
          maxTokens: 680,
          summaryPromptMaxTokens: 1400,
        },
        toolResponses: {
          maxToolResponseChars: 280,
          maxToolResponseTokens: 100,
        },
        tracing: {
          enabled: true,
          mode: 'batched',
          logData: true,
          sink: { type: 'file', path: baseDir },
        },
      });

      const first = await agent.invoke({
        messages: [{
          role: 'user',
          content: 'Fetch the ORBIT and NOVA project snapshots and preserve the key facts for a later recall question.',
        }],
      } as SmartState);

      const second = await agent.invoke({
        ...(first.state as SmartState),
        messages: [
          ...((first.state?.messages || first.messages) as SmartState['messages']),
          { role: 'user', content: 'What are the owner and risk for ORBIT and NOVA? Answer in one sentence.' },
        ],
      } as SmartState);

      const sessionDir = latestSessionDir(baseDir);
      console.log(JSON.stringify({
        profile,
        baseDir,
        sessionDir,
        answer: second.content,
        summaries: second.state?.summaries?.length || 0,
        planSteps: second.state?.plan?.steps?.length || 0,
      }));

      expect(sessionDir).toBeDefined();
      expect(fs.existsSync(path.join(baseDir, sessionDir!, 'trace.session.json'))).toBe(true);
    }, 240000);
  }
});