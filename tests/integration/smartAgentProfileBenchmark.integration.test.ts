import { beforeAll, describe, expect, it } from 'vitest';
import OpenAI from 'openai';
import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';
import { createSmartAgent, createTool } from '../../src/index.js';
import type { BuiltInRuntimeProfile, RuntimeProfile, SmartAgentCustomProfileConfig, SmartAgentEvent, SmartState } from '../../src/types.js';

const API_KEY = process.env.OPENAI_API_KEY;
const runReal = API_KEY ? describe : describe.skip;
type BenchmarkProfileTarget = {
  label: string;
  runtimeProfile: RuntimeProfile;
  baseProfile: BuiltInRuntimeProfile;
  customProfile?: SmartAgentCustomProfileConfig;
};

const PROFILES: BenchmarkProfileTarget[] = [
  { label: 'fast', runtimeProfile: 'fast', baseProfile: 'fast' },
  { label: 'balanced', runtimeProfile: 'balanced', baseProfile: 'balanced' },
  { label: 'deep', runtimeProfile: 'deep', baseProfile: 'deep' },
  { label: 'research', runtimeProfile: 'research', baseProfile: 'research' },
  {
    label: 'balanced-planner',
    runtimeProfile: 'custom',
    baseProfile: 'balanced',
    customProfile: {
      extends: 'balanced',
      planning: { mode: 'todo' },
      context: { lastTurnsToKeep: 10 },
    },
  },
  {
    label: 'fast-compact',
    runtimeProfile: 'custom',
    baseProfile: 'fast',
    customProfile: {
      extends: 'fast',
      summarization: { maxTokens: 620, summaryTriggerTokens: 300 },
      toolResponses: { maxToolResponseChars: 220 },
    },
  },
];

type ScenarioReport = {
  id: string;
  success: boolean;
  factScore: number;
  latencyMs: number;
  totalTokens: number;
  toolCalls: number;
  toolErrors: number;
  summaries: number;
  archivedResponses: number;
  compactions: number;
  planUsed: boolean;
  notes: string[];
};

type ProfileBenchmarkReport = {
  profile: RuntimeProfile;
  profileLabel: string;
  baseProfile: BuiltInRuntimeProfile;
  aggregate: {
    successRate: number;
    averageFactScore: number;
    averageLatencyMs: number;
    totalTokens: number;
    totalToolCalls: number;
    totalToolErrors: number;
    totalSummaries: number;
    totalArchivedResponses: number;
    planUsageRate: number;
    weightedScore: number;
  };
  scenarios: ScenarioReport[];
};

function createOpenAIModel(apiKey: string, modelName = 'gpt-4o-mini') {
  const client = new OpenAI({ apiKey });
  let boundTools: any[] | undefined;

  const model: any = {
    modelName,
    async invoke(messages: any[]): Promise<any> {
      const openaiMessages = messages.map((message: any) => {
        const normalized: any = {
          role: message.role,
          content: typeof message.content === 'string' ? message.content : JSON.stringify(message.content),
        };
        if (message.name) normalized.name = message.name;
        if (Array.isArray(message.tool_calls)) {
          normalized.tool_calls = message.tool_calls.map((toolCall: any) => ({
            id: toolCall.id,
            type: toolCall.type || 'function',
            function: toolCall.function || {
              name: toolCall.name,
              arguments: typeof toolCall.args === 'string' ? toolCall.args : JSON.stringify(toolCall.args || {}),
            },
          }));
        }
        if (message.tool_call_id) normalized.tool_call_id = message.tool_call_id;
        return normalized;
      });

      const response = await client.chat.completions.create({
        model: modelName,
        messages: openaiMessages,
        tools: boundTools,
        tool_choice: boundTools && boundTools.length > 0 ? 'auto' : undefined,
      });

      const choice = response.choices[0]?.message;
      return {
        role: 'assistant',
        content: choice?.content || '',
        usage: response.usage,
        tool_calls: choice?.tool_calls?.map((toolCall: any) => ({
          id: toolCall.id,
          name: toolCall.function.name,
          args: toolCall.function.arguments,
        })),
      };
    },
    bindTools(tools: any[]) {
      boundTools = tools.map((tool) => {
        const schema = tool.schema || tool.parameters;
        const parameters = schema && typeof schema.parse === 'function'
          ? zodToJsonSchema(schema, { target: 'openApi3' })
          : schema || { type: 'object', properties: {} };
        delete (parameters as any).$schema;
        return {
          type: 'function',
          function: {
            name: tool.name,
            description: tool.description || '',
            parameters,
          },
        };
      });
      return model;
    },
  };

  return model;
}

function normalizeText(value: string | undefined): string {
  return (value || '').toLowerCase();
}

function ratio(numerator: number, denominator: number): number {
  if (denominator <= 0) return 1;
  return Number((numerator / denominator).toFixed(3));
}

function extractTotalTokens(result: { metadata?: { usage?: any } }): number {
  const totals = result.metadata?.usage?.totals;
  if (!totals || typeof totals !== 'object') return 0;
  return Object.values(totals).reduce((acc: number, entry: any) => acc + (Number(entry?.total) || 0), 0);
}

function collectEventMetrics(events: SmartAgentEvent[]) {
  const toolCalls = events.filter((event) => event.type === 'tool_call' && event.phase === 'success').length;
  const toolErrors = events.filter((event) => event.type === 'tool_call' && event.phase === 'error').length;
  return { toolCalls, toolErrors };
}

function buildScenarioReport(
  id: string,
  startedAt: number,
  result: { content: string; metadata?: { usage?: any }; state?: SmartState },
  events: SmartAgentEvent[],
  factChecks: Array<boolean>,
  notes: string[] = [],
): ScenarioReport {
  const { toolCalls, toolErrors } = collectEventMetrics(events);
  const state = result.state;
  const factScore = ratio(factChecks.filter(Boolean).length, factChecks.length);
  return {
    id,
    success: factScore >= 0.8,
    factScore,
    latencyMs: Date.now() - startedAt,
    totalTokens: extractTotalTokens(result),
    toolCalls,
    toolErrors,
    summaries: state?.summaries?.length || 0,
    archivedResponses: state?.toolHistoryArchived?.length || 0,
    compactions: state?.summaryRecords?.length || 0,
    planUsed: Boolean(state?.plan?.steps?.length),
    notes,
  };
}

function aggregateProfile(target: BenchmarkProfileTarget, scenarios: ScenarioReport[]): ProfileBenchmarkReport {
  const successRate = ratio(scenarios.filter((scenario) => scenario.success).length, scenarios.length);
  const averageFactScore = Number((scenarios.reduce((acc, scenario) => acc + scenario.factScore, 0) / Math.max(scenarios.length, 1)).toFixed(3));
  const averageLatencyMs = Number((scenarios.reduce((acc, scenario) => acc + scenario.latencyMs, 0) / Math.max(scenarios.length, 1)).toFixed(1));
  const totalTokens = scenarios.reduce((acc, scenario) => acc + scenario.totalTokens, 0);
  const totalToolCalls = scenarios.reduce((acc, scenario) => acc + scenario.toolCalls, 0);
  const totalToolErrors = scenarios.reduce((acc, scenario) => acc + scenario.toolErrors, 0);
  const totalSummaries = scenarios.reduce((acc, scenario) => acc + scenario.summaries, 0);
  const totalArchivedResponses = scenarios.reduce((acc, scenario) => acc + scenario.archivedResponses, 0);
  const planUsageRate = ratio(scenarios.filter((scenario) => scenario.planUsed).length, scenarios.length);
  const weightedScore = Number((
    (successRate * 0.55)
    + (averageFactScore * 0.2)
    + ((1 - Math.min(totalToolErrors / Math.max(totalToolCalls, 1), 1)) * 0.1)
    + ((1 - Math.min(totalTokens / 40000, 1)) * 0.1)
    + (planUsageRate * 0.05)
  ).toFixed(3));

  return {
    profile: target.runtimeProfile,
    profileLabel: target.label,
    baseProfile: target.baseProfile,
    aggregate: {
      successRate,
      averageFactScore,
      averageLatencyMs,
      totalTokens,
      totalToolCalls,
      totalToolErrors,
      totalSummaries,
      totalArchivedResponses,
      planUsageRate,
      weightedScore,
    },
    scenarios,
  };
}

runReal('Smart Agent Profile Benchmark', () => {
  let model: any;

  beforeAll(() => {
    model = createOpenAIModel(API_KEY!);
  });

  function createBenchmarkAgent(target: BenchmarkProfileTarget, nameSuffix: string, tools: any[], extra?: Omit<Parameters<typeof createSmartAgent>[0], 'name' | 'model' | 'runtimeProfile' | 'customProfile' | 'tools'>) {
    return createSmartAgent({
      name: `Benchmark-${target.label}-${nameSuffix}`,
      model,
      runtimeProfile: target.runtimeProfile,
      customProfile: target.customProfile,
      tools,
      ...extra,
    });
  }

  async function runLongSessionScenario(target: BenchmarkProfileTarget): Promise<ScenarioReport> {
    const projectSnapshot = createTool({
      name: 'project_snapshot',
      description: 'Return a verbose project snapshot for a named codebase.',
      schema: z.object({ code: z.enum(['ORBIT', 'NOVA']) }),
      func: async ({ code }) => ({
        code,
        owner: code === 'ORBIT' ? 'Ada Lovelace' : 'Grace Hopper',
        risk: code === 'ORBIT' ? 'low' : 'medium',
        milestone: code === 'ORBIT' ? 'design' : 'blocked',
        notes: `${code} detailed snapshot `.repeat(420),
      }),
    });

    const agent = createBenchmarkAgent(target, 'long-session', [projectSnapshot], {
      summarization: {
        summaryTriggerTokens: 420,
        maxTokens: 760,
        summaryPromptMaxTokens: 1200,
      },
      toolResponses: {
        maxToolResponseChars: 320,
        maxToolResponseTokens: 120,
      },
    });

    const events: SmartAgentEvent[] = [];
    const startedAt = Date.now();
    const result = await agent.invoke({
      messages: [{
        role: 'user',
        content: 'Use project_snapshot for ORBIT and NOVA. Then answer with the owner, risk, and milestone for both projects in one short paragraph.',
      }],
    } as SmartState, { onEvent: (event) => events.push(event) });

    const lowered = normalizeText(result.content);
    return buildScenarioReport(
      'long_session_recall',
      startedAt,
      result,
      events,
      [
        lowered.includes('orbit'),
        lowered.includes('nova'),
        lowered.includes('ada'),
        lowered.includes('grace'),
        lowered.includes('low'),
        lowered.includes('medium'),
        lowered.includes('design'),
        lowered.includes('blocked'),
      ],
    );
  }

  async function runMultiTurnRecallScenario(target: BenchmarkProfileTarget): Promise<ScenarioReport> {
    const fetchProjectSnapshot = createTool({
      name: 'fetch_project_snapshot',
      description: 'Return a large project snapshot with canonical fact lines.',
      schema: z.object({ project: z.enum(['orbit', 'nova']) }),
      func: async ({ project }) => {
        const fact = project === 'orbit'
          ? 'PROJECT_FACT|code=ORBIT|owner=Ada Lovelace|risk=low|milestone=design'
          : 'PROJECT_FACT|code=NOVA|owner=Grace Hopper|risk=medium|milestone=blocked';
        return `${fact}\n${'Detailed archived payload '.repeat(220)}`;
      },
    });

    const agent = createBenchmarkAgent(target, 'multi-turn', [fetchProjectSnapshot], {
      summarization: {
        summaryTriggerTokens: 380,
        maxTokens: 680,
        summaryPromptMaxTokens: 1400,
      },
      toolResponses: {
        maxToolResponseChars: 280,
        maxToolResponseTokens: 100,
      },
    });

    const events: SmartAgentEvent[] = [];
    const startedAt = Date.now();
    const first = await agent.invoke({
      messages: [{
        role: 'user',
        content: 'Fetch the ORBIT and NOVA project snapshots and preserve the key facts for a later recall question.',
      }],
    } as SmartState, { onEvent: (event) => events.push(event) });

    const second = await agent.invoke({
      ...(first.state as SmartState),
      messages: [
        ...((first.state?.messages || first.messages) as SmartState['messages']),
        { role: 'user', content: 'What are the owner and risk for ORBIT and NOVA? Answer in one sentence.' },
      ],
    } as SmartState, { onEvent: (event) => events.push(event) });

    const lowered = normalizeText(second.content);
    return buildScenarioReport(
      'multi_turn_recall',
      startedAt,
      second,
      events,
      [
        lowered.includes('orbit'),
        lowered.includes('nova'),
        lowered.includes('ada'),
        lowered.includes('grace'),
        lowered.includes('low'),
        lowered.includes('medium'),
      ],
      first.state?.summaries?.length ? ['initial turn summarized successfully'] : ['no summary generated on first turn'],
    );
  }

  async function runRecoveryScenario(target: BenchmarkProfileTarget): Promise<ScenarioReport> {
    const attempts = new Map<string, number>();
    const unstableLookup = createTool({
      name: 'unstable_lookup',
      description: 'Return project facts but fail the first attempt for each code.',
      schema: z.object({ code: z.enum(['ORBIT', 'NOVA']) }),
      func: async ({ code }) => {
        const nextAttempt = (attempts.get(code) || 0) + 1;
        attempts.set(code, nextAttempt);
        if (nextAttempt === 1) {
          throw new Error(`transient backend timeout for ${code}`);
        }
        return {
          code,
          owner: code === 'ORBIT' ? 'Ada Lovelace' : 'Grace Hopper',
          risk: code === 'ORBIT' ? 'low' : 'medium',
        };
      },
    });

    const agent = createBenchmarkAgent(target, 'recovery', [unstableLookup], {
      limits: { maxToolCalls: 6 },
    });

    const events: SmartAgentEvent[] = [];
    const startedAt = Date.now();
    const result = await agent.invoke({
      messages: [{
        role: 'user',
        content: 'Use unstable_lookup for ORBIT and NOVA. If a tool call fails, retry that exact lookup one time and then answer with the owner and risk for both projects.',
      }],
    } as SmartState, { onEvent: (event) => events.push(event) });

    const lowered = normalizeText(result.content);
    const toolErrors = events.filter((event) => event.type === 'tool_call' && event.phase === 'error').length;
    return buildScenarioReport(
      'recovery_after_tool_error',
      startedAt,
      result,
      events,
      [
        toolErrors >= 1,
        lowered.includes('ada'),
        lowered.includes('grace'),
        lowered.includes('low'),
        lowered.includes('medium'),
      ],
      [`tool errors observed=${toolErrors}`],
    );
  }

  async function runPlanningScenario(target: BenchmarkProfileTarget): Promise<ScenarioReport> {
    const fetchRequirement = createTool({
      name: 'fetch_requirement',
      description: 'Return a concise requirement summary for a named stream.',
      schema: z.object({ stream: z.enum(['alpha', 'beta']) }),
      func: async ({ stream }) => ({
        stream,
        owner: stream === 'alpha' ? 'Ada' : 'Grace',
        priority: stream === 'alpha' ? 'high' : 'medium',
        blocker: stream === 'alpha' ? 'none' : 'vendor delay',
      }),
    });

    const agent = createBenchmarkAgent(target, 'planning', [fetchRequirement], {
      limits: { maxToolCalls: 5 },
    });

    const events: SmartAgentEvent[] = [];
    const startedAt = Date.now();
    const result = await agent.invoke({
      messages: [{
        role: 'user',
        content: 'Plan the work, then use fetch_requirement for alpha and beta. Finally compare both streams and mention the owner and blocker for each in two bullets.',
      }],
    } as SmartState, { onEvent: (event) => events.push(event) });

    const lowered = normalizeText(result.content);
    const planUsed = Boolean(result.state?.plan?.steps?.length);
    return buildScenarioReport(
      'planning_and_comparison',
      startedAt,
      result,
      events,
      [
        lowered.includes('alpha'),
        lowered.includes('beta'),
        lowered.includes('ada'),
        lowered.includes('grace'),
        lowered.includes('none'),
        lowered.includes('vendor'),
      ],
      [planUsed ? 'todo plan used' : 'no todo plan materialized'],
    );
  }

  async function runToolDisciplineScenario(target: BenchmarkProfileTarget): Promise<ScenarioReport> {
    const lookupOwner = createTool({
      name: 'lookup_owner',
      description: 'Return the owner for a project code.',
      schema: z.object({ code: z.enum(['ORBIT', 'NOVA']) }),
      func: async ({ code }) => ({ owner: code === 'ORBIT' ? 'Ada Lovelace' : 'Grace Hopper' }),
    });

    const agent = createBenchmarkAgent(target, 'discipline', [lookupOwner], {
      limits: { maxToolCalls: 3 },
    });

    const events: SmartAgentEvent[] = [];
    const startedAt = Date.now();
    const result = await agent.invoke({
      messages: [{
        role: 'user',
        content: 'Call lookup_owner only for ORBIT exactly once, then answer with only the owner name and nothing else.',
      }],
    } as SmartState, { onEvent: (event) => events.push(event) });

    const lowered = normalizeText(result.content.trim());
    const toolCalls = events.filter((event) => event.type === 'tool_call' && event.phase === 'success').length;
    return buildScenarioReport(
      'minimal_tool_discipline',
      startedAt,
      result,
      events,
      [
        lowered.includes('ada'),
        !lowered.includes('grace'),
        toolCalls <= 1,
      ],
      [`successful tool calls=${toolCalls}`],
    );
  }

  it('should benchmark all runtime profiles across detailed real scenarios', async () => {
    const reports: ProfileBenchmarkReport[] = [];

    for (const profile of PROFILES) {
      const scenarios = [
        await runLongSessionScenario(profile),
        await runMultiTurnRecallScenario(profile),
        await runRecoveryScenario(profile),
        await runPlanningScenario(profile),
        await runToolDisciplineScenario(profile),
      ];
      reports.push(aggregateProfile(profile, scenarios));
    }

    const ranked = [...reports].sort((left, right) => right.aggregate.weightedScore - left.aggregate.weightedScore);
    console.log('PROFILE_BENCHMARK_REPORT=' + JSON.stringify({ ranked, reports }));

    expect(reports).toHaveLength(PROFILES.length);
    expect(reports.every((report) => report.scenarios.length === 5)).toBe(true);
    expect(ranked[0]?.aggregate.weightedScore).toBeGreaterThan(0);
  }, 600000);
});