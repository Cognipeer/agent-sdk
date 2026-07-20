# Sub-Agents

Dynamic problem decomposition: the orchestrator agent delegates self-contained subtasks to focused child agents — predefined (registry), created on the fly (ad-hoc), or fanned out concurrently.

<div class="example-meta"><a class="example-source-link" href="https://github.com/Cognipeer/agent-sdk/blob/main/examples/sub-agents/sub-agents.ts" target="_blank" rel="noreferrer">Open source: examples/sub-agents/sub-agents.ts</a></div>

## Use this when
- a task naturally splits into independent or specialist subtasks
- you want a focused child context per subtask instead of one bloated transcript
- you want to run several subtasks in parallel and aggregate the results

## What it shows
- `delegate_to(subagent, input)` — a predefined registry sub-agent
- `spawn_subagent({ role, prompt, input, tools? })` — an ad-hoc specialist defined at runtime
- `spawn_subagents_parallel({ tasks })` — concurrent fan-out
- `subagent` lifecycle events (`start` / `result` / `error` / `paused`)
- a sub-agent borrowing a parent tool by name (`tools: ["search"]`)

## Run it
```bash
cd examples
npm run example:sub-agents
```

The example ships a scripted fake model so it runs without any API key. Set `OPENAI_API_KEY` and swap in a real model to see the orchestrator decide for itself when to delegate.

## How it works
- Pass `subagents: SubagentDef[]` and/or `subagentPolicy` to `createSmartAgent`. The agent then exposes the three tools and an `<available_subagents>` catalog in its system prompt.
- Children are **model-agnostic**: they reuse the parent model unless a `SubagentDef.model` override is given.
- Children inherit the parent's event / streaming / cancellation / tracing wiring, so progress surfaces to your host.
- Spawning is guarded by `subagentPolicy` (`maxDepth`, `maxChildCalls`, `maxParallel`, `childContextPolicy`).

## Human-in-the-loop
A tool-approval or `ask_user_question` pause **inside a sequential** sub-agent (`delegate_to` / `spawn_subagent`) is surfaced to the parent. Resolve it at the parent level with `agent.resolveToolApproval(...)` / `agent.resolveUserQuestion(...)` and re-invoke — the child resumes transparently. Parallel children may not request human input.

## Common failure modes
- `child-call budget exhausted` — raise `subagentPolicy.maxChildCalls`.
- `delegation depth limit reached` — raise `subagentPolicy.maxDepth`.
- An ad-hoc sub-agent can't find a tool — make sure the name is in the parent's tool set and `allowAdhocTools` is `true`.
