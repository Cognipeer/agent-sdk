---
layout: home

hero:
  name: Agent SDK
  text: Build Reliable Agent Workflows
  tagline: A smart runtime for autonomous agents that need typed tools, explicit planning, resilient context handling, and inspectable execution.
  actions:
    - theme: brand
      text: Get Started
      link: /guide/getting-started
    - theme: alt
      text: Study Architecture
      link: /guide/architecture

features:
  - title: Native LLM Providers — No Framework Required
    details: Call OpenAI, Anthropic, Azure, Bedrock, Vertex, and any OpenAI-compatible API directly with fetch. Unified schema, full token tracking (input/output/cached/reasoning), and streaming built-in.
  - title: Runtime Profiles For Different Agent Behaviors
    details: Use fast, balanced, deep, or research as operational presets. They are real tradeoff bundles for context budget, delegation depth, memory policy, and summarization behavior.
  - title: Planning That Fits Autonomous Work
    details: Smart planning is aimed at agents that own multi-step work. The durable plan lives on result.state.plan instead of being trapped in transient UI events.
  - title: Summarization With Recovery Paths
    details: Long-running agents can compact tool-heavy history without going blind. Archived outputs remain recoverable through get_tool_response when the agent needs raw evidence again.
  - title: State, Resume, And Human Control
    details: Pause execution, snapshot state, restore later, and gate risky tools through approvals without losing the agent's working context.
  - title: Tracing, Debugging, And Evaluation
    details: Inspect tool calls, summaries, handoffs, token drift, and partial sink failures through structured traces built for real operational debugging.
---

## Start Here

If you are integrating the SDK for the first time, read the docs in this order:

1. [Getting Started](/guide/getting-started) to get a working agent into your app fast.
2. [Native Providers](/guide/native-providers) to connect to OpenAI, Anthropic, Azure, Bedrock, Vertex, or any compatible endpoint without additional dependencies.
3. [Core Concepts](/guide/core-concepts) to understand what actually lives in state, what is emitted as an event, and what gets summarized.
4. [Architecture](/guide/architecture) to understand the smart wrapper, the base loop, and where runtime decisions are made.

## Quick Start

```ts
import { createSmartAgent, createTool, createProvider, fromNativeProvider } from "@cognipeer/agent-sdk";
import { z } from "zod";

const lookup = createTool({
  name: "lookup_owner",
  description: "Return the owner for a project code",
  schema: z.object({ code: z.enum(["ORBIT", "NOVA"]) }),
  func: async ({ code }) => ({ owner: code === "ORBIT" ? "Ada Lovelace" : "Grace Hopper" }),
});

// OpenAI, Anthropic, Azure, Bedrock, Vertex, or any compatible endpoint
const model = fromNativeProvider(
  createProvider({ provider: "openai", apiKey: process.env.OPENAI_API_KEY! }),
  { model: "gpt-4o" },
);

const agent = createSmartAgent({
  model,
  tools: [lookup],
  runtimeProfile: "balanced",
  planning: { mode: "todo" },
  limits: { maxToolCalls: 6, maxContextTokens: 12000 },
});

const result = await agent.invoke({
  messages: [{ role: "user", content: "Compare ORBIT and NOVA." }],
});
console.log(result.content);
```

## What This Site Optimizes For

- Fast product onboarding without hand-wavy architecture claims.
- Clear separation between the minimal loop and the smart runtime wrapper.
- Production-oriented guidance for autonomous agents, especially around planning, context pressure, and tracing.
- A product-led docs surface with platform attribution kept in the footer instead of the header.
