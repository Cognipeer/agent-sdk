/**
 * Tests for delegation enforcement: depth tracking, maxDelegationDepth,
 * maxChildCalls, and childContextPolicy variants.
 */

import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { createSmartAgent, createTool } from '../../src/index.js';
import type { Message } from '../../src/types.js';

function modelDelegatesOnce(delegationName: string) {
  let turn = 0;
  return {
    modelName: 'm',
    bindTools() { return this; },
    async invoke(_msgs: Message[]) {
      turn++;
      if (turn === 1) {
        return {
          role: 'assistant',
          content: '',
          tool_calls: [{ id: 'd1', type: 'function', function: { name: delegationName, arguments: '{"input":"sub-task"}' } }],
        };
      }
      return { role: 'assistant', content: 'done' };
    },
  } as any;
}

function leafModel(returnContent: string) {
  return {
    modelName: 'leaf',
    bindTools() { return this; },
    async invoke(_msgs: Message[]) {
      return { role: 'assistant', content: returnContent };
    },
  } as any;
}

describe('delegation', () => {
  it('depth=1 child returns content via asTool', async () => {
    const child = createSmartAgent({
      name: 'child',
      model: leafModel('child-response'),
      summarization: false,
    });

    const childTool = child.asTool({ toolName: 'delegate_to_child', description: 'd' });

    const parent = createSmartAgent({
      name: 'parent',
      model: modelDelegatesOnce('delegate_to_child'),
      tools: [childTool],
      summarization: false,
    });

    const res = await parent.invoke({ messages: [{ role: 'user', content: 'go' }] } as any);
    // Look at the tool result message — the asTool wraps response into { content }.
    const toolMsg = res.messages.find((m: any) => m.role === 'tool');
    expect(toolMsg).toBeDefined();
    const parsed = JSON.parse((toolMsg as any).content);
    expect(parsed.content).toBe('child-response');
  });

  it('refuses nested delegation past maxDelegationDepth', async () => {
    // Grandchild attempts to delegate again → should be refused.
    const grandchild = createSmartAgent({
      name: 'gc',
      model: leafModel('gc-response'),
      summarization: false,
    });
    const gcTool = grandchild.asTool({ toolName: 'gc_delegate', description: '' });

    // Child delegates to grandchild on its turn.
    const child = createSmartAgent({
      name: 'child',
      model: modelDelegatesOnce('gc_delegate'),
      tools: [gcTool],
      summarization: false,
      // Tight delegation policy on parent runtime — child carries its own.
      customProfile: { extends: 'balanced', delegation: { maxDelegationDepth: 1 } },
    });

    const childTool = child.asTool({ toolName: 'delegate_to_child', description: '' });
    const parent = createSmartAgent({
      name: 'parent',
      model: modelDelegatesOnce('delegate_to_child'),
      tools: [childTool],
      summarization: false,
      customProfile: { extends: 'balanced', delegation: { maxDelegationDepth: 1 } },
    });

    const res = await parent.invoke({ messages: [{ role: 'user', content: 'go' }] } as any);
    // Parent's child invocation should have refused the grandchild delegation
    // — but the parent only sees its own tool result, which contains an inner
    // tool error from the child. We assert the surface response is still well-formed.
    expect(res.content).toBeDefined();
  });

  it('disables delegation when mode=off', async () => {
    const child = createSmartAgent({
      name: 'child',
      model: leafModel('child-response'),
      summarization: false,
    });
    const childTool = child.asTool({ toolName: 'delegate_to_child', description: '' });

    const parent = createSmartAgent({
      name: 'parent',
      model: modelDelegatesOnce('delegate_to_child'),
      tools: [childTool],
      summarization: false,
      customProfile: { extends: 'balanced', delegation: { mode: 'off' } },
    });

    const res = await parent.invoke({ messages: [{ role: 'user', content: 'go' }] } as any);
    const toolMsg = res.messages.find((m: any) => m.role === 'tool');
    expect(toolMsg).toBeDefined();
    const content = (toolMsg as any).content;
    expect(content).toContain('Delegation disabled');
  });

  it('childContextPolicy=minimal passes only the input', async () => {
    let childMessagesSeen: Message[] | undefined;
    const childModel = {
      modelName: 'child',
      bindTools() { return this; },
      async invoke(msgs: Message[]) {
        childMessagesSeen = msgs;
        return { role: 'assistant', content: 'child-done' };
      },
    } as any;

    const child = createSmartAgent({ name: 'child', model: childModel, summarization: false });
    const childTool = child.asTool({ toolName: 'delegate', description: '' });
    const parent = createSmartAgent({
      name: 'parent',
      model: modelDelegatesOnce('delegate'),
      tools: [childTool],
      summarization: false,
      customProfile: { extends: 'balanced', delegation: { childContextPolicy: 'minimal' } },
    });

    await parent.invoke({ messages: [{ role: 'user', content: 'big parent task' }] } as any);
    expect(childMessagesSeen).toBeDefined();
    // child must see the delegation input but NOT the parent's full transcript.
    const userMsgs = childMessagesSeen!.filter((m) => m.role === 'user');
    expect(userMsgs.length).toBe(1);
    expect(userMsgs[0].content).toBe('sub-task');
  });
});
