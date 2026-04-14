import { describe, expect, it } from 'vitest';
import { createContextTools } from '../../src/contextTools.js';
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
