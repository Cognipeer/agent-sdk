/**
 * The summarizer call's default output cap, and the pass that comes back unusable.
 *
 *  - The default cap (8192) is ours, not the model's: a model whose output limit is
 *    lower answers 400 `max_tokens_too_large`. The pass retries ONCE, with the limit
 *    the server states or, when it states none, with no cap. A second failure is the
 *    ordinary fallback.
 *  - A billed call whose reply is unusable (cut off, empty) still leaves a trace
 *    event with its tokens; the usage is booked once.
 */

import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { createSmartAgent, createTool, customSink, ModelRequestError } from '../../src/index.js';
import { createContextSummarizeNode, SUMMARIZATION_TRIGGER_KEY } from '../../src/nodes/contextSummarize.js';
import type { Message, SummarizationEvent, TraceSessionFile } from '../../src/types.js';

const BIG = 'Detailed archived payload '.repeat(160);
const USAGE = { prompt_tokens: 900, completion_tokens: 120, total_tokens: 1020 };
const SUMMARY_JSON = JSON.stringify({ user_directives: [], stable_facts: [], active_goals: ['g'], open_questions: [], discarded_obsolete: [], rawSummary: 'real summary' });

const tooLarge = (maxAllowed?: number) => new ModelRequestError({
  code: 'max_tokens_too_large',
  provider: 'openai',
  model: 'small-model',
  message: 'max_tokens is too large',
  ...(maxAllowed !== undefined ? { maxAllowed } : {}),
});

/** A summarizer that runs `script[i]` on call i (an Error is thrown, anything else is returned) and records the options. */
function scripted(script: Array<Error | Record<string, unknown>>) {
  const calls: Array<{ options: any }> = [];
  const model: any = {
    modelName: 'small-model',
    async invoke(_messages: any[], options?: any) {
      const step = script[calls.length];
      calls.push({ options });
      if (step instanceof Error) throw step;
      return { role: 'assistant', usage: USAGE, ...step };
    },
  };
  return { model, calls };
}

function conversation() {
  return [
    { role: 'user', content: 'Fetch things.' },
    { role: 'assistant', content: '', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'fetch', arguments: '{}' } }] },
    { role: 'tool', tool_call_id: 'c1', name: 'fetch', content: BIG },
    { role: 'assistant', content: '', tool_calls: [{ id: 'c2', type: 'function', function: { name: 'fetch', arguments: '{}' } }] },
    { role: 'tool', tool_call_id: 'c2', name: 'fetch', content: BIG },
  ];
}

async function pass(model: any, summarization: Record<string, unknown> = {}) {
  const events: SummarizationEvent[] = [];
  const state: any = {
    messages: conversation(),
    toolHistory: [],
    usage: { perRequest: [], totals: {} },
    ctx: { __onEvent: (event: any) => { if (event.type === 'summarization') events.push(event); }, [SUMMARIZATION_TRIGGER_KEY]: 'mid_leg' },
  };
  const node = createContextSummarizeNode({ model, summarization: { enable: true, ...summarization } } as any);
  const delta: any = await node(state);
  return { delta, events, state };
}

describe('summarizer output cap: max_tokens_too_large', () => {
  it('retries once with the limit the server states, and keeps the real summary', async () => {
    const { model, calls } = scripted([tooLarge(4096), { content: SUMMARY_JSON }]);
    const { delta, events } = await pass(model);

    expect(calls).toHaveLength(2);
    expect(calls[0].options.maxTokens).toBe(8192);
    expect(calls[1].options.maxTokens).toBe(4096);
    expect(calls[1].options.purpose).toBe('summarization');
    expect(events.at(-1)?.phase).toBe('done');
    expect(events.at(-1)?.status).not.toBe('fallback');
    expect(JSON.stringify(delta.summaries)).toContain('Active goals:\\n- g');
  });

  it('retries with no cap when the error states no limit', async () => {
    const { model, calls } = scripted([tooLarge(), { content: SUMMARY_JSON }]);
    const { events } = await pass(model);

    expect(calls).toHaveLength(2);
    expect('maxTokens' in calls[1].options).toBe(false);
    expect(calls[1].options.reasoning).toEqual({ effort: 'none' });
    expect(events.at(-1)?.phase).toBe('done');
  });

  it('a caller-set cap is lowered to the stated limit, never raised', async () => {
    const lowered = scripted([tooLarge(2000), { content: SUMMARY_JSON }]);
    await pass(lowered.model, { outputMaxTokens: 3000 });
    expect(lowered.calls.map((c) => c.options.maxTokens)).toEqual([3000, 2000]);

    const raised = scripted([tooLarge(9000)]);
    const { events } = await pass(raised.model, { outputMaxTokens: 3000 });
    expect(raised.calls).toHaveLength(1);
    expect(events.at(-1)?.status).toBe('fallback');
  });

  it('a second failure ends in the existing fallback, with no third call', async () => {
    const { model, calls } = scripted([tooLarge(4096), tooLarge(1024)]);
    const { events } = await pass(model);

    expect(calls).toHaveLength(2);
    expect(events.at(-1)?.status).toBe('fallback');
  });

  it('does not retry a call that sent no cap, or another kind of failure', async () => {
    const noCap = scripted([tooLarge()]);
    await pass(noCap.model, { outputMaxTokens: 0 });
    expect(noCap.calls).toHaveLength(1);

    const other = scripted([new Error('boom')]);
    await pass(other.model);
    expect(other.calls).toHaveLength(1);
  });
});

describe('an unusable summarizer reply still leaves a trace event', () => {
  it('traces the billed call with its tokens and finish reason, and books the usage once', async () => {
    const sessions: TraceSessionFile[] = [];
    let agentTurn = 0;
    let summaryCalls = 0;
    const model: any = {
      modelName: 'cut-off',
      bindTools() { return model; },
      async invoke(messages: Message[]) {
        const first = messages[0];
        const head = typeof first?.content === 'string' ? first.content : '';
        if (first?.role === 'system' && head.includes('summarizes conversation history efficiently')) {
          summaryCalls += 1;
          return { role: 'assistant', content: '{"user_directives": [', usage: USAGE, response_metadata: { finish_reason: 'length' } };
        }
        const id = ['a', 'b', 'c'][agentTurn++];
        return id
          ? { role: 'assistant', content: '', tool_calls: [{ id: `call_${id}`, type: 'function', function: { name: 'fetch', arguments: JSON.stringify({ id }) } }] }
          : { role: 'assistant', content: 'done' };
      },
    };
    const fetch = createTool({ name: 'fetch', description: 'Fetch.', schema: z.object({ id: z.string() }), func: async ({ id }) => `${id}: ${BIG}` });
    const agent = createSmartAgent({
      name: 'CutOffSummarizer',
      model,
      tools: [fetch],
      summarization: { enable: true, maxTokens: 350, summaryPromptMaxTokens: 2000 },
      limits: { maxToolCalls: 5 },
      tracing: { enabled: true, sink: customSink({ onSession: (session) => { sessions.push(JSON.parse(JSON.stringify(session))); } }) },
    } as any);
    const result: any = await agent.invoke({ messages: [{ role: 'user', content: 'Fetch a, b and c.' }] });

    const traced = sessions.flatMap((s) => s.events).filter((e: any) => e.type === 'summarization') as any[];
    expect(summaryCalls).toBeGreaterThanOrEqual(1);
    expect(traced).toHaveLength(summaryCalls);
    for (const event of traced) {
      expect(event.status).toBe('error');
      expect(event.inputTokens).toBe(900);
      expect(event.outputTokens).toBe(120);
      expect(event.rawFinishReason).toBe('length');
      expect(event.error?.message).toMatch(/output limit/);
    }
    // One booking per billed call (only the summarizer reports usage here).
    const perRequest = (result.metadata?.usage?.perRequest ?? result.state?.usage?.perRequest ?? []) as any[];
    expect(perRequest.filter((r) => r.usage?.prompt_tokens === 900)).toHaveLength(summaryCalls);
  });
});
