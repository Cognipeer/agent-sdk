import { SmartState, SmartAgentOptions } from "../types.js";
import { countApproxTokens } from "../utils/utilTokens.js";

/** Shared helper to compute whether we exceed token limit */
function needsSummarization(state: SmartState, opts: SmartAgentOptions, summarizationEnabled: boolean): boolean {
  if (!summarizationEnabled) {
    return false;
  }

  // Determine the effective max tokens for summarization
  // Order of precedence:
  // 1. opts.summarization.maxTokens (if strictly defined)
  // 2. Default: 50000
  let maxTok: number | undefined;

  if (typeof opts.summarization === 'object' && typeof opts.summarization.maxTokens === 'number') {
    maxTok = opts.summarization.maxTokens;
  }
  
  // Default to 50000 if no limit specified but summarization is enabled
  if (maxTok === undefined) {
    maxTok = 50000;
  }

  try {
    const allText = (state.messages || [])
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
    const needsSum = tokenCount > maxTok;
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
      console.log(`[Summarization] Token count: ${tokenCount}, Max: ${maxTok}, Needs summarization: ${needsSum}`);
    }
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
