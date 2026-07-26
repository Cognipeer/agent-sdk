import { describe, expect, it, vi } from "vitest";

import type { ToolInterface } from "../../../../src/types.js";
import { composeToolSets } from "../../../../src/smart/skills/registry.js";
import {
  createBindSkillToolsTool,
  createOpenSkillTool,
  createSearchSkillsTool,
  createSkillTools,
} from "../../../../src/smart/skills/skillTools.js";
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

describe("search_skills (disclosure: \"search\")", () => {
  const searchPolicy = policy({ disclosure: "search" });

  const named = (key: string, title: string, header: string, over: Partial<Skill> = {}): Skill => ({
    ...smallSkill(key),
    title,
    header,
    ...over,
  });

  const catalog = [
    named("workspace:file_converter", "File Converter", "use when you need file conversion"),
    named("workspace:invoice", "Invoice Reader", "extract totals from invoices"),
  ];

  it("is only wired under search disclosure", () => {
    const deps = { registryRef: createSkillRegistryRef(), skills: catalog, policy: policy() };
    expect(createSkillTools(deps).map((t) => t.name)).toEqual(["open_skill", "bind_skill_tools"]);
    expect(createSkillTools({ ...deps, policy: searchPolicy }).map((t) => t.name)).toEqual([
      "search_skills",
      "open_skill",
      "bind_skill_tools",
    ]);
  });

  it("returns the keys open_skill expects, ranked by the query", async () => {
    const search = createSearchSkillsTool({
      registryRef: createSkillRegistryRef(),
      skills: catalog,
      policy: searchPolicy,
    });
    const out = await invoke(search, { query: "convert a file" });
    expect(out.skills.map((s: any) => s.skillKey)).toEqual(["workspace:file_converter"]);
    expect(out.total).toBe(2);
  });

  it("lists everything when no query is given, and flags what is already open", async () => {
    const ref = createSkillRegistryRef();
    ref.openedSkillKeys.push("workspace:invoice");
    const search = createSearchSkillsTool({ registryRef: ref, skills: catalog, policy: searchPolicy });
    const out = await invoke(search, {});
    expect(out.skills.map((s: any) => s.skillKey)).toEqual([
      "workspace:file_converter",
      "workspace:invoice",
    ]);
    expect(out.skills[1].alreadyOpen).toBe(true);
    expect(out.skills[0].alreadyOpen).toBeUndefined();
  });

  it("resolves availability at call time, not at prompt time", async () => {
    let connected = false;
    const gated = named("mcp:crm", "CRM", "search CRM deals", { isAvailable: () => connected });
    const search = createSearchSkillsTool({
      registryRef: createSkillRegistryRef(),
      skills: [gated],
      policy: searchPolicy,
    });

    const before = await invoke(search, { query: "crm" });
    expect(before.skills).toEqual([]);
    expect(before.hint).toContain("No skills are available");

    connected = true;
    const after = await invoke(search, { query: "crm" });
    expect(after.skills.map((s: any) => s.skillKey)).toEqual(["mcp:crm"]);
  });

  it("falls back to the catalog head when nothing matches literally", async () => {
    const search = createSearchSkillsTool({
      registryRef: createSkillRegistryRef(),
      skills: catalog,
      policy: searchPolicy,
    });
    // A lexical ranker cannot bridge languages; the model reading the headers
    // can, so a miss must still hand it something to judge.
    const out = await invoke(search, { query: "dosyayı pdf e çevir" });
    expect(out.skills.map((s: any) => s.skillKey)).toEqual([
      "workspace:file_converter",
      "workspace:invoice",
    ]);
    expect(out.hint).toContain("Nothing matched");
    expect(out.hint).toContain("headers");
  });

  it("caps the result count", async () => {
    const many = Array.from({ length: 40 }, (_, i) => named(`k${i}`, `T${i}`, "header"));
    const search = createSearchSkillsTool({
      registryRef: createSkillRegistryRef(),
      skills: many,
      policy: searchPolicy,
    });
    expect((await invoke(search, {})).skills).toHaveLength(10);
    expect((await invoke(search, { limit: 3 })).skills).toHaveLength(3);
    expect((await invoke(search, { limit: 999 })).skills).toHaveLength(25);
  });

  it("points open_skill at search_skills instead of the prompt block", async () => {
    const deps = { registryRef: createSkillRegistryRef(), skills: catalog, policy: searchPolicy };
    const open = createOpenSkillTool(deps);
    expect(open.description).toContain("search_skills");
    expect(open.description).not.toContain("<available_skills>");

    const unknown = await invoke(open, { skillKey: "nope" });
    expect(unknown.error).toContain("search_skills");

    // Catalog mode keeps pointing at the prompt block.
    const catalogOpen = createOpenSkillTool({ ...deps, policy: policy() });
    expect(catalogOpen.description).toContain("<available_skills>");
  });
});
