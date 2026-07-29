import { describe, expect, it } from "vitest";

import type { ToolInterface } from "../../../../src/types.js";
import {
  appendBoundTools,
  buildSkillHeaderBlock,
  canOpenSkill,
  composeToolSets,
  dedupeToolsByName,
  resolveAvailableSkills,
  searchSkills,
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

describe("searchSkills", () => {
  const skill = (key: string, title: string, header: string): Skill => ({
    key,
    title,
    header,
    prompt: "",
    listToolIndex: () => [],
    bindTools: () => [],
  });

  const catalog = [
    skill("workspace:file_converter", "File Converter", "use when you need file conversion"),
    skill("workspace:invoice", "Invoice Reader", "extract totals and dates from invoices"),
    skill("workspace:docs", "Docs", "write and convert long documents"),
    skill("mcp:jira", "Jira", "track issues and sprints"),
  ];

  const keys = (out: Skill[]) => out.map((s) => s.key);

  it("ranks by the query and drops what does not match", () => {
    expect(keys(searchSkills(catalog, "convert this docx to pdf"))).toEqual([
      "workspace:file_converter",
      "workspace:docs",
    ]);
  });

  it("ignores noise words instead of letting them match as substrings", () => {
    // "to" must not reach "totals", or every stopword drags in the whole catalog.
    expect(keys(searchSkills(catalog, "to"))).toEqual(keys(catalog));
    expect(keys(searchSkills(catalog, "to an"))).toEqual(keys(catalog));
  });

  it("bridges morphology: a 'conversion' header answers a 'convert' query", () => {
    expect(keys(searchSkills(catalog, "convert"))[0]).toBe("workspace:file_converter");
    expect(keys(searchSkills(catalog, "conversion"))[0]).toBe("workspace:file_converter");
    // plural/suffix in the other direction
    expect(keys(searchSkills(catalog, "invoices"))).toEqual(["workspace:invoice"]);
  });

  it("splits non-ASCII scripts on word boundaries, not on their letters", () => {
    const tr = [skill("workspace:donusum", "Dosya Dönüşümü", "faturaları dönüştürmek için")];
    expect(keys(searchSkills(tr, "dönüşüm"))).toEqual(["workspace:donusum"]);
    expect(keys(searchSkills(tr, "fatura"))).toEqual(["workspace:donusum"]);
  });

  it("prefers covering more of the query over a heavier single-field hit", () => {
    // "convert" hits file_converter's key AND title (heavier), but docs matches
    // both query words - which is the better answer.
    expect(keys(searchSkills(catalog, "convert documents"))).toEqual([
      "workspace:docs",
      "workspace:file_converter",
    ]);
  });

  it("treats an empty or all-noise query as a browse request", () => {
    expect(keys(searchSkills(catalog))).toEqual(keys(catalog));
    expect(keys(searchSkills(catalog, "   "))).toEqual(keys(catalog));
  });

  it("returns nothing when the query matches nothing", () => {
    expect(searchSkills(catalog, "kubernetes cluster autoscaling")).toEqual([]);
  });

  it("honors the limit and keeps catalog order for ties", () => {
    expect(keys(searchSkills(catalog, "", 2))).toEqual([catalog[0].key, catalog[1].key]);
    // file_converter and invoice both score 9 on one term each, so the tie is
    // broken by catalog order; docs only grazes "convert" in its header.
    expect(keys(searchSkills(catalog, "invoice conversion"))).toEqual([
      "workspace:file_converter",
      "workspace:invoice",
      "workspace:docs",
    ]);
  });
});
