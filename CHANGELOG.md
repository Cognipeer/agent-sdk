# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- Unified `reasoning` configuration on `createAgent(...)` / `createSmartAgent(...)` for provider-native reasoning plus post-tool reflection.
- Reflection persistence on `state.reflections` plus `reflection` events for streaming UIs and task timelines.
- Native provider reasoning mappings for OpenAI/Azure/OpenAI-compatible, Anthropic, and Vertex/Gemini through the built-in provider layer.

### Changed
- Documentation now explains reasoning presets, reflection behavior, provider mappings, and the new public types/events.

### Changed (breaking)
- **Tool response retention collapsed to a single lazy-summarizer model.** Tool outputs are never reduced at tool-call time. When the summarizer runs (context limits reached), old tool messages are rewritten according to `toolResponses.defaultPolicy` (default: `summarize_archive`). The full payload always stays available via `get_tool_response` because it is stored in `state.toolHistory` / `state.toolHistoryArchived`.
- Removed config fields (no backward compatibility):
  - `toolResponses.smallResponseChars`
  - `toolResponses.smallResponsePolicy`
  - `toolResponses.largeResponsePolicy`
  - `toolResponses.fallbackPolicy`
  - `toolResponses.keepRecentFullCount`
- Remaining config surface: `defaultPolicy`, `toolResponseRetentionByTool`, `criticalTools`, `maxToolResponseChars`, `maxToolResponseTokens`, `schemaValidation`, `retryOnSchemaError`.
- Classification enum simplified to `critical | informative | verbose` (removed `small`, `redundant`).
- `maxToolResponseChars` / `maxToolResponseTokens` now only drive an eager hard-cap truncation for non-critical, oversized single responses; the truncated head points at `get_tool_response` for recovery.
- Summarization placeholder prefixes: `STRUCTURED_TOOL_RESPONSE`, `ARCHIVED_TOOL_RESPONSE`, `DROPPED_TOOL_RESPONSE`. Critical tools and per-tool `keep_full` overrides are always preserved.

### Added
- **Native LLM provider layer** (`src/providers/`) — direct API access for 6 providers without LangChain or any framework dependency
  - `createProvider(config)` factory supports `"openai"`, `"anthropic"`, `"azure"`, `"bedrock"`, `"vertex"`, `"openai-compatible"`
  - `fromNativeProvider(provider, options?)` wraps any provider as a `BaseChatModel` for seamless agent-sdk integration
  - Unified `ChatCompletionRequest` / `ChatCompletionResponse` schema with per-provider wire format conversion
  - `TokenUsage` type tracks `inputTokens`, `outputTokens`, `cachedInputTokens`, `cachedWriteTokens`, `cachedOutputTokens`, and `reasoningTokens` across all providers
  - SSE stream parser (`src/providers/utils/sse.ts`) for OpenAI, Anthropic, Azure, and Vertex streaming
  - AWS Signature V4 signing (`src/providers/utils/sigv4.ts`) for Bedrock — zero AWS SDK dependency
  - Google Vertex AI service account JSON → JWT → access token flow built-in
  - Provider capabilities auto-configured (`structuredOutput`, `streaming`) so the smart runtime picks the right strategy automatically
- 38 new unit tests covering message conversion, request/response parsing, token usage, factory, adapter, SSE parser, and SigV4
- New docs page: `docs/guide/native-providers.md`

## [0.4.0] - 2026-03-16

### Added
- OTLP tracing sink/export helpers plus richer trace/session correlation fields (`traceId`, `spanId`, `parentSpanId`, `threadId`)
- Workbench integration tests covering invoke, tools, streaming, planning, and summarization flows

### Changed
- Tracing configuration now exposes explicit `mode` support and a wider public export surface for remote session handling
- Debugging, getting-started, and core-concepts docs were refreshed to describe the expanded tracing model

## [0.3.1] - 2026-02-18

### Added
- `threadId` tracing support for grouping multiple agent sessions under a single workflow or conversation

### Changed
- Debugging docs were updated to explain grouped trace sessions and workflow-level correlation

## [0.3.0] - 2026-02-16

### Added
- `startStreamingSession` tracing helper export for streaming trace backends

### Changed
- Agent/tracing runtime wiring was updated to prepare the streaming-session path

## [0.2.9] - 2026-02-06

### Added
- Tracing integration test coverage

### Changed
- Token counting and context-budget heuristics were tightened for more accurate summarization thresholds
- Agent-core and decision logic around summarization flow were simplified

## [0.2.8] - 2026-02-06

### Changed
- Version-only npm publish on top of the `0.2.7` line; no distinct source diff was recorded beyond the release bump

## [0.2.7] - 2026-02-06

### Added
- Comprehensive unit and integration test suites for agents, smart agents, approvals, pause/resume, snapshots, prompts, summarization, and token management
- Shared test fixtures/mocks and a Bedrock example in the examples workspace

### Changed
- Example workspace dependencies and package metadata were refreshed
- Trace section utilities and usage helpers were expanded for diagnostics and testability

## [0.2.6] - 2026-02-05

### Changed
- npm republish of the `0.2.3` source snapshot from the same `gitHead`; no additional repository diff was recorded for this publish

## [0.2.5] - 2026-02-05

### Changed
- npm republish of the `0.2.3` source snapshot from the same `gitHead`; no additional repository diff was recorded for this publish

## [0.2.4] - 2026-02-05

### Changed
- npm republish of the `0.2.3` source snapshot from the same `gitHead`; no additional repository diff was recorded for this publish

## [0.2.3] - 2026-02-04

### Changed
- SmartAgent summarization settings were refactored around clearer configuration and limit semantics
- Core agent, model, tools, tracing, and public types were updated to match the new summarization/runtime shape
- API docs, getting-started guides, limits docs, and examples were refreshed accordingly

## [0.2.2] - 2026-01-09

### Changed
- npm republish of the `0.2.0` source snapshot from the same `gitHead`; no additional repository diff was recorded for this publish

## [0.2.1] - 2026-01-08

### Changed
- npm republish of the `0.2.0` source snapshot from the same `gitHead`; no additional repository diff was recorded for this publish

## [0.2.0] - 2026-01-06

### Changed
- Documentation and example instructions were cleaned up for more consistent project setup and example execution
- README and examples were clarified ahead of the `0.2.x` release line

## [0.1.2] - 2025-10-17

### Added
- Conversation guardrails, human-in-the-loop tool approvals, and comprehensive tracing with multiple sink options and session management

### Changed
- Agent and Smart Agent types were unified and observability hooks were improved
- README and docs were expanded and reorganized across the published package surface

### Fixed
- Trace `ai_call` events now include token fields consistently
- Session path references were normalized in the docs

## [0.1.1] - 2025-09-26

### Added
- Initial npm release of the SDK with the base agent loop, smart-agent runtime, planning/TODO tools, summarization, structured output, tool limits, tracing/debug hooks, and documentation
