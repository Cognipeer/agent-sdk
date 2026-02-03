
# API

## Exported helpers

| Function | Purpose |
|----------|---------|
| `createSmartAgent(options)` | Smart wrapper with system prompt, planning tools, summarization, and structured output finalize support. |
| `createAgent(options)` | Minimal loop without system prompt or summarization. |
| `createTool({ name, description?, schema, func })` | Convenience helper for Zod-backed tools producing a lightweight tool object. |
| `fromLangchainModel(model)` | Adapter for LangChain `ChatModel` / `Runnable` objects. |
| `fromLangchainTools(tools)` | Converts LangChain/MCP `ToolInterface` objects into lightweight SDK tools. |
| `withTools(model, tools)` | Best-effort helper to bind tools to a model that exposes `bindTools`. |
| `buildSystemPrompt(extra?, planning?, name?)` | Compose the built-in system prompt with optional additional instructions. |
| `contextTools.ts` | Factory for built-in tools (`manage_todo_list`, `get_tool_response`, optional `response`). |
| `nodes/*` | Individual node factories (resolver, agentCore, tools, contextSummarize, toolLimitFinalize). |
| `utils/*` | Token heuristics, usage normalization, tracing helpers. |
| `types.ts` | Full TypeScript surface: `SmartAgentOptions`, `SmartState`, `AgentInvokeResult`, events, etc. |

## Options

### Base Agent (createAgent)

`createAgent` accepts `AgentOptions` - a minimal configuration:

- `model` *(required)* – object with `invoke(messages[]) => assistantMessage`; optional `bindTools(tools)` method.
- `tools?: ToolInterface[]` – Zod tools, LangChain `ToolInterface`, MCP adapters, or any object with `invoke`/`call`.
- `limits?: AgentLimits` – limit configuration:
	- `maxToolCalls?`
	- `maxParallelTools?`
- `outputSchema?: ZodSchema` – enables structured output finalize tool + parsed `result.output`.
- `handoffs?: HandoffDescriptor[]` – pre-configured agent handoffs exposed as tools.
- `usageConverter?: (finalMessage, fullState, model) => any` – override usage normalization.
- `tracing?: { enabled: boolean; logData?: boolean; sink?: TraceSinkConfig }` – structured JSON traces.

### Smart Agent (createSmartAgent)

`createSmartAgent` accepts `SmartAgentOptions` - extends `AgentOptions` with:

- All `AgentOptions` fields above, plus:
- `useTodoList?: boolean` – enable planning mode & `manage_todo_list` tool.
- `summarization?: boolean | { enable: boolean; maxTokens: number; summaryPromptMaxTokens?: number; promptTemplate?: string }` – default `true`; set `false` to disable summarization entirely.
- `systemPrompt?: string` – additional message appended inside the smart prompt.

> **Note:** Use `config.onEvent` in the `invoke()` call to receive structured events during execution (see InvokeConfig below).

### Agent vs SmartAgent behavior

**createAgent** (minimal):
- No automatic system prompt injection
- No planning/TODO tools
- No automatic summarization
- You provide all messages and control flow explicitly
- Useful when you need full control over prompts

**createSmartAgent** (batteries-included):
- A system message is automatically injected using `buildSystemPrompt`.
- Context tools (`manage_todo_list`, `get_tool_response`, and `response` when `outputSchema` is set) are appended to the provided tool list.
- Summarization decisions run before and after tool execution when `summarization.maxTokens` is exceeded (unless disabled with `summarization: false`).

## Return shape

`invoke(input, config?)` resolves to an `AgentInvokeResult<TOutput>`:

```ts
type AgentInvokeResult<TOutput = unknown> = {
	content: string;              // final assistant message string
	output?: TOutput;             // parsed JSON when outputSchema provided
	metadata: { usage?: any };    // raw provider usage (normalized) if available
	messages: Message[];          // full conversation history
	state?: SmartState;           // final agent state (includes tool history, summaries, usage, etc.)
};
```

Use `config.onEvent` in the `invoke()` call to receive structured events during execution.

## Events

`SmartAgentEvent` union includes:

- `tool_call` – `{ phase: 'start' | 'success' | 'error' | 'skipped', name, id?, args?, result?, error?, durationMs? }`
- `plan` – `{ source: 'manage_todo_list' | 'system', todoList?, operation?, version? }`
- `summarization` – `{ summary, archivedCount? }`
- `metadata` – `{ usage?, modelName?, limits? }` emitted after each agent turn.
- `handoff` – `{ from?, to?, toolName }`
- `finalAnswer` – `{ content }` emitted after the final assistant message.

Subscribe via:

```ts
await agent.invoke(state, {
	onEvent: (event) => {
		if (event.type === "tool_call") console.log(event);
	}
});
```

## Usage normalization

`normalizeUsage(rawUsage)` attempts to reconcile provider-specific shapes into:

```ts
{
	prompt_tokens,
	completion_tokens,
	total_tokens,
	prompt_tokens_details: { cached_tokens, audio_tokens },
	completion_tokens_details: {
		reasoning_tokens,
		audio_tokens,
		accepted_prediction_tokens,
		rejected_prediction_tokens,
	},
	raw,
}
```

Usage is stored on `state.usage.perRequest` (one entry per agent turn) and aggregated in `state.usage.totals` keyed by model name.

## Adapters

`fromLangchainModel` duck-types LangChain chat models and runnables. It handles:

- Mapping internal `Message` objects to LangChain message structures.
- Calling `lcModel.invoke(messages)`.
- Rewrapping the result back into `{ role, content, tool_calls, usage }`.
- Binding tools by deferring to `lcModel.bindTools` (or `bind`) after converting your tools with `fromLangchainTools`. If `@langchain/core` is not installed, the adapter keeps using the lightweight SDK representation instead of failing.

`fromLangchainTools` accepts any LangChain `ToolInterface` (including MCP clients built on LangChain) and returns SDK-native tool objects. Use it when you already have ready-made LangChain tools and want to plug them directly into `tools: [...]`.

> Optional dependency: install `@langchain/core` only if you want the adapter to return true LangChain tool instances. Without it, the wrapper still works by invoking the lightweight form.

If you prefer raw SDKs (OpenAI, Anthropic, etc.), implement a small object with `invoke` yourself – no additional helpers required.
