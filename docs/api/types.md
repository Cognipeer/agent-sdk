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
  pendingApprovals?: PendingToolApproval[];
  pendingUserQuestions?: PendingUserQuestion[];
  ctx?: Record<string, any>;
}
```

## `PendingUserQuestion`

Populated when the model calls the built-in `ask_user_question` tool (enabled via `humanInTheLoop.askUser`). The run pauses with `ctx.__awaitingUserQuestion` set.

```ts
type UserQuestionOption = {
  label: string;
  value?: string;       // defaults to label
  description?: string;
  preview?: string;
};

type UserQuestionItem = {
  question: string;
  header?: string;            // short chip (max ~12 chars recommended)
  multiSelect?: boolean;      // default false
  placeholder?: string;
  options?: UserQuestionOption[];
  required?: boolean;         // default true
};

type PendingUserQuestion = {
  id: string;
  toolCallId: string;
  toolName: "ask_user_question";
  questions: UserQuestionItem[];
  status: "pending" | "answered" | "cancelled" | "executed";
  requestedAt: string;
  answeredAt?: string;
  answeredBy?: string;
  answers?: UserQuestionAnswerSet;
  cancelled?: boolean;
  notes?: string;
  allowFreeText?: boolean;    // snapshot of the global flag at request time
  metadata?: Record<string, any>;
};
```

### `UserQuestionResolution`

Passed to `agent.resolveUserQuestion(state, resolution)`:

```ts
type UserQuestionAnswer = {
  values: string[];      // selected option values; single-select questions get one entry
  freeText?: string;     // only valid when allowFreeText is true
  notes?: string;
};

type UserQuestionAnswerSet = Record<string /* question text */, UserQuestionAnswer>;

type UserQuestionResolution = {
  id: string;            // PendingUserQuestion.id or toolCallId
  answers?: UserQuestionAnswerSet;
  answeredBy?: string;
  notes?: string;
  cancelled?: boolean;
};
```

### `UserQuestionEvent`

Emitted by the runtime when the model invokes `ask_user_question`. Subscribe through `invoke({ onEvent })` or the `humanInTheLoop.askUser.onQuestion` shortcut.

```ts
type UserQuestionEvent = {
  type: "user_question";
  status: "pending" | "answered" | "cancelled";
  id: string;
  toolCallId: string;
  questions?: UserQuestionItem[];
  answers?: UserQuestionAnswerSet;
  answeredBy?: string;
  allowFreeText?: boolean;
};
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
    maxPerRun?: number;     // cap total reflections in a single invoke
    everyNTurns?: number;   // minimum tool turns between reflections (default 1)
  } | false;
}
```

- `native` configures provider-specific reasoning/thinking fields.
- `reflection` creates short post-tool text notes without adding normal assistant turns.
- `reflection.maxPerRun` and `reflection.everyNTurns` cap reflection cost in long tool-heavy invokes.
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
  maxToolCalls?: number;          // tool budget for the whole invoke
  maxParallelTools?: number;      // concurrent non-approval tools per turn
  maxContextTokens?: number;      // approx ceiling for model-facing context
  maxTotalOutputTokens?: number;  // cumulative model output token budget
  maxCostUsd?: number;            // cumulative USD cost — needs costEstimator
  maxWallClockMs?: number;        // total wall-clock budget for the invoke
}
```

`AgentOptions` and `SmartAgentOptions` additionally expose:

```ts
type AgentOptions = {
  // ... model, tools, limits, tracing, reasoning, ...
  tokenCounter?: (text: string) => number;
  costEstimator?: (args: {
    modelName?: string;
    inputTokens: number;
    outputTokens: number;
    cachedInputTokens?: number;
    reasoningTokens?: number;
  }) => number;
};
```

- `tokenCounter` swaps the built-in character heuristic for a real tokenizer (tiktoken, `@anthropic-ai/tokenizer`, …) for the duration of a single `invoke(...)`.
- `costEstimator` is required for `maxCostUsd` to take effect. The SDK has no built-in pricing table.

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
