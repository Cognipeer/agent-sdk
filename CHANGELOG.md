# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.8.7] - 2026-07-29

### Fixed
- **`clampToBudget` no longer drops the run's context anchor.** With
  `context.policy: "raw"`, the over-budget clamp removed messages from the
  front of the transcript — and the first casualty was the first user message,
  which for worker-style agents carries the entire operating context and task
  brief. Models that lost it concluded "no task was provided" and bounced an
  `ask_user_question` back to the user mid-run (production incident class,
  2026-07). The clamp now pins every system message plus the FIRST user
  message, and drops the oldest assistant/tool exchanges (adjacency-safe)
  instead. When nothing droppable remains, the view is returned over budget
  rather than destroying the anchor.
- **Hybrid turn window keeps the first user message in both counting modes.**
  `collectRecentTurns` only re-attached the first user message when it was
  counting assistant turns; a conversation with more user turns than
  `lastTurnsToKeep` silently lost its original instruction from the model view.
- **Post-loop structured-output finalizer respects run pauses and budget
  signals.** After the main loop exited for an `ask_user_question` /
  tool-approval pause, a cancellation, a summarization signal, a breached
  limit, or a guardrail block, the tool-based finalizer still nudged the model
  and executed resulting tool calls. That stacked duplicate pending questions
  while the run was supposedly suspended, ran tools after the pause, and
  issued model calls on an over-budget context (provider 400s) with a dangling
  unresolved tool_calls tail. The finalizer now skips those exits entirely and
  stops immediately if a pause is raised during one of its own rounds.
- **Tool-call ARGUMENTS can now be reclaimed under context pressure.** Retention
  policies rewrote tool RESPONSES only, so content-authoring calls whose
  arguments carry the payload (file writes, document chunks — often tens of
  kilobytes each) kept the context growing no matter how aggressively responses
  were archived, eventually forcing destructive clamping. Arguments are now a
  first-class retention axis — see the two-axis retention entry under **Added**.

### Added
- **Two-axis tool retention: `input` (arguments) and `output` (result).** Value
  density is per-tool — a search tool carries a short query and returns the bulk,
  while a file writer is the mirror image — so one policy could never serve both.
  Argument retention is now its own axis, and it is **opt-in**:

  ```ts
  // Declared by the tool author, who knows whether args are payload or identity:
  createTool({
    name: "append_to_file",
    schema: z.object({ filePath: z.string(), mode: z.string(), content: z.string() }),
    func: appendImpl,
    retention: { input: "digest", output: "summarize_archive" },
  });

  // ...or overridden per tool by the caller, either axis independently:
  createSmartAgent({
    toolResponses: {
      retentionByTool: { create_text_file: { input: "digest" } },
      // defaultInputPolicy: "digest",   // opt every non-protected tool in at once
    },
  });
  ```

  `input: "digest"` is **field-level, never whole-object**: only string fields
  longer than `maxToolInputFieldChars` (default 2000) are replaced with a
  `{"__digest":{chars,sha256,head,recover}}` descriptor, so identifying scalars
  (`filePath`, `mode`, ids, indexes) survive verbatim and the model can still
  state exactly what it did. Rewrites stay valid JSON (Bedrock's `toolUse`
  mapping parses arguments), `toolHistory` keeps the original, and the protected
  recent window is never touched.

  Hard invariants that config cannot override: control-plane tools (`response`,
  `manage_todo_list`, `ask_user_question`, `open_skill`, `bind_skill_tools`,
  `search_skills`, `get_tool_response`) and delegation tools (`delegate_to`,
  `spawn_subagent`, `spawn_subagents_parallel`) are never digested — their
  arguments are how the loop steers itself. Assistant turns carrying signed
  reasoning blocks are skipped as well, since Anthropic/Bedrock extended
  thinking replays those blocks verbatim alongside their `tool_use`.

  Control-plane tools additionally *default* to `keep_full` on the output axis
  (overridable per tool), so a skill's guidance or a user's answer is not
  archived out from under the run.

  **Fully backward compatible.** `defaultInputPolicy` defaults to `"keep"`, so no
  existing caller sees a behavior change; the legacy single-axis
  `toolResponseRetentionByTool` map is still honored (consulted right after
  `retentionByTool`). New exports: `resolveInputRetention`,
  `digestToolInputValue`, `digestToolInputArguments`,
  `collectToolRetentionDeclarations`, `CONTROL_PLANE_TOOL_NAMES`,
  `DELEGATION_TOOL_NAMES`, plus the `ToolInputRetentionPolicy` /
  `ToolRetentionSpec` types.
- **`get_tool_response` can page ARGUMENTS back in: `part: "input" | "output"`.**
  Recovery was output-only, so a digested argument had no way back — and the
  recovery gate only scanned message `content`, missing digest markers that live
  in `tool_calls[].function.arguments`. The gate now scans tool-call arguments
  too, `"__digest"` counts as a recovery reference, and `part: "input"` returns
  the exact arguments the tool ran with. `part` defaults to `"output"`, so
  existing callers are unaffected.
- **`prepare` script** so git-based installs (`npm i github:Cognipeer/agent-sdk#branch`)
  build `dist/` automatically and `npm publish` always ships a fresh build.

## [0.8.6] - 2026-07-29

### Changed
- Internal refactor: extracted the shared `recordUsage` helper for per-request
  usage accounting (behavior unchanged).

## [0.8.5] - 2026-07-27

### Added
- **Search-based skill discovery — `skillPolicy.disclosure: "search"`.** Until now the only
  way for a model to learn which skills exist was the `<available_skills>` block, which renders
  every skill's header into the system prompt. That is the right trade for a small curated
  catalog, but it makes prompt cost scale with the catalog: a workspace with 40 installed skills
  pays 40 header lines on every turn of every conversation, almost all of them irrelevant to the
  task at hand.

  Under `disclosure: "search"` nothing is rendered into the prompt. The runtime registers a
  `search_skills` tool instead, so discovery costs one tool description (constant) plus one tool
  call when the model actually needs a capability:

  ```ts
  createSmartAgent({
    model,
    skills,
    skillPolicy: { ...DEFAULT_SKILL_POLICY, disclosure: "search" },
  });
  ```

  `search_skills({ query, limit? })` returns `{ skills: [{ skillKey, title, header }], total, hint }`,
  ranked by the new exported `searchSkills()` — a pure, deterministic keyword/prefix matcher over
  key, title and header (no embeddings, no I/O, Unicode-aware so non-ASCII catalogs rank correctly).
  An omitted query lists the catalog, and so does a query that matches nothing — a lexical
  ranker cannot bridge a Turkish question against an English-authored header, but the model
  reading those headers can, so a miss hands it the catalog head rather than an empty result.
  `open_skill`'s description and error text point at `search_skills` instead of the prompt block
  in this mode.

  Two behavioral notes: discovery is no longer guaranteed — a model that never calls
  `search_skills` never learns skills exist, so the tool description carries that weight — and
  `isAvailable` is now resolved inside the tool call rather than once per invoke, which means an
  integration that connects mid-run shows up on the next search.

  The default is unchanged (`"catalog"`), so existing agents behave exactly as before.

  New exports: `SkillDisclosure`, `searchSkills`, `createSearchSkillsTool`.

## [0.8.4] - 2026-07-26

### Fixed
- **`ask_user_question` was registered twice on a smart agent's base runtime**, which made
  `resume()` fail against providers that validate tool configs. `createSmartAgent` builds the
  ask-user tool into the tool list it hands to `createAgent` *and* forwards `humanInTheLoop`
  alongside it, so the factory attached a second copy of the same tool. `invoke()` hid the
  problem — the smart layer rebuilds a fresh tool set per call — but `smartAgent.resume` **is**
  the base agent's resume, so the duplicated list went straight to the provider. The first turn
  worked and *answering* the question blew up:

  ```
  Bedrock 400: The tool ask_user_question is already defined at toolConfig.tools.14
  ```

  OpenAI-family providers accept duplicate tool names, so this looked model-specific rather than
  like an SDK bug. `createAgent` now attaches its built-ins (`ask_user_question`, and the
  tool-based structured-output `response` finalizer) only when the caller's list does not already
  carry a tool of that name.

### Added
- **`ASK_USER_TOOL_NAME`** is exported from the root, so callers that inspect or filter an
  agent's tool surface do not have to hardcode the string.

## [0.8.3] - 2026-07-26

### Added
- **`file` and `audio` content parts across the native provider layer.** New unified `FileContent` / `AudioContent` types (exported from the root and `providers/`) let multimodal messages carry documents (PDF, DOCX, CSV, …) and audio clips alongside text/images. Per-provider wire mapping:
  - **Vertex/Gemini**: `inlineData` (base64) / `fileData` (URL) parts — Gemini's native document & audio understanding.
  - **Anthropic**: `document` blocks (base64 + URL sources, `title` from `fileName`); audio degrades to a visible text placeholder (no API support).
  - **OpenAI Chat Completions**: `file` blocks (`filename` + `file_data` data URL) and `input_audio` blocks; URL file sources degrade to a text reference (no URL source in Chat Completions).
  - **OpenAI Responses** (reasoning models): `input_file` (`file_data`/`file_url`) and `input_audio`.
  - **Bedrock Converse**: `document` blocks (format inferred from MIME/file name, sanitized `name`); audio degrades to a text placeholder.
- **Adapter normalization for incoming attachment shapes.** `fromNativeProvider` now recognizes LangChain-style standard data blocks (`{type: "file"|"audio", source_type: "base64"|"url", data|url, mime_type, metadata.filename}`), OpenAI `input_audio` parts, raw data URLs, and already-unified `source` objects — previously any non-text/image part was `JSON.stringify`-ed into the prompt as text (a token bomb that also hid the attachment from the model).
- Shared media helpers (`providers/utils/media.ts`): URL/file-name → MIME inference, audio MIME → OpenAI format, document MIME → Bedrock format, Bedrock document-name sanitizer.

### Fixed
- **Vertex URL images no longer hardcode `image/jpeg`.** `fileData.mimeType` is now taken from the part's `mediaType` or inferred from the URL extension, falling back to `image/jpeg` only when unknown.

## [0.8.2] - 2026-07-23

### Added
- **Tracing: caller-supplied `sessionId`** — `TracingConfig.sessionId` lets a
  caller key the trace session by their own run/task/chat id instead of the
  auto-generated `sess_…` id, so emitted traces correlate with the caller's
  records. Falls back to a generated id when omitted.
- **Tracing: `agentName` override** — `TracingConfig.agentName` overrides the
  SmartAgent's own name in the emitted session/start payload.

### Changed
- **Tracing transport is now reliable.** The `cognipeer`/`http` streaming and
  batched posts (`start`, `end`, full-session) retry transient failures
  (network error, timeout, 404/408/425/429/5xx) with exponential backoff +
  jitter, honor `Retry-After`, and apply a per-attempt timeout. Retries are
  safe because the ingest is idempotent (start/end upsert by `sessionId`; the
  `end` carries the authoritative summary). Per-event posts remain best-effort
  single-attempt to avoid inflating dedup-less event counts. Previously a single
  transient failure silently dropped the session.

## [0.8.1] - 2026-07-20

### Added
- **ContextPilot: native, deterministic context/token optimization layer.** Runs at tool-execution time (no extra model calls) to shrink large tool outputs before they enter the transcript, while keeping every original payload recoverable. **Opt-in** — disabled unless `contextPilot: { enabled: true }` (or an equivalent override) is passed explicitly to `createSmartAgent` (see `docs/guide/context-pilot.md`). Highlights:
  - **Format-aware compression.** BM25-lite relevance scoring drives `jsonCrusher` (large arrays), `textCrusher` (long plain text, sentence-level), plus dedicated `diffCompressor` (unified diffs), `logCompressor` (ERROR/WARN-prioritized log lines), and `searchCompressor` (grep/search matches with per-file diversity caps).
  - **Reversible Compress-Cache-Retrieve (CCR) store.** Every dropped/compressed payload is kept in an in-memory, TTL/LRU-bounded store keyed by a content hash; the compressed output carries a retrieval note, and the model can call the built-in `get_tool_response` tool with that `executionId` to get the full original data back. If `ccr.enabled: false` or `ccr.maxEntries: 0`, drop-based compression (json/text/diff/log/search) is skipped entirely rather than emitting a `get_tool_response` marker that can never be resolved; cross-turn dedup is unaffected since its pointers reference transcript history, not the CCR store.
  - **Cross-turn duplicate detection (`dedup`).** Byte-identical tool outputs seen again later in the same session are replaced with a lightweight `DUPLICATE_TOOL_RESPONSE` pointer instead of being resent in full.
  - **Cache alignment warnings.** Optional scan of the system prompt for volatile substrings (UUIDs, ISO/Unix timestamps, JWTs, hex hashes, API keys) that would defeat provider-side prompt caching; emits a one-time `context_pilot_cache_alignment` metadata event instead of rewriting the prompt.
  - **`excludeTools`** to opt specific tools out entirely.
  - **Runtime-profile aware defaults**: `fast`/`balanced`/`deep`/`research` scale `compression.json`/`text` `targetRatio` and `ccr.ttlMs`/`maxEntries` alongside the existing limit/context defaults.
  - Real-model A/B benchmarks (real pre-ContextPilot commit vs this branch, via `examples/context-pilot-comparison/`) measured **29–48% prompt-token reduction** across catalog lookups, repeat-query dedup, multi-tool incident investigations, and long multi-turn sessions, with no loss of answer correctness and full data recoverability confirmed via `get_tool_response`.

### Fixed
- **Restore provider tool-result coalescing dropped in 0.8.0.** The published `0.8.0` was built from the feature branch before the Anthropic / Bedrock / Vertex tool-result coalescing (shipped in `0.7.3`) was merged, so `0.8.0` regressed it. `0.8.1` combines both: the skills / sub-agents / ask-user work **and** the coalescing of multiple `tool_result` blocks into a single user message per provider request. Upgrade `0.8.0 → 0.8.1` to regain correct strict tool_use/tool_result pairing on tool-heavy turns.

## [0.8.0] - 2026-07-20

### Changed (BREAKING)
- **Default runtime-profile values modernized for frontier models.** All four built-in profiles (`fast`, `balanced`, `deep`, `research`) had their numeric defaults rescaled for 2026-era models (Claude 4.x, GPT-4o, Gemini 2.x). The previous defaults were tuned for 8k–16k context windows and now leave too much headroom unused. Headline changes per profile:
  - `fast`: `maxToolCalls 4→8`, `maxParallelTools 1→3`, `maxContextTokens 12000→32000`, summarization trigger `9000→24000`, `maxToolResponseChars 8k→16k`.
  - `balanced` (also the shared baseline): `maxToolCalls 8→20`, `maxParallelTools 2→5`, `maxContextTokens 24000→96000`, summarization trigger `17000→72000`, `lastTurnsToKeep 8→16`, `maxChildCalls 4→6`, `maxToolResponseChars 12k→32k`.
  - `deep`: `maxToolCalls 14→40`, `maxParallelTools 3→8`, `maxContextTokens 42000→200000`, summarization trigger `30000→150000`, `lastTurnsToKeep 12→30`, `maxChildCalls 6→10`, `maxToolResponseChars 16k→64k`.
  - `research`: `maxToolCalls 20→80`, `maxParallelTools 4→10`, `maxContextTokens 56000→400000`, summarization trigger `42000→300000`, `lastTurnsToKeep 20→60`, `maxChildCalls 8→16`, `maxParallelChild 3→6`, `maxToolResponseChars 24k→96k`.
  - **Migration:** if you depend on the old conservative caps (e.g., running against an 8k-window model, strict cost ceilings, or a deliberate "tight loop" agent), pass explicit `limits`, `summarization`, `context`, and `toolResponses` overrides — or build a `customProfile` extending the desired base and clamp the values you care about. Behavioral defaults (planning still `off`, `summaryMode: incremental`, `memory.writePolicy: auto_important`, `context.policy: hybrid`) are unchanged.

### Added
- **Coalesced tool results for Anthropic / Bedrock / Vertex.** Multiple `tool_result` blocks answering one assistant turn are now merged into a single user message per provider request, satisfying the providers' strict tool_use/tool_result pairing and reducing message overhead on tool-heavy turns.
- **Testing & evaluation surface.** New deterministic suites for the sub-agent primitive (`tests/unit/subagents*.test.ts` — intersections with structured output / guardrails / borrowed tools, plus snapshot serialize→resume round-trips, depth/cancellation/fan-out resilience). New `tests/integration/evalHarness.integration.test.ts` runs the public `runSmartAgentEvalHarness` with a scripted model (key-free) to guard the scoring math, and `tests/integration/providerMatrix.integration.test.ts` (`npm run test:matrix`) verifies tool-calling / structured-output / streaming against any real provider whose credentials are present (OpenAI, Anthropic, Azure, Bedrock, Vertex), skipping the rest. Coverage thresholds raised toward current actuals (statements/lines 55, functions 60, branches 45). Docs: new [Testing & Evaluation guide](docs/guide/testing.md) and refreshed `tests/README.md`.
- **Sub-agents (dynamic problem decomposition).** **Opt-in** — a plain `createSmartAgent({ model })` registers no sub-agent tools; pass `subagents: SubagentDef[]` and/or `subagentPolicy` to expose three built-in tools and an `<available_subagents>` system-prompt catalog: `delegate_to(subagent, input)` for predefined registry sub-agents, `spawn_subagent({ role, prompt, input, tools? })` for ad-hoc specialists the orchestrator defines at runtime, and `spawn_subagents_parallel({ tasks })` for concurrent fan-out (bounded by `subagentPolicy.maxParallel`). When enabled, the policy default is hybrid (`mode: "registry_and_adhoc"`). Children are **model-agnostic** (inherit the parent model unless `SubagentDef.model` overrides) and inherit the parent's event / streaming / cancellation / tracing wiring; each spawn emits `subagent` lifecycle events (`start` / `result` / `error` / `paused`) and forwards the child's own events (stamped with `subagentName` / `subagentId`, typed via the new `DelegationEventStamp`). Spawning reuses the existing delegation guards (`maxDepth`, `maxChildCalls`, `childContextPolicy`); sub-agents are single-level (a child never gets its own spawn tools). A tool-approval or `ask_user_question` pause inside a sequential sub-agent is surfaced to the parent and resumed transparently via `state.ctx.__subagentPending`; parallel (`spawn_subagents_parallel`) children may not request human input. Exposed: `SubagentDef`, `SubagentPolicy`, `DEFAULT_SUBAGENT_POLICY`, `SubagentResult`, `SubagentEvent`, `DelegationEventStamp`, `createSubagentTools`, plus the shared `seedChildMessages` helper (now used by both sub-agents and `asTool`).
- **Prompt-override hooks (`promptHooks`).** Intercept the SDK's otherwise-static prompt surfaces from `createSmartAgent`: `transformSystemPrompt(prompt, ctx)` rewrites the fully-composed system prompt, `toolDescriptions` overrides any built-in tool description by name (e.g. `delegate_to`, `spawn_subagent`, `open_skill`, `ask_user_question`), and `subagentCatalog(defaultBlock, subagents)` rewrites the `<available_subagents>` block. Overrides clone affected tools so shared tool objects are never mutated.
- **`asTool` now forwards observability.** Delegated children spawned via `agent.asTool(...)` previously ran "dark"; they now inherit the parent's `onEvent` / `onStream` / `onProgress` / cancellation wiring (events stamped with `delegatedTo`), and share the `seedChildMessages` context-seeding implementation with the sub-agent primitive.
- **Native reasoning round-trip (thinking blocks).** Provider responses now surface a normalized `reasoning` payload (`{ blocks, summary }`). Anthropic and Bedrock thinking / redacted-thinking blocks (with signatures) are captured on the assistant message and replayed verbatim on the next request, satisfying the providers' signed-thinking requirement. Vertex/Gemini `thought` parts and reasoning token counts are surfaced as a summary. OpenAI o-series / gpt-5 now route through the Responses API (`completeResponses`) when reasoning is requested, exposing the reasoning summary and `reasoning_tokens`; Azure OpenAI gets the same via its `/openai/responses` route. Reasoning mappers raise `max_tokens` above the thinking budget, clamp the budget below it, and strip sampling params (`temperature`/`top_p`/`top_k`) that thinking mode forbids.
- **`reasoning.level: "minimal"`.** A fourth, cheapest reasoning preset (`effort: "minimal"`, reflection off).
- **`initial_then_after_tool` reflection cadence.** Reflects once up-front as a planning note, then like `after_tool`. New default for `level: "medium"` / `"high"`. `on_branch` now fires on an actual tool-name-set change between turns rather than a turn-count heuristic.
- **Reflection hooks and routing.** `reasoning.reflection` accepts `shouldReflect` (override the cadence decision), `buildPrompt` (customize the probe), `onReflection` (side-effect hook), and `feedTo: "memory" | "plan" | "none"` to route the note into a `MemoryFact` or `plan.lastReflection`. Near-duplicate consecutive reflections are suppressed.
- **`validateReasoningConfig(config)`.** Exported pure validator that throws descriptive errors for invalid `level`, `cadence`, `effort`, `budgetTokens`, `everyNTurns`, or `feedTo` values; also run automatically inside `resolveReasoning`.
- **Ask-user (structured human-in-the-loop).** Opt in with `humanInTheLoop: { askUser: true }` on `createAgent` / `createSmartAgent` to register a built-in `ask_user_question` tool. When the model calls it, the runtime pauses with a `PendingUserQuestion` entry, emits a `user_question` event, and sets `ctx.__awaitingUserQuestion`. Resume by calling `agent.resolveUserQuestion(state, { id, answers })` which validates the response and appends it as a `role: "tool"` message bound to the original `tool_call_id`. The global `allowFreeText` flag (default `true`) decides whether "Other" / typed answers are accepted; when `false`, every question must include `>= 2` options and the resolver rejects `freeText`. Also exposed: `resolveUserQuestionState`, `createAskUserQuestionTool`, and types `PendingUserQuestion`, `UserQuestionItem`, `UserQuestionOption`, `UserQuestionAnswer`, `UserQuestionAnswerSet`, `UserQuestionResolution`, `UserQuestionEvent`, `HumanInTheLoopOptions`.

### Fixed
- **Sub-agent human-in-the-loop resume no longer strands the run.** When a delegating tool (`delegate_to` / `spawn_subagent`) paused for a child approval / `ask_user_question` **in the same assistant turn as another tool that completed**, the completing sibling's `tool_result` became the last message and the resume driver read tool_calls off it — so the paused sub-agent was never resumed and the run threw *"Agent loop terminated with a pending tool response…"*. The runtime now re-drives the owning assistant turn's **unresolved** tool_calls (a new `selectPendingToolCalls` helper, shared by the base loop and tools node), skipping already-completed siblings so they never re-execute.
- **Two concurrent sub-agent pauses drain deterministically.** If two delegating tool_calls in one turn both paused for input, resolving one no longer force-resolves the other with empty answers (which threw and abandoned the child). The still-unanswered pause is re-surfaced on the next resume round, and the single `ctx.__awaiting*` pause slot is no longer clobbered by a concurrent sibling.
- **Ad-hoc sub-agents keep their borrowed tools across a HITL resume.** `spawn_subagent({ tools: [...] })` children rebuilt on resume were losing their borrowed tools due to a `tools`/`toolNames` field mismatch between the durable pause record and the spec builder; the child now resumes with its full tool surface.
- **Bound skill tools survive pause/resume.** The per-invoke skill registry was rebuilt empty on every invoke, so any pause dropped every opened/bound skill tool (an approval-gated skill script tool became *"Tool not found"* on resume). Opened skill keys + bound tool names are now persisted on `ctx.__skillState` and rehydrated (re-bound) on the next invoke.
- **`promptHooks.toolDescriptions` function form no longer corrupts sub-agent tool descriptions.** The documented `(defaultDescription) => string` override was double-applied to `delegate_to` / `spawn_subagent` / `spawn_subagents_parallel`, passing the function object (not the default string) into the callback. Overrides are now applied uniformly in one place, so the callback receives the real default text.
- **Sub-agents are opt-in.** Previously a plain `createSmartAgent` registered `spawn_subagent` + `spawn_subagents_parallel` and injected an `<available_subagents>` block by default. They are now wired only when `subagents` or `subagentPolicy` is provided.
- **Parallel spawn budget is charged only for tasks that run.** `spawn_subagents_parallel` no longer counts invalid tasks (unknown sub-agent, ad-hoc disabled) against `maxChildCalls`, so a following `delegate_to` is no longer wrongly refused for an exhausted budget.
- **SKILL.md frontmatter no longer splits scalar values on commas.** A `description` (or any non-list key) containing commas is kept as a scalar string instead of being fragmented into an array, so the always-visible skill header is intact. Comma lists are split only for list-typed keys (e.g. `scripts`) or with explicit `[a, b]` syntax.
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
