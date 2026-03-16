import fs from 'node:fs';
import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import OpenAI from 'openai';
import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';
import { createSmartAgent, createTool } from '../../src/index.js';
import type { RuntimeProfile, SmartState } from '../../src/types.js';

const API_KEY = process.env.OPENAI_API_KEY;
const runReal = API_KEY ? describe : describe.skip;

function createOpenAIModel(apiKey: string, modelName = 'gpt-4o-mini') {
  const client = new OpenAI({ apiKey });
  let boundTools: any[] | undefined;

  const model: any = {
    modelName,
    async invoke(messages: any[]): Promise<any> {
      const openaiMessages = messages.map((message: any) => {
        const normalized: any = {
          role: message.role,
          content: typeof message.content === 'string' ? message.content : JSON.stringify(message.content),
        };
        if (message.name) normalized.name = message.name;
        if (Array.isArray(message.tool_calls)) {
          normalized.tool_calls = message.tool_calls.map((toolCall: any) => ({
            id: toolCall.id,
            type: toolCall.type || 'function',
            function: toolCall.function || {
              name: toolCall.name,
              arguments: typeof toolCall.args === 'string' ? toolCall.args : JSON.stringify(toolCall.args || {}),
            },
          }));
        }
        if (message.tool_call_id) normalized.tool_call_id = message.tool_call_id;
        return normalized;
      });

      const response = await client.chat.completions.create({
        model: modelName,
        messages: openaiMessages,
        tools: boundTools,
        tool_choice: boundTools && boundTools.length > 0 ? 'auto' : undefined,
      });

      const choice = response.choices[0]?.message;
      return {
        role: 'assistant',
        content: choice?.content || '',
        usage: response.usage,
        tool_calls: choice?.tool_calls?.map((toolCall: any) => ({
          id: toolCall.id,
          name: toolCall.function.name,
          args: toolCall.function.arguments,
        })),
      };
    },
    bindTools(tools: any[]) {
      boundTools = tools.map((tool) => {
        const schema = tool.schema || tool.parameters;
        const parameters = schema && typeof schema.parse === 'function'
          ? zodToJsonSchema(schema, { target: 'openApi3' })
          : schema || { type: 'object', properties: {} };
        delete (parameters as any).$schema;
        return {
          type: 'function',
          function: {
            name: tool.name,
            description: tool.description || '',
            parameters,
          },
        };
      });
      return model;
    },
  };

  return model;
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
  let model: any;

  beforeAll(() => {
    model = createOpenAIModel(API_KEY!);
  });

  const profiles: RuntimeProfile[] = ['deep', 'research'];

  for (const profile of profiles) {
    it(`should record trace logs for profile=${profile}`, async () => {
      const baseDir = path.join(process.cwd(), 'logs', 'profile-diagnostics', profile);

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
        model,
        runtimeProfile: profile,
        tools: [fetchProjectSnapshot],
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