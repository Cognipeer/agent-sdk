# Skills API

Skills are the public API for progressive capability disclosure in `createSmartAgent(...)`. They are exported from the package root:

```ts
import {
  type Skill,
  type SkillPolicy,
  DEFAULT_SKILL_POLICY,
  SMALL_TIER_SKILL_POLICY,
} from "@cognipeer/agent-sdk";
```

## `Skill`

```ts
type Skill = {
  key: string;
  title: string;
  header: string;
  prompt: string | (() => Promise<string> | string);
  needsSandbox?: boolean;
  minModelTier?: "small" | "large";
  isAvailable?: () => boolean | Promise<boolean>;
  listToolIndex: () => Promise<SkillToolHeader[]> | SkillToolHeader[];
  bindTools: (names?: string[]) => Promise<ToolInterface[]> | ToolInterface[];
  rankToolHeaders?: (
    query: string,
    headers: SkillToolHeader[],
  ) => Promise<SkillToolHeader[]> | SkillToolHeader[];
  defaultBindNames?: string[];
};
```

### Fields

| Field | Purpose |
|---|---|
| `key` | Stable model-facing identifier, usually namespaced (`builtin:pdf`, `integration:github`, `mcp:jira`). |
| `title` | Human-readable title for operators and host UIs. |
| `header` | One-line description shown in `<available_skills>` before the skill is opened. |
| `prompt` | Extra operating instructions returned from `open_skill`. Use a function when the prompt depends on workspace state. |
| `needsSandbox` | Metadata returned by `open_skill`; host runtimes can use it to prepare a sandbox. |
| `minModelTier` | Hides `"large"` skills when `skillPolicy.modelTier === "small"`. |
| `isAvailable` | Availability gate for connected integrations, feature flags, or credentials. |
| `listToolIndex` | Cheap list of tool names and descriptions. Used to decide whether a skill is small or large. |
| `bindTools` | Returns concrete `ToolInterface` objects. With no names, bind the whole small skill. With names, bind only that subset. |
| `rankToolHeaders` | Optional ranking hook for large skills when `open_skill` receives a query. |
| `defaultBindNames` | Deterministic fallback subset for large skills when the model opens without a usable query. |

## `SkillToolHeader`

```ts
type SkillToolHeader = {
  name: string;
  description?: string;
};
```

`listToolIndex()` should return headers, not full tool objects. Keep this list cheap and stable.

## `SkillPolicy`

```ts
type SkillPolicy = {
  maxOpenSkills: number;
  maxBoundToolsPerSkill: number;
  maxBoundToolsTotal: number;
  modelTier?: "small" | "large";
};
```

Policy controls how much capability the model can reveal during one invoke:

- `maxOpenSkills`: maximum distinct skill keys the model can open.
- `maxBoundToolsPerSkill`: maximum tools bound from one `bind_skill_tools` request or one small skill open.
- `maxBoundToolsTotal`: total skill-bound tool budget across the run.
- `modelTier`: controls `minModelTier` filtering.

Defaults:

```ts
const DEFAULT_SKILL_POLICY = {
  maxOpenSkills: 4,
  maxBoundToolsPerSkill: 12,
  maxBoundToolsTotal: 40,
};

const SMALL_TIER_SKILL_POLICY = {
  maxOpenSkills: 1,
  maxBoundToolsPerSkill: 6,
  maxBoundToolsTotal: 18,
  modelTier: "small",
};
```

## `createSmartAgent` options

```ts
const agent = createSmartAgent({
  model,
  skills,
  skillPolicy: DEFAULT_SKILL_POLICY,
});
```

When `skills` is non-empty, the smart runtime automatically:

- filters skills by `isAvailable` and `skillPolicy.modelTier`
- injects `<available_skills>` into the system prompt
- registers `open_skill` and `bind_skill_tools`
- rebuilds the live runtime tool set after tools are bound
- keeps `get_tool_response` recovery variants from dropping bound skill tools

An empty `skills` array is a no-op and does not register the skill meta-tools.

## Built-in meta-tools

### `open_skill`

Schema:

```ts
{
  skillKey: string;
  query?: string;
}
```

Behavior:

- rejects unknown or unavailable skills
- enforces `maxOpenSkills` and `maxBoundToolsTotal`
- returns the skill prompt and `needsSandbox` metadata
- binds all tools for small skills
- returns a ranked `toolIndex` for large skills
- may bind `defaultBindNames` for large skills when no useful query is present

### `bind_skill_tools`

Schema:

```ts
{
  skillKey: string;
  toolNames: string[];
}
```

Behavior:

- requires `open_skill` to have been called for the skill
- caps `toolNames` to `maxBoundToolsPerSkill`
- appends newly bound tools by name, deduped against existing skill tools
- updates the live runtime tool set for later model turns in the same invoke

## Low-level helpers

These helpers are exported for tests and advanced integrations:

| Export | Purpose |
|---|---|
| `createSkillRegistryRef()` | Creates the per-invoke mutable registry used by the meta-tools. |
| `createSkillTools(deps)` | Creates `open_skill` and `bind_skill_tools` against a registry. |
| `createOpenSkillTool(deps)` | Creates only the opener meta-tool. |
| `createBindSkillToolsTool(deps)` | Creates only the binder meta-tool. |
| `resolveAvailableSkills(skills, opts)` | Applies availability and model-tier filtering. |
| `buildSkillHeaderBlock(skills)` | Builds the `<available_skills>` system prompt block. |
| `appendBoundTools(ref, tools, policy)` | Append-only, name-deduped registry mutation with total cap. |
| `composeToolSets(input)` | Rebuilds tool arrays with and without `get_tool_response`. |
| `canOpenSkill(ref, policy)` | Checks open/budget precedence before opening a distinct skill. |
| `dedupeToolsByName(tools)` | Keeps the first tool for each name. |

Most applications should only use `Skill`, `SkillPolicy`, and `createSmartAgent({ skills })`. Use low-level helpers when you are testing skill catalogs or building a custom smart-runtime wrapper.
