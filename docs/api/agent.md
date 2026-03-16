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
- `watchdog`: token drift and over-tooling response
- `tracing`: execution telemetry
- `outputSchema`: deterministic structured output

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
- watchdog telemetry such as token drift and context rot

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
- `state.watchdog`

If you are using the smart runtime, prefer `state.plan` over any event-only or legacy todo mental model.
