---
title: Limits & Tokens
nav_order: 11
permalink: /limits-tokens/
---

# Limits and Token Management

## Limit knobs

- **`maxToolCalls`** – total tool executions allowed across the entire invocation. Once reached, additional tool calls are skipped and a finalize message is injected.
- **`maxParallelTools`** – maximum concurrent tool executions per agent turn (default 1). Adjust to balance throughput vs. rate limits.
- **`summarization.maxTokens`** – estimated token threshold for the *next* agent turn. Exceeding this triggers the summarization node before the model call.
- **`summarization.summaryPromptMaxTokens`** – max prompt tokens sent to the summarizer (prevents huge summarization prompts).

## Tool limit finalize

When the assistant proposes tool calls but `toolCallCount >= maxToolCalls`, the tools node:
1. Emits `tool_call` events with `phase: "skipped"` for the overflow calls.
2. Appends tool response messages noting the skip.
3. Invokes `toolLimitFinalize`, which injects a system message instructing the model to answer directly.

On the next agent turn, the model sees the finalize notice and must produce a direct assistant response without more tool calls.

## Summarization flow

Summarization is enabled by default for smart agents. It activates when:

```
estimatedTokens(messages) > summarization.maxTokens
```

Steps:
1. Build a bounded summarization prompt (uses `summaryPromptMaxTokens`).
2. Optionally include the previous summary (hierarchical summary chaining).
3. Replace tool response content with `SUMMARIZED` to reduce token load.
4. Append a synthetic assistant/tool pair labelled `summarize_context` containing the summary.
5. Store the latest summary in `state.summaries` for the next round.

Disable summarization entirely via `summarization: false`.

## Token heuristics

`countApproxTokens(text)` estimates tokens using `Math.ceil(text.length / 4)`. It avoids provider-specific encoders and keeps the runtime dependency-free. If you need precise counts, pre-truncate content or swap in your own estimation before calling `invoke`.

## Tips

- Return concise tool payloads to minimize summarization churn. Keep raw content accessible via IDs or `get_tool_response`.
- Increase `summarization.maxTokens` if summarization is happening too frequently.
- Use `summarization.promptTemplate` to enforce domain-specific summary structure.
- For conversations with user-provided long context, consider pre-summarizing or chunking prior to passing into the agent.
- Monitor `summarization` events to visualize how often compaction occurs and whether limits need tuning.
