# Limits and Tokens

## Main limit knobs

- `maxToolCalls`
- `maxParallelTools`
- `maxContextTokens`

## Summarization knobs

Smart-agent summarization is controlled under `summarization`, for example:

- `maxTokens`
- `summaryTriggerTokens`
- `summaryPromptMaxTokens`
- `summaryCompressionRatioTarget`

## Rule of thumb

Use `maxContextTokens` to bound the live conversation budget and then tune `summarization` if compaction is too early or too late.
