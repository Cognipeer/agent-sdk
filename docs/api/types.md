# State And Public Types

The most important types are the ones your application reads, persists, or reacts to. This page focuses on those surfaces.

## `SmartState`

`SmartState` is the main runtime state surface for smart agents.

```ts
type SmartState = {
  messages: Message[];
  toolHistory?: ToolExecution[];
  toolHistoryArchived?: ToolExecution[];
  summaries?: string[];
  summaryRecords?: SummaryRecord[];
  memoryFacts?: MemoryFact[];
  plan?: {
    version: number;
    steps: PlanStepRecord[];
    lastUpdated?: string;
    adherenceScore?: number;
  } | null;
  planVersion?: number;
  reflections?: ReflectionRecord[];
  ctx?: Record<string, any>;
}
```

## `ReasoningConfig`

Both `createAgent(...)` and `createSmartAgent(...)` accept a unified reasoning surface:

```ts
type ReasoningConfig = {
  enabled?: boolean;
  level?: "low" | "medium" | "high";
  native?: {
    effort?: "minimal" | "low" | "medium" | "high";
    budgetTokens?: number;
    includeThoughts?: boolean;
    providerExtras?: Record<string, any>;
  } | false;
  reflection?: {
    enabled?: boolean;
    cadence?: "off" | "every_turn" | "after_tool" | "on_branch";
    mode?: "piggyback" | "separate";
    maxTokens?: number;
    maxChars?: number;
    keepLast?: number;
    summarize?: boolean;
    promptTemplate?: string;
    emitEvents?: boolean;
  } | false;
}
```

- `native` configures provider-specific reasoning/thinking fields.
- `reflection` creates short post-tool text notes without adding normal assistant turns.
- Explicit sub-fields always win over `level` presets.

## `ReflectionRecord`

```ts
type ReflectionRecord = {
  id: string;
  turn: number;
  text: string;
  createdAt: string;
  durationMs?: number;
  anchorMessageIndex?: number;
  trigger?: "off" | "every_turn" | "after_tool" | "on_branch";
  usage?: {
    inputTokens?: number;
    outputTokens?: number;
    cachedInputTokens?: number;
    totalTokens?: number;
    reasoningTokens?: number;
  };
  toolCallIds?: string[];
}
```

Reflection records live on `state.reflections`. They are intended for persistence, timelines, and operator review rather than direct user rendering.

## `ReflectionEvent`

```ts
type ReflectionEvent = {
  type: "reflection";
  id: string;
  turn: number;
  text: string;
  trigger?: "off" | "every_turn" | "after_tool" | "on_branch";
  durationMs?: number;
  usage?: {
    inputTokens?: number;
    outputTokens?: number;
    cachedInputTokens?: number;
    totalTokens?: number;
    reasoningTokens?: number;
  };
  toolCallIds?: string[];
}
```

`SmartAgentEvent` includes `ReflectionEvent` alongside plan, tool-call, summarization, handoff, and final-answer events.

## `PlanStepRecord`

```ts
type PlanStepRecord = {
  id: number;
  step: string;
  owner: "agent" | "user" | "tool" | string;
  exitCriteria: string;
  evidence?: string;
  status: "not-started" | "in-progress" | "completed" | "blocked";
  title?: string;
  description?: string;
}
```

The smart runtime stores the current plan on `state.plan`. The event payload still uses `todoList` for compatibility.

## `PlanEvent`

```ts
type PlanEvent = {
  type: "plan";
  source: "manage_todo_list" | "system";
  operation?: "read" | "write" | "update";
  todoList?: PlanStepRecord[];
  version?: number;
  adherenceScore?: number;
}
```

Remember the distinction:

- `state.plan` is durable runtime state
- `event.todoList` is an event payload

## Profiles and limits

```ts
type BuiltInRuntimeProfile = "fast" | "balanced" | "deep" | "research";
type RuntimeProfile = BuiltInRuntimeProfile | "custom";

type AgentLimits = {
  maxToolCalls?: number;
  maxParallelTools?: number;
  maxContextTokens?: number;
}
```

If you are building a configurable product, these are usually the first types you expose to your own application config layer.

## Snapshot and restore

Snapshots matter if your agents pause, resume, or move through human approval workflows.

At a conceptual level:

- `snapshot(...)` captures serializable runtime state
- `resume(...)` restores and continues execution
- disallowed callback-like keys are stripped from `ctx`

## Tracing config

```ts
type TracingConfig = {
  enabled: boolean;
  mode?: "batched" | "streaming";
  threadId?: string;
  logData?: boolean;
  sink?: TraceSinkConfig;
}
```

Supported sink families:

- file
- http
- cognipeer
- otlp
- custom

Degraded trace runs may finalize as `status: "partial"` when one or more sinks fail but the session still completes.
