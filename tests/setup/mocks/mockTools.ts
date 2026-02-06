/**
 * Mock Tools for Testing
 */

import { z } from 'zod';
import { createTool } from '../../../src/tool.js';

/**
 * Simple echo tool - returns input as output
 */
export const echoTool = createTool({
  name: 'echo',
  description: 'Echoes the input message back',
  schema: z.object({
    message: z.string().describe('Message to echo'),
  }),
  func: async ({ message }) => message,
});

/**
 * Calculator tool - performs basic math
 */
export const calculatorTool = createTool({
  name: 'calculator',
  description: 'Performs basic arithmetic operations',
  schema: z.object({
    operation: z.enum(['add', 'subtract', 'multiply', 'divide']).describe('Math operation'),
    a: z.number().describe('First operand'),
    b: z.number().describe('Second operand'),
  }),
  func: async ({ operation, a, b }) => {
    switch (operation) {
      case 'add':
        return a + b;
      case 'subtract':
        return a - b;
      case 'multiply':
        return a * b;
      case 'divide':
        if (b === 0) throw new Error('Division by zero');
        return a / b;
    }
  },
});

/**
 * Failing tool - always throws an error
 */
export const failingTool = createTool({
  name: 'failing_tool',
  description: 'A tool that always fails',
  schema: z.object({
    input: z.string().optional(),
  }),
  func: async () => {
    throw new Error('Intentional tool failure');
  },
});

/**
 * Slow tool - simulates async operation
 */
export const slowTool = createTool({
  name: 'slow_tool',
  description: 'A tool that takes time to complete',
  schema: z.object({
    delayMs: z.number().default(100).describe('Delay in milliseconds'),
  }),
  func: async ({ delayMs }) => {
    await new Promise((resolve) => setTimeout(resolve, delayMs));
    return 'Completed after delay';
  },
});

/**
 * State tracking tool - tracks how many times it was called
 */
export function createStatefulTool() {
  let callCount = 0;
  const calls: any[] = [];

  const tool = createTool({
    name: 'stateful_tool',
    description: 'Tracks its own invocations',
    schema: z.object({
      data: z.any().optional(),
    }),
    func: async ({ data }) => {
      callCount++;
      calls.push({ data, timestamp: Date.now() });
      return { callCount, data };
    },
  });

  return {
    tool,
    getCallCount: () => callCount,
    getCalls: () => calls,
    reset: () => {
      callCount = 0;
      calls.length = 0;
    },
  };
}

/**
 * Tool that requires approval
 */
export const approvalRequiredTool = createTool({
  name: 'approval_required',
  description: 'A tool that requires user approval before execution',
  schema: z.object({
    action: z.string().describe('Action to perform'),
  }),
  func: async ({ action }) => `Executed: ${action}`,
  needsApproval: true,
  approvalPrompt: 'This action requires your approval. Proceed?',
});

/**
 * Search tool - simulates a search operation
 */
export const searchTool = createTool({
  name: 'search',
  description: 'Search for information',
  schema: z.object({
    query: z.string().describe('Search query'),
    limit: z.number().optional().default(10).describe('Max results'),
  }),
  func: async ({ query, limit }) => {
    return {
      results: Array.from({ length: Math.min(limit || 10, 5) }, (_, i) => ({
        title: `Result ${i + 1} for "${query}"`,
        snippet: `This is a mock result for the query: ${query}`,
      })),
      total: limit || 10,
    };
  },
});

/**
 * File operation tool
 */
export const fileOperationTool = createTool({
  name: 'file_operation',
  description: 'Simulates file operations',
  schema: z.object({
    operation: z.enum(['read', 'write', 'delete']),
    path: z.string(),
    content: z.string().optional(),
  }),
  func: async ({ operation, path, content }) => {
    switch (operation) {
      case 'read':
        return { content: `Mock content of ${path}` };
      case 'write':
        return { success: true, path, bytesWritten: content?.length || 0 };
      case 'delete':
        return { success: true, path };
    }
  },
});

/**
 * Get all mock tools as an array
 */
export function getAllMockTools() {
  return [echoTool, calculatorTool, searchTool, fileOperationTool];
}
