import { describe, expect, it } from 'vitest';
import { createContextTools, createGetToolResponseTool, hasToolResponseRecoveryReference } from '../../src/contextTools.js';
import { createTraceSession, customSink } from '../../src/utils/tracing.js';

describe('createContextTools manage_todo_list', () => {
  it('should write a full plan and then patch it with update', async () => {
    const stateRef: any = { todoList: undefined, planVersion: 0, adherenceScore: 0 };
    const tools = createContextTools(stateRef, { planningEnabled: true });
    const manageTodo = tools.find((tool: any) => tool.name === 'manage_todo_list');

    const writeResult = await manageTodo.invoke({
      operation: 'write',
      todoList: [
        { id: 1, title: 'Inspect code', status: 'in-progress' },
        { id: 2, title: 'Run tests', status: 'not-started' },
      ],
    });

    expect(writeResult).toEqual(expect.objectContaining({ status: 'ok', operation: 'write', version: 1 }));
    expect(stateRef.todoList).toHaveLength(2);
    expect(stateRef.todoList[0].title).toBe('Inspect code');

    const updateResult = await manageTodo.invoke({
      operation: 'update',
      expectedVersion: 1,
      todoList: [
        { id: 1, status: 'completed', evidence: 'inspected relevant files' },
        { id: 2, status: 'in-progress' },
      ],
    });

    expect(updateResult).toEqual(expect.objectContaining({ status: 'ok', operation: 'update', version: 2 }));
    expect(stateRef.todoList[0]).toEqual(expect.objectContaining({ id: 1, status: 'completed', evidence: 'inspected relevant files' }));
    expect(stateRef.todoList[1]).toEqual(expect.objectContaining({ id: 2, status: 'in-progress', title: 'Run tests' }));
    expect(stateRef.adherenceScore).toBe(0.5);
  });

  it('should reject update when expectedVersion is stale', async () => {
    const stateRef: any = {
      todoList: [{ id: 1, title: 'Inspect code', step: 'Inspect code', description: 'Inspect code', owner: 'agent', exitCriteria: 'Inspect code', status: 'in-progress' }],
      planVersion: 2,
      adherenceScore: 0,
    };
    const tools = createContextTools(stateRef, { planningEnabled: true });
    const manageTodo = tools.find((tool: any) => tool.name === 'manage_todo_list');

    const result = await manageTodo.invoke({
      operation: 'update',
      expectedVersion: 1,
      todoList: [{ id: 1, status: 'completed' }],
    });

    expect(result).toEqual(expect.objectContaining({ status: 'error', version: 2 }));
    expect(result.error).toContain('version mismatch');
    expect(stateRef.todoList[0].status).toBe('in-progress');
  });

  it('should reject plans with multiple in-progress items', async () => {
    const stateRef: any = { todoList: undefined, planVersion: 0, adherenceScore: 0 };
    const tools = createContextTools(stateRef, { planningEnabled: true });
    const manageTodo = tools.find((tool: any) => tool.name === 'manage_todo_list');

    const result = await manageTodo.invoke({
      operation: 'write',
      todoList: [
        { id: 1, title: 'Inspect code', status: 'in-progress' },
        { id: 2, title: 'Run tests', status: 'in-progress' },
      ],
    });

    expect(result).toEqual(expect.objectContaining({ status: 'error', operation: 'write' }));
    expect(result.error).toContain('Only one todo item may be in-progress');
    expect(stateRef.todoList).toBeUndefined();
  });

  it('should emit separate plan events for runtime and tracing', async () => {
    const runtimeEvents: any[] = [];
    const traceEvents: any[] = [];
    const stateRef: any = { todoList: undefined, planVersion: 0, adherenceScore: 0 };
    const tools = createContextTools(stateRef, { planningEnabled: true });
    const manageTodo = tools.find((tool: any) => tool.name === 'manage_todo_list');

    stateRef.__onEvent = (event: any) => runtimeEvents.push(event);
    stateRef.ctx = {
      __traceSession: createTraceSession({
        model: { id: 'test-model', provider: 'test-provider' },
        tracing: {
          enabled: true,
          sink: customSink((event) => {
            traceEvents.push(event);
          }),
        },
      } as any),
    };

    await manageTodo.invoke({
      operation: 'write',
      todoList: [
        { id: 1, title: 'Inspect code', status: 'in-progress' },
        { id: 2, title: 'Run tests', status: 'not-started' },
      ],
    });

    expect(runtimeEvents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'plan',
          source: 'manage_todo_list',
          operation: 'write',
          version: 1,
        }),
      ]),
    );

    expect(traceEvents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'plan',
        }),
      ]),
    );
    expect(traceEvents[0].label).toContain('Plan write');
    expect(traceEvents[0].data.sections).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'summary', label: 'Todo List' }),
        expect.objectContaining({ kind: 'metadata', label: 'Plan Metadata' }),
      ]),
    );
  });
});

describe('manage_plan (canonical) and manage_todo_list (deprecated alias) share one plan', () => {
  it('binds both names when planning is enabled, and manage_plan is the non-deprecated one', () => {
    const stateRef: any = { todoList: undefined, planVersion: 0, adherenceScore: 0 };
    const tools = createContextTools(stateRef, { planningEnabled: true });
    const names = tools.map((tool: any) => tool.name);

    expect(names).toContain('manage_plan');
    expect(names).toContain('manage_todo_list');

    const managePlan = tools.find((tool: any) => tool.name === 'manage_plan') as any;
    const legacyAlias = tools.find((tool: any) => tool.name === 'manage_todo_list') as any;
    expect(managePlan.description).not.toContain('DEPRECATED');
    expect(legacyAlias.description).toContain('DEPRECATED');
  });

  it('a write through manage_todo_list is readable through manage_plan, and vice versa', async () => {
    const stateRef: any = { todoList: undefined, planVersion: 0, adherenceScore: 0 };
    const tools = createContextTools(stateRef, { planningEnabled: true });
    const managePlan = tools.find((tool: any) => tool.name === 'manage_plan') as any;
    const legacyAlias = tools.find((tool: any) => tool.name === 'manage_todo_list') as any;

    await legacyAlias.invoke({
      operation: 'write',
      todoList: [{ id: 1, title: 'Inspect code', status: 'in-progress' }],
    });

    const readBack = await managePlan.invoke({ operation: 'read' });
    expect(readBack).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: 1, title: 'Inspect code' })]),
    );

    const updated = await managePlan.invoke({
      operation: 'update',
      expectedVersion: 1,
      todoList: [{ id: 1, status: 'completed' }],
    });
    expect(updated).toEqual(expect.objectContaining({ status: 'ok', version: 2 }));
    expect(stateRef.todoList[0].status).toBe('completed');
  });

  it('reports the actual tool name called as the plan event source', async () => {
    const stateRef: any = { todoList: undefined, planVersion: 0, adherenceScore: 0 };
    const runtimeEvents: any[] = [];
    stateRef.__onEvent = (event: any) => runtimeEvents.push(event);
    const tools = createContextTools(stateRef, { planningEnabled: true });
    const managePlan = tools.find((tool: any) => tool.name === 'manage_plan') as any;
    const legacyAlias = tools.find((tool: any) => tool.name === 'manage_todo_list') as any;

    await managePlan.invoke({ operation: 'write', todoList: [{ id: 1, title: 'x', status: 'in-progress' }] });
    await legacyAlias.invoke({ operation: 'update', expectedVersion: 1, todoList: [{ id: 1, status: 'completed' }] });

    expect(runtimeEvents[0]).toEqual(expect.objectContaining({ source: 'manage_plan' }));
    expect(runtimeEvents[1]).toEqual(expect.objectContaining({ source: 'manage_todo_list' }));
  });
});

describe('get_tool_response gating', () => {
  it('should detect visible reduced tool-response markers', () => {
    expect(hasToolResponseRecoveryReference([
      { content: 'ARCHIVED_TOOL_RESPONSE [toolName=search; executionId=exec-123]\nSummary: ...' },
    ])).toBe(true);

    expect(hasToolResponseRecoveryReference([
      { content: '{"results":[1,2,3]}' },
    ])).toBe(false);
  });

  it('should only return a tool response when the transcript references a reduced marker for that execution', async () => {
    const stateRef: any = {
      toolHistory: [{ executionId: 'exec-123', rawOutput: { ok: true, rows: [1, 2, 3] } }],
      toolHistoryArchived: [],
      messages: [{ role: 'tool', content: 'ARCHIVED_TOOL_RESPONSE [toolName=search_workspace_knowledge; executionId=exec-123]\nSummary: results available.' }],
    };

    const getTool = createGetToolResponseTool(stateRef);
    await expect(getTool.invoke({ executionId: 'exec-123' })).resolves.toEqual({ ok: true, rows: [1, 2, 3] });

    stateRef.messages = [{ role: 'tool', content: '{"results":[1,2,3]}' }];
    await expect(getTool.invoke({ executionId: 'exec-123' })).resolves.toContain('not recoverable');
  });

  // A digested ARGUMENT marker lives in tool_calls[].function.arguments, not in a
  // message's content. Without scanning there the gate would tell the model its
  // own digested call "is not recoverable" — the asymmetry that made argument
  // compaction lossy in the first place.
  it('detects a __digest argument marker carried on an assistant tool_call', () => {
    const digestedCall = {
      role: 'assistant',
      content: '',
      tool_calls: [{
        id: 'call_1',
        type: 'function',
        function: {
          name: 'create_text_file',
          arguments: JSON.stringify({
            filePath: '/reports/q3.md',
            content: { __digest: { chars: 61840, sha256: 'abc', head: '# Q3', recover: 'get_tool_response executionId="exec-9" part="input"' } },
          }),
        },
      }],
    };

    expect(hasToolResponseRecoveryReference([digestedCall])).toBe(true);
    expect(hasToolResponseRecoveryReference([digestedCall], 'exec-9')).toBe(true);
    expect(hasToolResponseRecoveryReference([digestedCall], 'exec-other')).toBe(false);
  });

  it('pages the original ARGUMENTS back in with part="input"', async () => {
    const originalArgs = { filePath: '/reports/q3.md', mode: 'append', content: 'x'.repeat(5000) };
    const stateRef: any = {
      toolHistory: [{ executionId: 'exec-9', args: originalArgs, rawOutput: { ok: true } }],
      toolHistoryArchived: [],
      messages: [{
        role: 'assistant',
        content: '',
        tool_calls: [{
          id: 'call_1',
          type: 'function',
          function: {
            name: 'create_text_file',
            arguments: JSON.stringify({
              filePath: '/reports/q3.md',
              content: { __digest: { chars: 5000, sha256: 'abc', head: 'xxx', recover: 'get_tool_response executionId="exec-9" part="input"' } },
            }),
          },
        }],
      }],
    };

    const getTool = createGetToolResponseTool(stateRef);
    await expect(getTool.invoke({ executionId: 'exec-9', part: 'input' })).resolves.toEqual(originalArgs);
    // The output side of the same execution still resolves independently.
    await expect(getTool.invoke({ executionId: 'exec-9', part: 'output' })).resolves.toEqual({ ok: true });
    // Default part is still "output" — existing callers are unaffected.
    await expect(getTool.invoke({ executionId: 'exec-9' })).resolves.toEqual({ ok: true });
  });
});
