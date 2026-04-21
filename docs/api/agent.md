# Agent Construction

The SDK exposes two construction entry points, and choosing the right one is the first important API decision.

## Choose the builder

| Builder | Use it when... |
|---|---|
| `createAgent(...)` | you want the minimal loop and will own prompts, planning, and context behavior yourself |
| `createSmartAgent(...)` | you are building an autonomous or semi-autonomous agent that needs profiles, planning, summarization, memory, and better operational defaults |

## `createSmartAgent(...)`

```ts
function createSmartAgent<TOutput = unknown>(options: SmartAgentOptions): SmartAgentInstance<TOutput>
```

### Key option groups

- `model`: the model adapter used by the runtime
- `tools`: local or adapted tools
- `runtimeProfile`: built-in preset or `custom`
- `planning`: explicit multi-step workflow control
- `summarization`, `context`, `toolResponses`: context pressure handling
- `memory`: fact read/write policy
- `delegation`: child-agent behavior
- `tracing`: execution telemetry
- `outputSchema`: deterministic structured output

### Tool response retention

`toolResponses` controls how tool payloads are stored in history and re-presented to the model under context pressure. Retention is lazy: tool outputs are stored in full in `toolHistory` and are only rewritten when the summarizer runs.

- `defaultPolicy` is applied by the summarizer to non-critical tool messages. Valid values: `keep_full`, `keep_structured`, `summarize_archive`, `drop`. Default is `summarize_archive`.
- `toolResponseRetentionByTool` overrides the default policy on a per-tool basis and always wins.
- `criticalTools` is the set of tool names that are never reduced. The default list covers `response`, `manage_todo_list`, and `get_tool_response`.
- `maxToolResponseChars` and `maxToolResponseTokens` only drive an eager hard-cap truncation when a single non-critical tool output is oversized. Truncated heads always point at `get_tool_response` for recovery.
- `schemaValidation` and `retryOnSchemaError` control Zod-based tool input validation.

Resolution order at summarization time: critical tool &rarr; per-tool override &rarr; default policy. The full payload is always recoverable through `get_tool_response` using the execution id embedded in the placeholder.

### Example

```ts
import { createSmartAgent, createTool, fromLangchainModel } from "@cognipeer/agent-sdk";
import { ChatOpenAI } from "@langchain/openai";
import { z } from "zod";

const lookup = createTool({
  name: "lookup_project",
  description: "Return project facts",
  schema: z.object({ code: z.string() }),
  func: async ({ code }) => ({ code, owner: "Ada Lovelace", risk: "low" }),
});

const agent = createSmartAgent({
  name: "ProjectAssistant",
  model: fromLangchainModel(new ChatOpenAI({ model: "gpt-4o-mini" })),
  tools: [lookup],
  runtimeProfile: "balanced",
  planning: { mode: "todo" },
  toolResponses: {
    defaultPolicy: "summarize_archive",
    toolResponseRetentionByTool: { lookup: "keep_full" },
  },
  limits: { maxToolCalls: 8, maxContextTokens: 12000 },
  tracing: { enabled: true },
});
```

### Why smart runtime users care

`createSmartAgent(...)` is the entry point you usually want for autonomous agents because it manages:

- adaptive planning
- model-facing context shaping
- summarization and archival
- memory fact sync
- canonical `state.plan` updates
- built-in archived tool-response retrieval via `get_tool_response`

## `createAgent(...)`

```ts
function createAgent<TOutput = unknown>(options: AgentOptions): AgentInstance<TOutput>
```

Use this when you want the smallest deterministic loop and do not want smart runtime behavior to wrap the model call.

```ts
const agent = createAgent({
  model,
  tools: [lookup],
  limits: { maxToolCalls: 4 },
});
```

`createAgent(...)` still supports tools, approvals, handoffs, tracing, and structured output. It simply leaves planning and context strategy up to you.

Unlike `createSmartAgent(...)`, the base builder does not automatically register `get_tool_response`. If you plan to archive or drop tool outputs in a base agent, provide your own retrieval strategy or keep those outputs inline.

## Shared instance methods

Both builders expose more than `invoke(...)`:

- `invoke(state, config?)`
- `snapshot(state, options?)`
- `resume(snapshot, options?)`
- `resolveToolApproval(state, resolution)`
- `asTool(options?)`
- `asHandoff(options?)`

These methods matter if your agent is long-running, approval-gated, resumable, or composed into a bigger agent system.

## `invoke(...)`

```ts
agent.invoke(state, config?)
```

Important `InvokeConfig` hooks:

- `onEvent(event)` for tool, plan, trace, and handoff visibility
- `onStateChange(state)` for pause and checkpoint workflows
- `checkpointReason` to annotate why a snapshot was taken

## Result shape

```ts
type AgentInvokeResult<TOutput = unknown> = {
  content: string;
  output?: TOutput;
  messages: Message[];
  state?: SmartState;
  metadata?: { usage?: any };
}
```

## State surfaces worth integrating

- `state.messages`
- `state.toolHistory`
- `state.toolHistoryArchived`
- `state.plan`
- `state.planVersion`
- `state.summaryRecords`
- `state.memoryFacts`

If you are using the smart runtime, prefer `state.plan` over any event-only or legacy todo mental model.
