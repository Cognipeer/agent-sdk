import { z } from "zod";

import { createTool } from "../../tool.js";
import type { ToolInterface } from "../../types.js";
import { appendBoundTools, canOpenSkill, resolveAvailableSkills, searchSkills } from "./registry.js";
import type { Skill, SkillPolicy, SkillRegistryRef } from "./types.js";

/**
 * Per-invoke skill tools (`open_skill`, `bind_skill_tools`, and — under
 * `disclosure: "search"` — `search_skills`). They mutate a SkillRegistryRef
 * (append-only) and call `ref.__onToolsChanged()` so the runtime can rebuild its
 * tool sets. Mirrors createAskUserQuestionTool: state is attached to the tool
 * via a private field and read inside `func`.
 */

const MAX_RETURNED_INDEX = 40;
const DEFAULT_SEARCH_LIMIT = 10;
const MAX_SEARCH_LIMIT = 25;

export type SkillToolDeps = {
  registryRef: SkillRegistryRef;
  skills: Skill[];
  policy: SkillPolicy;
};

const isSearchDisclosure = (policy: SkillPolicy): boolean => policy.disclosure === "search";

/** Where a valid skillKey comes from — the only thing that differs per mode. */
const keySource = (policy: SkillPolicy): string =>
  isSearchDisclosure(policy) ? "search_skills" : "<available_skills>";

const openSkillDescription = (policy: SkillPolicy): string =>
  `Load a capability on demand. Pass a skillKey from ${keySource(policy)}. A small ` +
  "skill binds all its tools immediately; a large one returns a tool index — then " +
  "call bind_skill_tools with only the tools you need. Open only what the task needs.";

const BIND_SKILL_TOOLS_DESCRIPTION =
  "After open_skill on a large skill, bind a chosen subset of its tools by name. " +
  "Pick the few tools the task actually needs.";

/**
 * Under `disclosure: "search"` this description is the ONLY thing telling the
 * model that skills exist — nothing is rendered into the system prompt. So it
 * has to state what a skill is, that the tools are hidden until one is opened,
 * and when to call. Keep it explicit if you override it via
 * `promptHooks.toolDescriptions`.
 */
const SEARCH_SKILLS_DESCRIPTION =
  "Find a reusable playbook (a \"skill\") for the task at hand. Skills are proven, " +
  "pre-written procedures for specific kinds of work — each with its own tools, which " +
  "are NOT in your tool list until you open the skill. Call this early whenever a request " +
  "looks like an established procedure, or when you seem to be missing a capability you " +
  "would expect to have: describe the task in `query`. Returns matching skill keys; pass " +
  "one to open_skill to load its instructions and tools. An empty query lists what exists.";

function findSkill(deps: SkillToolDeps, key: string): Skill | undefined {
  return deps.skills.find((skill) => skill.key === key);
}

/**
 * Discovery for `disclosure: "search"`: the catalog stays out of the prompt and
 * the model looks it up instead, so prompt cost is constant no matter how many
 * skills a workspace has.
 *
 * Availability (`isAvailable` / `minModelTier`) is resolved HERE rather than at
 * prompt-assembly time, which means an integration that connects mid-run shows
 * up on the next search instead of being frozen out for the whole invoke.
 */
export function createSearchSkillsTool(deps: SkillToolDeps): ToolInterface {
  const tool = createTool({
    name: "search_skills",
    description: SEARCH_SKILLS_DESCRIPTION,
    schema: z
      .object({
        query: z
          .string()
          .optional()
          .describe("What you are trying to do, in a few words. Omit to list available skills."),
        limit: z
          .number()
          .int()
          .positive()
          .optional()
          .describe(`Max results to return (default ${DEFAULT_SEARCH_LIMIT}).`),
      })
      .strict(),
    func: async ({ query, limit }: { query?: string; limit?: number }) => {
      const { skills, policy, registryRef: ref } = (tool as any)._deps as SkillToolDeps;
      const available = await resolveAvailableSkills(skills, { modelTier: policy.modelTier });
      if (available.length === 0) {
        return { skills: [], total: 0, hint: "No skills are available in this workspace." };
      }

      const capped = Math.min(limit || DEFAULT_SEARCH_LIMIT, MAX_SEARCH_LIMIT);
      const matches = searchSkills(available, query, capped);

      // A miss falls back to the head of the catalog rather than an empty
      // result. The ranker is lexical, so it cannot bridge a query and a header
      // written in different languages — but the MODEL can, once it sees the
      // headers. Returning them here rescues that case in one call instead of
      // making the model guess that an empty query would have listed them.
      const missed = matches.length === 0;
      const shown = missed ? available.slice(0, capped) : matches;

      return {
        skills: shown.map((skill) => ({
          skillKey: skill.key,
          title: skill.title,
          header: skill.header,
          ...(ref.openedSkillKeys.includes(skill.key) ? { alreadyOpen: true } : {}),
        })),
        total: available.length,
        hint: missed
          ? `Nothing matched "${query}" literally — listing ${shown.length} of ${available.length} instead. Judge them by their headers; call open_skill(skillKey) if one fits, otherwise carry on without a skill.`
          : "Call open_skill(skillKey) to load the one that fits.",
      };
    },
  });

  (tool as any)._deps = deps;
  (tool as any).__source = "smart-skills";
  return tool;
}

export function createOpenSkillTool(deps: SkillToolDeps): ToolInterface {
  const tool = createTool({
    name: "open_skill",
    description: openSkillDescription(deps.policy),
    schema: z
      .object({
        skillKey: z.string().min(1).describe(`A key from ${keySource(deps.policy)}.`),
        query: z
          .string()
          .optional()
          .describe("What you need from the skill — used to rank a large skill's tools."),
      })
      .strict(),
    func: async ({ skillKey, query }: { skillKey: string; query?: string }) => {
      const { registryRef: ref, policy } = (tool as any)._deps as SkillToolDeps;
      const skill = findSkill((tool as any)._deps, skillKey);
      if (!skill) {
        return {
          error: `Unknown skill: ${skillKey}. ${
            isSearchDisclosure(policy)
              ? "Call search_skills to get a valid key."
              : "Choose a key listed in <available_skills>."
          }`,
        };
      }
      if (skill.isAvailable && !(await skill.isAvailable())) {
        return { error: `Skill ${skillKey} is not available in this workspace.` };
      }

      const alreadyOpen = ref.openedSkillKeys.includes(skillKey);
      if (!alreadyOpen) {
        const guard = canOpenSkill(ref, policy);
        if (!guard.ok) {
          return {
            error: `Cannot open ${skillKey}: ${guard.reason}. Work with the skills already open.`,
          };
        }
        ref.openedSkillKeys.push(skillKey);
      }

      const prompt = typeof skill.prompt === "function" ? await skill.prompt() : skill.prompt;
      const index = await skill.listToolIndex();

      // Small skill: bind everything in one step.
      if (index.length <= policy.maxBoundToolsPerSkill) {
        const bound = await skill.bindTools();
        const added = appendBoundTools(ref, bound, policy);
        if (added.length > 0) ref.__onToolsChanged?.();
        return {
          skillKey,
          prompt,
          needsSandbox: Boolean(skill.needsSandbox),
          boundTools: added.map((t) => t.name),
          // Inject the bound tools into the live runtime for this loop.
          __runtimeToolsDelta: added,
        };
      }

      // Fat skill: optionally bind a deterministic default floor (so a weak
      // model that can't pick still gets a working set), then return the index.
      let defaultBound: string[] = [];
      let defaultAdded: ToolInterface[] = [];
      if ((!query || query.trim().length < 3) && skill.defaultBindNames?.length) {
        const bound = await skill.bindTools(skill.defaultBindNames.slice(0, policy.maxBoundToolsPerSkill));
        defaultAdded = appendBoundTools(ref, bound, policy);
        if (defaultAdded.length > 0) ref.__onToolsChanged?.();
        defaultBound = defaultAdded.map((t) => t.name);
      }

      const headers =
        query && query.trim().length >= 3 && skill.rankToolHeaders
          ? await skill.rankToolHeaders(query, index)
          : index;

      return {
        skillKey,
        prompt,
        needsSandbox: Boolean(skill.needsSandbox),
        boundTools: defaultBound,
        toolIndex: headers.slice(0, MAX_RETURNED_INDEX).map((h) => ({ name: h.name, description: h.description })),
        hint: "Call bind_skill_tools(skillKey, toolNames) with only the tools you need.",
        ...(defaultAdded.length > 0 ? { __runtimeToolsDelta: defaultAdded } : {}),
      };
    },
  });

  (tool as any)._deps = deps;
  (tool as any).__source = "smart-skills";
  return tool;
}

export function createBindSkillToolsTool(deps: SkillToolDeps): ToolInterface {
  const tool = createTool({
    name: "bind_skill_tools",
    description: BIND_SKILL_TOOLS_DESCRIPTION,
    schema: z
      .object({
        skillKey: z.string().min(1),
        toolNames: z.array(z.string().min(1)).min(1).describe("Tool names from the skill's index."),
      })
      .strict(),
    func: async ({ skillKey, toolNames }: { skillKey: string; toolNames: string[] }) => {
      const { registryRef: ref, policy } = (tool as any)._deps as SkillToolDeps;
      const skill = findSkill((tool as any)._deps, skillKey);
      if (!skill) {
        return { error: `Unknown skill: ${skillKey}.` };
      }
      if (!ref.openedSkillKeys.includes(skillKey)) {
        return { error: `Call open_skill("${skillKey}") before binding its tools.` };
      }

      const capped = toolNames.slice(0, policy.maxBoundToolsPerSkill);
      const bound = await skill.bindTools(capped);
      const added = appendBoundTools(ref, bound, policy);
      if (added.length > 0) ref.__onToolsChanged?.();

      return {
        skillKey,
        boundTools: added.map((t) => t.name),
        requested: capped.length,
        truncated: toolNames.length > capped.length,
        ...(added.length > 0 ? { __runtimeToolsDelta: added } : {}),
      };
    },
  });

  (tool as any)._deps = deps;
  (tool as any).__source = "smart-skills";
  return tool;
}

/**
 * The skill meta-tools for an invoke, sharing one registry ref. `search_skills`
 * is only wired under `disclosure: "search"` — in catalog mode the headers are
 * already in the prompt and a search tool would be pure overhead.
 */
export function createSkillTools(deps: SkillToolDeps): ToolInterface[] {
  const tools = [createOpenSkillTool(deps), createBindSkillToolsTool(deps)];
  if (isSearchDisclosure(deps.policy)) tools.unshift(createSearchSkillsTool(deps));
  return tools;
}
