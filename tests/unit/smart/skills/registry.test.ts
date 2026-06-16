import { describe, expect, it } from "vitest";

import type { ToolInterface } from "../../../../src/types.js";
import {
  appendBoundTools,
  buildSkillHeaderBlock,
  canOpenSkill,
  composeToolSets,
  dedupeToolsByName,
  resolveAvailableSkills,
} from "../../../../src/smart/skills/registry.js";
import {
  createSkillRegistryRef,
  type Skill,
  type SkillPolicy,
} from "../../../../src/smart/skills/types.js";

const tool = (name: string): ToolInterface => ({ name, description: name }) as ToolInterface;
const policy = (over: Partial<SkillPolicy> = {}): SkillPolicy => ({
  maxOpenSkills: 4,
  maxBoundToolsPerSkill: 12,
  maxBoundToolsTotal: 40,
  ...over,
});

describe("composeToolSets", () => {
  const base = [tool("base1"), tool("base2")];
  const skillTools = [tool("s1"), tool("s2")];
  const recovery = tool("get_tool_response");

  it("returns FRESH array references each call (breaks the === short-circuit)", () => {
    const a = composeToolSets({ base, boundSkillTools: skillTools, recoveryTool: recovery });
    const b = composeToolSets({ base, boundSkillTools: skillTools, recoveryTool: recovery });
    expect(a.toolsWithoutRecovery).not.toBe(b.toolsWithoutRecovery);
    expect(a.toolsWithRecovery).not.toBe(b.toolsWithRecovery);
  });

  it("includes skill tools in BOTH variants (recovery-swap cannot drop them)", () => {
    const { toolsWithoutRecovery, toolsWithRecovery } = composeToolSets({
      base,
      boundSkillTools: skillTools,
      recoveryTool: recovery,
    });
    const names = (arr: ToolInterface[]) => arr.map((t) => t.name);
    expect(names(toolsWithoutRecovery)).toEqual(["base1", "base2", "s1", "s2"]);
    expect(names(toolsWithRecovery)).toEqual(["base1", "base2", "s1", "s2", "get_tool_response"]);
  });

  it("omits recovery tool when none provided, still fresh ref", () => {
    const { toolsWithoutRecovery, toolsWithRecovery } = composeToolSets({ base, boundSkillTools: skillTools });
    expect(toolsWithRecovery).not.toBe(toolsWithoutRecovery);
    expect(toolsWithRecovery.map((t) => t.name)).toEqual(["base1", "base2", "s1", "s2"]);
  });
});

describe("appendBoundTools", () => {
  it("is append-only and deduped by name across calls", () => {
    const ref = createSkillRegistryRef();
    const a1 = appendBoundTools(ref, [tool("x"), tool("y")], policy());
    const a2 = appendBoundTools(ref, [tool("y"), tool("z")], policy());
    expect(a1.map((t) => t.name)).toEqual(["x", "y"]);
    expect(a2.map((t) => t.name)).toEqual(["z"]); // y already present
    expect(ref.boundSkillTools.map((t) => t.name)).toEqual(["x", "y", "z"]);
  });

  it("respects the overall total cap", () => {
    const ref = createSkillRegistryRef();
    const many = Array.from({ length: 10 }, (_, i) => tool(`t${i}`));
    const added = appendBoundTools(ref, many, policy({ maxBoundToolsTotal: 4 }));
    expect(added).toHaveLength(4);
    expect(ref.boundSkillTools).toHaveLength(4);
  });
});

describe("canOpenSkill", () => {
  it("allows when under limits", () => {
    expect(canOpenSkill(createSkillRegistryRef(), policy()).ok).toBe(true);
  });

  it("rejects when maxOpenSkills reached", () => {
    const ref = createSkillRegistryRef();
    ref.openedSkillKeys.push("a");
    const result = canOpenSkill(ref, policy({ maxOpenSkills: 1 }));
    expect(result.ok).toBe(false);
  });

  it("rejects when the total tool budget is exhausted", () => {
    const ref = createSkillRegistryRef();
    ref.boundSkillTools.push(tool("a"), tool("b"));
    const result = canOpenSkill(ref, policy({ maxBoundToolsTotal: 2 }));
    expect(result.ok).toBe(false);
  });
});

describe("resolveAvailableSkills", () => {
  const mk = (over: Partial<Skill> & { key: string }): Skill => ({
    title: over.key,
    header: over.key,
    prompt: "p",
    listToolIndex: () => [],
    bindTools: () => [],
    ...over,
  });

  it("filters out unavailable skills", async () => {
    const skills = [
      mk({ key: "on", isAvailable: () => true }),
      mk({ key: "off", isAvailable: () => false }),
      mk({ key: "default" }), // no isAvailable => available
    ];
    const result = await resolveAvailableSkills(skills);
    expect(result.map((s) => s.key)).toEqual(["on", "default"]);
  });

  it("gates large-only skills under a small tier", async () => {
    const skills = [
      mk({ key: "anytier" }),
      mk({ key: "bigonly", minModelTier: "large" }),
    ];
    expect((await resolveAvailableSkills(skills, { modelTier: "small" })).map((s) => s.key)).toEqual(["anytier"]);
    expect((await resolveAvailableSkills(skills, { modelTier: "large" })).map((s) => s.key)).toEqual([
      "anytier",
      "bigonly",
    ]);
  });
});

describe("buildSkillHeaderBlock", () => {
  it("is empty for no skills", () => {
    expect(buildSkillHeaderBlock([])).toBe("");
  });

  it("lists each key and header", () => {
    const block = buildSkillHeaderBlock([
      { key: "mcp:jira", title: "Jira", header: "track issues", prompt: "", listToolIndex: () => [], bindTools: () => [] },
    ]);
    expect(block).toContain("<available_skills>");
    expect(block).toContain("- mcp:jira: track issues");
    expect(block).toContain("open_skill");
  });
});

describe("dedupeToolsByName", () => {
  it("keeps the first occurrence of each name", () => {
    const out = dedupeToolsByName([tool("a"), tool("b"), tool("a")]);
    expect(out.map((t) => t.name)).toEqual(["a", "b"]);
  });
});
