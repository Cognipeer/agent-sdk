# Changelog

## [Unreleased]

## [0.6.5]

### Added
- **Parallel tool execution.** `limits.maxParallelTools` now actually fans non-approval tool calls across a bounded worker pool while preserving `tool_use → tool_result` order for Bedrock / Anthropic strict pairing.
- **Anthropic / Bedrock prompt caching.** Opt in via `prompt_caching: { enabled: true }` on the provider; system + final tool definition receive `cache_control: ephemeral` (Anthropic) or `cachePoint` blocks (Bedrock Converse). Typical input-token cost drops by ~90% on long tool-heavy runs.
- **Opt-in tool result cache.** `createTool({ cache: true | { keyFn?, ttlMs? } })` short-circuits duplicate args within an invoke; cached hits surface as `state.toolHistory[].fromCache === true`.
- **Per-tool retry / circuit breaker.** `createTool({ retry: { maxRetries, backoffMs, shouldRetry, circuitBreakerThreshold } })` retries transient errors with exponential backoff and trips a breaker after consecutive failures.
- **Provider retry + backoff.** Native providers automatically retry 429 / 5xx with `Retry-After`. Configure via `createProvider({ retry })`.
- **Delegation enforcement.** `asTool` reads the parent's resolved `delegation` policy at runtime and enforces `mode`, `maxDelegationDepth`, `maxChildCalls`, and `childContextPolicy` (`minimal` / `scoped` / `full`).
- **Budget limits.** `AgentLimits` gains `maxTotalOutputTokens`, `maxCostUsd`, and `maxWallClockMs`. Pair `maxCostUsd` with `costEstimator` on the agent options.
- **Pluggable token counter.** `AgentOptions.tokenCounter` swaps the built-in character heuristic for a real tokenizer per-invoke. Exported helpers: `setTokenCounter`, `getTokenCounter`, `defaultTokenCounter`.
- **Reflection budget.** `reasoning.reflection.maxPerRun` and `reasoning.reflection.everyNTurns` cap reflection cost on tool-heavy invokes.
- **stateRef per-invoke isolation.** Concurrent invocations on the same agent instance no longer share plan / todo / tool-history references.

### Fixed
- Summarizer uses `state.agent?.model` (live runtime model), so handoffs and per-invoke model overrides reach compaction too.
- `__summarizationExhausted` is cleared automatically when a new compactable tool result is appended; prevents deadlocks after partial retention bouts.
- `state.ctx` mutations from `toolsNode` propagate to the caller correctly (delta now explicitly returns `ctx`).
- Smart-agent runtime tool set includes the structured-output `response` finalize tool when `outputSchema` is set.
- Base-loop safety check honours the new `__limitBreached` exit reason.
- `asTool` delegation sub-agents pre-initialize `_stateRef` so the parent's tools node can deposit `parentRuntime` / `ctx` before the delegation runs.

### Changed
- Documentation refreshed: limits/tokens, summarization, tool development, runtime profiles, native providers, getting started, and API reference now cover the new budget surfaces, prompt caching, parallel tool exec, tool cache/retry, delegation enforcement, and pluggable token counter.

## [Earlier Unreleased]

### Added
- Unified `reasoning` configuration on `createAgent(...)` / `createSmartAgent(...)` for provider-native reasoning plus post-tool reflection.
- Reflection persistence on `state.reflections` plus `reflection` events for streaming UIs and task timelines.
- Native provider reasoning mappings for OpenAI/Azure/OpenAI-compatible, Anthropic, and Vertex/Gemini through the built-in provider layer.

### Changed
- Getting-started, native-provider, state-management, tracing, and type docs were refreshed to describe reasoning/reflection behavior.

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

---

For detailed changes, see [GitHub Releases](https://github.com/Cognipeer/agent-sdk/releases).
