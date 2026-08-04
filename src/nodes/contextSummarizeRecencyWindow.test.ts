import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { createContextSummarizeNode } from "./contextSummarize.js";
import { createSmartAgent, createTool } from "../index.js";

/**
 * Prod incident 2026-08-04 (pulse task_run 10126362-b4a7-463e-8d8b-c7d0881be9a6):
 * a worker searched the web, and the same tool outputs it had just received were
 * archived out of its context by the very next summarization pass. The model read
 * the ARCHIVED_TOOL_RESPONSE markers, paged every payload back in with
 * `get_tool_response`, burned that tool's per-run execution budget, and from then
 * on simply re-ran the identical searches forever — the run never terminated.
 *
 * The recency window in contextSummarize was supposed to prevent exactly this,
 * but it was conditional: it only engaged when OTHER compressable tool messages
 * existed. Since already-archived placeholders are excluded from the compressable
 * set, "other compressable" is empty on the first pass AND on every later pass
 * once the backlog is archived — so the window never engaged when it mattered.
 */

function summarizerNode() {
  return createContextSummarizeNode({
    summarization: true,
    model: {
      async invoke() {
        return {
          role: 'assistant',
          content: JSON.stringify({
            stable_facts: [],
            active_goals: [],
            open_questions: [],
            discarded_obsolete: [],
            rawSummary: 'compact summary',
          }),
        };
      },
    },
  } as any);
}

function webSearchResult(seed: string) {
  return { answer: `answer about ${seed}`, results: Array.from({ length: 10 }, (_, i) => ({ url: `https://${seed}.example/${i}`, content: `content ${i}` })) };
}

function searchTurn(ids: string[]) {
  return [
    {
      role: 'assistant',
      content: '',
      tool_calls: ids.map((id) => ({
        id: `call_${id}`,
        type: 'function',
        function: { name: 'web_search', arguments: JSON.stringify({ query: id }) },
      })),
    },
    ...ids.map((id) => ({
      role: 'tool',
      name: 'web_search',
      tool_call_id: `call_${id}`,
      content: JSON.stringify(webSearchResult(id)),
    })),
  ];
}

function searchHistory(ids: string[]) {
  return ids.map((id) => ({
    executionId: `exec_${id}`,
    toolName: 'web_search',
    tool_call_id: `call_${id}`,
    output: webSearchResult(id),
    rawOutput: webSearchResult(id),
    timestamp: new Date().toISOString(),
  }));
}

const summarizer = summarizerNode();

describe('contextSummarize recency window', () => {
  it('never archives the tool responses the model is still reasoning about on the first pass', async () => {
    const state: any = {
      messages: [
        { role: 'user', content: 'Research Cognipeer and write a company profile.' },
        ...searchTurn(['alpha', 'beta', 'gamma']),
      ],
      toolHistory: searchHistory(['alpha', 'beta', 'gamma']),
      toolHistoryArchived: [],
      summaries: [],
      summaryRecords: [],
      ctx: {},
    };

    const delta = await summarizer(state);

    // Nothing older exists, so there is nothing this pass can reclaim. Compressing
    // the freshest batch would only force the model to page it straight back in.
    expect(delta).toEqual({});
  });

  it('never archives the freshest batch just because the backlog is already archived', async () => {
    const state: any = {
      messages: [
        { role: 'user', content: 'Research Cognipeer and write a company profile.' },
        {
          role: 'assistant',
          content: '',
          tool_calls: [
            { id: 'call_old', type: 'function', function: { name: 'web_search', arguments: '{"query":"old"}' } },
          ],
        },
        {
          role: 'tool',
          name: 'web_search',
          tool_call_id: 'call_old',
          content: 'ARCHIVED_TOOL_RESPONSE [toolName=web_search, toolCallId=call_old, executionId=exec_old]\nSummary: object(keys=2)\nUse get_tool_response with executionId "exec_old" to fetch the full payload.',
        },
        ...searchTurn(['alpha', 'beta', 'gamma']),
      ],
      toolHistory: searchHistory(['alpha', 'beta', 'gamma']),
      toolHistoryArchived: [
        {
          ...searchHistory(['old'])[0],
          tool_call_id: 'call_old',
          executionId: 'exec_old',
          summarized: true,
          retentionPolicy: 'summarize_archive',
        },
      ],
      summaries: [],
      summaryRecords: [],
      ctx: {},
    };

    const delta = await summarizer(state);
    const freshToolMessages = (delta.messages ?? state.messages).filter(
      (m: any) => m.role === 'tool' && ['call_alpha', 'call_beta', 'call_gamma'].includes(m.tool_call_id),
    );

    expect(freshToolMessages).toHaveLength(3);
    for (const message of freshToolMessages) {
      expect(message.content).not.toContain('ARCHIVED_TOOL_RESPONSE');
      expect(message.content).toContain('answer about');
    }
  });

  it('still compresses older tool responses while the latest turn stays intact', async () => {
    const state: any = {
      messages: [
        { role: 'user', content: 'Research Cognipeer and write a company profile.' },
        ...searchTurn(['old1', 'old2']),
        ...searchTurn(['fresh1', 'fresh2']),
      ],
      toolHistory: searchHistory(['old1', 'old2', 'fresh1', 'fresh2']),
      toolHistoryArchived: [],
      summaries: [],
      summaryRecords: [],
      ctx: {},
    };

    const delta = await summarizer(state);
    const byCallId = new Map<string, any>(
      (delta.messages ?? []).filter((m: any) => m.role === 'tool').map((m: any) => [m.tool_call_id, m]),
    );

    expect(byCallId.get('call_old1')?.content).toContain('ARCHIVED_TOOL_RESPONSE');
    expect(byCallId.get('call_old2')?.content).toContain('ARCHIVED_TOOL_RESPONSE');
    expect(byCallId.get('call_fresh1')?.content).toContain('answer about fresh1');
    expect(byCallId.get('call_fresh2')?.content).toContain('answer about fresh2');
  });

  it('keeps the run moving: older turns compact, the live turn survives, the agent still answers', async () => {
    // Guards the whole loop, not just the node. Deferring a pass must not strand
    // the run either: an early version of this fix marked summarization
    // permanently exhausted on the deferred pass, and the agent then stopped
    // before producing a final answer.
    const modelCalls: string[] = [];
    let agentTurn = 0;
    const model: any = {
      modelName: 'recency-window-probe',
      bindTools: () => model,
      async invoke(messages: any[]) {
        const isSummaryPrompt = messages.length === 2
          && messages[0]?.role === 'system'
          && String(messages[0].content).includes('summarizes conversation history efficiently');
        modelCalls.push(isSummaryPrompt ? 'summary' : 'agent');
        if (isSummaryPrompt) return { role: 'assistant', content: 'SUMMARY' };

        agentTurn += 1;
        const seed = ['first', 'second'][agentTurn - 1];
        if (!seed) return { role: 'assistant', content: 'done' };
        return {
          role: 'assistant',
          content: '',
          tool_calls: [{
            id: `call_${seed}`,
            type: 'function',
            name: 'search',
            args: { seed },
            function: { name: 'search', arguments: JSON.stringify({ seed }) },
          }],
        };
      },
    };

    const agent = createSmartAgent({
      name: 'RecencyWindowProbe',
      model,
      tools: [createTool({
        name: 'search',
        description: 'Returns a payload large enough to force summarization.',
        schema: z.object({ seed: z.string() }),
        func: async ({ seed }: { seed: string }) => `SEED_${seed.toUpperCase()}\n${'Detailed padding payload '.repeat(160)}`,
      })],
      summarization: { enable: true, maxTokens: 350, summaryPromptMaxTokens: 2000 },
      limits: { maxToolCalls: 4 },
    } as any);

    const result = await agent.invoke({ messages: [{ role: 'user', content: 'Search twice, then answer.' }] } as any);
    const toolMessages = (result.state?.messages ?? []).filter((m: any) => m.role === 'tool' && m.name === 'search');

    expect(modelCalls.filter((call) => call === 'summary').length).toBeGreaterThanOrEqual(1);
    // Older turn reclaimed, newest turn intact. Assert on the marker rather than
    // on payload text: the archive placeholder embeds a preview of the payload,
    // so a substring check alone passes even when the message WAS archived.
    expect(toolMessages[0]?.content).toContain('ARCHIVED_TOOL_RESPONSE');
    expect(toolMessages[1]?.content).not.toContain('ARCHIVED_TOOL_RESPONSE');
    expect(toolMessages[1]?.content).toContain('SEED_SECOND');
    // And the run actually finished instead of stalling on a deferred pass.
    expect(agentTurn).toBe(3);
  });
});
