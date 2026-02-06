/**
 * Unit Tests for utils/tokenManager.ts and utilTokens.ts
 */

import { describe, it, expect } from 'vitest';
import { applyTokenLimits } from '../../../src/utils/tokenManager.js';
import { countApproxTokens } from '../../../src/utils/utilTokens.js';
import type { Message } from '../../../src/types.js';

describe('tokenManager', () => {
  describe('applyTokenLimits', () => {
    it('should return state unchanged when under limit', async () => {
      const state = {
        messages: [
          { role: 'user', content: 'Hello' },
          { role: 'assistant', content: 'Hi there!' },
        ] as Message[],
      };

      const result = await applyTokenLimits({
        state,
        limits: {
          contextTokenLimit: 10000,
          summaryTokenLimit: 1000,
        },
      });

      expect(result.messages).toHaveLength(2);
    });

    it('should handle empty messages', async () => {
      const state = {
        messages: [] as Message[],
      };

      const result = await applyTokenLimits({
        state,
        limits: {
          contextTokenLimit: 1000,
          summaryTokenLimit: 500,
        },
      });

      expect(result.messages).toHaveLength(0);
    });

    it('should work with large messages', async () => {
      const largeContent = 'word '.repeat(500);
      const state = {
        messages: [
          { role: 'user', content: largeContent },
        ] as Message[],
      };

      const result = await applyTokenLimits({
        state,
        limits: {
          contextTokenLimit: 10000,
          summaryTokenLimit: 1000,
        },
      });

      expect(result.messages.length).toBeGreaterThan(0);
    });
  });

  describe('countApproxTokens', () => {
    it('should count tokens in a simple string', () => {
      const count = countApproxTokens('Hello, world!');
      expect(count).toBeGreaterThan(0);
      expect(count).toBeLessThan(20);
    });

    it('should return 0 for empty string', () => {
      const count = countApproxTokens('');
      expect(count).toBe(0);
    });

    it('should handle longer text', () => {
      const longText = 'This is a longer text that contains multiple sentences. '.repeat(10);
      const count = countApproxTokens(longText);
      expect(count).toBeGreaterThan(50);
    });

    it('should handle unicode text', () => {
      const unicodeText = '你好世界 🌍 مرحبا';
      const count = countApproxTokens(unicodeText);
      expect(count).toBeGreaterThan(0);
    });

    it('should handle newlines', () => {
      const multilineText = 'Line 1\nLine 2\nLine 3';
      const count = countApproxTokens(multilineText);
      expect(count).toBeGreaterThan(0);
    });

    it('should handle special characters', () => {
      const specialText = '<script>alert("test")</script>';
      const count = countApproxTokens(specialText);
      expect(count).toBeGreaterThan(0);
    });

    it('should handle JSON strings', () => {
      const jsonString = JSON.stringify({ key: 'value', array: [1, 2, 3] });
      const count = countApproxTokens(jsonString);
      expect(count).toBeGreaterThan(5);
    });

    it('should handle code snippets', () => {
      const code = `
function hello(name: string) {
  console.log(\`Hello, \${name}!\`);
  return true;
}
      `;
      const count = countApproxTokens(code);
      expect(count).toBeGreaterThan(10);
    });
  });

  describe('token estimation accuracy', () => {
    it('should estimate ~4 chars per token for English text', () => {
      const text = 'This is a test sentence with exactly forty characters here.';
      const count = countApproxTokens(text);
      
      expect(count).toBeGreaterThan(5);
      expect(count).toBeLessThan(30);
    });

    it('should handle repeated words', () => {
      const repeated = 'test '.repeat(100);
      const count = countApproxTokens(repeated);
      
      expect(count).toBeGreaterThan(50);
      expect(count).toBeLessThan(300);
    });
  });
});
