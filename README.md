# @cognipeer/agent-sdk

[![npm](https://img.shields.io/npm/v/@cognipeer/agent-sdk?color=success)](https://npmjs.com/package/@cognipeer/agent-sdk) [Docs Website](https://cognipeer.github.io/agent-sdk/) 

Lightweight, message-first agent runtime that keeps tool calls transparent, supports provider-native reasoning plus post-tool reflection, automatically summarizes long histories, and ships with planning, multi-agent handoffs, and structured tracing.

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
  - [Reasoning & reflection](#reasoning--reflection)
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
- **Planning mode** – adaptive system prompt + TODO tool supports full plan writes and version-safe partial updates.
- **Unified reasoning surface** – one `reasoning` config controls provider-native reasoning and post-tool plain-text reflections.
- **Structured output** – provide a Zod schema and the agent injects a finalize tool to capture JSON deterministically.
- **Multi-agent and handoffs** – wrap agents as tools or transfer control mid-run with `asTool` / `asHandoff`.
- **Usage + events** – normalize provider usage, surface `tool_call`, `plan`, `summarization`, `reflection`, `metadata`, and `handoff` events.
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
npm install @cognipeer/agent-sdk zod
# Optional: LangChain bindings (if you want to use fromLangchainModel)
npm install @langchain/core @langchain/openai
```

The SDK includes a built-in native provider layer that talks directly to OpenAI, Anthropic, Azure, Bedrock, Vertex, and any OpenAI-compatible API — no LangChain required.

You can also bring your own model adapter as long as it exposes `invoke(messages[])` and (optionally) `bindTools()`.

## Quick start

### Native provider (no LangChain)

```ts
import { createSmartAgent, createTool, createProvider, fromNativeProvider } from "@cognipeer/agent-sdk";
import { z } from "zod";

const echo = createTool({
  name: "echo",
  description: "Echo back user text",
  schema: z.object({ text: z.string() }),
  func: async ({ text }) => ({ echoed: text }),
});

// Pick any provider – OpenAI, Anthropic, Azure, Bedrock, Vertex, or OpenAI-compatible
const model = fromNativeProvider(
  createProvider({ provider: "openai", apiKey: process.env.OPENAI_API_KEY! }),
  { model: "gpt-4o" },
);

const agent = createSmartAgent({ model, tools: [echo], runtimeProfile: "balanced" });
const result = await agent.invoke({ messages: [{ role: "user", content: "say hi" }] });
console.log(result.content);
```

Switch providers by changing a single config line:

```ts
// Anthropic
createProvider({ provider: "anthropic", apiKey: process.env.ANTHROPIC_API_KEY! })

// Azure OpenAI
createProvider({ provider: "azure", apiKey: "...", endpoint: "https://my-resource.openai.azure.com", deploymentName: "gpt-4o" })

// AWS Bedrock
createProvider({ provider: "bedrock", region: "us-east-1", accessKeyId: "...", secretAccessKey: "..." })

// Google Vertex AI
createProvider({ provider: "vertex", projectId: "my-project", accessToken: process.env.VERTEX_TOKEN })

// Any OpenAI-compatible endpoint (Ollama, Groq, Together, vLLM, …)
createProvider({ provider: "openai-compatible", apiKey: "...", baseURL: "https://custom.endpoint/v1" })
```

### Smart agent (planning + summarization)

```ts
import { createSmartAgent, createTool, fromLangchainModel } from "@cognipeer/agent-sdk";
import { ChatOpenAI } from "@langchain/openai";
import { z } from "zod";

const echo = createTool({
  name: "echo",
  description: "Echo back user text",
  schema: z.object({ text: z.string().min(1) }),
  func: async ({ text }) => ({ echoed: text }),
  maxExecutionsPerRun: null,
});

const model = fromLangchainModel(new ChatOpenAI({
  model: "gpt-4o-mini",
  apiKey: process.env.OPENAI_API_KEY,
}));

const agent = createSmartAgent({
  name: "ResearchHelper",
  model,
  tools: [echo],
  runtimeProfile: "balanced",
  planning: { mode: "todo", replanPolicy: "on_failure" },
  memory: { provider: "inMemory", scope: "session", writePolicy: "auto_important" },
  summarization: { summaryTriggerTokens: 8000, summaryMode: "incremental" },
  context: { policy: "hybrid", lastTurnsToKeep: 8 },
  toolResponses: {
    defaultPolicy: "summarize_archive",
    toolResponseRetentionByTool: { read_skills: "keep_full" },
    maxToolResponseChars: 4000,
    maxToolResponseTokens: 1200,
  },
  limits: { maxToolCalls: 5, maxContextTokens: 12000 },
  tracing: { enabled: true },
});

const result = await agent.invoke({
  messages: [{ role: "user", content: "plan a greeting and send it via the echo tool" }],
  toolHistory: [],
});

console.log(result.content);
```

Tool-response retention is lazy and summarizer-driven:

- Tool outputs are stored at full fidelity in `state.toolHistory` and are never reduced at tool-call time.
- When the summarizer runs (context limits reached), old tool messages are rewritten in place according to `defaultPolicy` (default: `summarize_archive`). The full payload is still recoverable via `get_tool_response` using the execution id embedded in the placeholder.
- `toolResponseRetentionByTool` lets you opt specific tools out of reduction (e.g. `read_skills: "keep_full"`).
- `criticalTools` are never reduced. The built-in list covers `response`, `manage_todo_list`, and `get_tool_response`.
- `maxToolResponseChars` / `maxToolResponseTokens` only drive an eager hard-cap truncation when a single tool output is big enough to blow up the very next model call. The truncated head always points at `get_tool_response` for recovery.

The smart wrapper now supports runtime presets (`fast`, `balanced`, `deep`, `research`), custom profiles layered on top of a base preset, structured summarization, hybrid context compaction, configurable tool-response retention, in-memory fact storage, delegation limits, and an eval harness via `runSmartAgentEvalHarness(...)`.

You can also define a custom profile by extending a built-in preset and overriding only the knobs you need:

```ts
const agent = createSmartAgent({
  name: "CustomPlanner",
  model,
  runtimeProfile: "custom",
  customProfile: {
    extends: "balanced",
    limits: { maxToolCalls: 10, maxContextTokens: 18000 },
    planning: { mode: "todo" },
    context: { lastTurnsToKeep: 10 },
    memory: { writePolicy: "manual" },
  },
});
```

### Reasoning & reflection

Both `createAgent(...)` and `createSmartAgent(...)` accept a unified `reasoning` config:

```ts
const agent = createSmartAgent({
  model: fromNativeProvider(
    createProvider({ provider: "openai", apiKey: process.env.OPENAI_API_KEY! }),
    { model: "gpt-5" },
  ),
  tools: [echo],
  reasoning: {
    enabled: true,
    level: "high",
    native: { effort: "high" },
    reflection: {
      cadence: "after_tool",
      mode: "piggyback",
      maxTokens: 450,
      keepLast: 4,
      summarize: false,
    },
  },
});

const result = await agent.invoke({
  messages: [{ role: "user", content: "Research the repo and propose the next implementation step." }],
}, {
  onEvent(event) {
    if (event.type === "reflection") {
      console.log("reflection:", event.text);
    }
  },
});

console.log(result.state?.reflections?.at(-1)?.text);
```

What this does:

- `reasoning.native` passes provider-specific reasoning knobs through the native provider layer.
- `reasoning.reflection` adds a short plain-text reflection after qualifying turns without committing that note as a normal assistant message.
- Reflection notes are persisted on `result.state.reflections`; only the last `keepLast` are re-injected into the next prompt as synthetic system context.

Use this only with models/endpoints that actually support provider-native reasoning. Unsupported models usually return a provider error rather than silently degrading.

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

- **Native provider layer** – call OpenAI, Anthropic, Azure, Bedrock, Vertex, and any OpenAI-compatible API directly. No LangChain required. Unified `ChatCompletionRequest` / `ChatCompletionResponse` schema with per-provider wire format conversion.
- **Full token tracking** – every response surfaces `inputTokens`, `outputTokens`, `cachedInputTokens`, `cachedWriteTokens`, and `reasoningTokens` for all six providers.
- **Unified reasoning controls** – enable provider-native reasoning (`reasoning.native`) and post-tool reflection (`reasoning.reflection`) from one config surface.
- **Summarization pipeline** – automatic chunking keeps tool call history within `contextTokenLimit` / `summaryTokenLimit`, archiving originals so `get_tool_response` can fetch them later.
- **Retention controls** – tool outputs can be kept full, reduced to structured previews, archived, or dropped based on size tiers, critical-tool fallback, per-tool overrides, and recent-response pinning.
- **Planning discipline** – when planning is enabled the system prompt distinguishes full plan writes from incremental plan updates and emits `plan` events as todos change.
- **Structured output** – supply `outputSchema` and the framework adds a hidden `response` finalize tool; parsed JSON is returned as `result.output`.
- **Multi-agent orchestration** – reuse agents via `agent.asTool({ toolName })` or perform handoffs that swap runtimes mid-execution.
- **MCP + LangChain tools** – any object satisfying the minimal tool interface works; LangChain’s `Tool` implementations plug in directly.
- **Vision input** – message parts accept base64 or URL images for multimodal requests.
- **Observability hooks** – `config.onEvent` surfaces tool lifecycle, summarization, reflection, metadata, and final answer events for streaming UIs or CLIs.

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

To run examples:

```bash
# Install root dependencies
npm install

# Install example dependencies
cd examples
npm install

# Run an example from the examples directory
npm run example:basic
npm run example:tools
npm run example:multi-agent
```

Or run directly with tsx:

```bash
# From examples directory
OPENAI_API_KEY=... npx tsx basic/basic.ts
```

## Architecture snapshot

The agent is a deterministic while-loop – no external graph runtime. Each turn flows through:

1. **resolver** – normalize state (messages, counters, limits).
2. **contextSummarize** (optional) – when token estimates exceed the active summarization threshold, archive heavy tool outputs.
3. **agent** – invoke the model (binding tools when supported).
4. **tools** – execute proposed tool calls with configurable parallelism.
5. **reflect** (optional) – append a plain-text reflection after tool turns when `reasoning.reflection` is enabled.
6. **toolLimitFinalize** – if tool-call cap is hit, inject a system notice so the next assistant turn must answer directly.

The loop stops when the assistant produces a message without tool calls, a structured output finalize signal is observed, or a handoff transfers control. See `docs/architecture/README.md` for diagrams and heuristics.

## API surface

Exported helpers (`agent-sdk/src/index.ts`):

**Agent factories:**
- `createSmartAgent(options)`
- `createAgent(options)`
- `createTool({ name, description?, schema, func, needsApproval?, approvalPrompt?, approvalDefaults?, maxExecutionsPerRun? })`

**Native providers (no LangChain):**
- `createProvider(config)` – factory for all six providers
- `fromNativeProvider(provider, options?)` – wraps a provider as a `BaseChatModel`
- `OpenAIProvider`, `AnthropicProvider`, `AzureProvider`, `OpenAICompatibleProvider`, `BedrockProvider`, `VertexProvider`
- Types: `ChatCompletionRequest`, `ChatCompletionResponse`, `TokenUsage`, `ProviderConfig`, `ReasoningConfig`, `ReflectionRecord`, `ReflectionEvent`

**LangChain adapters (optional):**
- `fromLangchainModel(model)`
- `withTools(model, tools)`
- `fromLangchainTools(tools)`

**Utilities:**
- `buildSystemPrompt(extra?, planning?, name?)`
- Node factories (`nodes/*`), context helpers, token utilities, and full TypeScript types (`SmartAgentOptions`, `SmartState`, `AgentInvokeResult`, etc.).

`SmartAgentOptions` accepts the usual suspects (`model`, `tools`, `limits`, `runtimeProfile`, `customProfile`, `useTodoList`, `summarization`, `reasoning`, `usageConverter`, `tracing`). See `docs/api/` for detailed type references.

Tools can also declare `maxExecutionsPerRun` to cap successful executions for that tool within a single agent run. Leave it unset or set it to `null` for unlimited usage. This is separate from global limits such as `limits.maxToolCalls` and `limits.maxParallelTools`.

## Tracing & observability

Enable tracing by passing `tracing: { enabled: true }`. Each invocation writes `trace.session.json` into `logs/<SESSION_ID>/` detailing:

- Model/provider, agent name/version, limits, and timing metadata
- Structured events for model calls, tool executions, summaries, reflections, and errors
- Optional payload captures (request/response/tool bodies) when `logData` is `true`
- Aggregated token usage, byte counts, and error summaries for dashboards

You can disable payload capture with `logData: false` to keep only metrics, or configure sinks such as `httpSink(url, headers?)`, `cognipeerSink(apiKey, url?)`, `otlpSink(endpoint, headers?)`, or `customSink({ onEvent, onSession })` to forward traces after each run. Sensitive headers/callbacks remain in-memory and are never written alongside the trace.

Each session/event also carries OTel-compatible correlation identifiers (`traceId`, `rootSpanId`, `spanId`, `parentSpanId`) so you can stitch agent traces into distributed telemetry pipelines.

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

