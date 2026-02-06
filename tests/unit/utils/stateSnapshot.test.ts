/**
 * Unit Tests for utils/stateSnapshot.ts
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { captureSnapshot, restoreSnapshot } from '../../../src/utils/stateSnapshot.js';
import type { SmartState, AgentRuntimeConfig } from '../../../src/types.js';

describe('stateSnapshot', () => {
  let baseState: SmartState;

  beforeEach(() => {
    baseState = {
      messages: [
        { role: 'system', content: 'You are helpful.' },
        { role: 'user', content: 'Hello' },
        { role: 'assistant', content: 'Hi there!' },
      ],
      toolCallCount: 2,
      toolHistory: [
        {
          executionId: 'exec_1',
          toolName: 'search',
          args: { query: 'test' },
          output: 'results',
          timestamp: '2024-01-01T00:00:00.000Z',
        },
      ],
      toolHistoryArchived: [],
      todoList: [
        { id: '1', title: 'Task 1', done: false },
        { id: '2', title: 'Task 2', done: true },
      ],
      ctx: {
        customKey: 'customValue',
      },
    } as SmartState;
  });

  describe('captureSnapshot', () => {
    it('should capture basic state', () => {
      const snapshot = captureSnapshot(baseState);

      expect(snapshot.state).toBeDefined();
      expect(snapshot.state.messages).toHaveLength(3);
      expect(snapshot.metadata).toBeDefined();
      expect(snapshot.metadata.createdAt).toBeDefined();
    });

    it('should preserve messages correctly', () => {
      const snapshot = captureSnapshot(baseState);

      expect(snapshot.state.messages[0]).toEqual({ role: 'system', content: 'You are helpful.' });
      expect(snapshot.state.messages[1]).toEqual({ role: 'user', content: 'Hello' });
      expect(snapshot.state.messages[2]).toEqual({ role: 'assistant', content: 'Hi there!' });
    });

    it('should preserve tool history', () => {
      const snapshot = captureSnapshot(baseState);

      expect(snapshot.state.toolHistory).toHaveLength(1);
      expect(snapshot.state.toolHistory![0].toolName).toBe('search');
    });

    it('should preserve todo list', () => {
      const snapshot = captureSnapshot(baseState);

      expect((snapshot.state as any).todoList).toHaveLength(2);
      expect((snapshot.state as any).todoList![0].title).toBe('Task 1');
    });

    it('should exclude internal ctx keys', () => {
      const stateWithInternals: SmartState = {
        ...baseState,
        ctx: {
          customKey: 'value',
          __onEvent: () => {},
          __traceSession: {},
          __paused: { stage: 'test' },
        },
      } as SmartState;

      const snapshot = captureSnapshot(stateWithInternals);

      expect(snapshot.state.ctx?.customKey).toBe('value');
      expect(snapshot.state.ctx?.__onEvent).toBeUndefined();
      expect(snapshot.state.ctx?.__traceSession).toBeUndefined();
      expect(snapshot.state.ctx?.__paused).toBeUndefined();
    });

    it('should include tag in metadata when provided', () => {
      const snapshot = captureSnapshot(baseState, { tag: 'checkpoint-1' });

      expect(snapshot.metadata.tag).toBe('checkpoint-1');
    });

    it('should include runtime hint by default', () => {
      const stateWithAgent: SmartState = {
        ...baseState,
        agent: {
          name: 'TestAgent',
          version: '1.0.0',
          tools: [{ name: 'tool1' }, { name: 'tool2' }],
        } as AgentRuntimeConfig,
      };

      const snapshot = captureSnapshot(stateWithAgent);

      expect(snapshot.runtimeHint).toBeDefined();
      expect(snapshot.runtimeHint?.name).toBe('TestAgent');
      expect(snapshot.runtimeHint?.version).toBe('1.0.0');
      expect(snapshot.runtimeHint?.tools).toEqual(['tool1', 'tool2']);
    });

    it('should exclude runtime hint when disabled', () => {
      const stateWithAgent: SmartState = {
        ...baseState,
        agent: {
          name: 'TestAgent',
        } as AgentRuntimeConfig,
      };

      const snapshot = captureSnapshot(stateWithAgent, { includeRuntimeHint: false });

      expect(snapshot.runtimeHint).toBeUndefined();
    });

    it('should create a deep clone of state', () => {
      const snapshot = captureSnapshot(baseState);

      // Modify original
      baseState.messages.push({ role: 'user', content: 'New message' });
      baseState.toolHistory![0].output = 'modified';

      // Snapshot should be unaffected
      expect(snapshot.state.messages).toHaveLength(3);
      expect(snapshot.state.toolHistory![0].output).toBe('results');
    });

    it('should capture paused state in metadata', () => {
      const pausedState: SmartState = {
        ...baseState,
        ctx: {
          __paused: {
            stage: 'tools',
            iteration: 5,
            reason: 'user_requested',
          },
        },
      } as SmartState;

      const snapshot = captureSnapshot(pausedState);

      expect(snapshot.metadata.paused).toBeDefined();
      expect((snapshot.metadata.paused as any)?.stage).toBe('tools');
    });
  });

  describe('restoreSnapshot', () => {
    it('should restore basic state', () => {
      const snapshot = captureSnapshot(baseState);
      const restored = restoreSnapshot(snapshot);

      expect(restored.messages).toHaveLength(3);
      expect(restored.toolCallCount).toBe(2);
    });

    it('should mark state as restored', () => {
      const snapshot = captureSnapshot(baseState);
      const restored = restoreSnapshot(snapshot);

      expect(restored.ctx?.__restoredFromSnapshot).toBe(true);
    });

    it('should merge incoming ctx by default', () => {
      const snapshot = captureSnapshot(baseState);
      const restored = restoreSnapshot(snapshot, {
        ctx: { newKey: 'newValue' },
      });

      expect(restored.ctx?.customKey).toBe('customValue');
      expect(restored.ctx?.newKey).toBe('newValue');
    });

    it('should replace ctx when mergeCtx is false', () => {
      const snapshot = captureSnapshot(baseState);
      const restored = restoreSnapshot(snapshot, {
        ctx: { newKey: 'newValue' },
        mergeCtx: false,
      });

      expect(restored.ctx?.customKey).toBeUndefined();
      expect(restored.ctx?.newKey).toBe('newValue');
    });

    it('should apply provided agent config', () => {
      const snapshot = captureSnapshot(baseState);
      const newAgent = { name: 'NewAgent', version: '2.0.0' } as AgentRuntimeConfig;

      const restored = restoreSnapshot(snapshot, { agent: newAgent });

      expect(restored.agent).toBe(newAgent);
    });

    it('should create a deep clone when restoring', () => {
      const snapshot = captureSnapshot(baseState);
      const restored = restoreSnapshot(snapshot);

      // Modify restored
      restored.messages.push({ role: 'user', content: 'After restore' });

      // Re-restore should not be affected
      const restoredAgain = restoreSnapshot(snapshot);
      expect(restoredAgain.messages).toHaveLength(3);
    });

    it('should handle empty ctx in snapshot', () => {
      const stateWithoutCtx: SmartState = {
        messages: [{ role: 'user', content: 'Test' }],
      } as SmartState;

      const snapshot = captureSnapshot(stateWithoutCtx);
      const restored = restoreSnapshot(snapshot);

      expect(restored.ctx?.__restoredFromSnapshot).toBe(true);
    });
  });

  describe('round-trip', () => {
    it('should preserve state through capture and restore', () => {
      const original: SmartState = {
        messages: [
          { role: 'user', content: 'Complex message with unicode: 你好' },
          {
            role: 'assistant',
            content: '',
            tool_calls: [
              {
                id: 'call_1',
                type: 'function',
                function: {
                  name: 'test',
                  arguments: '{"key":"value"}',
                },
              },
            ],
          },
        ],
        toolCallCount: 5,
        toolHistory: [
          {
            executionId: 'exec_1',
            toolName: 'test',
            args: { key: 'value' },
            output: { result: [1, 2, 3] },
            timestamp: '2024-01-01T00:00:00.000Z',
          },
        ],
        toolHistoryArchived: [],
        todoList: [{ id: '1', title: 'Task', done: false }],
      } as SmartState;

      const snapshot = captureSnapshot(original);
      const restored = restoreSnapshot(snapshot);

      expect(restored.messages).toEqual(original.messages);
      expect(restored.toolCallCount).toBe(original.toolCallCount);
      expect(restored.toolHistory).toEqual(original.toolHistory);
      expect((restored as any).todoList).toEqual((original as any).todoList);
    });
  });
});
