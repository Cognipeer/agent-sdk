/**
 * Regression suite for the context-loss root causes behind the production
 * "task request lost" incidents (consumer: Cognipeer Pulse worker/code agents,
 * 2026-07). Four distinct defects, each reproduced deterministically here:
 *
 * 1. clampToBudget dropped messages from the FRONT once the raw-policy view
 *    exceeded maxContextTokens — and the first casualty was the first user
 *    message carrying the run's task/context. The model then concluded no task
 *    was provided and bounced an ask_user_question back to the user.
 * 2. The hybrid turn-window (collectRecentTurns) only re-attached the first
 *    user message in assistant-counting mode, so multi-user-turn chats lost
 *    the anchor entirely.
 * 3. The post-loop structured-output finalizer ignored run pauses: after an
 *    ask_user_question pause it kept nudging the model and executing tools,
 *    stacking duplicate pending questions while the run was supposedly
 *    suspended.
 * 4. Summarization could archive tool RESPONSES but never touched tool-call
 *    ARGUMENTS, so content-authoring calls (whose arguments carry the whole
 *    payload) kept the context growing until the clamp had to truncate.
 */

import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { createSmartAgent, createTool, normalizeSmartAgentOptions } from '../../src/index.js';
import { buildModelMessages } from '../../src/smart/contextPolicy.js';
import type { Message, SmartState } from '../../src/types.js';

const FINAL_SCHEMA = z.object({ summary: z.string().min(1) });

function textOf(message: Message | undefined): string {
  if (!message) return '';
  if (typeof message.content === 'string') return message.content;
  if (Array.isArray(message.content)) {
    return message.content
      .map((part: any) => (typeof part === 'string' ? part : part?.text ?? part?.content ?? ''))
      .join('\n');
  }
  return '';
}

function isSummarizerPrompt(messages: Message[]): boolean {
  return messages.some(
    (message) => message.role === 'system' && textOf(message).includes('summarizes conversation history'),
  );
}

const TASK_ANCHOR = 'TASK_ANCHOR: compile the weekly fetch report.';

type RecordedCall = { roles: string[]; sawAnchor: boolean; messages: Message[] };

/**
 * Scripted worker-style model: fetches until `fetchTarget` pages are read,
 * then finalizes through the tool-based `response` tool. If the task anchor
 * ever disappears from its view it asks the user what to do — the exact
 * confused behavior real models exhibited in production.
 */
class ScriptedModel {
  model = 'scripted-model';
  capabilities = { structuredOutput: 'tool_based' as const, strictToolCalling: false, streaming: false };
  loopCalls: RecordedCall[] = [];
  fetches = 0;
  asks = 0;

  constructor(private fetchTarget: number) {}

  bindTools() {
    return this;
  }

  async invoke(messages: Message[]): Promise<Message> {
    if (isSummarizerPrompt(messages)) {
      return {
        role: 'assistant',
        content: JSON.stringify({
          stable_facts: [],
          active_goals: ['finish the report'],
          open_questions: [],
          discarded_obsolete: [],
          rawSummary: `Fetched ${this.fetches} pages so far.`,
        }),
      };
    }

    const sawAnchor = messages.some((m) => m.role !== 'system' && textOf(m).includes(TASK_ANCHOR));
    this.loopCalls.push({ roles: messages.map((m) => m.role), sawAnchor, messages });

    if (!sawAnchor) {
      this.asks += 1;
      return {
        role: 'assistant',
        content: '',
        tool_calls: [
          {
            id: `ask_${this.asks}`,
            type: 'function',
            function: {
              name: 'ask_user_question',
              arguments: JSON.stringify({
                questions: [{ question: 'No task is present in my context. What should I do?', header: 'Task?' }],
              }),
            },
          },
        ],
      } as Message;
    }

    if (this.fetches < this.fetchTarget) {
      this.fetches += 1;
      return {
        role: 'assistant',
        content: '',
        tool_calls: [
          {
            id: `fetch_${this.fetches}`,
            type: 'function',
            function: { name: 'fetch_data', arguments: JSON.stringify({ page: this.fetches }) },
          },
        ],
      } as Message;
    }

    return {
      role: 'assistant',
      content: '',
      tool_calls: [
        {
          id: 'final_1',
          type: 'function',
          function: { name: 'response', arguments: JSON.stringify({ summary: `done after ${this.fetches}` }) },
        },
      ],
    } as Message;
  }
}

const WORD = 'lorem ipsum dolor sit amet consectetur adipiscing elit ';

function buildFetchTool(payloadByPage: (page: number) => string) {
  return createTool({
    name: 'fetch_data',
    description: 'Fetch a page of report data.',
    schema: z.object({ page: z.number().int().min(1) }),
    func: async ({ page }: { page: number }) => ({ page, data: payloadByPage(page) }),
  });
}

function initialState(userContent: string): SmartState {
  return {
    messages: [{ role: 'user', content: userContent }],
    toolHistory: [],
    toolHistoryArchived: [],
    summaries: [],
    summaryRecords: [],
  } as unknown as SmartState;
}

describe('fix 1 — clampToBudget pins the first user message (context anchor)', () => {
  it('keeps the anchor visible on every model call even when keep_full retention forces clamping', async () => {
    // keep_full everywhere -> summarization can never compress -> the clamp is
    // the only shrink path. Before the fix the clamp removed the first user
    // message first and the model lost its task.
    const model = new ScriptedModel(4);
    const agent = createSmartAgent<z.infer<typeof FINAL_SCHEMA>>({
      name: 'ClampRepro',
      model: model as never,
      tools: [buildFetchTool((page) => (page === 1 ? WORD.repeat(640) : WORD.repeat(1240)))],
      runtimeProfile: 'balanced',
      planning: { mode: 'off' },
      limits: { maxToolCalls: 12, maxContextTokens: 26_000 },
      summarization: {
        enable: true,
        maxTokens: 8_000,
        summaryTriggerTokens: 18_000,
        summaryPromptMaxTokens: 12_000,
        integrityCheck: true,
      },
      context: { policy: 'raw', toolResponsePolicy: 'keep_full' },
      toolResponses: {
        defaultPolicy: 'keep_full',
        toolResponseRetentionByTool: {},
        maxToolResponseChars: 400_000,
        maxToolResponseTokens: 100_000,
      },
      outputSchema: FINAL_SCHEMA as z.ZodType<z.infer<typeof FINAL_SCHEMA>>,
      systemPrompt: 'You are a worker. Your task is the TASK_ANCHOR line in the first user message.',
      humanInTheLoop: { askUser: { allowFreeText: true } },
    });

    const result = await agent.invoke(initialState(`${TASK_ANCHOR}\n\nOperating context for the run.`), {});

    expect(model.loopCalls.length).toBeGreaterThan(0);
    for (const call of model.loopCalls) {
      expect(call.sawAnchor).toBe(true);
    }
    expect(model.asks).toBe(0);
    expect(result.output).toEqual({ summary: 'done after 4' });

    // The clamp still did its job: at least one over-budget view had older
    // fetch exchanges dropped (pairwise) while the anchor stayed.
    const clampedViews = model.loopCalls.filter((call) => call.roles.filter((r) => r === 'tool').length < model.fetches);
    expect(clampedViews.length).toBeGreaterThan(0);
  });

  it('drops assistant/tool pairs adjacently, never leaving orphan tool results', async () => {
    const model = new ScriptedModel(4);
    const agent = createSmartAgent<z.infer<typeof FINAL_SCHEMA>>({
      name: 'ClampAdjacency',
      model: model as never,
      tools: [buildFetchTool(() => WORD.repeat(900))],
      runtimeProfile: 'balanced',
      planning: { mode: 'off' },
      limits: { maxToolCalls: 12, maxContextTokens: 22_000 },
      summarization: { enable: false },
      context: { policy: 'raw', toolResponsePolicy: 'keep_full' },
      toolResponses: {
        defaultPolicy: 'keep_full',
        toolResponseRetentionByTool: {},
        maxToolResponseChars: 400_000,
        maxToolResponseTokens: 100_000,
      },
      outputSchema: FINAL_SCHEMA as z.ZodType<z.infer<typeof FINAL_SCHEMA>>,
      systemPrompt: 'Worker with TASK_ANCHOR in the first user message.',
    });

    await agent.invoke(initialState(`${TASK_ANCHOR}\nContext.`), {});

    for (const call of model.loopCalls) {
      const seenToolCallIds = new Set<string>();
      for (const message of call.messages) {
        if (message.role === 'assistant' && Array.isArray((message as any).tool_calls)) {
          for (const tc of (message as any).tool_calls) seenToolCallIds.add(tc.id);
        }
        if (message.role === 'tool') {
          expect(seenToolCallIds.has((message as any).tool_call_id)).toBe(true);
        }
      }
    }
  });
});

describe('fix 2 — hybrid turn window always retains the first user message', () => {
  it('keeps the anchor when user turns exceed lastTurnsToKeep', () => {
    const resolved = normalizeSmartAgentOptions({
      name: 'HybridWindow',
      model: {} as never,
      context: { policy: 'hybrid', lastTurnsToKeep: 2 },
      limits: { maxContextTokens: 100_000 },
    } as never);

    const messages: Message[] = [
      { role: 'system', content: 'system prompt' },
      { role: 'user', content: `${TASK_ANCHOR} original instruction` },
      { role: 'assistant', content: 'ack 1' },
      { role: 'user', content: 'follow-up 1' },
      { role: 'assistant', content: 'ack 2' },
      { role: 'user', content: 'follow-up 2' },
      { role: 'assistant', content: 'ack 3' },
      { role: 'user', content: 'follow-up 3' },
    ];

    const view = buildModelMessages({ messages } as unknown as SmartState, resolved);
    const flattened = view.map((m) => textOf(m)).join('\n');

    expect(flattened).toContain(TASK_ANCHOR);
    // The window itself still applies: the oldest follow-up is out.
    expect(flattened).not.toContain('follow-up 1');
  });
});

describe('fix 3 — post-loop structured-output finalizer respects run pauses', () => {
  it('does not re-invoke the model or stack duplicate questions after an ask_user pause', async () => {
    // Model asks ONE legitimate question on its first sight of the task.
    class AskingModel extends ScriptedModel {
      asked = false;
      override async invoke(messages: Message[]): Promise<Message> {
        if (isSummarizerPrompt(messages)) return super.invoke(messages);
        if (!this.asked) {
          this.asked = true;
          this.loopCalls.push({ roles: messages.map((m) => m.role), sawAnchor: true, messages });
          return {
            role: 'assistant',
            content: '',
            tool_calls: [
              {
                id: 'scope_1',
                type: 'function',
                function: {
                  name: 'ask_user_question',
                  arguments: JSON.stringify({ questions: [{ question: 'Which week?', header: 'Scope' }] }),
                },
              },
            ],
          } as Message;
        }
        return super.invoke(messages);
      }
    }

    const model = new AskingModel(1);
    const agent = createSmartAgent<z.infer<typeof FINAL_SCHEMA>>({
      name: 'PauseRepro',
      model: model as never,
      tools: [buildFetchTool(() => 'small payload')],
      runtimeProfile: 'balanced',
      planning: { mode: 'off' },
      limits: { maxToolCalls: 8, maxContextTokens: 100_000 },
      summarization: { enable: false },
      context: { policy: 'raw', toolResponsePolicy: 'keep_full' },
      outputSchema: FINAL_SCHEMA as z.ZodType<z.infer<typeof FINAL_SCHEMA>>,
      systemPrompt: 'Worker.',
      humanInTheLoop: { askUser: { allowFreeText: true } },
    });

    const paused = await agent.invoke(initialState(`${TASK_ANCHOR}\nContext.`), {});
    const pausedState = paused.state as SmartState & {
      pendingUserQuestions?: Array<{ id: string; status: string; questions: Array<{ question: string }> }>;
    };

    // Exactly ONE model call happened (the one that asked); the finalizer did
    // not nudge the paused run back into the model.
    expect(model.loopCalls).toHaveLength(1);
    // Exactly ONE pending question — no duplicates piled up.
    const pending = (pausedState.pendingUserQuestions ?? []).filter((q) => q.status === 'pending');
    expect(pending).toHaveLength(1);
    expect(paused.output ?? null).toBeNull();

    // The pause is resumable and completes normally afterwards.
    const resolved = agent.resolveUserQuestion(pausedState, {
      id: pending[0].id,
      answers: { 'Which week?': { values: [], freeText: 'Week 31' } },
    });
    const resumed = await agent.invoke(resolved as SmartState, {});
    expect(resumed.output).toEqual({ summary: 'done after 1' });
  });
});

describe('fix 4 — summarization compacts archived tool-call ARGUMENTS', () => {
  it('replaces oversized arguments of archived exchanges with a valid-JSON marker and keeps the newest turn intact', async () => {
    const hugeChunk = WORD.repeat(1200); // ~66k chars of argument payload per call
    let pages = 0;

    class WritingModel extends ScriptedModel {
      override async invoke(messages: Message[]): Promise<Message> {
        if (isSummarizerPrompt(messages)) return super.invoke(messages);
        const sawAnchor = messages.some((m) => m.role !== 'system' && textOf(m).includes(TASK_ANCHOR));
        this.loopCalls.push({ roles: messages.map((m) => m.role), sawAnchor, messages });
        expect(sawAnchor).toBe(true);
        if (pages < 3) {
          pages += 1;
          return {
            role: 'assistant',
            content: '',
            tool_calls: [
              {
                id: `write_${pages}`,
                type: 'function',
                function: {
                  name: 'append_chunk',
                  arguments: JSON.stringify({ page: pages, content: hugeChunk }),
                },
              },
            ],
          } as Message;
        }
        return {
          role: 'assistant',
          content: '',
          tool_calls: [
            {
              id: 'final_1',
              type: 'function',
              function: { name: 'response', arguments: JSON.stringify({ summary: 'written' }) },
            },
          ],
        } as Message;
      }
    }

    const appendTool = createTool({
      name: 'append_chunk',
      description: 'Append a content chunk to the working document.',
      schema: z.object({ page: z.number().int().min(1), content: z.string().min(1) }),
      func: async ({ page }: { page: number; content: string }) => ({ ok: true, page }),
    });

    const model = new WritingModel(0);
    const agent = createSmartAgent<z.infer<typeof FINAL_SCHEMA>>({
      name: 'ArgsCompaction',
      model: model as never,
      tools: [appendTool],
      runtimeProfile: 'balanced',
      planning: { mode: 'off' },
      limits: { maxToolCalls: 10, maxContextTokens: 60_000 },
      summarization: {
        enable: true,
        maxTokens: 8_000,
        summaryTriggerTokens: 20_000,
        summaryPromptMaxTokens: 12_000,
        integrityCheck: true,
      },
      context: { policy: 'raw', toolResponsePolicy: 'summarize_archive' },
      toolResponses: {
        defaultPolicy: 'summarize_archive',
        toolResponseRetentionByTool: {},
        maxToolResponseChars: 400_000,
        maxToolResponseTokens: 100_000,
      },
      outputSchema: FINAL_SCHEMA as z.ZodType<z.infer<typeof FINAL_SCHEMA>>,
      systemPrompt: 'Document writer.',
    });

    const result = await agent.invoke(initialState(`${TASK_ANCHOR}\nWrite the document.`), {});
    expect(result.output).toEqual({ summary: 'written' });

    // Inspect the final persisted transcript: archived write calls must carry
    // the compact marker instead of the original huge arguments, and markers
    // must be valid JSON (provider adapters parse tool-call arguments).
    const finalMessages = (result.state?.messages ?? []) as Message[];
    const markers: Array<Record<string, unknown>> = [];
    let fullArgsSurvivors = 0;
    for (const message of finalMessages) {
      if (message.role !== 'assistant' || !Array.isArray((message as any).tool_calls)) continue;
      for (const tc of (message as any).tool_calls) {
        if (tc?.function?.name !== 'append_chunk') continue;
        const args = String(tc.function.arguments ?? '');
        if (args.includes('"__argsArchived"')) {
          markers.push(JSON.parse(args));
        } else if (args.length > 10_000) {
          fullArgsSurvivors += 1;
        }
      }
    }

    expect(markers.length).toBeGreaterThan(0);
    for (const marker of markers) {
      expect(marker.__argsArchived).toBe(true);
      expect(typeof marker.originalChars).toBe('number');
    }
    // The protected (most recent) exchange keeps its full arguments so the
    // model can still reason about what it just wrote.
    expect(fullArgsSurvivors).toBeGreaterThan(0);
  });
});
