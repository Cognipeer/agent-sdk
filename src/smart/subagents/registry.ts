import type { ChildContextPolicy, Message, ToolInterface } from "../../types.js";
import type { SubagentDef, SubagentPolicy, SubagentRegistryRef } from "./types.js";

/**
 * Pure registry helpers for the sub-agent primitive. No I/O, no agent loop —
 * the deterministic core, fully unit-testable on its own.
 */

/** Look up a registry sub-agent by name. */
export function findSubagent(subagents: SubagentDef[], name: string): SubagentDef | undefined {
  return subagents.find((entry) => entry.name === name);
}

/** Filter the catalog to sub-agents usable now (availability gate). */
export async function resolveAvailableSubagents(subagents: SubagentDef[]): Promise<SubagentDef[]> {
  const out: SubagentDef[] = [];
  for (const entry of subagents) {
    const available = entry.isAvailable ? await entry.isAvailable() : true;
    if (available) out.push(entry);
  }
  return out;
}

/**
 * Spawn guard: may the run spawn `count` more children? Enforces the per-run
 * child-call budget. Depth is checked separately against the live ctx because
 * it depends on the parent's `__delegationDepth`.
 */
export function canSpawn(
  ref: SubagentRegistryRef,
  policy: SubagentPolicy,
  count = 1,
): { ok: true } | { ok: false; reason: string } {
  if (policy.mode === "off") {
    return { ok: false, reason: "sub-agents are disabled by runtime policy" };
  }
  if (ref.spawnedCount + count > policy.maxChildCalls) {
    return {
      ok: false,
      reason: `child-call budget exhausted (${policy.maxChildCalls}); ${ref.spawnedCount} already spawned`,
    };
  }
  return { ok: true };
}

/** Depth guard, evaluated against the current delegation depth from ctx. */
export function withinDepth(
  currentDepth: number,
  policy: SubagentPolicy,
): { ok: true } | { ok: false; reason: string } {
  if (currentDepth >= policy.maxDepth) {
    return { ok: false, reason: `delegation depth limit reached (${policy.maxDepth})` };
  }
  return { ok: true };
}

/**
 * Seed the child's initial messages from the parent transcript according to the
 * context policy. Extracted so both `asTool` delegation and the sub-agent tools
 * share ONE implementation.
 *
 *  - `full`    — entire parent transcript (minus its system prompt) + the input.
 *  - `scoped`  — last user turn + the task input.
 *  - `minimal` — only the task input (default).
 *
 * The parent's system message is intentionally NOT carried over: the child agent
 * composes its own system prompt from its `SubagentDef.systemPrompt` (or role),
 * and leaking the parent's system message would suppress it.
 */
export function seedChildMessages(
  policy: ChildContextPolicy,
  parentMessages: Message[],
  input: string,
): Message[] {
  const messages = (Array.isArray(parentMessages) ? parentMessages : []).filter((m) => m?.role !== "system");
  switch (policy) {
    case "full":
      return [...messages, { role: "user", content: input } as Message];
    case "scoped": {
      const lastUser = [...messages].reverse().find((m) => m?.role === "user");
      return [
        ...(lastUser ? [lastUser] : []),
        { role: "user", content: input } as Message,
      ];
    }
    case "minimal":
    default:
      return [{ role: "user", content: input } as Message];
  }
}

/**
 * Resolve a sub-agent's declared tool surface to concrete tools. `string[]`
 * entries are matched (by name) against the parent's live tool set so an ad-hoc
 * or registry sub-agent can borrow a subset of the parent's capabilities.
 */
export async function resolveSubagentTools(
  declared: SubagentDef["tools"] | string[] | undefined,
  parentTools: ToolInterface[],
): Promise<ToolInterface[]> {
  if (!declared) return [];
  if (typeof declared === "function") {
    return await declared();
  }
  if (Array.isArray(declared) && declared.length > 0 && typeof declared[0] === "string") {
    const wanted = new Set(declared as string[]);
    return parentTools.filter((tool) => wanted.has((tool as any)?.name));
  }
  return declared as ToolInterface[];
}

/** The cheap catalog block the model always sees in its system prompt. */
export function buildSubagentCatalogBlock(
  subagents: SubagentDef[],
  policy: SubagentPolicy,
  toolNames: { delegate: string; spawn: string; parallel: string },
): string {
  const lines: string[] = ["<available_subagents>"];
  const adhoc = policy.mode === "registry_and_adhoc";
  lines.push(
    "Delegate self-contained subtasks to focused sub-agents. Each runs with an " +
      "isolated context and returns a concise result. Use them to decompose hard " +
      "problems; do NOT delegate trivial steps you can do directly.",
  );
  if (subagents.length > 0) {
    lines.push(`Call ${toolNames.delegate}(subagent, input) for a named sub-agent:`);
    for (const entry of subagents) {
      lines.push(`- ${entry.name}: ${entry.header}`);
    }
  }
  if (adhoc) {
    lines.push(
      `Call ${toolNames.spawn}({ role, prompt, input, tools? }) to create a sub-agent on the fly.`,
    );
  }
  lines.push(
    `Call ${toolNames.parallel}({ tasks: [...] }) to run up to ${policy.maxParallel} ` +
      "independent subtasks concurrently (no human-input tools inside parallel children).",
  );
  lines.push("</available_subagents>");
  return lines.join("\n");
}
