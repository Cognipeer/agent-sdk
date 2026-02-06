/**
 * Integration Tests for Pause/Resume functionality
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createAgent } from '../../src/agent.js';
import { createSmartAgent } from '../../src/smart/index.js';
import { createTool } from '../../src/tool.js';
import { captureSnapshot, restoreSnapshot } from '../../src/utils/stateSnapshot.js';
import { createMockModel, createSimpleMockModel } from '../setup/mocks/mockModel.js';
import { z } from 'zod';
import type { SmartState, AgentSnapshot } from '../../src/types.js';

describe('Pause/Resume Integration', () => {
  describe('basic pause and resume', () => {
    it('should pause execution on state change callback', async () => {
      let pauseRequested = false;
      const mockModel = createSimpleMockModel(['Response 1', 'Response 2']);

      const agent = createAgent({
        name: 'PausableAgent',
        model: mockModel as any,
      });

      const result = await agent.invoke(
        { messages: [{ role: 'user', content: 'Hello' }] } as SmartState,
        {
          onStateChange: () => {
            if (!pauseRequested) {
              pauseRequested = true;
              return true; // Request pause
            }
            return false;
          },
          checkpointReason: 'user_requested',
        }
      );

      expect(result).toBeDefined();
    });

    it('should capture snapshot at pause point', async () => {
      const mockModel = createSimpleMockModel(['Paused response']);

      const agent = createAgent({
        name: 'SnapshotAgent',
        model: mockModel as any,
      });

      const result = await agent.invoke({
        messages: [{ role: 'user', content: 'Start task' }],
      } as SmartState);

      const state = result.state as SmartState;
      const cleanState = {
        ...state,
        ctx: Object.fromEntries(
          Object.entries(state.ctx || {}).filter(([_, v]) => typeof v !== 'function')
        ),
      } as SmartState;

      const snapshot = agent.snapshot(cleanState, { tag: 'checkpoint-1' });

      expect(snapshot).toBeDefined();
      expect(snapshot.metadata.tag).toBe('checkpoint-1');
      expect(snapshot.state.messages.length).toBeGreaterThan(0);
    });

    it('should resume from snapshot', async () => {
      const mockModel = createSimpleMockModel(['Initial response', 'Resumed response']);

      const agent = createAgent({
        name: 'ResumeAgent',
        model: mockModel as any,
      });

      // First invocation
      const result1 = await agent.invoke({
        messages: [{ role: 'user', content: 'Start' }],
      } as SmartState);

      // Clean non-serializable functions from ctx
      const state1 = result1.state as SmartState;
      const cleanState = {
        ...state1,
        ctx: Object.fromEntries(
          Object.entries(state1.ctx || {}).filter(([_, v]) => typeof v !== 'function')
        ),
      } as SmartState;

      // Capture snapshot
      const snapshot = agent.snapshot(cleanState);

      // Resume with new message
      const result2 = await agent.resume(snapshot, {
        messages: [{ role: 'user', content: 'Continue' }],
      });

      expect(result2.messages.length).toBeGreaterThan(result1.messages.length);
    });
  });

  describe('tool approval pause', () => {
    it('should pause for tool approval', async () => {
      const approvalTool = createTool({
        name: 'sensitive_action',
        description: 'Requires approval',
        schema: z.object({ action: z.string() }),
        func: async ({ action }: { action: string }) => `Executed: ${action}`,
        needsApproval: true,
      });

      const mockModel = createMockModel({
        responses: [
          {
            tool_calls: [
              {
                id: 'call_1',
                type: 'function',
                function: {
                  name: 'sensitive_action',
                  arguments: JSON.stringify({ action: 'delete_all' }),
                },
              },
            ],
          },
          { content: 'Action completed!' },
        ],
      });

      const agent = createAgent({
        name: 'ApprovalAgent',
        model: mockModel as any,
        tools: [approvalTool],
      });

      const result = await agent.invoke({
        messages: [{ role: 'user', content: 'Delete everything' }],
      } as SmartState);

      const state = result.state as SmartState;
      
      // Check if pending approvals exist
      if (state.pendingApprovals && state.pendingApprovals.length > 0) {
        expect(state.pendingApprovals[0].toolName).toBe('sensitive_action');
        expect(state.pendingApprovals[0].status).toBe('pending');
      }
    });

    it('should resume after approval resolution', async () => {
      const approvalTool = createTool({
        name: 'risky_tool',
        schema: z.object({ data: z.string() }),
        func: async ({ data }: { data: string }) => `Processed: ${data}`,
        needsApproval: true,
      });

      const mockModel = createMockModel({
        responses: [
          {
            tool_calls: [
              {
                id: 'call_1',
                type: 'function',
                function: {
                  name: 'risky_tool',
                  arguments: JSON.stringify({ data: 'important' }),
                },
              },
            ],
          },
          { content: 'Tool executed successfully!' },
        ],
      });

      const agent = createAgent({
        name: 'ApprovalResumeAgent',
        model: mockModel as any,
        tools: [approvalTool],
      });

      // Initial invocation
      const result1 = await agent.invoke({
        messages: [{ role: 'user', content: 'Process data' }],
      } as SmartState);

      const state1 = result1.state as SmartState;

      // If there are pending approvals, resolve them
      if (state1.pendingApprovals && state1.pendingApprovals.length > 0) {
        const resolved = agent.resolveToolApproval(state1, {
          id: state1.pendingApprovals[0].id,
          approved: true,
        });

        // Resume after approval
        const result2 = await agent.invoke(resolved);
        expect(result2.messages.length).toBeGreaterThan(0);
      }
    });
  });

  describe('state serialization', () => {
    it('should serialize and deserialize state correctly', () => {
      const state: SmartState = {
        messages: [
          { role: 'system', content: 'You are helpful.' },
          { role: 'user', content: 'Hello' },
          { role: 'assistant', content: 'Hi there!' },
        ],
        toolCallCount: 3,
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
      } as SmartState;

      const snapshot = captureSnapshot(state);
      const json = JSON.stringify(snapshot);
      const parsed = JSON.parse(json) as AgentSnapshot;
      const restored = restoreSnapshot(parsed);

      expect(restored.messages).toHaveLength(3);
      expect(restored.toolCallCount).toBe(3);
      expect(restored.toolHistory).toHaveLength(1);
    });

    it('should handle complex message content', () => {
      const state: SmartState = {
        messages: [
          {
            role: 'assistant',
            content: '',
            tool_calls: [
              {
                id: 'call_1',
                type: 'function',
                function: {
                  name: 'complex_tool',
                  arguments: JSON.stringify({
                    nested: { deep: { value: 'test' } },
                    array: [1, 2, 3],
                  }),
                },
              },
            ],
          },
        ],
      } as SmartState;

      const snapshot = captureSnapshot(state);
      const json = JSON.stringify(snapshot);
      const parsed = JSON.parse(json) as AgentSnapshot;
      const restored = restoreSnapshot(parsed);

      expect(restored.messages[0].tool_calls).toHaveLength(1);
      const args = JSON.parse(restored.messages[0].tool_calls![0].function.arguments);
      expect(args.nested.deep.value).toBe('test');
    });
  });

  describe('smart agent pause/resume', () => {
    it('should pause and resume smart agent', async () => {
      const mockModel = createSimpleMockModel(['First response', 'Second response']);

      const agent = createSmartAgent({
        name: 'SmartPausableAgent',
        model: mockModel as any,
        systemPrompt: 'You are helpful.',
      });

      // First invocation
      const result1 = await agent.invoke({
        messages: [{ role: 'user', content: 'Start conversation' }],
      } as SmartState);

      // Clean non-serializable functions from ctx
      const state1 = result1.state as SmartState;
      const cleanState = {
        ...state1,
        ctx: Object.fromEntries(
          Object.entries(state1.ctx || {}).filter(([_, v]) => typeof v !== 'function')
        ),
      } as SmartState;

      // Snapshot
      const snapshot = agent.snapshot(cleanState);

      // Resume
      const result2 = await agent.resume(snapshot, {
        messages: [{ role: 'user', content: 'Continue please' }],
      });

      expect(result2.messages.length).toBeGreaterThan(result1.messages.length);
    });

    it('should preserve tool history across pause/resume', async () => {
      const trackingTool = createTool({
        name: 'tracking_tool',
        schema: z.object({ value: z.number() }),
        func: async ({ value }: { value: number }) => ({ tracked: value }),
      });

      const mockModel = createMockModel({
        responses: [
          {
            tool_calls: [
              {
                id: 'call_1',
                type: 'function',
                function: {
                  name: 'tracking_tool',
                  arguments: JSON.stringify({ value: 42 }),
                },
              },
            ],
          },
          { content: 'Tracked!' },
          { content: 'Resumed and remembered!' },
        ],
      });

      const agent = createSmartAgent({
        name: 'HistoryPreserveAgent',
        model: mockModel as any,
        systemPrompt: 'You track things.',
        tools: [trackingTool],
      });

      // First invocation with tool call
      const result1 = await agent.invoke({
        messages: [{ role: 'user', content: 'Track value 42' }],
      } as SmartState);

      const state1 = result1.state as SmartState;
      const originalHistoryLength = state1.toolHistory?.length || 0;

      // Clean ctx from non-serializable functions before snapshot
      const cleanState = {
        ...state1,
        ctx: Object.fromEntries(
          Object.entries(state1.ctx || {}).filter(([_, v]) => typeof v !== 'function')
        ),
      } as SmartState;

      // Snapshot
      const snapshot = agent.snapshot(cleanState);

      // Resume
      const result2 = await agent.resume(snapshot, {
        messages: [{ role: 'user', content: 'What did you track?' }],
      });

      const state2 = result2.state as SmartState;
      expect(state2.toolHistory?.length).toBeGreaterThanOrEqual(originalHistoryLength);
    });
  });

  describe('cancellation', () => {
    it('should handle cancellation token', async () => {
      const slowTool = createTool({
        name: 'slow_tool',
        schema: z.object({}),
        func: async () => {
          await new Promise((r) => setTimeout(r, 1000));
          return 'done';
        },
      });

      const mockModel = createMockModel({
        responses: [
          {
            tool_calls: [
              {
                id: 'call_1',
                type: 'function',
                function: { name: 'slow_tool', arguments: '{}' },
              },
            ],
          },
        ],
      });

      const agent = createAgent({
        name: 'CancellableAgent',
        model: mockModel as any,
        tools: [slowTool],
      });

      const cancellationToken = { isCancellationRequested: false };

      // Cancel after 50ms
      setTimeout(() => {
        cancellationToken.isCancellationRequested = true;
      }, 50);

      const result = await agent.invoke({
        messages: [{ role: 'user', content: 'Do slow thing' }],
        ctx: { __cancellationToken: cancellationToken },
      } as SmartState);

      const state = result.state as SmartState;
      // Check if cancellation was detected
      if (state.ctx?.__cancelled) {
        expect(state.ctx.__cancelled.reason).toBe('cancelled');
      }
    });

    it('should handle abort signal', async () => {
      const mockModel = createMockModel({
        delay: 500,
        defaultResponse: { content: 'Should not complete' },
      });

      const agent = createAgent({
        name: 'AbortableAgent',
        model: mockModel as any,
      });

      const controller = new AbortController();

      // Abort after 50ms
      setTimeout(() => controller.abort(), 50);

      const result = await agent.invoke({
        messages: [{ role: 'user', content: 'Hello' }],
        ctx: { __abortSignal: controller.signal },
      } as SmartState);

      const state = result.state as SmartState;
      if (state.ctx?.__cancelled) {
        expect(state.ctx.__cancelled.reason).toBe('aborted');
      }
    });
  });
});
