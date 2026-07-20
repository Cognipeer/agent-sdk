---
title: Sub-Agents & Dynamic Delegation
permalink: /sub-agents/
---

# Sub-Agents & Dynamic Delegation

Sub-agents let a `createSmartAgent(...)` orchestrator decompose a hard problem by delegating self-contained subtasks to focused child agents. Each child runs with an **isolated context** and returns a concise result, so the orchestrator's transcript stays small while the real work happens in scoped, single-purpose runs.

Sub-agents are **opt-in**: a plain `createSmartAgent({ model })` gets no spawn tools. They are wired only when you pass `subagents` and/or `subagentPolicy`. When enabled, there are three disclosure modes, and the policy default is **hybrid** (`registry_and_adhoc`):

- **Registry** — predefined, named sub-agents the model invokes with `delegate_to(subagent, input)`.
- **Ad-hoc** — the orchestrator writes a `role` + `prompt` + tool subset at runtime with `spawn_subagent({ role, prompt, input, tools? })`.
- **Parallel** — independent subtasks fan out concurrently with `spawn_subagents_parallel({ tasks })`.

Sub-agents reuse the existing [delegation](/guide/tool-heavy-agents) guards (`maxDepth`, `maxChildCalls`, `childContextPolicy`) and are a higher-level sibling of [`asTool` / `asHandoff`](/examples/multi-agent): `asTool` wires one statically-built agent as a tool; the sub-agent primitive lets the model spawn and fan out children on demand.

## Quick start

```ts
import { createSmartAgent, createTool, type SubagentDef } from "@cognipeer/agent-sdk";
import { z } from "zod";

const search = createTool({
  name: "search",
  description: "Search a knowledge base",
  schema: z.object({ q: z.string() }),
  func: async ({ q }) => ({ q, hits: ["..."] }),
});

const researcher: SubagentDef = {
  name: "researcher",
  header: "gathers facts for a question",       // shown in the catalog the model sees
  systemPrompt: "You are a focused researcher. Answer concisely.",
  tools: ["search"],                            // borrow parent tools by name
  // model: someOtherModel,                      // optional; defaults to the parent model
};

const agent = createSmartAgent({
  model,                                         // any provider — children inherit it
  tools: [search],
  subagents: [researcher],
  runtimeProfile: "balanced",
});
```

The agent now exposes `delegate_to`, `spawn_subagent`, and `spawn_subagents_parallel`, plus an `<available_subagents>` block in its system prompt listing each registry sub-agent's `header`.

## The `SubagentDef`

```ts
type SubagentDef = {
  name: string;                 // stable id used by delegate_to
  header: string;               // one-line "what + when" shown in the catalog
  title?: string;
  systemPrompt?: string;        // the child's role prompt (fully under your control)
  tools?: ToolInterface[] | string[] | (() => ToolInterface[] | Promise<ToolInterface[]>);
  model?: any;                  // optional override; defaults to the parent model
  outputSchema?: ZodSchema;     // optional JSON output contract for the child
  limits?: AgentLimits;
  childContextPolicy?: "minimal" | "scoped" | "full";  // override the policy default
  isAvailable?: () => boolean | Promise<boolean>;       // hide from the catalog when false
  metadata?: Record<string, any>;
};
```

`tools` accepts concrete tools, a list of **parent tool names** to borrow, or a lazy builder. When omitted the child runs tool-free (pure reasoning).

## Policy

```ts
import { DEFAULT_SUBAGENT_POLICY } from "@cognipeer/agent-sdk";

const agent = createSmartAgent({
  model,
  subagents: [/* ... */],
  subagentPolicy: {
    mode: "registry_and_adhoc",   // "off" | "registry_only" | "registry_and_adhoc"
    maxDepth: 2,                   // nesting limit (shares the delegation depth counter)
    maxChildCalls: 8,              // total spawn budget per run
    maxParallel: 4,               // fan-out width for spawn_subagents_parallel
    childContextPolicy: "scoped", // how much parent context each child sees
    allowAdhocTools: true,         // may ad-hoc spawns borrow parent tools by name
  },
});
```

`childContextPolicy` controls how the child's initial messages are seeded (shared with `asTool`):

- `minimal` — only the task `input` (default for a clean, isolated child).
- `scoped` — the last user turn + the input.
- `full` — the entire parent transcript + the input.

The parent's system prompt is never carried into a child — each child composes its own from its `SubagentDef.systemPrompt` (or ad-hoc `role`/`prompt`).

::: tip Nesting
Children do **not** inherit sub-agents by default: the orchestrator's spawn tools are not re-exposed to its children, so a child cannot recurse on its own. To build a hierarchy, give a sub-agent its own registry by wrapping a pre-built `createSmartAgent({ subagents: [...] })` as a tool, or delegate across agents with [`asTool`](/examples/multi-agent). `maxDepth` is the hard backstop for any nested delegation.
:::

## Parallel fan-out

```ts
// The model emits this tool call:
spawn_subagents_parallel({
  tasks: [
    { subagent: "researcher", input: "Find the population of Berlin." },
    { role: "translator", prompt: "Translate to German.", input: "Translate: ..." },
  ],
})
// → returns { results: [ { name, mode, content, ... }, ... ] } in task order.
```

Up to `maxParallel` children run concurrently. Parallel children **may not request human input** — route any approval / ask-user subtask through `delegate_to` or `spawn_subagent` instead.

## Model-agnostic

Children are provider-agnostic. A child uses its `SubagentDef.model` when given, otherwise the parent's model — so a single agent definition works across OpenAI, Anthropic, Bedrock, Vertex, Azure, and any [native provider](/guide/native-providers).

## Events, streaming & cancellation

Each spawn emits a `subagent` lifecycle event and forwards the child's own events (stamped with `subagentName` / `subagentId`):

```ts
await agent.invoke(input, {
  stream: true,
  onStream: (chunk) => process.stdout.write(chunk.text),  // child tokens stream too
  onEvent: (e) => {
    if (e.type === "subagent") {
      console.log(`[${e.phase}] ${e.name}`, e.content ?? "");
    }
  },
  cancellationToken,  // cancelling the parent cancels in-flight children
});
```

`SubagentEvent.phase` is `"start" | "result" | "error" | "paused"`. The child's terminal `finalAnswer` / `metadata` events are **not** forwarded (so a child completion is never mistaken for the parent's) — use the `subagent` `result` phase instead.

## Human-in-the-loop

A tool-approval (`needsApproval`) or `ask_user_question` pause **inside a sequential** sub-agent is surfaced to the parent. The parent pauses with the child's pending entry in `state.pendingApprovals` / `state.pendingUserQuestions` (tagged with `metadata.__subagent`). Resolve at the parent level and re-invoke — the child resumes transparently:

```ts
const paused = await agent.invoke(input);
if (paused.state?.pendingApprovals?.length) {
  const { id } = paused.state.pendingApprovals[0];
  const resumed = agent.resolveToolApproval(paused.state, { id, approved: true });
  const done = await agent.invoke(resumed);
}
```

The child's paused state is held in `state.ctx.__subagentPending`, keyed by the parent tool-call. In-memory pause/resume (resolve + re-invoke on the same state) is fully supported; see [Pause & Resume](/examples/pause-resume) and [Tool Approvals](/guide/tool-approvals). A delegating tool can pause even when the model emitted other tool calls in the same turn, and if two delegations pause at once they drain one per resume round (resolve `state.pendingApprovals` / `state.pendingUserQuestions` and re-invoke until none remain).

## Overriding the prompts

All of the sub-agent prompt surfaces are interceptable through `promptHooks` (see [prompt overrides](#prompt-overrides) below):

```ts
const agent = createSmartAgent({
  model,
  subagents: [researcher],
  promptHooks: {
    // Rewrite a built-in tool description.
    toolDescriptions: {
      delegate_to: (def) => def + "\nPrefer the researcher for factual questions.",
    },
    // Rewrite the <available_subagents> catalog block.
    subagentCatalog: (block) => block.replace("Delegate self-contained", "DELEGATE self-contained"),
    // Rewrite the whole system prompt last.
    transformSystemPrompt: (prompt) => prompt + "\nAlways cite which sub-agent produced each fact.",
  },
});
```

### Prompt overrides {#prompt-overrides}

`promptHooks` works for any `createSmartAgent`, not just sub-agents:

- `transformSystemPrompt(prompt, { agentName })` — final rewrite of the composed system prompt.
- `toolDescriptions` — override any built-in tool description by name (`delegate_to`, `spawn_subagent`, `spawn_subagents_parallel`, `open_skill`, `bind_skill_tools`, `ask_user_question`, `get_tool_response`, …). A string replaces; a function receives the default.
- `subagentCatalog(defaultBlock, subagents)` — override the `<available_subagents>` block.

Overrides clone any affected tool so shared tool objects are never mutated across invokes.

## See also

- [Multi-Agent (`asTool`)](/examples/multi-agent) and [Handoff](/examples/handoff)
- [Skills & Progressive Disclosure](/guide/skills)
- [Sub-Agents example](/examples/sub-agents)
