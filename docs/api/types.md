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
  watchdog?: {
    tokenDrift?: number;
    contextRotScore?: number;
    overToolingRate?: number;
    compactions?: number;
    lastAction?: string;
  };
  ctx?: Record<string, any>;
}
```

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
