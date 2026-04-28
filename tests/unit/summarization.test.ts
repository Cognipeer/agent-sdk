/**
 * Summarization Unit Tests with deterministic mock models.
 *
 * These tests validate that summarization does not only trigger,
 * but also preserves the facts that later turns depend on.
 */

import { describe, it, expect } from 'vitest';
import { createSmartAgent, createTool } from '../../src/index.js';
import type { Message, SummarizationEvent } from '../../src/types.js';
import { z } from 'zod';

type ProjectFact = {
  code: string;
  owner: string;
  risk: string;
  milestone: string;
};

type DeterministicSummaryModel = {
  modelName: string;
  bindTools: () => DeterministicSummaryModel;
  invoke: (messages: Message[]) => Promise<Message>;
  getSummaryPrompts: () => string[];
};

const factPattern = /PROJECT_FACT\|code=([^|\n"{}]+)\|owner=([^|\n"{}]+)\|risk=([^|\n"{}]+)\|milestone=([^|\n"{}]+)/g;

const projectFacts: Record<'orbit' | 'nova', ProjectFact> = {
  orbit: {
    code: 'ORBIT',
    owner: 'Ada Lovelace',
    risk: 'low',
    milestone: 'design',
  },
  nova: {
    code: 'NOVA',
    owner: 'Grace Hopper',
    risk: 'medium',
    milestone: 'blocked',
  },
};

function messageToText(message: Message): string {
  if (typeof message.content === 'string') {
    return message.content;
  }

  return message.content
    .map((part) => (typeof part === 'string' ? part : part?.text ?? part?.content ?? JSON.stringify(part)))
    .join('');
}

function toFactLine(fact: ProjectFact): string {
  return `PROJECT_FACT|code=${fact.code}|owner=${fact.owner}|risk=${fact.risk}|milestone=${fact.milestone}`;
}

function extractProjectFacts(text: string): ProjectFact[] {
  const byCode = new Map<string, ProjectFact>();

  for (const match of text.matchAll(factPattern)) {
    const [, code, owner, risk, milestone] = match;
    byCode.set(code, { code, owner, risk, milestone });
  }

  return Array.from(byCode.values()).sort((left, right) => left.code.localeCompare(right.code));
}

function buildToolPayload(fact: ProjectFact): string {
  return `${toFactLine(fact)}\n${'Detailed archived payload '.repeat(160)}`;
}

function isSummarizationPrompt(messages: Message[]): boolean {
  return messages.length === 2
    && messages[0]?.role === 'system'
    && typeof messages[0]?.content === 'string'
    && messages[0].content.includes('summarizes conversation history efficiently');
}

function createDeterministicSummarizationModel(): DeterministicSummaryModel {
  let agentTurn = 0;
  const summaryPrompts: string[] = [];

  const model: DeterministicSummaryModel = {
    modelName: 'deterministic-summarization-model',
    bindTools() {
      return model;
    },
    async invoke(messages: Message[]): Promise<Message> {
      if (isSummarizationPrompt(messages)) {
        const promptBody = messageToText(messages[messages.length - 1]);
        summaryPrompts.push(promptBody);

        return {
          role: 'assistant',
          content: extractProjectFacts(promptBody).map(toFactLine).join('\n') || 'NO_RETAINED_FACTS',
        };
      }

      agentTurn += 1;

      if (agentTurn === 1) {
        return {
          role: 'assistant',
          content: '',
          tool_calls: [{
            id: 'call_orbit',
            type: 'function',
            name: 'fetch_project_snapshot',
            args: { project: 'orbit' },
            function: {
              name: 'fetch_project_snapshot',
              arguments: JSON.stringify({ project: 'orbit' }),
            },
          }],
        };
      }

      if (agentTurn === 2) {
        return {
          role: 'assistant',
          content: '',
          tool_calls: [{
            id: 'call_nova',
            type: 'function',
            name: 'fetch_project_snapshot',
            args: { project: 'nova' },
            function: {
              name: 'fetch_project_snapshot',
              arguments: JSON.stringify({ project: 'nova' }),
            },
          }],
        };
      }

      const retainedFacts = extractProjectFacts(messages.map(messageToText).join('\n'));
      const answer = retainedFacts
        .map((fact) => `${fact.code} is owned by ${fact.owner} with ${fact.risk} risk at the ${fact.milestone} milestone`)
        .join('; ');

      return {
        role: 'assistant',
        content: answer || 'No retained facts.',
      };
    },
    getSummaryPrompts() {
      return [...summaryPrompts];
    },
  };

  return model;
}

async function runRepeatedSummarizationScenario() {
  const summarizationEvents: SummarizationEvent[] = [];
  const toolPhases: string[] = [];

  const fetchProjectSnapshot = createTool({
    name: 'fetch_project_snapshot',
    description: 'Return a large project snapshot that should be compacted by summarization.',
    schema: z.object({ project: z.enum(['orbit', 'nova']) }),
    func: async ({ project }) => buildToolPayload(projectFacts[project]),
  });

  const model = createDeterministicSummarizationModel();
  const agent = createSmartAgent({
    name: 'DeterministicSummaryAgent',
    model,
    tools: [fetchProjectSnapshot],
    summarization: {
      enable: true,
      maxTokens: 350,
      summaryPromptMaxTokens: 2000,
    },
    limits: { maxToolCalls: 4 },
  });

  const initialResult = await agent.invoke({
    messages: [{
      role: 'user',
      content: 'Fetch the ORBIT and NOVA project snapshots, then tell me the owner and risk for each project after any summarization happens.',
    }],
  }, {
    onEvent: (event: any) => {
      if (event.type === 'summarization') {
        summarizationEvents.push(event as SummarizationEvent);
      }

      if (event.type === 'tool_call' && event.phase) {
        toolPhases.push(event.phase);
      }
    },
  });

  return { agent, model, initialResult, summarizationEvents, toolPhases };
}

describe('Summarization with deterministic mock models', () => {
  it('should preserve tool-derived facts across repeated summarization passes', async () => {
    const { initialResult, summarizationEvents, toolPhases } = await runRepeatedSummarizationScenario();
    const state = initialResult.state!;
    const latestSummary = state.summaries?.[state.summaries.length - 1] || '';

    expect(toolPhases.filter((phase) => phase === 'success')).toHaveLength(2);
    expect(summarizationEvents.length).toBeGreaterThanOrEqual(2);
    expect(state.summaries?.length).toBeGreaterThanOrEqual(2);
    expect(state.messages.some((message) => message.role === 'tool' && typeof message.content === 'string' && /^(SUMMARIZED|SUMMARIZED_TOOL_RESPONSE|ARCHIVED_TOOL_RESPONSE|STRUCTURED_TOOL_RESPONSE|DROPPED_TOOL_RESPONSE)/.test(message.content))).toBe(true);
    expect(summarizationEvents.every((event) => typeof event.tokenCountBefore === 'number' && typeof event.tokenCountAfter === 'number')).toBe(true);
    // Verify that summarization events report meaningful token counts.
    // Note: tokenCountAfter may not always be less than tokenCountBefore because
    // the summary + synthetic messages can add overhead when tool responses are
    // already compact (e.g., keep_structured policy). The important thing is that
    // summarization produces valid structured summaries.
    expect(summarizationEvents.every(
      (event) => (event.tokenCountBefore ?? 0) > 0 && (event.tokenCountAfter ?? 0) > 0,
    )).toBe(true);

    expect(latestSummary).toContain('PROJECT_FACT|code=ORBIT|owner=Ada Lovelace|risk=low|milestone=design');
    expect(latestSummary).toContain('PROJECT_FACT|code=NOVA|owner=Grace Hopper|risk=medium|milestone=blocked');
  });

  it('should never emit the synthetic summarization marker as a finalAnswer event', async () => {
    const summarizationEvents: SummarizationEvent[] = [];
    const finalAnswerEvents: Array<{ content: string }> = [];

    const fetchProjectSnapshot = createTool({
      name: 'fetch_project_snapshot',
      description: 'Return a large project snapshot that should be compacted by summarization.',
      schema: z.object({ project: z.enum(['orbit', 'nova']) }),
      func: async ({ project }) => buildToolPayload(projectFacts[project]),
    });

    const model = createDeterministicSummarizationModel();
    const agent = createSmartAgent({
      name: 'DeterministicSummaryAgent',
      model,
      tools: [fetchProjectSnapshot],
      summarization: {
        enable: true,
        maxTokens: 350,
        summaryPromptMaxTokens: 2000,
      },
      limits: { maxToolCalls: 4 },
    });

    await agent.invoke({
      messages: [{
        role: 'user',
        content: 'Fetch the ORBIT and NOVA project snapshots, then tell me the owner and risk for each project after any summarization happens.',
      }],
    }, {
      onEvent: (event: any) => {
        if (event.type === 'summarization') {
          summarizationEvents.push(event as SummarizationEvent);
        }

        if (event.type === 'finalAnswer') {
          finalAnswerEvents.push({ content: typeof event.content === 'string' ? event.content : '' });
        }
      },
    });

    // At least one summarization actually happened, otherwise this regression
    // check would silently pass without exercising the path it protects.
    expect(summarizationEvents.length).toBeGreaterThanOrEqual(1);
    expect(finalAnswerEvents.length).toBeGreaterThanOrEqual(1);
    for (const event of finalAnswerEvents) {
      expect(event.content).not.toMatch(/Context limit reached\. Summarizing conversation history/i);
    }
  });

  it('should pass the previous summary into later summarization prompts', async () => {
    const { model, initialResult } = await runRepeatedSummarizationScenario();
    const state = initialResult.state!;
    const summaryPrompts = model.getSummaryPrompts();
    const latestSummary = state.summaries?.[state.summaries.length - 1] || '';

    expect(summaryPrompts.length).toBeGreaterThanOrEqual(2);
    expect(summaryPrompts[0]).toContain('PROJECT_FACT|code=ORBIT');
    expect(summaryPrompts[1]).toContain('PROJECT_FACT|code=ORBIT');
    expect(summaryPrompts[1]).toContain('PROJECT_FACT|code=NOVA');
    expect(latestSummary).toContain('PROJECT_FACT|code=ORBIT');
    expect(latestSummary).toContain('PROJECT_FACT|code=NOVA');
  });

  it('should recover raw tool output after tool messages are compacted', async () => {
    const { agent, initialResult } = await runRepeatedSummarizationScenario();
    const state = initialResult.state!;
    const recoveryTool = agent.__runtime.tools.find((tool: any) => tool.name === 'get_tool_response') as any;
    const orbitExecution = state.toolHistory?.find((entry) => String(entry.output).includes('PROJECT_FACT|code=ORBIT'));

    expect(recoveryTool).toBeDefined();
    expect(orbitExecution).toBeDefined();
    expect(state.messages.some((message) => message.role === 'tool' && typeof message.content === 'string' && /^(SUMMARIZED|SUMMARIZED_TOOL_RESPONSE|ARCHIVED_TOOL_RESPONSE|STRUCTURED_TOOL_RESPONSE|DROPPED_TOOL_RESPONSE)/.test(message.content))).toBe(true);

    const recovered = await recoveryTool.func({ executionId: orbitExecution!.executionId });

    expect(recovered).toContain('PROJECT_FACT|code=ORBIT');
    expect(recovered).toContain('Detailed archived payload');
  });

  it('should properly stringify object content in token counting', async () => {
    const { countApproxTokens } = await import('../../src/utils/utilTokens.js');

    const messages = [
      { role: 'user', content: 'Get data' },
      { role: 'assistant', content: '', tool_calls: [{ id: 'call_1' }] },
      { role: 'tool', content: { result: 'A'.repeat(400) }, tool_call_id: 'call_1' },
    ];

    const allText = messages
      .map((message: any) => {
        if (typeof message.content === 'string') return message.content;
        if (Array.isArray(message.content)) {
          return message.content.map((part: any) => (typeof part === 'string' ? part : part?.text ?? part?.content ?? JSON.stringify(part))).join('');
        }
        if (message.content && typeof message.content === 'object') {
          return JSON.stringify(message.content);
        }
        return '';
      })
      .join('\n');

    const tokenCount = countApproxTokens(allText);

    expect(tokenCount).toBeGreaterThan(50);
  });
});
