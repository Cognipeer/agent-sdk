import { describe, it, expect, vi } from "vitest";

import {
  loadSkillsFromDisk,
  parseSkillFrontmatter,
  type SkillExecutionContext,
  type SkillFs,
} from "./markdownLoader.js";

class FakeFs implements SkillFs {
  constructor(
    private files: Record<string, string>,
    private dirs: Record<string, string[]>,
  ) {}
  listDir(dir: string): Promise<string[]> {
    const d = this.dirs[dir];
    return d ? Promise.resolve(d) : Promise.reject(new Error(`no dir ${dir}`));
  }
  readFile(path: string): Promise<string> {
    const f = this.files[path];
    return f === undefined ? Promise.reject(new Error(`no file ${path}`)) : Promise.resolve(f);
  }
}

describe("parseSkillFrontmatter", () => {
  it("splits frontmatter and body", () => {
    const { metadata, body } = parseSkillFrontmatter(
      `---\nname: pr-review\ndescription: Review PRs.\n---\n# Body\ntext`,
    );
    expect(metadata.name).toBe("pr-review");
    expect(metadata.description).toBe("Review PRs.");
    expect(body).toBe("# Body\ntext");
  });

  it("handles missing frontmatter", () => {
    const { metadata, body } = parseSkillFrontmatter("just body");
    expect(metadata).toEqual({});
    expect(body).toBe("just body");
  });

  it("parses block-list scripts", () => {
    const { metadata } = parseSkillFrontmatter(
      `---\nname: x\nscripts:\n  - analyze.py\n  - fill.py\n---\nb`,
    );
    expect(metadata.scripts).toEqual(["analyze.py", "fill.py"]);
  });

  it("keeps a comma-containing description as a scalar string (not an array)", () => {
    const { metadata } = parseSkillFrontmatter(
      `---\nname: charts\ndescription: Use this skill whenever you create a chart, graph, or plot.\n---\nbody`,
    );
    expect(metadata.description).toBe("Use this skill whenever you create a chart, graph, or plot.");
    expect(Array.isArray(metadata.description)).toBe(false);
  });

  it("splits an inline comma list only for list-typed keys (scripts)", () => {
    const { metadata } = parseSkillFrontmatter(
      `---\nname: x\nscripts: analyze.py, fill.py\n---\nb`,
    );
    expect(metadata.scripts).toEqual(["analyze.py", "fill.py"]);
  });

  it("supports explicit inline-array syntax for any key", () => {
    const { metadata } = parseSkillFrontmatter(
      `---\nname: x\ntags: [a, b, c]\n---\nb`,
    );
    expect(metadata.tags).toEqual(["a", "b", "c"]);
  });
});

describe("loadSkillsFromDisk", () => {
  it("discovers SKILL.md skills and maps them to Skill objects", async () => {
    const fs = new FakeFs(
      {
        "/skills/pr-review/SKILL.md": `---\nname: pr-review\ndescription: Review pull requests.\n---\nReview carefully.`,
        "/skills/docs/SKILL.md": `---\nname: docs\ndescription: Write docs.\n---\nWrite clearly.`,
      },
      { "/skills": ["pr-review", "docs", "junk"] },
    );

    const skills = await loadSkillsFromDisk({ fs, roots: ["/skills"] });
    expect(skills.map((s) => s.key).sort()).toEqual(["skillmd:docs", "skillmd:pr-review"]);

    const prReview = skills.find((s) => s.key === "skillmd:pr-review")!;
    expect(prReview.header).toBe("Review pull requests.");
    expect(prReview.prompt).toBe("Review carefully.");
    expect(await prReview.listToolIndex()).toEqual([]);
    expect(await prReview.bindTools()).toEqual([]);
  });

  it("skips entries without a SKILL.md and missing roots", async () => {
    const fs = new FakeFs({}, { "/skills": ["empty"] });
    expect(await loadSkillsFromDisk({ fs, roots: ["/skills", "/nope"] })).toEqual([]);
  });

  it("exposes bundled scripts as executable tools when an execution context is given", async () => {
    const fs = new FakeFs(
      {
        "/skills/pdf/SKILL.md": `---\nname: pdf\ndescription: Process PDFs.\n---\nUse the scripts.`,
      },
      { "/skills": ["pdf"], "/skills/pdf/scripts": ["extract.py", "merge.py"] },
    );
    const execution: SkillExecutionContext = { executeScript: vi.fn(async () => ({ ok: true })) };

    const skills = await loadSkillsFromDisk({ fs, roots: ["/skills"], execution });
    const pdf = skills[0]!;
    expect(pdf.needsSandbox).toBe(true);

    const index = await pdf.listToolIndex();
    expect(index.map((h) => h.name)).toEqual(["pdf__extract", "pdf__merge"]);

    const tools = await pdf.bindTools(["pdf__extract"]);
    expect(tools).toHaveLength(1);

    const result = await (tools[0] as { invoke: (i: unknown) => Promise<unknown> }).invoke({
      args: { file: "a.pdf" },
    });
    expect(result).toEqual({ ok: true });
    expect(execution.executeScript).toHaveBeenCalledWith("/skills/pdf/scripts/extract.py", { file: "a.pdf" });
  });

  it("does not expose script tools without an execution context", async () => {
    const fs = new FakeFs(
      { "/skills/pdf/SKILL.md": `---\nname: pdf\ndescription: Process PDFs.\n---\nbody` },
      { "/skills": ["pdf"], "/skills/pdf/scripts": ["extract.py"] },
    );
    const skills = await loadSkillsFromDisk({ fs, roots: ["/skills"] });
    expect(await skills[0]!.bindTools()).toEqual([]);
    // still flagged as needing a sandbox because scripts exist
    expect(skills[0]!.needsSandbox).toBe(true);
  });

  it("applies a min model tier from frontmatter or options", async () => {
    const fs = new FakeFs(
      {
        "/skills/a/SKILL.md": `---\nname: a\ndescription: d\nmin-model-tier: large\n---\nb`,
        "/skills/b/SKILL.md": `---\nname: b\ndescription: d\n---\nb`,
      },
      { "/skills": ["a", "b"] },
    );
    const skills = await loadSkillsFromDisk({ fs, roots: ["/skills"], minModelTier: "small" });
    const a = skills.find((s) => s.key === "skillmd:a")!;
    const b = skills.find((s) => s.key === "skillmd:b")!;
    expect(a.minModelTier).toBe("large"); // frontmatter wins
    expect(b.minModelTier).toBe("small"); // option default
  });
});
