/**
 * Unit Tests for prompts.ts
 */

import { describe, it, expect } from 'vitest';
import { buildSystemPrompt } from '../../src/prompts.js';

describe('buildSystemPrompt', () => {
  describe('basic prompt building', () => {
    it('should build a simple system prompt', () => {
      const prompt = buildSystemPrompt('You are a helpful assistant.', false, 'TestAgent');

      expect(prompt).toContain('You are a helpful assistant.');
      expect(prompt).toContain('TestAgent');
    });

    it('should handle empty base prompt', () => {
      const prompt = buildSystemPrompt('', false, 'Agent');

      expect(prompt).toBeDefined();
      expect(typeof prompt).toBe('string');
    });

    it('should handle undefined base prompt', () => {
      const prompt = buildSystemPrompt(undefined as any, false, 'Agent');

      expect(prompt).toBeDefined();
      expect(typeof prompt).toBe('string');
    });
  });

  describe('todo list integration', () => {
    it('should include todo list instructions when enabled', () => {
      const prompt = buildSystemPrompt('Base prompt', true, 'PlanningAgent');

      expect(prompt).toContain('todo');
    });

    it('should not include todo list instructions when disabled', () => {
      const prompt = buildSystemPrompt('Base prompt', false, 'SimpleAgent');
      const promptLower = prompt.toLowerCase();

      // Should not have explicit todo tool mentions (unless in base prompt)
      expect(promptLower.includes('manage_todo_list')).toBe(false);
    });
  });

  describe('agent name integration', () => {
    it('should include agent name in prompt', () => {
      const prompt = buildSystemPrompt('You help with coding.', false, 'CodingAssistant');

      expect(prompt).toContain('CodingAssistant');
    });

    it('should handle special characters in agent name', () => {
      const prompt = buildSystemPrompt('Base', false, 'Agent-v2.0');

      expect(prompt).toContain('Agent-v2.0');
    });
  });

  describe('prompt structure', () => {
    it('should produce a non-empty prompt', () => {
      const prompt = buildSystemPrompt('Test', false, 'Agent');

      expect(prompt.length).toBeGreaterThan(0);
    });

    it('should preserve base prompt content', () => {
      const basePrompt = 'You are an expert in TypeScript and React development.';
      const prompt = buildSystemPrompt(basePrompt, false, 'DevAgent');

      expect(prompt).toContain(basePrompt);
    });

    it('should handle multiline base prompts', () => {
      const basePrompt = `You are a helpful assistant.
You should:
- Be concise
- Be accurate
- Be helpful`;
      const prompt = buildSystemPrompt(basePrompt, true, 'MultilineAgent');

      expect(prompt).toContain('Be concise');
      expect(prompt).toContain('Be accurate');
      expect(prompt).toContain('Be helpful');
    });
  });
});
