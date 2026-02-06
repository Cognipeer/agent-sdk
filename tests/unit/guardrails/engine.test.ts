/**
 * Unit Tests for guardrails/engine.ts
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { evaluateGuardrails } from '../../../src/guardrails/engine.js';
import { GuardrailPhase } from '../../../src/types.js';
import type {
  ConversationGuardrail,
  SmartState,
  SmartAgentOptions,
  AgentRuntimeConfig,
  GuardrailContext,
} from '../../../src/types.js';

describe('guardrails/engine', () => {
  let baseState: SmartState;
  let baseRuntime: AgentRuntimeConfig;
  let baseOptions: SmartAgentOptions;

  beforeEach(() => {
    baseState = {
      messages: [
        { role: 'user', content: 'Hello, how are you?' },
      ],
    } as SmartState;

    baseRuntime = {
      name: 'TestAgent',
      model: {} as any,
      tools: [],
    } as AgentRuntimeConfig;

    baseOptions = {
      name: 'TestAgent',
      model: {} as any,
    } as SmartAgentOptions;
  });

  describe('evaluateGuardrails', () => {
    it('should return ok:true when no guardrails are provided', async () => {
      const result = await evaluateGuardrails({
        guardrails: [],
        phase: GuardrailPhase.Request,
        state: baseState,
        runtime: baseRuntime,
        options: baseOptions,
      });

      expect(result.ok).toBe(true);
      expect(result.incidents).toHaveLength(0);
    });

    it('should return ok:true when guardrails pass', async () => {
      const guardrail: ConversationGuardrail = {
        id: 'test-guardrail',
        title: 'Test Guardrail',
        appliesTo: [GuardrailPhase.Request],
        rules: [
          {
            id: 'rule-1',
            title: 'Always Pass',
            evaluate: () => ({ passed: true }),
          },
        ],
      };

      const result = await evaluateGuardrails({
        guardrails: [guardrail],
        phase: GuardrailPhase.Request,
        state: baseState,
        runtime: baseRuntime,
        options: baseOptions,
      });

      expect(result.ok).toBe(true);
      expect(result.incidents).toHaveLength(0);
    });

    it('should return ok:false when a guardrail fails', async () => {
      const guardrail: ConversationGuardrail = {
        id: 'blocking-guardrail',
        title: 'Blocking Guardrail',
        appliesTo: [GuardrailPhase.Request],
        rules: [
          {
            id: 'rule-block',
            title: 'Always Block',
            evaluate: () => ({
              passed: false,
              reason: 'Blocked by test',
              disposition: 'block' as const,
            }),
          },
        ],
      };

      const result = await evaluateGuardrails({
        guardrails: [guardrail],
        phase: GuardrailPhase.Request,
        state: baseState,
        runtime: baseRuntime,
        options: baseOptions,
      });

      expect(result.ok).toBe(false);
      expect(result.incidents).toHaveLength(1);
      expect(result.incidents[0].reason).toBe('Blocked by test');
      expect(result.incidents[0].disposition).toBe('block');
    });

    it('should skip guardrails that do not apply to current phase', async () => {
      const requestOnlyGuardrail: ConversationGuardrail = {
        id: 'request-only',
        appliesTo: [GuardrailPhase.Request],
        rules: [
          {
            evaluate: () => ({ passed: false, reason: 'Should not run' }),
          },
        ],
      };

      const result = await evaluateGuardrails({
        guardrails: [requestOnlyGuardrail],
        phase: GuardrailPhase.Response, // Different phase
        state: baseState,
        runtime: baseRuntime,
        options: baseOptions,
      });

      expect(result.ok).toBe(true);
      expect(result.incidents).toHaveLength(0);
    });

    it('should evaluate multiple rules in order', async () => {
      const evaluationOrder: string[] = [];

      const guardrail: ConversationGuardrail = {
        id: 'multi-rule',
        appliesTo: [GuardrailPhase.Request],
        rules: [
          {
            id: 'rule-1',
            evaluate: () => {
              evaluationOrder.push('rule-1');
              return { passed: true };
            },
          },
          {
            id: 'rule-2',
            evaluate: () => {
              evaluationOrder.push('rule-2');
              return { passed: true };
            },
          },
          {
            id: 'rule-3',
            evaluate: () => {
              evaluationOrder.push('rule-3');
              return { passed: true };
            },
          },
        ],
      };

      await evaluateGuardrails({
        guardrails: [guardrail],
        phase: GuardrailPhase.Request,
        state: baseState,
        runtime: baseRuntime,
        options: baseOptions,
      });

      expect(evaluationOrder).toEqual(['rule-1', 'rule-2', 'rule-3']);
    });

    it('should collect all incidents from failed rules', async () => {
      const guardrail: ConversationGuardrail = {
        id: 'multi-fail',
        appliesTo: [GuardrailPhase.Request],
        rules: [
          {
            id: 'fail-1',
            evaluate: () => ({ passed: false, reason: 'Reason 1', disposition: 'warn' as const }),
          },
          {
            id: 'fail-2',
            evaluate: () => ({ passed: false, reason: 'Reason 2', disposition: 'warn' as const }),
          },
        ],
      };

      const result = await evaluateGuardrails({
        guardrails: [guardrail],
        phase: GuardrailPhase.Request,
        state: baseState,
        runtime: baseRuntime,
        options: baseOptions,
      });

      expect(result.incidents).toHaveLength(2);
      expect(result.incidents[0].reason).toBe('Reason 1');
      expect(result.incidents[1].reason).toBe('Reason 2');
    });

    it('should handle async rule evaluation', async () => {
      const guardrail: ConversationGuardrail = {
        id: 'async-guardrail',
        appliesTo: [GuardrailPhase.Request],
        rules: [
          {
            id: 'async-rule',
            evaluate: async () => {
              await new Promise((r) => setTimeout(r, 10));
              return { passed: true };
            },
          },
        ],
      };

      const result = await evaluateGuardrails({
        guardrails: [guardrail],
        phase: GuardrailPhase.Request,
        state: baseState,
        runtime: baseRuntime,
        options: baseOptions,
      });

      expect(result.ok).toBe(true);
    });

    it('should handle rule evaluation errors gracefully', async () => {
      const guardrail: ConversationGuardrail = {
        id: 'error-guardrail',
        appliesTo: [GuardrailPhase.Request],
        rules: [
          {
            id: 'throwing-rule',
            evaluate: () => {
              throw new Error('Rule evaluation error');
            },
          },
        ],
      };

      const result = await evaluateGuardrails({
        guardrails: [guardrail],
        phase: GuardrailPhase.Request,
        state: baseState,
        runtime: baseRuntime,
        options: baseOptions,
      });

      expect(result.ok).toBe(false);
      expect(result.incidents).toHaveLength(1);
      expect(result.incidents[0].reason).toBe('Rule evaluation error');
      expect(result.incidents[0].disposition).toBe('block');
    });

    it('should provide correct context to rules', async () => {
      let capturedContext: any = null;

      const guardrail: ConversationGuardrail = {
        id: 'context-test',
        appliesTo: [GuardrailPhase.Request],
        rules: [
          {
            evaluate: (context: GuardrailContext) => {
              capturedContext = context;
              return { passed: true };
            },
          },
        ],
      };

      await evaluateGuardrails({
        guardrails: [guardrail],
        phase: GuardrailPhase.Request,
        state: baseState,
        runtime: baseRuntime,
        options: baseOptions,
      });

      expect(capturedContext).not.toBeNull();
      expect(capturedContext.phase).toBe(GuardrailPhase.Request);
      expect(capturedContext.messages).toEqual(baseState.messages);
      expect(capturedContext.latestMessage).toEqual(baseState.messages[0]);
      expect(capturedContext.state).toBe(baseState);
      expect(capturedContext.runtime).toBe(baseRuntime);
      expect(capturedContext.options).toBe(baseOptions);
    });

    it('should handle warn disposition without blocking', async () => {
      const guardrail: ConversationGuardrail = {
        id: 'warn-guardrail',
        appliesTo: [GuardrailPhase.Request],
        rules: [
          {
            id: 'warn-rule',
            evaluate: () => ({
              passed: false,
              reason: 'This is a warning',
              disposition: 'warn' as const,
            }),
          },
        ],
      };

      const result = await evaluateGuardrails({
        guardrails: [guardrail],
        phase: GuardrailPhase.Request,
        state: baseState,
        runtime: baseRuntime,
        options: baseOptions,
      });

      // Warn should still result in ok:false but with warn disposition
      expect(result.incidents).toHaveLength(1);
      expect(result.incidents[0].disposition).toBe('warn');
    });

    it('should evaluate multiple guardrails', async () => {
      const guardrail1: ConversationGuardrail = {
        id: 'guardrail-1',
        appliesTo: [GuardrailPhase.Request],
        rules: [{ evaluate: () => ({ passed: true }) }],
      };

      const guardrail2: ConversationGuardrail = {
        id: 'guardrail-2',
        appliesTo: [GuardrailPhase.Request],
        rules: [
          { evaluate: () => ({ passed: false, reason: 'Blocked', disposition: 'block' as const }) },
        ],
      };

      const result = await evaluateGuardrails({
        guardrails: [guardrail1, guardrail2],
        phase: GuardrailPhase.Request,
        state: baseState,
        runtime: baseRuntime,
        options: baseOptions,
      });

      expect(result.ok).toBe(false);
      expect(result.incidents).toHaveLength(1);
    });

    it('should support onViolation callback', async () => {
      const onViolation = vi.fn().mockReturnValue('allow');

      const guardrail: ConversationGuardrail = {
        id: 'callback-guardrail',
        appliesTo: [GuardrailPhase.Request],
        rules: [
          {
            id: 'fail-rule',
            evaluate: () => ({ passed: false, reason: 'Failed', disposition: 'block' as const }),
          },
        ],
        onViolation,
      };

      await evaluateGuardrails({
        guardrails: [guardrail],
        phase: GuardrailPhase.Request,
        state: baseState,
        runtime: baseRuntime,
        options: baseOptions,
      });

      expect(onViolation).toHaveBeenCalled();
    });
  });

  describe('content-based guardrails', () => {
    it('should detect forbidden words', async () => {
      const forbiddenWords = ['spam', 'hack', 'attack'];

      const guardrail: ConversationGuardrail = {
        id: 'content-filter',
        appliesTo: [GuardrailPhase.Request],
        rules: [
          {
            id: 'forbidden-words',
            evaluate: (ctx: GuardrailContext) => {
              const content =
                typeof ctx.latestMessage?.content === 'string'
                  ? ctx.latestMessage.content.toLowerCase()
                  : '';
              const found = forbiddenWords.find((word) => content.includes(word));
              return found
                ? { passed: false, reason: `Forbidden word: ${found}`, disposition: 'block' as const }
                : { passed: true };
            },
          },
        ],
      };

      // Test with clean content
      let result = await evaluateGuardrails({
        guardrails: [guardrail],
        phase: GuardrailPhase.Request,
        state: baseState,
        runtime: baseRuntime,
        options: baseOptions,
      });
      expect(result.ok).toBe(true);

      // Test with forbidden content
      const badState: SmartState = {
        messages: [{ role: 'user', content: 'How do I hack into a system?' }],
      } as SmartState;

      result = await evaluateGuardrails({
        guardrails: [guardrail],
        phase: GuardrailPhase.Request,
        state: badState,
        runtime: baseRuntime,
        options: baseOptions,
      });
      expect(result.ok).toBe(false);
      expect(result.incidents[0].reason).toContain('hack');
    });

    it('should enforce message length limits', async () => {
      const maxLength = 100;

      const guardrail: ConversationGuardrail = {
        id: 'length-limit',
        appliesTo: [GuardrailPhase.Request],
        rules: [
          {
            id: 'max-length',
            evaluate: (ctx: GuardrailContext) => {
              const content =
                typeof ctx.latestMessage?.content === 'string' ? ctx.latestMessage.content : '';
              return content.length > maxLength
                ? { passed: false, reason: `Message too long: ${content.length}/${maxLength}` }
                : { passed: true };
            },
          },
        ],
      };

      const longState: SmartState = {
        messages: [{ role: 'user', content: 'a'.repeat(150) }],
      } as SmartState;

      const result = await evaluateGuardrails({
        guardrails: [guardrail],
        phase: GuardrailPhase.Request,
        state: longState,
        runtime: baseRuntime,
        options: baseOptions,
      });

      expect(result.ok).toBe(false);
      expect(result.incidents[0].reason).toContain('150/100');
    });
  });
});
