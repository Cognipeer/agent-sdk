/**
 * Mock Model Adapter for Testing
 * Simulates LLM responses without actual API calls
 */

import type { Message } from '../../../src/types.js';

export type MockModelResponse = {
  content?: string;
  tool_calls?: Array<{
    id: string;
    type: 'function';
    function: {
      name: string;
      arguments: string;
    };
  }>;
};

export type MockModelConfig = {
  responses?: MockModelResponse[];
  defaultResponse?: MockModelResponse;
  delay?: number;
  shouldFail?: boolean;
  failureMessage?: string;
  onInvoke?: (messages: Message[]) => MockModelResponse | Promise<MockModelResponse>;
};

export function createMockModel(config: MockModelConfig = {}) {
  let callIndex = 0;
  const invocations: Message[][] = [];

  const model = {
    invoke: async (messages: Message[]): Promise<Message> => {
      invocations.push([...messages]);

      if (config.delay) {
        await new Promise((resolve) => setTimeout(resolve, config.delay));
      }

      if (config.shouldFail) {
        throw new Error(config.failureMessage || 'Mock model failure');
      }

      let response: MockModelResponse;

      if (config.onInvoke) {
        response = await config.onInvoke(messages);
      } else if (config.responses && config.responses.length > 0) {
        response = config.responses[Math.min(callIndex, config.responses.length - 1)];
        callIndex++;
      } else {
        response = config.defaultResponse || { content: 'Mock response' };
      }

      const result: Message = {
        role: 'assistant',
        content: response.content || '',
      };

      if (response.tool_calls && response.tool_calls.length > 0) {
        result.tool_calls = response.tool_calls;
      }

      return result;
    },

    // Test utilities
    getInvocations: () => invocations,
    getCallCount: () => callIndex,
    reset: () => {
      callIndex = 0;
      invocations.length = 0;
    },
  };

  return model;
}

/**
 * Create a mock model that responds with specific tool calls
 */
export function createToolCallingMockModel(toolCalls: Array<{ name: string; args: Record<string, any> }>) {
  return createMockModel({
    responses: [
      {
        tool_calls: toolCalls.map((tc, i) => ({
          id: `call_${i}`,
          type: 'function' as const,
          function: {
            name: tc.name,
            arguments: JSON.stringify(tc.args),
          },
        })),
      },
      { content: 'Task completed.' },
    ],
  });
}

/**
 * Create a mock model that returns simple text responses
 */
export function createSimpleMockModel(responses: string[]) {
  return createMockModel({
    responses: responses.map((content) => ({ content })),
  });
}

/**
 * Create a mock model that alternates between tool calls and responses
 */
export function createConversationalMockModel(
  turns: Array<{ type: 'text'; content: string } | { type: 'tool_call'; name: string; args: Record<string, any> }>
) {
  return createMockModel({
    responses: turns.map((turn) => {
      if (turn.type === 'text') {
        return { content: turn.content };
      }
      return {
        tool_calls: [
          {
            id: `call_${Math.random().toString(36).slice(2, 8)}`,
            type: 'function' as const,
            function: {
              name: turn.name,
              arguments: JSON.stringify(turn.args),
            },
          },
        ],
      };
    }),
  });
}
