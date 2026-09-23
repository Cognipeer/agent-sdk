import type { BaseMessage, MemoryFact, ResolvedSmartAgentConfig, SmartState, StructuredSummary } from "../types.js";
import { countApproxTokens } from "../utils/utilTokens.js";
import { extractMessageText } from "../utils/content.js";
import { isSyntheticSummaryMessage } from "../utils/syntheticMessages.js";

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

  // The first user message is the run's context anchor (the original task /
  // instruction). It must survive the turn window in BOTH counting modes:
  // restricting this to countAssistantTurns runs dropped the anchor for any
  // conversation with more user turns than the window (prod incident class:
  // the agent concluded "no task was provided" mid-run and stalled or re-asked).
  if (collected.length > 0) {
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
  // Standing instructions first: they constrain every later turn, and they are
  // the part of the conversation a summary must never paraphrase away.
  if (summary.user_directives && summary.user_directives.length > 0) {
    lines.push("User directives (still in force — follow them):");
    lines.push(...summary.user_directives.map((directive) => `- ${directive}`));
  }
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
  // discarded_obsolete items are intentionally NOT rendered back into the context.
  // They are already obsolete and including them wastes tokens.
  return lines.join("\n");
}

function renderMemoryBlock(facts: MemoryFact[] | undefined): string {
  if (!facts || facts.length === 0) return "";
  return [
    "Retrieved memory:",
    ...facts.map((fact) => `- ${fact.key}: ${fact.value}`),
  ].join("\n");
}

/**
 * True for messages the clamp must NEVER remove:
 *  - system messages (the agent's instructions, synthetic context_summary /
 *    memory_context blocks, structured-output nudges — all small and load-bearing),
 *  - the FIRST user message (the run's context anchor: the original task or
 *    instruction; dropping it made agents "lose" their task mid-run, conclude
 *    no task was provided, and stall or bounce questions back to the user).
 */
function isClampProtected(message: BaseMessage, index: number, firstUserIndex: number): boolean {
  if (message.role === "system") return true;
  if (index === firstUserIndex) return true;
  return false;
}

function clampToBudget(messages: BaseMessage[], maxContextTokens: number): BaseMessage[] {
  let working = [...messages];

  while (working.length > 2) {
    const tokenCount = countApproxTokens(working.map(extractMessageText).join("\n"));
    if (tokenCount <= maxContextTokens) return working;

    // Find the oldest DROPPABLE message: skip every protected message (system
    // blocks wherever they sit, plus the first user message — the context
    // anchor). Previously only messages[0] was protected when it was a system
    // message, so the first casualty of an over-budget run was the user
    // message carrying the original task.
    const firstUserIndex = working.findIndex((message) => message.role === "user");
    const firstNonSystem = working.findIndex((message, index) => !isClampProtected(message, index, firstUserIndex));
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

/**
 * The `summary_only` view: the summary stands in for PAST turns; the current
 * turn is sent as it is.
 *
 *  - The FIRST user message (the run's instruction anchor) is always kept —
 *    the old `.slice(-2)` dropped it, so a standing instruction given there
 *    ("answer in Turkish", "never touch prod") vanished on the third turn.
 *  - The CURRENT turn — the last user message and everything after it — is
 *    kept whole, tool calls and results included. The old view filtered tool
 *    messages out entirely, so inside a run the model never saw the output of
 *    the tool it had just called (and asked for it again), and a kept
 *    assistant turn with `tool_calls` but no results was an invalid request
 *    for most providers. Results the summarizer compacted stay as their small
 *    placeholders: they are the trail of what the run already did (which
 *    pages it read, which queries it ran), and without that trail a model
 *    re-does work it cannot see it did. The summarizer's latest, protected
 *    tool turn stays in full even though its marker is appended after it.
 *  - Earlier turns are represented by the summary, EXCEPT those after the
 *    latest summarization point: nobody has summarized them yet.
 *  - The synthetic summarize_context exchange itself is dropped: its text is
 *    already in the `context_summary` block.
 *  - Until a first summary exists there is nothing to stand in for the past,
 *    so the view is the hybrid turn window — dropping turns nobody has
 *    summarized would lose them outright.
 */
function collectSummaryOnlyBody(body: BaseMessage[], hasSummary: boolean, lastTurnsToKeep: number): BaseMessage[] {
  if (!hasSummary) {
    return collectRecentTurns(body, Math.max(1, lastTurnsToKeep));
  }

  let boundary = -1;
  for (let index = body.length - 1; index >= 0; index -= 1) {
    if (isSyntheticSummaryMessage(body[index])) {
      boundary = index;
      break;
    }
  }
  let lastUserIndex = -1;
  for (let index = body.length - 1; index >= 0; index -= 1) {
    if (body[index].role === "user") {
      lastUserIndex = index;
      break;
    }
  }

  const keep = new Set<number>();
  const firstUserIndex = body.findIndex((message) => message.role === "user");
  if (firstUserIndex >= 0) keep.add(firstUserIndex);
  const verbatimFrom = Math.min(lastUserIndex >= 0 ? lastUserIndex : body.length, boundary + 1);
  for (let index = Math.max(0, verbatimFrom); index < body.length; index += 1) {
    if (!isSyntheticSummaryMessage(body[index])) keep.add(index);
  }

  return body.filter((_, index) => keep.has(index));
}

export function buildModelMessages(state: SmartState, config: ResolvedSmartAgentConfig): BaseMessage[] {
  const rawMessages = (state.messages || []) as BaseMessage[];
  if (config.context.policy === "raw") {
    return clampToBudget(rawMessages, config.limits.maxContextTokens);
  }

  const latestSummary = state.summaryRecords?.[state.summaryRecords.length - 1];
  const summaryText = renderStructuredSummary(latestSummary);
  const memoryText = renderMemoryBlock(state.memoryFacts);
  const systemMessage = rawMessages[0]?.role === "system" ? rawMessages[0] : undefined;
  const body = config.context.policy === "summary_only"
    ? collectSummaryOnlyBody(systemMessage ? rawMessages.slice(1) : rawMessages, Boolean(summaryText), config.context.lastTurnsToKeep)
    : (() => {
      const recentMessages = collectRecentTurns(rawMessages, config.context.lastTurnsToKeep);
      return recentMessages[0]?.role === "system" ? recentMessages.slice(1) : recentMessages;
    })();
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
    ...body,
  ];

  return clampToBudget(assembled, config.limits.maxContextTokens);
}