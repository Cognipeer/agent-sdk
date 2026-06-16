import type { ToolInterface } from "../../types.js";
import type { Skill, SkillPolicy, SkillRegistryRef } from "./types.js";

/**
 * Pure registry helpers for the skill primitive. No I/O, no agent loop — these
 * are the deterministic core, fully unit-testable on their own.
 */

/**
 * Rebuild BOTH runtime tool-set variants with fresh array references.
 *
 * This is the heart of mid-run skill binding. `syncRuntimeTools` swaps between
 * two PRE-COMPUTED arrays and short-circuits on `currentRuntime.tools ===
 * nextTools`. So to make newly-bound skill tools take effect we must hand back
 * NEW array references (breaking the `===` short-circuit) AND include the skill
 * tools in the recovery variant too (otherwise a recovery-swap iteration would
 * silently drop them).
 */
export function composeToolSets(input: {
  base: ToolInterface[];
  boundSkillTools: ToolInterface[];
  recoveryTool?: ToolInterface;
}): { toolsWithoutRecovery: ToolInterface[]; toolsWithRecovery: ToolInterface[] } {
  const without = [...input.base, ...input.boundSkillTools];
  const withRec = input.recoveryTool ? [...without, input.recoveryTool] : [...without];
  return { toolsWithoutRecovery: without, toolsWithRecovery: withRec };
}

/**
 * Append tools to the registry, append-only and deduped by name, honoring the
 * overall total cap. Returns the tools actually added (may be fewer than asked).
 */
export function appendBoundTools(
  ref: SkillRegistryRef,
  newTools: ToolInterface[],
  policy: Pick<SkillPolicy, "maxBoundToolsTotal">,
): ToolInterface[] {
  const present = new Set(ref.boundSkillTools.map((tool) => tool.name));
  const added: ToolInterface[] = [];
  for (const tool of newTools) {
    if (ref.boundSkillTools.length >= policy.maxBoundToolsTotal) break;
    if (present.has(tool.name)) continue;
    present.add(tool.name);
    ref.boundSkillTools.push(tool);
    added.push(tool);
  }
  return added;
}

/** Precedence guard: may the model open another (not-yet-open) skill? */
export function canOpenSkill(
  ref: SkillRegistryRef,
  policy: SkillPolicy,
): { ok: true } | { ok: false; reason: string } {
  if (ref.openedSkillKeys.length >= policy.maxOpenSkills) {
    return { ok: false, reason: `max ${policy.maxOpenSkills} skill(s) already open` };
  }
  if (ref.boundSkillTools.length >= policy.maxBoundToolsTotal) {
    return { ok: false, reason: "skill tool budget exhausted" };
  }
  return { ok: true };
}

/** Filter the catalog to skills usable now: available + tier-gated. */
export async function resolveAvailableSkills(
  skills: Skill[],
  opts: { modelTier?: SkillPolicy["modelTier"] } = {},
): Promise<Skill[]> {
  const out: Skill[] = [];
  for (const skill of skills) {
    if (skill.minModelTier === "large" && opts.modelTier === "small") continue;
    const available = skill.isAvailable ? await skill.isAvailable() : true;
    if (available) out.push(skill);
  }
  return out;
}

/** The cheap header block the model always sees in its system prompt. */
export function buildSkillHeaderBlock(skills: Skill[]): string {
  if (skills.length === 0) return "";
  const lines = skills.map((skill) => `- ${skill.key}: ${skill.header}`);
  return [
    "<available_skills>",
    "Open a skill with open_skill(skillKey) to load its tools on demand. Only open what the task needs; close nothing — opened skills stay available for the rest of the run.",
    ...lines,
    "</available_skills>",
  ].join("\n");
}

export function dedupeToolsByName(tools: ToolInterface[]): ToolInterface[] {
  const seen = new Set<string>();
  const out: ToolInterface[] = [];
  for (const tool of tools) {
    if (seen.has(tool.name)) continue;
    seen.add(tool.name);
    out.push(tool);
  }
  return out;
}
