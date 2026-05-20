/**
 * Integration Tests for the ask_user_question Human-in-the-Loop tool.
 */

import { describe, it, expect, vi } from 'vitest';
import { createAgent } from '../../src/agent.js';
import { createSmartAgent } from '../../src/smart/index.js';
import type { SmartState, SmartAgentEvent } from '../../src/types.js';

type ScriptedResponse = {
  content?: string;
  tool_calls?: Array<{
    id: string;
    type: 'function';
    function: { name: string; arguments: string };
  }>;
};

function scriptedModel(responses: ScriptedResponse[]) {
  let idx = 0;
  const calls: any[] = [];
  return {
    bindTools(_tools: any) {
      return this;
    },
    async invoke(messages: any[]) {
      calls.push([...messages]);
      const response = responses[Math.min(idx, responses.length - 1)];
      idx += 1;
      return {
        role: 'assistant',
        content: response.content ?? '',
        ...(response.tool_calls ? { tool_calls: response.tool_calls } : {}),
      };
    },
    getCalls: () => calls,
    getCallIndex: () => idx,
  };
}

const askQuestionToolCall = (id: string, args: any) => ({
  id,
  type: 'function' as const,
  function: { name: 'ask_user_question', arguments: JSON.stringify(args) },
});

describe('ask_user_question integration', () => {
  it('pauses the agent with pendingUserQuestions when the model calls the tool', async () => {
    const model = scriptedModel([
      {
        tool_calls: [
          askQuestionToolCall('call_q1', {
            questions: [
              {
                question: 'Which framework do you want to use?',
                options: [{ label: 'React' }, { label: 'Vue' }, { label: 'Svelte' }],
              },
            ],
          }),
        ],
      },
    ]);
    const events: SmartAgentEvent[] = [];
    const agent = createAgent({
      name: 'Picker',
      model: model as any,
      humanInTheLoop: { askUser: true },
    });

    const result = await agent.invoke(
      { messages: [{ role: 'user', content: 'Help me scaffold an app.' }] } as SmartState,
      { onEvent: (event) => events.push(event) },
    );

    expect(result.state?.ctx?.__awaitingUserQuestion).toBeDefined();
    expect(result.state?.pendingUserQuestions?.length).toBe(1);
    const pending = result.state!.pendingUserQuestions![0];
    expect(pending.status).toBe('pending');
    expect(pending.toolCallId).toBe('call_q1');
    expect(pending.allowFreeText).toBe(true);

    const userQuestionEvents = events.filter((e) => e.type === 'user_question');
    expect(userQuestionEvents).toHaveLength(1);
    expect((userQuestionEvents[0] as any).status).toBe('pending');
    expect((userQuestionEvents[0] as any).allowFreeText).toBe(true);
  });

  it('resumes after the host resolves the question and the model produces the final answer', async () => {
    const model = scriptedModel([
      {
        tool_calls: [
          askQuestionToolCall('call_q1', {
            questions: [
              {
                question: 'Pick a deployment target',
                options: [{ label: 'Vercel' }, { label: 'Fly.io' }],
              },
            ],
          }),
        ],
      },
      {
        content: 'Great — deploying to Vercel now.',
      },
    ]);
    const agent = createAgent({
      name: 'Deploy',
      model: model as any,
      humanInTheLoop: { askUser: true },
    });

    const first = await agent.invoke({
      messages: [{ role: 'user', content: 'Where should I deploy?' }],
    } as SmartState);

    const pending = first.state!.pendingUserQuestions![0];
    const resolved = agent.resolveUserQuestion(first.state!, {
      id: pending.id,
      answers: { 'Pick a deployment target': { values: ['Vercel'] } },
      answeredBy: 'qa@example.com',
    });

    // The resolver appends the tool answer as the last message.
    const lastBeforeResume = resolved.messages[resolved.messages.length - 1] as any;
    expect(lastBeforeResume.role).toBe('tool');
    expect(lastBeforeResume.tool_call_id).toBe('call_q1');

    const second = await agent.invoke(resolved);
    expect(second.content).toBe('Great — deploying to Vercel now.');
    expect(second.state?.pendingUserQuestions?.[0].status).toBe('answered');
    expect(second.state?.pendingUserQuestions?.[0].answeredBy).toBe('qa@example.com');
  });

  it('forwards user_question events through the askUser.onQuestion convenience hook', async () => {
    const model = scriptedModel([
      {
        tool_calls: [
          askQuestionToolCall('call_q1', {
            questions: [
              {
                question: 'Pick an option',
                options: [{ label: 'A' }, { label: 'B' }],
              },
            ],
          }),
        ],
      },
    ]);
    const onQuestion = vi.fn();
    const agent = createAgent({
      model: model as any,
      humanInTheLoop: { askUser: { onQuestion } },
    });

    await agent.invoke({
      messages: [{ role: 'user', content: 'ask me' }],
    } as SmartState);

    expect(onQuestion).toHaveBeenCalledTimes(1);
    const event = onQuestion.mock.calls[0][0];
    expect(event.type).toBe('user_question');
    expect(event.status).toBe('pending');
  });

  it('does not expose the ask_user_question tool when humanInTheLoop is omitted', async () => {
    const model = scriptedModel([
      { content: 'I cannot ask the user — no such tool available.' },
    ]);
    const agent = createAgent({ model: model as any });
    const toolNames = (agent.__runtime.tools || []).map((t: any) => t.name);
    expect(toolNames).not.toContain('ask_user_question');
  });

  it('supports a cancellation resolution', async () => {
    const model = scriptedModel([
      {
        tool_calls: [
          askQuestionToolCall('call_q1', {
            questions: [
              {
                question: 'Confirm?',
                options: [{ label: 'Yes' }, { label: 'No' }],
              },
            ],
          }),
        ],
      },
      { content: 'Aborted because the user dismissed the question.' },
    ]);
    const agent = createAgent({
      model: model as any,
      humanInTheLoop: { askUser: true },
    });

    const first = await agent.invoke({
      messages: [{ role: 'user', content: 'Do the thing.' }],
    } as SmartState);

    const pending = first.state!.pendingUserQuestions![0];
    const resolved = agent.resolveUserQuestion(first.state!, {
      id: pending.id,
      cancelled: true,
      notes: 'User closed the prompt.',
    });

    const second = await agent.invoke(resolved);
    expect(second.state?.pendingUserQuestions?.[0].status).toBe('cancelled');
    const lastMessage = second.messages.find((m: any) => m.role === 'tool' && m.tool_call_id === 'call_q1') as any;
    expect(lastMessage).toBeDefined();
    const payload = JSON.parse(lastMessage.content);
    expect(payload.status).toBe('cancelled');
  });

  it('works through SmartAgent as well', async () => {
    const model = scriptedModel([
      {
        tool_calls: [
          askQuestionToolCall('call_q1', {
            questions: [
              {
                question: 'Choose a flavor',
                options: [{ label: 'Vanilla' }, { label: 'Chocolate' }],
              },
            ],
          }),
        ],
      },
      { content: 'Vanilla it is.' },
    ]);
    const agent = createSmartAgent({
      model: model as any,
      humanInTheLoop: { askUser: true },
    });

    const first = await agent.invoke({
      messages: [{ role: 'user', content: 'Surprise me with ice cream' }],
    } as SmartState);

    const pending = first.state!.pendingUserQuestions![0];
    expect(pending.status).toBe('pending');
    const resolved = agent.resolveUserQuestion(first.state!, {
      id: pending.id,
      answers: { 'Choose a flavor': { values: ['Vanilla'] } },
    });
    const second = await agent.invoke(resolved);
    expect(second.content).toBe('Vanilla it is.');
  });
});
