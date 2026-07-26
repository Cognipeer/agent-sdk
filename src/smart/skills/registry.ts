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

/** Word-granular, script-agnostic: `\p{L}` keeps Turkish/Cyrillic/CJK intact. */
const WORD_SPLIT = /[^\p{L}\p{N}]+/u;
/** Below this a term is noise ("to", "an") that would match half the catalog. */
const MIN_TERM_LENGTH = 3;
const FIELD_WEIGHTS = { key: 4, title: 3, header: 2 } as const;

const wordsOf = (text: string): string[] =>
  text.toLowerCase().split(WORD_SPLIT).filter((word) => word.length >= 2);

/**
 * Deliberately morphological rather than fuzzy: a shared 4-char prefix bridges
 * "conversion" to a header that says "convert", while plain substring matching
 * would let "to" hit "totals".
 */
const termHitsWord = (term: string, word: string): boolean =>
  word === term ||
  word.startsWith(term) ||
  (word.length >= 3 && term.startsWith(word)) ||
  (term.length >= 5 && word.length >= 5 && word.slice(0, 4) === term.slice(0, 4));

/**
 * Rank a catalog against a free-text task description. Pure, deterministic and
 * dependency-free: no embeddings, no I/O, so it costs nothing and behaves the
 * same on every run. Backs the `search_skills` tool.
 *
 * Skills covering MORE of the query rank first, and only then by field weight
 * (key > title > header) — matching two of the user's words in a header beats
 * matching one of them in a title. Ties keep catalog order so a repeated query
 * always returns the same list.
 *
 * An empty (or all-noise) query is a browse request and returns the head of the
 * catalog rather than nothing.
 */
export function searchSkills(skills: Skill[], query?: string, limit = 10): Skill[] {
  const cap = Math.max(1, limit);
  const normalized = (query || "").trim().toLowerCase();
  const terms = [
    ...new Set(normalized.split(WORD_SPLIT).filter((term) => term.length >= MIN_TERM_LENGTH)),
  ];
  if (terms.length === 0) return skills.slice(0, cap);

  const scored = skills
    .map((skill, index) => {
      const fields = {
        key: wordsOf(skill.key),
        title: wordsOf(skill.title || ""),
        header: wordsOf(skill.header || ""),
      };
      const exact = skill.key.toLowerCase() === normalized || (skill.title || "").toLowerCase() === normalized;
      let score = exact ? 100 : 0;
      let coverage = 0;
      for (const term of terms) {
        let hit = false;
        for (const [field, weight] of Object.entries(FIELD_WEIGHTS)) {
          if (fields[field as keyof typeof fields].some((word) => termHitsWord(term, word))) {
            score += weight;
            hit = true;
          }
        }
        if (hit) coverage += 1;
      }
      return { skill, score, coverage, index };
    })
    .filter((entry) => entry.score > 0);

  scored.sort((a, b) => b.coverage - a.coverage || b.score - a.score || a.index - b.index);
  return scored.slice(0, cap).map((entry) => entry.skill);
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
