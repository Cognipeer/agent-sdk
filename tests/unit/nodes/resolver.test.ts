/**
 * Unit Tests for nodes/resolver.ts
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { createResolverNode } from '../../../src/nodes/resolver.js';
import type { SmartState } from '../../../src/types.js';

describe('resolverNode', () => {
  let resolver: ReturnType<typeof createResolverNode>;

  beforeEach(() => {
    resolver = createResolverNode();
  });

  describe('createResolverNode', () => {
    it('should create a resolver function', () => {
      expect(resolver).toBeInstanceOf(Function);
    });
  });

  describe('message resolution', () => {
    it('should pass through basic state unchanged', async () => {
      const state: SmartState = {
        messages: [{ role: 'user', content: 'Hello' }],
      } as SmartState;

      const result = await resolver(state);

      expect(result.messages).toHaveLength(1);
      expect(result.messages[0].content).toBe('Hello');
    });

    it('should handle empty messages array', async () => {
      const state: SmartState = {
        messages: [],
      } as SmartState;

      const result = await resolver(state);

      expect(result.messages).toHaveLength(0);
    });

    it('should preserve message roles', async () => {
      const state: SmartState = {
        messages: [
          { role: 'system', content: 'You are helpful.' },
          { role: 'user', content: 'Hi' },
          { role: 'assistant', content: 'Hello!' },
        ],
      } as SmartState;

      const result = await resolver(state);

      expect(result.messages[0].role).toBe('system');
      expect(result.messages[1].role).toBe('user');
      expect(result.messages[2].role).toBe('assistant');
    });

    it('should handle tool messages', async () => {
      const state: SmartState = {
        messages: [
          { role: 'user', content: 'Calculate 2+2' },
          {
            role: 'assistant',
            content: '',
            tool_calls: [
              {
                id: 'call_1',
                type: 'function',
                function: { name: 'calc', arguments: '{"a":2,"b":2}' },
              },
            ],
          },
          { role: 'tool', tool_call_id: 'call_1', name: 'calc', content: '4' },
        ],
      } as SmartState;

      const result = await resolver(state);

      expect(result.messages).toHaveLength(3);
      const toolMsg = result.messages[2];
      expect(toolMsg.role).toBe('tool');
      expect(toolMsg.content).toBe('4');
    });
  });

  describe('state properties', () => {
    it('should preserve toolCallCount', async () => {
      const state: SmartState = {
        messages: [{ role: 'user', content: 'Test' }],
        toolCallCount: 5,
      } as SmartState;

      const result = await resolver(state);

      expect(result.toolCallCount).toBe(5);
    });

    it('should preserve toolHistory', async () => {
      const state: SmartState = {
        messages: [{ role: 'user', content: 'Test' }],
        toolHistory: [
          {
            executionId: 'exec_1',
            toolName: 'search',
            args: { q: 'test' },
            output: 'results',
            timestamp: '2024-01-01T00:00:00.000Z',
          },
        ],
      } as SmartState;

      const result = await resolver(state);

      expect(result.toolHistory).toHaveLength(1);
      expect(result.toolHistory![0].toolName).toBe('search');
    });

    it('should preserve ctx', async () => {
      const state: SmartState = {
        messages: [{ role: 'user', content: 'Test' }],
        ctx: { customData: 'value' },
      } as SmartState;

      const result = await resolver(state);

      expect(result.ctx?.customData).toBe('value');
    });
  });

  describe('edge cases', () => {
    it('should handle multiline content', async () => {
      const state: SmartState = {
        messages: [
          {
            role: 'user',
            content: `Line 1
Line 2
Line 3`,
          },
        ],
      } as SmartState;

      const result = await resolver(state);

      expect(result.messages[0].content).toContain('Line 1');
      expect(result.messages[0].content).toContain('Line 3');
    });

    it('should handle special characters', async () => {
      const state: SmartState = {
        messages: [
          { role: 'user', content: 'Special: <script>alert("xss")</script>' },
        ],
      } as SmartState;

      const result = await resolver(state);

      expect(result.messages[0].content).toContain('<script>');
    });

    it('should handle unicode content', async () => {
      const state: SmartState = {
        messages: [
          { role: 'user', content: '你好世界 🌍 مرحبا' },
        ],
      } as SmartState;

      const result = await resolver(state);

      expect(result.messages[0].content).toContain('你好');
      expect(result.messages[0].content).toContain('🌍');
    });
  });
});
