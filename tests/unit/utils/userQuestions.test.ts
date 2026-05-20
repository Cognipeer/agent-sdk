/**
 * Unit Tests for utils/userQuestions.ts
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { resolveUserQuestionState } from '../../../src/utils/userQuestions.js';
import type { SmartState, UserQuestionResolution } from '../../../src/types.js';

function makeState(allowFreeText = true): SmartState {
  return {
    messages: [
      { role: 'user', content: 'Help me plan a trip.' },
      {
        role: 'assistant',
        content: '',
        tool_calls: [
          {
            id: 'call_q1',
            type: 'function',
            function: {
              name: 'ask_user_question',
              arguments: JSON.stringify({
                questions: [
                  {
                    question: 'Which destination?',
                    options: [{ label: 'Paris' }, { label: 'Tokyo' }],
                  },
                  {
                    question: 'Pick travel dates',
                    multiSelect: true,
                    options: [
                      { label: 'Q1' },
                      { label: 'Q2' },
                      { label: 'Q3' },
                    ],
                  },
                ],
              }),
            },
          },
        ],
      },
    ],
    pendingUserQuestions: [
      {
        id: 'uq_1',
        toolCallId: 'call_q1',
        toolName: 'ask_user_question',
        status: 'pending',
        requestedAt: new Date().toISOString(),
        allowFreeText,
        questions: [
          {
            question: 'Which destination?',
            options: [{ label: 'Paris' }, { label: 'Tokyo' }],
          },
          {
            question: 'Pick travel dates',
            multiSelect: true,
            options: [{ label: 'Q1' }, { label: 'Q2' }, { label: 'Q3' }],
          },
        ],
      },
    ],
    ctx: { __awaitingUserQuestion: { id: 'uq_1', toolCallId: 'call_q1' } },
  } as SmartState;
}

describe('resolveUserQuestionState', () => {
  let baseState: SmartState;

  beforeEach(() => {
    baseState = makeState();
  });

  it('records an answered status, clears awaiting flag, and appends a tool message', () => {
    const resolution: UserQuestionResolution = {
      id: 'uq_1',
      answeredBy: 'user@example.com',
      answers: {
        'Which destination?': { values: ['Paris'] },
        'Pick travel dates': { values: ['Q1', 'Q2'] },
      },
    };

    const next = resolveUserQuestionState(baseState, resolution);
    const entry = next.pendingUserQuestions?.[0];
    expect(entry?.status).toBe('answered');
    expect(entry?.answeredBy).toBe('user@example.com');
    expect(entry?.answeredAt).toBeDefined();
    expect(next.ctx?.__awaitingUserQuestion).toBeUndefined();
    expect(next.ctx?.__userQuestionResolved).toEqual({ id: 'uq_1', status: 'answered' });

    const lastMessage = next.messages[next.messages.length - 1] as any;
    expect(lastMessage.role).toBe('tool');
    expect(lastMessage.tool_call_id).toBe('call_q1');
    expect(lastMessage.name).toBe('ask_user_question');
    const payload = JSON.parse(lastMessage.content);
    expect(payload.status).toBe('answered');
    expect(payload.answers[0]).toMatchObject({
      question: 'Which destination?',
      values: ['Paris'],
    });
    expect(payload.answers[1]).toMatchObject({
      question: 'Pick travel dates',
      values: ['Q1', 'Q2'],
    });
  });

  it('preserves free-text answers when allowFreeText is true', () => {
    const next = resolveUserQuestionState(baseState, {
      id: 'uq_1',
      answers: {
        'Which destination?': { values: [], freeText: 'Reykjavik' },
        'Pick travel dates': { values: ['Q3'] },
      },
    });
    const payload = JSON.parse(
      (next.messages[next.messages.length - 1] as any).content,
    );
    expect(payload.answers[0].freeText).toBe('Reykjavik');
    expect(payload.answers[0].values).toEqual([]);
  });

  it('rejects free-text answers when allowFreeText is false', () => {
    const stateNoFree = makeState(false);
    expect(() =>
      resolveUserQuestionState(stateNoFree, {
        id: 'uq_1',
        answers: {
          'Which destination?': { values: [], freeText: 'Reykjavik' },
          'Pick travel dates': { values: ['Q1'] },
        },
      }),
    ).toThrow(/Free-text answers are disabled/);
  });

  it('rejects multiple values on single-select question', () => {
    expect(() =>
      resolveUserQuestionState(baseState, {
        id: 'uq_1',
        answers: {
          'Which destination?': { values: ['Paris', 'Tokyo'] },
          'Pick travel dates': { values: ['Q1'] },
        },
      }),
    ).toThrow(/single-select/);
  });

  it('rejects unknown option values when free-text disabled', () => {
    const stateNoFree = makeState(false);
    expect(() =>
      resolveUserQuestionState(stateNoFree, {
        id: 'uq_1',
        answers: {
          'Which destination?': { values: ['Berlin'] },
          'Pick travel dates': { values: ['Q1'] },
        },
      }),
    ).toThrow(/not one of the allowed options/);
  });

  it('requires answers for required questions', () => {
    expect(() =>
      resolveUserQuestionState(baseState, {
        id: 'uq_1',
        answers: {
          'Which destination?': { values: ['Paris'] },
        },
      }),
    ).toThrow(/Missing answer for required question/);
  });

  it('honors cancellation', () => {
    const next = resolveUserQuestionState(baseState, {
      id: 'uq_1',
      cancelled: true,
      notes: 'User dismissed',
    });
    expect(next.pendingUserQuestions?.[0].status).toBe('cancelled');
    expect(next.pendingUserQuestions?.[0].cancelled).toBe(true);
    const payload = JSON.parse(
      (next.messages[next.messages.length - 1] as any).content,
    );
    expect(payload.status).toBe('cancelled');
    expect(payload.message).toBe('User dismissed');
  });

  it('throws when the question id does not exist', () => {
    expect(() =>
      resolveUserQuestionState(baseState, {
        id: 'nope',
        answers: {},
      }),
    ).toThrow(/Pending user question not found/);
  });

  it('throws when the question was already resolved', () => {
    const next = resolveUserQuestionState(baseState, {
      id: 'uq_1',
      answers: {
        'Which destination?': { values: ['Tokyo'] },
        'Pick travel dates': { values: ['Q3'] },
      },
    });
    expect(() =>
      resolveUserQuestionState(next, {
        id: 'uq_1',
        answers: {
          'Which destination?': { values: ['Paris'] },
          'Pick travel dates': { values: ['Q3'] },
        },
      }),
    ).toThrow(/already resolved/);
  });

  it('does not mutate original state', () => {
    resolveUserQuestionState(baseState, {
      id: 'uq_1',
      answers: {
        'Which destination?': { values: ['Paris'] },
        'Pick travel dates': { values: ['Q3'] },
      },
    });
    expect(baseState.pendingUserQuestions?.[0].status).toBe('pending');
    expect(baseState.ctx?.__awaitingUserQuestion).toBeDefined();
  });

  it('resolves by toolCallId as fallback', () => {
    const next = resolveUserQuestionState(baseState, {
      id: 'call_q1',
      answers: {
        'Which destination?': { values: ['Paris'] },
        'Pick travel dates': { values: ['Q3'] },
      },
    });
    expect(next.pendingUserQuestions?.[0].status).toBe('answered');
  });
});
