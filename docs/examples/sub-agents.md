---
title: Sub-Agents
---

# Sub-Agents

Dynamic problem decomposition: an orchestrator delegates self-contained subtasks to focused child agents — predefined (registry), created on the fly (ad-hoc), or fanned out concurrently.

<div class="example-meta"><a class="example-source-link" href="https://github.com/Cognipeer/agent-sdk/blob/main/examples/sub-agents/sub-agents.ts" target="_blank" rel="noreferrer">Open source: examples/sub-agents/sub-agents.ts</a></div>

## Use this when
- a task splits into independent or specialist subtasks
- you want a focused child context per subtask instead of one bloated transcript
- you want to run several subtasks in parallel and aggregate results

## What it shows
- `delegate_to(subagent, input)` — a predefined registry sub-agent
- `spawn_subagent({ role, prompt, input, tools? })` — an ad-hoc specialist
- `spawn_subagents_parallel({ tasks })` — concurrent fan-out
- `subagent` lifecycle events and a child borrowing a parent tool by name

## Run it
```bash
cd examples
npm run example:sub-agents
```

The example ships a scripted fake model, so it runs without an API key. Set `OPENAI_API_KEY` and swap in a real model to let the orchestrator decide when to delegate.

## Core code
```ts
import { createSmartAgent, createTool, type SubagentDef } from "@cognipeer/agent-sdk";
import { z } from "zod";

const search = createTool({
  name: "search",
  description: "Search a knowledge base",
  schema: z.object({ q: z.string() }),
  func: async ({ q }) => ({ q, hits: [`result for ${q}`] }),
});

const researcher: SubagentDef = {
  name: "researcher",
  header: "gathers facts for a question",
  systemPrompt: "You are a focused researcher. Answer concisely.",
  tools: ["search"], // borrow the parent's tool by name
};

const agent = createSmartAgent({
  model,
  tools: [search],
  subagents: [researcher],
  subagentPolicy: { mode: "registry_and_adhoc", maxDepth: 2, maxChildCalls: 8, maxParallel: 4, childContextPolicy: "scoped", allowAdhocTools: true },
});

const res = await agent.invoke(
  { messages: [{ role: "user", content: "Research the capital of Germany, verify it, then summarize." }] },
  { onEvent: (e) => { if (e.type === "subagent") console.log(`[${e.phase}] ${e.name}`, e.content ?? ""); } },
);
console.log(res.content);
```

## Expected output
- `subagent` events print for each delegated run (`start` → `result`)
- the parent's final answer reflects the aggregated sub-agent results

## Common failure modes
- `child-call budget exhausted` → raise `subagentPolicy.maxChildCalls` (a delegation refused by a `subagentStart` plugin does not use it up)
- `delegation depth limit reached` → raise `subagentPolicy.maxDepth`
- `Unknown tool name(s) for the sub-agent` → ad-hoc `tools` must be exact names of the parent's tools, and `allowAdhocTools` must be `true`
- the parent presents a child's partial work as complete → read `status` (`incomplete`, `blocked`, `needs_input`, `cancelled`, `error`) on the result; the model is told to treat anything but `ok` as not done
- child text shows up in your UI as the parent's answer → it does not by default; with `subagentPolicy.streamChildren: true` filter chunks that carry `subagentName`
- the parent stops mid-turn on `maxCostUsd` after a child spent a lot → the child's calls are in the parent's `state.usage` (entries tagged `subagent`); give the child its own `limits` to bound it separately

## See also
- [Sub-Agents guide](/guide/sub-agents)
- [Multi-Agent (`asTool`)](/examples/multi-agent) · [Handoff](/examples/handoff)
