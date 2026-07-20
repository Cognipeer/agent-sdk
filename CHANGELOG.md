# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.8.1]

### Changed (BREAKING)
- **Default runtime-profile values modernized for frontier models.** All four built-in profiles (`fast`, `balanced`, `deep`, `research`) had their numeric defaults rescaled for 2026-era models (Claude 4.x, GPT-4o, Gemini 2.x). The previous defaults were tuned for 8k–16k context windows and now leave too much headroom unused. Headline changes per profile:
  - `fast`: `maxToolCalls 4→8`, `maxParallelTools 1→3`, `maxContextTokens 12000→32000`, summarization trigger `9000→24000`, `maxToolResponseChars 8k→16k`.
  - `balanced` (also the shared baseline): `maxToolCalls 8→20`, `maxParallelTools 2→5`, `maxContextTokens 24000→96000`, summarization trigger `17000→72000`, `lastTurnsToKeep 8→16`, `maxChildCalls 4→6`, `maxToolResponseChars 12k→32k`.
  - `deep`: `maxToolCalls 14→40`, `maxParallelTools 3→8`, `maxContextTokens 42000→200000`, summarization trigger `30000→150000`, `lastTurnsToKeep 12→30`, `maxChildCalls 6→10`, `maxToolResponseChars 16k→64k`.
  - `research`: `maxToolCalls 20→80`, `maxParallelTools 4→10`, `maxContextTokens 56000→400000`, summarization trigger `42000→300000`, `lastTurnsToKeep 20→60`, `maxChildCalls 8→16`, `maxParallelChild 3→6`, `maxToolResponseChars 24k→96k`.
  - **Migration:** if you depend on the old conservative caps (e.g., running against an 8k-window model, strict cost ceilings, or a deliberate "tight loop" agent), pass explicit `limits`, `summarization`, `context`, and `toolResponses` overrides — or build a `customProfile` extending the desired base and clamp the values you care about. Behavioral defaults (planning still `off`, `summaryMode: incremental`, `memory.writePolicy: auto_important`, `context.policy: hybrid`) are unchanged.

### Added
- **ContextPilot: native, deterministic context/token optimization layer.** Runs at tool-execution time (no extra model calls) to shrink large tool outputs before they enter the transcript, while keeping every original payload recoverable. Enabled by default via `contextPilot` on `createSmartAgent` (see `docs/guide/context-pilot.md`). Highlights:
  - **Format-aware compression.** BM25-lite relevance scoring drives `jsonCrusher` (large arrays), `textCrusher` (long plain text, sentence-level), plus dedicated `diffCompressor` (unified diffs), `logCompressor` (ERROR/WARN-prioritized log lines), and `searchCompressor` (grep/search matches with per-file diversity caps).
  - **Reversible Compress-Cache-Retrieve (CCR) store.** Every dropped/compressed payload is kept in an in-memory, TTL/LRU-bounded store keyed by a content hash; the compressed output carries a retrieval note, and the model can call the built-in `get_tool_response` tool with that `executionId` to get the full original data back.
  - **Cross-turn duplicate detection (`dedup`).** Byte-identical tool outputs seen again later in the same session are replaced with a lightweight `DUPLICATE_TOOL_RESPONSE` pointer instead of being resent in full.
  - **Cache alignment warnings.** Optional scan of the system prompt for volatile substrings (UUIDs, ISO/Unix timestamps, JWTs, hex hashes, API keys) that would defeat provider-side prompt caching; emits a one-time `context_pilot_cache_alignment` metadata event instead of rewriting the prompt.
  - **`excludeTools`** to opt specific tools out entirely.
  - **Runtime-profile aware defaults**: `fast`/`balanced`/`deep`/`research` scale `compression.json`/`text` `targetRatio` and `ccr.ttlMs`/`maxEntries` alongside the existing limit/context defaults.
  - Real-model A/B benchmarks (real pre-ContextPilot commit vs this branch, via `examples/context-pilot-comparison/`) measured **29–48% prompt-token reduction** across catalog lookups, repeat-query dedup, multi-tool incident investigations, and long multi-turn sessions, with no loss of answer correctness and full data recoverability confirmed via `get_tool_response`.
- **Native reasoning round-trip (thinking blocks).** Provider responses now surface a normalized `reasoning` payload (`{ blocks, summary }`). Anthropic and Bedrock thinking / redacted-thinking blocks (with signatures) are captured on the assistant message and replayed verbatim on the next request, satisfying the providers' signed-thinking requirement. Vertex/Gemini `thought` parts and reasoning token counts are surfaced as a summary. OpenAI o-series / gpt-5 now route through the Responses API (`completeResponses`) when reasoning is requested, exposing the reasoning summary and `reasoning_tokens`; Azure OpenAI gets the same via its `/openai/responses` route. Reasoning mappers raise `max_tokens` above the thinking budget, clamp the budget below it, and strip sampling params (`temperature`/`top_p`/`top_k`) that thinking mode forbids.
- **`reasoning.level: "minimal"`.** A fourth, cheapest reasoning preset (`effort: "minimal"`, reflection off).
- **`initial_then_after_tool` reflection cadence.** Reflects once up-front as a planning note, then like `after_tool`. New default for `level: "medium"` / `"high"`. `on_branch` now fires on an actual tool-name-set change between turns rather than a turn-count heuristic.
- **Reflection hooks and routing.** `reasoning.reflection` accepts `shouldReflect` (override the cadence decision), `buildPrompt` (customize the probe), `onReflection` (side-effect hook), and `feedTo: "memory" | "plan" | "none"` to route the note into a `MemoryFact` or `plan.lastReflection`. Near-duplicate consecutive reflections are suppressed.
- **`validateReasoningConfig(config)`.** Exported pure validator that throws descriptive errors for invalid `level`, `cadence`, `effort`, `budgetTokens`, `everyNTurns`, or `feedTo` values; also run automatically inside `resolveReasoning`.
- **Ask-user (structured human-in-the-loop).** Opt in with `humanInTheLoop: { askUser: true }` on `createAgent` / `createSmartAgent` to register a built-in `ask_user_question` tool. When the model calls it, the runtime pauses with a `PendingUserQuestion` entry, emits a `user_question` event, and sets `ctx.__awaitingUserQuestion`. Resume by calling `agent.resolveUserQuestion(state, { id, answers })` which validates the response and appends it as a `role: "tool"` message bound to the original `tool_call_id`. The global `allowFreeText` flag (default `true`) decides whether "Other" / typed answers are accepted; when `false`, every question must include `>= 2` options and the resolver rejects `freeText`. Also exposed: `resolveUserQuestionState`, `createAskUserQuestionTool`, and types `PendingUserQuestion`, `UserQuestionItem`, `UserQuestionOption`, `UserQuestionAnswer`, `UserQuestionAnswerSet`, `UserQuestionResolution`, `UserQuestionEvent`, `HumanInTheLoopOptions`.

### Fixed
- **Reflection throttling is now run-scoped.** `reasoning.reflection.maxPerRun` counts reflections within the current `invoke(...)` instead of the whole (possibly resumed) conversation, and `everyNTurns` spacing is enforced in a single place (the duplicate hidden `on_branch` gate was removed).
- **Native reasoning config lifecycle.** `ctx.__reasoning` is (re)applied on every invoke and cleared when native reasoning is disabled, so a resumed run can no longer inherit a stale reasoning configuration.


## [0.6.5]

### Added
- **Parallel tool execution.** `limits.maxParallelTools` now actually fans non-approval tool calls across a bounded worker pool while preserving `tool_use → tool_result` order for Bedrock / Anthropic strict pairing. Approval-required tools still run sequentially.
- **Anthropic / Bedrock prompt caching.** Opt in with `prompt_caching: { enabled: true }` on the provider; system prompt and the final tool definition receive `cache_control: ephemeral` (Anthropic) or `cachePoint` blocks (Bedrock Converse). Typical input-token cost drops by ~90% on long tool-heavy runs.
- **Opt-in tool result cache.** `createTool({ cache: true | { keyFn?, ttlMs? } })` short-circuits duplicate args within an invoke and surfaces cached hits as `state.toolHistory[].fromCache === true`.
- **Per-tool retry / circuit breaker.** `createTool({ retry: { maxRetries, backoffMs, shouldRetry, circuitBreakerThreshold } })` retries transient errors with exponential backoff and short-circuits after consecutive failures.
- **Provider retry + backoff.** Native providers automatically retry 429 / 5xx with `Retry-After` support. Configure via `createProvider({ retry: { maxRetries, baseDelayMs, maxDelayMs, shouldRetry } })`.
- **Delegation enforcement.** `asTool` now reads the parent's resolved delegation policy and enforces `mode`, `maxDelegationDepth`, `maxChildCalls`, and `childContextPolicy` (`minimal` / `scoped` / `full`) at runtime instead of just describing them in the system prompt.
- **Budget limits.** `AgentLimits` gains `maxTotalOutputTokens`, `maxCostUsd`, and `maxWallClockMs`. Pair `maxCostUsd` with `costEstimator` on the agent options for real cost enforcement.
- **Pluggable token counter.** `AgentOptions.tokenCounter` (or the exported `setTokenCounter` / `defaultTokenCounter` helpers) swaps the built-in character heuristic for a real tokenizer (tiktoken, `@anthropic-ai/tokenizer`, etc.) without losing concurrency safety.
- **Reflection budget.** `reasoning.reflection.maxPerRun` and `reasoning.reflection.everyNTurns` cap reflection cost in long tool-heavy invokes.
- **stateRef per-invoke isolation.** Plan / todo / tool-history references are now created per `invoke(...)` so concurrent invocations on the same agent instance no longer clobber each other.

### Fixed
- Summarizer now uses `state.agent?.model` (live runtime model) instead of `opts.model`, so handoffs and per-invoke model overrides reach the summarizer too.
- `__summarizationExhausted` is automatically cleared when a new compactable tool result is appended, preventing infinite "nothing to compress" deadlocks after partial retention bouts.
- `state.ctx` mutations from `toolsNode` now propagate correctly to the caller (delta explicitly returns `ctx`).
- SmartAgent runtime tool set now includes the structured-output `response` finalize tool when `outputSchema` is set, eliminating "tool not found" loops in retry paths.
- The base-loop "tool result without subsequent model call" safety check now respects the new `__limitBreached` exit reason.
- `asTool` delegation sub-agents pre-initialize `_stateRef` so the parent's tools node can deposit `parentRuntime` / `ctx` before the delegation runs.

### Added (continued from earlier)
- Unified `reasoning` configuration on `createAgent(...)` / `createSmartAgent(...)` for provider-native reasoning plus post-tool reflection.
- Reflection persistence on `state.reflections` plus `reflection` events for streaming UIs and task timelines.
- Native provider reasoning mappings for OpenAI/Azure/OpenAI-compatible, Anthropic, and Vertex/Gemini through the built-in provider layer.

### Changed
- Documentation refreshed: limits/tokens, summarization, tool development, runtime profiles, native providers, getting started, and API reference now cover the new budget surfaces, prompt caching, parallel tool exec, tool cache/retry, delegation enforcement, and the pluggable token counter.

### Changed (breaking)
- **Tool response retention collapsed to a single lazy-summarizer model.** Tool outputs are never reduced at tool-call time. When the summarizer runs (context limits reached), old tool messages are rewritten according to `toolResponses.defaultPolicy` (default: `summarize_archive`). The full payload always stays available via `get_tool_response` because it is stored in `state.toolHistory` / `state.toolHistoryArchived`.
- Removed config fields (no backward compatibility):
  - `toolResponses.smallResponseChars`
  - `toolResponses.smallResponsePolicy`
  - `toolResponses.largeResponsePolicy`
  - `toolResponses.fallbackPolicy`
  - `toolResponses.keepRecentFullCount`
- Removed stale no-op config fields (no backward compatibility):
  - `context.archiveLargeToolResponses`
  - `context.retrieveArchivedToolResponseOnDemand`
  - `toolResponses.retryOnSchemaError`
- Remaining config surface: `defaultPolicy`, `toolResponseRetentionByTool`, `criticalTools`, `maxToolResponseChars`, `maxToolResponseTokens`, `schemaValidation`.
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
