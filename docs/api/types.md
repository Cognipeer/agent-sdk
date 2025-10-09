# Types

Complete TypeScript type definitions for Agent SDK.

## Core Types

### SmartState

The state object that flows through the agent loop:

```typescript
interface SmartState {
  // Messages
  messages: Message[];                    // Conversation history
  
  // Tool tracking
  toolCallCount: number;                  // Total tool calls in session
  toolHistory: ToolExecution[];           // Recent tool results
  toolHistoryArchived: ToolExecution[];   // Archived tool results
  
  // Summarization
  summaries: SummaryMessage[];            // Summarization messages
  
  // Planning
  plan?: TodoList;                        // Current plan
  planVersion?: number;                   // Plan version counter
  
  // Usage tracking
  usage?: UsageInfo;                      // Aggregated token usage
  
  // Runtime
  agent: AgentRuntime;                    // Active agent metadata
  
  // Internal context
  ctx?: StateContext;                     // System internal state
}
```

### Message Types

```typescript
type Message = 
  | SystemMessage
  | UserMessage
  | AssistantMessage
  | ToolMessage;

interface SystemMessage {
  role: "system";
  content: string;
}

interface UserMessage {
  role: "user";
  content: string | MessagePart[];       // Text or multimodal
}

interface AssistantMessage {
  role: "assistant";
  content: string;
  tool_calls?: ToolCall[];
}

interface ToolMessage {
  role: "tool";
  content: string;
  tool_call_id: string;
  name: string;
}

// Multimodal support
type MessagePart = TextPart | ImagePart;

interface TextPart {
  type: "text";
  text: string;
}

interface ImagePart {
  type: "image_url";
  image_url: string | { url: string; detail?: string };
}
```

### ToolInterface

Tool contract that all tools must implement:

```typescript
interface ToolInterface {
  name: string;
  description?: string;
  schema?: any;                           // JSON Schema or Zod
  
  // At least one of these must be implemented
  invoke?(args: any): Promise<any>;
  call?(args: any): Promise<any>;
  func?(args: any): Promise<any>;
}
```

### ToolCall

Tool invocation request from model:

```typescript
interface ToolCall {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string;                    // JSON string
  };
}
```

### ToolExecution

Completed tool execution record:

```typescript
interface ToolExecution {
  executionId: string;
  toolName: string;
  args: any;
  result: any;
  timestamp: number;
  error?: Error;
}
```

## Planning Types

### TodoList

```typescript
interface TodoList {
  items: TodoItem[];
}

interface TodoItem {
  id: number;
  title: string;                          // Short description (3-7 words)
  description: string;                    // Detailed context
  status: TodoStatus;
}

type TodoStatus = "not-started" | "in-progress" | "completed";
```

## Limits & Configuration

### SmartAgentLimits

```typescript
interface SmartAgentLimits {
  maxToolCalls?: number;                  // Default: 50
  maxParallelTools?: number;              // Default: 5
  maxToken?: number;                      // Default: 10000
  contextTokenLimit?: number;             // Default: 8000
  summaryTokenLimit?: number;             // Default: 1000
}
```

### TracingOptions

```typescript
interface TracingOptions {
  enabled: boolean;
  logData?: boolean;                      // Include payloads in trace
  sink?: TraceSinkConfig;
}

type TraceSinkConfig = 
  | { type: "file"; directory?: string }
  | { type: "http"; url: string; headers?: Record<string, string> }
  | { type: "cognipeer"; apiKey: string }
  | { type: "custom"; handler: (event: TraceEvent) => void };
```

## Events

### SmartAgentEvent

```typescript
type SmartAgentEvent = 
  | PlanEvent
  | ToolExecutionEvent
  | SummarizationEvent
  | PauseEvent
  | ResumeEvent
  | ErrorEvent;

interface PlanEvent {
  type: "plan";
  version: number;
  todoList: TodoItem[];
  timestamp: number;
}

interface ToolExecutionEvent {
  type: "tool_execution";
  tool: string;
  args: any;
  result: any;
  duration: number;
  timestamp: number;
}

interface SummarizationEvent {
  type: "summarization";
  summary: string;
  archivedCount: number;
  tokensSaved: number;
  timestamp: number;
}

interface PauseEvent {
  type: "pause";
  reason: string;
  metadata?: any;
  timestamp: number;
}

interface ResumeEvent {
  type: "resume";
  stage: string;
  timestamp: number;
}

interface ErrorEvent {
  type: "error";
  error: Error;
  phase?: string;
  timestamp: number;
}
```

## Results

### AgentInvokeResult

```typescript
interface AgentInvokeResult {
  content: string;                        // Final assistant message
  output?: any;                           // Parsed structured output
  state: SmartState;                      // Final state
  usage?: UsageInfo;                      // Token usage
  error?: Error;                          // Error if failed
  paused?: boolean;                       // True if paused
}
```

### UsageInfo

```typescript
interface UsageInfo {
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
  
  // Provider-specific (optional)
  cache_read_tokens?: number;
  cache_creation_tokens?: number;
  reasoning_tokens?: number;
}
```

## State Management

### AgentSnapshot

```typescript
interface AgentSnapshot {
  version: string;
  timestamp: number;
  state: SerializedState;
  metadata?: {
    tag?: string;
    reason?: string;
    [key: string]: any;
  };
}

interface SerializedState {
  messages: Message[];
  toolCallCount: number;
  toolHistory: ToolExecution[];
  summaries: SummaryMessage[];
  plan?: TodoList;
  usage?: UsageInfo;
}
```

## Multi-Agent

### HandoffDescriptor

```typescript
interface HandoffDescriptor {
  targetAgent: SmartAgent;
  handoffName: string;
  handoffDescription?: string;
  returnOnFinalize?: boolean;
}
```

### AgentRuntime

```typescript
interface AgentRuntime {
  name: string;
  tools: ToolInterface[];
  limits: SmartAgentLimits;
  handoffs?: HandoffDescriptor[];
  useTodoList: boolean;
  summarization: boolean;
}
```

## Guardrails

### GuardrailCheck

```typescript
interface GuardrailCheck {
  name: string;
  check: (message: Message) => boolean | Promise<boolean>;
  severity: "warn" | "block";
  message?: string;
}

interface GuardrailResult {
  passed: boolean;
  violations: GuardrailViolation[];
}

interface GuardrailViolation {
  check: string;
  severity: "warn" | "block";
  message: string;
}
```

## Utilities

### TokenCounter

```typescript
function countApproxTokens(text: string): number;
function countApproxTokens(messages: Message[]): number;
```

### Usage Normalization

```typescript
type UsageConverter = (
  finalMessage: AssistantMessage,
  fullState: SmartState,
  model: ModelAdapter
) => UsageInfo | undefined;
```

## Type Guards

```typescript
function isAssistantMessage(msg: Message): msg is AssistantMessage;
function isToolMessage(msg: Message): msg is ToolMessage;
function isUserMessage(msg: Message): msg is UserMessage;
function isSystemMessage(msg: Message): msg is SystemMessage;
```

## See Also

- [Agent API](/api/agent) - Agent creation and configuration
- [Tools API](/api/tools) - Tool development
- [State Management](/guide/state-management) - Working with state
