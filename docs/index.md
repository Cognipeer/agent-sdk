---
layout: home

hero:
  name: Agent SDK
  text: Lightweight AI Agent Framework
  tagline: Message-first agent loop with planning, summarization, and multi-agent orchestration
  image:
    src: /agent-sdk/logo.svg
    alt: Agent SDK
  actions:
    - theme: brand
      text: Get Started
      link: /guide/getting-started
    - theme: alt
      text: View on GitHub
      link: https://github.com/Cognipeer/agent-sdk

features:
  - icon: 🎯
    title: Planning & TODOs
    details: Built-in planning mode with structured TODO management and strict workflow rules for complex multi-step tasks.
  - icon: 🧠
    title: Smart Summarization
    details: Token-aware context summarization that archives heavy tool outputs while keeping them recoverable.
  - icon: 🔧
    title: Tool Development
    details: Create type-safe tools with Zod schemas. Built-in adapters for LangChain and MCP tools.
  - icon: 🤝
    title: Multi-Agent Composition
    details: Compose agents via asTool and asHandoff for seamless delegation and orchestration.
  - icon: 📊
    title: Structured Output
    details: Enforce structured responses using Zod schemas with automatic validation and parsing.
  - icon: 🛡️
    title: Guardrails
    details: Conversation guardrails with built-in checks and customizable presets for safe AI interactions.
  - icon: 📈
    title: Tracing & Debugging
    details: Structured JSON tracing with payload capture and pluggable sinks for observability.
  - icon: ⚡
    title: Pause & Resume
    details: Support for long-running sessions with state snapshots and resumable execution.
---

## Quick Start

::: code-group

```bash [npm]
npm install @cognipeer/agent-sdk zod
```

```bash [yarn]
yarn add @cognipeer/agent-sdk zod
```

```bash [pnpm]
pnpm add @cognipeer/agent-sdk zod
```

:::

## Basic Usage

```typescript
import { createSmartAgent, createTool, fromLangchainModel } from "@cognipeer/agent-sdk";
import { ChatOpenAI } from "@langchain/openai";
import { z } from "zod";

// Define a simple tool
const echo = createTool({
  name: "echo",
  description: "Echo back the input text",
  schema: z.object({ text: z.string().min(1) }),
  func: async ({ text }) => ({ echoed: text }),
});

// Create model adapter
const model = fromLangchainModel(new ChatOpenAI({
  model: "gpt-4o-mini",
  apiKey: process.env.OPENAI_API_KEY,
}));

// Create smart agent with planning
const agent = createSmartAgent({
  name: "Assistant",
  model,
  tools: [echo],
  useTodoList: true,
  limits: { maxToolCalls: 5 },
  summarization: { maxTokens: 6000 },
  tracing: { enabled: true },
});

// Run the agent
const result = await agent.invoke({
  messages: [{ 
    role: "user", 
    content: "Plan a greeting and send it via the echo tool" 
  }],
});

console.log(result.content);
```

## Key Capabilities

- **Planning Mode**: Structured TODO tool with strict workflow rules
- **Smart Summarization**: Token-aware context archiving with retrieval
- **Structured Output**: Zod-powered schema validation and parsing
- **Tool Limits**: Total and parallel execution limits with automatic finalization
- **Multi-Agent**: Compose agents via `asTool` and runtime handoffs
- **Vision Support**: Multimodal message parts and provider normalization
- **Tracing**: Structured JSON logs with streaming `onEvent` hooks

## Advanced Features

### Planning Mode

```typescript
const agent = createSmartAgent({
  model,
  tools,
  useTodoList: true, // Enable planning mode
});
```

### Structured Output

```typescript
const agent = createSmartAgent({
  model,
  tools,
  outputSchema: z.object({
    summary: z.string(),
    items: z.array(z.string()),
  }),
});

const result = await agent.invoke({ messages });
console.log(result.output); // Parsed structured output
```

### Multi-Agent Delegation

```typescript
const specialist = createSmartAgent({ name: "Specialist", model, tools });
const coordinator = createSmartAgent({
  name: "Coordinator",
  model,
  tools: [specialist.asTool({ toolName: "delegate_to_specialist" })],
});
```

## Why Agent SDK?

- **Minimal Dependencies**: Lightweight core with optional adapters for LangChain and MCP
- **Type-Safe**: Full TypeScript support with Zod schema validation
- **Flexible**: Use `createSmartAgent` for batteries-included experience or `createAgent` for full control
- **Production Ready**: Built-in tracing, guardrails, and token management
- **Composable**: Easy multi-agent orchestration with delegation and handoffs
- **Observable**: Predictable events, inspection-ready state, and structured traces
