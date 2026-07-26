import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { ASK_USER_TOOL_NAME, createAgent, createSmartAgent, createTool } from '../../src/index.js';
import { createMockModel } from '../setup/mocks/mockModel.js';

/**
 * The ask-user tool must appear EXACTLY once on every tool surface.
 *
 * `createSmartAgent` builds the tool into the list it hands to `createAgent`
 * and forwards `humanInTheLoop` alongside it, so the factory used to attach a
 * second copy. Nothing caught it at invoke time — the smart layer rebuilds its
 * own tool set per call — but `smartAgent.resume` IS the base agent's resume,
 * so it sent the duplicated list straight to the provider. Strict tool configs
 * reject that outright:
 *
 *   Bedrock 400: The tool ask_user_question is already defined at toolConfig.tools.14
 */

const model = createMockModel({ defaultResponse: { content: 'ok' } });

const userTool = () =>
  createTool({
    name: 'my_tool',
    description: 'does a thing',
    schema: z.object({}),
    func: async () => 'ok',
  });

const names = (agent: any): string[] => agent.__runtime.tools.map((tool: any) => tool.name);

const countOf = (list: string[], name: string) => list.filter((entry) => entry === name).length;

describe('ask_user_question tool surface', () => {
  it('is registered once on a smart agent with askUser: true', () => {
    const agent = createSmartAgent({ name: 'a', model, tools: [userTool()] as any, humanInTheLoop: { askUser: true } } as any);
    expect(countOf(names(agent), ASK_USER_TOOL_NAME)).toBe(1);
  });

  it('is registered once with the object form of the config', () => {
    const agent = createSmartAgent({
      name: 'a',
      model,
      tools: [userTool()] as any,
      humanInTheLoop: { askUser: { enabled: true, allowFreeText: false } },
    } as any);
    expect(countOf(names(agent), ASK_USER_TOOL_NAME)).toBe(1);
  });

  it('leaves no duplicate tool name at all on the base runtime', () => {
    const agent = createSmartAgent({ name: 'a', model, tools: [userTool()] as any, humanInTheLoop: { askUser: true } } as any);
    const list = names(agent);
    expect(new Set(list).size).toBe(list.length);
  });

  it('is absent when askUser is off', () => {
    const agent = createSmartAgent({ name: 'b', model, tools: [userTool()] as any } as any);
    expect(names(agent)).not.toContain(ASK_USER_TOOL_NAME);
  });

  it('still attaches the tool when createAgent is used directly', () => {
    const agent = createAgent({ name: 'c', model, tools: [userTool()] as any, humanInTheLoop: { askUser: true } } as any);
    expect(countOf(names(agent), ASK_USER_TOOL_NAME)).toBe(1);
  });

  it('does not add a second copy when the caller already supplied one', () => {
    const supplied = createTool({
      name: ASK_USER_TOOL_NAME,
      description: 'caller-built',
      schema: z.object({}),
      func: async () => 'ok',
    });
    const agent = createAgent({
      name: 'd',
      model,
      tools: [supplied] as any,
      humanInTheLoop: { askUser: true },
    } as any);

    expect(countOf(names(agent), ASK_USER_TOOL_NAME)).toBe(1);
    // The caller's own instance is the one kept.
    const attached = (agent as any).__runtime.tools.find((tool: any) => tool.name === ASK_USER_TOOL_NAME);
    expect(attached.description).toBe('caller-built');
  });
});
