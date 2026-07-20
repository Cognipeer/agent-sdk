import { z } from "zod";

import { createTool } from "../../tool.js";
import type { ToolInterface } from "../../types.js";
import type { Skill, SkillToolHeader } from "./types.js";

/**
 * Native SKILL.md loader — Anthropic-style filesystem skills for the smart agent.
 *
 * Discovers `<root>/<name>/SKILL.md` documents, parses their frontmatter, and
 * adapts each into a {@link Skill} with progressive disclosure:
 *   - level 1: `header` (frontmatter description) — always in the catalog;
 *   - level 2: `prompt` (the markdown body) — returned on `open_skill`;
 *   - level 3: bundled `scripts/` — exposed as tools that execute out-of-context
 *     via an injected {@link SkillExecutionContext} (e.g. a sandbox), so script
 *     source never enters the model context.
 *
 * The filesystem is injected (`SkillFs`) so skills can live on local disk or on
 * a remote sandbox filesystem. This module is additive: it produces standard
 * `Skill` objects consumable by `createSmartAgent({ skills })`.
 */

/** Minimal filesystem the loader needs; satisfiable by node fs or a sandbox fs. */
export interface SkillFs {
  /** Entry names directly under `dir`. Reject if `dir` does not exist. */
  listDir(dir: string): Promise<string[]>;
  /** Read a UTF-8 file. Reject if the file does not exist. */
  readFile(path: string): Promise<string>;
}

/** Executes a skill's bundled script out of context and returns its output. */
export interface SkillExecutionContext {
  /**
   * Run a bundled script (path relative to the skill directory) with the given
   * arguments. Implementations typically shell out inside a sandbox and return
   * stdout / a parsed result.
   */
  executeScript(scriptPath: string, args: Record<string, unknown>): Promise<unknown>;
}

export interface LoadSkillsOptions {
  fs: SkillFs;
  /** Directories to scan for `<name>/SKILL.md`. */
  roots: string[];
  /** When provided, bundled scripts become executable tools. */
  execution?: SkillExecutionContext;
  /** Default model-tier gate applied to discovered skills. */
  minModelTier?: "small" | "large";
}

export interface SkillFrontmatter {
  metadata: Record<string, string | string[]>;
  body: string;
}

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;

/** Parse SKILL.md frontmatter + body. No YAML dependency. */
export function parseSkillFrontmatter(md: string): SkillFrontmatter {
  const match = FRONTMATTER_RE.exec(md);
  if (!match) return { metadata: {}, body: md.trim() };
  return { metadata: parseFrontmatterBlock(match[1] ?? ""), body: md.slice(match[0].length).trim() };
}

// Keys whose inline value is semantically a comma-separated list. Everything
// else (name, title, description, …) is treated as an opaque scalar so that a
// value containing commas — the common case for a `description` — is NOT split
// into an array and does not corrupt the always-visible skill header.
const LIST_KEYS = new Set([
  "scripts",
  "keywords",
  "tags",
  "allowed-tools",
  "allowed_tools",
  "compatible-models",
  "compatible_models",
]);

function parseFrontmatterBlock(raw: string): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {};
  let listKey: string | null = null;
  let listAcc: string[] = [];
  const flush = () => {
    if (listKey) {
      out[listKey] = listAcc;
      listAcc = [];
      listKey = null;
    }
  };
  const splitList = (value: string): string[] =>
    value.split(",").map((v) => unquote(v.trim())).filter(Boolean);
  for (const line of raw.split(/\r?\n/)) {
    if (line.trim() === "") continue;
    const item = /^\s*-\s+(.*)$/.exec(line);
    if (item && listKey) {
      listAcc.push(unquote(item[1]!.trim()));
      continue;
    }
    flush();
    const kv = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line);
    if (!kv) continue;
    const [, key, rawValue] = kv;
    const value = rawValue!.trim();
    if (value === "") {
      listKey = key!;
    } else if (value.startsWith("[") && value.endsWith("]")) {
      // Explicit inline-array syntax: `key: [a, b, c]`.
      out[key!] = splitList(value.slice(1, -1));
    } else if (LIST_KEYS.has(key!.toLowerCase())) {
      out[key!] = splitList(value);
    } else {
      out[key!] = unquote(value);
    }
  }
  flush();
  return out;
}

function unquote(s: string): string {
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    return s.slice(1, -1);
  }
  return s;
}

function asArray(v: string | string[] | undefined): string[] {
  if (v === undefined) return [];
  return Array.isArray(v) ? v : [v];
}

function sanitize(s: string): string {
  return s.replace(/[^A-Za-z0-9_]+/g, "_").replace(/^_+|_+$/g, "");
}

function scriptToolName(skillName: string, scriptFile: string): string {
  const base = scriptFile.replace(/\.[^.]+$/, "");
  return `${sanitize(skillName)}__${sanitize(base)}`;
}

const join = (...parts: string[]): string => parts.join("/").replace(/\/{2,}/g, "/");

/** Build the executable tools for a skill's bundled scripts. */
function buildScriptTools(
  skillName: string,
  skillDir: string,
  scripts: string[],
  execution: SkillExecutionContext,
): { headers: SkillToolHeader[]; tools: ToolInterface[] } {
  const tools = scripts.map((file) =>
    createTool({
      name: scriptToolName(skillName, file),
      description: `Run the bundled "${file}" script from the "${skillName}" skill.`,
      schema: z.object({
        args: z.record(z.any()).optional().describe("Arguments passed to the script."),
      }),
      needsApproval: true,
      approvalPrompt: `Run script ${file} from skill ${skillName}?`,
      func: (input: { args?: Record<string, unknown> }) =>
        execution.executeScript(join(skillDir, "scripts", file), input?.args ?? {}),
    }),
  );
  const headers = tools.map((t) => ({ name: t.name, description: t.description }));
  return { headers, tools };
}

async function loadOneSkill(
  fs: SkillFs,
  skillDir: string,
  fallbackName: string,
  execution: SkillExecutionContext | undefined,
  minModelTier: "small" | "large" | undefined,
): Promise<Skill | null> {
  let md: string;
  try {
    md = await fs.readFile(join(skillDir, "SKILL.md"));
  } catch {
    return null; // not a skill directory
  }

  const { metadata, body } = parseSkillFrontmatter(md);
  const name = (metadata.name as string) ?? fallbackName;
  const description = (metadata.description as string) ?? "";
  const tier = (metadata["min-model-tier"] as "small" | "large") ?? minModelTier;

  // Discover bundled scripts (best-effort).
  let scripts: string[] = asArray(metadata.scripts);
  if (scripts.length === 0) {
    try {
      scripts = await fs.listDir(join(skillDir, "scripts"));
    } catch {
      scripts = [];
    }
  }

  const built =
    execution && scripts.length > 0
      ? buildScriptTools(name, skillDir, scripts, execution)
      : { headers: [] as SkillToolHeader[], tools: [] as ToolInterface[] };

  const skill: Skill = {
    key: `skillmd:${name}`,
    title: name,
    header: description,
    prompt: body,
    needsSandbox: scripts.length > 0,
    listToolIndex: () => built.headers,
    bindTools: (names) =>
      names ? built.tools.filter((t) => names.includes(t.name)) : built.tools,
  };
  if (tier) skill.minModelTier = tier;
  return skill;
}

/**
 * Discover and load all SKILL.md skills under the configured roots. Returns
 * standard `Skill` objects ready to pass to `createSmartAgent({ skills })`.
 */
export async function loadSkillsFromDisk(opts: LoadSkillsOptions): Promise<Skill[]> {
  const skills: Skill[] = [];
  const seen = new Set<string>();

  for (const root of opts.roots) {
    let entries: string[];
    try {
      entries = await opts.fs.listDir(root);
    } catch {
      continue;
    }
    for (const entry of entries) {
      const skill = await loadOneSkill(
        opts.fs,
        join(root, entry),
        entry,
        opts.execution,
        opts.minModelTier,
      );
      if (skill && !seen.has(skill.key)) {
        seen.add(skill.key);
        skills.push(skill);
      }
    }
  }
  return skills;
}
