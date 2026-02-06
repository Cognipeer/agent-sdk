/**
 * Test State Fixtures
 */

import type { SmartState, Message } from '../../../src/types.js';

/**
 * Create a minimal valid state
 */
export function createMinimalState(userMessage = 'Hello'): SmartState {
  return {
    messages: [{ role: 'user', content: userMessage }],
  } as SmartState;
}

/**
 * Create state with system message
 */
export function createStateWithSystem(systemPrompt: string, userMessage: string): SmartState {
  return {
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userMessage },
    ],
  } as SmartState;
}

/**
 * Create state with conversation history
 */
export function createConversationState(messages: Array<{ role: string; content: string }>): SmartState {
  return {
    messages: messages as Message[],
  } as SmartState;
}

/**
 * Create state with tool call in progress
 */
export function createStateWithToolCall(
  toolName: string,
  toolArgs: Record<string, any>,
  toolCallId = 'call_test_1'
): SmartState {
  return {
    messages: [
      { role: 'user', content: 'Please use the tool' },
      {
        role: 'assistant',
        content: '',
        tool_calls: [
          {
            id: toolCallId,
            type: 'function',
            function: {
              name: toolName,
              arguments: JSON.stringify(toolArgs),
            },
          },
        ],
      },
    ],
    toolCallCount: 0,
  } as SmartState;
}

/**
 * Create state with tool result
 */
export function createStateWithToolResult(
  toolName: string,
  toolCallId: string,
  result: string
): SmartState {
  return {
    messages: [
      { role: 'user', content: 'Please use the tool' },
      {
        role: 'assistant',
        content: '',
        tool_calls: [
          {
            id: toolCallId,
            type: 'function',
            function: {
              name: toolName,
              arguments: '{}',
            },
          },
        ],
      },
      {
        role: 'tool',
        tool_call_id: toolCallId,
        name: toolName,
        content: result,
      },
    ],
    toolCallCount: 1,
  } as SmartState;
}

/**
 * Create state with todo list
 */
export function createStateWithTodos(todos: Array<{ id: string; title: string; done: boolean }>): SmartState {
  return {
    messages: [{ role: 'user', content: 'Complete the tasks' }],
    todoList: todos,
  } as SmartState;
}

/**
 * Create state with tool history
 */
export function createStateWithToolHistory(
  history: Array<{
    executionId: string;
    toolName: string;
    tool_call_id: string;
    output: string;
    args?: any;
  }>
): SmartState {
  return {
    messages: [{ role: 'user', content: 'Test' }],
    toolHistory: history.map((h) => ({
      ...h,
      args: h.args ?? {},
      rawOutput: h.output,
      timestamp: new Date().toISOString(),
    })),
    toolHistoryArchived: [],
  } as SmartState;
}

/**
 * Create state with guardrail incidents
 */
export function createStateWithGuardrailIncidents(
  incidents: Array<{ guardrailId: string; reason: string }>
): SmartState {
  return {
    messages: [{ role: 'user', content: 'Test' }],
    guardrailOutcome: {
      ok: false,
      incidents: incidents.map((i) => ({
        guardrailId: i.guardrailId,
        phase: 'request' as const,
        reason: i.reason,
        disposition: 'block' as const,
      })),
    },
  } as SmartState;
}

/**
 * Create a complex multi-turn state
 */
export function createMultiTurnState(): SmartState {
  return {
    messages: [
      { role: 'system', content: 'You are a helpful assistant.' },
      { role: 'user', content: 'What is 2+2?' },
      {
        role: 'assistant',
        content: '',
        tool_calls: [
          {
            id: 'call_1',
            type: 'function',
            function: {
              name: 'calculator',
              arguments: JSON.stringify({ operation: 'add', a: 2, b: 2 }),
            },
          },
        ],
      },
      {
        role: 'tool',
        tool_call_id: 'call_1',
        name: 'calculator',
        content: '4',
      },
      { role: 'assistant', content: '2 + 2 = 4' },
      { role: 'user', content: 'What about 3*3?' },
    ],
    toolCallCount: 1,
    toolHistory: [
      {
        executionId: 'exec_1',
        toolName: 'calculator',
        tool_call_id: 'call_1',
        args: { operation: 'add', a: 2, b: 2 },
        output: '4',
        rawOutput: '4',
        timestamp: new Date().toISOString(),
      },
    ],
    toolHistoryArchived: [],
  } as SmartState;
}

/**
 * Create state with pending tool approvals
 */
export function createStateWithPendingApprovals(
  approvals: Array<{ toolCallId: string; toolName: string; args: Record<string, any> }>
): SmartState {
  return {
    messages: [
      { role: 'user', content: 'Execute actions' },
      {
        role: 'assistant',
        content: '',
        tool_calls: approvals.map((a) => ({
          id: a.toolCallId,
          type: 'function',
          function: {
            name: a.toolName,
            arguments: JSON.stringify(a.args),
          },
        })),
      },
    ],
    pendingApprovals: approvals.map((a) => ({
      toolCallId: a.toolCallId,
      toolName: a.toolName,
      args: a.args,
      requestedAt: new Date().toISOString(),
      status: 'pending' as const,
    })),
  } as SmartState;
}
