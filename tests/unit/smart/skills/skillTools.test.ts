import { describe, expect, it, vi } from "vitest";

import type { ToolInterface } from "../../../../src/types.js";
import { composeToolSets } from "../../../../src/smart/skills/registry.js";
import { createBindSkillToolsTool, createOpenSkillTool } from "../../../../src/smart/skills/skillTools.js";
import {
  createSkillRegistryRef,
  type Skill,
  type SkillPolicy,
  type SkillRegistryRef,
} from "../../../../src/smart/skills/types.js";

const tool = (name: string): ToolInterface => ({ name, description: name }) as ToolInterface;
const policy = (over: Partial<SkillPolicy> = {}): SkillPolicy => ({
  maxOpenSkills: 4,
  maxBoundToolsPerSkill: 6,
  maxBoundToolsTotal: 18,
  ...over,
});

function smallSkill(key: string, names = ["read", "write"]): Skill {
  return {
    key,
    title: key,
    header: `header ${key}`,
    prompt: `prompt ${key}`,
    listToolIndex: () => names.map((n) => ({ name: n })),
    bindTools: (want) => (want ?? names).map(tool),
  };
}

function fatSkill(key: string, count = 30, extra: Partial<Skill> = {}): Skill {
  const names = Array.from({ length: count }, (_, i) => `${key}_t${i}`);
  return {
    key,
    title: key,
    header: `header ${key}`,
    prompt: `prompt ${key}`,
    listToolIndex: () => names.map((n) => ({ name: n })),
    bindTools: (want) => (want ?? names).map(tool),
    ...extra,
  };
}

async function invoke(t: ToolInterface, args: any) {
  return (t as any).func(args);
}

function withHook(ref: SkillRegistryRef) {
  const onChanged = vi.fn();
  ref.__onToolsChanged = onChanged;
  return onChanged;
}

describe("open_skill", () => {
  it("binds a small skill's tools immediately and signals a tools change", async () => {
    const ref = createSkillRegistryRef();
    const onChanged = withHook(ref);
    const open = createOpenSkillTool({ registryRef: ref, skills: [smallSkill("builtin:pdf")], policy: policy() });

    const res = await invoke(open, { skillKey: "builtin:pdf" });
    expect(res.prompt).toBe("prompt builtin:pdf");
    expect(res.boundTools).toEqual(["read", "write"]);
    expect(ref.boundSkillTools.map((t) => t.name)).toEqual(["read", "write"]);
    expect(onChanged).toHaveBeenCalledTimes(1);
  });

  it("does NOT bind a fat skill's tools; returns an index + hint", async () => {
    const ref = createSkillRegistryRef();
    const onChanged = withHook(ref);
    const open = createOpenSkillTool({ registryRef: ref, skills: [fatSkill("mcp:jira")], policy: policy() });

    const res = await invoke(open, { skillKey: "mcp:jira" });
    expect(res.boundTools).toEqual([]);
    expect(res.toolIndex.length).toBeGreaterThan(0);
    expect(res.hint).toContain("bind_skill_tools");
    expect(ref.boundSkillTools).toHaveLength(0);
    expect(onChanged).not.toHaveBeenCalled();
  });

  it("binds a deterministic default floor for a fat skill when no usable query", async () => {
    const ref = createSkillRegistryRef();
    const onChanged = withHook(ref);
    const skill = fatSkill("mcp:crm", 30, { defaultBindNames: ["mcp:crm_t0", "mcp:crm_t1"] });
    const open = createOpenSkillTool({ registryRef: ref, skills: [skill], policy: policy() });

    const res = await invoke(open, { skillKey: "mcp:crm" });
    expect(res.boundTools).toEqual(["mcp:crm_t0", "mcp:crm_t1"]);
    expect(onChanged).toHaveBeenCalledTimes(1);
  });

  it("ranks the index when a query and ranker are present", async () => {
    const ref = createSkillRegistryRef();
    withHook(ref);
    const skill = fatSkill("mcp:jira", 30, {
      rankToolHeaders: (_q, headers) => [...headers].reverse(),
    });
    const open = createOpenSkillTool({ registryRef: ref, skills: [skill], policy: policy() });

    const res = await invoke(open, { skillKey: "mcp:jira", query: "create an issue" });
    expect(res.toolIndex[0].name).toBe("mcp:jira_t29");
  });

  it("errors on unknown or unavailable skills", async () => {
    const ref = createSkillRegistryRef();
    const open = createOpenSkillTool({
      registryRef: ref,
      skills: [smallSkill("a"), { ...smallSkill("b"), isAvailable: () => false }],
      policy: policy(),
    });
    expect((await invoke(open, { skillKey: "missing" })).error).toContain("Unknown skill");
    expect((await invoke(open, { skillKey: "b" })).error).toContain("not available");
  });

  it("surfaces needsSandbox", async () => {
    const ref = createSkillRegistryRef();
    withHook(ref);
    const open = createOpenSkillTool({
      registryRef: ref,
      skills: [{ ...smallSkill("code"), needsSandbox: true }],
      policy: policy(),
    });
    const res = await invoke(open, { skillKey: "code" });
    expect(res.needsSandbox).toBe(true);
  });

  it("enforces the maxOpenSkills precedence guard but stays idempotent for re-open", async () => {
    const ref = createSkillRegistryRef();
    withHook(ref);
    const open = createOpenSkillTool({
      registryRef: ref,
      skills: [smallSkill("a"), smallSkill("b")],
      policy: policy({ maxOpenSkills: 1 }),
    });
    expect((await invoke(open, { skillKey: "a" })).boundTools).toBeTruthy();
    // second DISTINCT skill is rejected (budget protected)
    expect((await invoke(open, { skillKey: "b" })).error).toContain("Cannot open");
    // re-opening the already-open skill is fine (no guard error)
    expect((await invoke(open, { skillKey: "a" })).error).toBeUndefined();
    expect(ref.openedSkillKeys).toEqual(["a"]);
  });
});

describe("bind_skill_tools", () => {
  it("requires the skill to be opened first", async () => {
    const ref = createSkillRegistryRef();
    const bind = createBindSkillToolsTool({ registryRef: ref, skills: [fatSkill("mcp:jira")], policy: policy() });
    const res = await invoke(bind, { skillKey: "mcp:jira", toolNames: ["mcp:jira_t0"] });
    expect(res.error).toContain("open_skill");
  });

  it("binds a chosen subset, caps per skill, and signals a change", async () => {
    const ref = createSkillRegistryRef();
    const onChanged = withHook(ref);
    ref.openedSkillKeys.push("mcp:jira");
    const bind = createBindSkillToolsTool({
      registryRef: ref,
      skills: [fatSkill("mcp:jira")],
      policy: policy({ maxBoundToolsPerSkill: 2 }),
    });
    const res = await invoke(bind, { skillKey: "mcp:jira", toolNames: ["mcp:jira_t0", "mcp:jira_t1", "mcp:jira_t2"] });
    expect(res.boundTools).toEqual(["mcp:jira_t0", "mcp:jira_t1"]);
    expect(res.truncated).toBe(true);
    expect(onChanged).toHaveBeenCalledTimes(1);
  });
});

describe("end-to-end: bound skill tools survive composeToolSets (the identity-swap fix)", () => {
  it("includes opened+bound skill tools in BOTH recovery variants", async () => {
    const ref = createSkillRegistryRef();
    const base = [tool("read_text_file"), tool("search_capability")];
    const recovery = tool("get_tool_response");

    // before opening: composeToolSets has no skill tools
    const before = composeToolSets({ base, boundSkillTools: ref.boundSkillTools, recoveryTool: recovery });
    expect(before.toolsWithoutRecovery.map((t) => t.name)).not.toContain("read");

    // open a small skill -> binds its tools into the ref
    ref.__onToolsChanged = () => {};
    const open = createOpenSkillTool({ registryRef: ref, skills: [smallSkill("builtin:pdf", ["read", "write"])], policy: policy() });
    await invoke(open, { skillKey: "builtin:pdf" });

    // after opening: a fresh composeToolSets includes the skill tools in both variants
    const after = composeToolSets({ base, boundSkillTools: ref.boundSkillTools, recoveryTool: recovery });
    expect(after.toolsWithoutRecovery.map((t) => t.name)).toEqual([
      "read_text_file",
      "search_capability",
      "read",
      "write",
    ]);
    expect(after.toolsWithRecovery.map((t) => t.name)).toEqual([
      "read_text_file",
      "search_capability",
      "read",
      "write",
      "get_tool_response",
    ]);
    // fresh references => the runtime's === short-circuit will see a change
    expect(after.toolsWithoutRecovery).not.toBe(before.toolsWithoutRecovery);
  });
});
