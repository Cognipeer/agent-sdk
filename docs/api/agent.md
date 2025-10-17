# Agent API

The Agent SDK provides two main entry points for creating agents, each with different levels of control and features:

- **`createSmartAgent`** - Batteries-included agent with planning, summarization, and structured output (uses `SmartState`)
- **`createAgent`** - Minimal agent loop without system prompt or auto-summarization (uses `AgentState`)

Both share the same core capabilities (tools, limits, handoffs, tracing) but `SmartAgent` adds opinionated features like planning enforcement and token-aware summarization.

---

## createSmartAgent

The batteries-included agent with planning, summarization, and structured output support.

### Signature

```typescript
function createSmartAgent(options: SmartAgentOptions): SmartAgentInstance
```

### Options

```typescript
interface SmartAgentOptions {
  // Required
  model: ModelAdapter;              // Model with invoke(messages) => message
  
  // Tools & Features
  tools?: ToolInterface[];          // Zod tools, LangChain, MCP, or custom
  useTodoList?: boolean;            // Enable planning mode (default: false)
  handoffs?: HandoffDescriptor[];   // Pre-configured agent handoffs
  
  // Limits & Optimization
  limits?: AgentLimits;             // Token and execution limits
  summarization?: boolean;          // Enable summarization (default: true)
  
  // Output & Validation
  outputSchema?: ZodSchema;         // Structured output schema
  
  // Prompts & Behavior
  systemPrompt?: string;            // Additional system instructions
  name?: string;                    // Agent name for logging/handoffs
  
  // Observability
  tracing?: TracingConfig;          // Structured JSON tracing
  
  // Advanced
  usageConverter?: UsageConverter;  // Custom usage normalization
}
```

### AgentLimits

```typescript
interface AgentLimits {
  maxToolCalls?: number;           // Total tool executions per invocation
  maxParallelTools?: number;       // Concurrent tools per agent turn
  maxToken?: number;               // Token threshold for summarization
  contextTokenLimit?: number;      // Target token budget for transcript
  summaryTokenLimit?: number;      // Target size per summary chunk
}
```

### Return Value

```typescript
interface SmartAgentInstance {
  // Core methods
  invoke(state: Partial<SmartState>, config?: InvokeConfig): Promise<AgentInvokeResult>;
  
  // Multi-agent composition
  asTool(options: { toolName: string; description?: string; inputDescription?: string }): ToolInterface;
  asHandoff(options: { toolName?: string; description?: string; schema?: ZodSchema }): HandoffDescriptor;
  
  // State management
  snapshot(state: SmartState, options?: SnapshotOptions): AgentSnapshot;
  resume(snapshot: AgentSnapshot, config?: InvokeConfig, restoreOptions?: RestoreSnapshotOptions): Promise<AgentInvokeResult>;
  
  // Tool approval
  resolveToolApproval(state: SmartState, resolution: ToolApprovalResolution): SmartState;
  
  // Runtime metadata (read-only)
  __runtime: AgentRuntimeConfig;
}
```

### Example

```typescript
import { createSmartAgent, fromLangchainModel } from "@cognipeer/agent-sdk";
import { ChatOpenAI } from "@langchain/openai";
import { z } from "zod";

const agent = createSmartAgent({
  name: "Assistant",
  model: fromLangchainModel(new ChatOpenAI({ model: "gpt-4o-mini" })),
  tools: [weatherTool, searchTool],
  useTodoList: true,
  limits: {
    maxToolCalls: 10,
    maxParallelTools: 3,
    maxToken: 8000,
  },
  outputSchema: z.object({
    summary: z.string(),
    confidence: z.number().min(0).max(1),
  }),
  tracing: { enabled: true },
  onEvent: (event) => {
    if (event.type === "plan") {
      console.log("Plan updated:", event.todoList);
    }
  },
});

const result = await agent.invoke({
  messages: [{ role: "user", content: "What's the weather?" }],
});

console.log(result.content);
console.log(result.output); // Parsed structured output
```

## createAgent

Minimal control loop without system prompt or automatic summarization.

### Signature

```typescript
function createAgent(options: AgentOptions): AgentInstance
```

### Options

```typescript
interface AgentOptions {
  // Required
  model: ModelAdapter;              // Model with invoke(messages) => message
  
  // Tools & Features
  tools?: ToolInterface[];          // Zod tools, LangChain, MCP, or custom
  handoffs?: HandoffDescriptor[];   // Pre-configured agent handoffs
  
  // Limits & Optimization
  limits?: AgentLimits;             // Token and execution limits
  
  // Output & Validation
  outputSchema?: ZodSchema;         // Structured output schema
  
  // Prompts & Behavior
  name?: string;                    // Agent name for logging/handoffs
  
  // Observability
  tracing?: TracingConfig;          // Structured JSON tracing
  
  // Advanced
  usageConverter?: UsageConverter;  // Custom usage normalization
}
```

### Differences from createSmartAgent

- **No automatic system prompt** - you control all messages
- **No planning/TODO tools** - no `manage_todo_list` or `get_tool_response`
- **No automatic summarization** - summarization field ignored
- **Useful for**: Full control over prompts and conversation flow

### Example

```typescript
import { createAgent, fromLangchainModel } from "@cognipeer/agent-sdk";

const agent = createAgent({
  model: fromLangchainModel(model),
  tools: [customTool],
  // No system prompt, no planning, no summarization
});

const result = await agent.invoke({
  messages: [
    { role: "system", content: "You are a helpful assistant." },
    { role: "user", content: "Hello!" },
  ],
});
```

## InvokeConfig

Additional options passed to `invoke()` method:

```typescript
interface InvokeConfig {
  // State monitoring
  onStateChange?: (state: SmartState) => boolean | void;
  
  // Checkpoints
  checkpointReason?: string;
  
  // Per-invocation overrides
  onEvent?: (event: SmartAgentEvent) => void;
}
```

## AgentInvokeResult

Result returned from `invoke()`:

```typescript
interface AgentInvokeResult {
  content: string;              // Final assistant message content
  output?: any;                 // Parsed structured output (if schema provided)
  state: SmartState;            // Final state
  usage?: UsageInfo;            // Aggregated token usage
  error?: Error;                // Error if failed
}
```

## Model Adapters

### fromLangchainModel

Wrap LangChain models for use with Agent SDK:

```typescript
import { fromLangchainModel } from "@cognipeer/agent-sdk";
import { ChatOpenAI } from "@langchain/openai";

const model = fromLangchainModel(new ChatOpenAI({
  model: "gpt-4o-mini",
  apiKey: process.env.OPENAI_API_KEY,
}));
```

### Custom Adapter

Implement your own model adapter:

```typescript
interface ModelAdapter {
  invoke(messages: Message[]): Promise<AssistantMessage>;
  bindTools?(tools: ToolInterface[]): ModelAdapter;
}

const customModel: ModelAdapter = {
  async invoke(messages) {
    // Call your model API
    return { role: "assistant", content: "response" };
  },
  bindTools(tools) {
    // Optional: return new instance with tools bound
    return this;
  },
};
```

## Events

Monitor agent execution via events:

```typescript
type SmartAgentEvent = 
  | { type: "plan"; version: number; todoList: TodoItem[] }
  | { type: "tool_execution"; tool: string; args: any; result: any }
  | { type: "summarization"; summary: string; archivedCount: number }
  | { type: "pause"; reason: string; metadata: any }
  | { type: "resume"; stage: string }
  | { type: "error"; error: Error };
```

## See Also

- [Tools API](/api/tools) - Creating and using tools
- [Nodes API](/api/nodes) - Understanding the execution graph
- [Types API](/api/types) - Complete TypeScript definitions
- [State Management](/guide/state-management) - Working with agent state
