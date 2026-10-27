/**
 * A reply cut off by the output limit (finish reason `length`) may end inside a
 * tool call. Such a call must never run: the run ends as a limit outcome, the
 * call is dropped from the transcript and its text is kept.
 *
 * Also: a per-call `maxTokens` / `max_tokens` / `maxOutputTokens` beats the
 * adapter default, for both invoke and stream.
 */

import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { createAgent, createTool } from '../../src/index.js';
import { fromNativeProvider } from '../../src/providers/adapter.js';
import type { Message } from '../../src/types.js';

const usage = {
  inputTokens: 5,
  outputTokens: 5,
  totalTokens: 10,
  cachedInputTokens: 0,
  cachedWriteTokens: 0,
  cachedOutputTokens: 0,
  reasoningTokens: 0,
};

type Scripted = { content?: string; toolCalls?: Array<{ id: string; name: string; arguments: string }>; finishReason: string };

/** A scripted native provider that records every request it receives. */
function fakeProvider(script: Scripted[]) {
  const requests: any[] = [];
  let turn = 0;
  const next = () => script[Math.min(turn++, script.length - 1)];
  const provider: any = {
    providerName: 'openai-compatible',
    defaultModel: 'fake',
    async complete(req: any) {
      requests.push(req);
      const s = next();
      return {
        id: `r${turn}`,
        model: 'fake',
        content: s.content ?? '',
        toolCalls: s.toolCalls ?? [],
        usage,
        finishReason: s.finishReason,
      };
    },
    async *completeStream(req: any) {
      requests.push(req);
      const s = next();
      if (s.content) yield { id: `r${turn}`, model: 'fake', delta: { content: s.content } };
      for (const tc of s.toolCalls ?? []) {
        yield { id: `r${turn}`, model: 'fake', delta: { toolCalls: [{ id: tc.id, name: tc.name, arguments: tc.arguments }] } };
      }
      yield { id: `r${turn}`, model: 'fake', delta: {}, usage, finishReason: s.finishReason };
    },
  };
  return { provider, requests };
}

function counterTool() {
  const calls: any[] = [];
  const tool = createTool({
    name: 'write_file',
    description: 'writes a file',
    schema: z.object({ path: z.string(), body: z.string() }),
    func: async (args: any) => { calls.push(args); return 'ok'; },
  });
  return { tool, calls };
}

const user = (content: string): Message => ({ role: 'user', content }) as any;

describe('truncated tool calls', () => {
  it('ends the run as a maxOutputTokens limit and runs no tool when a length reply has tool calls', async () => {
    const { provider } = fakeProvider([{
      content: 'Writing the file now. ',
      // Cut off mid-JSON: the adapter's lenient parser would turn this into {}.
      toolCalls: [{ id: 'c1', name: 'write_file', arguments: '{"path":"a.txt","bo' }],
      finishReason: 'length',
    }]);
    const { tool, calls } = counterTool();
    const events: any[] = [];
    const agent = createAgent({ model: fromNativeProvider(provider), tools: [tool] });

    const res: any = await agent.invoke({ messages: [user('go')] } as any, { onEvent: (e: any) => events.push(e) });

    expect(calls).toHaveLength(0);
    expect(res.state.ctx.__limitBreached).toContain('maxOutputTokens');
    const breach = events.find((e) => e.type === 'metadata' && e.limitBreached);
    expect(breach?.limitBreached).toContain('maxOutputTokens');
    // No tool call was announced as started.
    expect(events.some((e) => e.type === 'tool_call' && e.phase === 'start')).toBe(false);

    const msgs: any[] = res.state.messages;
    const last = msgs[msgs.length - 1];
    expect(last.role).toBe('assistant');
    expect(last.tool_calls).toBeUndefined();
    expect(last.content).toBe('Writing the file now. ');
    // The history holds no assistant tool_calls turn without results.
    expect(msgs.some((m) => m.role === 'tool')).toBe(false);
    expect(res.content).toBe('Writing the file now. ');
  });

  it('does the same on the streaming path', async () => {
    const { provider } = fakeProvider([{
      content: 'Working. ',
      toolCalls: [{ id: 'c1', name: 'write_file', arguments: '{"path":"a.txt"' }],
      finishReason: 'length',
    }]);
    const { tool, calls } = counterTool();
    const agent = createAgent({ model: fromNativeProvider(provider), tools: [tool] });

    const res: any = await agent.invoke({ messages: [user('go')] } as any, { stream: true });

    expect(calls).toHaveLength(0);
    expect(res.state.ctx.__limitBreached).toContain('maxOutputTokens');
    const last = res.state.messages[res.state.messages.length - 1];
    expect(last.tool_calls).toBeUndefined();
    expect(last.content).toBe('Working. ');
  });

  it('gives a call-only cut-off reply a stand-in text, so the next request has no empty assistant turn', async () => {
    const { provider } = fakeProvider([{
      toolCalls: [{ id: 'c1', name: 'write_file', arguments: '{"pa' }],
      finishReason: 'length',
    }]);
    const { tool, calls } = counterTool();
    const agent = createAgent({ model: fromNativeProvider(provider), tools: [tool] });

    const res: any = await agent.invoke({ messages: [user('go')] } as any);

    expect(calls).toHaveLength(0);
    const last = res.state.messages[res.state.messages.length - 1];
    expect(last.role).toBe('assistant');
    expect(last.tool_calls).toBeUndefined();
    expect(last.content).toMatch(/output token limit/);
  });

  it('the stream path of the adapter reports the finish reason where agentCore reads it', async () => {
    const { provider } = fakeProvider([{ content: 'x', finishReason: 'length' }]);
    const model: any = fromNativeProvider(provider);
    let final: any;
    for await (const chunk of model.stream([user('hi')])) {
      if (chunk && typeof chunk === 'object' && (chunk as any).role === 'assistant') final = chunk;
    }
    expect(final.response_metadata.finish_reason).toBe('length');
  });

  it('still runs tools on a normal tool_calls reply', async () => {
    const { provider } = fakeProvider([
      {
        toolCalls: [{ id: 'c1', name: 'write_file', arguments: '{"path":"a.txt","body":"hi"}' }],
        finishReason: 'tool_calls',
      },
      { content: 'done', finishReason: 'stop' },
    ]);
    const { tool, calls } = counterTool();
    const agent = createAgent({ model: fromNativeProvider(provider), tools: [tool] });

    const res: any = await agent.invoke({ messages: [user('go')] } as any);

    expect(calls).toEqual([{ path: 'a.txt', body: 'hi' }]);
    expect(res.state.ctx?.__limitBreached).toBeUndefined();
    expect(res.content).toBe('done');
  });

  it('returns the text of a length reply that has no tool calls, as before', async () => {
    const { provider } = fakeProvider([{ content: 'a long answer that was cut', finishReason: 'length' }]);
    const { tool, calls } = counterTool();
    const agent = createAgent({ model: fromNativeProvider(provider), tools: [tool] });

    const res: any = await agent.invoke({ messages: [user('go')] } as any);

    expect(calls).toHaveLength(0);
    expect(res.content).toBe('a long answer that was cut');
    expect(res.state.ctx?.__limitBreached).toBeUndefined();
  });

  it('does not carry the limit into the next run on the same state', async () => {
    const { provider } = fakeProvider([
      { content: 'cut', toolCalls: [{ id: 'c1', name: 'write_file', arguments: '{' }], finishReason: 'length' },
      { content: 'second answer', finishReason: 'stop' },
    ]);
    const { tool } = counterTool();
    const agent = createAgent({ model: fromNativeProvider(provider), tools: [tool] });

    const first: any = await agent.invoke({ messages: [user('go')] } as any);
    expect(first.state.ctx.__limitBreached).toContain('maxOutputTokens');

    const second: any = await agent.invoke({
      ...first.state,
      messages: [...first.state.messages, user('continue')],
    } as any);
    expect(second.state.ctx?.__limitBreached).toBeUndefined();
    expect(second.content).toBe('second answer');
  });
});

describe('per-call maxTokens', () => {
  const cases: Array<[string, Record<string, any>]> = [
    ['maxTokens', { maxTokens: 321 }],
    ['max_tokens', { max_tokens: 321 }],
    ['maxOutputTokens', { maxOutputTokens: 321 }],
  ];

  for (const [name, invokeOptions] of cases) {
    it(`${name} wins over the adapter default on invoke and stream`, async () => {
      const { provider, requests } = fakeProvider([{ content: 'ok', finishReason: 'stop' }]);
      const model: any = fromNativeProvider(provider, { maxTokens: 4096 });

      await model.invoke([user('hi')], invokeOptions);
      for await (const _ of model.stream([user('hi')], invokeOptions)) { /* drain */ }

      expect(requests).toHaveLength(2);
      expect(requests[0].maxTokens).toBe(321);
      expect(requests[1].maxTokens).toBe(321);
    });
  }

  it('keeps the adapter default when the per-call value is absent or not a positive finite number', async () => {
    const { provider, requests } = fakeProvider([{ content: 'ok', finishReason: 'stop' }]);
    const model: any = fromNativeProvider(provider, { maxTokens: 4096 });

    await model.invoke([user('hi')]);
    await model.invoke([user('hi')], { max_tokens: 0 });
    await model.invoke([user('hi')], { max_tokens: -5 });
    await model.invoke([user('hi')], { max_tokens: Number.NaN });
    await model.invoke([user('hi')], { max_tokens: Infinity });
    await model.invoke([user('hi')], { max_tokens: '100' });

    expect(requests.map((r) => r.maxTokens)).toEqual([4096, 4096, 4096, 4096, 4096, 4096]);
  });

  it('sends the per-call value when the adapter has no default', async () => {
    const { provider, requests } = fakeProvider([{ content: 'ok', finishReason: 'stop' }]);
    const model: any = fromNativeProvider(provider);

    await model.invoke([user('hi')], { max_tokens: 77 });
    await model.invoke([user('hi')]);

    expect(requests[0].maxTokens).toBe(77);
    expect(requests[1].maxTokens).toBeUndefined();
  });
});
