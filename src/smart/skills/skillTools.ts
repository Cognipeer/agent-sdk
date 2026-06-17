import { z } from "zod";

import { createTool } from "../../tool.js";
import type { ToolInterface } from "../../types.js";
import { appendBoundTools, canOpenSkill } from "./registry.js";
import type { Skill, SkillPolicy, SkillRegistryRef } from "./types.js";

/**
 * Per-invoke skill tools (`open_skill`, `bind_skill_tools`). They mutate a
 * SkillRegistryRef (append-only) and call `ref.__onToolsChanged()` so the
 * runtime can rebuild its tool sets. Mirrors createAskUserQuestionTool: state
 * is attached to the tool via a private field and read inside `func`.
 */

const MAX_RETURNED_INDEX = 40;

export type SkillToolDeps = {
  registryRef: SkillRegistryRef;
  skills: Skill[];
  policy: SkillPolicy;
};

const OPEN_SKILL_DESCRIPTION =
  "Load a capability on demand. Pass a skillKey from <available_skills>. A small " +
  "skill binds all its tools immediately; a large one returns a tool index — then " +
  "call bind_skill_tools with only the tools you need. Open only what the task needs.";

const BIND_SKILL_TOOLS_DESCRIPTION =
  "After open_skill on a large skill, bind a chosen subset of its tools by name. " +
  "Pick the few tools the task actually needs.";

function findSkill(deps: SkillToolDeps, key: string): Skill | undefined {
  return deps.skills.find((skill) => skill.key === key);
}

export function createOpenSkillTool(deps: SkillToolDeps): ToolInterface {
  const tool = createTool({
    name: "open_skill",
    description: OPEN_SKILL_DESCRIPTION,
    schema: z
      .object({
        skillKey: z.string().min(1).describe("A key from <available_skills>."),
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
        return { error: `Unknown skill: ${skillKey}. Choose a key listed in <available_skills>.` };
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

/** Both skill tools for an invoke, sharing one registry ref. */
export function createSkillTools(deps: SkillToolDeps): ToolInterface[] {
  return [createOpenSkillTool(deps), createBindSkillToolsTool(deps)];
}
