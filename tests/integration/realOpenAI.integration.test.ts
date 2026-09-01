/**
 * Real OpenAI Integration Tests
 *
 * These tests drive the SDK against a REAL, OpenAI-compatible endpoint through
 * the SDK's OWN provider layer (`createProvider` + `fromNativeProvider`) rather
 * than a hand-rolled adapter, so a regression in the provider/adapter code is
 * actually caught here instead of being masked by a second, drifting copy of it.
 *
 * Requires OPENAI_API_KEY; skipped entirely without one.
 *
 *   OPENAI_API_KEY=sk-xxx npm run test:real
 *
 * Any OpenAI-compatible endpoint works — a gateway, a proxy, or a local server:
 *
 *   OPENAI_BASE_URL=http://localhost:11434/v1 \
 *   PLUGIN_TEST_MODEL=qwen2.5 OPENAI_API_KEY=ignored npx vitest run …
 *
 * Assertions are written against BEHAVIOUR (tool invocations, message shapes,
 * state fields) rather than particular model wording, so they hold across models.
 */

import { describe, it, expect } from 'vitest';
import { createAgent, createSmartAgent, createTool } from '../../src/index.js';
import { createProvider, fromNativeProvider } from '../../src/providers/index.js';
import { defineHook } from '../../src/plugins/define.js';
import { z } from 'zod';
import type { SmartState, Message } from '../../src/types.js';

// Skip if no API key
const API_KEY = process.env.OPENAI_API_KEY;
const runReal = API_KEY ? describe : describe.skip;
const MODEL = process.env.PLUGIN_TEST_MODEL ?? 'gpt-4o-mini';
const BASE_URL = process.env.OPENAI_BASE_URL;

/** The SDK's own provider stack, pointed at whatever endpoint is configured. */
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

/** Captures exactly what the agent handed to the provider. */
function wireSpy(sink: Message[][]) {
  return defineHook(
    'preModelCall',
    ({ messages }) => {
      sink.push(messages.map((m) => ({ ...m })));
      return undefined;
    },
    { name: 'wire-spy', priority: 999 },
  );
}

runReal('Real OpenAI Integration', () => {
  describe('basic conversation', () => {
    it('should handle a simple message', async () => {
      const agent = createAgent({
        name: 'SimpleAgent',
        model: realModel(),
      });

      const result = await agent.invoke({
        messages: [{ role: 'user', content: 'Say "Hello World" and nothing else.' }],
      } as SmartState);

      expect(result.messages.length).toBeGreaterThan(1);
      // The user turn must be preserved and an assistant turn appended with content.
      expect(result.messages[0].role).toBe('user');
      const assistant = result.messages.filter((m: Message) => m.role === 'assistant');
      expect(assistant.length).toBeGreaterThan(0);
      expect(typeof result.content).toBe('string');
      expect(result.content.length).toBeGreaterThan(0);
      expect(result.content).toBe(assistant.at(-1)!.content);
    }, 60000);
  });

  describe('tool execution', () => {
    it('should execute a simple tool', async () => {
      let toolCalledWith: any = null;

      const echoTool = createTool({
        name: 'echo',
        description: 'Echo back the given text',
        schema: z.object({ text: z.string().describe('Text to echo') }),
        func: async (args: { text: string }) => {
          toolCalledWith = args;
          return { echoed: args.text };
        },
      });

      const agent = createAgent({
        name: 'ToolAgent',
        model: realModel(),
        tools: [echoTool],
        limits: { maxToolCalls: 3 },
      });

      const result = await agent.invoke({
        messages: [{ role: 'user', content: 'Use the echo tool to echo "test message"' }],
      } as SmartState);

      expect(toolCalledWith).not.toBeNull();
      expect(toolCalledWith.text).toContain('test');

      // The tool result has to come back through the transcript as a tool
      // message tied to the assistant's tool call, or the model never sees it.
      const toolMessages = result.messages.filter((m: Message) => m.role === 'tool');
      expect(toolMessages.length).toBeGreaterThan(0);
      const callIds = result.messages
        .filter((m: Message) => Array.isArray((m as any).tool_calls))
        .flatMap((m: Message) => (m as any).tool_calls.map((tc: any) => tc.id));
      expect(callIds).toContain((toolMessages[0] as any).tool_call_id);
    }, 60000);

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
        model: realModel(),
        tools: [calculator],
        limits: { maxToolCalls: 5 },
      });

      const result = await agent.invoke({
        messages: [{ role: 'user', content: 'What is 15 multiplied by 7? Use the calculator tool.' }],
      } as SmartState);

      // The model must have driven the tool with the numbers from the question…
      expect(calculations).toContain('15 multiply 7');
      // …and the computed answer must survive back into the final reply.
      expect(result.content).toContain('105');
    }, 60000);
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
        model: realModel(),
        outputSchema,
      });

      const result = await agent.invoke({
        messages: [{ role: 'user', content: 'Analyze: "TypeScript is amazing for large projects. It catches bugs early."' }],
      } as SmartState);

      const output = result.output || (result.state as any)?.ctx?.__structuredOutputParsed;

      // The whole point of outputSchema is that a parsed object comes back and
      // conforms — a soft "if (output)" made this test unable to fail.
      expect(output).toBeDefined();
      expect(() => outputSchema.parse(output)).not.toThrow();
      expect(typeof output.summary).toBe('string');
      expect(output.summary.length).toBeGreaterThan(0);
      expect(['positive', 'negative', 'neutral']).toContain(output.sentiment);
      expect(Array.isArray(output.keywords)).toBe(true);
    }, 60000);
  });

  describe('smart agent', () => {
    it('should work with system prompt', async () => {
      // Originally this asserted the reply contained pirate vocabulary, which is
      // model wording. The property it was really checking is that a smart
      // agent's `systemPrompt` is actually delivered to the provider as a system
      // message ahead of the user turn, and that the run still answers.
      const wire: Message[][] = [];
      const systemPrompt = 'You are a pirate. Always respond like a pirate would speak.';

      const agent = createSmartAgent({
        name: 'PirateAgent',
        model: realModel(),
        systemPrompt,
        plugins: [wireSpy(wire)],
      });

      const result = await agent.invoke({
        messages: [{ role: 'user', content: 'Hello, how are you?' }],
      } as SmartState);

      expect(wire.length).toBeGreaterThan(0);
      const sent = wire[0];
      expect(sent[0].role).toBe('system');
      expect(String(sent[0].content)).toContain(systemPrompt);
      expect(sent.some((m) => m.role === 'user' && String(m.content).includes('Hello'))).toBe(true);

      expect(result.content.length).toBeGreaterThan(0);
    }, 60000);

    it('should execute tools with smart agent', async () => {
      let searchQuery: string | null = null;

      const searchTool = createTool({
        name: 'search',
        description: 'Search for information',
        schema: z.object({ query: z.string().describe('Search query') }),
        func: async ({ query }: { query: string }) => {
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
        model: realModel(),
        systemPrompt: 'You are a helpful search assistant. Use the search tool when asked questions.',
        tools: [searchTool],
        limits: { maxToolCalls: 3 },
      });

      const result = await agent.invoke({
        messages: [{ role: 'user', content: 'Search for information about TypeScript generics' }],
      } as SmartState);

      expect(searchQuery).not.toBeNull();
      expect(searchQuery!.toLowerCase()).toContain('typescript');

      // A smart agent records every executed tool call in its state history.
      const history = result.state?.toolHistory ?? [];
      expect(history.some((entry: any) => entry.name === 'search' || entry.toolName === 'search')).toBe(true);
      expect(result.content.length).toBeGreaterThan(0);
    }, 60000);
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
        model: realModel(),
        tools: [getCurrentTime, formatMessage],
        limits: { maxToolCalls: 5 },
      });

      const result = await agent.invoke({
        messages: [{ role: 'user', content: 'Get the current time and then format a greeting for John with that time.' }],
      } as SmartState);

      expect(toolCalls).toContain('get_current_time');
      // Model might or might not use format_message depending on its decision.
      // What must hold either way: every tool call in the transcript got a
      // matching tool result, so the multi-turn loop stayed well formed.
      const callIds = result.messages
        .filter((m: Message) => Array.isArray((m as any).tool_calls))
        .flatMap((m: Message) => (m as any).tool_calls.map((tc: any) => tc.id));
      const resultIds = result.messages
        .filter((m: Message) => m.role === 'tool')
        .map((m: Message) => (m as any).tool_call_id);
      expect(callIds.length).toBeGreaterThan(0);
      for (const id of callIds) expect(resultIds).toContain(id);
      expect(result.content.length).toBeGreaterThan(0);
    }, 90000);
  });

  describe('error handling', () => {
    it('should handle tool errors gracefully', async () => {
      let attempts = 0;
      const failingTool = createTool({
        name: 'failing_operation',
        description: 'An operation that always fails',
        schema: z.object({ input: z.string() }),
        func: async () => {
          attempts += 1;
          throw new Error('This operation failed intentionally');
        },
      });

      const agent = createAgent({
        name: 'ErrorHandlerAgent',
        model: realModel(),
        tools: [failingTool],
        limits: { maxToolCalls: 2 },
      });

      const result = await agent.invoke({
        messages: [{ role: 'user', content: 'Use the failing_operation tool with input "test"' }],
      } as SmartState);

      // The throw must not escape the run…
      expect(attempts).toBeGreaterThan(0);
      expect(result.messages.length).toBeGreaterThan(1);
      // …it has to be surfaced to the model as a tool message so the transcript
      // stays valid, and the run still has to finish with an answer.
      const toolMessages = result.messages.filter((m: Message) => m.role === 'tool');
      expect(toolMessages.length).toBeGreaterThan(0);
      expect(JSON.stringify(toolMessages)).toContain('failed intentionally');
      expect(result.content.length).toBeGreaterThan(0);
    }, 60000);
  });
});
