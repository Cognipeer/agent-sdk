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

runReal('Smart Agent V2 Profiles', () => {
  let model: any;

  beforeAll(() => {
    model = createOpenAIModel(API_KEY!);
  });

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
        model,
        runtimeProfile: profile,
        tools: [projectSnapshot],
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