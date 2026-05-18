/**
 * Tests for the new budget limits: maxTotalOutputTokens, maxCostUsd,
 * maxWallClockMs. Each limit should cleanly terminate the loop with a
 * `metadata` event and the partial result still surfaced.
 */

import { describe, it, expect } from 'vitest';
import { createAgent, createTool } from '../../src/index.js';
import type { Message } from '../../src/types.js';
import { z } from 'zod';

function modelWithUsage(usagePerCall: number, contents: string[]) {
  let turn = 0;
  return {
    modelName: 'usage-mock',
    bindTools() { return this; },
    async invoke(_msgs: Message[]) {
      const content = contents[Math.min(turn, contents.length - 1)];
      const response: any = {
        role: 'assistant',
        content,
        usage_metadata: {
          input_tokens: 10,
          output_tokens: usagePerCall,
          total_tokens: 10 + usagePerCall,
        },
      };
      turn++;
      if (content.startsWith('TOOL:')) {
        response.content = '';
        response.tool_calls = [{
          id: `t${turn}`, type: 'function',
          function: { name: 'noop', arguments: '{}' },
        }];
      }
      return response;
    },
  } as any;
}

const noop = createTool({
  name: 'noop',
  description: '',
  schema: z.object({}),
  func: async () => 'ok',
});

describe('budget limits', () => {
  it('terminates when maxTotalOutputTokens is exceeded', async () => {
    // Each model call returns 60 output tokens; cap at 100 means iteration 2
    // should breach budget.
    const model = modelWithUsage(60, ['TOOL:1', 'TOOL:2', 'TOOL:3', 'done']);
    const events: any[] = [];
    const agent = createAgent({
      model,
      tools: [noop],
      limits: { maxToolCalls: 10, maxTotalOutputTokens: 100 },
    });
    await agent.invoke({ messages: [{ role: 'user', content: 'go' }] } as any, {
      onEvent: (e: any) => events.push(e),
    });
    const breach = events.find((e) => e.type === 'metadata' && e.limitBreached);
    expect(breach).toBeDefined();
    expect(breach.limitBreached).toContain('maxTotalOutputTokens');
  });

  it('terminates when maxWallClockMs is exceeded', async () => {
    const slowTool = createTool({
      name: 'slow',
      description: '',
      schema: z.object({}),
      func: async () => { await new Promise((r) => setTimeout(r, 120)); return 'slow'; },
    });
    let turn = 0;
    const model: any = {
      modelName: 'm', bindTools() { return model; },
      async invoke(_msgs: Message[]) {
        turn++;
        if (turn <= 3) return { role: 'assistant', content: '', tool_calls: [{ id: `t${turn}`, type: 'function', function: { name: 'slow', arguments: '{}' } }] };
        return { role: 'assistant', content: 'done' };
      },
    };
    const events: any[] = [];
    const agent = createAgent({
      model,
      tools: [slowTool],
      limits: { maxToolCalls: 5, maxWallClockMs: 100 },
    });
    await agent.invoke({ messages: [{ role: 'user', content: 'go' }] } as any, {
      onEvent: (e: any) => events.push(e),
    });
    const breach = events.find((e) => e.type === 'metadata' && e.limitBreached);
    expect(breach).toBeDefined();
    expect(breach.limitBreached).toContain('maxWallClockMs');
  });

  it('terminates when maxCostUsd is exceeded (with costEstimator)', async () => {
    const model = modelWithUsage(20, ['TOOL:1', 'TOOL:2', 'TOOL:3', 'done']);
    const events: any[] = [];
    const agent = createAgent({
      model,
      tools: [noop],
      limits: { maxToolCalls: 10, maxCostUsd: 0.0005 },
      // 20 output tokens * $0.00003 = $0.0006 per call → over cap on first call.
      costEstimator: ({ outputTokens }) => outputTokens * 0.00003,
    });
    await agent.invoke({ messages: [{ role: 'user', content: 'go' }] } as any, {
      onEvent: (e: any) => events.push(e),
    });
    const breach = events.find((e) => e.type === 'metadata' && e.limitBreached);
    expect(breach).toBeDefined();
    expect(breach.limitBreached).toContain('maxCostUsd');
  });

  it('ignores cost limit when no estimator is provided', async () => {
    const model = modelWithUsage(20, ['TOOL:1', 'TOOL:2', 'done']);
    const events: any[] = [];
    const agent = createAgent({
      model,
      tools: [noop],
      limits: { maxToolCalls: 5, maxCostUsd: 0.0001 },
    });
    await agent.invoke({ messages: [{ role: 'user', content: 'go' }] } as any, {
      onEvent: (e: any) => events.push(e),
    });
    const breach = events.find((e) => e.type === 'metadata' && e.limitBreached);
    expect(breach).toBeUndefined();
  });
});
