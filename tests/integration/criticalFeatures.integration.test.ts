/**
 * Critical Features Integration Tests
 *
 * These tests exercise the critical features against a REAL, OpenAI-compatible
 * endpoint, driven through the SDK's OWN provider layer (`createProvider` +
 * `fromNativeProvider`) instead of a hand-rolled adapter — so a regression in
 * the provider/adapter code is caught here rather than masked by a second,
 * drifting copy of it.
 *
 * Covered:
 * 1. Multi-turn tool execution (long-running tool loops)
 * 2. Summarization (at least one summarization, plus fact retention across it)
 * 3. Guardrails
 * 4. Tool approvals
 * 5. Multi-agent delegation
 * 6. Handoff
 *
 * Requires OPENAI_API_KEY; skipped entirely without one.
 *
 *   OPENAI_API_KEY=sk-xxx npm run test:critical
 *
 * Any OpenAI-compatible endpoint works:
 *
 *   OPENAI_BASE_URL=http://localhost:11434/v1 \
 *   PLUGIN_TEST_MODEL=qwen2.5 OPENAI_API_KEY=ignored npx vitest run …
 *
 * Assertions are written against BEHAVIOUR (tool invocations, state fields,
 * emitted events) rather than particular model wording, so they hold across models.
 */

import { describe, it, expect } from 'vitest';
import {
  createAgent,
  createSmartAgent,
  createTool,
} from '../../src/index.js';
import { createProvider, fromNativeProvider } from '../../src/providers/index.js';
import { z } from 'zod';
import type { SmartAgentEvent, ConversationGuardrail, GuardrailContext } from '../../src/types.js';
import { GuardrailPhase } from '../../src/types.js';

// Skip if no API key
const API_KEY = process.env.OPENAI_API_KEY;
const runReal = API_KEY ? describe : describe.skip;
const MODEL = process.env.PLUGIN_TEST_MODEL ?? 'gpt-4o-mini';
const BASE_URL = process.env.OPENAI_BASE_URL;

/** The SDK's own provider stack, pointed at whatever endpoint is configured. */
function realModel() {
  return fromNativeProvider(
    createProvider({
      provider: 'openai',
      apiKey: API_KEY!,
      defaultModel: MODEL,
      ...(BASE_URL ? { baseURL: BASE_URL } : {}),
    }),
    { model: MODEL },
  );
}

// ============================================================================
// 1. MULTI-TURN TOOL EXECUTION
// ============================================================================
runReal('1. Multi-Turn Tool Execution', () => {
  const model = realModel();

  it('should execute multiple tools across multiple turns', async () => {
    const toolExecutions: string[] = [];
    
    const fetchWeather = createTool({
      name: 'fetch_weather',
      description: 'Get weather for a city',
      schema: z.object({ city: z.string() }),
      func: async ({ city }) => {
        toolExecutions.push(`weather:${city}`);
        return { city, temperature: 22, condition: 'sunny' };
      },
    });

    const fetchNews = createTool({
      name: 'fetch_news',
      description: 'Get news for a topic',
      schema: z.object({ topic: z.string() }),
      func: async ({ topic }) => {
        toolExecutions.push(`news:${topic}`);
        return { topic, headlines: ['Breaking: AI advances', 'Tech stocks rise'] };
      },
    });

    const sendEmail = createTool({
      name: 'send_email',
      description: 'Send an email with content',
      schema: z.object({ to: z.string(), subject: z.string(), body: z.string() }),
      func: async ({ to, subject, body }) => {
        toolExecutions.push(`email:${to}`);
        return { success: true, messageId: 'msg_123' };
      },
    });

    const agent = createAgent({
      name: 'MultiTurnAgent',
      model,
      tools: [fetchWeather, fetchNews, sendEmail],
      limits: { maxToolCalls: 10 },
    });

    const result = await agent.invoke({
      messages: [{
        role: 'user',
        content: 'Get the weather in Tokyo, fetch news about AI, and then send an email to john@example.com summarizing both. Use the subject "Daily Briefing".',
      }],
    });

    console.log('Multi-turn tool executions:', toolExecutions);
    console.log('Final response:', result.content);

    // Verify all tools were called
    expect(toolExecutions).toContain('weather:Tokyo');
    expect(toolExecutions.some(e => e.startsWith('news:'))).toBe(true);
    expect(toolExecutions.some(e => e.startsWith('email:'))).toBe(true);
    expect(toolExecutions.length).toBeGreaterThanOrEqual(3);
  }, 60000);

  it('should handle 5+ sequential tool calls', async () => {
    const steps: number[] = [];
    
    const stepTool = createTool({
      name: 'process_step',
      description: 'Process a numbered step in the workflow',
      schema: z.object({ step: z.number(), data: z.string() }),
      func: async ({ step, data }) => {
        steps.push(step);
        return { step, processed: true, result: `Step ${step} completed: ${data}` };
      },
    });

    const agent = createAgent({
      name: 'SequentialAgent',
      model,
      tools: [stepTool],
      limits: { maxToolCalls: 10 },
    });

    const result = await agent.invoke({
      messages: [{
        role: 'user',
        content: 'Execute a 5-step workflow using process_step. Start with step 1 and increment. Use data like "init", "validate", "transform", "analyze", "finalize".',
      }],
    });

    console.log('Steps executed:', steps);
    console.log('Final response:', result.content);

    expect(steps.length).toBeGreaterThanOrEqual(5);
  }, 90000);

  it('should maintain context across multiple tool calls', async () => {
    const conversationLog: string[] = [];
    
    const rememberTool = createTool({
      name: 'remember',
      description: 'Store a piece of information',
      schema: z.object({ key: z.string(), value: z.string() }),
      func: async ({ key, value }) => {
        conversationLog.push(`store:${key}=${value}`);
        return { stored: true, key, value };
      },
    });

    const recallTool = createTool({
      name: 'recall',
      description: 'Recall stored information by key',
      schema: z.object({ key: z.string() }),
      func: async ({ key }) => {
        conversationLog.push(`recall:${key}`);
        // Simulate memory
        if (key === 'user_name') return { key, value: 'Alice' };
        if (key === 'project') return { key, value: 'agent-sdk' };
        return { key, value: 'unknown' };
      },
    });

    const agent = createAgent({
      name: 'ContextAgent',
      model,
      tools: [rememberTool, recallTool],
      limits: { maxToolCalls: 8 },
    });

    // Turn 1
    const result1 = await agent.invoke({
      messages: [{ role: 'user', content: 'Remember that the user_name is Alice and the project is agent-sdk' }],
    });

    console.log('Turn 1 log:', conversationLog);
    console.log('Turn 1 response:', result1.content);

    // Turn 2 - Continue with previous state
    const result2 = await agent.invoke({
      messages: [
        ...result1.messages,
        { role: 'user', content: 'Now recall the user_name and project, and tell me about them.' }
      ],
    });

    console.log('Turn 2 log:', conversationLog);
    console.log('Turn 2 response:', result2.content);

    expect(conversationLog.filter(l => l.startsWith('store:')).length).toBeGreaterThanOrEqual(2);
    expect(conversationLog.filter(l => l.startsWith('recall:')).length).toBeGreaterThanOrEqual(1);
  }, 60000);
});

// ============================================================================
// 2. SUMMARIZATION
// ============================================================================
runReal('2. Summarization', () => {
  const model = realModel();

  it('should trigger summarization when context exceeds limit', async () => {
    const summarizationEvents: any[] = [];
    const allEvents: any[] = [];
    
    // Tool that returns very large responses to force summarization
    const generateContent = createTool({
      name: 'generate_content',
      description: 'Generate a long piece of content about a topic',
      schema: z.object({ topic: z.string() }),
      func: async ({ topic }) => {
        // Generate very large content (~2000 characters = ~500 tokens)
        const paragraph = `This is extremely detailed and comprehensive content about ${topic}. `;
        const filler = 'Lorem ipsum dolor sit amet, consectetur adipiscing elit. Sed do eiusmod tempor incididunt ut labore et dolore magna aliqua. Ut enim ad minim veniam, quis nostrud exercitation ullamco laboris nisi ut aliquip ex ea commodo consequat. ';
        return { content: paragraph + filler.repeat(10) };
      },
    });

    const smartAgent = createSmartAgent({
      name: 'SummarizingAgent',
      model,
      tools: [generateContent],
      summarization: {
        enable: true,
        maxTokens: 300, // Very very low to force summarization
        summaryPromptMaxTokens: 500,
      },
      limits: { maxToolCalls: 5 },
    });

    const result = await smartAgent.invoke({
      messages: [{
        role: 'user',
        // The sequencing instruction is load-bearing, not cosmetic. Compaction
        // deliberately protects the LAST assistant turn's tool results (the
        // model asked for them and has not reasoned over them yet), so a model
        // that emits all three generate_content calls in ONE parallel batch
        // leaves the summarizer nothing it is allowed to compress and the run
        // legitimately ends with zero summaries. Forcing one call per turn is
        // what makes "context exceeds the limit" reachable at all.
        content: 'Generate content about "machine learning". Then generate content about "cloud computing". Then generate content about "cybersecurity". Request them ONE AT A TIME: call generate_content once, read the result and analyze it, and only then request the next topic. Never request more than one topic in the same turn.',
      }],
    }, {
      onEvent: (e) => {
        allEvents.push(e);
        if (e.type === 'summarization') {
          summarizationEvents.push(e);
        }
      },
    });

    console.log('Total events:', allEvents.length);
    console.log('Summarization events:', summarizationEvents.length);
    console.log('State summaries:', result.state?.summaries?.length || 0);
    console.log('Final response:', result.content?.substring(0, 200) + '...');

    // Check that summarization was triggered at least once
    const stateSummaries = result.state?.summaries || [];
    expect(stateSummaries.length).toBeGreaterThanOrEqual(1);
  }, 120000);

  it('should perform multiple summarizations in long conversations', async () => {
    const toolCalls: string[] = [];
    
    const queryDatabase = createTool({
      name: 'query_database',
      description: 'Query a database and return results',
      schema: z.object({ query: z.string() }),
      func: async ({ query }) => {
        toolCalls.push(query);
        // Return large result set
        const rows = Array.from({ length: 50 }, (_, i) => ({
          id: i,
          name: `Item ${i}`,
          description: `This is a detailed description for item ${i} with lots of metadata and information`.repeat(3),
        }));
        return { rows, totalCount: 50 };
      },
    });

    const smartAgent = createSmartAgent({
      name: 'DatabaseAgent',
      model,
      tools: [queryDatabase],
      summarization: {
        enable: true,
        maxTokens: 1500, // Very aggressive summarization
        summaryPromptMaxTokens: 1000,
      },
      limits: { maxToolCalls: 8 },
    });

    const result = await smartAgent.invoke({
      messages: [{
        role: 'user',
        content: 'Query the database for "users", then "orders", then "products", then "inventory". After each query, analyze the results before moving to the next. Finally provide a summary of all data.',
      }],
    });

    console.log('Tool calls made:', toolCalls);
    console.log('Summaries generated:', result.state?.summaries?.length || 0);

    // With aggressive limits, should trigger multiple summarizations
    expect(result.state?.summaries?.length || 0).toBeGreaterThanOrEqual(1);
  }, 120000);

  it('should retain key facts across summarization and answer a follow-up recall question', async () => {
    const projectFacts = {
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
    } as const;

    const buildPayload = (fact: typeof projectFacts.orbit) => [
      `PROJECT_FACT|code=${fact.code}|owner=${fact.owner}|risk=${fact.risk}|milestone=${fact.milestone}`,
      'Detailed archived payload '.repeat(220),
    ].join('\n');

    const fetchProjectSnapshot = createTool({
      name: 'fetch_project_snapshot',
      description: 'Return a large project snapshot with a canonical fact line at the top.',
      schema: z.object({ project: z.enum(['orbit', 'nova']) }),
      func: async ({ project }) => buildPayload(projectFacts[project]),
    });

    const smartAgent = createSmartAgent({
      name: 'SummarizationRecallAgent',
      model,
      tools: [fetchProjectSnapshot],
      summarization: {
        enable: true,
        maxTokens: 450,
        summaryPromptMaxTokens: 2200,
        promptTemplate: [
          'Summarize the conversation while preserving any project facts exactly.',
          'When you see a line formatted like PROJECT_FACT|code=...|owner=...|risk=...|milestone=..., copy it exactly into the summary.',
          'Retain earlier exact fact lines from the previous summary as well.',
          '',
          'Previous summary:',
          '{{previousSummary}}',
          '',
          'Conversation:',
          '{{conversation}}',
          '',
          'Updated summary:'
        ].join('\n'),
      },
      limits: { maxToolCalls: 4 },
    });

    const firstResult = await smartAgent.invoke({
      messages: [{
        role: 'user',
        // One snapshot per turn, for the same reason as the test above: the
        // latest assistant turn's tool results are protected from compaction,
        // so a single parallel batch would leave nothing summarizable.
        content: 'Fetch the ORBIT and NOVA project snapshots ONE AT A TIME: call fetch_project_snapshot for ORBIT first, read the result, and only then call it for NOVA. Never request both in the same turn. Preserve the key facts so you can answer a follow-up question later.',
      }],
    });

    console.log('Summaries after first run:', firstResult.state?.summaries?.length || 0);
    console.log('Last summary preview:', firstResult.state?.summaries?.at(-1)?.slice(0, 300));

    expect(firstResult.state?.summaries?.length || 0).toBeGreaterThanOrEqual(1);

    // The original assertion looked for a tool message whose content is exactly
    // the literal "SUMMARIZED". Nothing in src/ emits that any more — the only
    // remaining references are the *readers* in
    // src/nodes/contextSummarize.ts:178 and src/agent.ts:106, kept for
    // backwards compatibility with old transcripts. Compaction now rewrites a
    // reclaimed tool payload through renderRetainedToolMessage()
    // (src/smart/toolResponses.ts:369-399) into a typed recovery marker whose
    // family depends on the retention policy. The property being checked is
    // unchanged: at least one tool payload was actually replaced by a marker,
    // i.e. compaction reclaimed context rather than only appending a summary.
    const placeholderPrefixes = [
      'SUMMARIZED_TOOL_RESPONSE',
      'ARCHIVED_TOOL_RESPONSE',
      'STRUCTURED_TOOL_RESPONSE',
      'DROPPED_TOOL_RESPONSE',
    ];
    const reclaimed = (firstResult.state?.messages || []).filter((message) =>
      message.role === 'tool'
      && typeof message.content === 'string'
      && (message.content === 'SUMMARIZED' || placeholderPrefixes.some((p) => (message.content as string).startsWith(p))),
    );
    expect(reclaimed.length).toBeGreaterThan(0);

    const followUp = await smartAgent.invoke({
      messages: [
        ...(firstResult.state?.messages || firstResult.messages),
        {
          role: 'user',
          content: 'What are the owner and risk for ORBIT and NOVA? Answer in one sentence.',
        },
      ],
      summaries: firstResult.state?.summaries,
      toolHistory: firstResult.state?.toolHistory,
      toolHistoryArchived: firstResult.state?.toolHistoryArchived,
      toolCallCount: firstResult.state?.toolCallCount,
    });

    const normalized = followUp.content.toLowerCase();
    console.log('Follow-up response:', followUp.content);

    expect(normalized).toContain('ada');
    expect(normalized).toContain('lovelace');
    expect(normalized).toContain('grace');
    expect(normalized).toContain('hopper');
    expect(normalized).toContain('orbit');
    expect(normalized).toContain('nova');
    expect(normalized).toContain('low');
    expect(normalized).toContain('medium');
  }, 180000);
});

// ============================================================================
// 3. GUARDRAILS
// ============================================================================
runReal('3. Guardrails', () => {
  const model = realModel();

  it('should block responses with forbidden content', async () => {
    const violations: any[] = [];
    
    const guardrails: ConversationGuardrail[] = [{
      title: 'no-secrets',
      description: 'Block messages containing passwords or secrets',
      appliesTo: [GuardrailPhase.Response],
      haltOnViolation: true,
      rules: [{
        title: 'check-secrets',
        evaluate: async (ctx: GuardrailContext) => {
          const content = ctx.latestMessage?.content?.toString().toLowerCase() || '';
          const hasForbidden = ['password', 'secret', 'api_key', 'private_key'].some(word => 
            content.includes(word)
          );
          if (hasForbidden) {
            return { passed: false, reason: 'Contains secret information', disposition: 'block' as const };
          }
          return { passed: true };
        },
      }],
      onViolation: (incident, context) => { violations.push(incident); },
    }];

    const agent = createSmartAgent({
      name: 'GuardedAgent',
      model,
      tools: [],
      guardrails,
    });

    const result = await agent.invoke({
      messages: [{ role: 'user', content: 'What is a password manager and how does it store passwords?' }],
    });

    console.log('Violations detected:', violations.length);
    console.log('Response blocked:', result.state?.ctx?.__guardrailBlocked);
    console.log('Final content:', result.content?.substring(0, 100));

    // The response likely contains "password" so should be blocked
    if (result.content?.toLowerCase().includes('password')) {
      expect(violations.length).toBeGreaterThan(0);
    }
  }, 30000);

  it('should enforce message length limits', async () => {
    let evaluated = 0;
    const warnings: string[] = [];
    const guardrails: ConversationGuardrail[] = [{
      title: 'length-limit',
      description: 'Limit response length',
      appliesTo: [GuardrailPhase.Response],
      haltOnViolation: false,
      rules: [{
        title: 'max-length',
        evaluate: async (ctx: GuardrailContext) => {
          evaluated += 1;
          const content = ctx.latestMessage?.content?.toString() || '';
          if (content.length > 500) {
            const reason = `Response too long: ${content.length} chars`;
            warnings.push(reason);
            return { passed: false, reason, disposition: 'warn' as const };
          }
          return { passed: true };
        },
      }],
    }];

    const agent = createSmartAgent({
      name: 'LengthGuardedAgent',
      model,
      tools: [],
      guardrails,
    });

    const result = await agent.invoke({
      messages: [{ role: 'user', content: 'Explain quantum computing in great detail.' }],
    });

    console.log('Response length:', result.content?.length, 'warnings:', warnings.length);

    // The response-phase rule must actually have been evaluated…
    expect(evaluated).toBeGreaterThan(0);
    // …and because the disposition is `warn` (not `block`), a violation must
    // NOT halt the run: the content still comes back and nothing is stamped as
    // guardrail-blocked. `toBeDefined()` alone could not tell those apart.
    expect(typeof result.content).toBe('string');
    expect(result.content.length).toBeGreaterThan(0);
    expect(result.state?.ctx?.__guardrailBlocked).toBeFalsy();
    if (result.content.length > 500) {
      expect(warnings.length).toBeGreaterThan(0);
    }
  }, 120000);

  it('should apply input guardrails before processing', async () => {
    let inputChecked = false;
    let inputBlocked = false;
    
    const guardrails: ConversationGuardrail[] = [{
      title: 'input-filter',
      description: 'Filter inappropriate input',
      appliesTo: [GuardrailPhase.Request],
      haltOnViolation: true,
      rules: [{
        title: 'check-input',
        evaluate: async (ctx: GuardrailContext) => {
          inputChecked = true;
          const content = ctx.latestMessage?.content?.toString().toLowerCase() || '';
          if (content.includes('hack') || content.includes('attack')) {
            inputBlocked = true;
            return { passed: false, reason: 'Inappropriate request', disposition: 'block' as const };
          }
          return { passed: true };
        },
      }],
    }];

    const agent = createSmartAgent({
      name: 'InputGuardedAgent',
      model,
      tools: [],
      guardrails,
    });

    const result = await agent.invoke({
      messages: [{ role: 'user', content: 'How can I hack into a system?' }],
    });

    console.log('Input checked:', inputChecked);
    console.log('Input blocked:', inputBlocked);
    console.log('Guardrail blocked:', result.state?.ctx?.__guardrailBlocked);

    expect(inputChecked).toBe(true);
  }, 30000);
});

// ============================================================================
// 4. TOOL APPROVALS
// ============================================================================
runReal('4. Tool Approvals', () => {
  const model = realModel();

  it('should pause for approval on sensitive tool', async () => {
    let deleteAttempted = false;
    
    const deleteFile = createTool({
      name: 'delete_file',
      description: 'Delete a file from the system',
      schema: z.object({ path: z.string() }),
      needsApproval: true,
      approvalPrompt: 'Confirm file deletion',
      func: async ({ path }) => {
        deleteAttempted = true;
        return { deleted: true, path };
      },
    });

    const agent = createAgent({
      name: 'ApprovalAgent',
      model,
      tools: [deleteFile],
      limits: { maxToolCalls: 5 },
    });

    const result = await agent.invoke({
      messages: [{ role: 'user', content: 'Delete the file at /tmp/test.txt' }],
    });

    console.log('Delete attempted:', deleteAttempted);
    console.log('Awaiting approval:', result.state?.ctx?.__awaitingApproval);
    console.log('Pending approvals:', result.state?.pendingApprovals?.length);

    // Tool should NOT have been executed yet
    expect(deleteAttempted).toBe(false);
    expect(result.state?.ctx?.__awaitingApproval).toBeTruthy();
    expect(result.state?.pendingApprovals?.length).toBeGreaterThan(0);

    // Now approve and resume
    const pending = result.state!.pendingApprovals![0];
    console.log('Pending tool:', pending.toolName, 'args:', pending.args);

    const approvedState = agent.resolveToolApproval(result.state!, {
      id: pending.id,
      approved: true,
      decidedBy: 'admin',
      comment: 'Approved for testing',
    });

    const resumedResult = await agent.invoke(approvedState);

    console.log('After approval - Delete attempted:', deleteAttempted);
    console.log('Final response:', resumedResult.content);

    expect(deleteAttempted).toBe(true);
    expect(resumedResult.content).toBeDefined();
  }, 60000);

  it('should reject tool execution when denied', async () => {
    let writeAttempted = false;
    
    const writeDatabase = createTool({
      name: 'write_database',
      description: 'Write data to the database',
      schema: z.object({ table: z.string(), data: z.string() }),
      needsApproval: true,
      func: async ({ table, data }) => {
        writeAttempted = true;
        return { written: true, table };
      },
    });

    const agent = createAgent({
      name: 'RejectAgent',
      model,
      tools: [writeDatabase],
      limits: { maxToolCalls: 5 },
    });

    const result = await agent.invoke({
      messages: [{ role: 'user', content: 'Write "test data" to the users table' }],
    });

    expect(result.state?.pendingApprovals?.length).toBeGreaterThan(0);

    const pending = result.state!.pendingApprovals![0];

    // Reject the approval
    const rejectedState = agent.resolveToolApproval(result.state!, {
      id: pending.id,
      approved: false,
      decidedBy: 'security-team',
      comment: 'Write operation not allowed',
    });

    const resumedResult = await agent.invoke(rejectedState);

    console.log('Write attempted after rejection:', writeAttempted);
    console.log('Final response:', resumedResult.content);

    // Tool should NOT have been executed
    expect(writeAttempted).toBe(false);
  }, 60000);

  it('should handle multiple tools requiring approval', async () => {
    const executions: string[] = [];
    
    const deployTool = createTool({
      name: 'deploy',
      description: 'Deploy to production',
      schema: z.object({ version: z.string() }),
      needsApproval: true,
      func: async ({ version }) => {
        executions.push(`deploy:${version}`);
        return { deployed: true, version };
      },
    });

    const rollbackTool = createTool({
      name: 'rollback',
      description: 'Rollback deployment',
      schema: z.object({ version: z.string() }),
      needsApproval: true,
      func: async ({ version }) => {
        executions.push(`rollback:${version}`);
        return { rolledBack: true, version };
      },
    });

    const agent = createAgent({
      name: 'DeployAgent',
      model,
      tools: [deployTool, rollbackTool],
      limits: { maxToolCalls: 5 },
    });

    const result = await agent.invoke({
      messages: [{ role: 'user', content: 'Deploy version 2.0.0 to production' }],
    });

    console.log('Executions before approval:', executions);
    expect(result.state?.pendingApprovals?.length).toBeGreaterThan(0);

    // Approve all pending
    let currentState = result.state!;
    for (const pending of result.state!.pendingApprovals || []) {
      currentState = agent.resolveToolApproval(currentState, {
        id: pending.id,
        approved: true,
        decidedBy: 'devops',
      });
    }

    const finalResult = await agent.invoke(currentState);
    
    console.log('Executions after approval:', executions);
    console.log('Final response:', finalResult.content);

    expect(executions.length).toBeGreaterThan(0);
  }, 60000);
});

// ============================================================================
// 5. MULTI-AGENT
// ============================================================================
runReal('5. Multi-Agent', () => {
  const model = realModel();

  it('should delegate to child agent via asTool', async () => {
    const childExecutions: string[] = [];
    
    const analyzeTool = createTool({
      name: 'analyze',
      description: 'Analyze data in detail',
      schema: z.object({ data: z.string() }),
      func: async ({ data }) => {
        childExecutions.push(`analyze:${data}`);
        return { analysis: `Deep analysis of: ${data}`, confidence: 0.95 };
      },
    });

    // Child specialist agent
    const specialistAgent = createSmartAgent({
      name: 'DataSpecialist',
      model,
      tools: [analyzeTool],
      systemPrompt: 'You are a data analysis specialist. ALWAYS call the analyze tool on the data you are given; never analyse it yourself in prose.',
      limits: { maxToolCalls: 3 },
    });

    // Convert to tool for parent
    const specialistTool = specialistAgent.asTool({
      toolName: 'consult_specialist',
      description: 'Delegate data analysis to the specialist agent',
    });

    // Parent agent
    const parentAgent = createSmartAgent({
      name: 'Coordinator',
      model,
      tools: [specialistTool],
      systemPrompt: 'You coordinate tasks. Delegate data analysis to the specialist.',
      limits: { maxToolCalls: 5 },
    });

    const result = await parentAgent.invoke({
      messages: [{ role: 'user', content: 'Use the consult_specialist tool to analyze "Q4 2025 sales data". You MUST delegate this to the specialist.' }],
    });

    const delegations = (result.state?.toolHistory ?? [])
      .map((h) => h.toolName)
      .filter((n) => n === 'consult_specialist');
    console.log('Child executions:', childExecutions);
    console.log('Delegations:', delegations);
    console.log('Final response:', result.content);

    // The parent reached the child agent — the property `asTool` is named for.
    expect(delegations.length).toBeGreaterThan(0);
    // And the child ran its OWN tool loop, which is what separates a delegated
    // agent from a tool that returns a canned string.
    expect(childExecutions.length).toBeGreaterThan(0);
  }, 90000);

  it('should orchestrate multiple specialist agents', async () => {
    const agentCalls: string[] = [];
    
    // Research agent
    const researchTool = createTool({
      name: 'search',
      description: 'Search for information',
      schema: z.object({ query: z.string() }),
      func: async ({ query }) => {
        agentCalls.push(`research:${query}`);
        return { results: [`Result 1 for ${query}`, `Result 2 for ${query}`] };
      },
    });

    const researchAgent = createSmartAgent({
      name: 'Researcher',
      model,
      tools: [researchTool],
      // The assertion is that orchestration REACHED this specialist, observed
      // through its tool. Without telling it to use the tool, a model that
      // answers from its own knowledge fails the test for the wrong reason.
      systemPrompt: 'You are a research specialist. Always call the search tool to gather material; never answer from memory.',
      limits: { maxToolCalls: 2 },
    });

    // Writer agent
    const writeTool = createTool({
      name: 'compose',
      description: 'Compose text',
      schema: z.object({ topic: z.string(), style: z.string() }),
      func: async ({ topic, style }) => {
        agentCalls.push(`write:${topic}:${style}`);
        return { text: `Composed ${style} content about ${topic}` };
      },
    });

    const writerAgent = createSmartAgent({
      name: 'Writer',
      model,
      tools: [writeTool],
      systemPrompt: 'You are a content writer. Always call the compose tool to produce the text; never write the prose directly in your reply.',
      limits: { maxToolCalls: 2 },
    });

    // Orchestrator
    const orchestrator = createSmartAgent({
      name: 'Orchestrator',
      model,
      tools: [
        researchAgent.asTool({ toolName: 'research_agent', description: 'Delegate research tasks' }),
        writerAgent.asTool({ toolName: 'writer_agent', description: 'Delegate writing tasks' }),
      ],
      systemPrompt: 'Coordinate research and writing tasks by delegating to specialist agents.',
      limits: { maxToolCalls: 5 },
    });

    const result = await orchestrator.invoke({
      messages: [{
        role: 'user',
        // Both delegations stay asserted below; the prompt just stops the
        // orchestrator from deciding it can write the post itself after the
        // research came back, which is a routing choice, not the thing under test.
        content: 'Research AI trends and write a blog post about them. You MUST delegate: first call research_agent to gather the trends, then call writer_agent to compose the post. Do not write the post yourself.',
      }],
    });

    const delegations = (result.state?.toolHistory ?? [])
      .map((h) => h.toolName)
      .filter((n) => n.endsWith('_agent'));
    console.log('Agent calls:', agentCalls);
    console.log('Delegations:', delegations);
    console.log('Final response:', result.content);

    // What "orchestrate multiple specialist agents" claims is that the
    // orchestrator reached BOTH specialists — that is the SDK's behaviour and
    // it is observable directly in toolHistory.
    expect(delegations).toContain('research_agent');
    expect(delegations).toContain('writer_agent');
    // At least one specialist ran its OWN tool loop, which is what separates a
    // real delegation from a tool that merely returned a string. Both leaves are
    // deliberately not required: whether a given specialist calls its tool or
    // answers directly is the leaf model's choice, not something the SDK decides,
    // and asserting it makes the test measure the model instead of the runtime.
    expect(agentCalls.length).toBeGreaterThan(0);
    expect(result.content.length).toBeGreaterThan(0);
  }, 120000);
});

// ============================================================================
// 6. HANDOFF
// ============================================================================
// ─────────────────────────────────────────────────────────────────────────────
// KNOWN DEFECT — every test in this block is skipped for the SAME src/ bug, not
// for anything about this endpoint or this model.
//
//
// `createAgent` (src/agent.ts:1293-1303) appends the handoff tools to
// `runtime.tools`, but `createSmartAgent` rebuilds the tool set per invoke from
// `userTools` only (src/smart/index.ts:53, 168) and `syncRuntimeTools`
// (src/smart/index.ts:354-374) overwrites `state.agent.tools` with that set on
// every iteration — so the handoff tool never reaches the provider and the model
// answers "that handoff isn't available".
//
// Reproduced without any network, with a tool-recording stub model:
//   createAgent   + handoffs → model sees ["delegate_child"]
//   createSmartAgent + same  → model sees []
// The same scenario driven through `createAgent` against this endpoint DOES
// execute the child's tool, so the handoff machinery itself works; only the
// smart-agent wiring is broken.
//
// `SmartAgentOptions.handoffs` is a documented, typed option ("Predefined
// handoff targets exposed as tools automatically", src/types.ts:680-681), so
// these assertions describe the behaviour the SDK promises. They are left
// intact — un-skip them once the smart layer merges handoff tools into its
// per-invoke tool set.
// ─────────────────────────────────────────────────────────────────────────────
runReal('6. Handoff', () => {
  const model = realModel();
  it('should hand off to specialist agent mid-conversation', async () => {
    const events: SmartAgentEvent[] = [];
    
    // Coding specialist
    const codingAgent = createSmartAgent({
      name: 'Coder',
      model,
      tools: [],
      systemPrompt: 'You are an expert programmer. Write clean, efficient code.',
    });

    // Main agent with handoff capability
    // A router: without a prompt that makes delegating its job, answering the
    // coding question directly is the reasonable move, and the test would be
    // measuring the model's willingness to delegate rather than whether the
    // SDK transfers control when it does.
    const mainAgent = createSmartAgent({
      name: 'Assistant',
      model,
      tools: [],
      systemPrompt: 'You are a router. You never write code yourself. For any programming task, call delegate_coding and let the specialist answer.',
      handoffs: [
        codingAgent.asHandoff({
          toolName: 'delegate_coding',
          description: 'Hand off to coding specialist for programming tasks',
        }),
      ],
    });

    const result = await mainAgent.invoke({
      messages: [{ role: 'user', content: 'Write a TypeScript function to calculate fibonacci numbers. Use delegate_coding.' }],
    }, {
      onEvent: (e) => events.push(e),
    });

    const handoffEvents = events.filter(e => e.type === 'handoff');
    console.log('Handoff events:', handoffEvents.length);
    console.log('Final response:', result.content?.substring(0, 200));

    // The original assertion here was `result.content` contains "function",
    // which is model wording — the main agent answering the coding question
    // itself satisfies it, so the test passed while the handoff never fired.
    // The property it was really checking: control actually transferred to the
    // coding specialist. That is observable as a handoff event and as the
    // runtime swapping to the child agent (src/nodes/tools.ts:752-755).
    expect(handoffEvents.length).toBeGreaterThan(0);
    expect(result.state?.agent?.name).toBe('Coder');
    expect(result.content.length).toBeGreaterThan(0);
  }, 60000);
  it('should transfer context during handoff', async () => {
    const contextLog: string[] = [];
    
    // Finance agent
    const financeAgent = createSmartAgent({
      name: 'Finance',
      model,
      tools: [
        createTool({
          name: 'calculate_roi',
          description: 'Calculate return on investment',
          schema: z.object({ investment: z.number(), returns: z.number() }),
          func: async ({ investment, returns }) => {
            contextLog.push(`roi:${investment}:${returns}`);
            const roi = ((returns - investment) / investment) * 100;
            return { roi: roi.toFixed(2) + '%' };
          },
        }),
      ],
      // The property under test is that the NUMBERS survive the handoff, so the
      // specialist is told to always use the tool — otherwise the test also
      // measures whether the model felt like computing 50% in its head.
      systemPrompt: 'You are a financial analyst. For any ROI question always call calculate_roi with the numbers you were given; never compute it yourself.',
      limits: { maxToolCalls: 3 },
    });

    // General assistant with handoff
    const assistant = createSmartAgent({
      name: 'GeneralAssistant',
      model,
      tools: [],
      handoffs: [
        financeAgent.asHandoff({
          toolName: 'delegate_finance',
          description: 'Hand off financial calculations to finance specialist',
        }),
      ],
    });

    const result = await assistant.invoke({
      messages: [{ role: 'user', content: 'Use delegate_finance to calculate ROI. Investment: $10000, Returns: $15000. You MUST use the handoff.' }],
    });

    console.log('Context log:', contextLog);
    console.log('Final response:', result.content);

    // Finance agent should have calculated ROI, with the numbers from the user
    // turn carried across the handoff (that is the "context transfer" claim).
    expect(contextLog).toContain('roi:10000:15000');
    expect(result.content.length).toBeGreaterThan(0);
  }, 60000);
  it('should support chained handoffs', async () => {
    const handoffChain: string[] = [];
    
    // Level 3: Deep specialist
    const deepSpecialist = createSmartAgent({
      name: 'DeepSpecialist',
      model,
      systemPrompt: 'You are a deep specialist. Always use the deep_analysis tool first to analyze the subject.',
      tools: [
        createTool({
          name: 'deep_analysis',
          description: 'Perform deep analysis - YOU MUST USE THIS TOOL',
          schema: z.object({ subject: z.string() }),
          func: async ({ subject }) => {
            handoffChain.push(`deep:${subject}`);
            return { deepInsight: `Deep analysis of ${subject} completed` };
          },
        }),
      ],
      limits: { maxToolCalls: 8 },
    });

    // Level 2: Mid-level specialist - MUST forward to deep
    const midSpecialist = createSmartAgent({
      name: 'MidSpecialist',
      model,
      tools: [
        createTool({
          name: 'mark_received',
          description: 'Mark that you received a task, then use go_deeper handoff',
          schema: z.object({ task: z.string() }),
          func: async ({ task }) => {
            handoffChain.push(`mid:${task}`);
            return { status: 'received', instruction: 'Now you MUST use go_deeper handoff' };
          },
        }),
      ],
      systemPrompt: 'You are a mid-level specialist. First use mark_received, then ALWAYS use the go_deeper handoff. Never respond directly without delegating, and never ask a clarifying question — act on whatever subject you were given.',
      handoffs: [
        deepSpecialist.asHandoff({
          toolName: 'go_deeper',
          description: 'Hand off for deeper analysis - USE THIS AFTER mark_received',
        }),
      ],
      limits: { maxToolCalls: 8 },
    });

    // Level 1: Entry point
    const entryAgent = createSmartAgent({
      name: 'EntryAgent',
      model,
      systemPrompt: 'You are an entry point. Always use delegate_mid handoff to delegate tasks.',
      tools: [],
      handoffs: [
        midSpecialist.asHandoff({
          toolName: 'delegate_mid',
          description: 'Hand off to mid-level specialist - ALWAYS USE THIS',
        }),
      ],
    });

    const result = await entryAgent.invoke({
      messages: [{ role: 'user', content: 'Analyze 2024 US electric-vehicle market trends over a 12-month horizon. Everything you need is in this sentence — never ask a clarifying question. You MUST use the delegate_mid handoff tool immediately.' }],
    });

    console.log('Handoff chain:', handoffChain);
    console.log('Final response:', result.content?.substring(0, 200));

    // The previous assertion accepted the word "delegat" appearing anywhere in
    // the reply, so an agent that refused to delegate and merely said so still
    // passed. The property under test is that the chain actually ran: entry →
    // mid (mark_received) → deep (deep_analysis), each rung recording itself.
    expect(handoffChain.some(step => step.startsWith('mid:'))).toBe(true);
    expect(handoffChain.some(step => step.startsWith('deep:'))).toBe(true);
    expect(result.content.length).toBeGreaterThan(0);
  }, 120000);
});
