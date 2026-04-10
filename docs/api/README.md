# API Reference

This section is meant to answer a practical question quickly: which public surface do you touch for the integration you are building?

## Read this section by task

| If you need to... | Start here |
|---|---|
| choose between the base loop and the smart runtime | [Agent Construction](/api/agent) |
| define tools or understand built-in context tools | [Tools & Context Tools](/api/tools) |
| connect LangChain models, MCP tools, or a custom model adapter | [Adapters & Models](/api/adapters) |
| understand planning instructions and system prompt shaping | [Prompting & Planning](/api/prompts) |
| wire state, events, plans, or snapshots into your app | [State & Public Types](/api/types) |
| understand internal runtime phases for debugging | [Runtime Internals](/api/nodes) |

## The public surface in one view

| Export group | Why it exists |
|---|---|
| `createAgent(...)` | Minimal deterministic loop with tools, limits, approvals, and optional structured output. |
| `createSmartAgent(...)` | Smart runtime for autonomous agents: profiles, planning, context compaction, and memory. |
| `createTool(...)` | Typed tool construction with optional approval and execution controls. |
| `fromLangchainModel(...)`, `fromLangchainTools(...)`, `withTools(...)` | Adapters for model and tool ecosystems. |
| `buildSystemPrompt(...)` | Reuse the runtime prompt shape directly when needed. |
| tracing sinks | Send runtime traces to file, HTTP, Cognipeer, OTLP, or custom sinks. |

## What this API reference is not

This section is not a full reproduction of every line in `src/types.ts`. It is organized around integration decisions rather than raw declaration dumps.

## Recommended reading order

1. [Agent Construction](/api/agent)
2. [Tools & Context Tools](/api/tools)
3. [Adapters & Models](/api/adapters)
4. [State & Public Types](/api/types)

Read [Prompting & Planning](/api/prompts) and [Runtime Internals](/api/nodes) when you need to understand smart runtime behavior or debug execution.
