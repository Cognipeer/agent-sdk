import type {
  EvalCase,
  EvalCaseResult,
  EvalHarnessMetrics,
  EvalProfileDescriptor,
  EvalProfileTarget,
  EvalHarnessResult,
  RuntimeProfile,
  SmartAgentEvent,
  SmartAgentInstance,
  SmartState,
} from "../types.js";

export type EvalHarnessParams = {
  profiles: EvalProfileTarget[];
  cases: EvalCase[];
  createAgent: (profile: RuntimeProfile, descriptor: EvalProfileDescriptor) => SmartAgentInstance<any>;
};

function normalizeProfileTarget(target: EvalProfileTarget): EvalProfileDescriptor {
  if (typeof target === "string") {
    return {
      label: target,
      runtimeProfile: target,
      baseProfile: target === "custom" ? "balanced" : target,
    };
  }
  return {
    label: target.label,
    runtimeProfile: target.runtimeProfile,
    baseProfile: target.baseProfile ?? (target.runtimeProfile === "custom" ? target.customProfile?.extends ?? "balanced" : target.runtimeProfile),
    customProfile: target.customProfile,
  };
}

function normalizeText(value: string | undefined): string {
  return (value || "").toLowerCase();
}

function ratio(numerator: number, denominator: number): number {
  if (denominator <= 0) return 1;
  return Number((numerator / denominator).toFixed(3));
}

function sum(values: number[]): number {
  return values.reduce((acc, value) => acc + value, 0);
}

function mean(values: number[]): number {
  if (values.length === 0) return 0;
  return Number((sum(values) / values.length).toFixed(3));
}

function extractTotalTokens(usage: any): number {
  if (!usage?.totals || typeof usage.totals !== "object") return 0;
  return Object.values(usage.totals).reduce((acc: number, entry: any) => acc + (Number(entry?.total) || 0), 0);
}

function caseResultFromRun(
  descriptor: EvalProfileDescriptor,
  testCase: EvalCase,
  content: string,
  events: SmartAgentEvent[],
  state: SmartState | undefined,
  latencyMs: number,
  totalTokens: number,
): EvalCaseResult {
  const normalizedContent = normalizeText(content);
  const matchedPhrases = (testCase.expectedPhrases || []).filter((phrase) => normalizedContent.includes(normalizeText(phrase)));
  const matchedFacts = (testCase.expectedFacts || []).filter((fact) => {
    const memoryMatch = state?.memoryFacts?.some((entry) => entry.key === fact.key && normalizeText(entry.value).includes(normalizeText(fact.value)));
    const summaryMatch = state?.summaryRecords?.some((record) => record.stable_facts.some((entry) => entry.key === fact.key && normalizeText(entry.value).includes(normalizeText(fact.value))));
    return Boolean(memoryMatch || summaryMatch || normalizedContent.includes(normalizeText(fact.value)));
  });
  const forbiddenMisses = (testCase.forbiddenPhrases || []).filter((phrase) => !normalizedContent.includes(normalizeText(phrase)));
  const toolCalls = events.filter((event) => event.type === "tool_call" && event.phase === "success") as Array<Extract<SmartAgentEvent, { type: "tool_call" }>>;
  const expectedToolHits = (testCase.expectedToolNames || []).filter((toolName) => toolCalls.some((event) => event.name === toolName));
  const toolPrecision = ratio(expectedToolHits.length, Math.max(toolCalls.length, 1));
  const recallAccuracy = ratio(matchedPhrases.length + matchedFacts.length, (testCase.expectedPhrases?.length || 0) + (testCase.expectedFacts?.length || 0));
  const obsoleteDropAccuracy = ratio(forbiddenMisses.length, testCase.forbiddenPhrases?.length || 0);
  const trajectoryScore = ratio(expectedToolHits.length, testCase.expectedToolNames?.length || 0);
  const hadRecoverableError = events.some((event) => event.type === "tool_call" && event.phase === "error");
  const recoveryRate = hadRecoverableError ? Number((normalizedContent.length > 0 ? 1 : 0).toFixed(3)) : 1;
  const overToolingRate = toolCalls.length === 0 ? 0 : Number((Math.max(0, toolCalls.length - Math.max(testCase.expectedToolNames?.length || 0, 1)) / toolCalls.length).toFixed(3));
  const success = recallAccuracy >= 0.8 && obsoleteDropAccuracy >= 0.8;

  return {
    id: testCase.id,
    family: testCase.family,
    success,
    recallAccuracy,
    obsoleteDropAccuracy,
    trajectoryScore: Number(((trajectoryScore + toolPrecision) / 2).toFixed(3)),
    recoveryRate,
    overToolingRate,
    latencyMs,
    totalTokens,
    profile: descriptor.runtimeProfile,
    profileLabel: descriptor.label,
    baseProfile: descriptor.baseProfile,
    notes: success ? [] : [
      recallAccuracy < 0.8 ? "Recall below threshold." : "",
      obsoleteDropAccuracy < 0.8 ? "Obsolete filtering below threshold." : "",
      trajectoryScore < 0.5 ? "Tool trajectory diverged from expectation." : "",
    ].filter(Boolean),
  };
}

function aggregateMetrics(caseResults: EvalCaseResult[]): EvalHarnessMetrics {
  const taskSuccess = ratio(caseResults.filter((result) => result.success).length, caseResults.length);
  const recallAccuracy = mean(caseResults.map((result) => result.recallAccuracy));
  const obsoleteDropAccuracy = mean(caseResults.map((result) => result.obsoleteDropAccuracy));
  const trajectoryScore = mean(caseResults.map((result) => result.trajectoryScore));
  const recoveryRate = mean(caseResults.map((result) => result.recoveryRate));
  const overToolingRate = mean(caseResults.map((result) => result.overToolingRate));
  const latencyMs = mean(caseResults.map((result) => result.latencyMs));
  const totalTokens = sum(caseResults.map((result) => result.totalTokens || 0));
  const toolPrecision = trajectoryScore;
  const costScore = totalTokens <= 0 ? 1 : Number((1 / (1 + totalTokens / 10000)).toFixed(3));
  const score = Number((
    (0.45 * taskSuccess)
    + (0.20 * trajectoryScore)
    + (0.15 * toolPrecision)
    + (0.10 * recoveryRate)
    + (0.10 * costScore)
  ).toFixed(3));

  return {
    taskSuccess,
    recallAccuracy,
    obsoleteDropAccuracy,
    trajectoryScore,
    recoveryRate,
    overToolingRate,
    latencyMs,
    totalTokens,
    score,
  };
}

export async function runSmartAgentEvalHarness(params: EvalHarnessParams): Promise<EvalHarnessResult[]> {
  const results: EvalHarnessResult[] = [];

  for (const profileTarget of params.profiles) {
    const descriptor = normalizeProfileTarget(profileTarget);
    const caseResults: EvalCaseResult[] = [];

    for (const testCase of params.cases) {
      const agent = params.createAgent(descriptor.runtimeProfile, descriptor);
      const events: SmartAgentEvent[] = [];
      const startedAt = Date.now();
      const result = await agent.invoke({
        messages: [{ role: "user", content: testCase.prompt }],
      } as SmartState, {
        onEvent: (event) => {
          events.push(event);
        },
      });

      caseResults.push(caseResultFromRun(
        descriptor,
        testCase,
        result.content,
        events,
        result.state,
        Date.now() - startedAt,
        extractTotalTokens(result.metadata?.usage),
      ));
    }

    results.push({
      profile: descriptor.runtimeProfile,
      profileLabel: descriptor.label,
      baseProfile: descriptor.baseProfile,
      metrics: aggregateMetrics(caseResults),
      cases: caseResults,
    });
  }

  return results;
}