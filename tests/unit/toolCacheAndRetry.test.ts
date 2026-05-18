/**
 * Tests for opt-in tool result cache + per-tool retry/backoff/circuit-breaker.
 */

import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { createAgent, createTool } from '../../src/index.js';
import type { Message } from '../../src/types.js';

function modelCallsToolTwice(toolName: string, args: object = {}) {
  let turn = 0;
  return {
    modelName: 'm',
    bindTools() { return this; },
    async invoke(_messages: Message[]) {
      turn++;
      if (turn === 1) {
        return {
          role: 'assistant',
          content: '',
          tool_calls: [{ id: 't1', type: 'function', function: { name: toolName, arguments: JSON.stringify(args) } }],
        };
      }
      if (turn === 2) {
        return {
          role: 'assistant',
          content: '',
          tool_calls: [{ id: 't2', type: 'function', function: { name: toolName, arguments: JSON.stringify(args) } }],
        };
      }
      return { role: 'assistant', content: 'done' };
    },
  } as any;
}

describe('tool result cache', () => {
  it('serves identical args from cache and skips re-execution', async () => {
    let executions = 0;
    const tool = createTool({
      name: 'lookup',
      description: 'lookup',
      schema: z.object({ key: z.string() }),
      func: async ({ key }) => { executions++; return `value-for-${key}`; },
      cache: true,
    });
    const model = modelCallsToolTwice('lookup', { key: 'foo' });
    const agent = createAgent({ model, tools: [tool], limits: { maxToolCalls: 5 } });

    const result = await agent.invoke({ messages: [{ role: 'user', content: 'go' }] } as any);
    expect(executions).toBe(1);
    // Second tool history entry must be flagged as cached.
    const history = result.state?.toolHistory || [];
    expect(history.length).toBeGreaterThanOrEqual(2);
    expect(history[1].fromCache).toBe(true);
  });

  it('treats different args as separate cache keys', async () => {
    let executions = 0;
    let turn = 0;
    const tool = createTool({
      name: 'lookup',
      description: 'lookup',
      schema: z.object({ key: z.string() }),
      func: async ({ key }) => { executions++; return `value-for-${key}`; },
      cache: true,
    });
    const model: any = {
      modelName: 'm', bindTools() { return model; },
      async invoke(_msgs: Message[]) {
        turn++;
        if (turn === 1) return { role: 'assistant', content: '', tool_calls: [{ id: 't1', type: 'function', function: { name: 'lookup', arguments: '{"key":"a"}' } }] };
        if (turn === 2) return { role: 'assistant', content: '', tool_calls: [{ id: 't2', type: 'function', function: { name: 'lookup', arguments: '{"key":"b"}' } }] };
        return { role: 'assistant', content: 'done' };
      },
    };
    const agent = createAgent({ model, tools: [tool], limits: { maxToolCalls: 5 } });
    await agent.invoke({ messages: [{ role: 'user', content: 'go' }] } as any);
    expect(executions).toBe(2);
  });

  it('respects keyFn override', async () => {
    let executions = 0;
    let turn = 0;
    const tool = createTool({
      name: 'lookup',
      description: '',
      schema: z.object({ key: z.string(), nonce: z.string() }),
      func: async ({ key }) => { executions++; return key; },
      cache: { keyFn: (args: any) => args.key }, // ignore nonce
    });
    const model: any = {
      modelName: 'm', bindTools() { return model; },
      async invoke(_msgs: Message[]) {
        turn++;
        if (turn === 1) return { role: 'assistant', content: '', tool_calls: [{ id: 't1', type: 'function', function: { name: 'lookup', arguments: '{"key":"x","nonce":"1"}' } }] };
        if (turn === 2) return { role: 'assistant', content: '', tool_calls: [{ id: 't2', type: 'function', function: { name: 'lookup', arguments: '{"key":"x","nonce":"2"}' } }] };
        return { role: 'assistant', content: 'done' };
      },
    };
    const agent = createAgent({ model, tools: [tool], limits: { maxToolCalls: 5 } });
    await agent.invoke({ messages: [{ role: 'user', content: 'go' }] } as any);
    expect(executions).toBe(1);
  });
});

describe('tool retry / circuit breaker', () => {
  it('retries on transient errors up to maxRetries', async () => {
    let calls = 0;
    const flaky = createTool({
      name: 'flaky',
      description: '',
      schema: z.object({}),
      func: async () => {
        calls++;
        if (calls < 3) throw new Error('transient');
        return 'recovered';
      },
      retry: { maxRetries: 3, backoffMs: 1 },
    });
    let turn = 0;
    const model: any = {
      modelName: 'm', bindTools() { return model; },
      async invoke() {
        turn++;
        if (turn === 1) return { role: 'assistant', content: '', tool_calls: [{ id: 't', type: 'function', function: { name: 'flaky', arguments: '{}' } }] };
        return { role: 'assistant', content: 'done' };
      },
    };
    const agent = createAgent({ model, tools: [flaky], limits: { maxToolCalls: 3 } });
    const result = await agent.invoke({ messages: [{ role: 'user', content: 'go' }] } as any);
    expect(calls).toBe(3);
    expect(result.state?.toolHistory?.[0]?.output).toBe('recovered');
  });

  it('opens circuit breaker after threshold consecutive failures', async () => {
    let calls = 0;
    const bad = createTool({
      name: 'bad',
      description: '',
      schema: z.object({}),
      func: async () => { calls++; throw new Error('boom'); },
      retry: { maxRetries: 0, circuitBreakerThreshold: 2 },
    });
    let turn = 0;
    const model: any = {
      modelName: 'm', bindTools() { return model; },
      async invoke() {
        turn++;
        if (turn <= 4) return { role: 'assistant', content: '', tool_calls: [{ id: `t${turn}`, type: 'function', function: { name: 'bad', arguments: '{}' } }] };
        return { role: 'assistant', content: 'done' };
      },
    };
    const agent = createAgent({ model, tools: [bad], limits: { maxToolCalls: 6 } });
    const result = await agent.invoke({ messages: [{ role: 'user', content: 'go' }] } as any);
    // After threshold (2) failures the breaker trips and bad never runs again.
    expect(calls).toBe(2);
    const toolMessages = result.messages.filter((m: any) => m.role === 'tool');
    const breakerOpened = toolMessages.some((m: any) => typeof m.content === 'string' && m.content.includes('circuit breaker open'));
    expect(breakerOpened).toBe(true);
  });

  it('shouldRetry can opt out of specific errors', async () => {
    let calls = 0;
    const tool = createTool({
      name: 'auth',
      description: '',
      schema: z.object({}),
      func: async () => { calls++; throw new Error('UNAUTHORIZED'); },
      retry: {
        maxRetries: 5,
        backoffMs: 1,
        shouldRetry: (err: any) => !String(err?.message || '').includes('UNAUTHORIZED'),
      },
    });
    let turn = 0;
    const model: any = {
      modelName: 'm', bindTools() { return model; },
      async invoke() {
        turn++;
        if (turn === 1) return { role: 'assistant', content: '', tool_calls: [{ id: 't', type: 'function', function: { name: 'auth', arguments: '{}' } }] };
        return { role: 'assistant', content: 'done' };
      },
    };
    const agent = createAgent({ model, tools: [tool], limits: { maxToolCalls: 3 } });
    await agent.invoke({ messages: [{ role: 'user', content: 'go' }] } as any);
    // shouldRetry returned false on first attempt → no retries.
    expect(calls).toBe(1);
  });
});
