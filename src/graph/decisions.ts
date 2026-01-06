import { SmartState, SmartAgentOptions } from "../types.js";
import { countApproxTokens } from "../utils/utilTokens.js";

/** Shared helper to compute whether we exceed token limit */
function needsSummarization(state: SmartState, opts: SmartAgentOptions, summarizationEnabled: boolean): boolean {
  // Check both maxToken and contextTokenLimit for backward compatibility
  const maxTok = opts.limits?.maxToken ?? opts.limits?.contextTokenLimit;
  if (!maxTok || !summarizationEnabled) {
    return false;
  }
  try {
    const allText = (state.messages || [])
      .map((m: any) => typeof m.content === "string" ? m.content : Array.isArray(m.content) ? m.content.map((c: any) => (typeof c === 'string' ? c : c?.text ?? c?.content ?? '')).join('') : '')
      .join("\n");
    const tokenCount = countApproxTokens(allText);
    const needsSum = tokenCount > maxTok;
    return needsSum;
  } catch (e) {
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

export function finalizeDecisionFactory(opts: SmartAgentOptions, summarizationEnabled: boolean) {
  return function finalizeDecision(state: SmartState) {
    return needsSummarization(state, opts, summarizationEnabled) ? "contextSummarize" : "agent";
  };
}
