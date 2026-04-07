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
  let userTurnCount = 0;
  const collected: BaseMessage[] = [];

  for (let index = body.length - 1; index >= 0; index -= 1) {
    const message = body[index];
    collected.unshift(message);
    if (message.role === "user") {
      userTurnCount += 1;
      if (userTurnCount >= lastTurnsToKeep) break;
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

    const firstNonSystem = working.findIndex((message, index) => !(index === 0 && message.role === "system"));
    if (firstNonSystem < 0) break;
    working.splice(firstNonSystem, 1);
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

export function estimateContextRotScore(state: SmartState): number {
  const summaryCount = state.summaryRecords?.length || 0;
  const archivedCount = state.toolHistoryArchived?.length || 0;
  const messageCount = state.messages?.length || 0;
  const summarizedMessages = state.messages?.filter((message) => (
    message.role === "tool"
    && typeof message.content === "string"
    && (message.content === "SUMMARIZED" || message.content.startsWith("SUMMARIZED_TOOL_RESPONSE"))
  )).length || 0;
  const numerator = (summaryCount * 2) + archivedCount + summarizedMessages;
  const denominator = Math.max(messageCount, 1);
  return Number((numerator / denominator).toFixed(3));
}