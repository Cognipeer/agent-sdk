import { countApproxTokens } from "./utilTokens.js";
import { Message } from "../types.js";

export type TokenLimits = {
  contextTokenLimit: number;
  summaryTokenLimit: number;
};

export async function applyTokenLimits({
  state,
  limits,
}: {
  state: { messages: Message[]; summaries?: string[] };
  limits: {
    contextTokenLimit: number;
    summaryTokenLimit: number;
  };
}) {
  const messages = state.messages || [];
  const budget = limits.contextTokenLimit;
  let total = messages.reduce((acc, m) => acc + countApproxTokens(String((m as any).content || "")), 0);
  if (total <= budget) return state;

  // Trim oldest non-system messages until we're under budget
  const newMessages: Message[] = [...messages];
  while (total > budget && newMessages.length > 1) {
    // Find the first non-system message to remove (preserve system messages)
    const idx = newMessages.findIndex(m => m.role !== 'system');
    if (idx === -1) break; // Only system messages left
    const removed = newMessages.splice(idx, 1)[0];
    total -= countApproxTokens(String((removed as any).content || ""));
  }

  return { ...state, messages: newMessages };
}
