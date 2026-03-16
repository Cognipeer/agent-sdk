import { SmartState, SmartAgentOptions } from "../types.js";
import { countApproxTokens } from "../utils/utilTokens.js";
import { getResolvedSmartConfig } from "../smart/runtimeConfig.js";

function isSyntheticSummaryMessage(message: any): boolean {
  if (!message) return false;
  if (message.role === 'tool' && message.name === 'summarize_context') {
    return true;
  }

  if (message.role === 'assistant' && Array.isArray(message.tool_calls)) {
    return message.tool_calls.some((toolCall: any) => {
      const toolName = toolCall?.function?.name || toolCall?.name;
      return toolName === 'summarize_context';
    });
  }

  return false;
}

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
    const allText = (state.messages || [])
      .filter((message: any) => !isSyntheticSummaryMessage(message))
      .map((m: any) => {
        if (typeof m.content === "string") return m.content;
        if (Array.isArray(m.content)) {
          return m.content.map((c: any) => (typeof c === 'string' ? c : c?.text ?? c?.content ?? JSON.stringify(c))).join('');
        }
        // Handle object content (e.g., tool results)
        if (m.content && typeof m.content === 'object') {
          return JSON.stringify(m.content);
        }
        return '';
      })
      .join("\n");
    const tokenCount = countApproxTokens(allText);
    const contextRotScore = state.watchdog?.contextRotScore || 0;
    const needsSum = tokenCount > maxTok || (
      resolved.watchdog.enabled
      && resolved.watchdog.autoCompaction
      && contextRotScore >= resolved.watchdog.contextRotThreshold
    );
    // Debug log for development - can be removed in production
    if (process.env.DEBUG_SUMMARIZATION) {
      const msgCount = (state.messages || []).length;
      const toolMsgs = (state.messages || []).filter((m: any) => m.role === 'tool');
      const toolDetails = toolMsgs.map((m: any, i: number) => {
        const contentStr = typeof m.content === 'string' ? m.content : JSON.stringify(m.content);
        return `[${i}] id:${m.tool_call_id?.slice(-8) || 'none'} len:${contentStr.length} preview:"${contentStr.slice(0, 30)}..."`;
      });
      console.log(`[Summarization] Messages: ${msgCount}, Tool messages: ${toolMsgs.length}`);
      toolDetails.forEach(d => console.log(`  ${d}`));
      console.log(`[Summarization] Token count: ${tokenCount}, Max: ${maxTok}, Context rot: ${contextRotScore}, Needs summarization: ${needsSum}`);
    }
    return needsSum;
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

export function finalizeDecisionFactory(opts: SmartAgentOptions, summarizationEnabled: boolean) {
  return function finalizeDecision(state: SmartState) {
    return needsSummarization(state, opts, summarizationEnabled) ? "contextSummarize" : "agent";
  };
}
