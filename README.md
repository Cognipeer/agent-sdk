# @cognipeer/agent-sdk

[![npm](https://img.shields.io/npm/v/@cognipeer/agent-sdk?color=success)](https://npmjs.com/package/@cognipeer/agent-sdk) [Docs Website](https://cognipeer.github.io/agent-sdk/)

Lightweight, message-first agent runtime that keeps tool calls transparent, automatically summarizes long histories, and ships with planning, multi-agent handoffs, and structured tracing.

- SDK source: `src/`
- Examples: `examples/`
- Docs (VitePress): `docs/`
- Requires Node.js **18.17+**

## Table of contents
- [Overview](#overview)
- [What’s inside](#whats-inside)
- [Install](#install)
- [Quick start](#quick-start)
  - [Smart agent (planning + summarization)](#smart-agent-planning--summarization)
  - [Base agent (minimal loop)](#base-agent-minimal-loop)
- [Key capabilities](#key-capabilities)
- [Examples](#examples)
- [Architecture snapshot](#architecture-snapshot)
- [API surface](#api-surface)
- [Tracing & observability](#tracing--observability)
- [Development](#development)
- [Troubleshooting](#troubleshooting)
- [Documentation](#documentation)

## Overview

`@cognipeer/agent-sdk` is a zero-graph, TypeScript-first agent loop. Tool calls are persisted as messages, token pressure triggers automatic summarization, and optional planning mode enforces TODO hygiene with the bundled `manage_todo_list` tool. Multi-agent composition, structured output, and batched tracing are built-in.

Highlights:
- **Message-first design** – assistant tool calls and tool responses stay in the transcript.
- **Token-aware summarization** – chunked rewriting archives oversized tool outputs while exposing `get_tool_response` for lossless retrieval.
- **Planning mode** – strict system prompt + TODO tool keeps one task in progress and emits plan events.
- **Structured output** – provide a Zod schema and the agent injects a finalize tool to capture JSON deterministically.
- **Multi-agent and handoffs** – wrap agents as tools or transfer control mid-run with `asTool` / `asHandoff`.
- **Usage + events** – normalize provider usage, surface `tool_call`, `plan`, `summarization`, `metadata`, and `handoff` events.
- **Structured tracing** – optional per-invoke JSON traces with metadata, payload capture, and pluggable sinks (file, HTTP, Cognipeer, custom).

## What’s inside

| Path | Description |
|------|-------------|
| `src/` | Source for the published package (TypeScript, bundled via tsup). |
| `examples/` | End-to-end scripts demonstrating tools, planning, summarization, multi-agent, MCP, structured output, and vision input. |
| `docs/` | VitePress documentation site served at [cognipeer.github.io/agent-sdk](https://cognipeer.github.io/agent-sdk/). |
| `dist/` | Build output (generated). Contains ESM, CommonJS, and TypeScript definitions. |
| `logs/` | Generated trace sessions when `tracing.enabled: true`. Safe to delete. |

## Install

Install the SDK and its (optional) LangChain peer dependency:

```sh
npm install @cognipeer/agent-sdk @langchain/core zod
# Optional: LangChain OpenAI bindings for quick starts
npm install @langchain/openai
```

You can also bring your own model adapter as long as it exposes `invoke(messages[])` and (optionally) `bindTools()`.

## Quick start

### Smart agent (planning + summarization)

```ts
import { createSmartAgent, createTool, fromLangchainModel } from "@cognipeer/agent-sdk";
import { ChatOpenAI } from "@langchain/openai";
import { z } from "zod";

const echo = createTool({
  name: "echo",
  description: "Echo back user text",
  schema: z.object({ text: z.string().min(1) }),
  func: async ({ text }) => ({ echoed: text })
});

const model = fromLangchainModel(new ChatOpenAI({
  model: "gpt-4o-mini",
  apiKey: process.env.OPENAI_API_KEY,
}));

const agent = createSmartAgent({
  name: "ResearchHelper",
  model,
  tools: [echo],
  useTodoList: true,
  limits: { maxToolCalls: 5, maxToken: 8000 },
  tracing: { enabled: true },
});

const result = await agent.invoke({
  messages: [{ role: "user", content: "plan a greeting and send it via the echo tool" }],
  toolHistory: [],
});

console.log(result.content);
```

The smart wrapper injects a system prompt, manages TODO tooling, and runs summarization passes whenever `limits.maxToken` would be exceeded.

### Base agent (minimal loop)

Prefer a tiny core without system prompt or summarization? Use `createAgent`:

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

const model = fromLangchainModel(new ChatOpenAI({ model: "gpt-4o-mini", apiKey: process.env.OPENAI_API_KEY }));

const agent = createAgent({
  model,
  tools: [echo],
  limits: { maxToolCalls: 3, maxParallelTools: 2 },
});

const res = await agent.invoke({ messages: [{ role: "user", content: "say hi via echo" }] });
console.log(res.content);
```

## Key capabilities

- **Summarization pipeline** – automatic chunking keeps tool call history within `contextTokenLimit` / `summaryTokenLimit`, archiving originals so `get_tool_response` can fetch them later.
- **Planning discipline** – when `useTodoList` is true the system prompt enforces a plan-first workflow and emits `plan` events as todos change.
- **Structured output** – supply `outputSchema` and the framework adds a hidden `response` finalize tool; parsed JSON is returned as `result.output`.
- **Usage normalization** – provider `usage` blobs are normalized into `{ prompt_tokens, completion_tokens, total_tokens }` with cached token tracking and totals grouped by model.
- **Multi-agent orchestration** – reuse agents via `agent.asTool({ toolName })` or perform handoffs that swap runtimes mid-execution.
- **MCP + LangChain tools** – any object satisfying the minimal tool interface works; LangChain’s `Tool` implementations plug in directly.
- **Vision input** – message parts accept OpenAI-style `image_url` entries (see `examples/vision`).
- **Observability hooks** – `config.onEvent` surfaces tool lifecycle, summarization, metadata, and final answer events for streaming UIs or CLIs.

## Examples

Examples live under `examples/` with per-folder READMEs. Build the package first (`npm run build` or `npm run preexample:<name>`).

| Folder | Focus |
|--------|-------|
| `basic/` | Minimal tool call run with real model. |
| `tools/` | Multiple tools, Tavily search integration, `onEvent` usage. |
| `tool-limit/` | Hitting the global tool-call cap and finalize behavior. |
| `todo-planning/` | Smart planning workflow with enforced TODO updates. |
| `summarization/` | Token-threshold summarization walkthrough. |
| `summarize-context/` | Summaries + `get_tool_response` raw retrieval. |
| `structured-output/` | Zod schema finalize tool and parsed outputs. |
| `rewrite-summary/` | Continue conversations after summaries are injected. |
| `multi-agent/` | Delegating between agents via `asTool`. |
| `handoff/` | Explicit runtime handoffs. |
| `mcp-tavily/` | MCP remote tool discovery. |
| `vision/` | Text + image input using LangChain’s OpenAI bindings. |

Run directly with `tsx`, for example:

```sh
# from repo root
npm run build
OPENAI_API_KEY=... npx tsx examples/tools/tools.ts
```

## Architecture snapshot

The agent is a deterministic while-loop – no external graph runtime. Each turn flows through:

1. **resolver** – normalize state (messages, counters, limits).
2. **contextSummarize** (optional) – when token estimates exceed `limits.maxToken`, archive heavy tool outputs.
3. **agent** – invoke the model (binding tools when supported).
4. **tools** – execute proposed tool calls with configurable parallelism.
5. **toolLimitFinalize** – if tool-call cap is hit, inject a system notice so the next assistant turn must answer directly.

The loop stops when the assistant produces a message without tool calls, a structured output finalize signal is observed, or a handoff transfers control. See `docs/architecture/README.md` for diagrams and heuristics.

## API surface

Exported helpers (`agent-sdk/src/index.ts`):

- `createSmartAgent(options)`
- `createAgent(options)`
- `createTool({ name, description?, schema, func })`
- `fromLangchainModel(model)`
- `withTools(model, tools)`
- `buildSystemPrompt(extra?, planning?, name?)`
- Node factories (`nodes/*`), context helpers, token utilities, and full TypeScript types (`SmartAgentOptions`, `SmartState`, `AgentInvokeResult`, etc.).

`SmartAgentOptions` accepts the usual suspects (`model`, `tools`, `limits`, `useTodoList`, `summarization`, `usageConverter`, `tracing`). See `docs/api/` for detailed type references.

## Tracing & observability

Enable tracing by passing `tracing: { enabled: true }`. Each invocation writes `trace.session.json` into `logs/<SESSION_ID>/` detailing:

- Model/provider, agent name/version, limits, and timing metadata
- Structured events for model calls, tool executions, summaries, and errors
- Optional payload captures (request/response/tool bodies) when `logData` is `true`
- Aggregated token usage, byte counts, and error summaries for dashboards

You can disable payload capture with `logData: false` to keep only metrics, or configure sinks such as `httpSink(url, headers?)`, `cognipeerSink(apiKey, url?)`, or `customSink({ onEvent, onSession })` to forward traces after each run. Sensitive headers/callbacks remain in-memory and are never written alongside the trace.

## Development

Install dependencies and build the package:

```sh
cd agent-sdk
npm install
npm run build
```

From the repo root you can run `npm run build` (delegates to the package) or use `npm run example:<name>` scripts defined in `package.json`.

### Publishing

Only publish `agent-sdk/`:

```sh
cd agent-sdk
npm version <patch|minor|major>
npm publish --access public
```

`prepublishOnly` ensures a fresh build before publishing.

## Troubleshooting

- **Missing tool calls** – ensure your model supports `bindTools`. If not, wrap with `withTools(model, tools)` to provide best-effort behavior.
- **Summaries too aggressive** – adjust `limits.maxToken`, `contextTokenLimit`, and `summaryTokenLimit`, or disable with `summarization: false`.
- **Large tool responses** – return structured payloads and rely on `get_tool_response` for raw data instead of dumping megabytes inline.
- **Usage missing** – some providers do not report usage; customize `usageConverter` to normalize proprietary shapes.

## Documentation

- Live site: https://cognipeer.github.io/agent-sdk/
- Key guides within this repo:
  - `docs/getting-started/`
  - `docs/core-concepts/`
  - `docs/architecture/`
  - `docs/api/`
  - `docs/tools/`
  - `docs/examples/`
  - `docs/debugging/`
  - `docs/limits-tokens/`
  - `docs/tool-development/`
  - `docs/faq/`

Contributions welcome! Open issues or PRs against `main` with reproduction details when reporting bugs.

