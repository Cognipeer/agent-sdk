import type { BaseMessage, MemoryFact, ResolvedSmartAgentConfig, SmartState, StructuredSummary } from "../types.js";
import { countApproxTokens } from "../utils/utilTokens.js";

function messageText(message: BaseMessage): string {
  if (typeof message.content === "string") return message.content;
  if (Array.isArray(message.content)) {
    return message.content.map((part: any) => (typeof part === "string" ? part : part?.text ?? part?.content ?? JSON.stringify(part))).join(" ");
  }
  return "";
}

function collectRecentTurns(messages: BaseMessage[], lastTurnsToKeep: number): BaseMessage[] {
  if (lastTurnsToKeep <= 0) return [];
  const systemPrefix = messages.filter((message, index) => index === 0 && message.role === "system");
  const body = systemPrefix.length > 0 ? messages.slice(1) : [...messages];

  // Count total user turns to detect single-user-turn scenarios (e.g. worker agents).
  const totalUserTurns = body.filter((m) => m.role === "user").length;

  // When there are fewer user turns than lastTurnsToKeep (typical for worker agents
  // that start with a single user message and then loop assistant→tool cycles),
  // count assistant messages as interaction rounds instead. This prevents the hybrid
  // policy from keeping ALL messages and forcing clampToBudget to do destructive
  // truncation that breaks tool_call/tool_result adjacency.
  const countAssistantTurns = totalUserTurns < lastTurnsToKeep;

  let turnCount = 0;
  const collected: BaseMessage[] = [];

  for (let index = body.length - 1; index >= 0; index -= 1) {
    const message = body[index];
    collected.unshift(message);

    const isTurnBoundary = countAssistantTurns
      ? message.role === "assistant"
      : message.role === "user";

    if (isTurnBoundary) {
      turnCount += 1;
      if (turnCount >= lastTurnsToKeep) break;
    }
  }

  // When counting assistant turns, ensure the first user message is always included
  // so the agent retains its original task instruction.
  if (countAssistantTurns && collected.length > 0 && collected[0].role !== "user") {
    const firstUserMsg = body.find((m) => m.role === "user");
    if (firstUserMsg && !collected.includes(firstUserMsg)) {
      collected.unshift(firstUserMsg);
    }
  }

  return [...systemPrefix, ...collected];
}

export function renderStructuredSummary(summary: StructuredSummary | undefined): string {
  if (!summary) return "";
  const lines = ["Context summary:"];
  if (summary.stable_facts.length > 0) {
    lines.push("Stable facts:");
    lines.push(...summary.stable_facts.map((fact) => `- ${fact.key}: ${fact.value}`));
  }
  if (summary.active_goals.length > 0) {
    lines.push("Active goals:");
    lines.push(...summary.active_goals.map((goal) => `- ${goal}`));
  }
  if (summary.open_questions.length > 0) {
    lines.push("Open questions:");
    lines.push(...summary.open_questions.map((question) => `- ${question}`));
  }
  if (summary.discarded_obsolete.length > 0) {
    lines.push("Discarded obsolete:");
    lines.push(...summary.discarded_obsolete.map((item) => `- ${item}`));
  }
  return lines.join("\n");
}

function renderMemoryBlock(facts: MemoryFact[] | undefined): string {
  if (!facts || facts.length === 0) return "";
  return [
    "Retrieved memory:",
    ...facts.map((fact) => `- ${fact.key}: ${fact.value}`),
  ].join("\n");
}

function clampToBudget(messages: BaseMessage[], maxContextTokens: number): BaseMessage[] {
  let working = [...messages];

  while (working.length > 2) {
    const tokenCount = countApproxTokens(working.map(messageText).join("\n"));
    if (tokenCount <= maxContextTokens) return working;

    // Find the first non-system message to remove.
    const firstNonSystem = working.findIndex((message, index) => !(index === 0 && message.role === "system"));
    if (firstNonSystem < 0) break;

    const target = working[firstNonSystem];

    // When removing an assistant message with tool_calls, also remove its
    // corresponding tool result messages to preserve message adjacency.
    // Orphan tool messages cause "tool must follow assistant with tool_calls" errors
    // and confuse the model with placeholder messages.
    if (target.role === "assistant" && Array.isArray(target.tool_calls) && target.tool_calls.length > 0) {
      const toolCallIds = new Set(
        target.tool_calls.map((tc: any) => tc.id).filter(Boolean)
      );
      // Remove assistant + its tool results as a group
      working = working.filter((m, idx) => {
        if (idx === firstNonSystem) return false;
        if (m.role === "tool" && m.tool_call_id && toolCallIds.has(m.tool_call_id)) return false;
        return true;
      });
    } else if (target.role === "tool") {
      // If the target is a tool message, also remove its parent assistant message
      // to avoid leaving an assistant with a dangling tool_call reference.
      const toolCallId = target.tool_call_id;
      let parentIdx = -1;
      if (toolCallId) {
        for (let i = firstNonSystem - 1; i >= 0; i--) {
          const m = working[i];
          if (m.role === "assistant" && Array.isArray(m.tool_calls) && m.tool_calls.some((tc: any) => tc.id === toolCallId)) {
            parentIdx = i;
            break;
          }
        }
      }
      if (parentIdx >= 0) {
        // Remove the entire assistant + all its tool results as a group
        const parent = working[parentIdx];
        const parentToolCallIds = new Set(
          (parent.tool_calls || []).map((tc: any) => tc.id).filter(Boolean)
        );
        working = working.filter((m, idx) => {
          if (idx === parentIdx) return false;
          if (m.role === "tool" && m.tool_call_id && parentToolCallIds.has(m.tool_call_id)) return false;
          return true;
        });
      } else {
        // Orphan tool message — safe to remove alone
        working.splice(firstNonSystem, 1);
      }
    } else {
      working.splice(firstNonSystem, 1);
    }
  }
  return working;
}

export function buildModelMessages(state: SmartState, config: ResolvedSmartAgentConfig): BaseMessage[] {
  const rawMessages = (state.messages || []) as BaseMessage[];
  if (config.context.policy === "raw") {
    return clampToBudget(rawMessages, config.limits.maxContextTokens);
  }

  const recentMessages = collectRecentTurns(rawMessages, config.context.lastTurnsToKeep);
  const latestSummary = state.summaryRecords?.[state.summaryRecords.length - 1];
  const summaryText = renderStructuredSummary(latestSummary);
  const memoryText = renderMemoryBlock(state.memoryFacts);
  const systemMessage = recentMessages[0]?.role === "system" ? recentMessages[0] : undefined;
  const body = systemMessage ? recentMessages.slice(1) : recentMessages;
  const syntheticContextMessages: BaseMessage[] = [];

  if (summaryText) {
    syntheticContextMessages.push({ role: "system", name: "context_summary", content: summaryText });
  }
  if (memoryText) {
    syntheticContextMessages.push({ role: "system", name: "memory_context", content: memoryText });
  }

  const assembled = [
    ...(systemMessage ? [systemMessage] : []),
    ...syntheticContextMessages,
    ...(config.context.policy === "summary_only" ? body.filter((message) => message.role === "user" || message.role === "assistant").slice(-2) : body),
  ];

  return clampToBudget(assembled, config.limits.maxContextTokens);
}