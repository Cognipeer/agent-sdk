// LangChain specific types are removed from core; we define lightweight internal shapes.
// If the user uses LangChain, they can still pass LC message objects; we treat them opaquely.
import type { ZodSchema } from "zod";

// Image and content part types for multimodal messages
export type ImageURL =
  | { url: string; detail?: 'auto' | 'low' | 'high' }
  | { base64: string; media_type?: string; detail?: 'auto' | 'low' | 'high' }
  | string;

export type ContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: ImageURL }
  | { type: string; [key: string]: any };

// Generic tool interface minimal contract (duck-typed). If user passes a LangChain Tool it will satisfy this.
export interface ToolInterface<TInput = any, TOutput = any, TCallOptions = any> {
  name: string;
  description?: string;
  // Either invoke(arg) or call(arg)
  invoke?: (input: TInput, config?: TCallOptions) => Promise<TOutput> | TOutput;
  call?: (input: TInput, config?: TCallOptions) => Promise<TOutput> | TOutput;
  schema?: any; // optional JSON schema / zod inference
  needsApproval?: boolean;
  approvalPrompt?: string;
  approvalDefaults?: any;
  [key: string]: any;
}

export type RunnableConfig = { [key: string]: any };

// Base message (internal) – we accept either string content or array parts.
export type BaseMessage = {
  role: string; // 'user' | 'assistant' | 'system' | 'tool' | etc.
  name?: string;
  content: string | ContentPart[];
  tool_calls?: any;
  tool_call_id?: string;
  [key: string]: any;
};

// AI message is any message with role=assistant; keep alias for usageConverter generics
export type AIMessage = BaseMessage & { role: 'assistant' };

export type Message = BaseMessage; // maintain alias used elsewhere

export enum GuardrailPhase {
  Request = "request",
  Response = "response",
}

export type GuardrailDisposition = "block" | "warn" | "allow";

export type GuardrailContext = {
  phase: GuardrailPhase;
  messages: Message[];
  latestMessage?: Message;
  state: SmartState;
  runtime?: AgentRuntimeConfig;
  options: SmartAgentOptions;
};

export type GuardrailRuleResult = {
  passed: boolean;
  reason?: string;
  details?: Record<string, any>;
  disposition?: GuardrailDisposition;
};

export type GuardrailRule = {
  id?: string;
  title?: string;
  description?: string;
  evaluate: (
    context: GuardrailContext
  ) => Promise<GuardrailRuleResult> | GuardrailRuleResult;
  metadata?: Record<string, any>;
};

export type GuardrailIncident = {
  guardrailId?: string;
  guardrailTitle?: string;
  ruleId?: string;
  ruleTitle?: string;
  phase: GuardrailPhase;
  reason?: string;
  details?: Record<string, any>;
  disposition: GuardrailDisposition;
};

export type ConversationGuardrail = {
  id?: string;
  title?: string;
  description?: string;
  appliesTo: GuardrailPhase[];
  rules: GuardrailRule[];
  haltOnViolation?: boolean;
  onViolation?: (
    incident: GuardrailIncident,
    context: GuardrailContext
  ) => Promise<GuardrailDisposition | void> | GuardrailDisposition | void;
  metadata?: Record<string, any>;
};

export type GuardrailOutcome = {
  ok: boolean;
  incidents: GuardrailIncident[];
};

// Common limits for both Agent and SmartAgent
export type AgentLimits = {
  maxToolCalls?: number;
  // Maximum number of tools to execute in parallel per turn
  maxParallelTools?: number;
};

// Alias for backward compatibility
export type SmartAgentLimits = AgentLimits;

export type TraceSinkFileConfig = {
  type: "file";
  path?: string;
};

export type TraceSinkCustomConfig = {
  type: "custom";
  onEvent?: (event: TraceEventRecord) => void | Promise<void>;
  onSession?: (session: TraceSessionFile) => void | Promise<void>;
};

export type TraceSinkCognipeerConfig = {
  type: "cognipeer";
  apiKey: string;
  url?: string;
};

export type TraceSinkHttpConfig = {
  type: "http";
  url: string;
  headers?: Record<string, string>;
};

export type TraceSinkConfig =
  | TraceSinkFileConfig
  | TraceSinkCustomConfig
  | TraceSinkCognipeerConfig
  | TraceSinkHttpConfig;

export type TracingConfig = {
  enabled: boolean;
  logData?: boolean;
  sink?: TraceSinkConfig;
};

// Alias for backward compatibility
export type SmartAgentTracingConfig = TracingConfig;

// --- Base Agent (simple, minimal) ---
export type AgentOptions = {
  // Human-friendly agent name used in prompts and logging
  name?: string;
  version?: string;
  model: any; // A BaseChatModel-like object with invoke(messages[]) => assistant message
  // Accept any tool implementation matching minimal ToolInterface (LangChain Tool compatible)
  tools?: Array<ToolInterface<any, any, any>>;
  // Optional guard layer descriptors to evaluate before sending requests and after receiving responses
  guardrails?: ConversationGuardrail[];
  // Predefined handoff targets exposed as tools automatically
  handoffs?: HandoffDescriptor[];
  limits?: AgentLimits;
  // Optional: normalize provider-specific usage into a common shape
  usageConverter?: (finalMessage: AIMessage, fullState: SmartState, model: any) => any;
  // Optional Zod schema for structured output; when provided, invoke() will attempt to parse
  // the final assistant content as JSON and validate it. Parsed value is returned as result.output
  // with full TypeScript inference.
  outputSchema?: ZodSchema<any>;
  tracing?: TracingConfig;
};

// --- Smart Agent (batteries-included with planning & summarization) ---
export type SmartAgentOptions = {
  // Human-friendly agent name used in prompts and logging
  name?: string;
  version?: string;
  model: any; // A BaseChatModel-like object with invoke(messages[]) => assistant message
  // Accept any tool implementation matching minimal ToolInterface (LangChain Tool compatible)
  tools?: Array<ToolInterface<any, any, any>>;
  // Optional guard layer descriptors to evaluate before sending requests and after receiving responses
  guardrails?: ConversationGuardrail[];
  // Predefined handoff targets exposed as tools automatically
  handoffs?: HandoffDescriptor[];
  limits?: AgentLimits;
  // Toggle token-aware context summarization. Default: true. Set to false to disable.
  summarization?: boolean | {
    enable: boolean;
    maxTokens: number;
    /** Max tokens to include in the summarization prompt itself (to avoid sending huge context to summarizer). Default: 8000 */
    summaryPromptMaxTokens?: number;
  };
  // System prompt configuration
  systemPrompt?: string; // Plain string system prompt to append to defaults
  // Enable internal planning workflow (todo list tool + prompt hints)
  useTodoList?: boolean;
  // Optional: normalize provider-specific usage into a common shape
  usageConverter?: (finalMessage: AIMessage, fullState: SmartState, model: any) => any;
  // Optional Zod schema for structured output; when provided, invoke() will attempt to parse
  // the final assistant content as JSON and validate it. Parsed value is returned as result.output
  // with full TypeScript inference.
  outputSchema?: ZodSchema<any>;
  tracing?: TracingConfig;
};

// Runtime representation of an agent (used inside state.agent)
export type AgentRuntimeConfig = {
  name?: string;
  version?: string;
  model: any;
  tools: Array<ToolInterface<any, any, any>>;
  guardrails?: ConversationGuardrail[];
  systemPrompt?: string;
  limits?: AgentLimits;
  useTodoList?: boolean;
  outputSchema?: ZodSchema<any>;
  tracing?: TracingConfig;
};

export type TraceMessageSection = {
  id?: string;
  kind: "message";
  label: string;
  role: string;
  content: string;
  metadata?: Record<string, any>;
};

export type TraceToolCallSection = {
  id?: string;
  kind: "tool_call";
  label: string;
  tool: string;
  arguments?: any;
};

export type TraceToolResultItem = {
  title?: string;
  url?: string;
  snippet?: string;
  [key: string]: any;
};

export type TraceToolResultSection = {
  id?: string;
  kind: "tool_result";
  label: string;
  tool: string;
  summary?: string;
  items?: TraceToolResultItem[];
  output?: any;
};

export type TraceToolResponseSection = {
  id?: string;
  kind: "tool_response";
  label: string;
  tool: string;
  summary?: string;
  items?: TraceToolResultItem[];
  output?: any;
};

export type TraceSummarySection = {
  id?: string;
  kind: "summary";
  label: string;
  content: string;
};

export type TraceMetadataSection = {
  id?: string;
  kind: "metadata";
  label: string;
  data: Record<string, any>;
};

export type TraceDataSection =
  | TraceMessageSection
  | TraceToolCallSection
  | TraceToolResultSection
  | TraceToolResponseSection
  | TraceSummarySection
  | TraceMetadataSection;

export type TraceEventRecord = {
  sessionId: string;
  id: string;
  type: string;
  label: string;
  sequence: number;
  timestamp: string;
  actor?: { scope?: string; name?: string; role?: string; version?: string };
  status: "success" | "error" | "skipped" | "retry";
  durationMs?: number;
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  cachedInputTokens?: number;
  requestBytes?: number;
  responseBytes?: number;
  model?: string;
  provider?: string;
  toolExecutionId?: string;
  retryOf?: string;
  error?: { message: string; stack?: string } | null;
  data?: { sections: TraceDataSection[] };
  debug?: Record<string, any>;
};

export type TraceErrorRecord = {
  eventId: string;
  message: string;
  stack?: string;
  type?: string;
  timestamp?: string;
};

export type TraceSessionSummary = {
  totalDurationMs: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCachedInputTokens: number;
  totalBytesIn: number;
  totalBytesOut: number;
  eventCounts: Record<string, number>;
};

export type TraceSessionStatus = "in_progress" | "success" | "error" | "partial";

export type TraceSinkSnapshot =
  | { type: "file"; path: string }
  | { type: "custom" }
  | { type: "cognipeer"; url: string }
  | { type: "http"; url: string };

export type TraceSessionConfigSnapshot = {
  enabled: boolean;
  logData: boolean;
  sink: TraceSinkSnapshot;
};

export type TraceSessionFile = {
  sessionId: string;
  startedAt: string;
  endedAt?: string;
  durationMs?: number;
  agent?: { name?: string; version?: string; model?: string; provider?: string };
  config: TraceSessionConfigSnapshot;
  summary: TraceSessionSummary;
  events: TraceEventRecord[];
  status: TraceSessionStatus;
  errors: TraceErrorRecord[];
};

export type ResolvedTraceSink =
  | { type: "file"; baseDir: string }
  | { type: "custom"; onEvent?: (event: TraceEventRecord) => void | Promise<void>; onSession?: (session: TraceSessionFile) => void | Promise<void> }
  | { type: "cognipeer"; url: string; apiKey: string }
  | { type: "http"; url: string; headers?: Record<string, string> };

export type ResolvedTraceConfig = {
  enabled: boolean;
  mode: "batched";
  logData: boolean;
  sink: ResolvedTraceSink;
};

export type TraceSessionRuntime = {
  sessionId: string;
  startedAt: number;
  resolvedConfig: ResolvedTraceConfig;
  events: TraceEventRecord[];
  summary: TraceSessionSummary;
  status: TraceSessionStatus;
  errors: TraceErrorRecord[];
  fileBaseDir?: string;
  fileSessionDir?: string;
};

// Handoff descriptor returned from childAgent.asHandoff(...)
export type HandoffDescriptor<TParsed = any> = {
  type: "handoff";
  toolName: string;
  description: string;
  // Optional zod schema for handoff arguments; fallback is { reason: string }
  schema?: ZodSchema<any>;
  target: SmartAgentInstance<TParsed> & { __runtime: AgentRuntimeConfig };
};

// Base Agent State (minimal)
export type AgentState = {
  messages: Message[];
  // Active agent runtime parameters (dynamically swapped on handoff)
  agent?: AgentRuntimeConfig;
  toolHistory?: Array<{
    executionId: string;
    toolName: string;
    args: any;
    output: any;
    rawOutput?: any;
    timestamp?: string;
    summarized?: boolean;
    originalTokenCount?: number | null;
    messageId?: string;
    tool_call_id?: string;
    fromCache?: boolean;
  }>;
  toolCache?: Record<string, any>;
  toolCallCount?: number;
  metadata?: Record<string, any>;
  ctx?: Record<string, any>;
  pendingApprovals?: PendingToolApproval[];
  // Usage tracking (per agent model call). Each agent turn that produces an AI response
  // appends an entry to usage.perRequest. totals aggregates by modelName.
  usage?: {
    perRequest: Array<{
      id: string;            // unique id per request
      modelName: string;     // resolved provider/model identifier
      usage: any;            // raw provider usage object (unmodified)
      timestamp: string;     // ISO time of capture
      turn: number;          // 1-based index of agent turn producing this response
      cachedInput?: number;  // cached / reused prompt tokens (provider specific)
    }>;
    totals: Record<string, { input: number; output: number; total: number; cachedInput: number }>;
  };
  guardrailResult?: GuardrailOutcome;
};

// Smart Agent State (extends base with planning & summarization)
export type SmartState = AgentState & {
  summaries?: string[];
  toolHistoryArchived?: Array<{
    executionId: string;
    toolName: string;
    args: any;
    output: any;
    rawOutput?: any;
    timestamp?: string;
    summarized?: boolean;
    originalTokenCount?: number | null;
    messageId?: string;
    tool_call_id?: string;
    fromCache?: boolean;
  }>;
  plan?: { version: number; steps: Array<{ index: number; title: string; status: string }>; lastUpdated?: string } | null;
  planVersion?: number;
};

// Event types for observability and future streaming support
export type ToolCallEvent = {
  type: "tool_call";
  phase: "start" | "success" | "error" | "skipped";
  name: string;
  id?: string;
  args?: any;
  result?: any;
  error?: { message: string } | undefined;
  durationMs?: number;
};

export type PlanEvent = {
  type: "plan";
  source: "manage_todo_list" | "system";
  operation?: "write" | "read";
  todoList?: Array<{ id: number; title: string; description: string; status: string; evidence?: string }>;
  version?: number;
};

export type SummarizationEvent = {
  type: "summarization";
  summary: string;
  archivedCount?: number;
};

export type FinalAnswerEvent = {
  type: "finalAnswer";
  content: string;
};

export type MetadataEvent = {
  type: "metadata";
  usage?: any;
  modelName?: string;
  limits?: SmartAgentLimits;
  [key: string]: any;
};

export type HandoffEvent = {
  type: "handoff";
  from?: string;
  to?: string;
  toolName: string;
};

export type ToolApprovalStatus = "pending" | "approved" | "rejected" | "executed";

export type PendingToolApproval = {
  id: string;
  toolCallId: string;
  toolName: string;
  args: any;
  status: ToolApprovalStatus;
  requestedAt: string;
  decidedAt?: string;
  decidedBy?: string;
  comment?: string;
  approvedArgs?: any;
  resolvedAt?: string;
  executionId?: string;
  metadata?: Record<string, any>;
};

export type ToolApprovalResolution = {
  id: string;
  approved: boolean;
  approvedArgs?: any;
  decidedBy?: string;
  comment?: string;
};

export type ToolApprovalEvent = {
  type: "tool_approval";
  status: "pending" | "approved" | "rejected";
  id: string;
  toolName: string;
  toolCallId?: string;
  args?: any;
  decidedBy?: string;
  comment?: string;
};

export type GuardrailEvent = {
  type: "guardrail";
  phase: GuardrailPhase;
  guardrailId?: string;
  guardrailTitle?: string;
  ruleId?: string;
  ruleTitle?: string;
  disposition: GuardrailDisposition;
  reason?: string;
  details?: Record<string, any>;
};

export type SmartAgentEvent =
  | ToolCallEvent
  | ToolApprovalEvent
  | PlanEvent
  | SummarizationEvent
  | FinalAnswerEvent
  | MetadataEvent
  | HandoffEvent
  | GuardrailEvent;

export type InvokeConfig = RunnableConfig & {
  // Optional per-call event hook (overrides SmartAgentOptions.onEvent if provided)
  onEvent?: (event: SmartAgentEvent) => void;
  // Invoked after each major stage; return true to checkpoint execution (state.ctx.__paused will be set).
  onStateChange?: (state: SmartState) => boolean;
  // Optional reason stored alongside checkpoint metadata.
  checkpointReason?: string;
};

export type SnapshotRuntimeHint = {
  name?: string;
  version?: string;
  tools?: string[];
};

export type SerializableSmartState = Omit<SmartState, "agent"> & { agent?: undefined };

export type AgentSnapshotMetadata = {
  createdAt: string;
  tag?: string;
  paused?: {
    stage?: string;
    iteration?: number;
    reason?: string;
  } | null;
};

export type AgentSnapshot = {
  state: SerializableSmartState;
  runtimeHint?: SnapshotRuntimeHint;
  metadata: AgentSnapshotMetadata;
};

export type SnapshotOptions = {
  tag?: string;
  includeRuntimeHint?: boolean;
};

export type RestoreSnapshotOptions = {
  agent?: AgentRuntimeConfig;
  ctx?: Record<string, any>;
  mergeCtx?: boolean;
};

// Structured agent result returned by invoke
export type AgentInvokeResult<TOutput = unknown> = {
  content: string;
  // If outputSchema is set, this will contain the parsed and validated output.
  // TOutput will be inferred from the provided Zod schema.
  output?: TOutput;
  metadata: { usage?: any };
  messages: Message[];
  state?: SmartState;
};

// Base Agent instance (minimal)
export type AgentInstance<TOutput = unknown> = {
  invoke: (input: SmartState, config?: InvokeConfig) => Promise<AgentInvokeResult<TOutput>>;
  snapshot: (state: SmartState, options?: SnapshotOptions) => AgentSnapshot;
  resume: (snapshot: AgentSnapshot, config?: InvokeConfig, restoreOptions?: RestoreSnapshotOptions) => Promise<AgentInvokeResult<TOutput>>;
  resolveToolApproval: (state: SmartState, resolution: ToolApprovalResolution) => SmartState;
  // Convert this agent into a tool usable by another agent. Accepts optional overrides.
  asTool: (opts: { toolName: string; description?: string; inputDescription?: string } ) => ToolInterface<any, any, any>;
  // Create a handoff descriptor so another agent can switch control to this one mid-conversation
  asHandoff: (opts: { toolName?: string; description?: string; schema?: ZodSchema<any>; }) => HandoffDescriptor<TOutput>;
  __runtime: AgentRuntimeConfig;
};

// Smart Agent instance (same as AgentInstance for now, but semantically separate)
export type SmartAgentInstance<TOutput = unknown> = AgentInstance<TOutput>;
