
# FAQ

## Why are my tool calls not triggering?
Your model may not support structured tool calls. Try:

- Ensuring your adapter exposes a real `bindTools` implementation (LangChain models already do).
- Wrapping the model with `withTools(model, tools)` as a best-effort fallback.
- Switching to a model that supports OpenAI-style tool calling (e.g. GPT-4o variants).

## When does summarization run?
When `summarization.maxTokens` would be exceeded before the next model call, the `contextSummarize` node compacts history.

## How do I disable summarization?
It is enabled by default. Pass `summarization: false` to `createSmartAgent({ ... })` to turn it off. When disabled, token-threshold compaction is skipped.

## Can I use MCP tools?
Yes. Most MCP clients expose LangChain-style tools. Pass them through `fromLangchainTools(...)` first, then include the returned objects in the `tools` array. They behave like any other SDK-native tool.

## What's the difference between `createAgent` and `createSmartAgent`?
`createAgent` is the minimal loop: no system prompt, no planning helpers, no summaries. `createSmartAgent` adds those features automatically (planning rules, context tools, summarization, optional structured output finalize). Choose the one that matches your orchestration needs.

## Why is my structured output not parsed?
- Ensure `outputSchema` is a Zod schema (or object compatible with `parse`).
- Confirm the model invoked the hidden `response` tool; if it didn’t, inspect the final assistant message and adjust prompting.
- Check the trace session – look for `metadata.error` entries or `__structuredOutputParsed` flags inside events.

## How do I inspect raw tool outputs after summarization?
Call the `get_tool_response` tool with the `executionId` printed in the summarized message (e.g. `SUMMARIZED executionId:'abc123'`). The agent will return the original payload from `toolHistoryArchived`.

## Why do I see “Skipped tool due to tool-call limit”? 
The assistant proposed additional tool calls after hitting `limits.maxToolCalls`. Increase the limit or refine your prompts to encourage earlier final answers. The skip is intentional to force the next turn to respond directly.

## Traces aren't showing up
- Verify `tracing: { enabled: true }` was passed.
- Confirm your process has write access to the tracing path (defaults to `[cwd]/logs`).
- If you configured a non-file sink, check its HTTP responses/callback errors; failures are appended to the session `errors` array with type `sink`.
