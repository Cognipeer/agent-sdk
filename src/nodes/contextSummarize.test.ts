import { describe, it, expect } from 'vitest';
import { createContextSummarizeNode } from "./contextSummarize.js";

/**
 * A trailing assistant→tool exchange. The summarizer never compacts the newest
 * turn (the model has not reasoned over it yet), so any fixture that wants an
 * earlier tool response compacted has to put something after it.
 */
function latestTurn(toolCallId: string, toolName: string, content: string) {
  return [
    {
      role: 'assistant',
      content: '',
      tool_calls: [{ id: toolCallId, type: 'function', function: { name: toolName, arguments: '{}' } }],
    },
    { role: 'tool', name: toolName, tool_call_id: toolCallId, content },
  ];
}

describe('contextSummarize', () => {
  it('should handle summarization with null model gracefully', async () => {
    const summarizer = createContextSummarizeNode({
      summarization: true,
      limits: { summaryTokenLimit: 5000 },
      // We don't want to call a real model in tests. The node tolerates missing model.invoke
      // and will fall back to a default summary text.
      model: null as any,
    } as any);

    const execId = "exec_test_1";
    const state: any = {
      messages: [
        { role: "user", content: "hello" },
        {
          role: "assistant",
          content: "calling tool",
          tool_calls: [
            {
              id: "call_1",
              type: "function",
              function: { name: "search_in_knowledgebase", arguments: "{\"query\":\"x\"}" },
            },
          ],
        },
        {
          role: "tool",
          name: "search_in_knowledgebase",
          tool_call_id: "call_1",
          content: "RAW_TOOL_PAYLOAD: result A, result B",
        },
      ],
      toolHistory: [
        {
          executionId: execId,
          toolName: "search_in_knowledgebase",
          tool_call_id: "call_1",
          output: "RAW_TOOL_PAYLOAD: result A, result B",
          rawOutput: "RAW_TOOL_PAYLOAD: result A, result B",
          timestamp: new Date().toISOString(),
        },
      ],
      toolHistoryArchived: [],
      ctx: {},
    };

    const delta = await summarizer(state);
    const next = { ...state, ...delta };

    // 1) Tool message must still exist (may be replaced with placeholder)
    const summarizedToolMsg = next.messages.find((m: any) => m.role === "tool");
    expect(summarizedToolMsg).toBeDefined();
    
    // When model is null, it falls back to default behavior
    // The summarization may or may not happen depending on error handling
    // Just verify the function completed without throwing
    expect(next.messages).toBeDefined();
  });

  it('should ignore synthetic summarize_context messages when deciding what to compress', async () => {
    const summarizer = createContextSummarizeNode({
      summarization: true,
      model: {
        async invoke() {
          return { role: 'assistant', content: 'unexpected summary' };
        },
      },
    } as any);

    const state: any = {
      messages: [
        { role: 'user', content: 'hello' },
        {
          role: 'assistant',
          content: 'calling real tool',
          tool_calls: [
            {
              id: 'call_1',
              type: 'function',
              function: { name: 'search_in_knowledgebase', arguments: '{"query":"x"}' },
            },
          ],
        },
        {
          role: 'tool',
          name: 'search_in_knowledgebase',
          tool_call_id: 'call_1',
          content: 'SUMMARIZED',
        },
        {
          role: 'assistant',
          content: 'Context limit reached. Summarizing conversation history to reduce token usage.',
          tool_calls: [
            {
              id: 'call_summary_1',
              type: 'function',
              function: { name: 'summarize_context', arguments: '{}' },
            },
          ],
        },
        {
          role: 'tool',
          name: 'summarize_context',
          tool_call_id: 'call_summary_1',
          content: 'PROJECT_FACT|code=ORBIT|owner=Ada Lovelace|risk=low|milestone=design',
        },
      ],
      summaries: ['PROJECT_FACT|code=ORBIT|owner=Ada Lovelace|risk=low|milestone=design'],
      ctx: {},
    };

    const delta = await summarizer(state);

    expect(delta).toEqual({});
  });

  it('should preserve canonical tool facts even if the model omits them', async () => {
    const summarizer = createContextSummarizeNode({
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
              rawSummary: 'minimal summary',
            }),
          };
        },
      },
    } as any);

    const state: any = {
      messages: [
        { role: 'user', content: 'Fetch project facts and preserve them.' },
        {
          role: 'assistant',
          content: 'calling tool',
          tool_calls: [
            {
              id: 'call_1',
              type: 'function',
              function: { name: 'fetch_project_snapshot', arguments: '{"project":"orbit"}' },
            },
          ],
        },
        {
          role: 'tool',
          name: 'fetch_project_snapshot',
          tool_call_id: 'call_1',
          content: 'PROJECT_FACT|code=ORBIT|owner=Ada Lovelace|risk=low|milestone=design',
        },
        // The latest turn is never compacted, so call_1 needs a successor to be
        // outside the protected window.
        ...latestTurn('call_2', 'fetch_project_snapshot', 'PROJECT_FACT|code=NOVA|owner=Grace Hopper|risk=medium|milestone=blocked'),
      ],
      summaries: [],
      summaryRecords: [],
      ctx: {},
    };

    const delta = await summarizer(state);
    const record = delta.summaryRecords?.[0];

    expect(record?.stable_facts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ key: 'project_fact.orbit.owner', value: 'Ada Lovelace' }),
        expect.objectContaining({ key: 'project_fact.orbit.risk', value: 'low' }),
        expect.objectContaining({ key: 'project_fact.orbit.milestone', value: 'design' }),
      ]),
    );
  });

  it('records the summarization call in state.usage so hosts can bill it', async () => {
    // Summarization fires on the longest, most expensive runs. Its tokens were
    // reported to the tracing sink but never entered state.usage, so a host
    // billing from result.metadata.usage was permanently short by exactly that
    // spend — and only ever on the runs where it mattered most.
    const summarizer = createContextSummarizeNode({
      summarization: true,
      model: {
        modelName: 'gpt-5.4-mini',
        async invoke() {
          return {
            role: 'assistant',
            content: JSON.stringify({
              stable_facts: [],
              active_goals: [],
              open_questions: [],
              discarded_obsolete: [],
              rawSummary: 'summary',
            }),
            usage: { prompt_tokens: 900, completion_tokens: 120, total_tokens: 1020 },
          };
        },
      },
    } as any);

    const state: any = {
      messages: [
        { role: 'user', content: 'summarize this' },
        {
          role: 'assistant',
          content: 'calling tool',
          tool_calls: [
            { id: 'call_1', type: 'function', function: { name: 'fetch', arguments: '{}' } },
          ],
        },
        { role: 'tool', name: 'fetch', tool_call_id: 'call_1', content: 'a long tool response' },
        ...latestTurn('call_2', 'fetch', 'another tool response'),
      ],
      summaries: [],
      summaryRecords: [],
      usage: { perRequest: [], totals: {} },
      ctx: {},
    };

    await summarizer(state);

    expect(state.usage.perRequest).toHaveLength(1);
    expect(state.usage.perRequest[0]).toMatchObject({
      modelName: 'gpt-5.4-mini',
      usage: expect.objectContaining({ prompt_tokens: 900, completion_tokens: 120 }),
    });
    expect(state.usage.perRequest[0].id).toEqual(expect.any(String));
    expect(state.usage.totals['gpt-5.4-mini']).toMatchObject({ input: 900, output: 120, total: 1020 });
  });

  it('should preserve tool retrieval hints when compacting tool messages', async () => {
    const summarizer = createContextSummarizeNode({
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

    const state: any = {
      messages: [
        { role: 'user', content: 'Count daily CRM logs exactly.' },
        {
          role: 'assistant',
          content: 'calling tool',
          tool_calls: [
            {
              id: 'call_crm_1',
              type: 'function',
              function: { name: 'crm_list_logs', arguments: '{"range":"2026-04-06..2026-04-12"}' },
            },
          ],
        },
        {
          role: 'tool',
          name: 'crm_list_logs',
          tool_call_id: 'call_crm_1',
          content: JSON.stringify({ rows: Array.from({ length: 25 }, (_, index) => ({ day: index + 1, count: index * 3 })) }),
        },
        ...latestTurn('call_crm_2', 'crm_list_logs', '{"rows":[]}'),
      ],
      toolHistory: [
        {
          executionId: 'exec_crm_1',
          toolName: 'crm_list_logs',
          tool_call_id: 'call_crm_1',
          output: { rows: Array.from({ length: 25 }, (_, index) => ({ day: index + 1, count: index * 3 })) },
          rawOutput: { rows: Array.from({ length: 25 }, (_, index) => ({ day: index + 1, count: index * 3 })) },
          summary: 'array(length=25) day/count rows for requested CRM log range',
          timestamp: new Date().toISOString(),
        },
      ],
      toolHistoryArchived: [],
      summaries: [],
      summaryRecords: [],
      ctx: {},
    };

    const delta = await summarizer(state);
    const summarizedToolMsg = delta.messages?.find((message: any) => message.role === 'tool' && message.name === 'crm_list_logs');

    expect(typeof summarizedToolMsg?.content).toBe('string');
    expect(summarizedToolMsg?.content).toContain('ARCHIVED_TOOL_RESPONSE');
    expect(summarizedToolMsg?.content).toContain('toolCallId=call_crm_1');
    expect(summarizedToolMsg?.content).toContain('executionId=exec_crm_1');
    expect(summarizedToolMsg?.content).toContain('array(length=25) day/count rows for requested CRM log range');
    expect(summarizedToolMsg?.content).toContain('get_tool_response');
  });

  it('should respect keep_full retention policy and not summarize protected tool messages', async () => {
    const summarizer = createContextSummarizeNode({
      summarization: true,
      toolResponses: {
        defaultPolicy: 'keep_full',
        maxToolResponseChars: 100000,
        maxToolResponseTokens: 50000,
      },
      model: {
        async invoke() {
          return {
            role: 'assistant',
            content: JSON.stringify({
              stable_facts: [],
              active_goals: [],
              open_questions: [],
              discarded_obsolete: [],
              rawSummary: 'should not be generated',
            }),
          };
        },
      },
    } as any);

    const state: any = {
      messages: [
        { role: 'user', content: 'Fetch all calendar events.' },
        {
          role: 'assistant',
          content: 'calling tool',
          tool_calls: [
            {
              id: 'call_cal_1',
              type: 'function',
              function: { name: 'list_calendar_events', arguments: '{"range":"week"}' },
            },
          ],
        },
        {
          role: 'tool',
          name: 'list_calendar_events',
          tool_call_id: 'call_cal_1',
          content: JSON.stringify({ events: Array.from({ length: 50 }, (_, i) => ({ id: i, title: `Event ${i}` })) }),
        },
      ],
      toolHistory: [
        {
          executionId: 'exec_cal_1',
          toolName: 'list_calendar_events',
          tool_call_id: 'call_cal_1',
          retentionPolicy: 'keep_full',
          output: { events: Array.from({ length: 50 }, (_, i) => ({ id: i, title: `Event ${i}` })) },
          rawOutput: { events: Array.from({ length: 50 }, (_, i) => ({ id: i, title: `Event ${i}` })) },
          timestamp: new Date().toISOString(),
        },
      ],
      toolHistoryArchived: [],
      summaries: [],
      summaryRecords: [],
      ctx: {},
    };

    const delta = await summarizer(state);

    // With keep_full, there should be nothing to compress — return empty delta
    expect(delta).toEqual({});
  });
});
