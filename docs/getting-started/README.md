---
title: Getting Started
nav_order: 3
permalink: /getting-started/
---

# Getting Started

This guide helps you install, configure, and run your first agent. Two entry points are available:

- **`createSmartAgent`** – batteries-included loop with planning, summarization, context tools, and structured-output helpers.
- **`createAgent`** – minimal control loop with no system prompt or summarization so you can orchestrate everything yourself.
## Prerequisites

- Node.js >= 18 (recommended LTS)
- A supported model provider API key (e.g. `OPENAI_API_KEY`) **or** a fake model for offline experimentation.
- Package manager: npm, pnpm, or yarn (examples use npm).
## Why this agent?

- Structured output enforcement via Zod schemas.
- Safe tool limits (total + parallel) with finalize messaging.
- Planning/TODO mode, summarization, and context tools when using `createSmartAgent`.
- Built-in multi-agent composition (`asTool`, `asHandoff`).
- Adapter helpers for LangChain models/tools and MCP clients without taking a hard dependency.
- Structured JSON tracing with optional payload capture.
## Install
```sh
npm install @cognipeer/agent-sdk zod

# Optional: install if you want LangChain adapters or MCP tool clients
npm install @langchain/core @langchain/openai
```

Install other adapters (e.g. MCP clients) as needed for your tools.
## Environment Setup

Expose your model key (OpenAI example):
```sh
export OPENAI_API_KEY=sk-...
```
Add this to your shell profile for persistence (`~/.zshrc` or similar).

## Your first agent

### Option A: Smart agent with planning and summarization

```ts
import { createSmartAgent, createTool, fromLangchainModel } from "@cognipeer/agent-sdk";
import { ChatOpenAI } from "@langchain/openai";
import { z } from "zod";

const echo = createTool({
  name: "echo",
  description: "Echo back",
  schema: z.object({ text: z.string().min(1) }),
  func: async ({ text }) => ({ echoed: text }),
});

const model = fromLangchainModel(new ChatOpenAI({
  model: "gpt-4o-mini",
  apiKey: process.env.OPENAI_API_KEY,
}));

const agent = createSmartAgent({
  name: "Planner",
  model,
  tools: [echo],
  useTodoList: true,
  limits: { maxToolCalls: 5, maxToken: 6000 },
  tracing: { enabled: true },
});

const res = await agent.invoke({
  messages: [{ role: "user", content: "Plan a greeting and send it via the echo tool" }],
});

console.log(res.content);
```

What happens:
1. A Zod-backed tool (`echo`) is registered.
2. The smart agent injects a system prompt with planning rules and exposes the `manage_todo_list` + `get_tool_response` helpers.
3. `invoke` runs the loop, executing tool calls until the assistant provides a final answer.
4. When tracing is enabled, a `trace.session.json` file is written under `logs/[session]/`.

### Option B: Minimal agent loop

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

const model = fromLangchainModel(new ChatOpenAI({
  model: "gpt-4o-mini",
  apiKey: process.env.OPENAI_API_KEY,
}));

const agent = createAgent({
  model,
  tools: [echo],
  limits: { maxToolCalls: 5 },
});

const res = await agent.invoke({
  messages: [{ role: "user", content: "Say hi via echo" }],
});

console.log(res.content);
```

The base agent gives you full control: no system prompt, no planning rules, and no auto-summarization. Perfect when you already orchestrate prompts elsewhere.

> **Tip:** already have LangChain tools or MCP adapters? Wrap them with `fromLangchainTools(...)` before passing them into `tools`.

### Optional: Offline fake model

```ts
const fakeModel = {
  bindTools() { return this; },
  async invoke() {
    return { role: "assistant", content: "hello (fake)" };
  },
};

const agent = createAgent({ model: fakeModel as any });
```

## Adding structured output

Provide `outputSchema` on either agent variant to validate and parse the final message. The framework exposes `res.output` when parsing succeeds and injects a finalize tool called `response`.

```ts
const Result = z.object({ title: z.string(), bullets: z.array(z.string()).min(1) });
const agent = createAgent({ model, outputSchema: Result });

const res = await agent.invoke({
  messages: [{ role: "user", content: "Give 3 bullets about agents" }],
});

console.log(res.output?.bullets);
```

## Smart layer: planning, TODO, and summarization

Listen for plan updates emitted by the smart agent:

```ts
await agent.invoke(
  { messages: [{ role: "user", content: "Plan and echo hi" }] },
  {
    onEvent: (event) => {
      if (event.type === "plan") {
        console.log("Plan size", event.todoList?.length ?? 0);
      }
    },
  }
);
```

## Handling tool limits

Set caps to prevent runaway loops:

```ts
createAgent({
  model,
  tools: [echo],
  limits: { maxToolCalls: 3, maxParallelTools: 2 },
});
```

When the limit is hit, a system finalize message is injected and the next model turn must answer directly.

## Context summarization (SmartAgent)

Configure summarization under `summarization`:

```ts
createSmartAgent({
  model,
  tools: [echo],
  summarization: {
    enable: true,
    maxTokens: 6000,
    summaryPromptMaxTokens: 4000,
    promptTemplate: "Summary so far:\n{{previousSummary}}\n\nConversation:\n{{conversation}}\n\nSummary:",
  },
});
```

Disable summarization entirely with `summarization: false`.

## Tracing & observability

Enable structured JSON traces:

```ts
createSmartAgent({
  model,
  tracing: {
    enabled: true,
    logData: true,
  },
});
```

By default, traces land in `logs/[session]/trace.session.json`. Keep `logData: true` for payload snapshots, set it to `false` for metrics-only mode, and swap in `fileSink(path?)`, `httpSink(url, headers?)`, `cognipeerSink(apiKey, url?)`, or `customSink({ onEvent, onSession })` when you want a different destination.

## Quick capability tour

| Capability | How | Example Folder |
|------------|-----|----------------|
| Multiple Tools | tools array | `examples/tools` |
| Planning / TODO | `useTodoList: true` | `examples/todo-planning` |
| Tool Limits | `limits.maxToolCalls` | `examples/tool-limit` |
| Summarization | `summarization.maxTokens` | `examples/summarization` |
| Structured Output | `outputSchema` | `examples/structured-output` |
| Multi-Agent | `agent.asTool()` | `examples/multi-agent` |
| Handoff | `agent.asHandoff()` | `examples/handoff` |
| MCP Tools | MCP adapter client | `examples/mcp-tavily` |
| Vision Input | message parts with `image_url` | `examples/vision` |

## Next Steps

Proceed to:
- Architecture – understand the loop & phases.
- Tools – author richer tools and error handling.
- Limits & Tokens – tune summarization & caps.
- Examples – experiment hands-on.

## Troubleshooting

| Issue | Likely Cause | Fix |
|-------|--------------|-----|
| No tool calls emitted | Model lacks tool calling | Use OpenAI-compatible model or fake scenario |
| Summarization not triggering | `maxToken` not reached or disabled | Lower `maxToken` or remove `summarization:false` |
| Parsed output missing | Schema mismatch / invalid JSON | Inspect `res.content`, adjust prompt, broaden schema |
| Handoff ignored | Tool not included | Ensure `handoffs` array includes the target agent |
| Trace file missing | `tracing.enabled` false | Enable tracing or ensure the process can write to `logs/` |

If stuck, enable tracing and review the most recent `trace.session.json` for error metadata.

## Running examples

The repository ships runnable scripts in `examples/`. Build the package once (`npm run build` from repo root) and run with `tsx`, e.g.:

```sh
OPENAI_API_KEY=... npx tsx examples/tools/tools.ts
```

Each folder includes a README describing required environment variables and the capability it showcases.
