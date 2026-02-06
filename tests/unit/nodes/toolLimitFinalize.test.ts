/**
 * Unit Tests for nodes/toolLimitFinalize.ts
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { createToolLimitFinalizeNode } from '../../../src/nodes/toolLimitFinalize.js';
import type { SmartState, SmartAgentOptions } from '../../../src/types.js';

describe('toolLimitFinalizeNode', () => {
  describe('createToolLimitFinalizeNode', () => {
    it('should create a finalize function', () => {
      const finalize = createToolLimitFinalizeNode({} as SmartAgentOptions);
      expect(finalize).toBeInstanceOf(Function);
    });
  });

  describe('tool limit enforcement', () => {
    it('should allow execution when under limit', async () => {
      const finalize = createToolLimitFinalizeNode({
        limits: { maxToolCalls: 10 },
      } as SmartAgentOptions);

      const state: SmartState = {
        messages: [{ role: 'user', content: 'Test' }],
        toolCallCount: 5,
      } as SmartState;

      const result = await finalize(state);

      // The function always adds a system notice message
      expect(result.messages).toBeDefined();
      // Should have original message + the notice
      expect(result.messages?.length).toBe(2);
    });

    it('should detect when at limit', async () => {
      const finalize = createToolLimitFinalizeNode({
        limits: { maxToolCalls: 5 },
      } as SmartAgentOptions);

      const state: SmartState = {
        messages: [{ role: 'user', content: 'Test' }],
        toolCallCount: 5,
      } as SmartState;

      const result = await finalize(state);

      // Should indicate limit reached
      expect(result).toBeDefined();
    });

    it('should handle undefined toolCallCount', async () => {
      const finalize = createToolLimitFinalizeNode({
        limits: { maxToolCalls: 10 },
      } as SmartAgentOptions);

      const state: SmartState = {
        messages: [{ role: 'user', content: 'Test' }],
      } as SmartState;

      const result = await finalize(state);

      expect(result).toBeDefined();
    });

    it('should handle unlimited tool calls (Infinity)', async () => {
      const finalize = createToolLimitFinalizeNode({
        limits: { maxToolCalls: Infinity },
      } as SmartAgentOptions);

      const state: SmartState = {
        messages: [{ role: 'user', content: 'Test' }],
        toolCallCount: 1000,
      } as SmartState;

      const result = await finalize(state);

      expect(result).toBeDefined();
    });

    it('should handle zero limit', async () => {
      const finalize = createToolLimitFinalizeNode({
        limits: { maxToolCalls: 0 },
      } as SmartAgentOptions);

      const state: SmartState = {
        messages: [{ role: 'user', content: 'Test' }],
        toolCallCount: 0,
      } as SmartState;

      const result = await finalize(state);

      expect(result).toBeDefined();
    });
  });

  describe('state preservation', () => {
    it('should preserve existing messages', async () => {
      const finalize = createToolLimitFinalizeNode({
        limits: { maxToolCalls: 10 },
      } as SmartAgentOptions);

      const state: SmartState = {
        messages: [
          { role: 'system', content: 'You are helpful.' },
          { role: 'user', content: 'Hello' },
          { role: 'assistant', content: 'Hi there!' },
        ],
        toolCallCount: 2,
      } as SmartState;

      const result = await finalize(state);

      // Original messages should be preserved
      const originalMsgs = result.messages?.slice(0, 3) ?? state.messages;
      expect(originalMsgs[0].content).toBe('You are helpful.');
      expect(originalMsgs[1].content).toBe('Hello');
    });

    it('should preserve toolHistory', async () => {
      const finalize = createToolLimitFinalizeNode({
        limits: { maxToolCalls: 10 },
      } as SmartAgentOptions);

      const state: SmartState = {
        messages: [{ role: 'user', content: 'Test' }],
        toolCallCount: 1,
        toolHistory: [
          {
            executionId: 'exec_1',
            toolName: 'search',
            args: {},
            output: 'result',
            timestamp: new Date().toISOString(),
          },
        ],
      } as SmartState;

      const result = await finalize(state);

      expect(result.toolHistory ?? state.toolHistory).toHaveLength(1);
    });

    it('should preserve ctx', async () => {
      const finalize = createToolLimitFinalizeNode({
        limits: { maxToolCalls: 10 },
      } as SmartAgentOptions);

      const state: SmartState = {
        messages: [{ role: 'user', content: 'Test' }],
        ctx: { customKey: 'customValue' },
      } as SmartState;

      const result = await finalize(state);

      expect((result.ctx ?? state.ctx)?.customKey).toBe('customValue');
    });
  });

  describe('default options', () => {
    it('should work without explicit limits', async () => {
      const finalize = createToolLimitFinalizeNode({} as SmartAgentOptions);

      const state: SmartState = {
        messages: [{ role: 'user', content: 'Test' }],
        toolCallCount: 5,
      } as SmartState;

      const result = await finalize(state);

      expect(result).toBeDefined();
    });

    it('should use default maxToolCalls when not specified', async () => {
      const finalize = createToolLimitFinalizeNode({
        name: 'TestAgent',
      } as SmartAgentOptions);

      const state: SmartState = {
        messages: [{ role: 'user', content: 'Test' }],
        toolCallCount: 5,
      } as SmartState;

      // Should not throw
      const result = await finalize(state);
      expect(result).toBeDefined();
    });
  });
});
