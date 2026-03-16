# Basic Agent

This is the smallest end-to-end example in the repository. Open it first if you want to understand the raw agent loop before any smart runtime features are added.

<div class="example-meta"><a class="example-source-link" href="https://github.com/Cognipeer/agent-sdk/blob/main/examples/basic/basic.ts" target="_blank" rel="noreferrer">Open source: examples/basic/basic.ts</a></div>

## Use this when

- you want the minimum code needed to build and run an agent
- you want to understand how tools are executed in the base loop
- you want a clean reference before reading planning or summarization examples

## What it shows

- smart agent construction
- model adapter setup
- one or more typed tools
- a single invocation from user message to final answer

## Run it

```bash
cd examples
npm run example:basic
```

If `OPENAI_API_KEY` is not set, the script falls back to a fake model so the control flow stays observable offline.

## Core code

```ts
import { createAgent, createTool, fromLangchainModel } from "@cognipeer/agent-sdk";
import { ChatOpenAI } from "@langchain/openai";
import { z } from "zod";

const echo = createTool({
	name: "echo",
	description: "Echo back",
	schema: z.object({ text: z.string().min(1) }),
	func: async ({ text }) => ({ echoed: text }),
});

const model = fromLangchainModel(new ChatOpenAI({ model: "gpt-4o-mini", apiKey }));

const agent = createAgent({
	model,
	tools: [echo],
	limits: { maxToolCalls: 3 },
});

const res = await agent.invoke({
	messages: [{ role: "user", content: "say hi via echo" }],
});
```

## End-to-end flow

1. A user message asks the agent to say hi via the `echo` tool.
2. The model decides to call `echo`.
3. The runtime validates input against the Zod schema and executes the tool.
4. The tool result is appended to the message history.
5. The model produces the final assistant answer.

## What to inspect

- how the model is wrapped
- how tools are passed into the runtime
- what the initial `messages` state looks like
- what comes back on `result.content` and `result.state`

## Why this example matters

Everything else in the Examples section builds on this shape. If the base loop is not clear, smart runtime behavior will look more magical than it really is.

## Expected output

- the console prints a final assistant reply such as `done`
- metadata is printed so you can inspect usage or adapter-level result details
- if the fake model path is used, the tool call flow is still visible without a provider key

## Common failure modes

- `OPENAI_API_KEY` is missing and you expected a real provider run: the script will fall back to a fake model instead
- the tool schema changes but the fake model arguments are not updated: the run will fail validation
