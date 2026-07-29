---
title: Skills & Progressive Disclosure
permalink: /skills/
---

# Skills & Progressive Disclosure

Skills are lazy capability bundles for `createSmartAgent(...)`. They let you keep a large integration or domain tool catalog available without binding every tool on every model turn.

Use skills when the agent has many possible capabilities but only needs a few for any one task: MCP apps, optional workspace integrations, document-processing bundles, code/sandbox workflows, or large internal tool catalogs.

If you only have a handful of tools, pass them directly through `tools`. Skills are for reducing prompt/tool pressure, not for hiding simple tool definitions behind extra indirection.

## The mental model

With normal tools, the model sees the whole tool catalog up front.

With skills:

1. You pass a `skills` catalog to `createSmartAgent(...)`.
2. The runtime filters the catalog by `isAvailable` and `minModelTier`.
3. The model discovers the catalog — by default through a cheap `<available_skills>` block with each skill key and one-line header. See [Discovery](#discovery-catalog-or-search).
4. The runtime exposes two meta-tools: `open_skill` and `bind_skill_tools`.
5. The model calls `open_skill(skillKey)` when the task needs that capability.
6. Small skills bind their tools immediately. Large skills return a tool index, then the model calls `bind_skill_tools(skillKey, toolNames)` for the subset it needs.

Opened skills stay available for the rest of the invoke. The registry is per invoke, append-only, and deduped by tool name.

## Discovery: catalog or search

`skillPolicy.disclosure` decides how the model learns which skills exist.

| | `"catalog"` (default) | `"search"` |
| --- | --- | --- |
| System prompt | `<available_skills>` block, one line per skill | nothing |
| Prompt cost | grows with the catalog, paid on every turn | constant |
| Discovery | free, the model just reads it | one `search_skills` call |
| Extra tool | — | `search_skills` |

Stay on `"catalog"` for a small, curated, mostly-relevant catalog: discovery costs nothing and the model cannot miss a skill.

Switch to `"search"` when the catalog is large, workspace-supplied, or mostly irrelevant to any one conversation — a tenant with 40 installed skills should not pay for 40 header lines on every turn of every conversation:

```ts
const agent = createSmartAgent({
  model,
  skills,
  skillPolicy: { ...DEFAULT_SKILL_POLICY, disclosure: "search" },
});
```

The model then calls `search_skills({ query: "convert a docx to pdf" })`, gets back matching `skillKey`s, and opens one. An empty query lists what is available. Ranking is a pure, deterministic keyword/prefix match over key, title and header — no embeddings, no I/O (`searchSkills` is exported if you want it directly).

A query that matches nothing also returns the head of the catalog rather than an empty result. That is what keeps a Turkish question usable against an English-authored catalog: the lexical ranker cannot bridge languages, but the model reading those headers can.

Two consequences worth knowing:

- **Discovery is no longer guaranteed.** Nothing in the prompt says skills exist, so a model that never calls `search_skills` never finds them. The tool description carries that weight; if you override it via `promptHooks.toolDescriptions`, keep it explicit about what a skill is and when to look.
- **Availability is resolved lazily**, inside the tool call, instead of once per invoke while assembling the block. An integration that connects mid-run shows up on the next search.

## Define a skill

```ts
import { createSmartAgent, createTool, type Skill } from "@cognipeer/agent-sdk";
import { z } from "zod";

const pdfRead = createTool({
  name: "pdf_read",
  description: "Extract text from a PDF file by file id",
  schema: z.object({ fileId: z.string().min(1) }),
  func: async ({ fileId }) => ({ fileId, text: "..." }),
});

const pdfSummarize = createTool({
  name: "pdf_summarize",
  description: "Summarize extracted PDF text",
  schema: z.object({ text: z.string().min(1) }),
  func: async ({ text }) => ({ summary: text.slice(0, 200) }),
});

const pdfSkill: Skill = {
  key: "builtin:pdf",
  title: "PDF",
  header: "read and summarize PDF files when the user references a PDF",
  prompt: "Use pdf_read before pdf_summarize. Preserve file ids in your final answer.",
  listToolIndex: () => [
    { name: "pdf_read", description: "Extract PDF text by file id" },
    { name: "pdf_summarize", description: "Summarize extracted PDF text" },
  ],
  bindTools: (names) => {
    const tools = [pdfRead, pdfSummarize];
    if (!names) return tools;
    const requested = new Set(names);
    return tools.filter((tool) => requested.has(tool.name));
  },
};

const agent = createSmartAgent({
  model,
  skills: [pdfSkill],
  runtimeProfile: "balanced",
});
```

When the run starts, the model sees the skill header and the meta-tools. It does not see `pdf_read` or `pdf_summarize` until it opens the skill.

## Small and large skills

The runtime treats a skill as small when `listToolIndex()` returns no more than `skillPolicy.maxBoundToolsPerSkill` headers. Opening a small skill binds all of its tools in one step.

Large skills return an index instead:

```ts
const jiraSkill: Skill = {
  key: "mcp:jira",
  title: "Jira",
  header: "search, create, and update Jira issues when project work involves tickets",
  prompt: "Prefer read-only Jira tools unless the user explicitly asks to change an issue.",
  listToolIndex: () => jiraToolHeaders,
  bindTools: (names) => names?.map((name) => jiraToolsByName.get(name)).filter(Boolean) ?? [],
  rankToolHeaders: async (query, headers) => rankWithEmbeddings(query, headers),
  defaultBindNames: ["jira_search_issues", "jira_get_issue"],
};
```

For large skills:

- `open_skill` returns up to 40 tool headers.
- `rankToolHeaders` can reorder the index for the task query.
- `bind_skill_tools` caps each request at `skillPolicy.maxBoundToolsPerSkill`.
- `defaultBindNames` provides a deterministic fallback when the model opens the skill without a useful query.

## Availability and model tiering

Use `isAvailable` for workspace-specific gates such as connected integrations, feature flags, or missing credentials:

```ts
const githubSkill: Skill = {
  key: "integration:github",
  title: "GitHub",
  header: "inspect repositories and manage issues when GitHub is connected",
  prompt: "Use read-only tools first. Ask for approval before write operations.",
  isAvailable: async () => Boolean(await getGithubConnection(workspaceId)),
  listToolIndex: () => githubToolHeaders,
  bindTools: (names) => bindGithubTools(names),
};
```

Unavailable skills are omitted from `<available_skills>` (or from `search_skills` results under `disclosure: "search"`), and `open_skill` re-checks availability at call time.

Use `minModelTier: "large"` for skills that should be hidden from small-tier models:

```ts
const migrationSkill: Skill = {
  key: "builtin:large-migration",
  title: "Large Migration",
  header: "coordinate multi-repository code migrations",
  minModelTier: "large",
  prompt: "Plan first, then bind only the repository tools needed for the next step.",
  listToolIndex: () => migrationToolHeaders,
  bindTools: (names) => bindMigrationTools(names),
};
```

Then choose a policy:

```ts
import { SMALL_TIER_SKILL_POLICY } from "@cognipeer/agent-sdk";

const agent = createSmartAgent({
  model,
  skills,
  skillPolicy: SMALL_TIER_SKILL_POLICY,
});
```

## Policy defaults

`DEFAULT_SKILL_POLICY` is tuned for normal smart-agent runs:

```ts
{
  maxOpenSkills: 4,
  maxBoundToolsPerSkill: 12,
  maxBoundToolsTotal: 40,
}
```

`SMALL_TIER_SKILL_POLICY` is stricter:

```ts
{
  maxOpenSkills: 1,
  maxBoundToolsPerSkill: 6,
  maxBoundToolsTotal: 18,
  modelTier: "small",
}
```

Override these when your host application has stronger limits:

```ts
const agent = createSmartAgent({
  model,
  skills,
  skillPolicy: {
    maxOpenSkills: 2,
    maxBoundToolsPerSkill: 8,
    maxBoundToolsTotal: 24,
    modelTier: "large",
  },
});
```

## Sandbox metadata

Set `needsSandbox: true` for capabilities that require an execution environment:

```ts
const codeSkill: Skill = {
  key: "builtin:code",
  title: "Code Workspace",
  header: "inspect and modify code when the user asks for implementation work",
  prompt: "Open files before editing. Keep changes focused and verify them.",
  needsSandbox: true,
  listToolIndex: () => codeToolHeaders,
  bindTools: (names) => bindCodeTools(names),
};
```

`open_skill` returns `needsSandbox` in its tool result. The SDK keeps that as metadata; your host runtime can use it to bootstrap or route work to a sandboxed environment.

## Best practices

- Keep `key` stable and namespace it (`builtin:*`, `integration:*`, `mcp:*`).
- Make `header` a one-line "what and when to use" instruction.
- Keep `prompt` focused on operating rules after the skill is opened, not a full manual.
- Make `listToolIndex()` cheap; it may run before any concrete tool is bound.
- Make `bindTools(names)` honor the requested names for large skills.
- Avoid tool-name collisions across skills. The registry dedupes by name and keeps the first tool.
- Use `isAvailable` instead of exposing disconnected integrations.
- Prefer direct `tools` for tiny always-on capabilities.

## How this interacts with state

Skill binding is runtime behavior, not durable application state. Persist your `skills` catalog in application configuration and pass it into every `createSmartAgent(...)` construction. Do not rely on `openedSkillKeys` or bound skill tools as resume storage; the registry is intentionally per invoke.

Tool calls from skill-bound tools still appear in `state.toolHistory`, tracing, and normal tool messages once they execute. The skill registry only controls which tools are available to the model during the run.
