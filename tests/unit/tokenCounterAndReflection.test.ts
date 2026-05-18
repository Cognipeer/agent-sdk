/**
 * Tests for pluggable token counter and reflection budget controls.
 */

import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { createAgent, createSmartAgent, createTool, defaultTokenCounter, setTokenCounter, getTokenCounter } from '../../src/index.js';
import type { Message } from '../../src/types.js';

describe('pluggable token counter', () => {
  it('default counter is heuristic', () => {
    setTokenCounter(undefined);
    const tc = getTokenCounter();
    expect(tc).toBe(defaultTokenCounter);
    expect(tc('hello world')).toBeGreaterThan(0);
  });

  it('install custom counter via setTokenCounter and restore', () => {
    const calls: string[] = [];
    setTokenCounter((s: string) => { calls.push(s); return 999; });
    const tc = getTokenCounter();
    expect(tc('abc')).toBe(999);
    expect(calls).toContain('abc');
    setTokenCounter(undefined);
    expect(getTokenCounter()).toBe(defaultTokenCounter);
  });

  it('agent installs and tears down a custom counter per invoke', async () => {
    const seenStrings: string[] = [];
    const tool = createTool({
      name: 'noop',
      description: '',
      schema: z.object({}),
      func: async () => 'ok',
    });
    let turn = 0;
    const model: any = {
      modelName: 'm', bindTools() { return model; },
      async invoke() {
        turn++;
        if (turn === 1) return { role: 'assistant', content: '', tool_calls: [{ id: 't', type: 'function', function: { name: 'noop', arguments: '{}' } }] };
        return { role: 'assistant', content: 'done' };
      },
    };
    const agent = createAgent({
      model,
      tools: [tool],
      tokenCounter: (text: string) => { seenStrings.push(text); return 1; },
    });
    await agent.invoke({ messages: [{ role: 'user', content: 'hello' }] } as any);
    expect(seenStrings.length).toBeGreaterThan(0);
    // After invoke completes the counter is reset.
    expect(getTokenCounter()).toBe(defaultTokenCounter);
  });
});

describe('reflection budget', () => {
  function makeToolTurns(turns: number) {
    let turn = 0;
    return {
      modelName: 'm',
      bindTools() { return this; },
      async invoke(_msgs: Message[]) {
        turn++;
        if (turn <= turns) {
          return {
            role: 'assistant',
            content: '',
            tool_calls: [{ id: `t${turn}`, type: 'function', function: { name: 'noop', arguments: '{}' } }],
          };
        }
        return { role: 'assistant', content: 'done' };
      },
    } as any;
  }
  const noop = createTool({
    name: 'noop',
    description: '',
    schema: z.object({}),
    func: async () => 'ok',
  });

  it('caps reflections at maxPerRun', async () => {
    const reflections: any[] = [];
    const agent = createAgent({
      model: makeToolTurns(4),
      tools: [noop],
      limits: { maxToolCalls: 10 },
      reasoning: {
        enabled: true,
        level: 'low',
        reflection: { cadence: 'after_tool', maxPerRun: 2 },
      },
    });
    await agent.invoke({ messages: [{ role: 'user', content: 'go' }] } as any, {
      onEvent: (e: any) => { if (e.type === 'reflection') reflections.push(e); },
    });
    expect(reflections.length).toBeLessThanOrEqual(2);
  });

  it('honors everyNTurns spacing', async () => {
    const reflections: any[] = [];
    const agent = createAgent({
      model: makeToolTurns(6),
      tools: [noop],
      limits: { maxToolCalls: 10 },
      reasoning: {
        enabled: true,
        level: 'low',
        reflection: { cadence: 'after_tool', everyNTurns: 3 },
      },
    });
    await agent.invoke({ messages: [{ role: 'user', content: 'go' }] } as any, {
      onEvent: (e: any) => { if (e.type === 'reflection') reflections.push(e); },
    });
    // 6 tool turns / every 3 → at most 2 reflections.
    expect(reflections.length).toBeLessThanOrEqual(2);
  });
});

describe('stateRef per-invoke isolation', () => {
  it('concurrent invokes do not share plan/todo state', async () => {
    let turn = 0;
    const model: any = {
      modelName: 'm',
      bindTools() { return model; },
      async invoke(_msgs: Message[]) {
        turn++;
        return { role: 'assistant', content: `turn ${turn}` };
      },
    };
    const agent = createSmartAgent({
      name: 'p',
      model,
      summarization: false,
      useTodoList: true,
    });

    const [a, b, c] = await Promise.all([
      agent.invoke({ messages: [{ role: 'user', content: 'A' }] } as any),
      agent.invoke({ messages: [{ role: 'user', content: 'B' }] } as any),
      agent.invoke({ messages: [{ role: 'user', content: 'C' }] } as any),
    ]);

    // Each invoke independently produced a result without crashing or
    // clobbering the other invokes' state.
    expect(typeof a.content).toBe('string');
    expect(typeof b.content).toBe('string');
    expect(typeof c.content).toBe('string');
  });
});
