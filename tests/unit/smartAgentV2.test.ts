import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  InMemoryMemoryStore,
  createSmartAgent,
  createToolsNode,
  createTool,
  normalizeSmartAgentOptions,
  runSmartAgentEvalHarness,
} from '../../src/index.js';
import { createMockModel } from '../setup/mocks/mockModel.js';
import type { Message, SmartState } from '../../src/types.js';

describe('Smart Agent V2', () => {
  it('should resolve runtime profiles with caller overrides', () => {
    const resolved = normalizeSmartAgentOptions({
      model: { invoke: async () => ({ role: 'assistant', content: 'ok' }) } as any,
      runtimeProfile: 'fast',
      limits: { maxToolCalls: 9 },
      planning: { mode: 'todo' },
    });

    expect(resolved.runtimeProfile).toBe('fast');
    expect(resolved.limits.maxToolCalls).toBe(9);
    expect(resolved.planning.mode).toBe('todo');
    expect(resolved.context.policy).toBe('hybrid');
  });

  it('should mark previous facts obsolete in the in-memory store', async () => {
    const store = new InMemoryMemoryStore();

    await store.upsert('session', [{ key: 'project.status', value: 'draft', sourceTurn: 1, confidence: 0.8 }]);
    await store.upsert('session', [{ key: 'project.status', value: 'approved', sourceTurn: 2, confidence: 0.9 }]);

    const active = await store.get('session');
    const all = await store.get('session', { includeObsolete: true });

    expect(active).toHaveLength(1);
    expect(active[0].value).toBe('approved');
    expect(all.some((fact) => fact.value === 'draft' && fact.obsolete === true)).toBe(true);
  });

  it('should archive verbose tool responses while keeping them retrievable', async () => {
    const largePayload = `PROJECT_FACT|code=ORBIT|owner=Ada Lovelace|risk=low\n${'payload '.repeat(600)}`;
    const fetchSnapshot = createTool({
      name: 'fetch_snapshot',
      description: 'Return a verbose project snapshot',
      schema: z.object({ project: z.string() }),
      func: async ({ project }) => ({ project, payload: largePayload }),
    });

    const options = {
      model: createMockModel() as any,
      runtimeProfile: 'balanced',
      tools: [fetchSnapshot],
      toolResponses: {
        maxToolResponseChars: 120,
        maxToolResponseTokens: 60,
      },
    } as const;
    const toolsNode = createToolsNode([fetchSnapshot], options as any);
    const resolved = normalizeSmartAgentOptions(options as any);

    const next = await toolsNode({
      messages: [{
        role: 'assistant',
        content: '',
        tool_calls: [{
          id: 'call_fetch',
          name: 'fetch_snapshot',
          args: { project: 'orbit' },
          type: 'function',
          function: {
            name: 'fetch_snapshot',
            arguments: JSON.stringify({ project: 'orbit' }),
          },
        }],
      }],
      toolHistory: [],
      toolHistoryArchived: [],
      agent: {
        name: 'ToolPolicyAgent',
        model: options.model,
        tools: [fetchSnapshot],
        limits: resolved.limits,
        runtimeProfile: resolved.runtimeProfile,
        smart: resolved,
      },
      ctx: {},
    } as SmartState);

    const archivedExecution = next.toolHistory[0];
    expect(JSON.stringify(archivedExecution.rawOutput || archivedExecution.output)).toContain('PROJECT_FACT|code=ORBIT');
  });

  it('should only expose get_tool_response when reduced tool-response markers are visible', async () => {
    const seenToolSets: string[][] = [];
    const model = {
      bindTools: (tools: any[]) => {
        seenToolSets.push(tools.map((tool) => tool.name));
        return {
          invoke: async () => ({ role: 'assistant', content: 'ok' }),
        };
      },
      invoke: async () => ({ role: 'assistant', content: 'ok' }),
    } as any;

    const agent = createSmartAgent({ model });

    await agent.invoke({ messages: [{ role: 'user', content: 'hello' }] as Message[] });
    expect(seenToolSets[0] ?? []).not.toContain('get_tool_response');

    seenToolSets.length = 0;
    await agent.invoke({
      messages: [{
        role: 'user',
        content: 'ARCHIVED_TOOL_RESPONSE [toolName=search_workspace_knowledge; executionId=exec-123]\nSummary: use get_tool_response with executionId "exec-123" to inspect the full payload.',
      }] as Message[],
    });
    expect(seenToolSets[0] ?? []).toContain('get_tool_response');
  });

  it('should evaluate profiles with the harness', async () => {
    const createEvalAgent = (profile: 'fast' | 'balanced' | 'custom', descriptor?: { customProfile?: { extends?: 'balanced' } }) => createSmartAgent({
      runtimeProfile: profile,
      customProfile: descriptor?.customProfile,
      model: createMockModel({
        onInvoke: async (messages: Message[]) => {
          const latestUser = [...messages].reverse().find((message) => message.role === 'user');
          return { content: `Answer for ${(latestUser?.content as string) || 'unknown'}` };
        },
      }) as any,
    });

    const results = await runSmartAgentEvalHarness({
      profiles: [
        'fast',
        'balanced',
        {
          label: 'balanced-planner',
          runtimeProfile: 'custom',
          baseProfile: 'balanced',
          customProfile: {
            extends: 'balanced',
            planning: { mode: 'todo' },
          },
        },
      ],
      createAgent: (profile, descriptor) => createEvalAgent(profile as 'fast' | 'balanced' | 'custom', descriptor as { customProfile?: { extends?: 'balanced' } }),
      cases: [
        {
          id: 'recall-1',
          family: 'recall',
          prompt: 'remember orbit owner Ada Lovelace',
          expectedPhrases: ['orbit', 'ada'],
        },
      ],
    });

    expect(results).toHaveLength(3);
    expect(results.every((result) => result.metrics.score > 0)).toBe(true);
    expect(results.find((result) => result.profileLabel === 'balanced-planner')?.profile).toBe('custom');
  });

  it('should keep deep and research defaults conservative unless explicitly overridden', () => {
    const deep = normalizeSmartAgentOptions({
      model: { invoke: async () => ({ role: 'assistant', content: 'ok' }) } as any,
      runtimeProfile: 'deep',
    });
    const research = normalizeSmartAgentOptions({
      model: { invoke: async () => ({ role: 'assistant', content: 'ok' }) } as any,
      runtimeProfile: 'research',
    });

    expect(deep.planning.mode).toBe('off');
    expect(deep.summarization.summaryMode).toBe('incremental');
    expect(research.planning.mode).toBe('off');
    expect(research.summarization.summaryMode).toBe('incremental');
    expect(research.memory.writePolicy).toBe('auto_important');
  });

  it('should resolve a custom profile on top of a built-in base profile', () => {
    const resolved = normalizeSmartAgentOptions({
      model: { invoke: async () => ({ role: 'assistant', content: 'ok' }) } as any,
      runtimeProfile: 'custom',
      customProfile: {
        extends: 'balanced',
        limits: { maxToolCalls: 11 },
        context: { lastTurnsToKeep: 5 },
        planning: { mode: 'todo' },
        memory: { writePolicy: 'manual' },
      },
      toolResponses: { maxToolResponseTokens: 777 },
    });

    expect(resolved.runtimeProfile).toBe('custom');
    expect(resolved.baseProfile).toBe('balanced');
    expect(resolved.limits.maxToolCalls).toBe(11);
    expect(resolved.context.lastTurnsToKeep).toBe(5);
    expect(resolved.planning.mode).toBe('todo');
    expect(resolved.memory.writePolicy).toBe('manual');
    expect(resolved.toolResponses.maxToolResponseTokens).toBe(777);
    expect(resolved.context.policy).toBe('hybrid');
  });

  it('should infer runtimeProfile=custom when only customProfile is provided', () => {
    const resolved = normalizeSmartAgentOptions({
      model: { invoke: async () => ({ role: 'assistant', content: 'ok' }) } as any,
      customProfile: {
        extends: 'fast',
        planning: { mode: 'todo' },
      },
    });

    expect(resolved.runtimeProfile).toBe('custom');
    expect(resolved.baseProfile).toBe('fast');
    expect(resolved.planning.mode).toBe('todo');
  });

  it('should not expose stale smart-agent config flags in resolved output', () => {
    const resolved = normalizeSmartAgentOptions({
      model: { invoke: async () => ({ role: 'assistant', content: 'ok' }) } as any,
      runtimeProfile: 'balanced',
    });

    expect(Object.hasOwn(resolved.context, 'archiveLargeToolResponses')).toBe(false);
    expect(Object.hasOwn(resolved.context, 'retrieveArchivedToolResponseOnDemand')).toBe(false);
    expect(Object.hasOwn(resolved.toolResponses, 'retryOnSchemaError')).toBe(false);
  });

  it('should use context toolResponsePolicy as the default summarization retention policy', () => {
    const resolved = normalizeSmartAgentOptions({
      model: { invoke: async () => ({ role: 'assistant', content: 'ok' }) } as any,
      context: { toolResponsePolicy: 'keep_full' },
      toolResponses: { maxToolResponseTokens: 1234 },
    });

    expect(resolved.context.toolResponsePolicy).toBe('keep_full');
    expect(resolved.toolResponses.defaultPolicy).toBe('keep_full');
    expect(resolved.toolResponses.maxToolResponseTokens).toBe(1234);
  });

  it('should let explicit toolResponses defaultPolicy override context toolResponsePolicy', () => {
    const resolved = normalizeSmartAgentOptions({
      model: { invoke: async () => ({ role: 'assistant', content: 'ok' }) } as any,
      context: { toolResponsePolicy: 'keep_full' },
      toolResponses: { defaultPolicy: 'summarize_archive' },
    });

    expect(resolved.context.toolResponsePolicy).toBe('keep_full');
    expect(resolved.toolResponses.defaultPolicy).toBe('summarize_archive');
  });
});