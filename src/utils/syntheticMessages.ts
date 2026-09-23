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

/**
 * True for a tool result the summarizer replaced with a placeholder (its
 * content now lives in the summary and in the archived tool history).
 * Shared by the summarizer and the `summary_only` context view.
 */
export function isCompactedToolContent(content: unknown): boolean {
  return typeof content === 'string'
    && (
      content === 'SUMMARIZED'
      || content.startsWith('SUMMARIZED_TOOL_RESPONSE')
      || content.startsWith('ARCHIVED_TOOL_RESPONSE')
      || content.startsWith('STRUCTURED_TOOL_RESPONSE')
      || content.startsWith('DROPPED_TOOL_RESPONSE')
    );
}
