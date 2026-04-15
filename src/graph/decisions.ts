import { SmartState, SmartAgentOptions } from "../types.js";
import { countMessagesTokens } from "../utils/utilTokens.js";
import { isSyntheticSummaryMessage } from "../utils/syntheticMessages.js";
import { getResolvedSmartConfig } from "../smart/runtimeConfig.js";

/** Shared helper to compute whether we exceed token limit */
function needsSummarization(state: SmartState, opts: SmartAgentOptions, summarizationEnabled: boolean): boolean {
  if (!summarizationEnabled) {
    return false;
  }

  if ((state.ctx as any)?.__needsSummarization) {
    return true;
  }

  const resolved = getResolvedSmartConfig(opts, state.agent as any);
  if (!resolved.summarization.enable) {
    return false;
  }

  const maxTok = resolved.summarization.summaryTriggerTokens;

  try {
    const filtered = (state.messages || []).filter((message: any) => !isSyntheticSummaryMessage(message));
    const tokenCount = countMessagesTokens(filtered);
    return tokenCount > maxTok;
  } catch {
    return false;
  }
}

export function resolverDecisionFactory(opts: SmartAgentOptions, summarizationEnabled: boolean) {
  return function resolverDecision(state: SmartState) {
    return needsSummarization(state, opts, summarizationEnabled) ? "contextSummarize" : "agent";
  };
}

export function toolsDecisionFactory(opts: SmartAgentOptions, summarizationEnabled: boolean) {
  return function toolsDecision(state: SmartState) {
    const max = (opts.limits?.maxToolCalls ?? 10) as number;
    const count = state.toolCallCount || 0;
    if (count >= max) return "toolLimitFinalize";
    return needsSummarization(state, opts, summarizationEnabled) ? "contextSummarize" : "agent";
  };
}