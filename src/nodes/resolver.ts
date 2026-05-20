import type { SmartState } from "../types.js";

// Ensures required state fields exist and normalizes incoming messages
export function createResolverNode() {
  return async (state: SmartState): Promise<SmartState> => {
    const messages = Array.isArray(state.messages) ? state.messages : [];
    return {
      ...state,
      messages,
      summaries: state.summaries || [],
      toolCallCount: state.toolCallCount || 0,
      toolCache: state.toolCache || {},
  toolHistory: state.toolHistory || [],
  toolHistoryArchived: state.toolHistoryArchived || [],
      pendingApprovals: state.pendingApprovals || [],
      pendingUserQuestions: state.pendingUserQuestions || [],
      plan: state.plan || null,
      planVersion: state.planVersion || 0,
    } as SmartState;
  };
}
