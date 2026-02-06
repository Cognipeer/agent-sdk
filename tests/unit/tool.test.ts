/**
 * Unit Tests for tool.ts
 */

import { describe, it, expect, vi } from 'vitest';
import { createTool } from '../../src/tool.js';
import { z } from 'zod';

describe('createTool', () => {
  describe('basic tool creation', () => {
    it('should create a tool with required properties', () => {
      const tool = createTool({
        name: 'test_tool',
        description: 'A test tool',
        schema: z.object({ input: z.string() }),
        func: async ({ input }) => `processed: ${input}`,
      });

      expect(tool.name).toBe('test_tool');
      expect(tool.description).toBe('A test tool');
      expect(tool.schema).toBeDefined();
      expect(tool.invoke).toBeInstanceOf(Function);
      expect(tool.call).toBeInstanceOf(Function);
    });

    it('should create a tool without description', () => {
      const tool = createTool({
        name: 'minimal_tool',
        schema: z.object({}),
        func: async () => 'done',
      });

      expect(tool.name).toBe('minimal_tool');
      expect(tool.description).toBeUndefined();
    });
  });

  describe('tool execution', () => {
    it('should execute tool function via invoke', async () => {
      const tool = createTool({
        name: 'echo',
        schema: z.object({ message: z.string() }),
        func: async ({ message }) => message.toUpperCase(),
      });

      const result = await tool.invoke?.({ message: 'hello' });
      expect(result).toBe('HELLO');
    });

    it('should execute tool function via call', async () => {
      const tool = createTool({
        name: 'echo',
        schema: z.object({ message: z.string() }),
        func: async ({ message }) => message.toUpperCase(),
      });

      const result = await tool.call?.({ message: 'world' });
      expect(result).toBe('WORLD');
    });

    it('should handle synchronous functions', async () => {
      const tool = createTool({
        name: 'sync_tool',
        schema: z.object({ value: z.number() }),
        func: ({ value }) => value * 2,
      });

      const result = await tool.invoke?.({ value: 5 });
      expect(result).toBe(10);
    });

    it('should propagate errors from tool function', async () => {
      const tool = createTool({
        name: 'failing_tool',
        schema: z.object({}),
        func: async () => {
          throw new Error('Tool execution failed');
        },
      });

      await expect(tool.invoke?.({})).rejects.toThrow('Tool execution failed');
    });
  });

  describe('approval configuration', () => {
    it('should set needsApproval flag', () => {
      const tool = createTool({
        name: 'approval_tool',
        schema: z.object({}),
        func: async () => 'done',
        needsApproval: true,
      });

      expect((tool as any).needsApproval).toBe(true);
    });

    it('should set approvalPrompt', () => {
      const tool = createTool({
        name: 'approval_tool',
        schema: z.object({}),
        func: async () => 'done',
        needsApproval: true,
        approvalPrompt: 'Are you sure?',
      });

      expect((tool as any).approvalPrompt).toBe('Are you sure?');
    });

    it('should set approvalDefaults', () => {
      const defaults = { timeout: 30000, autoApprove: false };
      const tool = createTool({
        name: 'approval_tool',
        schema: z.object({}),
        func: async () => 'done',
        approvalDefaults: defaults,
      });

      expect((tool as any).approvalDefaults).toEqual(defaults);
    });

    it('should not set approval properties if not provided', () => {
      const tool = createTool({
        name: 'simple_tool',
        schema: z.object({}),
        func: async () => 'done',
      });

      expect((tool as any).needsApproval).toBeUndefined();
      expect((tool as any).approvalPrompt).toBeUndefined();
      expect((tool as any).approvalDefaults).toBeUndefined();
    });
  });

  describe('complex schemas', () => {
    it('should handle nested object schemas', async () => {
      const tool = createTool({
        name: 'nested_tool',
        schema: z.object({
          user: z.object({
            name: z.string(),
            age: z.number(),
          }),
          settings: z.object({
            enabled: z.boolean(),
          }),
        }),
        func: async ({ user, settings }) => ({
          greeting: `Hello ${user.name}, age ${user.age}`,
          active: settings.enabled,
        }),
      });

      const result = await tool.invoke?.({
        user: { name: 'Alice', age: 30 },
        settings: { enabled: true },
      });

      expect(result).toEqual({
        greeting: 'Hello Alice, age 30',
        active: true,
      });
    });

    it('should handle array schemas', async () => {
      const tool = createTool({
        name: 'array_tool',
        schema: z.object({
          items: z.array(z.string()),
        }),
        func: async ({ items }) => items.join(', '),
      });

      const result = await tool.invoke?.({ items: ['a', 'b', 'c'] });
      expect(result).toBe('a, b, c');
    });

    it('should handle optional fields', async () => {
      const tool = createTool({
        name: 'optional_tool',
        schema: z.object({
          required: z.string(),
          optional: z.string().optional(),
        }),
        func: async ({ required, optional }) => ({
          required,
          optional: optional ?? 'default',
        }),
      });

      const result = await tool.invoke?.({ required: 'value' });
      expect(result).toEqual({ required: 'value', optional: 'default' });
    });

    it('should handle enum schemas', async () => {
      const tool = createTool({
        name: 'enum_tool',
        schema: z.object({
          operation: z.enum(['add', 'subtract', 'multiply']),
        }),
        func: async ({ operation }) => `Operation: ${operation}`,
      });

      const result = await tool.invoke?.({ operation: 'add' });
      expect(result).toBe('Operation: add');
    });
  });

  describe('metadata', () => {
    it('should set __source to smart', () => {
      const tool = createTool({
        name: 'meta_tool',
        schema: z.object({}),
        func: async () => 'done',
      });

      expect((tool as any).__source).toBe('smart');
    });

    it('should preserve __impl reference', () => {
      const impl = async () => 'done';
      const tool = createTool({
        name: 'meta_tool',
        schema: z.object({}),
        func: impl,
      });

      expect((tool as any).__impl).toBe(impl);
    });
  });
});
