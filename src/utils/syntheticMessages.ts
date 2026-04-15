/**
 * Detects synthetic summarization messages injected by the contextSummarize node.
 * Shared across agent.ts, decisions.ts, and contextSummarize.ts to avoid duplication.
 */
export function isSyntheticSummaryMessage(message: any): boolean {
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
