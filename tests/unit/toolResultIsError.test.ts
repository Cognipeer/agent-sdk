/**
 * A tool message for a call that failed, was invalid, denied or not found carries
 * `isError`, so a provider with a native error flag (Anthropic `is_error`) sends it.
 * A successful result carries none.
 */

import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { createAgent } from '../../src/agent.js';
import { createTool } from '../../src/tool.js';
import { AnthropicProvider } from '../../src/providers/anthropic.js';
import { fromNativeProvider } from '../../src/providers/adapter.js';

const toolUse = (id: string, name: string, input: unknown) => ({
  id: 'm', model: 'c', content: [{ type: 'tool_use', id, name, input }], stop_reason: 'tool_use', usage: { input_tokens: 1, output_tokens: 1 },
});
const FINAL = { id: 'm', model: 'c', content: [{ type: 'text', text: 'done' }], stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 } };

/** Runs one tool call (`name`/`input`) and returns the tool_result block the next request carried. */
async function toolResultFor(name: string, input: unknown, tools: any[]): Promise<any> {
  const bodies: any[] = [];
  const replies = [toolUse('t1', name, input), FINAL];
  const fetchImpl = (async (_url: unknown, init: any) => {
    bodies.push(JSON.parse(init.body));
    return new Response(JSON.stringify(replies[bodies.length - 1] ?? FINAL), { status: 200 });
  }) as unknown as typeof fetch;
  const provider = new AnthropicProvider({ provider: 'anthropic', apiKey: 'k', fetch: fetchImpl, retry: { maxRetries: 0 } });
  const agent = createAgent({
    name: 'IsErrorAgent',
    model: fromNativeProvider(provider, { model: 'claude-sonnet-4-20250514' }),
    tools,
  } as any);
  await agent.invoke({ messages: [{ role: 'user', content: 'go' }] } as any);
  const second = bodies[1];
  expect(second).toBeDefined();
  return second.messages.flatMap((m: any) => (Array.isArray(m.content) ? m.content : [])).find((b: any) => b.type === 'tool_result');
}

const okTool = createTool({ name: 'ok_tool', description: 'Works.', schema: z.object({ x: z.string() }), func: async ({ x }) => `fine ${x}` });
const badTool = createTool({ name: 'bad_tool', description: 'Throws.', schema: z.object({ x: z.string() }), func: async () => { throw new Error('kaboom'); } });

describe('tool_result is_error from the tool node', () => {
  it('a thrown tool error is flagged', async () => {
    const block = await toolResultFor('bad_tool', { x: 'a' }, [badTool]);
    expect(block.is_error).toBe(true);
    expect(JSON.stringify(block.content)).toContain('kaboom');
  });

  it('a tool that does not exist is flagged', async () => {
    const block = await toolResultFor('missing_tool', { x: 'a' }, [okTool]);
    expect(block.is_error).toBe(true);
  });

  it('arguments that fail validation are flagged', async () => {
    const block = await toolResultFor('ok_tool', {}, [okTool]);
    expect(block.is_error).toBe(true);
  });

  it('a successful result has no is_error', async () => {
    const block = await toolResultFor('ok_tool', { x: 'a' }, [okTool]);
    expect(block).toBeDefined();
    expect('is_error' in block).toBe(false);
  });
});
