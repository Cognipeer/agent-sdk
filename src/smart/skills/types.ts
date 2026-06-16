import type { ToolInterface } from "../../types.js";

/**
 * Skill primitive — progressive capability disclosure for the smart agent.
 *
 * A Skill is a lazy, self-contained capability bundle. The model always sees a
 * cheap one-line `header`; it calls `open_skill(key)` to load the skill's prompt
 * and (for small skills) bind its tools, or `bind_skill_tools(key, names)` to
 * bind a chosen subset of a fat skill. This keeps the number of bound tools per
 * step small — the property small models need — and replaces an up-front
 * tool-selector pass with on-demand disclosure.
 */

export type SkillToolHeader = {
  name: string;
  description?: string;
};

export type SkillModelTier = "small" | "large";

export type Skill = {
  /** Stable key, e.g. "mcp:atlassian" | "integration:google" | "builtin:drawio". */
  key: string;
  title: string;
  /** One-line "what + when to use" the model always sees in the catalog. */
  header: string;
  /** Injected (as the open_skill result) only after the skill is opened. */
  prompt: string | (() => Promise<string> | string);
  /** When true, opening this skill should trigger sandbox bootstrap. */
  needsSandbox?: boolean;
  /** Gate: a "large"-only skill is hidden from a small-tier model. */
  minModelTier?: SkillModelTier;
  /** Whether the skill is usable in the current workspace (integration connected, etc.). */
  isAvailable?: () => boolean | Promise<boolean>;
  /** Cheap list of the skill's tool headers (names + one-liners). */
  listToolIndex: () => Promise<SkillToolHeader[]> | SkillToolHeader[];
  /** Bind concrete tools. With no names, bind the whole (small) skill. */
  bindTools: (names?: string[]) => Promise<ToolInterface[]> | ToolInterface[];
  /** Optional embedding/heuristic ranking of tool headers for a fat skill. */
  rankToolHeaders?: (
    query: string,
    headers: SkillToolHeader[],
  ) => Promise<SkillToolHeader[]> | SkillToolHeader[];
  /** Deterministic floor: tools to bind when a weak model gives no usable query. */
  defaultBindNames?: string[];
};

export type SkillPolicy = {
  /** Max distinct skills open at once (small tier should be 1). */
  maxOpenSkills: number;
  /** Max tools bound from a single skill in one bind call. */
  maxBoundToolsPerSkill: number;
  /** Overall cap on skill-bound tools across the whole run. */
  maxBoundToolsTotal: number;
  /** Current model tier; gates `minModelTier`. */
  modelTier?: SkillModelTier;
};

export const DEFAULT_SKILL_POLICY: SkillPolicy = {
  maxOpenSkills: 4,
  maxBoundToolsPerSkill: 12,
  maxBoundToolsTotal: 40,
};

export const SMALL_TIER_SKILL_POLICY: SkillPolicy = {
  maxOpenSkills: 1,
  maxBoundToolsPerSkill: 6,
  maxBoundToolsTotal: 18,
  modelTier: "small",
};

/**
 * Mutable per-invoke registry. The skill tools mutate this ref (append-only) and
 * call `__onToolsChanged` so the runtime can rebuild its tool sets. Mirrors the
 * stateRef pattern used by createAskUserQuestionTool.
 */
export type SkillRegistryRef = {
  /** Append-only: skills the model has opened this run. */
  openedSkillKeys: string[];
  /** Append-only, deduped by tool name: tools bound from opened skills. */
  boundSkillTools: ToolInterface[];
  /** Rebuild hook wired by createSmartAgent; rebuilds both recovery variants. */
  __onToolsChanged?: () => void;
};

export function createSkillRegistryRef(): SkillRegistryRef {
  return { openedSkillKeys: [], boundSkillTools: [] };
}
