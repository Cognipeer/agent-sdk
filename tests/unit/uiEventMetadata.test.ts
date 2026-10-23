/**
 * Metadata that lets a UI place agent events precisely: which tool call produced
 * a `plan` snapshot, and which pass a `summarization` event belongs to (start,
 * done or skipped), where it was triggered, whether the summarizer failed and
 * which tool results it replaced.
 */

import { describe, it, expect, vi } from 'vitest';
import { z } from 'zod';
import { createSmartAgent, createTool } from '../../src/index.js';
import { createContextTools } from '../../src/contextTools.js';
import { createContextSummarizeNode, SUMMARIZATION_TRIGGER_KEY } from '../../src/nodes/contextSummarize.js';
import { DEFERRED_TRACE_EVENTS_KEY } from '../../src/utils/tracing.js';
import type { Message, SummarizationEvent } from '../../src/types.js';

const BIG = 'Detailed archived payload '.repeat(160);

function textOf(message: Message): string {
  if (typeof message.content === 'string') return message.content;
  return (message.content as any[]).map((part) => (typeof part === 'string' ? part : part?.text ?? '')).join('');
}

function isSummaryCall(messages: Message[]): boolean {
  return messages[0]?.role === 'system' && textOf(messages[0]).includes('summarizes conversation history efficiently');
}

describe('plan event carries the tool call id', () => {
  const todo = (title: string) => [{ id: 1, title, status: 'in-progress' }, { id: 2, title: 'Next', status: 'not-started' }];

  it('stamps the id the tools node passes with the call', async () => {
    const events: any[] = [];
    const stateRef: any = { todoList: undefined, planVersion: 0, adherenceScore: 0 };
    const manage = createContextTools(stateRef, { planningEnabled: true }).find((tool: any) => tool.name === 'manage_plan') as any;
    stateRef.__onEvent = (event: any) => events.push(event);

    await manage.invoke({ operation: 'write', todoList: todo('First') }, { toolCallId: 'call_plan_1' });

    const plan = events.find((event) => event.type === 'plan');
    expect(plan).toEqual(expect.objectContaining({ source: 'manage_plan', operation: 'write', version: 1, count: 2, toolCallId: 'call_plan_1' }));
  });

  it('keeps concurrent calls apart even though the shared state ref names only the last one', async () => {
    const events: any[] = [];
    const stateRef: any = { todoList: undefined, planVersion: 0, adherenceScore: 0 };
    const manage = createContextTools(stateRef, { planningEnabled: true }).find((tool: any) => tool.name === 'manage_plan') as any;
    stateRef.__onEvent = (event: any) => events.push(event);
    // What the tools node leaves behind when two sibling calls start: the last one wins.
    stateRef.__currentToolCallId = 'call_plan_b';

    await Promise.all([
      manage.invoke({ operation: 'write', todoList: todo('A') }, { toolCallId: 'call_plan_a' }),
      manage.invoke({ operation: 'read' }, { toolCallId: 'call_plan_b' }),
    ]);

    const ids = events.filter((event) => event.type === 'plan').map((event) => event.toolCallId).sort();
    expect(ids).toEqual(['call_plan_a', 'call_plan_b']);
  });

  it('falls back to the state ref only when the tool is called without a context', async () => {
    const events: any[] = [];
    const stateRef: any = { todoList: undefined, planVersion: 0, adherenceScore: 0 };
    const manage = createContextTools(stateRef, { planningEnabled: true }).find((tool: any) => tool.name === 'manage_todo_list') as any;
    stateRef.__onEvent = (event: any) => events.push(event);

    await manage.invoke({ operation: 'write', todoList: todo('A') });
    expect(events.find((event) => event.type === 'plan').toolCallId).toBeUndefined();

    stateRef.__currentToolCallId = 'call_from_ref';
    await manage.invoke({ operation: 'read' });
    expect(events.filter((event) => event.type === 'plan')[1].toolCallId).toBe('call_from_ref');
  });

  it('reaches onEvent from a real agent run', async () => {
    let turn = 0;
    const model: any = {
      modelName: 'scripted-model',
      bindTools() { return model; },
      async invoke() {
        turn += 1;
        if (turn === 1) {
          return {
            role: 'assistant',
            content: '',
            tool_calls: [{
              id: 'call_plan_live',
              type: 'function',
              function: { name: 'manage_plan', arguments: JSON.stringify({ operation: 'write', todoList: [{ id: 1, title: 'Only step', status: 'in-progress' }] }) },
            }],
          };
        }
        return { role: 'assistant', content: 'done' };
      },
    };
    const agent = createSmartAgent({ name: 'PlanAgent', model, tools: [], planning: { mode: 'todo' }, limits: { maxToolCalls: 4 } } as any);
    const events: any[] = [];
    await agent.invoke({ messages: [{ role: 'user', content: 'Plan it.' }] }, { onEvent: (event: any) => { if (event.type === 'plan') events.push(event); } });

    expect(events.length).toBeGreaterThanOrEqual(1);
    expect(events[0].toolCallId).toBe('call_plan_live');
  });
});

describe('summarization pass events', () => {
  function nodeWith(model: any) {
    return createContextSummarizeNode({ model, summarization: { enable: true } } as any);
  }

  const okModel = () => ({
    async invoke() {
      return { role: 'assistant', content: JSON.stringify({ user_directives: [], stable_facts: [], active_goals: [], open_questions: [], discarded_obsolete: [], rawSummary: 's' }) };
    },
  });

  function conversation() {
    return [
      { role: 'user', content: 'Fetch things.' },
      { role: 'assistant', content: '', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'fetch', arguments: '{}' } }] },
      { role: 'tool', tool_call_id: 'c1', name: 'fetch', content: BIG },
      { role: 'assistant', content: '', tool_calls: [{ id: 'c2', type: 'function', function: { name: 'fetch', arguments: '{}' } }] },
      { role: 'tool', tool_call_id: 'c2', name: 'fetch', content: BIG },
    ];
  }

  function stateOf(events: SummarizationEvent[], extra: Record<string, unknown> = {}, messages: any[] = conversation()) {
    return {
      messages,
      toolHistory: [],
      ctx: { __onEvent: (event: any) => { if (event.type === 'summarization') events.push(event); }, [SUMMARIZATION_TRIGGER_KEY]: 'mid_leg' },
      ...extra,
    } as any;
  }

  it('emits a start event and then one done event that share id, pass and trigger', async () => {
    const events: SummarizationEvent[] = [];
    const delta = await nodeWith(okModel())(stateOf(events));

    expect(events.map((event) => event.phase)).toEqual(['start', 'done']);
    const [start, done] = events;
    expect(start.summary).toBe('');
    expect(start.id).toMatch(/^call_summary_\d+_[A-Za-z0-9_-]{6}$/);
    expect(done.id).toBe(start.id);
    expect(start.pass).toBe(1);
    expect(done.pass).toBe(1);
    expect(start.trigger).toBe('mid_leg');
    expect(done.trigger).toBe('mid_leg');
    expect(done.status).toBe('ok');
    expect(done.error).toBeUndefined();
    expect(done.summary).not.toBe('');

    // The transcript marker is the same pass: it carries the event's id.
    const marker = (delta.messages as any[]).at(-1);
    expect(marker.tool_call_id).toBe(done.id);
    // The trigger is input only.
    expect((delta.ctx as any)[SUMMARIZATION_TRIGGER_KEY]).toBeUndefined();
  });

  it('numbers the pass after the summaries already made', async () => {
    const events: SummarizationEvent[] = [];
    await nodeWith(okModel())(stateOf(events, { summaries: ['earlier one', 'earlier two'] }));
    expect(events.map((event) => event.pass)).toEqual([3, 3]);
  });

  it('lists the tool results this pass replaced, and only those', async () => {
    const events: SummarizationEvent[] = [];
    await nodeWith(okModel())(stateOf(events));
    const done = events.find((event) => event.phase === 'done')!;
    // c2 is the newest turn and stays whole.
    expect(done.compactedTools).toEqual([{ toolCallId: 'c1', toolName: 'fetch' }]);
  });

  it('omits trigger when the driver did not say', async () => {
    const events: SummarizationEvent[] = [];
    const state = stateOf(events);
    delete state.ctx[SUMMARIZATION_TRIGGER_KEY];
    await nodeWith(okModel())(state);
    expect(events.every((event) => event.trigger === undefined)).toBe(true);
  });

  it('reports a failed summarizer as ONE terminal event with status fallback', async () => {
    const events: SummarizationEvent[] = [];
    const failing = { async invoke() { throw new Error('summarizer down'); } };
    const delta = await nodeWith(failing)(stateOf(events));

    expect(events.map((event) => event.phase)).toEqual(['start', 'done']);
    const done = events[1];
    expect(done.status).toBe('fallback');
    expect(done.error).toBe('summarizer down');
    expect(done.id).toBe(events[0].id);
    expect(done.compactedTools).toEqual([{ toolCallId: 'c1', toolName: 'fetch' }]);
    // The fallback still compacted: the transcript has its marker.
    expect(((delta.messages as any[]).at(-1)).tool_call_id).toBe(done.id);
  });

  // A tool message with no matching assistant call is dropped, so the pass has
  // a model call to make but nothing to replace.
  const orphaned = () => [
    { role: 'user', content: 'Fetch things.' },
    { role: 'tool', tool_call_id: 'orphan', name: 'fetch', content: BIG },
    { role: 'assistant', content: '', tool_calls: [{ id: 'c2', type: 'function', function: { name: 'fetch', arguments: '{}' } }] },
    { role: 'tool', tool_call_id: 'c2', name: 'fetch', content: BIG },
  ];

  it('emits skipped after start when the pass ends without replacing anything', async () => {
    const events: SummarizationEvent[] = [];
    const delta = await nodeWith(okModel())(stateOf(events, {}, orphaned()));

    expect(delta).toEqual({});
    expect(events.map((event) => event.phase)).toEqual(['start', 'skipped']);
    expect(events[1].id).toBe(events[0].id);
    expect(events[1].pass).toBe(1);
    expect(events[1].trigger).toBe('mid_leg');
    expect(events[1].summary).toBe('');
    expect(events[1].status).toBeUndefined();
  });

  it('carries the fallback status on skipped when the summarizer also failed', async () => {
    const events: SummarizationEvent[] = [];
    const failing = { async invoke() { throw new Error('summarizer down'); } };
    await nodeWith(failing)(stateOf(events, {}, orphaned()));

    expect(events.map((event) => event.phase)).toEqual(['start', 'skipped']);
    expect(events[1].status).toBe('fallback');
    expect(events[1].error).toBe('summarizer down');
  });

  it('emits nothing when no model call will happen', async () => {
    const events: SummarizationEvent[] = [];
    // Only the newest turn: nothing the pass may touch.
    const newestOnly = conversation().slice(3);
    const delta = await nodeWith(okModel())(stateOf(events, {}, newestOnly));
    expect(delta).toEqual({});
    expect(events).toEqual([]);
  });

  it('lets a consumer count passes as events with phase absent or done', async () => {
    const events: SummarizationEvent[] = [];
    await nodeWith(okModel())(stateOf(events));
    const passes = events.filter((event) => event.phase === undefined || event.phase === 'done');
    expect(passes).toHaveLength(1);
    expect(passes[0].summary).not.toBe('');
  });

  describe('a pass that started always ends, once', () => {
    // A tool-history entry that cannot be read: the pass fails while it rewrites the
    // tool messages, after the summarizer was called and outside that call's own try.
    const unreadableHistory = (message = 'tool history unreadable') => [{
      executionId: 'e1',
      toolName: 'fetch',
      tool_call_id: 'c1',
      output: 'x',
      get rawOutput(): string { throw new Error(message); },
      timestamp: new Date().toISOString(),
    }];

    /** Lets the host callback misbehave after it has recorded the event. */
    function throwingOn(state: any, phase: string) {
      const record = state.ctx.__onEvent;
      state.ctx.__onEvent = (event: any) => {
        record(event);
        if (event.phase === phase) throw new Error('host handler bug');
      };
      return state;
    }

    it('announces start only once a model call is about to happen', async () => {
      const events: SummarizationEvent[] = [];
      const delta = await nodeWith(undefined)(stateOf(events));

      // No model to call: the pass falls back locally and has only its terminal event.
      expect(events.map((event) => event.phase)).toEqual(['done']);
      expect(events[0].status).toBe('fallback');
      expect(events[0].error).toBe('Summarization model is unavailable.');
      expect(((delta.messages as any[]).at(-1)).tool_call_id).toBe(events[0].id);
    });

    it('stays silent when there is no model and nothing to replace', async () => {
      const events: SummarizationEvent[] = [];
      const delta = await nodeWith(undefined)(stateOf(events, {}, orphaned()));
      expect(delta).toEqual({});
      expect(events).toEqual([]);
    });

    it('ends a pass that throws after start with one skipped event (status error), then rethrows', async () => {
      const events: SummarizationEvent[] = [];
      await expect(nodeWith(okModel())(stateOf(events, { toolHistory: unreadableHistory() }))).rejects.toThrow('tool history unreadable');

      expect(events.map((event) => event.phase)).toEqual(['start', 'skipped']);
      const [start, skipped] = events;
      expect(skipped.status).toBe('error');
      expect(skipped.error).toBe('tool history unreadable');
      expect(skipped.id).toBe(start.id);
      expect(skipped.pass).toBe(start.pass);
      expect(skipped.trigger).toBe('mid_leg');
      expect(skipped.summary).toBe('');
    });

    it('invents no end for a pass that threw before it started', async () => {
      const events: SummarizationEvent[] = [];
      const unreadable = { role: 'tool', tool_call_id: 'c0', name: 'fetch', get content(): string { throw new Error('message unreadable'); } };
      await expect(nodeWith(okModel())(stateOf(events, {}, [...conversation(), unreadable]))).rejects.toThrow('message unreadable');
      expect(events).toEqual([]);
    });

    it('does not take a consumer that throws on start for a summarizer failure', async () => {
      const events: SummarizationEvent[] = [];
      let modelCalls = 0;
      const model = { async invoke() { modelCalls += 1; return okModel().invoke(); } };
      const delta = await nodeWith(model)(throwingOn(stateOf(events), 'start'));

      // The summarizer was called and answered: that is a success, not a fallback.
      expect(modelCalls).toBe(1);
      expect(events.map((event) => event.phase)).toEqual(['start', 'done']);
      expect(events[1].status).toBe('ok');
      expect(events[1].error).toBeUndefined();
      expect(((delta.messages as any[]).at(-1)).tool_call_id).toBe(events[1].id);
    });

    it('adds no second terminal event when the consumer throws on the first', async () => {
      const events: SummarizationEvent[] = [];
      await expect(nodeWith(okModel())(throwingOn(stateOf(events), 'done'))).rejects.toThrow('host handler bug');
      expect(events.map((event) => event.phase)).toEqual(['start', 'done']);
    });

    it('reports the pass\'s own failure even when the consumer throws on the closing event', async () => {
      const events: SummarizationEvent[] = [];
      const state = throwingOn(stateOf(events, { toolHistory: unreadableHistory() }), 'skipped');
      await expect(nodeWith(okModel())(state)).rejects.toThrow('tool history unreadable');
      expect(events.map((event) => event.phase)).toEqual(['start', 'skipped']);
    });
  });

  describe('error text on events', () => {
    const failingWith = (message: string) => ({ async invoke() { throw new Error(message); } });
    const longMessage = `provider rejected the request: ${'z'.repeat(900)}`;

    it('clips the provider message to 300 characters on the event and keeps it whole in the trace', async () => {
      const events: SummarizationEvent[] = [];
      const node = createContextSummarizeNode({ model: failingWith(longMessage), summarization: { enable: true }, tracing: { enabled: true } } as any);
      const delta = await node(stateOf(events));

      const done = events.find((event) => event.phase === 'done')!;
      expect(done.status).toBe('fallback');
      expect(done.error).toHaveLength(300);
      expect(done.error!.startsWith('provider rejected the request: zzz')).toBe(true);
      expect(done.error!.endsWith('...')).toBe(true);

      const traced = (delta.ctx as any)[DEFERRED_TRACE_EVENTS_KEY];
      expect(traced).toHaveLength(1);
      expect(traced[0].error.message).toBe(longMessage);
    });

    it('clips it on a skipped pass too', async () => {
      const events: SummarizationEvent[] = [];
      await nodeWith(failingWith(longMessage))(stateOf(events, {}, orphaned()));
      const skipped = events.find((event) => event.phase === 'skipped')!;
      expect(skipped.status).toBe('fallback');
      expect(skipped.error).toHaveLength(300);
    });

    it('clips the message of a pass that failed unexpectedly', async () => {
      const events: SummarizationEvent[] = [];
      const history = [{ executionId: 'e1', toolName: 'fetch', tool_call_id: 'c1', output: 'x', get rawOutput(): string { throw new Error(longMessage); }, timestamp: '' }];
      await expect(nodeWith(okModel())(stateOf(events, { toolHistory: history }))).rejects.toThrow(longMessage);
      const skipped = events.find((event) => event.phase === 'skipped')!;
      expect(skipped.status).toBe('error');
      expect(skipped.error).toHaveLength(300);
    });

    it('leaves a message of 300 characters or fewer as it is', async () => {
      for (const message of ['summarizer down', 'q'.repeat(300)]) {
        const events: SummarizationEvent[] = [];
        await nodeWith(failingWith(message))(stateOf(events));
        expect(events.find((event) => event.phase === 'done')!.error).toBe(message);
      }
      const events: SummarizationEvent[] = [];
      await nodeWith(failingWith('q'.repeat(301)))(stateOf(events));
      expect(events.find((event) => event.phase === 'done')!.error).toBe(`${'q'.repeat(297)}...`);
    });
  });

  describe('the pass identity', () => {
    it('gives each pass an id of its own, even within one millisecond', async () => {
      const now = vi.spyOn(Date, 'now').mockReturnValue(1_760_000_000_000);
      try {
        const first: SummarizationEvent[] = [];
        const second: SummarizationEvent[] = [];
        const delta = await nodeWith(okModel())(stateOf(first));
        await nodeWith(okModel())(stateOf(second));

        expect(first[1].id).toBe(first[0].id);
        expect(second[1].id).toBe(second[0].id);
        expect(second[0].id).not.toBe(first[0].id);
        for (const id of [first[0].id, second[0].id]) {
          expect(id).toMatch(/^call_summary_1760000000000_[A-Za-z0-9_-]{6}$/);
          // The id goes back to the provider inside the transcript: keep within the
          // 40 characters the strictest tool-call id limit allows.
          expect(id!.length).toBeLessThanOrEqual(40);
        }
        // The marker message in the transcript carries the pass's id.
        const [call, response] = (delta.messages as any[]).slice(-2);
        expect(call.tool_calls[0].id).toBe(first[1].id);
        expect(response.tool_call_id).toBe(first[1].id);
      } finally {
        now.mockRestore();
      }
    });

    it('repeats the pass number after a skipped pass, and the id still tells the passes apart', async () => {
      const skipped: SummarizationEvent[] = [];
      await nodeWith(okModel())(stateOf(skipped, {}, orphaned()));
      // A skipped pass adds no summary, so the next one starts from the same state.
      const next: SummarizationEvent[] = [];
      await nodeWith(okModel())(stateOf(next));

      expect(skipped.map((event) => event.phase)).toEqual(['start', 'skipped']);
      expect(next.map((event) => event.phase)).toEqual(['start', 'done']);
      expect(skipped[0].pass).toBe(1);
      expect(next[0].pass).toBe(1);
      expect(next[0].id).not.toBe(skipped[0].id);
    });
  });

  describe('through the smart agent', () => {
    it('reports the pre-leg / mid-leg / post-tools trigger and keeps the key out of state', async () => {
      let agentTurn = 0;
      const fetches = ['a', 'b', 'c'];
      const model: any = {
        modelName: 'scripted-model',
        bindTools() { return model; },
        async invoke(messages: Message[]) {
          if (isSummaryCall(messages)) {
            return {
              role: 'assistant',
              content: JSON.stringify({ stable_facts: [], active_goals: [], open_questions: [], discarded_obsolete: [], rawSummary: 's' }),
              usage: { prompt_tokens: 1200, completion_tokens: 80, total_tokens: 1280 },
            };
          }
          const id = fetches[agentTurn];
          agentTurn += 1;
          return id
            ? { role: 'assistant', content: '', tool_calls: [{ id: `call_${id}`, type: 'function', function: { name: 'fetch', arguments: JSON.stringify({ id }) } }] }
            : { role: 'assistant', content: 'done' };
        },
      };
      const fetchTool = createTool({
        name: 'fetch',
        description: 'Fetch a large record.',
        schema: z.object({ id: z.string() }),
        func: async ({ id }) => `${id}: ${BIG}`,
      });
      const agent = createSmartAgent({
        name: 'TriggerAgent',
        model,
        tools: [fetchTool],
        summarization: { enable: true, maxTokens: 350, summaryPromptMaxTokens: 2000 },
        limits: { maxToolCalls: 5 },
      } as any);

      const events: SummarizationEvent[] = [];
      const result = await agent.invoke({ messages: [{ role: 'user', content: 'Fetch a, b and c.' }] }, {
        onEvent: (event: any) => { if (event.type === 'summarization') events.push(event); },
      });

      const starts = events.filter((event) => event.phase === 'start');
      const dones = events.filter((event) => event.phase === 'done');
      expect(dones.length).toBeGreaterThanOrEqual(1);
      expect(starts.length).toBeGreaterThanOrEqual(dones.length);
      for (const done of dones) {
        expect(starts.some((start) => start.id === done.id && start.pass === done.pass && start.trigger === done.trigger)).toBe(true);
        expect(['pre_leg', 'mid_leg', 'post_tools']).toContain(done.trigger);
        expect(done.status).toBe('ok');
      }
      // Passes number consecutively from 1.
      expect(dones.map((event) => event.pass)).toEqual(dones.map((_, index) => index + 1));
      expect(result.state?.summaries?.length).toBe(dones.length);
      expect((result.state?.ctx as any)?.[SUMMARIZATION_TRIGGER_KEY]).toBeUndefined();
    });
  });
});
