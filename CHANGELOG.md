# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.22.0] - 2026-10-27

### Behaviour changes
Read these before upgrading; each one can change what a host sees on the wire or in its error handling.

- **`ModelRequestError.code` has a new member, `"max_tokens_too_large"`.** A 400 that says the requested output size is above the model's limit used to arrive as `"model_request_invalid"`; it now carries `code: "max_tokens_too_large"` and, when the server's message states the maximum, `maxAllowed`. Parse-only: nothing is learned and nothing is retried by the model layer. A host with an exhaustive `switch` over `ModelRequestErrorCode`, or one that matched `model_request_invalid` to catch this case, must handle the new value.
- **Claude on Vertex defaults to location `global`** when `location` is not set (Gemini still defaults to `us-central1`). Regional endpoints serve Claude Sonnet 4.6 and earlier only, so a default region would reject newer models. An explicit `location` is always used as given: set it to keep a region, for example for data residency. Note that `global` routes the request to Google's global endpoint, not to a region you chose.
- **`OpenAICompatibleProvider` auto cache marker is on the last user message only.** With `prompt_caching: { strategy: "auto" }` the marker no longer follows the tail through a tool loop (it used to sit on a trailing tool result). It stays on the user turn that opened the loop, because OpenRouter and LiteLLM document `cache_control` on system and user text only. Caching remains off unless enabled.
- **A stream that ends without a terminal event now throws a retryable `ProviderError` (status 502)** instead of ending as a clean `stop`: a Responses stream that ends before `response.completed`, an Anthropic stream with no `message_stop` / stop reason, a Bedrock stream with no `messageStop`. A call cancelled through its `AbortSignal` is not an error. Hosts will see retries (or errors) where a truncated reply used to pass silently.
- **`refusal` maps to `finishReason: "content_filter"`** on Anthropic (and Claude on Vertex). `pause_turn` maps to `stop`; the raw value stays in `rawFinishReason`.
- **Responses API request body changes (OpenAI, Azure, compatible).** `temperature` is now sent when the model's rule allows sampling (it was always omitted), and `parallel_tool_calls` when tools are present and the caller set it. Reasoning models get `include: ["reasoning.encrypted_content"]`, and the returned reasoning items are replayed on the next call of a tool loop. On Azure the include is sent only on the `v1` route, `preview` / `latest`, or a dated `apiVersion` >= `2025-04-01`; older versions reject it. `extra: { include: null }` opts out. The 60 snapshots in `openaiTransportRegression.test.ts` were re-recorded for these changes.
- **Chat Completions stream chunks no longer carry `finishReason: "stop"` while generating.** Only the chunk whose choice has a `finish_reason` sets `finishReason` / `rawFinishReason`; a stream that never sends one ends with none.
- **Summarizer calls carry an output cap.** The smart agent's summarizer (any model that is not a LangChain model) is called with `maxTokens: 8192`, `reasoning: { effort: "none" }` and `purpose: "summarization"`. If the model rejects the cap with `max_tokens_too_large`, the pass retries once with the stated limit (never above the cap sent), or with no cap when none is stated. Set `summarization.outputMaxTokens: 0` to send no cap.
- **An unusable summarizer reply no longer triggers local compaction.** A reply cut off at an output limit, empty, or (default prompt only) JSON with none of the summary fields now ends the pass `skipped` with `status: "fallback"`: nothing is replaced, the previous summary stays, the tokens are booked. Before, the local fallback summary was used and tool output was archived under it.
- **Tool messages for failed calls carry `isError: true`** (tool not found, invalid arguments, policy / reviewer / approval denial, execution-limit skip, circuit breaker open, thrown or reported tool failure, cancelled or skipped call). Anthropic sends `tool_result.is_error` and Bedrock `toolResult.status: "error"` for them, which changes the request body of those turns.
- **Empty text is replaced on Anthropic and Bedrock.** An empty tool result is sent as `(no output)`; an empty user or assistant message drops the empty block and falls back to `(empty message)` only if nothing else is left.
- **Bedrock `additionalModelRequestFields.thinking` is sent for Claude ids only.** Other families (Nova, Llama, gpt-oss, Mistral, ...) get no reasoning fields and keep their sampling params; use `request.extra` for their own controls. No id, or an opaque application inference profile ARN, is still treated as Claude.
- **Gemini 3+ never gets `thinkingBudget`.** Effort maps to `thinkingLevel`; a numeric `budgetTokens` picks the nearest level. Gemini 2.5 Pro maps effort `none` to a 128 budget (it cannot be turned off). Details under Fixed.
- **The Anthropic / Bedrock system cache breakpoint sits after the static system part**; dynamic system blocks follow it.

### Added
- **Claude models on Vertex.** `VertexProvider` serves model ids starting with `claude` (optionally `publishers/anthropic/models/<id>`) through `:rawPredict` / `:streamRawPredict`, reusing the Anthropic body, caching, thinking, tool handling and stream parsing (`vertexAnthropic.ts`). The body carries `anthropic_version: "vertex-2023-10-16"` (a caller's `extra.anthropic_version` wins) and no `model`; auth is the provider's bearer token. A dated id such as `claude-haiku-4-5-20251001` is sent as `claude-haiku-4-5@20251001`. Hosts: `global`, the multi-regions `us` / `eu` (`aiplatform.{us|eu}.rep.googleapis.com`) and regions. Capabilities follow the model (Claude ids use the response tool). Usage is reported on the Vertex basis whatever the model: input includes cache read and write, reasoning is split out of the output. URL image and document sources are refused client-side with a non-retryable 400 asking for base64 (the URL is never echoed); server tools, the MCP connector, the Files API and Message Batches are not available on Vertex.
- **`VertexProviderConfig.prompt_caching` and `thinkingMode`** (Claude models only; caching off unless enabled), `gcloudTimeoutMs` (default 30000) for the `gcloud auth print-access-token` fallback, and exports `VertexAnthropicProvider`, `vertexClaudeModelId`, `VertexClaudeOptions`. `AnthropicProvider` gained protected transport hooks (`requestUrl`, `requestHeaders`, `wireBody`, `normalizeUsage`); its behaviour is unchanged.
- **`TextContent.cacheControl?: { type: "ephemeral"; ttl?: "5m" | "1h" }`.** A prompt-cache breakpoint on a text part, honoured by Anthropic (`cache_control` on text, tool_result text and system text), Bedrock (a `cachePoint` block after it) and OpenAI-compatible. OpenAI and Azure never send it. At most 4 breakpoints per request: the caller's markers win and the SDK's own are added only while slots remain. A caller's `5m` marker before a `1h` one downgrades the later one to `5m`. Thinking blocks and empty text never get a marker. `fromNativeProvider` carries it across.
- **`OpenAICompatibleProviderConfig.prompt_caching`** (`{ enabled, strategy: "auto" | "static", ttl }`, off by default, Chat Completions only) for servers that forward `cache_control` to Claude-class models, and **`replayReasoningContent`** (default `false`) which sends the reasoning summary text back as `reasoning_content` on assistant turns, as DeepSeek thinking mode requires in a tool loop. A server that rejects an unknown `cache_control` field answers 400 and the SDK does not learn that: leave caching off there.
- **`ModelRequestError.maxAllowed`** and `ParsedModelError.maxAllowed` / kind `max_tokens_too_large` from `parseModelError`.
- **`summarization.outputMaxTokens`** (default 8192, `0` = no cap) and **`summarization.reasoningEffort`** (default `"none"`).
- **`ChatCompletionRequest.purpose`** (`"summarization"` | `"reflection"`) for host routing and cost attribution, and **`UnifiedMessage.isError`**.
- **Azure `apiVersion: "v1"`** posts Responses to `{endpoint}/openai/v1/responses` with no `api-version`; chat and embeddings keep their dated deployment routes (`2024-10-21`).
- **Model rules.** `ReasoningStyle` gains `"level"`, `reasoning.minBudget` and `reasoning.defaultOn` are new optional fields in `model-rules.json` (visible through `@cognipeer/agent-sdk/model-rules.json`). Seven Gemini 3 rules and a Gemini 4+ level-only rule were added; `applyGeminiReasoning` takes `{ model?, rule? }` as a third argument (without a model the budget style applies).
- **Vertex `seed`, `presencePenalty`, `frequencyPenalty`** now reach `generationConfig` when set. `topK` is not forwarded.
- **Bedrock** maps `malformed_model_output` / `malformed_tool_use` to `error` and `content_filtered` / `guardrail_intervened` / `guardrail` to `content_filter`; image tool-result parts become Converse image blocks and JSON object content a `json` block.

### Changed
- **Claude Mythos Preview** has its own rule: `budget_tokens` extended thinking is sent (`enabled` + `budget_tokens`), effort `none` sends no `thinking` field (never `disabled`). Mythos 5 / 5.1 and Fable stay adaptive-only; a `budgetTokens` on them maps to adaptive + effort. Claude 5.x rules carry `defaultOn`: `includeThoughts: true` with no effort or budget sends `thinking: { type: "adaptive", display: "summarized" }` only. Applies to Anthropic, Claude on Vertex and Bedrock.
- **Bedrock 1-hour cache TTL** is sent only for Claude 4.5 and later (`bedrockSupportsOneHourTtl`; ARN prefix, region prefix and `anthropic.` are stripped before parsing). Claude 3.x, 4.0 / 4.1, Nova, unrecognised and opaque application-profile ids get a plain 5-minute checkpoint with no `ttl`, which avoids `ValidationException`. The same rule covers per-part `cacheControl` and the provider default `ttl`.
- **Gemini thinking.** Gemini 3 sends `thinkingLevel` (Pro: low / high; 3.1+ Pro: low / medium / high; Flash and Flash-Lite: minimal..high; 3.7 / 3.8 Flash: low..high; image models by their own table); Gemini 4 and later is level-only (no MINIMAL). A numeric `budgetTokens` on a level model picks the nearest level (<= 1024 low, <= 8192 medium, else high, clamped to the model's levels); an explicit `providerExtras.thinkingBudget` is still sent as given.
- **Vertex multi-regions.** Gemini chat, stream and embeddings reach `us` / `eu` at `aiplatform.{us|eu}.rep.googleapis.com`; `global` uses `aiplatform.googleapis.com`.
- **Reflection tokens** are booked in the ledger and counted against the budgets like agent calls (`maxPerRun` counts stored reflections only).

### Fixed
- **Vertex auth.** Service-account tokens are cached per process (key: client email + scope + a digest of the private key), shared by every `VertexProvider`, refreshed shortly before expiry from `expires_in`, with concurrent refreshes coalesced and failures never cached. The `gcloud` fallback no longer blocks the event loop (`execFile`, no shell off Windows, cached ~58 minutes per instance); a timeout fails with `gcloud timed out after N ms ... Raise gcloudTimeoutMs, or provide accessToken or serviceAccountJson`.
- **Vertex Gemini request shape.** Tool parameters and `responseSchema` go through a Gemini schema sanitizer: `$ref` / `$defs` inlined (a recursive reference degrades to `{ type: "object" }`), unsupported keywords dropped, `const` becomes a one-value enum, `["x", "null"]` becomes `nullable`, `oneOf` is sent as `anyOf`, integer / number enums carry `format: "enum"`, boolean enums are dropped, a multi-member `allOf` is merged. A tool choice naming a function now sends `mode: "ANY"` with `allowedFunctionNames` instead of `AUTO`. `functionResponse.name` is resolved from the earlier call with the same `toolCallId`.
- **Gemini 3+ thinking.** Effort `none` sends `MINIMAL` as asked. Unsigned `functionCall` parts of the current turn get the documented `skip_thought_signature_validator` value (first call of each model step after the latest user message; Gemini 2.5 and earlier turns untouched). Thought signatures on text parts now round-trip through `reasoning.blocks`. Gemini 2.5 Pro with effort `none` sends budget 128; 2.5 Flash and Flash-Lite still use 0.
- **Claude Mythos Preview** is no longer sent `thinking: disabled` or rejected `budget_tokens` (see Changed).
- **Responses API.** Reasoning items are requested and replayed inside a tool loop (OpenAI and compatible servers without `id` / `status`, Azure with ids); an endpoint that refuses them costs one extra request and replay is switched off for that endpoint and model on that provider instance. `Unrecognized request argument supplied: <name>` is handled as an unsupported parameter for any name (retried without it and learned), not only `stream_options`; `Encrypted content is not supported with this model` drops the include. `stream_options` rejections ("Extra inputs are not permitted", "unknown field", "is not supported") now teach the SDK to drop it, so streaming continues without usage.
- **Anthropic stream errors.** SSE `error` events throw a `ProviderError` with the HTTP status of the error type, so 429, 500, 504 and 529 are retried.
- **Summarizer and tools.** A billed summarizer call whose reply is unusable leaves a `Context Summarization Failed` trace event (`status: "error"`) with its tokens, usage basis, cache writes, response id / model and raw finish reason.

### Notes
- Usage `cache_write_tokens` (Responses `input_tokens_details`, chat `prompt_tokens_details`) was already read as a cache write on the inclusive basis; it is now covered by tests.
- Not done: Vertex `topK`. Vertex Claude streaming assumes the standard Anthropic SSE events. The Bedrock 1-hour TTL allow-list is derived from AWS's supported-models table, not from a live call.
- `docs/changelog.md` is a stale partial copy (it stops at 0.6.5), so it was not updated.

## [0.21.0] - 2026-10-26

### Added
- **`BaseProvider.usageBasis`.** Optional `WireUsageBasis` saying how the provider's own `TokenUsage` counts tokens. Unset = derived from `providerName` (`usageBasisOf`: Anthropic and Bedrock `inputTokens` leave out the cache read + write, Vertex `outputTokens` leaves out the reasoning). An explicit `{}` means "already inclusive": a gateway or wrapper that normalised the usage itself and still reports an `anthropic` / `bedrock` / `vertex` provider name must declare it, or `fromNativeProvider` adds the cache a second time.
- **The usage ledger keeps cache writes.** `NormalizedUsage.prompt_tokens_details.cache_write_tokens` (read through `cacheWriteTokensOf`, so every spelling it knows), `state.usage.perRequest[].cacheWrite` and `state.usage.totals[model].cacheWriteInput` (optional in the type; a ledger restored from an older run reads as 0). `recordUsage`, `totalUsage`, `appendUsageEntries` and `splitUsage` carry it, sub-agent calls included, with the same split rules as the other counters. `cachedInput` / `cacheWriteInput` are subsets of `input`.
- **`costEstimator` receives `cacheWriteTokens`.** The argument is passed by `limits.maxCostUsd`, `budgetGuard` and `sessionMetrics`, built in one place (`costEstimatorArgsOf` in `utils/usage.ts`) instead of three copies. `inputTokens` is INCLUSIVE (uncached + cache read + cache write); `cachedInputTokens` and `cacheWriteTokens` are subsets of it and `reasoningTokens` is a subset of `outputTokens`, so a price table bills `(input - cached - cacheWrite) * in + cached * read + cacheWrite * write + output * out`. An estimator that ignores the new argument is unaffected.
- **Anthropic reports usage at `message_start`.** The stream now yields a usage chunk (input, cache read, cache write, the first output count; empty delta, no finish reason) as soon as the stream opens, so a stream that is cut or cancelled before `message_delta` still carries what the prompt cost. `message_delta` also reads `input_tokens` / `cache_read_input_tokens` / `cache_creation_input_tokens` when the API repeats them. Every usage chunk a provider stream yields is CUMULATIVE: a consumer keeps the last one and never adds them. Bedrock has no equivalent: a Converse stream reports usage only in its final `metadata` event, so a cut Bedrock stream has none (a host that bills a cancelled stream has to estimate the input).
- **OpenAI-compatible cache dialects.** One reader (`usageFromOpenAIShape`) serves Chat Completions and Responses: cache read from `prompt_tokens_details.cached_tokens` / `input_tokens_details.cached_tokens` (OpenAI, Azure, OpenRouter), DeepSeek `prompt_cache_hit_tokens` and Moonshot's top-level `cached_tokens`; cache write from `prompt_tokens_details.cache_write_tokens` / `input_tokens_details.cache_write_tokens` (OpenRouter) and LiteLLM `cache_creation_input_tokens` (`cachedWriteTokens` was always 0 before). In all of them `prompt_tokens` already includes the cached tokens, so the input is kept as reported. Guard: when read + write exceed `prompt_tokens` the server left the cache out (an Anthropic-style usage forwarded verbatim) and it is added back. `reasoningTokens` is the reported count (0 = not reported, never an estimate) and is clamped to the output.
- **The `langfuseTracing` plugin applies the same basis rule as the OTLP export.** A message that declares `inputExcludesCache` / `outputExcludesReasoning` (a hand-built or LangChain message) is reported with the cache / reasoning added back, so Langfuse and OTLP agree on input and output for one call.
- **Prompt caching strategy and TTL.** `prompt_caching` on the Anthropic and Bedrock providers takes `PromptCachingConfig` `{ enabled, strategy?: "auto" | "static", ttl?: "5m" | "1h" }` (exported); `{ enabled: true }` keeps working. `ttl` is sent only for `"1h"`, on every marker of the request, so the longer-TTL-first rule always holds.
- **Anthropic automatic caching for the conversation tail.** With the default `strategy: "auto"` the request carries a top-level `cache_control` next to the system and last-tool markers, so the breakpoint follows the growing conversation (the vendor's recommended agent-loop setup). It is skipped when `extra` already sets `cache_control` (null included) or when 4 explicit markers are in use.
- **Bedrock rolling cache checkpoint.** Converse has no automatic caching, so with `strategy: "auto"` a `cachePoint` is appended to the last user message (text or tool results) on every request, after the system and tools checkpoints (at most 4).
- **Bedrock caching knows the model family.** Amazon Nova gets system and message checkpoints only (no tools checkpoint, no `ttl`). Converse families without explicit caching (meta, mistral, cohere, ai21, deepseek, openai, qwen, writer, stability, luma, twelvelabs, amazon.titan) get none. ARNs and unrecognised ids keep the previous behaviour.
- **`reset` stream chunk.** A provider stream may yield `{ reset: true }` to start the answer over, for example a host that retries a call cut off by its output limit inside one stream. `fromNativeProvider` drops the text, tool calls, reasoning (thinking blocks included) and finish reason gathered so far, so the final message holds only the new attempt. Deltas already yielded cannot be taken back, and usage stays cumulative.
- **Output-limit outcome for cut-off tool calls.** A reply that stops on the output limit (finish reason `length`) with tool calls ends the run with `ctx.__limitBreached` starting with `maxOutputTokens`. It is reported through the same `metadata.limitBreached` event and `limit` notification as the budget limits.
- **`rawFinishReason` on the OpenAI Responses API paths** (stream, emulated stream, non-stream): `incomplete_details.reason` when incomplete (for example `max_output_tokens`), otherwise the status (for example `completed`).
- **Gemini block reasons.** A prompt blocked before generation (`promptFeedback.blockReason`, no candidates) returns `finishReason: "content_filter"` with the block reason as `rawFinishReason` and empty content.
- **Adaptive thinking output floors.** New `adaptiveMaxTokens` table in model-rules.json (minimal 4096, low 8192, medium 16384, high 32768, xhigh and max 64000), exported as `ANTHROPIC_ADAPTIVE_MAX_TOKENS`.

### Changed
- **`message.usage` and `response_metadata.token_usage` are now truly INCLUSIVE for Anthropic, Bedrock and Vertex.** The shape always documented `prompt_tokens` as including `cached_tokens` and `completion_tokens` as including `reasoning_tokens`, but the adapter copied the provider's native counters. `fromNativeProvider` now converts: for Anthropic and Bedrock `prompt_tokens = inputTokens + cacheRead + cacheWrite`, for Vertex `completion_tokens = outputTokens + thoughts`, and `total_tokens = prompt_tokens + completion_tokens` (a provider's own total is not trusted to cover the same parts). The details (`cached_tokens`, `cache_write_tokens`, `reasoning_tokens`) stay subsets. The provider-level `TokenUsage` keeps its native basis (documented on the type); `toMessageUsage(usage, basis?)` takes the basis (omitted = inclusive, source compatible). Visible effect: for Anthropic / Bedrock runs with prompt caching `usage.totals[model].input` and a `costEstimator`'s `inputTokens` grow by the cache tokens, and `limits.maxCostUsd` trips sooner (an estimator that subtracts `cachedInputTokens` from `inputTokens` is now right; subtract `cacheWriteTokens` too).
- **Adapter messages declare no `usageBasis`.** `fromNativeProvider` attaches wire info with `usageBasis: {}` after the conversion, and `attachWireInfo` leaves an empty basis out, so trace records and the OTLP export (`gen_ai.usage.input_tokens`) take the converted figure once instead of adding the cache again. The exclusive branch stays for hand-built messages, LangChain wrappers and records written by older SDKs. `WireUsageBasis` now describes the counters of the message it is attached to.
- **Migration.** A host that folded the cache into the input itself (for example a gateway that already normalises usage) must declare `usageBasis: {}` on its provider object and stop folding; with `@cognipeer/agent-sdk` < this release the field is ignored.
- **Bedrock `totalTokens` is `inputTokens + outputTokens`** (the service's own figure is not documented to cover the cache); the adapter recomputes it after the fold anyway.
- **Enabling Anthropic/Bedrock prompt caching now also caches the conversation tail** (`strategy: "auto"` is the default). Set `strategy: "static"` for the 0.20 system + last-tool behaviour.
- **Anthropic default `max_tokens`.** When the request has no `maxTokens`, models that think adaptively by default fall back to 16384 instead of 4096, and a requested effort raises that default to the effort's floor (high 32768, xhigh/max 64000). A caller's `maxTokens` is never raised: adaptive thinking, unlike a thinking budget, does not need room above it, so it stays a hard cap. Bedrock is unchanged (an unset `maxTokens` is already the model maximum).
- **Gemini thinking budget.** A numeric `maxOutputTokens` below `thinkingBudget + 2048` is raised to that value, like the Anthropic budget rule. Dynamic (-1), 0 and `thinkingLevel` configs are left alone.
- **OpenAI-compatible finish reasons.** `max_tokens`, `model_length` and `max_output_tokens` map to `length`; `insufficient_system_resource` maps to `error`. `rawFinishReason` stays the raw string.
- **Gemini finish reasons.** `PROHIBITED_CONTENT`, `BLOCKLIST`, `SPII` and `IMAGE_SAFETY` map to `content_filter`; `MALFORMED_FUNCTION_CALL` and `UNEXPECTED_TOOL_CALL` map to `error`. Stream chunks no longer report `finishReason: "stop"` before the chunk that carries the reason, and `rawFinishReason` is set on stream and non-stream results.
- **Responses API limit precedence.** An incomplete response whose reason is `max_output_tokens` is `length` even when it holds function calls, because cut-off arguments are not usable.
- **Truncated tool calls are dropped, not run.** The kept assistant message loses its tool calls and keeps its text. A reply that was only a cut-off call gets a short stand-in text, because Anthropic and Bedrock reject an empty assistant turn when the conversation continues. The dropped calls are recorded in the trace as skipped `tool_call` events.
- **The limit flag is per run.** A `ctx.__limitBreached` left by a previous run is cleared when a run starts, so continuing a state that stopped on a limit does not stop again at once.

### Fixed
- **A summarizer reply that does not parse is still billed.** The usage of the summarization call is now read and recorded in `state.usage` before the reply is parsed, so a truncated or non-JSON reply (the fallback summary) no longer drops the tokens it cost; the trace event and the `postCompact` call record report them. A call that throws before any reply still books nothing.
- **Anthropic `model_context_window_exceeded`** maps to finish reason `length` (the raw value stays in `rawFinishReason`), matching Bedrock, instead of falling through to `stop`.
- **Responses API truncation.** Only `incomplete` with reason `max_output_tokens` maps to `length`, and `content_filter` maps to `content_filter`. Other incomplete reasons (`max_messages`, `steered`, none) no longer read as a token limit.
- **Per-call `maxTokens` was ignored.** `fromNativeProvider` honours a positive per-call `maxTokens` / `max_tokens` / `maxOutputTokens` over the adapter default for invoke and stream. The reflection pass's `max_tokens` is no longer dropped.
- **Cut-off tool calls were executed.** A tool call cut off by the output limit reached the tools node, where the lenient argument parser had turned its arguments into `{}`.

### Notes
- Vertex `toolUsePromptTokenCount` (tokens of built-in tool results) is not added to the input: Google's reference only says "Number of tokens present in tool-use prompt(s)" and does not say whether `promptTokenCount` already includes them, so it is left alone until that is confirmed.

## [0.20.0] - 2026-10-23

### Added
- **`PlanEvent.toolCallId`.** The `plan` event now names the model tool call that produced the snapshot (`manage_plan` / `manage_todo_list`), so a UI can place the plan next to the call in the transcript. The id is the one the tools node passes to the tool with each call, so two plan calls in the same turn each carry their own; the shared per-tool field is only a fallback for a tool invoked directly, without a call context. It is also on the trace record's `Plan Metadata`. `PlanEvent.count` (the number of steps, already sent) is now declared.
- **`SummarizationEvent` describes the pass it belongs to.** New optional fields: `id` (the pass's identity: its `summarize_context` tool-call id, the same one the transcript marker message carries), `phase` (`"start"`, `"done"` or `"skipped"`; absent means `"done"`), `pass` (summaries so far + 1, 1-based; a pass that ends `"skipped"` makes no summary, so the next pass repeats its number: pair a pass's events by `id`, not by `pass`), `trigger` (`"pre_leg"`, `"mid_leg"` or `"post_tools"`: which point of the run loop asked for the pass), `status` (`"ok"`, `"fallback"` or `"error"`), `error` (the failure's message when `status` is not `"ok"`) and `compactedTools` (`{ toolCallId, toolName }` of the tool results THIS pass replaced). `error` is provider text for operators and logs, not for end users: it is clipped to 300 characters on the event, and the trace keeps the whole message.
- **A pass announces itself.** A `summarization` event with `phase: "start"` (empty `summary`) is emitted right before the summarizer model call, so a live UI can show the pass while it runs. A pass that started ends with exactly one terminal event: `phase: "done"`, or `phase: "skipped"` when it replaced nothing. A started pass that throws also ends with `phase: "skipped"`, with `status: "error"` and the failure in `error`, and then the error is rethrown. Passes that never reach the model call (nothing compressible, only the newest turn compressible) emit nothing, as before; a pass with no summarizer model to call falls back locally and emits only its `done` event.

### Changed
- **A failed summarizer is one terminal event, not two.** It used to emit an event from the failure itself and another when the pass finished. The pass now emits exactly one terminal event (`phase: "done"`, `status: "fallback"`, `error`; `phase: "skipped"` instead when it then replaced nothing). The trace is unchanged: still one `error` event per pass.
- **Counting passes.** A consumer that counts or sums `summarization` events must count only those with `phase` absent or `"done"`; `"start"` and `"skipped"` are progress markers that carry no token counts.
- **The pass's tool-call id is unique.** The synthetic `summarize_context` tool-call id is now `call_summary_<timestamp>_<suffix>` (33 characters) instead of `call_summary_<timestamp>`, so two passes in the same millisecond no longer share one. Nothing in the SDK reads its shape; a consumer that matched the old one exactly has to accept the suffix.
- The `summarization` events a pass emits now carry the fields above in addition to everything they carried before; no existing field changed meaning.

## [0.19.0] - 2026-10-22

### Added
- **A sub-agent's span is recorded `running` when it starts.** The agent span of a child (`delegate_to`, `spawn_subagent`, `spawn_subagents_parallel`, `asTool`) was recorded only when the child finished or paused, while its iterations and calls pointed at that `spanId` from the start. A host that stores events as they land (a `customSink` `onEvent`, `mode: "streaming"`) and draws the trace while the run goes found steps whose parent did not exist yet, and drew a child's iterations as if they were the parent's. Each segment of a child's run now opens with a record of the span, same `spanId`, `status: "running"`, under the parent's current iteration (the delegating tool call is written when it returns), without `durationMs`, with the `Sub-agent` section (`status: "running"`) and, under `logData`, the `Task`. The record that ends or pauses the segment supersedes it.

### Changed
- **`TraceEventRecord.status` gains `"running"`.** `foldSupersededSpans` drops an earlier `running` record of a span id as it drops a `pending` one. `summary.eventCounts.span` / `totalEvents` count the new records (one more per child segment). OTLP exports are unchanged: a `running` record is folded away (or held back like a `pending` one).
- **Compatibility.** A reader that draws every record without `foldSupersededSpans` shows an extra `Sub-agent` record per child segment; fold first (the Cognipeer Console folds `running` from the release that adds this).

## [0.18.0] - 2026-10-19

### Fixed
- **A paused-and-resumed sub-agent is ONE span.** 0.17.0 gave every segment of a run its own span id (pending under the parent's iteration, a second span under the resumed `delegate_to`), so a trace showed two groups. The run now keeps one id, stored in the pending record (`SubagentPendingRecord.agentSpanId`, `startedAt`, `segments`, all optional and validated on resume). Every pause records the span `pending`; the segment that ends the run records it again under the same `spanId`, finished, under the resumed `delegate_to` call. The child's iterations, tool calls and approval steps hang under that id, in order. This reverses 0.17.0's "the resumed child records a new span" and "span ids are never reused".
- **Reading rule.** Records stay append-only in every sink. Per `spanId` the highest `sequence` is drawn and only earlier `pending` records are dropped: exported `foldSupersededSpans(events)`. `summary.eventCounts` / `totalEvents` still count every record written.
- **Duration.** The agent span's `durationMs` is the run's wall-clock extent from its first segment to its end, the wait included (0.17.0: the last segment's); it stays out of `totalDurationMs`. The `Sub-agent` section gets `segments` once a run has paused. The `subagent` lifecycle event and `subagentStop` keep reporting the last segment's `durationMs`. The start is never earlier than the trace session the span is recorded in.
- **OTLP.** The agent span is exported once, from the segment that ends the run; while it is pending it is held back (OTLP cannot take a span back), so every exported span's parent is an exported span. If the run never ends (the host abandons the approval and calls `closeTraceContinuation`, or the turn ends with the trace still held), the pending span is exported as it stands (UNSET, `cognipeer.event.status` `pending`) by that last export: `TraceContinuation.pendingSpans` carries the unfinished spans (identity sections only, at most 64) across legs for that.
- **Compatibility.** A run paused under 0.17.0 resumes with a fresh span id (two groups, as written, not merged). A consumer that keeps the FIRST record per `spanId` must fold first.

### Added
- **OpenTelemetry GenAI export** (`src/utils/otlp`). One pipeline behind `otlpSink` and `otelTracing`, run inside `finalizeTraceSession`. Spans follow the GenAI semantic conventions (pinned to semantic-conventions-genai `547934a`, exported as `GENAI_SEMCONV_COMMIT`): root and sub-agents `invoke_agent <name>`, model calls `chat <model>` (CLIENT), tools `execute_tool <tool>`; provider name from the registry only, response id/model, `finish_reasons` array, normalized `gen_ai.usage.*` (Anthropic/Bedrock input includes cache; Vertex output includes reasoning), `error.type`, one `exception` event per failed span.
- **`semconv: "cognipeer" | "gen_ai" | "both"`** (default `both`) on every OTLP option set. `cognipeer.event.status` is new; `cognipeer.event.sequence` already existed. Both are `cognipeer.*` keys, so they are emitted with `semconv` `cognipeer` or `both` only, and the root span carries neither: with `semconv: "gen_ai"` the Cognipeer Console cannot rebuild the session, so point the Console at `cognipeer` or `both`.
- **OTLP protobuf and gzip.** `protocol: "http/json" | "http/protobuf"` (hand-written encoder, no runtime dependency), `compression: "gzip"`, a 10 s per-attempt timeout, 3 attempts with full-jitter back-off and `Retry-After` (429/502/503/504 and transport errors), a 25 s budget, defensive `partial_success` parsing. An export never throws and a request with no spans is not sent.
- **`OTEL_*` environment** when no `endpoint` is given: `OTEL_EXPORTER_OTLP_(TRACES_)ENDPOINT|HEADERS|PROTOCOL|COMPRESSION|TIMEOUT`, `OTEL_SDK_DISABLED`, `OTEL_TRACES_EXPORTER=none`; `OTEL_SERVICE_NAME` and `OTEL_RESOURCE_ATTRIBUTES` in both modes. `grpc` warns once and falls back to `http/protobuf`.
- **Content capture** (`content` option), off by default and independent of `logData`: system instructions, input/output messages, tool definitions, tool arguments and results; `redact` runs before the caps, caps drop whole messages, never slice JSON; other sinks never see it. The `cognipeer.sections` attribute (the record's sections, which hold the same prompts, replies and tool payloads) follows the same switch: it carries payload only when `content` is on and `"sections"` is in `include` (the default), through `redact` (`field: "sections"`, a hook must hand back the list; anything else drops it) and the caps. Identity sections (ids, status, timestamps) always go.
- **Approval and question pairing without `logData`.** Every approval request, decision, answer and client-tool step now also records an identity section (`Approval ids`, `Decision ids`, `Answer ids`, `Client tool ids`: `approvalId` / `questionId`, `toolCallId`, status or decision, `requestedAt`, `decidedAt` / `answeredAt`, `waitedMs`), kept when `logData` is off and exported whatever `content` says, so a viewer can fold the pair. They never hold a prompt, comment, notes or arguments, which stay in the sections older releases wrote (unchanged, `logData` only). `TraceMetadataSection.identity` marks them.
- **`rejectedSpans` in the `otelTracing` metadata event** and a `console.warn` for every export a collector answered with `partial_success`.
- **W3C Trace Context.** `TracingConfig.parent` and `InvokeConfig.traceParent` (a `traceparent` value or `{ traceparent, tracestate }`) make the root a child of the caller's span; trace flags are carried unchanged, `sampled=0` suppresses the OTLP export only, the parent survives pauses. `ToolCallContext.traceId`; exports `parseTraceparent`, `formatTraceparent`, `traceparentOf`.
- **`closeTraceContinuation`** exports the held root of a run that paused and will never resume (OTLP exporters only), with any sub-agent span the run left pending; the smart driver calls it for a dangling continuation and for a driver-level failure.
- **`createOtlpExporter`**, `AgentPlugin.traceExporters`, `src/version.ts` (`SDK_VERSION`, with a drift test against `package.json`), a docs page ([OpenTelemetry Export](docs/guide/opentelemetry.md)), golden fixtures and an opt-in collector end-to-end test (`OTLP_COLLECTOR_E2E=1`).
- Trace records gain `responseId`, `responseModel`, `rawFinishReason`, `cacheWriteTokens`, `usageBasis`, `streaming`, `outputType`, `skipReason`, `error.type` and the provider's `toolCallId`.

### Changed
- **The root span is exported once**, by the leg that ends the run. A paused leg exports its own finished spans without a root.
- **Status is UNSET** for success, skipped, retried and pending work (was OK); only failures are `ERROR`. The SDK's own status is in `cognipeer.event.status`.
- **Start times are true**: `timestamp - durationMs` instead of the finish time for both ends; containers cover their children.
- **Span names**: root `invoke_agent <agent>` (was `agent_session: <agent>`), model calls `chat <model>`, tools `execute_tool <tool>`; the old label stays in `cognipeer.event.label`.
- **Default `semconv` is `both`**: spans carry `gen_ai.*` next to the existing `cognipeer.*` keys. Use `semconv: "cognipeer"` for the previous attribute set.
- **`cognipeer.sections` is no longer sent unconditionally.** 0.17 exported the record's sections (prompts, replies, tool arguments and results) on every span whenever `tracing.logData` was on, and `logData` is on by default. They are payload now: they go out only with `content: { enabled: true }`, redacted and capped like the `gen_ai.*` content. **Console users who read the transcript from an OTLP export must turn `content` on**; without it the session still builds, with the structure, tokens and identity sections but no message text.
- **`provider` on model-call records is filled in for every sink.** It now falls back to the adapter's wire info and the model capabilities when the model object does not name a provider (it was `undefined` for the native OpenAI/Anthropic/Gemini adapters), so the file, cognipeer, http and custom sinks, and the Console's `cognipeer.provider` / provider column, see `openai` / `anthropic` / ... where they saw nothing. Nothing else about those sinks changes.
- **Pending client tools.** The placeholder recorded when a run pauses for a host-run tool is a plain span (no `gen_ai.operation.name`); the result recorded on resume is the `execute_tool` span.
- **`otelTracing` exports from `finalizeTraceSession`** as a contributed exporter instead of posting from its own `sessionEnd` hook. A 503 is now retried; a 200 whose body stalls no longer holds the run (the body is read inside the attempt's timeout); `serviceName` only sets the resource `service.name` (it no longer renames the root span); the `metadata` event gains `terminal`. Public name, priority, `failureMode` and the tracing-off warning are unchanged. Only a root session exports: a sub-agent that inherits the plugin does not.
- **Reversal of 0.17.0**: "the resumed child records a new span" and "span ids are never reused" no longer hold; a paused-and-resumed sub-agent is one span (see Fixed).
- `protobufjs` is a devDependency for decode tests only.

### Migration notes
- Dashboards keyed on `agent_session: <name>`, on `OK` status or on the old span names should read `invoke_agent <name>`, UNSET and `cognipeer.event.status`.
- The default protocol depends on the mode. With an **explicit `endpoint` it stays `http/json`** (the Cognipeer Console ingests JSON only). With **no endpoint (env-driven)** it follows `OTEL_EXPORTER_OTLP_PROTOCOL` and defaults to `http/protobuf`, as OpenTelemetry specifies. In explicit-endpoint mode `OTEL_EXPORTER_OTLP_*` is ignored.
- Out of scope: metrics, the logs/events signal, OTLP/gRPC, span links, request parameters and `server.address`.
- Traces written by 0.17.0 (two groups for a paused sub-agent) are not merged.

## [0.17.0]

### Sub-agents in the parent's trace
- **One trace for the whole run.** A sub-agent (`delegate_to`, `spawn_subagent`, `spawn_subagents_parallel`, and an `asTool` child with no tracing of its own) used to run with no trace session: its model calls, tools, approvals and hooks went nowhere and the parent trace showed one `tool_call` with nothing under it. A child now records into its parent's session (same `sessionId` / `traceId`, shared sequence numbers, totals and sink), nested as `agent_iteration` > `tool_call` (`delegate_to`) > `span` "Sub-agent <name>" > the child's own `agent_iteration` > `ai_call` / `tool_call`.
- **The agent span.** `type: "span"`, `actor: { scope: "agent", name, role: "subagent" }`, `status` `success` / `skipped` (blocked) / `error` (error, cancelled, needs_input) / `pending` (paused), the segment's `durationMs` (left out of `summary.totalDurationMs`, as are a child's own events: the delegating `tool_call` already holds that time), and a `Sub-agent` metadata section, kept even when `logData` is off: `id` (the `subagent` event id), `name`, `mode`, `parallel`, `depth`, `parentToolCallId`, `status`, `note` (why an incomplete run stopped) and `SubagentDef.metadata` when set. Only a failed or refused run carries an `error`. With `logData` on it also has `Task` and `Result` message sections. It carries no tokens: they stay on the child's `ai_call` events (and summarization), so `summary` includes the children exactly once.
- **Resume.** A child that pauses for approval or a question records its span as `pending` under the parent's iteration (the `delegate_to` span does not exist yet); the resumed child records a new span under the resumed `delegate_to` call. Span ids are never reused. The `subagent` event id is now stable across the pause (`SubagentPendingRecord.spawnId`): `start`, `paused` and the terminal event share one id, where a resumed child used to get a new one.
- **Iteration numbering.** A child numbers its own iterations from 1, carrying on across a pause (`SubagentPendingRecord.iterations`); the root no longer counts them (`TraceSessionSummary.subagentIterations`, carried in `TraceContinuation`).
- **Human steps once.** The approval request, client-tool request and decisions a child surfaces on the parent are recorded by the child, inside its spans; the parent's tagged copies (`metadata.__subagent`) are no longer recorded a second time. A run nobody can pause (parallel fan-out, an `asTool` child) records no request, since none could be decided.
- **`otelTracing` and children.** A child that inherits `otelTracing` no longer exports the parent's half-finished session at its own `sessionEnd`; the parent exports the whole tree once.
- **Hooks.** Plugin hook outcomes recorded inside a child (`plugins/trace.ts`) now land in the session under the child's spans instead of being held and lost.
- **Building blocks.** `ToolCallContext.traceSpanId` is the span id the tools node gives the call's `tool_call` event (allocated before the tool runs, so a tool can parent its own spans to it); absent when the run is not traced. The scope and span helpers in `utils/tracing` are internal.
- **Unchanged.** An `asTool` child with its own `tracing` keeps its own session (the parent still records the agent span, with nothing under it). Nothing is recorded when the parent's tracing is off.

## [0.16.0]

### Sub-agents
- **Concurrent delegations keep their own identity.** `delegate_to` / `spawn_subagent` calls in one assistant turn read their tool-call id from a field on the shared tool object, so siblings stamped the same `parentToolCallId` on events and, when both paused for a human, the second pending record overwrote the first (a resumed sibling then ran the other's task). The tools node now passes the call's id to the tool's `func` as a second argument: `ToolCallContext { toolCallId, cancellationToken, signal }` (`createTool` forwards it to your `func`).
- **A child's spend counts against the parent.** After a child run (or pause) its model calls are merged into the parent's `state.usage` (`perRequest` + `totals`), each entry tagged `subagent: { name, id, mode }`, so `limits.maxCostUsd` / `maxTotalOutputTokens` see them mid-turn. `result.metadata.usage` is now the whole bill of the run: a host that bills children separately must skip the tagged entries. A resumed child is merged once.
- **A child's outcome is a status.** `SubagentResult` gets `status: "ok" | "incomplete" | "blocked" | "needs_input" | "cancelled" | "error"`, plus `note`, `usage` and, for `error` / `blocked` / `needs_input`, `error`. Mapped from: a thrown error or failed structured output (`error`), a budget / wall-clock limit, the tool-call-limit finalize or an empty answer (`incomplete`), `ctx.__cancelled` (`cancelled`), an output guardrail or `subagentStart` denial (`blocked`), human input inside a parallel fan-out (`needs_input`). `subagent` events carry `status`, `note` and `usage`. A delegation that ends `error` / `cancelled` (or is refused: unknown sub-agent, depth, budget) is a failed tool call: `tool_call` event `phase: "error"` (the result is still on `result`), tool-history `status: "error"`, trace step status `error`; a parallel call is marked failed when every task failed. The result the model sees no longer echoes `input` and omits `usage` / `durationMs` (`toModelResult`); each parallel entry has its own `status`. A `preFinalAnswer` denial now also sets `ctx.__guardrailBlocked`.
- **Prompts follow the policy.** The runtime hint's `Delegation:` line is rendered from `subagentPolicy` when sub-agents are wired (it used the runtime profile's `asTool` policy, which could say "off" while `delegate_to` existed) and reads "not available (you are a sub-agent)" in a child. The `<available_subagents>` block now explains how to write a task, how to read `status`, what to do on anything but `ok`, and that results are untrusted data. Tool descriptions and schemas come from the policy: no ad-hoc fields on the parallel tool in `registry_only`, no `tools` field when `allowAdhocTools` is `false`, `subagent` is an enum of the registry, unknown ad-hoc `tools` names are an error, `maxParallel` is described as concurrency. A child gets a preamble (no human to ask, state assumptions, return only the result) and a registry child without a prompt gets "You are <title>. <header>". A child can no longer borrow the parent's delegation tools by name.
- **Child context is framed.** `scoped` / `full` send the task as its own message ("YOUR TASK ...") with the parent's messages marked as background; `full` leaves out the current turn's unresolved assistant tool calls.
- **Handoff.** The handoff tool result is `Handoff complete: control transferred to <target>. Reason: <reason>. <target> now answers the user.` (was `ok`); the target's system prompt gets a preamble naming the source (wire only, cleared with the handoff on the next invoke; `ctx.__handoffInfo`). `asHandoff` and `handoffs` share a default description saying control transfers and the source stops, and the default `reason` schema asks for the goal and facts. Handoff stays scoped to one invoke; documented.
- **A refused delegation does not spend the child-call budget:** the spawn is reserved up front (so siblings cannot overspend) and given back when a `subagentStart` gate denies it.
- **Every child ends once.** A parallel child that wants a human (`needs_input`), a `subagentStart` denial (`blocked`, preceded by a `start` event), a thrown child and a "resolution missing on resume" error now all emit a terminal `subagent` `result` / `error` event (with `status`, `usage`, `durationMs`) and run the `subagentStop` observers; before, they left a dangling `start` and skipped `subagentStop`.
- **The prompts say what a child can really do.** The child preamble follows `humanInTheLoop.askUser`: with it, a `delegate_to` / `spawn_subagent` child "may ask the user only when it cannot proceed with a stated assumption"; without it, and for every `spawn_subagents_parallel` child, "there is no human to ask, which overrides any instruction to ask clarifying questions". The parent's catalog and the `spawn_subagent` description follow (`BuildChildConfig.interactive`, `SubagentToolDeps.canAskUser`, `buildSubagentCatalogBlock(..., { askUser })`; `SUBAGENT_CHILD_PREAMBLE` is replaced by `subagentChildPreamble(canAskUser)`). The catalog splits the status advice: retry once only for `incomplete` / `error`; `blocked` is not to be retried, rephrased or worked around; `cancelled` is not retried; a `needs_input` task is rerun with `delegate_to`. With no named sub-agents the parallel tool and the catalog describe `{ role, prompt, input }` (no `subagent`), and the parallel `prompt` / `tools` fields are described.
- **Built-in usage plugins and child spend.** `sessionMetrics` computes `inputTokens` / `outputTokens` / `cachedInputTokens` / `totalTokens` / `estimatedCostUsd` from the run's own ledger entries and adds `subagentCalls`, `subagentInputTokens`, `subagentOutputTokens`, `subagentTotalTokens`, `subagentEstimatedCostUsd` when it delegated, so a pipeline that sums run records (each child reports its own) does not count a child twice. `langfuseTracing`'s trace token total leaves sub-agent calls out for the same reason. `budgetGuard` counts them toward `maxUsd` / `maxOutputTokens` and not toward `maxModelCalls`. New `splitUsage(usage)` in `utils/usage`.
- **Handoff reason stays out of the system prompt.** The target's preamble names the source only; the `reason` (model-written) is in the handoff tool result, capped at 500 characters, collapsed to one line, without a doubled period. `ctx.__handoffInfo` is `{ from }`. The default handoff description no longer points at a delegation tool.
- **Stream isolation.** A child's text deltas are no longer forwarded to the parent's `onStream` / `stream` events (they read as the parent's answer). `subagentPolicy.streamChildren: true` forwards them tagged with `subagentName` / `subagentId` (`StreamChunk` has both fields). Other child events, `reasoning` included, are forwarded as before A child's `isFinal` stream chunk is never forwarded, on either channel (it carries the child's whole answer).
- **Type-level changes.** `SubagentResult.status` is required and `SubagentResult.input` is optional: code that constructs a `SubagentResult` (a custom registry, a test double) or reads `result.input` as a `string` stops compiling under strict mode. A `createTool` `func` that declares a second parameter now receives `ToolCallContext` there (for every tool, not only the delegation tools); `SmartToolFn` has the second parameter.
- **`asTool` is unchanged except for seeding.** Stream isolation and usage merging cover the sub-agent tools (`delegate_to`, `spawn_subagent`, `spawn_subagents_parallel`) only: an `asTool` child's text deltas still reach the parent's `onStream` untagged and its spend is not merged into the parent's ledger. It shares `seedChildMessages`, so its `scoped` / `full` children now get the framed "YOUR TASK" message and `full` drops the unresolved tool calls.
- **Docs.** `examples/handoff/README.md` names `handoff_to_coder` and the new tool result; `README.md` no longer says children inherit streaming wiring.

## [0.15.0]

### Fixed
- **Context summarization reaches the trace.** The summarizer runs between two invokes ("legs") of the smart agent; it recorded its event into the session on `ctx`, which the previous leg had already handed to its sink — so no summarization was ever delivered (and on a streaming sink it reused the next leg's sequence number). An event recorded while no session is open now waits on `ctx.__deferredTraceEvents` and is recorded at the start of the next invoke, in the turn's own session. Plugin hook records made between legs (`preCompact` / `postCompact`) are held the same way. `TraceSessionRuntime.closed` marks a session already given to its sink. The summarizer's tokens are now part of the session totals.
- **A directive the user never gave no longer takes over the conversation.** Prod: a conversation with no request for JSON got `user_directives: ["Return strict JSON only."]` — the summarizer's own reply-format instruction read back as the user's — and every later answer came back as JSON; the integrity repair then carried it forward forever. Directives are now kept only when they trace back to a user message (`summarization.groundDirectives`, default `true`): the default prompt asks for a verbatim `source_quote`, which must occur in a user message; a quote-less directive must have most of its words (character bigrams for CJK / Thai) in one user message. With a custom `promptTemplate` a quote-less directive is kept as before. Carried directives are re-checked on every pass; one from a pre-upgrade summary (no recorded source) whose message is no longer in state, or that paraphrases the user across languages without a quote, is dropped — the trace and `droppedDirectives` say so. Directives are taken from user messages only.
- A parsed summarizer reply with no `stable_facts` no longer turns the lines of its raw JSON into `fact_N` entries (only an unparseable reply does).

### Changed
- The summarizer prompt states its JSON reply format as the request's own requirement, marks the conversation with `<conversation>` tags, and says where directives may come from. Every user message is sent ahead of tool output (up to 60% of `summaryPromptMaxTokens`); oversized messages keep their start and end (`[TRUNCATED n chars]`) instead of only the start. A custom `promptTemplate` is used as before.
- One trace event per summarization pass (a failed call was traced twice: once as an error with estimated tokens, once as a success). It carries `model`, `provider`, usage, and sections: the prompt, the model's raw reply, the summary injected into the context, `Compaction` and `User directives` (kept with sources, dropped with reasons). OTLP exports it as a CLIENT span.

### Added
- `summarization.groundDirectives`; `StructuredSummary.user_directive_sources` (directive → the user's words); `SummarizationEvent.model` and `.droppedDirectives`; `DroppedDirective`.
- `postCompact` input `call: { model, usage, durationMs, messagesCompressed, fallback }` — the summarizer's model call, which never passes `pre/postModelCall`. `langfuseTracing` exports it as a `summarize_context` generation.
- A LangChain model gets `{ runName: "summarize_context", tags: ["cognipeer:summarization"] }` on the summarizer call, so LangChain callbacks name the run. Other models get no options, as before.
- Exports: `isTraceSessionOpen`, `recordOrDeferTraceEvent`, `replayDeferredTraceEvents`, `traceSectionsFromMessages`, `DeferredTraceEvent`.

## [0.14.0]

### Fixed
- **A turn that pauses is one trace session, not two.** A run paused for a tool approval, an ask-user question or a client tool used to be finished by a second invoke that opened a new trace session, so the model call that asked for the tool sat in one session and the tool itself (with an "Iteration 1" that had no model call) in another. The same happened to the smart agent's summarization legs. The paused run now leaves `ctx.__traceContinuation` (`TraceContinuation`: session/trace/root-span ids, start time, next sequence, part number, cumulative summary) in its state, and the invoke that resumes it continues the same session: ids, start time and totals are carried over, sequences and iteration numbers keep counting. Hosts that persist the paused state must keep this key with it; a new user message (no continuation) still opens a new session.
- Sinks receive `continuation: { part, firstSequence }` on every part after the first and should append that part's events rather than replace the session's. The file sink merges with the `trace.session.json` already on disk; the HTTP and OTLP sinks send it as-is (Cognipeer Console ≥ the matching release appends).

### Added
- **Human steps in the trace.** `tool_approval` events: "Approval requested · <tool>" (`status: "pending"`, the arguments to approve) when the run pauses, and "Approved · <tool>" / "Rejected · <tool>" when it resumes, stamped at the decision with the wait as `durationMs`, `actor: { scope: "human", name: decidedBy }`, a `Decision` section (`approvalId`, `decision`, `decidedBy`, `comment`, `requestedAt`, `decidedAt`, `waitedMs`, `argumentsEdited`) and the requested / approved arguments. Ask-user questions: "Question to user" (`pending`) and "Answer from user" / "Question cancelled" with each question and its answer. Client tools: a pending "Tool Execution - <tool> (client)" and, on resume, the same step with the client's result. Request and outcome share `approvalId` / `questionId` so a viewer can fold them.
- `TraceSessionStatus` adds `"paused"` (the run is waiting on a person); `TraceEventRecord.status` adds `"pending"`. New exports: `TraceContinuation`, `readTraceContinuation`, `traceContinuationOf`.

## [0.13.0]

### Added
- **`model-rules.json`: one file describes what every model accepts.** Shipped in the package (bundled into the code and exported as `@cognipeer/agent-sdk/model-rules.json`) so hosts such as the console read the same rules. It holds the effort ladder (`none < minimal < low < medium < high < xhigh < max`), the thinking-token budgets, and an ordered rule list per family (`openai`, `anthropic`, `gemini`, `other`): reasoning style / supported efforts / off mechanism, sampling support, `max_tokens` vs `max_completion_tokens`, whether function tools on Chat Completions need `reasoning_effort: "none"`, and a `source` (`verified-2026-10-14` for live-verified rules, `docs` otherwise). Every per-model check in the providers (`isReasoningModel`, sampling stripping, token-limit field, thinking form, effort / budget mapping, off mechanisms) now reads it.
- **`xhigh` and `max` reasoning efforts** (`ReasoningEffort`). The SDK accepts every ladder value for every model and maps it to the nearest LOWER value the model's rule accepts (nearest higher if nothing lower exists); `none` uses the model's off mechanism (`none` / `disabled` / `between_tools`) or else the lowest supported value. E.g. gpt-5.6 / gpt-6 take `none..xhigh` on Chat Completions (`max` -> `xhigh`; the Responses endpoint takes `max`), gpt-5 / mini / codex take `minimal..high`, o-series / gpt-oss `low..high`, Claude 5.x `low..max` (adaptive thinking), Claude 4.6 `low..max` without `xhigh`, 4.7 adds `xhigh`.
- **New exports**: `MODEL_RULES`, `resolveModelRule({ provider, model })` (the effective rule, with `matchedRuleId`, `isDefault`, `learned`), `mapReasoningEffort(rule, effort, endpoint?)`, `modelIdCandidates`, `ModelRequestError`, `parseModelError`, `listLearnedModelRules` / `rememberModelRulePatch` / `clearLearnedModelRules`, and the types `ModelRule`, `ModelRules`, `ResolvedModelRule`, `RulePatch`, `ReasoningEffort`, `EffortMapping`, `ModelRequestErrorCode`, `ModelRuleLearnedEvent`.
- **Unknown models no longer break.** An id no rule matches gets a permissive family default (the caller's request is sent as asked). When the provider answers a 400 about a parameter or value (`Unsupported parameter`, `Unsupported value ... Supported values are`, `Use 'max_completion_tokens' instead`, `Only the default (1) value is supported`, `Function tools with reasoning_effort are not supported`, Anthropic `` `x` is deprecated for this model ``, `may only be set to 1 when thinking is enabled`, `thinking.type.enabled is not supported`, `thinking.type.adaptive is not supported`, the `between_tools` / `thinking.type.disabled` off-mechanism messages), the OpenAI-wire (Chat + Responses), Anthropic and Bedrock providers fix the request and retry (at most 3 adjustments per call, only before any response byte reached the caller) and remember the fix per (provider, model) in a bounded in-process cache (500 entries) so the next call is right first time. `onModelRuleLearned` on any provider config is called with each learned adjustment so hosts can log or persist it.
- **`ModelRequestError`** (extends `ProviderError`, so existing `instanceof ProviderError` handling keeps working): `{ status, code: 'unsupported_parameter' | 'unsupported_value' | 'model_request_invalid', param?, value?, supportedValues?, provider, model, message }`. Thrown for a 400 the SDK could not fix (OpenAI-wire, Anthropic, Bedrock, Vertex).

- **Client-safe subpath `@cognipeer/agent-sdk/model-rules`** (ESM, CJS and types): `MODEL_RULES`, `resolveModelRule`, `mapReasoningEffort`, `modelIdCandidates`, `allowsSampling`, `effortBudget` and the rule types, with no Node built-ins in its import graph, so browser / UI bundles can use the same rules. `./model-rules.json` stays exported. The main entry also re-exports `allowsSampling`, `applyDropParams`, `effortBudget`, `mergeRulePatch`, `runWithModelAdjustments`, `asModelRequestError`, `MAX_ADJUSTMENTS`, `getLearnedModelRulePatch` and the remaining rule types.
- **Learned adjustments are scoped per backend.** `resolveModelRule`, `rememberModelRulePatch`, `getLearnedModelRulePatch` and `listLearnedModelRules` take / return an optional `scope`; the OpenAI-wire providers use their base URL, so two Azure / openai-compatible endpoints that share a deployment name no longer share what was learned. Pass the same `scope` to `resolveModelRule` to see a learned rule. A field the caller set in `request.extra` is corrected for the current call but never learned for the model.

### Changed
- Azure `gpt-35-turbo*` deployment ids resolve to the legacy (non-reasoning) rule, not `gpt-6-plus`.
- Known limitation: rules are anchored on the model id, so a custom deployment name with a prefix (`prod-gpt-5`, `team-o3`) is treated as an unknown model (permissive default) and relies on the 400 self-correction on its first call.
- Claude 5.x never receives `temperature` / `top_p` / `top_k` (the API rejects them for any value). Effort `none` on Claude 5.x uses the model's off mechanism: Haiku `thinking:{type:"disabled"}`, Sonnet `thinking:{type:"between_tools"}`, Opus cannot turn thinking off and gets the lowest effort. Claude 4.6 / 4.7 now use adaptive thinking.
- gpt-5.1+ and gpt-N (N >= 6): function tools on Chat Completions send `reasoning_effort: "none"` explicitly (any other effort is a 400); reasoning requests with tools route to the Responses API as before. `presence_penalty` / `frequency_penalty` / `logprobs` are no longer sent to reasoning models that reject them. `reasoning` is not sent to models whose rule has no reasoning control (gpt-4o, gpt-4.1, `*-chat`).
- `isReasoningModel` and `supportsAdaptiveThinking` are thin wrappers over the rules; `clampOpenAIEffort` / `openAIEffortLine` from the unreleased 0.12.1 draft are replaced by `mapReasoningEffort`.

## [0.12.0]

### Added
- **Embeddings on the native providers**: `provider.embed({ model, input: string[], dimensions?, encodingFormat?, inputType?, batchSize?, extra?, signal? })` returns `{ model, vectors, usage: { inputTokens, totalTokens }, raw }`, one vector per input in input order. OpenAI / openai-compatible: `POST /embeddings`, batched (2048 per request), `dimensions`, `encodingFormat: "base64"` is decoded for you. Azure: deployment-scoped path with `api-key` auth. Bedrock `InvokeModel`: Amazon Titan Text Embeddings v1/v2 (one text per call, 4 in flight) and Cohere Embed v3/v4 (batched, `inputType` -> `input_type`, `dimensions` -> `output_dimension`). Vertex `:predict`: text-embedding / multilingual / `gemini-embedding` (one instance per request), `inputType` -> task type, `dimensions` -> `outputDimensionality`. Providers without an embeddings endpoint (Anthropic, Jev) reject with a 400 `ProviderError`. New exported types `EmbeddingRequest`, `EmbeddingResponse`, `EmbeddingUsage`, `EmbeddingInputType`.
- **Gateway-grade request options** on `ChatCompletionRequest`: `streamUsage` (`false` omits `stream_options.include_usage` for servers that reject it), `seed`, `n` (pass-through; only choice 0 is parsed), `parallelToolCalls` (sent only with tools), `logprobs`, `topLogprobs`.
- **Raw finish reason** next to the normalised one: `rawFinishReason` on `ChatCompletionResponse` and on the stream chunk that carries it (OpenAI `finish_reason`, Anthropic / Bedrock `stop_reason`, Gemini `finishReason`).
- **Provider response fields kept** in `providerFields` (response and stream chunks) when present: `system_fingerprint`, `service_tier`, message `annotations` and `refusal`, choice `logprobs`.
- **Tool-call stream deltas carry `index`** (`ToolCall.index`): the OpenAI `tool_calls[].index`, and a per-turn ordinal for Anthropic, Bedrock, Vertex and the Responses stream. Anthropic now announces a tool call (id + name) when its content block opens, so a tool with no input is no longer invisible to a stream consumer.
- **`@langchain/*` and `langchain` are optional peer dependencies.** Nothing imports LangChain at module load; `fromLangchainModel` / `fromLangchainTools` keep working when LangChain is installed.

### Breaking
- **Bedrock `extra` routing**: keys that are not Converse request fields now go inside `additionalModelRequestFields` (merged with the reasoning mapping and with any explicit `extra.additionalModelRequestFields`); Converse's own top-level fields (`guardrailConfig`, `performanceConfig`, `requestMetadata`, `promptVariables`, `additionalModelResponseFieldPaths`, `serviceTier`, `outputConfig`, ...) stay top-level. Previously every key was spread at the top level. Migration: to force a key to the top level (e.g. a Converse field added after this release) put it under `extra.__top`, e.g. `extra: { __top: { newConverseField: 1 } }`.

### Behaviour changes
- Adaptive (Claude 5.x) requests carry `thinking.display = "summarized"`, and temperature / top_p / top_k are stripped only when thinking is actually enabled (not for `effort: "none"`).
- Bedrock stop reasons `model_context_window_exceeded` -> `length`, `guardrail_intervened` -> `content_filter`.
- Anthropic `reasoningTokens` is now populated. It is already included in `outputTokens`: do not add it again.
- Anthropic streams announce a tool call (id + name) when its block opens; consumers that created a call on first sight of `name` must merge by id/index.

### Added (upstream API selection)
- **`api: "chat" | "responses" | "auto"`** on `OpenAIProvider`, `AzureProvider` and `OpenAICompatibleProvider`. Default `"auto"` keeps the 0.11 behaviour of each class (OpenAI and Azure: Responses when the request carries `reasoning` and the model name looks like an o-series / gpt-5 model; OpenAI-compatible: always Chat Completions), so upgrading changes nothing. `"chat"` always uses Chat Completions. `"responses"` sends every request to the Responses API with real SSE streaming (text, tool-call arguments and `response.reasoning_summary_text.delta` as reasoning parts; `responsesStreaming: false` opts back into one non-streaming call). The existing `responsesApi` option still works as a deprecated alias (`never` = chat, `always` = responses, `auto` = auto); `api` wins when both are set.
- `responsesApiModels` / `responsesStreaming` are now honoured by `AzureProvider` and `OpenAICompatibleProvider` too (previously only a directly configured `OpenAIProvider`).
- **Claude visible thinking.** On the adaptive (Claude 5.x) thinking form the SDK now sends `thinking.display = "summarized"` (Bedrock-Claude too) unless `reasoning.includeThoughts` is `false`; those models otherwise return empty thinking text. An explicit `extra.thinking` is never modified. Behaviour change: adaptive requests carry the extra `display` field.
- Anthropic `usage.output_tokens_details.thinking_tokens` is parsed into `reasoningTokens` (non-stream and stream).
- Vertex embeddings: task type aliases `semantic_similarity`, `question_answering`, `fact_verification`, `code_retrieval_query`.

### Fixed (providers)
- **Bedrock**: usage reads `cacheReadInputTokens` / `cacheWriteInputTokens` first and the `...TokenCount` names as a fallback (non-stream and stream); stop reasons `guardrail_intervened` map to `content_filter` and `model_context_window_exceeded` to `length` (`guardrail` is still `content_filter`).
- **SigV4**: the canonical URI is now URI-encoded a second time per path segment for non-S3 services, as AWS requires. Model ids containing `:` previously produced a path the signer and the service canonicalised differently. Verified against a reference signature from `@smithy/signature-v4`. `signRequest` accepts an optional `now` for reproducible tests.
- **Vertex embeddings**: `extra.parameters` is merged with `outputDimensionality` instead of replacing it, and a prediction without an `embeddings.values` array now raises a `ProviderError` instead of returning `undefined` vectors.

### Fixed (forced tool choice)
- **Claude 5.x Sonnet / Opus reject `tool_choice` `any` / `tool`** with a 400 (`tool_choice: type "tool" and "any" are not supported for this model`). Anthropic and Bedrock providers now map `required` and a specific tool to `auto` for those models (new `supportsForcedToolChoice(modelId)` helper; Haiku and older models keep forcing), and retry once with `auto` when any other model answers that exact 400. The tool-based structured output path keeps working: a text answer is parsed by the existing fallback.

### Fixed
- **Anthropic / Bedrock-Claude thinking on newer models.** Claude 5.x models reject `thinking: { type: "enabled", budget_tokens }`. The thinking shape is now chosen per model id: newer models get `thinking: { type: "adaptive" }` plus `output_config.effort` (`minimal` maps to `low`, `none` sends no thinking); older models keep the budget form. New `thinkingMode: "auto" | "adaptive" | "budget"` provider option overrides detection (`supportsAdaptiveThinking` is exported). The Anthropic provider also retries once with the other form when the upstream returns that specific 400. An explicit `extra.thinking` is still passed through unchanged.


## [0.11.0]

### Added
- **`fetch` and `timeoutMs` on every provider config**, used at all call sites (OpenAI chat/Responses, Azure, compatible, Anthropic, Bedrock, Vertex incl. the OAuth token exchange, Jev). `timeoutMs` covers the wait for response headers (an open stream is not cut) and surfaces as `ProviderError` with status 408. New type `ProviderTransportConfig`.
- **OpenAI-family token parameter**: `maxTokensParam: "auto" | "max_tokens" | "max_completion_tokens"` (OpenAI, Azure, compatible). `auto` sends `max_completion_tokens` for o-series / gpt-5. `temperature` / `top_p` are omitted for reasoning models (`gpt-5-chat` excepted).
- **Reasoning text from OpenAI-compatible servers**: `message.reasoning_content` / `message.reasoning` (and `delta.*` while streaming) are parsed into `reasoning.summary`. The streaming adapter yields `{ type: "reasoning", reasoning_content }` parts (never answer text), the agent loop emits a `reasoning` event, and the final message keeps the full reasoning text.
- **Compatible provider** forwards `organization`, `retry` and `responsesApi` (default `"never"`); **Azure** takes `retry`.
- **Adapter**: `topP`, `stop`, `presencePenalty`, `frequencyPenalty` options; `transformRequest(req)` hook applied after tools/response format/reasoning are known (mutate or return a replacement, sync or async). Streamed final messages carry `response_metadata.finish_reason` and `model_name`.
- **One documented usage shape** (`MessageUsage`, `toMessageUsage`): `prompt_tokens`, `completion_tokens`, `total_tokens`, `prompt_tokens_details { cached_tokens, cache_write_tokens }`, `completion_tokens_details { reasoning_tokens }` on `message.usage` and `response_metadata.token_usage` (which also keeps the flat legacy cache keys).
- **Bedrock real streaming** over ConverseStream: AWS event-stream binary frames (prelude and message CRC32 verified, typed headers) are decoded incrementally, SigV4-signed like Converse. Text, tool-call argument and reasoning deltas stream as they arrive; a closing chunk carries the finish reason, usage and signed reasoning blocks. In-stream exceptions become `ProviderError` with a status (e.g. `throttlingException` -> 429). `capabilities.streaming` is now `true` for Bedrock.
- **Anthropic**: an explicit `extra.thinking` wins over reasoning derived from `effort` / `budgetTokens` (it is still made API-legal: `max_tokens > budget_tokens`, sampling overrides dropped when enabled). `max_tokens` is guaranteed positive (default 4096) even if `extra` nulls it.
- **Vertex**: `retry` config, 429/5xx retried with backoff and `Retry-After`; Gemini `thoughtSignature` on `functionCall` parts is captured (`ToolCall.thoughtSignature`, `tool_calls[].thoughtSignature`) and echoed on the next request; streamed tool calls get stream-unique ids (previously two calls in separate chunks both became `call_0` and were merged); `reasoning.thinkingLevel` sends `thinkingConfig.thinkingLevel` instead of a budget (`effort: "none"` still wins).

### Changed
- `OpenAICompatibleProvider` now defaults `responsesApi` to `"never"` (it used to inherit `"auto"`, which could route an o-series / gpt-5 named model on a compatible server to `/responses`). Pass `responsesApi: "auto"` to restore the old routing.

## [0.10.6]

### Fixed
- **Cancelling a run did not stop the model.** The abort signal / `cancellationToken` reached the agent loop and no further: `fromNativeProvider` dropped it, so `fetch` never saw it and the HTTP response kept streaming (and billing) until the model had finished, even though the loop had already walked away. The request now carries the call's signal — a real `AbortSignal`, or a token that only exposes `isCancellationRequested` / `onCancellationRequested`, which is turned into one — in `invoke` and `stream` for OpenAI (Chat Completions and Responses), Azure, Anthropic, Bedrock and Vertex, and `ChatCompletionRequest` gains an optional `signal` for direct provider use. `fromLangchainModel` gives LangChain a real `signal` too (it knows nothing of a token). A stream whose consumer just stops reading is closed as well (the SSE reader is cancelled, not only released), and a retry backoff ends the moment the call is cancelled instead of sleeping out its delay and issuing another attempt.
- **A cancelled model call is reported as `cancelled`, not thrown.** With the request aborted, the rejection used to surface as a model error. The agent now recognises its own cancellation: no `Assistant Error` trace, no throw; the run ends with `ctx.__cancelled` (`stage: "agent"`, reason `"aborted"` or `"cancelled"`), a `cancelled` event, and an `Assistant Cancelled` trace event (status `skipped`). Text that had already streamed is kept as the assistant turn; a tool call that had not finished streaming is dropped, so the transcript never holds an unanswered `tool_call`, and the loop does not run post-model guardrails or start another call. A stream that ends because it was aborted is not passed off as a finished message. `parseSSEStream(body, signal)` now throws on an aborted signal instead of ending quietly as if the body were complete.
- **Attachments were `JSON.stringify`'d into text.** Anything that flattened a message to a string fell back to the part's JSON, which includes the whole base64 payload. A ~400-token photo was estimated at ~18,000 tokens and triggered needless compaction; the summarizer read (and was truncated into) a wall of base64 instead of learning a picture was there ("three files" for four); the trace display showed the same wall. Token estimation, the summarizer's input and trace display now use a short placeholder — `[image: photo.png]`, taking the part's `name`, else `fileId`, else its media type — for image, audio, video and file parts in every shape the SDK sees (`image`, `image_url`, `input_image`, `input_audio`, `file`, `input_file`, `document`, Gemini `inlineData`). `contentToString` no longer inlines a data URL (a remote URL is still shown). A text part in a trace section is shown as its text rather than as `{ "type": "text", … }`.
- **Responses API rejected structured-output schemas with a reused sub-schema.** zod-to-json-schema references a reused sub-schema by a pointer into the middle of the document (`#/definitions/structured_response/properties/goals/items`), and `/responses` answers `400 invalid_json_schema … reference to component '…' which was not found`. When the OpenAI provider builds `text.format` (from `responseFormat`, or from a translated `extra.response_format`), in-document `$ref`s are now inlined and the `definitions`/`$defs` nothing references any more are dropped. A schema without `$ref` is sent byte-for-byte as before. Recursive references are kept as they were. The caller's schema object is never modified. Chat Completions `response_format` is unchanged.

### Added
- **`parts` on trace message sections.** A `message` section whose message carries a non-text part now also has `parts`: the structured parts in order (text included), so a host can render a thumbnail where `content` can only name the image. `content` stays a string, as before. A text-only message has no `parts`. New type `TraceMessagePart`.
- **Exports: `describeContentPart`, `contentPartToText`, `mediaKindOf`, `hasMediaPart`** — the same placeholder text the SDK uses, for hosts that flatten content themselves.
- **`responsesApiModels` and `responsesStreaming` on the `openai` provider (opt-in).** Some models reason by default and reject function tools on Chat Completions whether or not a reasoning field is sent; the GPT-6 family on an Azure `/openai/v1` endpoint returns *"Function tools with reasoning_effort are not supported … use /v1/responses"*, and `gpt-6.1-sol` cannot turn reasoning off. `responsesApiModels` (exact strings or RegExps) routes the listed models to the Responses API with or without a `reasoning` config. For those models only, Chat Completions spellings in `extra` that `/responses` rejects with a 400 are re-spelled, values unchanged: `reasoning_effort` → `reasoning.effort` (a request-level `reasoning` still wins), `max_tokens` / `max_completion_tokens` → `max_output_tokens`, `response_format` → `text.format`, and `stream_options.include_usage` is dropped. With `responsesStreaming: true`, they also get real Responses SSE streaming: text and tool-call argument deltas, then a final chunk with usage and the reasoning summary. Both options are unset by default. Nothing is inferred from model names, `responsesApi: "never"` still wins, and `AzureProvider` / `OpenAICompatibleProvider` ignore both. Request bodies, routing and streaming for every configuration that does not list a model are unchanged, and a new byte-for-byte snapshot test pins them.

## [0.10.4]

### Changed
- **Strict tool calling is on by default for every model that supports it**, not only under native structured output. Tool-call arguments are then schema-valid by construction. No option: the switch is the model's `capabilities.strictToolCalling`.
- **`strictToolCalling` is reported only for endpoints that enforce it**: OpenAI and Azure OpenAI. A LangChain `ChatOpenAI` pointed at another host (`baseURL` — vLLM, Ollama, LM Studio, gateways) and the native `openai-compatible` provider now report `false` and keep the plain, simplified schemas; native structured output is unchanged for them. An explicit `model.capabilities` still takes precedence.

### Added
- **Strict tool schemas are made strict-valid in the SDK.** In strict mode each Zod-schema tool — the caller's and the SDK's own (`manage_plan`, `open_skill`, `spawn_subagent`, …) — is bound through a view whose schema follows OpenAI's rules: optionals become required-nullable, objects and **union branches** are closed, free-form objects/records/`any` travel as JSON strings. The model's calls are restored to the tool's original shape (nulls for "not given" dropped, JSON decoded) before plugins, the transcript and the tool node see them. Exported: `toStrictCompatible`, `toStrictToolSchema`, `restoreToolCalls`, `prepareStrictToolMenu`, `isOpenAIHostedEndpoint`.

### Fixed
- **`manage_plan` / `manage_todo_list` failed on Gemini and broke strict runs.** Its `todoList` was a union of a write item and an update item, and Gemini's function schema has no object unions: LangChain throws "Gemini cannot handle union types" when binding it. The model now sees a single flat item schema (`status` optional, required on write); each operation is still validated against its own schema, and a write without a status returns `todoList[i].status: Required`. The schema is also ~30% smaller.
- **Planning broke every strict run.** `manage_plan`'s `todoList: array(union(write, update))` left the branches' optional fields out of `required`, so OpenAI rejected the request (`Invalid schema for function 'manage_plan' … anyOf … Missing 'step'`).
- **Strict mode with optional arguments.** The adapter marked every property required without making it nullable, so the model could not leave one out, and a null it sent failed the tool's own validation.

## [0.10.3]

### Fixed
- **`context.policy: "summary_only"` dropped the instruction anchor.** The view was the last two user/assistant messages, so from the third turn on the first user message — where standing instructions usually live — was gone. The first user message and the current request are now always kept, as the hybrid window and the clamp already do.
- **`summary_only` hid tool results from the model inside a run.** Tool messages were filtered out entirely, so the model never saw the output of the tool it had just called (and tended to call it again), and a kept assistant turn with `tool_calls` but no results was an invalid request for most providers. The current turn is now sent whole — tool calls and results included, compacted results as their placeholders (the trail of what the run already did) — and the summarizer's protected latest tool turn stays visible even though its `summarize_context` marker is appended after it. Only past turns are represented by the summary.
- **`summary_only` dropped turns nobody had summarized.** Before the first summary, and for the turns after the latest one, messages were lost outright. Before a summary exists the view is now the hybrid turn window; after one, the turns past the summarization point are kept.

### Added
- **`StructuredSummary.user_directives`.** The summarizer now records the user's standing instructions (language, format, scope, always/never rules) verbatim and renders them first in the context summary. A directive a later summary drops is treated as critical loss and merged forward by the integrity repair, unless the user revoked it (its text is listed in `discarded_obsolete`). The local fallback summary carries the previous directives forward. Custom `summarization.promptTemplate`s are unaffected; add `user_directives` to their schema to opt in.

## [0.10.2]

### Fixed
- **`userPromptSubmit` was skipped on every turn after a snapshot restore.** `__restoredFromSnapshot` was written by `restoreSnapshot` and never cleared or stripped, so every later `invoke()` on the restored state read as a resume and the input guardrail never ran again for that conversation. The marker is now consumed at invoke entry and excluded from snapshots; a genuine in-process resume (`__paused` / `__awaiting*` / `__resumeStage`) is still exempt. A snapshot taken at the pre-model checkpoint and then restored is gated once more on the same user message — the safe direction.
- **An unknown `decision` string from a hook was read as `allow`.** `DECISION_RANK[unknown]` is `undefined`, and `undefined > 0` is false, so `"block"`, `"DENY"` or `true` fell through the chain with no warning. An unrecognised decision is now a handler error: it follows the plugin's `failureMode` and is logged at error level with the plugin, hook and value.
- **`ask` from a hook without approval semantics degraded to `allow`.** Every caller except `preToolUse` tests only `=== "deny"`. `runGate` now coerces `ask` to `deny` (with a warning) on every hook except `preToolUse`.
- **A deny under `outputSchema` (tool-based strategy) did not end the run.** The refusal carried no `tool_calls`, so the structured-output nudge re-entered the loop and the provider was called once more. The nudge guard now also stops on `__guardrailBlocked`.
- **`__guardrailBlocked` leaked into the next turn and into snapshots.** It is now cleared at invoke entry on both factories and stripped from snapshots.
- **A reason-less deny inherited an earlier plugin's non-blocking reason**, and `deniedBy` named the wrong plugin. The reason is reset on escalation unless the escalating handler supplied one.
- **Reviewer-edited `approvedArgs` skipped schema validation and the `preToolUse` gate.** Edited arguments are re-validated and re-gated before the tool runs; an unedited approval is not re-gated.
- **`postToolUse` did not run on a `preToolUse.result` short-circuit or on a tool-cache hit.** It now runs on both paths; the input carries `source: "tool" | "hook" | "cache"`.
- **`auditLog` wrote tool arguments through `notification.detail` even with `includeArgs: false`.** `detail.args` now goes through the same rendering/redaction as the direct path.

## [0.10.1]

### Fixed
- **A `userPromptSubmit` deny on `createSmartAgent` didn't set `ctx.__guardrailBlocked`.** `createAgent`'s own prompt-denial path sets this flag — the SDK's documented signal that a turn was blocked rather than answered — but `createSmartAgent` runs through a separate copy of the same session-open/denial branch that never set it. A caller checking the flag on a smart agent saw nothing and could not tell a blocked turn from an ordinary completed one.

## [0.10.0]

### Added
- **Plugin/hook layer.** Three extension kinds — hooks (intercept, chained), contributions (add, accumulate) and strategy slots (replace, exactly one owner) — across 13 hooks: `sessionStart`, `userPromptSubmit`, `preModelCall`, `postModelCall`, `preToolUse`, `postToolUse`, `preCompact`, `postCompact`, `preFinalAnswer`, `subagentStart`, `subagentStop`, `notification`, `sessionEnd`. Plugins compose in priority order with waterfall mutation, `deny > ask > allow` escalation, per-plugin `failureMode` and per-handler `timeoutMs`; observers never block. Ships 25 built-in plugins, including `cognipeerGuardrail`, `portkeyGuardrail`, `piiRedaction`, `promptInjectionGuard`, `toolPolicy`, `budgetGuard`, `rateLimit`, `responseCache`, `auditLog`, `langfuseTracing` and `otel`. Multimodal input (image/audio/video) is carried through every hook: a text rewrite replaces only the text parts and leaves attachments intact.
- **Handoff targets now carry their own persona.** `AgentRuntimeConfig.systemPrompt` / `useTodoList` are populated from the agent's options, so a runtime handed to another loop still knows who it is. The target's system prompt is rebuilt on the WIRE for each model call, never written into the transcript: persisting it would leave the caller's returned messages describing an agent no longer in control, and the next turn — which seeds no system message when one is already present — would run the originating agent's tools under the target's instructions. Plugin `systemPrompt` contributions are re-applied to the rebuilt prompt, since the plugins still govern the run; the originating agent's skill/subagent catalog is not, because those tools left the menu with the handoff. A handoff is scoped to one `invoke`.

### Fixed
- **`createSmartAgent` silently dropped the `handoffs` option.** The option is typed and documented on both factories, but only `createAgent` honoured it: the smart loop rebuilds its tool set every iteration and wrote it over `state.agent.tools`, discarding whatever the base runtime carried. The handoff tool never reached the model, so the agent could not hand off at all — the call compiled, validated, and did nothing. Handoff tools are now merged into both smart tool sets, and a runtime the loop did not produce is left exactly as it is instead of being overwritten with its predecessor's menu.
- **A handoff swapped the tool menu but not the system prompt.** The target ran under the *originating* agent's instructions and name: its own `systemPrompt` never reached the model, so it read as an agent ignoring the tools it had just been handed. The leading system message is now rebuilt from the target runtime at the point of handoff. The originating agent's skill and subagent catalog blocks are deliberately not carried over — those tools left the menu with the handoff.
- **`type: "image"` content had no branch in the provider adapter.** The SDK's own unified image shape was `JSON.stringify`'d into a text part, so the model never saw the image.
- **Streaming emitted the final answer twice.** The assembled message was published as another delta, so a UI that rendered deltas showed the answer twice.
- **A cancelled run left a dangling `tool_call`.** The persisted transcript then failed the next send with a 400.
- **`postToolUse` never ran on a tool error**, so raw error text reached the transcript, the trace and the model unredacted; and `__finalStructuredOutput` was extracted before the hook, handing the caller an unredacted `result.output`.
- **`snapshot()` threw `DataCloneError` after any handoff.** The handoff tool's raw output was recorded as the target's whole runtime — model and tool closures included — and `captureSnapshot` does a `structuredClone` of `toolHistory`. So a run that handed off could not be snapshotted or checkpointed at all, and a `checkpointing` plugin with `failureMode: "open"` swallowed the throw: exactly the runs that needed a checkpoint (paused, cancelled, errored) silently got none. `toolHistory[].rawOutput` for a handoff is now `{ __handoff: { to } }`.
- **Tools injected at runtime were dropped by the next tool-set sync.** `open_skill` and friends add tools to the live runtime through `__runtimeToolsDelta`; the smart driver then wrote its own tool set over the runtime on the following iteration, so a skill the model had just opened lost its tools — typically right after a summarization pass. Injected tools are now carried across every sync.
- **An approval resume could strand its own approved tool call.** `preopenedSkills` records each opened skill as a tool exchange appended to the transcript — correct on a fresh run, where the transcript ends with the user message. On an approval resume the transcript instead ends with the assistant turn whose tool_call is approved but not yet answered, and appending the synthetic exchange after it buried that call: the pending-call scan walks back only to the most recent assistant turn, finds the synthetic one fully resolved, and reports nothing pending. The loop broke with zero model calls, the approved tool never ran, and the run failed with "a model provider error or exhausted iteration budget" — neither of which had happened. The bindings still happen; the transcript injection is now withheld whenever a tool_call is already pending.

## [0.9.7]

### Changed
- **Publishing now uses npm Trusted Publishing through GitHub Actions.** Releases are published from the GitHub Release event with short-lived OIDC credentials instead of a long-lived npm token. The workflow validates the tag, tests and builds the package, checks the packed contents, and publishes the tagged artifact.

## [0.9.6]

### Changed
- **The planning tool is now `manage_plan`, not `manage_todo_list`.** `manage_todo_list`'s name collided, on downstream products with their own real "todo list" domain (a personal to-do backlog, unrelated to run planning), with a substring match on `"todo_list"` — a deterministic tool-recovery mechanism that force-binds by fuzzy name/description match had no way to tell the SDK's own bookkeeping tool apart from a product's domain todo-list tools, and force-bound the wrong one. `manage_todo_list` still works exactly as before — it is now a deprecated alias sharing the same handler and the same plan state (`stateRef.todoList`/`planVersion`/`adherenceScore`) as `manage_plan`, both bound whenever planning is enabled, so an in-flight run or a caller still on the old name is unaffected. New: `createManageTodoListAliasTool` (exported alongside the existing `createManageTodoTool`, which now builds the `manage_plan` tool). `CONTROL_PLANE_TOOL_NAMES` and the default `criticalTools` list carry both names for the duration of the alias. `PlanEvent.source` widened to `"manage_plan" | "manage_todo_list" | "system"` and now reports whichever name was actually called, instead of always reporting `"manage_todo_list"`. The `<planning>` prompt block's rule 1 now says `manage_plan`.

## [0.9.5]

### Fixed
- **`sanitizeTracePayload(undefined)` no longer returns the string `"undefined"`.** `JSON.stringify(undefined)` returns the real `undefined` (not a string); `JSON.parse` of that then coerces its argument to the string `"undefined"` and throws, and the old catch-all fallback answered with `String(undefined)` — the literal string `"undefined"`. A caller that treats an absent field as a record (e.g. Console's tool-details renderer, which spreads it) split that string into single-character indexed keys instead of showing nothing. `undefined` now stays `undefined` all the way through.

## [0.9.4]

### Added
- **`TracingConfig.metadata`.** Arbitrary key-value tags (e.g. `{ complexity: "complex" }`) forwarded as-is on every tracing payload — session start, streaming events, session end, and the batched/OTLP session file (as `cognipeer.metadata.<key>` resource attributes). The SDK does not interpret these tags; they exist purely so a downstream sink consumer can use them as reporting/attribution dimensions.

## [0.9.3]

### Added
- **Per-model-call structured-output contract on trace events.** The tool menu
  landed in 0.9.2; this is its other half. A model call's output shape is
  decided by two things — the tools it was offered and the contract it was held
  to — and only the first was recorded. So a reply that was not valid JSON
  looked identical whether a schema had been enforced and the model failed it,
  or nothing had ever asked for JSON. That is the difference between a defect
  and a choice, and the trace could not tell them apart.

  Every `ai_call` event now carries a `response_format` section:
  `{type, strategy?, schemaName?, strict?, schema?}`. It rides per event, never
  per session, because an agent can enforce a schema on its final turn only.
  Both strategies report through it: the native `response_format` path as
  `strategy: "native"`, and providers without one — where the SDK enforces the
  same contract through the injected `response` tool — as
  `strategy: "tool_based"`, carrying that tool's schema. A replay
  (evaluation, prompt optimization) that drops the contract measures a looser
  system than production runs under, which is what this exists to prevent.

  Same size discipline as the tool menu: section ≤64KB, and beyond it the
  contract's identity (`type` / `schemaName` / `strict`) survives while the
  schema body is dropped with a `truncated` marker — knowing a strict
  `invoice_v2` schema was enforced is most of the diagnostic value even without
  the schema text. New exports: `TraceResponseFormatSection`,
  `buildResponseFormatSection`; `recordTraceEvent` accepts `responseFormat`
  (the `{response_format: …}` invoke envelope or a bare body) plus
  `responseFormatStrategy`, composing with — never replacing — the message and
  tool-menu sections, and suppressed when `logData` is off.

- **`finishReason` on trace events.** Why the model stopped. `length` — the
  output ceiling — is the single most common cause of truncated and
  unparseable structured output, and without it that failure is
  indistinguishable from a model that simply answered badly. Read from the
  provider's normalized response and exported as an OTLP attribute
  (`cognipeer.finish_reason`).

- **`reasoningTokens` on trace events.** A SUBSET of `outputTokens`, matching
  OpenAI's `completion_tokens_details.reasoning_tokens`. On a reasoning model
  it is routinely most of the output bill while being invisible in the response
  text, so a spend investigation that only sees `outputTokens` cannot explain
  where the money went. Recorded for attribution; consumers must not add it to
  a cost total, because it is already inside the output count. Unlike the four
  token fields, it is **omitted rather than zeroed** on an `ai_call` — a model
  that does no reasoning and a provider that reports nothing are different
  facts. OTLP attribute: `cognipeer.tokens.reasoning`.

### Fixed
- **Native structured output produced a schema the provider rejected — and
  could crash before sending.** The Zod → JSON Schema conversion passed options
  that do not exist in the pinned `zod-to-json-schema`
  (`openaiStrictMode`, `nameStrategy`, `$refStrategy: "extract-to-root"`,
  `nullableStrategy`). They were silently ignored, with teeth:
  - an unrecognised `$refStrategy` made `get$ref` return undefined, so a
    recursive schema (`z.lazy` — comment trees, categories, org charts)
    recursed until `RangeError: Maximum call stack size exceeded`, thrown
    locally before any request was sent;
  - repeated sub-schemas were re-inlined at every use site instead of being
    referenced once;
  - strict mode never ran, so a hand-rolled pass forced `required` on every
    field — turning each `.optional()` into a field the model MUST invent a
    value for, marked required with no null branch.

  Conversion now uses the library's real strict-mode switch (`target: "openAi"`),
  which emits `type: [T, "null"]` for optional fields, marks everything
  required, and sets `additionalProperties: false` at every level.

### Compatibility
- Fully backward compatible. The new trace fields are additive and absent when
  the information is not available; the schema-conversion fix changes the JSON
  Schema sent for `.optional()` fields from "required, no null" to "required,
  nullable" — which is what OpenAI strict mode requires and what the code
  already intended.

## [0.9.2]

### Added
- **Per-model-call tool menus on trace events.** Every `ai_call` trace event
  now carries a `tool_definitions` section recording the exact tool menu the
  model was offered on THAT call (`{name, description?, parameters?}` per
  tool, flat JSON-schema parameters). Menus ride per event — never per
  session — because the bound tools can change between iterations. Size
  discipline matches the Cognipeer console ingest contract: ≤128 tools,
  name ≤200 / description ≤4000 chars, section ≤64KB (oversized entries drop
  `parameters` with a `truncated` marker before the list is trimmed). New
  exports: `TraceToolDefinition`, `TraceToolDefinitionsSection`,
  `buildToolDefinitionsSection`; `recordTraceEvent` accepts an optional
  `toolDefinitions` array that composes with (never replaces) the
  auto-converted message sections and is suppressed when `logData` is off.
  Custom sinks, HTTP/cognipeer sinks and the OTLP exporter (via
  `cognipeer.sections`) all carry the section unchanged.

## [0.9.1] - 2026-08-12

### Added
- **`needsApproval` accepts a predicate — approvals decided per call.** The gate
  read a static boolean, so a tool was either always gated or never: `bash` could
  be paused, but "pause before `rm`, not before `ls`" could not be expressed at
  all. `needsApproval` now takes `boolean | ((args) => boolean)` and the
  predicate is evaluated in the tools node with the parsed arguments in hand,
  immediately before the call would run.

  ```ts
  needsApproval: (args) => /^\s*rm\b/.test(args.command)
  ```

  A predicate that **throws counts as `true`** — a gate that cannot decide has
  not granted permission, and the asymmetry matters: a needless prompt is an
  annoyance, a skipped one is an unreviewed action. A predicate-bearing tool is
  always placed in the sequential group, because the parallel/sequential split
  happens before arguments are parsed and must not decide on a different value
  than the gate sees.

- **`approvalPrompt` accepts a function of the arguments**, so the question can
  quote what is about to happen ("Run `rm -rf build`?") rather than describing
  the tool in general. If it throws, the pause still happens and only the wording
  is lost.

- **`TraceToolDetails.approval.conditional`** marks a tool whose approval is
  decided per call. `approval.required` stays absent in that case, because there
  is no static answer to record; each call's verdict lives on its
  `pendingApprovals` entry.

### Compatibility
- Fully backward compatible: `needsApproval: true | false` and a plain
  `approvalPrompt` string behave exactly as before. A `needsApproval` value that
  is neither a boolean nor a function is now dropped rather than carried through,
  so a stray truthy value cannot gate a tool by accident.

## [0.9.0]

### Added
- **`InvokeConfig.preopenedSkills` — deterministic skill activation.** Discovery
  via `open_skill` is the model's decision, which is right for a capability and
  wrong for a policy: a rule that only applies when the model happens to notice
  it is not a rule. A caller can now name skill keys per invoke; each one is
  opened before the first model call, through the same `open_skill` tool the
  model would have called, and written into the transcript as an assistant tool
  call plus its tool result. The model therefore starts with the skill's
  guidance and tools already bound, in the message shape it is trained on, and
  `bind_skill_tools` still works to widen the surface. Tool call ids are derived
  from the skill key rather than random, so an unchanged preopen set produces a
  byte-identical prefix on every run and provider prompt caching keeps hitting.
  Unknown, unavailable, and already-open keys are skipped rather than injecting
  a broken exchange, so a resumed run does not re-open what it already has.

## [0.8.12]

### Fixed
- **Summarization no longer archives the tool outputs the model just asked for.**
  The recency window in `contextSummarize` was waived whenever no OTHER
  compressable tool message existed. Because messages already rewritten into
  placeholders are excluded from that set, "no others" was true on the very first
  pass AND on every later pass once the backlog was archived — so the pass ate the
  freshest batch instead. The model then read the `ARCHIVED_TOOL_RESPONSE` markers,
  paged every payload back in with `get_tool_response` until that tool's
  `maxExecutionsPerRun` budget ran out, and from then on simply re-issued the
  identical tool calls forever; a production research worker never terminated.
  The window is now unconditional, is evaluated BEFORE the summary is generated
  (so a pass that can reclaim nothing costs no model call), and ignores the
  synthetic `summarize_context` exchange each pass appends — otherwise the window
  drifted off the real tool batch and the next pass archived it anyway.
- **A deferred summarization pass no longer disables summarization for the rest of
  the run.** `__summarizationExhausted` was sticky, so the first pass that could
  not reclaim anything stopped the agent from ever compacting again — and could
  strand a run before its final answer. The flag is now stamped with the tool
  history size and re-arms as soon as new tool output lands, which is the only
  thing that creates new compressable material.
- Recovering an archived tool payload no longer crashes summarization when the
  history entry carries no output (`JSON.stringify(undefined)` returns `undefined`).

## [0.8.11] - 2026-08-04

### Added
- **Tool arguments are repaired before they are rejected.** Grammar-constrained
  and smaller open-weight backends (measured on Qwen-class models behind vLLM)
  routinely emit arguments that are semantically right and syntactically wrong: a
  nested object arrives as a JSON *string* (`expectedResult: "{\"kind\":...}"` →
  `expected object, received string`), a number as `"60"`, a boolean as `"true"`,
  an omitted optional as `""`, a single value where a one-element array was
  wanted, or every argument wrapped in one `input`/`args` envelope key. Each of
  those cost a whole turn to recover from something no reasoning was needed to
  fix. `validateToolArgs` now validates the raw arguments FIRST — so a model that
  emits well-typed arguments is completely unaffected and the schema stays a real
  constraint — and only on failure runs the new `coerceToolArgs` re-typing pass
  and re-validates. Coercion never fabricates a value, so a genuinely missing
  required argument still fails.
- **Validation failures now say what the tool wanted.** A rejected call reports
  the original Zod issues plus a one-line rendering of the tool's top-level
  parameters and their JSON types, because `expected object, received string` on
  its own does not tell a weaker model which key to fix.

### Changed
- **Optional nullable properties are published as plain types.** Zod's
  `.nullable().optional()` — the idiomatic "you may leave this out" — produced
  `anyOf: [X, {"type":"null"}]` for every constrained field, and unions are what
  grammar-constrained decoders follow least reliably. For a property that is not
  in `required`, the null branch carries nothing the `required` list does not
  already carry, so it is now dropped from the JSON Schema sent to the provider.
  Strict mode is untouched: there every property is required and the null branch
  is the only way to express optionality.

## [0.8.10] - 2026-08-02

### Fixed
- **Per-call reasoning config now merges with the adapter's default instead of
  replacing it.** The adapter default is a property of the endpoint (for a
  self-hosted server, typically a `providerExtras` passthrough — a chat-template
  variable, a gateway flag); the per-call override is a property of the turn (an
  agent asking for more or less deliberation on this step). Replacing dropped
  the endpoint's fields the moment any agent set a per-run reasoning config —
  silently, on exactly the deployments that needed them. `providerExtras` is
  now merged key-wise, one level deep, so a call can override a single flag
  without restating the endpoint's whole passthrough.

### Added
- **`reasoning.effort: "none"`.** An explicit "do not think" instruction for a
  model that otherwise defaults to reasoning — distinct from omitting
  `reasoning` entirely, and not a valid `reasoning.level` (there is no coherent
  "off" preset; `reasoning.enabled: false` is how the whole feature is turned
  off).

## [0.8.9] - 2026-07-31

### Fixed
- **Structured-output nudge and correction messages now use `role: "user"`
  instead of `role: "system"`.** Several OpenAI-compatible chat templates (e.g.
  Qwen-class models) reject a `system` message anywhere except the very start
  of the conversation, so the in-loop "you must respond with valid JSON" /
  "call `response` again with corrected values" nudges were rejected outright
  by those backends.

## [0.8.8] - 2026-07-29

### Fixed
- **Summarization spend is now recorded in `state.usage`.** Summarization is a
  real model call, but the node reported its tokens only to the tracing sink.
  A host billing from `result.metadata.usage` was therefore short by exactly
  the summarizer's spend — and only on the long runs where summarization
  fires, i.e. the expensive ones, which is how a host's own accounting and its
  observability dashboard drift apart precisely where the money is. The ledger
  append that `agent.ts` and `agentCore.ts` had each open-coded is extracted
  into `recordUsage()` in `utils/usage.ts` and called from the summarization
  node too, so every node that calls a model now goes through one path.

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

> Builds on the ask-user primitive (0.6.6), the runtime-profile rescale (0.7.0),
> the native reasoning round-trip (0.7.1), and the skill primitive (0.7.2)
> shipped over the preceding months — see those entries for that groundwork.
> This release adds sub-agents on top of it.

### Added
- **Testing & evaluation surface.** New deterministic suites for the sub-agent primitive (`tests/unit/subagents*.test.ts` — intersections with structured output / guardrails / borrowed tools, plus snapshot serialize→resume round-trips, depth/cancellation/fan-out resilience). New `tests/integration/evalHarness.integration.test.ts` runs the public `runSmartAgentEvalHarness` with a scripted model (key-free) to guard the scoring math, and `tests/integration/providerMatrix.integration.test.ts` (`npm run test:matrix`) verifies tool-calling / structured-output / streaming against any real provider whose credentials are present (OpenAI, Anthropic, Azure, Bedrock, Vertex), skipping the rest. Coverage thresholds raised toward current actuals (statements/lines 55, functions 60, branches 45). Docs: new [Testing & Evaluation guide](docs/guide/testing.md) and refreshed `tests/README.md`.
- **Sub-agents (dynamic problem decomposition).** **Opt-in** — a plain `createSmartAgent({ model })` registers no sub-agent tools; pass `subagents: SubagentDef[]` and/or `subagentPolicy` to expose three built-in tools and an `<available_subagents>` system-prompt catalog: `delegate_to(subagent, input)` for predefined registry sub-agents, `spawn_subagent({ role, prompt, input, tools? })` for ad-hoc specialists the orchestrator defines at runtime, and `spawn_subagents_parallel({ tasks })` for concurrent fan-out (bounded by `subagentPolicy.maxParallel`). When enabled, the policy default is hybrid (`mode: "registry_and_adhoc"`). Children are **model-agnostic** (inherit the parent model unless `SubagentDef.model` overrides) and inherit the parent's event / streaming / cancellation / tracing wiring; each spawn emits `subagent` lifecycle events (`start` / `result` / `error` / `paused`) and forwards the child's own events (stamped with `subagentName` / `subagentId`, typed via the new `DelegationEventStamp`). Spawning reuses the existing delegation guards (`maxDepth`, `maxChildCalls`, `childContextPolicy`); sub-agents are single-level (a child never gets its own spawn tools). A tool-approval or `ask_user_question` pause inside a sequential sub-agent is surfaced to the parent and resumed transparently via `state.ctx.__subagentPending`; parallel (`spawn_subagents_parallel`) children may not request human input. Exposed: `SubagentDef`, `SubagentPolicy`, `DEFAULT_SUBAGENT_POLICY`, `SubagentResult`, `SubagentEvent`, `DelegationEventStamp`, `createSubagentTools`, plus the shared `seedChildMessages` helper (now used by both sub-agents and `asTool`).
- **Prompt-override hooks (`promptHooks`).** Intercept the SDK's otherwise-static prompt surfaces from `createSmartAgent`: `transformSystemPrompt(prompt, ctx)` rewrites the fully-composed system prompt, `toolDescriptions` overrides any built-in tool description by name (e.g. `delegate_to`, `spawn_subagent`, `open_skill`, `ask_user_question`), and `subagentCatalog(defaultBlock, subagents)` rewrites the `<available_subagents>` block. Overrides clone affected tools so shared tool objects are never mutated.
- **`asTool` now forwards observability.** Delegated children spawned via `agent.asTool(...)` previously ran "dark"; they now inherit the parent's `onEvent` / `onStream` / `onProgress` / cancellation wiring (events stamped with `delegatedTo`), and share the `seedChildMessages` context-seeding implementation with the sub-agent primitive.

### Fixed
- **Sub-agent human-in-the-loop resume no longer strands the run.** When a delegating tool (`delegate_to` / `spawn_subagent`) paused for a child approval / `ask_user_question` **in the same assistant turn as another tool that completed**, the completing sibling's `tool_result` became the last message and the resume driver read tool_calls off it — so the paused sub-agent was never resumed and the run threw *"Agent loop terminated with a pending tool response…"*. The runtime now re-drives the owning assistant turn's **unresolved** tool_calls (a new `selectPendingToolCalls` helper, shared by the base loop and tools node), skipping already-completed siblings so they never re-execute.
- **Two concurrent sub-agent pauses drain deterministically.** If two delegating tool_calls in one turn both paused for input, resolving one no longer force-resolves the other with empty answers (which threw and abandoned the child). The still-unanswered pause is re-surfaced on the next resume round, and the single `ctx.__awaiting*` pause slot is no longer clobbered by a concurrent sibling.
- **Ad-hoc sub-agents keep their borrowed tools across a HITL resume.** `spawn_subagent({ tools: [...] })` children rebuilt on resume were losing their borrowed tools due to a `tools`/`toolNames` field mismatch between the durable pause record and the spec builder; the child now resumes with its full tool surface.
- **Bound skill tools survive pause/resume.** The per-invoke skill registry was rebuilt empty on every invoke, so any pause dropped every opened/bound skill tool (an approval-gated skill script tool became *"Tool not found"* on resume). Opened skill keys + bound tool names are now persisted on `ctx.__skillState` and rehydrated (re-bound) on the next invoke.
- **`promptHooks.toolDescriptions` function form no longer corrupts sub-agent tool descriptions.** The documented `(defaultDescription) => string` override was double-applied to `delegate_to` / `spawn_subagent` / `spawn_subagents_parallel`, passing the function object (not the default string) into the callback. Overrides are now applied uniformly in one place, so the callback receives the real default text.
- **Sub-agents are opt-in.** Previously a plain `createSmartAgent` registered `spawn_subagent` + `spawn_subagents_parallel` and injected an `<available_subagents>` block by default. They are now wired only when `subagents` or `subagentPolicy` is provided.
- **Parallel spawn budget is charged only for tasks that run.** `spawn_subagents_parallel` no longer counts invalid tasks (unknown sub-agent, ad-hoc disabled) against `maxChildCalls`, so a following `delegate_to` is no longer wrongly refused for an exhausted budget.
- **SKILL.md frontmatter no longer splits scalar values on commas.** A `description` (or any non-list key) containing commas is kept as a scalar string instead of being fragmented into an array, so the always-visible skill header is intact. Comma lists are split only for list-typed keys (e.g. `scripts`) or with explicit `[a, b]` syntax.

## [0.7.3] - 2026-07-14

### Fixed
- **Coalesced multiple tool results into a single user message for Anthropic, Bedrock, and Vertex.** These providers require strict `tool_use` → `tool_result` pairing; when an assistant turn produced several tool calls, each `tool_result` had previously been sent as its own message. Results answering one assistant turn are now merged into a single user-role message per provider request, satisfying the pairing requirement and reducing per-turn message overhead on tool-heavy runs.

## [0.7.2] - 2026-06-17

### Added
- **Skill primitive for progressive capability disclosure.** New `src/smart/skills/` module replaces the up-front tool-selector with on-demand skill opening, keeping the bound-tool count per step small — the property small/weaker models need. `open_skill` / `bind_skill_tools` per-invoke tools (mirroring the ask-user tool's `stateRef` pattern): a "small" skill binds all its tools at once, a "fat" skill returns a ranked tool index and binds a deterministic default floor for models that give no usable query. New `Skill` / `SkillPolicy` types (with a `SMALL_TIER` preset), and a pure `composeToolSets` that rebuilds both runtime tool-set variants with fresh references so newly-bound tools actually propagate across the identity-swap the runtime uses to sync tools between invokes.
- **Wired into `createSmartAgent`.** Passing `opts.skills` builds a per-invoke skill registry, adds an `<available_skills>` header block to the system prompt (availability/tier resolved per invoke), and introduces a generic `__runtimeToolsDelta` marker so a tool that binds new tools mid-run (like `open_skill`) makes them callable on a later turn within the same loop.
- New `docs/guide/skills.md` and `docs/api/skills.md` reference pages.

## [0.7.1] - 2026-06-01

### Added
- **Native reasoning round-trip (thinking blocks).** Provider responses now surface a normalized `reasoning` payload (`{ blocks, summary }`). Anthropic and Bedrock thinking / redacted-thinking blocks (with signatures) are captured on the assistant message and replayed verbatim on the next request, satisfying the providers' signed-thinking requirement. Vertex/Gemini `thought` parts and reasoning token counts are surfaced as a summary. OpenAI o-series / gpt-5 now route through the Responses API (`completeResponses`) when reasoning is requested, exposing the reasoning summary and `reasoning_tokens`; Azure OpenAI gets the same via its `/openai/responses` route. Reasoning mappers raise `max_tokens` above the thinking budget, clamp the budget below it, and strip sampling params (`temperature`/`top_p`/`top_k`) that thinking mode forbids.
- **`reasoning.level: "minimal"`.** A fourth, cheapest reasoning preset (`effort: "minimal"`, reflection off).
- **`initial_then_after_tool` reflection cadence.** Reflects once up-front as a planning note, then like `after_tool`. New default for `level: "medium"` / `"high"`. `on_branch` now fires on an actual tool-name-set change between turns rather than a turn-count heuristic.
- **Reflection hooks and routing.** `reasoning.reflection` accepts `shouldReflect` (override the cadence decision), `buildPrompt` (customize the probe), `onReflection` (side-effect hook), and `feedTo: "memory" | "plan" | "none"` to route the note into a `MemoryFact` or `plan.lastReflection`. Near-duplicate consecutive reflections are suppressed.
- **`validateReasoningConfig(config)`.** Exported pure validator that throws descriptive errors for invalid `level`, `cadence`, `effort`, `budgetTokens`, `everyNTurns`, or `feedTo` values; also run automatically inside `resolveReasoning`.

### Fixed
- **Reflection throttling is now run-scoped.** `reasoning.reflection.maxPerRun` counts reflections within the current `invoke(...)` instead of the whole (possibly resumed) conversation, and `everyNTurns` spacing is enforced in a single place (the duplicate hidden `on_branch` gate was removed).
- **Native reasoning config lifecycle.** `ctx.__reasoning` is (re)applied on every invoke and cleared when native reasoning is disabled, so a resumed run can no longer inherit a stale reasoning configuration.

## [0.7.0] - 2026-05-21

### Changed (BREAKING)
- **Default runtime-profile values modernized for frontier models.** All four built-in profiles (`fast`, `balanced`, `deep`, `research`) had their numeric defaults rescaled for 2026-era models (Claude 4.x, GPT-4o, Gemini 2.x). The previous defaults were tuned for 8k–16k context windows and now leave too much headroom unused. Headline changes per profile:
  - `fast`: `maxToolCalls 4→8`, `maxParallelTools 1→3`, `maxContextTokens 12000→32000`, summarization trigger `9000→24000`, `maxToolResponseChars 8k→16k`.
  - `balanced` (also the shared baseline): `maxToolCalls 8→20`, `maxParallelTools 2→5`, `maxContextTokens 24000→96000`, summarization trigger `17000→72000`, `lastTurnsToKeep 8→16`, `maxChildCalls 4→6`, `maxToolResponseChars 12k→32k`.
  - `deep`: `maxToolCalls 14→40`, `maxParallelTools 3→8`, `maxContextTokens 42000→200000`, summarization trigger `30000→150000`, `lastTurnsToKeep 12→30`, `maxChildCalls 6→10`, `maxToolResponseChars 16k→64k`.
  - `research`: `maxToolCalls 20→80`, `maxParallelTools 4→10`, `maxContextTokens 56000→400000`, summarization trigger `42000→300000`, `lastTurnsToKeep 20→60`, `maxChildCalls 8→16`, `maxParallelChild 3→6`, `maxToolResponseChars 24k→96k`.
  - **Migration:** if you depend on the old conservative caps (e.g., running against an 8k-window model, strict cost ceilings, or a deliberate "tight loop" agent), pass explicit `limits`, `summarization`, `context`, and `toolResponses` overrides — or build a `customProfile` extending the desired base and clamp the values you care about. Behavioral defaults (planning still `off`, `summaryMode: incremental`, `memory.writePolicy: auto_important`, `context.policy: hybrid`) are unchanged.

### Added
- **Tool observability tracing.** New `TraceToolDetails` type captures detailed per-call tool information — execution status, retention policy, approval state — on trace events.

## [0.6.6] - 2026-05-20

### Added
- **Ask-user (structured human-in-the-loop).** Opt in with `humanInTheLoop: { askUser: true }` on `createAgent` / `createSmartAgent` to register a built-in `ask_user_question` tool. When the model calls it, the runtime pauses with a `PendingUserQuestion` entry, emits a `user_question` event, and sets `ctx.__awaitingUserQuestion`. Resume by calling `agent.resolveUserQuestion(state, { id, answers })` which validates the response and appends it as a `role: "tool"` message bound to the original `tool_call_id`. The global `allowFreeText` flag (default `true`) decides whether "Other" / typed answers are accepted; when `false`, every question must include `>= 2` options and the resolver rejects `freeText`. Also exposed: `resolveUserQuestionState`, `createAskUserQuestionTool`, and types `PendingUserQuestion`, `UserQuestionItem`, `UserQuestionOption`, `UserQuestionAnswer`, `UserQuestionAnswerSet`, `UserQuestionResolution`, `UserQuestionEvent`, `HumanInTheLoopOptions`.

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

## [0.6.4] - 2026-04-29

### Fixed
- **Per-call `tool_choice` override was sent even when no tools were bound.** The reflection node temporarily disables tools by clearing the tool list, but still passed a `tool_choice` override alongside it. Both the native adapter and the OpenAI provider now only forward `tool_choice` when `tools.length > 0`.

### Changed
- **`toolResponses.defaultPolicy` now inherits `context.toolResponsePolicy`** (falling back to the active runtime profile default) instead of always defaulting to `"summarize_archive"` regardless of what `context.toolResponsePolicy` was set to.

## [0.6.3] - 2026-04-28

### Fixed
- **A synthetic `summarize_context` marker could leak out as a fake final answer.** When the base loop exited purely to signal SmartAgent that summarization was needed, the last assistant message in state could be the internal synthetic summarization call rather than a real answer. `createAgent` now suppresses `finalAnswer` / `stream` events in that case, and `createSmartAgent` stops running a post-turn summarization pass once the model has already produced a real terminal assistant turn.

## [0.6.2] - 2026-04-22

### Changed
- **Removed additional stale no-op config fields**: `context.archiveLargeToolResponses`, `context.retrieveArchivedToolResponseOnDemand`, and `toolResponses.retryOnSchemaError` (continuing the surface cleanup started in 0.6.0).
- **Context tools refactored into individually exported functions** (`createManageTodoTool` and others) and gained a `hasToolResponseRecoveryReference` guard that recognizes all four retention placeholder markers (`ARCHIVED_TOOL_RESPONSE`, `STRUCTURED_TOOL_RESPONSE`, `SUMMARIZED_TOOL_RESPONSE`, `DROPPED_TOOL_RESPONSE`) before honoring a `get_tool_response` recovery request.

## [0.6.1] - 2026-04-21

### Added
- Unified `reasoning` configuration on `createAgent(...)` / `createSmartAgent(...)` for provider-native reasoning plus post-tool reflection, generated by a new reflection node that produces insights without polluting the assistant's message history.
- Reflection persistence on `state.reflections` plus `reflection` events for streaming UIs and task timelines.
- Native provider reasoning mappings for OpenAI/Azure/OpenAI-compatible, Anthropic, and Vertex/Gemini through the built-in provider layer.

### Changed
- Getting-started, native-provider, state-management, tracing, and type docs were refreshed to describe reasoning/reflection behavior.

## [0.6.0] - 2026-04-21

### Changed (BREAKING)
- **Tool response retention collapsed to a single lazy-summarizer model.** Tool outputs are never reduced at tool-call time. When the summarizer runs (context limit reached), old tool messages are rewritten according to `toolResponses.defaultPolicy` (default `summarize_archive`); the full payload always stays available via `get_tool_response` because it is stored in `state.toolHistory` / `state.toolHistoryArchived`.
- Removed config fields (no backward compatibility): `toolResponses.smallResponseChars`, `smallResponsePolicy`, `largeResponsePolicy`, `fallbackPolicy`, `keepRecentFullCount`.
- Classification enum simplified to `critical | informative | verbose` (removed `small`, `redundant`).
- `maxToolResponseChars` / `maxToolResponseTokens` now only drive an eager hard-cap truncation for non-critical, oversized single responses; the truncated head points at `get_tool_response` for recovery.
- Summarization placeholder prefixes standardized: `STRUCTURED_TOOL_RESPONSE`, `ARCHIVED_TOOL_RESPONSE`, `DROPPED_TOOL_RESPONSE`.

## [0.5.4] - 2026-04-21

### Changed
- npm republish of the `0.5.3` source snapshot from the same `gitHead`; no additional repository diff was recorded for this publish.

## [0.5.3] - 2026-04-18

### Fixed
- **Strict tool-schema mode now falls back safely instead of emitting a schema OpenAI's strict mode would reject.** A new shape-scanner (`hasStrictUnsafeShape`) detects untyped object properties, `$ref`s, and unconstrained `anyOf`/`oneOf`/`allOf` compositions that strict mode can't represent; when a tool's schema contains one, strict mode is silently disabled for that tool instead of sending an invalid `strict: true` tool definition the provider would reject outright.

## [0.5.2] - 2026-04-17

### Changed
- **Native structured output now parses in a single pass instead of always going through the retry/nudge loop.** When the active strategy is `"native"` (the provider's own `response_format: json_schema` contract), the model's text output is guaranteed valid JSON, so the agent loop parses and finalizes immediately on the first text response — no nudges, no extra round-trips. Retries are now reserved for the `"tool_based"` strategy, where the model can still skip calling the `response` tool.

### Fixed
- **Strict JSON Schema conversion no longer sends the unsupported `format` keyword**, which some strict-mode validators reject outright.

## [0.5.1] - 2026-04-15

### Changed
- Internal refactor: consolidated message-content extraction and token-counting into shared utilities (`extractMessageText`, `countMessagesTokens`), simplified the `createSmartAgent` summarization call path behind a `trySummarize` helper, and removed the unused legacy `tokenManager` utility and debug logger. No public behavior change.

## [0.5.0] - 2026-04-14

### Added
- **Native LLM provider layer** (`src/providers/`) — direct API access for six providers without LangChain or any framework dependency. `createProvider(config)` supports `"openai"`, `"anthropic"`, `"azure"`, `"bedrock"`, `"vertex"`, `"openai-compatible"`; `fromNativeProvider(provider, options?)` wraps any provider as a `BaseChatModel` for drop-in agent-sdk use. Includes a unified `ChatCompletionRequest` / `ChatCompletionResponse` schema, an SSE stream parser, AWS Signature V4 signing for Bedrock (zero AWS SDK dependency), and a Google Vertex service-account-JSON → JWT → access-token flow, all built in. 38 new unit tests and a new [Native Providers guide](docs/guide/native-providers.md).

## [0.4.9] - 2026-04-13

### Changed
- npm republish of the `0.4.8` source snapshot from the same `gitHead`; no additional repository diff was recorded for this publish.

## [0.4.8] - 2026-04-10

### Changed
- Removed watchdog telemetry from the smart agent (metrics/config plumbing and its documentation); summarization logic no longer references watchdog metrics. Internal cleanup, no public API change.

## [0.4.7] - 2026-04-09

### Fixed
- **A plain `createAgent` (no `summarization` configured) could throw "Agent context exceeded the available budget" even though nothing had asked for summarization.** The internal `__needsSummarization` signal introduced in 0.4.6 was being set regardless of whether summarization was actually configured. The active summarization threshold is now resolved once per agent (`undefined` when summarization isn't configured) and the signal is cleared whenever it's inactive.

## [0.4.6] - 2026-04-09

### Added
- **Safety check for abnormal loop exit.** If the base loop terminates with an unresolved tool response and no valid exit condition is active (approval pause, cancellation, checkpoint, structured-output finalize, summarization signal), it now throws a descriptive error instead of silently leaking the raw tool output to the caller as if it were the final answer.

### Fixed
- **The final answer is now read from the last *assistant* message, not just the last message in state** — closes a class of bug where a stray trailing message could be returned as the agent's answer.

## [0.4.5] - 2026-04-07

### Added
- **Summarized tool responses now carry retrieval references.** The placeholder left behind for a compacted tool message changed from a bare `"SUMMARIZED"` string to `SUMMARIZED_TOOL_RESPONSE [toolName=…; toolCallId=…; executionId=…]` plus a one-line summary and a `get_tool_response` hint, so the model (and downstream renderers) can tell which call was summarized and how to recover it, instead of an opaque marker.

### Changed
- `get_tool_response`'s description and schema were expanded to also recognize `SUMMARIZED_TOOL_RESPONSE` references, not just `ARCHIVED_TOOL_RESPONSE` / `DROPPED_TOOL_RESPONSE`.

## [0.4.4] - 2026-04-06

### Changed
- npm republish of the `0.4.3` source snapshot from the same `gitHead`; no additional repository diff was recorded for this publish.

## [0.4.3] - 2026-04-05

### Fixed
- **Summarization could trigger prematurely.** The context-size check that signals SmartAgent to summarize was reading `summarization.maxTokens` (which controls *summary output* size) instead of the intended `summarization.summaryTriggerTokens` threshold. It now prefers `summaryTriggerTokens` and only falls back to `maxTokens` when the former isn't set.
- A tool response kept with `retentionPolicy: "keep_full"` was losing its `summary` field (set to an empty string); the summary is now always computed before branching on retention policy.

## [0.4.2] - 2026-04-04

### Changed
- **`get_tool_response`'s description was rewritten for clarity**, spelling out the exact `ARCHIVED_TOOL_RESPONSE [executionId=…]` / `DROPPED_TOOL_RESPONSE [executionId=…]` markers it expects and confirming it also accepts the original `tool_call_id`.
- Archived and dropped tool responses now surface as explicit `ARCHIVED_TOOL_RESPONSE [executionId=…]` / `DROPPED_TOOL_RESPONSE [executionId=…]` messages (previously a single undifferentiated placeholder), each pointing back at `get_tool_response`.

### Fixed
- Safer JSON serialization fallback for tool-response summarization when `JSON.stringify` returns a non-string result.

## [0.4.1] - 2026-04-03

### Changed
- npm republish of the `0.4.0` source snapshot; the only repository changes in this window were documentation/site theming, not part of the published package.

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
