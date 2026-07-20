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
