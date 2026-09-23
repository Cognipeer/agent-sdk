/**
 * `context.policy: "summary_only"` regressions.
 *
 * The old view was `body.filter(user|assistant).slice(-2)`, which:
 *  1. dropped the first user message — the instruction anchor — from the third
 *     turn on, so standing instructions silently stopped applying;
 *  2. dropped every tool message, so inside a run the model never saw the
 *     output of the tool it had just called, and a kept assistant turn with
 *     `tool_calls` but no results was an invalid provider request;
 *  3. dropped turns nobody had summarized yet (before the first summary, and
 *     the turns after the latest one).
 *
 * The summary also had nowhere to keep a standing instruction given later in
 * the conversation: `user_directives` is that place.
 */
import { describe, it, expect } from 'vitest';
import { normalizeSmartAgentOptions } from '../../src/index.js';
import { buildModelMessages, renderStructuredSummary } from '../../src/smart/contextPolicy.js';
import { createContextSummarizeNode } from '../../src/nodes/contextSummarize.js';
import type { Message, SmartState, StructuredSummary } from '../../src/types.js';

const textOf = (m: Message) => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content));

function resolvedSummaryOnly(lastTurnsToKeep = 2) {
  return normalizeSmartAgentOptions({
    name: 'SummaryOnly',
    model: {} as never,
    context: { policy: 'summary_only', lastTurnsToKeep },
    limits: { maxContextTokens: 100_000 },
  } as never);
}

const SUMMARY: StructuredSummary = {
  user_directives: ['Always answer in Turkish.'],
  stable_facts: [{ key: 'customer', value: 'ACME', confidence: 0.9 }],
  active_goals: ['triage INC-42'],
  open_questions: [],
  discarded_obsolete: [],
};

function summaryPair(id: string): Message[] {
  return [
    {
      role: 'assistant',
      content: 'Context limit reached. Summarizing conversation history to reduce token usage.',
      tool_calls: [{ id, type: 'function', function: { name: 'summarize_context', arguments: '{}' } }],
    } as Message,
    { role: 'tool', name: 'summarize_context', tool_call_id: id, content: 'Context summary: …' } as Message,
  ];
}

function assertValidToolAdjacency(view: Message[]) {
  const pending = new Set<string>();
  for (const message of view) {
    if (message.role === 'assistant' && Array.isArray((message as any).tool_calls)) {
      for (const tc of (message as any).tool_calls) pending.add(tc.id);
    }
    if (message.role === 'tool') {
      expect(pending.has((message as any).tool_call_id)).toBe(true);
      pending.delete((message as any).tool_call_id);
    }
  }
  // Every call that is in the view has its result in the view.
  expect([...pending]).toEqual([]);
}

describe('summary_only context view', () => {
  it('keeps the first user message (the instruction anchor) once a summary exists', () => {
    const messages: Message[] = [
      { role: 'system', content: 'system prompt' },
      { role: 'user', content: 'ANCHOR: answer only in Turkish from now on' },
      { role: 'assistant', content: 'Tamam.' },
      { role: 'user', content: 'turn 2' },
      { role: 'assistant', content: 'answer 2' },
      ...summaryPair('call_summary_1'),
      { role: 'user', content: 'turn 3' },
    ];
    const view = buildModelMessages({ messages, summaryRecords: [SUMMARY] } as unknown as SmartState, resolvedSummaryOnly());
    const flat = view.map(textOf).join('\n');

    expect(flat).toContain('ANCHOR: answer only in Turkish');
    expect(flat).toContain('turn 3');
    // Covered by the summary, so not repeated verbatim.
    expect(flat).not.toContain('answer 2');
    // The synthetic exchange duplicates the context_summary block.
    expect(view.some((m) => (m as any).name === 'summarize_context')).toBe(false);
    expect(view.some((m) => (m as any).name === 'context_summary')).toBe(true);
  });

  it('shows the current turn’s tool calls AND their results to the model', () => {
    const messages: Message[] = [
      { role: 'system', content: 'system prompt' },
      { role: 'user', content: 'ANCHOR task' },
      { role: 'assistant', content: 'done 1' },
      ...summaryPair('call_summary_1'),
      { role: 'user', content: 'check the logs' },
      {
        role: 'assistant',
        content: '',
        tool_calls: [{ id: 'call_logs', type: 'function', function: { name: 'search_logs', arguments: '{"q":"502"}' } }],
      } as Message,
      { role: 'tool', name: 'search_logs', tool_call_id: 'call_logs', content: 'LOG_RESULT: pool exhausted' } as Message,
    ];
    const view = buildModelMessages({ messages, summaryRecords: [SUMMARY] } as unknown as SmartState, resolvedSummaryOnly());

    expect(view.map(textOf).join('\n')).toContain('LOG_RESULT: pool exhausted');
    assertValidToolAdjacency(view);
  });

  it('keeps the current request even when summarization happened mid-run', () => {
    const messages: Message[] = [
      { role: 'system', content: 'system prompt' },
      { role: 'user', content: 'ANCHOR task' },
      { role: 'assistant', content: 'done 1' },
      { role: 'user', content: 'CURRENT request' },
      {
        role: 'assistant',
        content: '',
        tool_calls: [{ id: 'call_a', type: 'function', function: { name: 'fetch', arguments: '{}' } }],
      } as Message,
      { role: 'tool', name: 'fetch', tool_call_id: 'call_a', content: 'ARCHIVED_TOOL_RESPONSE …' } as Message,
      ...summaryPair('call_summary_1'),
      {
        role: 'assistant',
        content: '',
        tool_calls: [{ id: 'call_b', type: 'function', function: { name: 'fetch', arguments: '{"page":2}' } }],
      } as Message,
      { role: 'tool', name: 'fetch', tool_call_id: 'call_b', content: 'PAGE_2' } as Message,
    ];
    const view = buildModelMessages({ messages, summaryRecords: [SUMMARY] } as unknown as SmartState, resolvedSummaryOnly());
    const flat = view.map(textOf).join('\n');

    expect(flat).toContain('ANCHOR task');
    expect(flat).toContain('CURRENT request');
    expect(flat).toContain('PAGE_2');
    // Pre-summary tool exchange is represented by the summary; dropped as a pair.
    expect(flat).not.toContain('ARCHIVED_TOOL_RESPONSE');
    assertValidToolAdjacency(view);
  });

  it('keeps turns after the latest summary verbatim', () => {
    const messages: Message[] = [
      { role: 'user', content: 'ANCHOR task' },
      { role: 'assistant', content: 'old answer' },
      ...summaryPair('call_summary_1'),
      { role: 'user', content: 'turn after summary' },
      { role: 'assistant', content: 'NOT YET SUMMARIZED answer' },
      { role: 'user', content: 'latest' },
    ];
    const view = buildModelMessages({ messages, summaryRecords: [SUMMARY] } as unknown as SmartState, resolvedSummaryOnly());
    const flat = view.map(textOf).join('\n');

    expect(flat).toContain('NOT YET SUMMARIZED answer');
    expect(flat).toContain('latest');
    expect(flat).not.toContain('old answer');
  });

  it('uses the turn window before any summary exists instead of dropping unsummarized turns', () => {
    const messages: Message[] = [
      { role: 'system', content: 'system prompt' },
      { role: 'user', content: 'ANCHOR task' },
      { role: 'assistant', content: 'a1' },
      { role: 'user', content: 'u2' },
      { role: 'assistant', content: 'a2' },
      { role: 'user', content: 'u3' },
    ];
    const view = buildModelMessages({ messages } as unknown as SmartState, resolvedSummaryOnly(2));
    const flat = view.map(textOf).join('\n');

    expect(flat).toContain('ANCHOR task');
    expect(flat).toContain('a2');
    expect(flat).toContain('u3');
  });

  it('renders user directives first in the context summary', () => {
    const rendered = renderStructuredSummary(SUMMARY);
    expect(rendered).toMatch(/User directives[^\n]*\n- Always answer in Turkish\./);
    expect(rendered.indexOf('User directives')).toBeLessThan(rendered.indexOf('Stable facts'));
  });
});

describe('summary user_directives', () => {
  function stateWithCompressibleTool(previous?: StructuredSummary): any {
    return {
      messages: [
        { role: 'user', content: 'Always answer in Turkish. Investigate INC-42.' },
        {
          role: 'assistant',
          content: '',
          tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'fetch', arguments: '{}' } }],
        },
        { role: 'tool', name: 'fetch', tool_call_id: 'call_1', content: 'x'.repeat(400) },
        {
          role: 'assistant',
          content: '',
          tool_calls: [{ id: 'call_2', type: 'function', function: { name: 'fetch', arguments: '{}' } }],
        },
        { role: 'tool', name: 'fetch', tool_call_id: 'call_2', content: 'latest' },
      ],
      summaries: previous ? ['prev'] : [],
      summaryRecords: previous ? [previous] : [],
      ctx: {},
    };
  }

  function summarizerReturning(payload: Record<string, unknown>) {
    return createContextSummarizeNode({
      summarization: { enable: true, integrityCheck: true },
      model: { async invoke() { return { role: 'assistant', content: JSON.stringify(payload) }; } },
    } as any);
  }

  it('keeps the directives the summarizer returns', async () => {
    const node = summarizerReturning({
      user_directives: ['Always answer in Turkish.'],
      stable_facts: [{ key: 'incident', value: 'INC-42', confidence: 0.9 }],
      active_goals: [], open_questions: [], discarded_obsolete: [],
    });
    const delta = await node(stateWithCompressibleTool());
    expect(delta.summaryRecords?.at(-1)?.user_directives).toEqual(['Always answer in Turkish.']);
    expect(delta.summaries?.at(-1)).toContain('Always answer in Turkish.');
  });

  it('merges a directive forward when a later summary drops it', async () => {
    const node = summarizerReturning({
      user_directives: [],
      stable_facts: [{ key: 'incident', value: 'INC-42', confidence: 0.9 }],
      active_goals: [], open_questions: [], discarded_obsolete: [],
    });
    const delta = await node(stateWithCompressibleTool({ ...SUMMARY, stable_facts: [{ key: 'incident', value: 'INC-42', confidence: 0.9 }] }));
    const record = delta.summaryRecords?.at(-1);
    expect(record?.user_directives).toEqual(['Always answer in Turkish.']);
    expect(record?.integrity?.notes.join(' ')).toMatch(/user directive/);
  });

  it('lets the user revoke a directive through discarded_obsolete', async () => {
    const node = summarizerReturning({
      user_directives: [],
      stable_facts: [{ key: 'incident', value: 'INC-42', confidence: 0.9 }],
      active_goals: [], open_questions: [],
      discarded_obsolete: ['Always answer in Turkish.'],
    });
    const delta = await node(stateWithCompressibleTool({ ...SUMMARY, stable_facts: [{ key: 'incident', value: 'INC-42', confidence: 0.9 }] }));
    expect(delta.summaryRecords?.at(-1)?.user_directives).toEqual([]);
  });

  it('carries directives forward when the summarizer call fails', async () => {
    const node = createContextSummarizeNode({
      summarization: { enable: true },
      model: { async invoke() { throw new Error('provider down'); } },
    } as any);
    const delta = await node(stateWithCompressibleTool(SUMMARY));
    expect(delta.summaryRecords?.at(-1)?.user_directives).toEqual(['Always answer in Turkish.']);
  });
});
