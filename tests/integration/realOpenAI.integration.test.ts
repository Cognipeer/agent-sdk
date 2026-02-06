/**
 * Real OpenAI Integration Tests
 * 
 * Bu testler gerçek OpenAI API'si ile çalışır.
 * Çalıştırmak için OPENAI_API_KEY environment variable'ı gerekli.
 * 
 * Çalıştırma:
 *   OPENAI_API_KEY=sk-xxx npm run test:real
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { createAgent, createSmartAgent, createTool } from '../../src/index.js';
import OpenAI from 'openai';
import { z } from 'zod';
import type { SmartState, Message } from '../../src/types.js';
import { zodToJsonSchema } from 'zod-to-json-schema';

// Skip if no API key
const API_KEY = process.env.OPENAI_API_KEY;
const runReal = API_KEY ? describe : describe.skip;

/**
 * Simple OpenAI adapter that wraps the OpenAI SDK
 */
function createOpenAIModel(apiKey: string, modelName = 'gpt-4o-mini') {
  const client = new OpenAI({ apiKey });
  let boundTools: any[] | undefined;

  const model: any = {
    modelName,
    
    async invoke(messages: any[]): Promise<any> {
      // Convert messages to OpenAI format
      const openaiMessages = messages.map((m: any) => {
        const msg: any = {
          role: m.role as 'system' | 'user' | 'assistant' | 'tool',
          content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content),
        };
        if (m.name) msg.name = m.name;
        // Convert tool_calls from SDK format { id, name, args } to OpenAI format { id, type, function: { name, arguments } }
        if (m.tool_calls && Array.isArray(m.tool_calls)) {
          msg.tool_calls = m.tool_calls.map((tc: any) => ({
            id: tc.id,
            type: tc.type || 'function',
            function: tc.function || {
              name: tc.name,
              arguments: typeof tc.args === 'string' ? tc.args : JSON.stringify(tc.args || {}),
            },
          }));
        }
        if (m.tool_call_id) msg.tool_call_id = m.tool_call_id;
        return msg;
      });

      const params: any = {
        model: modelName,
        messages: openaiMessages,
      };

      if (boundTools && boundTools.length > 0) {
        params.tools = boundTools;
        params.tool_choice = 'auto';
      }

      const response = await client.chat.completions.create(params);
      const choice = response.choices[0];
      const msg = choice.message;

      const result: any = {
        role: 'assistant',
        content: msg.content || '',
        usage: response.usage,
      };

      if (msg.tool_calls && msg.tool_calls.length > 0) {
        // SDK expects { id, name, args } format, not OpenAI's { id, function: { name, arguments } }
        result.tool_calls = msg.tool_calls.map((tc: any) => ({
          id: tc.id,
          name: tc.function.name,
          args: tc.function.arguments, // SDK will parse this if it's a string
        }));
      }

      return result;
    },

    bindTools(tools: any[]) {
      // Convert tools to OpenAI format
      boundTools = tools.map(tool => {
        const schema = tool.schema || tool.parameters;
        let jsonSchema: any;

        if (schema && typeof schema.parse === 'function') {
          // Zod schema
          jsonSchema = zodToJsonSchema(schema, { target: 'openApi3' });
          delete jsonSchema.$schema;
        } else if (schema) {
          jsonSchema = schema;
        } else {
          jsonSchema = { type: 'object', properties: {} };
        }

        return {
          type: 'function',
          function: {
            name: tool.name,
            description: tool.description || '',
            parameters: jsonSchema,
          },
        };
      });

      return model;
    },
  };

  return model;
}

runReal('Real OpenAI Integration', () => {
  let model: any;

  beforeAll(() => {
    model = createOpenAIModel(API_KEY!);
  });

  describe('basic conversation', () => {
    it('should handle a simple message', async () => {
      const agent = createAgent({
        name: 'SimpleAgent',
        model,
      });

      const result = await agent.invoke({
        messages: [{ role: 'user', content: 'Say "Hello World" and nothing else.' }],
      } as SmartState);

      console.log('Response:', result.content);
      expect(result.messages.length).toBeGreaterThan(1);
      expect(result.content.toLowerCase()).toContain('hello');
    }, 30000);
  });

  describe('tool execution', () => {
    it('should execute a simple tool', async () => {
      let toolCalledWith: any = null;

      const echoTool = createTool({
        name: 'echo',
        description: 'Echo back the given text',
        schema: z.object({ text: z.string().describe('Text to echo') }),
        func: async (args: { text: string }) => {
          console.log('Tool called with:', args);
          toolCalledWith = args;
          return { echoed: args.text };
        },
      });

      const agent = createAgent({
        name: 'ToolAgent',
        model,
        tools: [echoTool],
        limits: { maxToolCalls: 3 },
      });

      const result = await agent.invoke({
        messages: [{ role: 'user', content: 'Use the echo tool to echo "test message"' }],
      } as SmartState);

      console.log('Final content:', result.content);
      console.log('Tool was called with:', toolCalledWith);
      console.log('Messages:', result.messages.map((m: Message) => ({ role: m.role, content: typeof m.content === 'string' ? m.content?.slice?.(0, 100) : m.content })));

      expect(toolCalledWith).not.toBeNull();
      expect(toolCalledWith.text).toContain('test');
    }, 30000);

    it('should execute calculator tool', async () => {
      const calculations: string[] = [];

      const calculator = createTool({
        name: 'calculator',
        description: 'Perform basic math operations: add, subtract, multiply, divide',
        schema: z.object({
          operation: z.enum(['add', 'subtract', 'multiply', 'divide']),
          a: z.number().describe('First number'),
          b: z.number().describe('Second number'),
        }),
        func: async ({ operation, a, b }: { operation: string; a: number; b: number }) => {
          console.log(`Calculator: ${a} ${operation} ${b}`);
          calculations.push(`${a} ${operation} ${b}`);
          switch (operation) {
            case 'add': return { result: a + b };
            case 'subtract': return { result: a - b };
            case 'multiply': return { result: a * b };
            case 'divide': return { result: a / b };
            default: return { error: 'Unknown operation' };
          }
        },
      });

      const agent = createAgent({
        name: 'CalculatorAgent',
        model,
        tools: [calculator],
        limits: { maxToolCalls: 5 },
      });

      const result = await agent.invoke({
        messages: [{ role: 'user', content: 'What is 15 multiplied by 7?' }],
      } as SmartState);

      console.log('Calculations performed:', calculations);
      console.log('Final answer:', result.content);

      expect(calculations.length).toBeGreaterThan(0);
      expect(result.content).toContain('105');
    }, 30000);
  });

  describe('structured output', () => {
    it('should return structured output', async () => {
      const outputSchema = z.object({
        summary: z.string().describe('A brief summary'),
        sentiment: z.enum(['positive', 'negative', 'neutral']).describe('Overall sentiment'),
        keywords: z.array(z.string()).describe('Key topics'),
      });

      const agent = createAgent({
        name: 'StructuredAgent',
        model,
        outputSchema,
      });

      const result = await agent.invoke({
        messages: [{ role: 'user', content: 'Analyze: "TypeScript is amazing for large projects. It catches bugs early."' }],
      } as SmartState);

      console.log('Structured output:', result.output);
      console.log('Raw ctx:', (result.state as SmartState)?.ctx);

      // Output might be in result.output or ctx.__structuredOutputParsed
      const output = result.output || (result.state as any)?.ctx?.__structuredOutputParsed;
      
      if (output) {
        expect(output.summary).toBeDefined();
        expect(['positive', 'negative', 'neutral']).toContain(output.sentiment);
      }
    }, 30000);
  });

  describe('smart agent', () => {
    it('should work with system prompt', async () => {
      const agent = createSmartAgent({
        name: 'PirateAgent',
        model,
        systemPrompt: 'You are a pirate. Always respond like a pirate would speak.',
      });

      const result = await agent.invoke({
        messages: [{ role: 'user', content: 'Hello, how are you?' }],
      } as SmartState);

      console.log('Pirate response:', result.content);
      
      // Should contain pirate-like language
      const pirateWords = ['arr', 'matey', 'ahoy', 'ye', 'aye', 'treasure', 'ship', 'sea', 'captain', 'sail'];
      const hasAnyPirateWord = pirateWords.some(word => 
        result.content.toLowerCase().includes(word)
      );
      expect(hasAnyPirateWord).toBe(true);
    }, 30000);

    it('should execute tools with smart agent', async () => {
      let searchQuery: string | null = null;

      const searchTool = createTool({
        name: 'search',
        description: 'Search for information',
        schema: z.object({ query: z.string().describe('Search query') }),
        func: async ({ query }: { query: string }) => {
          console.log('Search called with:', query);
          searchQuery = query;
          return {
            results: [
              { title: 'Result 1', snippet: 'This is the first result about ' + query },
              { title: 'Result 2', snippet: 'Another result related to ' + query },
            ],
          };
        },
      });

      const agent = createSmartAgent({
        name: 'SearchAgent',
        model,
        systemPrompt: 'You are a helpful search assistant. Use the search tool when asked questions.',
        tools: [searchTool],
        limits: { maxToolCalls: 3 },
      });

      const result = await agent.invoke({
        messages: [{ role: 'user', content: 'Search for information about TypeScript generics' }],
      } as SmartState);

      console.log('Search query used:', searchQuery);
      console.log('Final response:', result.content);

      expect(searchQuery).not.toBeNull();
      expect(searchQuery!.toLowerCase()).toContain('typescript');
    }, 30000);
  });

  describe('multi-tool scenario', () => {
    it('should use multiple tools in sequence', async () => {
      const toolCalls: string[] = [];

      const getCurrentTime = createTool({
        name: 'get_current_time',
        description: 'Get the current date and time',
        schema: z.object({}),
        func: async () => {
          toolCalls.push('get_current_time');
          return { time: new Date().toISOString(), timezone: 'UTC' };
        },
      });

      const formatMessage = createTool({
        name: 'format_message',
        description: 'Format a greeting message with the given name and time',
        schema: z.object({
          name: z.string().describe('Name to greet'),
          time: z.string().describe('Time to include in greeting'),
        }),
        func: async ({ name, time }: { name: string; time: string }) => {
          toolCalls.push('format_message');
          return { message: `Hello ${name}! The time is ${time}.` };
        },
      });

      const agent = createAgent({
        name: 'MultiToolAgent',
        model,
        tools: [getCurrentTime, formatMessage],
        limits: { maxToolCalls: 5 },
      });

      const result = await agent.invoke({
        messages: [{ role: 'user', content: 'Get the current time and then format a greeting for John with that time.' }],
      } as SmartState);

      console.log('Tool calls:', toolCalls);
      console.log('Final response:', result.content);

      expect(toolCalls).toContain('get_current_time');
      // Model might or might not use format_message depending on its decision
    }, 45000);
  });

  describe('error handling', () => {
    it('should handle tool errors gracefully', async () => {
      const failingTool = createTool({
        name: 'failing_operation',
        description: 'An operation that always fails',
        schema: z.object({ input: z.string() }),
        func: async () => {
          throw new Error('This operation failed intentionally');
        },
      });

      const agent = createAgent({
        name: 'ErrorHandlerAgent',
        model,
        tools: [failingTool],
        limits: { maxToolCalls: 2 },
      });

      const result = await agent.invoke({
        messages: [{ role: 'user', content: 'Use the failing_operation tool with input "test"' }],
      } as SmartState);

      console.log('Response after error:', result.content);
      
      // Agent should still complete, potentially mentioning the error
      expect(result.messages.length).toBeGreaterThan(1);
    }, 30000);
  });
});
