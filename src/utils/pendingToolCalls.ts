import { isSyntheticSummaryMessage } from "./syntheticMessages.js";

/**
 * Selects the tool_calls that still need to be executed for the current turn.
 *
 * Normal operation: the assistant message the model just produced is last, so we
 * return its tool_calls verbatim (possibly empty for a final answer). This keeps
 * the hot path byte-for-byte identical to `messages[last].tool_calls`.
 *
 * Resume-after-pause: a pausable tool (a sub-agent `delegate_to` / `spawn_subagent`
 * whose child awaited human input) can be emitted in the SAME assistant turn as
 * ordinary tools. Those ordinary tools complete and their `role:"tool"` results
 * get appended, so on resume the LAST message is a sibling tool result — not the
 * assistant turn. Reading `messages[last].tool_calls` then yields `[]` and the
 * paused tool never re-runs (leaving an unpaired tool_use and, downstream, a hard
 * loop-termination error). Here we instead find the assistant turn that owns the
 * still-unresolved tool_calls and return ONLY those (calls that already have a
 * matching `role:"tool"` result are filtered out, so completed siblings never
 * re-execute).
 */
export function selectPendingToolCalls(messages: Array<any> | undefined): any[] {
  if (!Array.isArray(messages) || messages.length === 0) return [];
  const last = messages[messages.length - 1];

  // Hot path: the just-produced assistant turn is last. Return its calls as-is
  // (empty ⇒ final answer). Identical to the previous behaviour.
  if (last?.role === "assistant") {
    return Array.isArray(last.tool_calls) ? last.tool_calls : [];
  }

  // Resume path: last message is a tool result. Find the most recent assistant
  // turn and return only the tool_calls that have no matching tool result yet.
  const resolvedIds = new Set<string>();
  for (const m of messages) {
    if (m?.role === "tool" && m.tool_call_id != null) resolvedIds.add(String(m.tool_call_id));
  }
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const m = messages[i];
    if (m?.role !== "assistant") continue;
    const calls = Array.isArray(m.tool_calls) ? m.tool_calls : [];
    if (calls.length === 0) return [];
    // A call is unresolved when its id has no tool result (or it has no id at
    // all, in which case it cannot be matched and must be treated as pending).
    return calls.filter((c: any) => c?.id == null || !resolvedIds.has(String(c.id)));
  }
  return [];
}

/**
 * True when the transcript ends inside a tool exchange that is not finished: the
 * last assistant turn still has tool_calls with no result after it. That is a
 * run paused for an approval, a question or a paused sub-agent, or a resume about
 * to run the approved call. Appending any other turn here buries those calls
 * (see `selectPendingToolCalls`), so the summarizer must not run at this point.
 *
 * A newer user turn moves past such calls, so it ends the exchange.
 */
export function hasUnresolvedToolCalls(messages: Array<any> | undefined): boolean {
  if (!Array.isArray(messages) || messages.length === 0) return false;
  const role = messages[messages.length - 1]?.role;
  if (role !== "assistant" && role !== "tool") return false;
  return selectPendingToolCalls(messages).length > 0;
}

/**
 * Repairs a transcript in which summarize_context exchanges were appended after
 * a turn whose tool_calls are still open (what 0.22 and earlier stored when a run
 * paused for a human over the summarization threshold). Those trailing exchanges
 * are moved in front of the open turn, so the turn and its results are last
 * again: the pending calls are found, and their results land directly after the
 * calls, which is the order providers require.
 *
 * Returns the input array unchanged when there is nothing to repair.
 */
export function unburyPendingToolCalls<T = any>(messages: T[]): T[] {
  if (!Array.isArray(messages) || messages.length === 0) return messages;
  let start = messages.length;
  while (start > 0 && isSyntheticSummaryMessage(messages[start - 1])) start -= 1;
  if (start === messages.length || start === 0) return messages;

  const body = messages.slice(0, start);
  if (!hasUnresolvedToolCalls(body)) return messages;

  let owner = body.length - 1;
  while (owner >= 0 && (body[owner] as any)?.role !== "assistant") owner -= 1;
  if (owner < 0) return messages;

  return [...body.slice(0, owner), ...messages.slice(start), ...body.slice(owner)];
}
