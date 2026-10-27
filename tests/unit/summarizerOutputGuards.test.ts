/**
 * The summarizer call: what it asks of the model, and what it does with the answer.
 *
 *  - The call carries an output cap (`summarization.outputMaxTokens`, default 8192;
 *    `0` sends none), a reasoning effort (`summarization.reasoningEffort`, default
 *    `none`) and `purpose: 'summarization'`. A LangChain model gets only its run
 *    options: it forwards unknown options into the provider request.
 *  - A reply that was cut off at an output limit, is empty, or is JSON with none of
 *    the summary fields is no summary. The pass ends `skipped` with status
 *    `fallback`, the previous summary stays the latest and no tool message is
 *    replaced (replacing them under a summary nobody read loses what the run needs).
 *    The summarizer's tokens are booked either way.
 */

import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { createSmartAgent, createTool } from '../../src/index.js';
import { fromNativeProvider } from '../../src/providers/adapter.js';
import { createContextSummarizeNode, SUMMARIZATION_TRIGGER_KEY } from '../../src/nodes/contextSummarize.js';
import type { Message, SummarizationEvent } from '../../src/types.js';

const BIG = 'Detailed archived payload '.repeat(160);
const USAGE = { prompt_tokens: 900, completion_tokens: 120, total_tokens: 1020 };
const SUMMARY_JSON = JSON.stringify({ user_directives: [], stable_facts: [], active_goals: ['g'], open_questions: [], discarded_obsolete: [], rawSummary: 's' });
/** What a summary cut off by the output limit looks like. */
const TRUNCATED_JSON = '{"user_directives": [], "stable_facts": [{"key": "owner", "value": "Ada Lo';
const COMPACTED = /^(SUMMARIZED|SUMMARIZED_TOOL_RESPONSE|ARCHIVED_TOOL_RESPONSE|STRUCTURED_TOOL_RESPONSE|DROPPED_TOOL_RESPONSE)/;

function textOf(message: Message): string {
  if (typeof message.content === 'string') return message.content;
  return (message.content as any[]).map((part) => (typeof part === 'string' ? part : part?.text ?? '')).join('');
}

function isSummaryCall(messages: Message[]): boolean {
  return messages[0]?.role === 'system' && textOf(messages[0]).includes('summarizes conversation history efficiently');
}

/** A model that answers every call with `reply` (merged over an assistant message with usage) and records the call. */
function modelReplying(reply: Record<string, unknown>) {
  const calls: Array<{ messages: any[]; options: any }> = [];
  const model: any = {
    modelName: 'summarizer-model',
    async invoke(messages: any[], options?: any) {
      calls.push({ messages, options });
      return { role: 'assistant', usage: USAGE, ...reply };
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

/** One pass of the node over `conversation()`: its delta, the events it emitted and the state it was given. */
async function pass(
  model: any,
  opts: { summarization?: Record<string, unknown>; state?: Record<string, unknown> } = {},
) {
  const events: SummarizationEvent[] = [];
  const state: any = {
    messages: conversation(),
    toolHistory: [],
    usage: { perRequest: [], totals: {} },
    ctx: { __onEvent: (event: any) => { if (event.type === 'summarization') events.push(event); }, [SUMMARIZATION_TRIGGER_KEY]: 'mid_leg' },
    ...(opts.state || {}),
  };
  const node = createContextSummarizeNode({ model, summarization: { enable: true, ...(opts.summarization || {}) } } as any);
  const delta = await node(state);
  return { delta, events, state };
}

const phases = (events: SummarizationEvent[]) => events.map((event) => event.phase);
const toolMessages = (state: any) => (state.messages as any[]).filter((message) => message.role === 'tool');

/** The pass compacted nothing: no delta, the skipped event says why, the tokens were booked. */
function expectSkippedAsFallback(result: Awaited<ReturnType<typeof pass>>, error: string | RegExp) {
  const { delta, events, state } = result;
  expect(delta).toEqual({});
  expect(phases(events)).toEqual(['start', 'skipped']);
  const [start, skipped] = events;
  expect(skipped.id).toBe(start.id);
  expect(skipped.pass).toBe(start.pass);
  expect(skipped.status).toBe('fallback');
  if (typeof error === 'string') expect(skipped.error).toBe(error);
  else expect(skipped.error).toMatch(error);
  expect(skipped.summary).toBe('');
  expect(skipped.compactedTools).toBeUndefined();
  // Nothing was replaced.
  expect(toolMessages(state)).toHaveLength(2);
  expect(toolMessages(state).every((message) => message.content === BIG)).toBe(true);
}

describe('a reply cut off at an output limit is no summary', () => {
  const LIMIT_REPLIES: Array<[string, Record<string, unknown>, string]> = [
    ['response_metadata.finish_reason length', { response_metadata: { finish_reason: 'length' } }, 'length'],
    ['response_metadata.finishReason length', { response_metadata: { finishReason: 'length' } }, 'length'],
    ['finishReason length on the message', { finishReason: 'length' }, 'length'],
    ['Anthropic stop_reason max_tokens', { response_metadata: { stop_reason: 'max_tokens' } }, 'max_tokens'],
    ['Gemini MAX_TOKENS, in any case', { response_metadata: { finish_reason: 'MAX_TOKENS' } }, 'MAX_TOKENS'],
    ['Responses API max_output_tokens', { response_metadata: { finish_reason: 'max_output_tokens' } }, 'max_output_tokens'],
    ['model_context_window_exceeded', { response_metadata: { stop_reason: 'model_context_window_exceeded' } }, 'model_context_window_exceeded'],
  ];

  it.each(LIMIT_REPLIES)('%s: the pass is skipped as a fallback and replaces nothing', async (_label, reply, stop) => {
    const { model, calls } = modelReplying({ content: TRUNCATED_JSON, ...reply });
    const result = await pass(model);

    expect(calls).toHaveLength(1);
    expectSkippedAsFallback(result, `Summarizer reply ended at its output limit (${stop}).`);
  });

  it('does not trust a reply that reads as a whole summary but ended at the limit', async () => {
    const { model } = modelReplying({ content: SUMMARY_JSON, response_metadata: { finish_reason: 'length' } });
    expectSkippedAsFallback(await pass(model), /output limit \(length\)/);
  });

  it('books the tokens the cut-off call cost', async () => {
    const { model } = modelReplying({ content: TRUNCATED_JSON, response_metadata: { finish_reason: 'length' } });
    const { state } = await pass(model);

    expect(state.usage.perRequest).toHaveLength(1);
    expect(state.usage.perRequest[0]).toMatchObject({ modelName: 'summarizer-model', usage: { prompt_tokens: 900, completion_tokens: 120, total_tokens: 1020 } });
    expect(state.usage.totals['summarizer-model']).toMatchObject({ input: 900, output: 120, total: 1020 });
  });

  it('keeps the previous summary: the pass adds none, and the summarizer was shown it', async () => {
    const { model, calls } = modelReplying({ content: TRUNCATED_JSON, response_metadata: { finish_reason: 'length' } });
    const result = await pass(model, { state: { summaries: ['earlier summary'] } });

    expectSkippedAsFallback(result, /output limit/);
    // The pass number is "summaries so far + 1": the skipped pass made none.
    expect(result.events[0].pass).toBe(2);
    // No `summaries` / `summaryRecords` / `messages` key in the delta to merge over the state.
    expect(result.delta).not.toHaveProperty('summaries');
    expect(result.delta).not.toHaveProperty('summaryRecords');
    expect(result.delta).not.toHaveProperty('messages');
    expect(result.state.summaries).toEqual(['earlier summary']);
    expect(textOf(calls[0].messages[1])).toContain('earlier summary');
  });

  it('is not mistaken for a stop that finished normally', async () => {
    for (const reply of [
      { response_metadata: { finish_reason: 'stop' } },
      { response_metadata: { stop_reason: 'end_turn' } },
      { finishReason: 'stop' },
      {},
    ]) {
      const { delta, events } = await pass(modelReplying({ content: SUMMARY_JSON, ...reply }).model);
      expect(phases(events)).toEqual(['start', 'done']);
      expect(events[1].status).toBe('ok');
      expect(delta.messages).toBeDefined();
    }
  });

  it('reads a native provider that ended at its limit through fromNativeProvider', async () => {
    const provider: any = {
      providerName: 'openai-compatible',
      defaultModel: 'fake-summarizer',
      async complete() {
        return {
          id: 'r1',
          model: 'fake-summarizer',
          content: TRUNCATED_JSON,
          toolCalls: [],
          usage: { inputTokens: 900, outputTokens: 120, totalTokens: 1020, cachedInputTokens: 0, cachedWriteTokens: 0, cachedOutputTokens: 0, reasoningTokens: 0 },
          finishReason: 'length',
        };
      },
    };
    const result = await pass(fromNativeProvider(provider, { model: 'fake-summarizer' }));

    expectSkippedAsFallback(result, /output limit \(length\)/);
    expect(result.state.usage.perRequest).toHaveLength(1);
    expect(result.state.usage.perRequest[0].modelName).toBe('fake-summarizer');
  });
});

describe('an empty reply, or JSON with no summary in it, is no summary', () => {
  it.each([
    ['an empty string', { content: '' }],
    ['whitespace', { content: ' \n\t ' }],
    ['null content', { content: null }],
    ['no content', { content: undefined }],
    ['an empty list of parts', { content: [] }],
    ['blank text parts', { content: [{ type: 'text', text: ' ' }, { type: 'text', text: '\n' }] }],
  ])('%s: skipped as a fallback, nothing replaced, tokens booked', async (_label, reply) => {
    const { model } = modelReplying(reply);
    const result = await pass(model);

    expectSkippedAsFallback(result, 'Summarizer returned no text.');
    expect(result.state.usage.perRequest).toHaveLength(1);
  });

  it('a model that answers with nothing at all is an empty reply too', async () => {
    const model = { modelName: 'silent', async invoke() { return undefined; } };
    const result = await pass(model);
    expectSkippedAsFallback(result, 'Summarizer returned no text.');
  });

  it.each([
    ['an empty object', '{}'],
    ['an error object', '{"error":{"message":"rate limited"}}'],
    ['an object of other fields', '{"status":"ok","note":"nothing to report"}'],
    ['a fenced object with no summary field', '```json\n{"status":"ok"}\n```'],
  ])('%s: skipped as a fallback with the default prompt', async (_label, content) => {
    const { model } = modelReplying({ content });
    expectSkippedAsFallback(await pass(model), 'Summarizer reply has no summary fields.');
  });

  it('a JSON reply is a summary as soon as it has any one of the fields', async () => {
    for (const field of ['user_directives', 'stable_facts', 'active_goals', 'open_questions', 'discarded_obsolete', 'obsolete_discarded', 'rawSummary']) {
      const value = field === 'rawSummary' ? 'text' : [];
      const { delta, events } = await pass(modelReplying({ content: JSON.stringify({ [field]: value }) }).model);
      expect(phases(events), field).toEqual(['start', 'done']);
      expect(delta.messages, field).toBeDefined();
    }
  });

  it('a custom prompt template may ask for another shape: its reply is not held to the summary fields', async () => {
    for (const content of ['{}', '{"status":"ok"}']) {
      const { delta, events } = await pass(modelReplying({ content }).model, { summarization: { promptTemplate: 'Summarize in your own format: {{conversation}}' } });
      expect(phases(events)).toEqual(['start', 'done']);
      expect(events[1].status).toBe('ok');
      // The pass went on to compact.
      expect(events[1].compactedTools).toEqual([{ toolCallId: 'c1', toolName: 'fetch' }]);
      expect(delta.messages).toBeDefined();
    }
  });

  it('an empty reply is no summary under a custom template either', async () => {
    const { model } = modelReplying({ content: '  ' });
    const result = await pass(model, { summarization: { promptTemplate: 'Summarize: {{conversation}}' } });
    expectSkippedAsFallback(result, 'Summarizer returned no text.');
  });
});

describe('replies that still make a summary', () => {
  it('a plain-text reply is a free-text summary and the pass compacts', async () => {
    const { model } = modelReplying({ content: 'PROJECT_FACT|code=ORBIT|owner=Ada Lovelace|risk=low|milestone=design' });
    const { delta, events } = await pass(model);

    expect(phases(events)).toEqual(['start', 'done']);
    expect(events[1].status).toBe('ok');
    expect((delta.summaries as string[]).at(-1)).toContain('PROJECT_FACT|code=ORBIT|owner=Ada Lovelace');
    expect(events[1].compactedTools).toEqual([{ toolCallId: 'c1', toolName: 'fetch' }]);
  });

  it('a reply that is not valid JSON goes the ordinary fallback: compaction still runs, status fallback', async () => {
    const { model } = modelReplying({ content: '{this is not valid json}' });
    const { delta, events } = await pass(model);

    expect(phases(events)).toEqual(['start', 'done']);
    expect(events[1].status).toBe('fallback');
    expect(events[1].compactedTools).toEqual([{ toolCallId: 'c1', toolName: 'fetch' }]);
    expect(delta.messages).toBeDefined();
  });

  it('a summarizer that throws still falls back with compaction (unchanged)', async () => {
    const failing = { modelName: 'down', async invoke() { throw new Error('summarizer down'); } };
    const { delta, events } = await pass(failing);

    expect(phases(events)).toEqual(['start', 'done']);
    expect(events[1].status).toBe('fallback');
    expect(events[1].error).toBe('summarizer down');
    expect(delta.messages).toBeDefined();
  });
});

describe('the options of the summarizer call', () => {
  const DEFAULTS = { maxTokens: 8192, reasoning: { effort: 'none' }, purpose: 'summarization' };

  it('asks for the default cap and no reasoning, and says what the call is for', async () => {
    const { model, calls } = modelReplying({ content: SUMMARY_JSON });
    await pass(model);

    expect(calls).toHaveLength(1);
    expect(calls[0].options).toEqual(DEFAULTS);
  });

  it('takes the cap and the effort from summarization.outputMaxTokens and reasoningEffort', async () => {
    const { model, calls } = modelReplying({ content: SUMMARY_JSON });
    await pass(model, { summarization: { outputMaxTokens: 2000, reasoningEffort: 'low' } });

    expect(calls[0].options).toEqual({ maxTokens: 2000, reasoning: { effort: 'low' }, purpose: 'summarization' });
  });

  it('floors a fractional cap', async () => {
    const { model, calls } = modelReplying({ content: SUMMARY_JSON });
    await pass(model, { summarization: { outputMaxTokens: 1500.9 } });
    expect(calls[0].options.maxTokens).toBe(1500);
  });

  it.each([0, -5, Number.NaN, Number.POSITIVE_INFINITY])('sends no cap for outputMaxTokens %s, and still the rest', async (outputMaxTokens) => {
    const { model, calls } = modelReplying({ content: SUMMARY_JSON });
    await pass(model, { summarization: { outputMaxTokens } });

    expect(calls[0].options).not.toHaveProperty('maxTokens');
    expect(calls[0].options).toEqual({ reasoning: { effort: 'none' }, purpose: 'summarization' });
  });

  it('an unset effort is the default none, sent as a value: none is a setting, not an omission', async () => {
    const { model, calls } = modelReplying({ content: SUMMARY_JSON });
    await pass(model, { summarization: { reasoningEffort: undefined } });
    expect(calls[0].options.reasoning).toEqual({ effort: 'none' });
  });

  it('gives a LangChain model its run options and nothing else', async () => {
    const { model, calls } = modelReplying({ content: SUMMARY_JSON });
    await pass({ ...model, _lc: {} }, { summarization: { outputMaxTokens: 2000, reasoningEffort: 'high' } });

    expect(calls[0].options).toEqual({ runName: 'summarize_context', tags: ['cognipeer:summarization'], metadata: { cognipeer_event: 'summarization' } });
  });

  it('reaches a native provider as request fields; an adapter default it does not replace survives', async () => {
    const requests: any[] = [];
    const provider: any = {
      providerName: 'openai-compatible',
      defaultModel: 'fake-summarizer',
      async complete(request: any) {
        requests.push(request);
        return {
          id: 'r1',
          model: 'fake-summarizer',
          content: SUMMARY_JSON,
          toolCalls: [],
          usage: { inputTokens: 5, outputTokens: 5, totalTokens: 10, cachedInputTokens: 0, cachedWriteTokens: 0, cachedOutputTokens: 0, reasoningTokens: 0 },
          finishReason: 'stop',
        };
      },
    };
    const model = fromNativeProvider(provider, {
      model: 'fake-summarizer',
      maxTokens: 1000,
      reasoning: { providerExtras: { chat_template_kwargs: { enable_thinking: true } } },
    });
    const { events } = await pass(model);

    expect(phases(events)).toEqual(['start', 'done']);
    expect(requests).toHaveLength(1);
    // The call's own cap beats the adapter's default one; its effort is merged over the endpoint's passthrough.
    expect(requests[0].maxTokens).toBe(8192);
    expect(requests[0].purpose).toBe('summarization');
    expect(requests[0].reasoning).toEqual({ effort: 'none', providerExtras: { chat_template_kwargs: { enable_thinking: true } } });
  });

  it('a native provider with no cap of its own still gets the summarizer one', async () => {
    const requests: any[] = [];
    const provider: any = {
      providerName: 'openai-compatible',
      defaultModel: 'fake-summarizer',
      async complete(request: any) {
        requests.push(request);
        return { id: 'r1', model: 'fake-summarizer', content: SUMMARY_JSON, toolCalls: [], usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2, cachedInputTokens: 0, cachedWriteTokens: 0, cachedOutputTokens: 0, reasoningTokens: 0 }, finishReason: 'stop' };
      },
    };
    await pass(fromNativeProvider(provider), { summarization: { outputMaxTokens: 3000, reasoningEffort: 'medium' } });

    expect(requests[0]).toMatchObject({ maxTokens: 3000, purpose: 'summarization', reasoning: { effort: 'medium' } });
  });
});

describe('through the smart agent', () => {
  type Reply = (callNumber: number) => Record<string, unknown>;

  /** Agent turns: one fetch each for a, b and c, then a final answer. Summarizer calls answer with `reply`. */
  function scriptedModel(reply: Reply) {
    let agentTurn = 0;
    const fetches = ['a', 'b', 'c'];
    const summaryOptions: any[] = [];
    const model: any = {
      modelName: 'scripted-model',
      bindTools() { return model; },
      async invoke(messages: Message[], options?: any) {
        if (isSummaryCall(messages)) {
          summaryOptions.push(options);
          return { role: 'assistant', usage: USAGE, ...reply(summaryOptions.length) };
        }
        const id = fetches[agentTurn];
        agentTurn += 1;
        return id
          ? { role: 'assistant', content: '', tool_calls: [{ id: `call_${id}`, type: 'function', function: { name: 'fetch', arguments: JSON.stringify({ id }) } }] }
          : { role: 'assistant', content: 'done' };
      },
    };
    return { model, summaryOptions };
  }

  const fetchTool = () => createTool({
    name: 'fetch',
    description: 'Fetch a large record.',
    schema: z.object({ id: z.string() }),
    func: async ({ id }) => `${id}: ${BIG}`,
  });

  async function run(reply: Reply, summarization: Record<string, unknown> = {}) {
    const { model, summaryOptions } = scriptedModel(reply);
    const events: SummarizationEvent[] = [];
    const agent = createSmartAgent({
      name: 'SummarizerGuardAgent',
      model,
      tools: [fetchTool()],
      summarization: { enable: true, maxTokens: 350, summaryPromptMaxTokens: 2000, ...summarization },
      limits: { maxToolCalls: 5 },
    } as any);
    const result = await agent.invoke({ messages: [{ role: 'user', content: 'Fetch a, b and c.' }] }, {
      onEvent: (event: any) => { if (event.type === 'summarization') events.push(event); },
    });
    return { result, events, summaryOptions };
  }

  it('sends the summarizer the default cap, effort and purpose on every pass', async () => {
    const { result, summaryOptions } = await run(() => ({ content: SUMMARY_JSON }));

    expect(summaryOptions.length).toBeGreaterThanOrEqual(1);
    for (const options of summaryOptions) expect(options).toEqual({ maxTokens: 8192, reasoning: { effort: 'none' }, purpose: 'summarization' });
    expect(result.state?.summaries?.length).toBeGreaterThanOrEqual(1);
  });

  it('sends the configured cap and effort', async () => {
    const { summaryOptions } = await run(() => ({ content: SUMMARY_JSON }), { outputMaxTokens: 1500, reasoningEffort: 'minimal' });

    expect(summaryOptions.length).toBeGreaterThanOrEqual(1);
    for (const options of summaryOptions) expect(options).toEqual({ maxTokens: 1500, reasoning: { effort: 'minimal' }, purpose: 'summarization' });
  });

  it('control: a summarizer that finishes normally compacts the transcript', async () => {
    const { result, events } = await run(() => ({ content: SUMMARY_JSON, response_metadata: { finish_reason: 'stop' } }));

    expect(events.filter((event) => event.phase === 'done').length).toBeGreaterThanOrEqual(1);
    expect(events.every((event) => event.phase !== 'skipped' || event.status === undefined)).toBe(true);
    expect(toolMessages(result.state).some((message) => typeof message.content === 'string' && COMPACTED.test(message.content))).toBe(true);
  });

  it('a summarizer that always ends at its limit compacts nothing, and the agent still answers', async () => {
    const { result, events, summaryOptions } = await run(() => ({ content: TRUNCATED_JSON, response_metadata: { finish_reason: 'length' } }));

    // Every pass was announced and every one ended skipped, as a fallback, with the reason.
    expect(summaryOptions.length).toBeGreaterThanOrEqual(1);
    expect(events.filter((event) => event.phase === 'done')).toHaveLength(0);
    const skipped = events.filter((event) => event.phase === 'skipped');
    expect(skipped).toHaveLength(summaryOptions.length);
    expect(events.filter((event) => event.phase === 'start')).toHaveLength(summaryOptions.length);
    for (const event of skipped) {
      expect(event.status).toBe('fallback');
      expect(event.error).toBe('Summarizer reply ended at its output limit (length).');
    }

    // No summary was made and no tool result was replaced.
    expect(result.state?.summaries ?? []).toHaveLength(0);
    const tools = toolMessages(result.state);
    expect(tools).toHaveLength(3);
    for (const message of tools) {
      expect(typeof message.content).toBe('string');
      expect(message.content).toContain('Detailed archived payload');
      expect(message.content).not.toMatch(COMPACTED);
    }
    expect(result.content).toBe('done');

    // The cut-off calls cost real tokens, and the run's ledger says so.
    const ledger = (result.metadata.usage?.perRequest || []).filter((entry: any) => entry.usage?.completion_tokens === USAGE.completion_tokens);
    expect(ledger).toHaveLength(summaryOptions.length);
  });

  it('a summarizer that answers with JSON that is not a summary does the same', async () => {
    const { result, events } = await run(() => ({ content: '{"error":"overloaded"}' }));

    expect(events.filter((event) => event.phase === 'done')).toHaveLength(0);
    expect(events.filter((event) => event.phase === 'skipped').length).toBeGreaterThanOrEqual(1);
    expect(toolMessages(result.state).every((message) => !COMPACTED.test(String(message.content)))).toBe(true);
    expect(result.content).toBe('done');
  });

  it('recovers: a pass that ends at the limit is followed by a good one when a later call finishes', async () => {
    // The first summarizer call is cut off, every later one is fine.
    const { result, events } = await run((call) => (call === 1
      ? { content: TRUNCATED_JSON, response_metadata: { finish_reason: 'length' } }
      : { content: SUMMARY_JSON }));

    const skipped = events.filter((event) => event.phase === 'skipped');
    const done = events.filter((event) => event.phase === 'done');
    expect(skipped.length).toBeGreaterThanOrEqual(1);
    expect(skipped[0].status).toBe('fallback');
    expect(done.length).toBeGreaterThanOrEqual(1);
    expect(done[0].status).toBe('ok');
    expect(result.state?.summaries?.length).toBe(done.length);
    expect(result.content).toBe('done');
  });
});
