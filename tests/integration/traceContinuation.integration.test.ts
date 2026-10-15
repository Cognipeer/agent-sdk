/**
 * One turn, one trace session — however many invokes the turn takes.
 *
 * A run that pauses for a tool approval, a question to the user or a host-run
 * (client) tool is finished by a second invoke. Before trace continuation each
 * invoke opened its own session, so the model call that asked for the tool sat
 * in one session and the tool it asked for in another, with nothing linking
 * them. These tests pin the contract sinks rely on: same ids, sequence numbers
 * that carry on, cumulative totals, and a `continuation` marker telling the
 * sink to append.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { createAgent } from '../../src/agent.js';
import { createSmartAgent } from '../../src/smart/index.js';
import { createTool } from '../../src/tool.js';
import { customSink, fileSink } from '../../src/utils/tracing.js';
import { recordHumanDecisions } from '../../src/utils/traceDecisions.js';
import { captureSnapshot, restoreSnapshot } from '../../src/utils/stateSnapshot.js';
import type { SmartState, TraceSessionFile, TraceSessionRuntime } from '../../src/types.js';

type Scripted = {
  content?: string;
  tool_calls?: Array<{ id: string; type: 'function'; function: { name: string; arguments: string } }>;
};

function scriptedModel(responses: Scripted[]) {
  let index = 0;
  return {
    modelName: 'scripted-model',
    bindTools() {
      return this;
    },
    async invoke() {
      const response = responses[Math.min(index, responses.length - 1)];
      index += 1;
      return {
        role: 'assistant',
        content: response.content ?? '',
        ...(response.tool_calls ? { tool_calls: response.tool_calls } : {}),
        usage: { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110 },
      };
    },
  };
}

const call = (id: string, name: string, args: unknown) => ({
  id,
  type: 'function' as const,
  function: { name, arguments: JSON.stringify(args) },
});

function searchTool(needsApproval = true) {
  return createTool({
    name: 'web_search',
    description: 'Search the web',
    schema: z.object({ query: z.string() }),
    needsApproval,
    func: async ({ query }) => ({ results: [{ title: `About ${query}`, url: 'https://example.com' }] }),
  });
}

function collectingSink() {
  const sessions: TraceSessionFile[] = [];
  return { sessions, sink: customSink({ onSession: (session) => { sessions.push(session); } }) };
}

const types = (session: TraceSessionFile) => session.events.map((event) => `${event.type}:${event.status}`);

describe('trace continuation across a tool approval', () => {
  async function runApproval(approved: boolean) {
    const { sessions, sink } = collectingSink();
    const agent = createAgent({
      name: 'Researcher',
      model: scriptedModel([
        { tool_calls: [call('c1', 'web_search', { query: 'cognipeer' })] },
        { content: approved ? 'Cognipeer builds agentic AI.' : 'I could not search.' },
      ]) as any,
      tools: [searchTool()],
      tracing: { enabled: true, logData: true, sink },
    });

    const first = await agent.invoke({ messages: [{ role: 'user', content: 'Research cognipeer' }] } as SmartState);
    const pending = first.state!.pendingApprovals![0];
    const resolved = agent.resolveToolApproval(first.state!, {
      id: pending.id,
      approved,
      decidedBy: 'anil',
      comment: approved ? undefined : 'not now',
    });
    const second = await agent.invoke(resolved);
    return { sessions, first, second };
  }

  it('records both invokes into one session', async () => {
    const { sessions, first, second } = await runApproval(true);
    expect(sessions).toHaveLength(2);
    const [part1, part2] = sessions;

    expect(part2.sessionId).toBe(part1.sessionId);
    expect(part2.traceId).toBe(part1.traceId);
    expect(part2.rootSpanId).toBe(part1.rootSpanId);
    expect(part2.startedAt).toBe(part1.startedAt);

    expect(part1.status).toBe('paused');
    expect(part1.continuation).toBeUndefined();
    expect(part2.status).toBe('success');
    expect(part2.continuation).toEqual({ part: 2, firstSequence: part1.events.length + 1 });

    // Sequence numbers carry on across the pause.
    expect(part1.events.map((event) => event.sequence)).toEqual(part1.events.map((_, i) => i + 1));
    expect(part2.events[0].sequence).toBe(part1.events.length + 1);

    // The paused state carries the continuation; the finished one does not.
    expect(first.state!.ctx!.__traceContinuation).toMatchObject({ v: 1, sessionId: part1.sessionId, part: 1 });
    expect(second.state!.ctx!.__traceContinuation).toBeUndefined();
  });

  it('reads as: model call, approval requested | approval, tool, answer', async () => {
    const { sessions } = await runApproval(true);
    const [part1, part2] = sessions;
    expect(types(part1)).toEqual(['agent_iteration:success', 'ai_call:success', 'tool_approval:pending']);
    expect(types(part2)).toEqual([
      'agent_iteration:success',
      'tool_approval:success',
      'tool_call:success',
      'agent_iteration:success',
      'ai_call:success',
    ]);
    // Iterations are numbered across the session, not per invoke.
    expect(part2.events.filter((event) => event.type === 'agent_iteration').map((event) => event.label))
      .toEqual(['Iteration 2 #4', 'Iteration 3 #7']);
  });

  it('the decision names who decided, when, and how long the run waited', async () => {
    const { sessions } = await runApproval(true);
    const pendingEvent = sessions[0].events.find((event) => event.type === 'tool_approval')!;
    const decision = sessions[1].events.find((event) => event.type === 'tool_approval')!;
    const pendingData = pendingEvent.data!.sections.find((section) => section.kind === 'metadata') as any;
    const decisionData = decision.data!.sections.find((section) => section.kind === 'metadata') as any;

    expect(pendingData.data).toMatchObject({ status: 'pending' });
    expect(decisionData.data).toMatchObject({ decision: 'approved', decidedBy: 'anil', approvalId: pendingData.data.approvalId });
    expect(decision.actor).toMatchObject({ scope: 'human', name: 'anil', role: 'approver' });
    expect(decision.durationMs).toBeGreaterThanOrEqual(0);
    const requested = decision.data!.sections.find((section) => section.kind === 'tool_call') as any;
    expect(requested.arguments).toEqual({ query: 'cognipeer' });
  });

  it('a rejection is recorded the same way', async () => {
    const { sessions } = await runApproval(false);
    const decision = sessions[1].events.find((event) => event.type === 'tool_approval')!;
    expect(decision.label).toMatch(/^Rejected · web_search/);
    const data = (decision.data!.sections.find((section) => section.kind === 'metadata') as any).data;
    expect(data).toMatchObject({ decision: 'rejected', comment: 'not now' });
    expect(sessions[1].events.some((event) => event.type === 'tool_call' && event.status === 'success')).toBe(false);
  });

  it('totals are cumulative: the last part reports the whole session', async () => {
    const { sessions } = await runApproval(true);
    const [part1, part2] = sessions;
    expect(part1.summary.totalInputTokens).toBe(100);
    expect(part2.summary.totalInputTokens).toBe(200);
    expect(part2.summary.eventCounts.agent_iteration).toBe(3);
    expect(part2.summary.eventCounts.ai_call).toBe(2);
  });

  it('a new message after the turn finished opens a new session', async () => {
    const { sessions, second } = await runApproval(true);
    const { sink, sessions: next } = collectingSink();
    const agent = createAgent({
      name: 'Researcher',
      model: scriptedModel([{ content: 'Sure.' }]) as any,
      tools: [searchTool()],
      tracing: { enabled: true, sink },
    });
    await agent.invoke({ ...second.state!, messages: [...second.messages, { role: 'user', content: 'Thanks' }] } as SmartState);
    expect(next[0].sessionId).not.toBe(sessions[0].sessionId);
    expect(next[0].continuation).toBeUndefined();
  });

  it('survives the paused state being persisted as JSON and as a snapshot', async () => {
    const { sessions, sink } = collectingSink();
    const agent = createAgent({
      name: 'Researcher',
      model: scriptedModel([
        { tool_calls: [call('c1', 'web_search', { query: 'x' })] },
        { content: 'done' },
      ]) as any,
      tools: [searchTool()],
      tracing: { enabled: true, sink },
    });
    const first = await agent.invoke({ messages: [{ role: 'user', content: 'go' }] } as SmartState);
    const snapshot = captureSnapshot(first.state!);
    const restored = restoreSnapshot(JSON.parse(JSON.stringify(snapshot)));
    const resolved = agent.resolveToolApproval(restored, { id: first.state!.pendingApprovals![0].id, approved: true });
    await agent.invoke(resolved);
    expect(sessions[1].sessionId).toBe(sessions[0].sessionId);
    expect(sessions[1].continuation?.part).toBe(2);
  });

  it('works through the smart agent', async () => {
    const { sessions, sink } = collectingSink();
    const agent = createSmartAgent({
      name: 'Researcher',
      model: scriptedModel([
        { tool_calls: [call('c1', 'web_search', { query: 'x' })] },
        { content: 'done' },
      ]) as any,
      tools: [searchTool()],
      useTodoList: false,
      tracing: { enabled: true, sink },
    });
    const first = await agent.invoke({ messages: [{ role: 'user', content: 'go' }] } as SmartState);
    const resolved = agent.resolveToolApproval(first.state!, { id: first.state!.pendingApprovals![0].id, approved: true });
    const second = await agent.invoke(resolved);
    expect(second.content).toBe('done');
    const ids = new Set(sessions.map((session) => session.sessionId));
    expect(ids.size).toBe(1);
    expect(sessions.at(-1)!.status).toBe('success');
    expect(second.state!.ctx!.__traceContinuation).toBeUndefined();
  });

  it('the file sink writes the whole session, not just the last part', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'trace-continuation-'));
    const agent = createAgent({
      name: 'Researcher',
      model: scriptedModel([
        { tool_calls: [call('c1', 'web_search', { query: 'x' })] },
        { content: 'done' },
      ]) as any,
      tools: [searchTool()],
      tracing: { enabled: true, sink: fileSink(dir) },
    });
    const first = await agent.invoke({ messages: [{ role: 'user', content: 'go' }] } as SmartState);
    const sessionId = (first.state!.ctx!.__traceContinuation as any).sessionId as string;
    const resolved = agent.resolveToolApproval(first.state!, { id: first.state!.pendingApprovals![0].id, approved: true });
    await agent.invoke(resolved);
    const written = JSON.parse(fs.readFileSync(path.join(dir, sessionId, 'trace.session.json'), 'utf8')) as TraceSessionFile;
    expect(written.events.map((event) => event.sequence)).toEqual(written.events.map((_, i) => i + 1));
    expect(written.events.length).toBe(8);
    expect(written.status).toBe('success');
    expect(written.continuation).toBeUndefined();
  });
});

describe('trace continuation across a question to the user', () => {
  it('records the question and the answer in one session', async () => {
    const { sessions, sink } = collectingSink();
    const agent = createAgent({
      name: 'Deploy',
      model: scriptedModel([
        {
          tool_calls: [call('q1', 'ask_user_question', {
            questions: [{ question: 'Pick a target', options: [{ label: 'Vercel' }, { label: 'Fly.io' }] }],
          })],
        },
        { content: 'Deploying to Vercel.' },
      ]) as any,
      humanInTheLoop: { askUser: true },
      tracing: { enabled: true, logData: true, sink },
    });
    const first = await agent.invoke({ messages: [{ role: 'user', content: 'Deploy it' }] } as SmartState);
    const pending = first.state!.pendingUserQuestions![0];
    const resolved = agent.resolveUserQuestion(first.state!, {
      id: pending.id,
      answers: { 'Pick a target': { values: ['Vercel'] } },
      answeredBy: 'anil',
    });
    await agent.invoke(resolved);

    expect(sessions).toHaveLength(2);
    expect(sessions[1].sessionId).toBe(sessions[0].sessionId);
    expect(sessions[0].status).toBe('paused');
    const asked = sessions[0].events.find((event) => event.type === 'user_question')!;
    expect(asked.status).toBe('pending');
    const answer = sessions[1].events.find((event) => event.type === 'user_question')!;
    expect(answer.label).toMatch(/^Answer from user/);
    expect(answer.actor).toMatchObject({ scope: 'human', name: 'anil' });
    const qa = answer.data!.sections.find((section) => section.label === 'Questions and answers') as any;
    expect(qa.data.items).toEqual([{ question: 'Pick a target', answer: { values: ['Vercel'] } }]);
  });
});

describe('host-run (client) tools', () => {
  function session(): TraceSessionRuntime {
    return {
      sessionId: 's', startedAt: Date.now(), traceId: 't', rootSpanId: 'r',
      resolvedConfig: { enabled: true, mode: 'batched', logData: true, sink: { type: 'custom' } },
      events: [], summary: { totalDurationMs: 0, totalInputTokens: 0, totalOutputTokens: 0, totalCachedInputTokens: 0, totalBytesIn: 0, totalBytesOut: 0, eventCounts: {} },
      status: 'in_progress', errors: [],
    };
  }

  it('records the result as a tool step, not as an answer from the user', () => {
    const trace = session();
    const state = {
      pendingUserQuestions: [{
        id: 'p1', toolCallId: 'tc1', toolName: 'ask_user_question' as const, questions: [], status: 'answered' as const,
        requestedAt: '2026-10-15T10:00:00.000Z', answeredAt: '2026-10-15T10:00:02.500Z',
        metadata: { clientTool: { name: 'get_customer', args: { id: 42 } } },
      }],
      toolHistory: [{ tool_call_id: 'tc1', output: '{"name":"Ada"}', rawOutput: { name: 'Ada' }, status: 'success' }],
    };
    recordHumanDecisions(trace, state);
    expect(trace.events).toHaveLength(1);
    const [event] = trace.events;
    expect(event.type).toBe('tool_call');
    expect(event.label).toMatch(/get_customer \(client\)/);
    expect(event.durationMs).toBe(2500);
    const result = event.data!.sections.find((section) => section.kind === 'tool_result') as any;
    expect(result.output).toEqual({ name: 'Ada' });

    // Recorded once: a later iteration of the same run does not repeat it.
    recordHumanDecisions(trace, state);
    expect(trace.events).toHaveLength(1);
  });
});
