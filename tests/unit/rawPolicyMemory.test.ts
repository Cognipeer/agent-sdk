/**
 * `context.policy: "raw"` keeps the conversation untouched, and the recalled
 * memory still reaches the model: it used to be dropped on this policy only.
 */
import { describe, it, expect } from 'vitest';
import { normalizeSmartAgentOptions } from '../../src/index.js';
import { buildModelMessages } from '../../src/smart/contextPolicy.js';
import type { Message, SmartState } from '../../src/types.js';

function resolvedRaw() {
  return normalizeSmartAgentOptions({
    name: 'Raw',
    model: {} as never,
    context: { policy: 'raw' },
    limits: { maxContextTokens: 100_000 },
  } as never);
}

const FACT = { key: 'language', value: 'Answers in Turkish', sourceTurn: 1, confidence: 0.9 };

describe('raw context policy and recalled memory', () => {
  it('puts the memory block right after the system prompt and keeps every message', () => {
    const messages: Message[] = [
      { role: 'system', content: 'You are helpful.' },
      { role: 'user', content: 'Hi' },
      { role: 'assistant', content: 'Hello' },
      { role: 'user', content: 'What language do I want?' },
    ];
    const view = buildModelMessages({ messages, memoryFacts: [FACT] } as unknown as SmartState, resolvedRaw());

    expect(view).toHaveLength(5);
    expect(view[0]).toBe(messages[0]);
    expect(view[1]).toMatchObject({ role: 'system', name: 'memory_context' });
    expect(String(view[1].content)).toContain('Answers in Turkish');
    expect(view.slice(2)).toEqual(messages.slice(1));
  });

  it('leads with the memory block when there is no system prompt', () => {
    const messages: Message[] = [{ role: 'user', content: 'Hi' }];
    const view = buildModelMessages({ messages, memoryFacts: [FACT] } as unknown as SmartState, resolvedRaw());

    expect(view[0]).toMatchObject({ role: 'system', name: 'memory_context' });
    expect(view[1]).toBe(messages[0]);
  });

  it('sends the conversation alone when nothing was recalled', () => {
    const messages: Message[] = [
      { role: 'system', content: 'You are helpful.' },
      { role: 'user', content: 'Hi' },
    ];
    const view = buildModelMessages({ messages, memoryFacts: [] } as unknown as SmartState, resolvedRaw());

    expect(view).toEqual(messages);
  });
});
