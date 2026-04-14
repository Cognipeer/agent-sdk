# Getting Started

Agent SDK exposes two usable entry points, and the right one depends on whether you want product-ready runtime behavior or the thinnest possible tool loop.

- `createSmartAgent` when you want adaptive planning, context compaction, memory syncing, and trace-friendly state.
- `createAgent` when you want a minimal deterministic loop without smart runtime prompt shaping.

## Who this guide is for

Use this guide if you need to answer these questions quickly:

1. What do I install to get the first working agent running?
2. Which runtime entry point should my product start from?
3. What should I expect to exist in `result.state` after the run?
4. How do I move from a toy example to a production integration without re-architecting the whole app?

## Install

```sh
npm install @cognipeer/agent-sdk zod
```

Optional (only if you use `fromLangchainModel`):

```sh
npm install @langchain/core @langchain/openai
```

Requirements:

- Node.js 18.17+
- A model adapter or native provider config
- A concrete decision about whether planning should be `off` or `todo` for your first integration

## Choose your model integration path

| Path | What you need | Best for |
|---|---|---|
| `createProvider` + `fromNativeProvider` | Just an API key | Zero-dependency production use |
| `fromLangchainModel` | `@langchain/core` + provider binding | Teams already using LangChain |
| Custom object | `invoke(messages[])` | Embedding into existing infra |

The native provider path is recommended for new integrations — it handles auth, SSE streaming, and token usage normalization for all providers with no additional dependencies.

## Choose the right starting point

| If you need... | Start with... | Why |
|---|---|---|
| Sensible defaults for real product work | `createSmartAgent` | You get profiles, plan sync, context compaction, and memory reads without assembling those behaviors manually. |
| Maximum control with minimal abstraction | `createAgent` | You keep only the base loop: model call, tool execution, limits, and finalize behavior. |
| Durable planning state that survives UI refreshes or resumes | `createSmartAgent` | The smart runtime synchronizes the canonical plan onto `state.plan`. |
| A debugging sandbox for provider behavior | `createAgent` | Fewer moving parts means fewer runtime heuristics to inspect. |

## First smart agent

### With native provider (recommended)

```ts
import { createSmartAgent, createTool, createProvider, fromNativeProvider } from "@cognipeer/agent-sdk";
import { z } from "zod";

const lookup = createTool({
	name: "lookup_owner",
	description: "Return the owner for a project code",
	schema: z.object({ code: z.enum(["ORBIT", "NOVA"]) }),
	func: async ({ code }) => ({ owner: code === "ORBIT" ? "Ada Lovelace" : "Grace Hopper" }),
});

const model = fromNativeProvider(
	createProvider({ provider: "openai", apiKey: process.env.OPENAI_API_KEY! }),
	{ model: "gpt-4o" },
);

const agent = createSmartAgent({
	name: "Assistant",
	model,
	tools: [lookup],
	runtimeProfile: "balanced",
	planning: { mode: "todo" },
	limits: { maxToolCalls: 6, maxContextTokens: 12000 },
	tracing: { enabled: true },
});
```

### With LangChain adapter

```ts
import { createSmartAgent, createTool, fromLangchainModel } from "@cognipeer/agent-sdk";
import { ChatOpenAI } from "@langchain/openai";
import { z } from "zod";

const lookup = createTool({
	name: "lookup_owner",
	description: "Return the owner for a project code",
	schema: z.object({ code: z.enum(["ORBIT", "NOVA"]) }),
	func: async ({ code }) => ({ owner: code === "ORBIT" ? "Ada Lovelace" : "Grace Hopper" }),
});

const agent = createSmartAgent({
	name: "Assistant",
	model: fromLangchainModel(new ChatOpenAI({ model: "gpt-4o-mini" })),
	tools: [lookup],
	runtimeProfile: "balanced",
	planning: { mode: "todo" },
	limits: { maxToolCalls: 6, maxContextTokens: 12000 },
	tracing: { enabled: true },
});

const result = await agent.invoke({
	messages: [{ role: "user", content: "Compare ORBIT and NOVA." }],
}, {
	onEvent: (event) => {
		if (event.type === "plan") {
			console.log(event.operation, event.version, event.todoList?.length ?? 0);
		}
	},
});

console.log(result.content);
console.log(result.state?.plan?.steps);
```

## What this example actually proves

1. The runtime can bind typed tools and still keep the transcript message-first.
2. Planning is available, but still adaptive. The runtime does not force a todo list for every prompt.
3. If a plan is created or updated, the durable representation ends up on `result.state.plan`.
4. If context pressure builds, the smart wrapper can summarize while preserving recovery paths for raw tool output.
5. With tracing enabled, you can inspect the run without instrumenting the whole loop yourself.

## What the smart runtime adds on top of the base loop

| Capability | `createAgent` | `createSmartAgent` |
|---|---|---|
| System prompt composition | Manual | Built in |
| Planning tool injection | Manual | Built in when planning is enabled |
| Context summarization | Manual | Built in through smart runtime config |
| Memory facts sync | No | Yes |
| Canonical `state.plan` sync | No | Yes |
| Runtime profiles | No | Yes |

## What to inspect after your first run

Check these surfaces before you move on:

- `result.content`: the final assistant answer.
- `result.state.plan`: the durable plan, if planning was used.
- `result.state.summaryRecords`: evidence that the runtime compacted prior context.
- `result.state.memoryFacts`: facts reloaded from memory policy.

This is the minimum sanity check that tells you whether the runtime is behaving as an operational system instead of just returning text.

## Minimal loop example

```ts
const agent = createAgent({
	model,
	tools: [lookup],
	limits: { maxToolCalls: 4 },
});
```

Use this variant when you do not want prompt injection, runtime profiles, or any smart-runtime heuristics. It is especially useful when you are validating model behavior, testing tool contract quality, or embedding the SDK inside another orchestration layer that already owns planning and memory.

## Recommended first integration path

1. Start with `createSmartAgent` and the `balanced` profile.
2. Explicitly choose `planning: { mode: "todo" }` only if the user journey includes genuine multi-step work.
3. Turn on tracing from day one so you can see whether the agent is over-tooling or summarizing too aggressively.
4. Only move to `runtimeProfile: "custom"` after you can explain which built-in preset is close but not correct.

That order matters. Teams often customize limits too early and lose the benefit of the preset tradeoffs.

## Next steps

- [Native Providers](/guide/native-providers)
- [Core Concepts](/guide/core-concepts)
- [Architecture](/guide/architecture)
- [Planning Guide](/guide/planning)
- [API Reference](/api/agent)
