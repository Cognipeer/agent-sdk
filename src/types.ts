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
  maxExecutionsPerRun?: number | null;
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
  // Approximate maximum context tokens the smart runtime should build for model calls
  maxContextTokens?: number;
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

export type TraceSinkOtlpConfig = {
  type: "otlp";
  endpoint: string;
  headers?: Record<string, string>;
};

export type TracingMode = "batched" | "streaming";

export type TraceSinkConfig =
  | TraceSinkFileConfig
  | TraceSinkCustomConfig
  | TraceSinkCognipeerConfig
  | TraceSinkHttpConfig
  | TraceSinkOtlpConfig;

export type TracingConfig = {
  enabled: boolean;
  mode?: TracingMode;
  logData?: boolean;
  sink?: TraceSinkConfig;
  threadId?: string;
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
  // Optional override for the built-in todo list planning instructions.
  // Applied only when todo/planning guidance is enabled.
  todoListPrompt?: string;
  // Optional: normalize provider-specific usage into a common shape
  usageConverter?: (finalMessage: AIMessage, fullState: SmartState, model: any) => any;
  // Optional Zod schema for structured output; when provided, invoke() will attempt to parse
  // the final assistant content as JSON and validate it. Parsed value is returned as result.output
  // with full TypeScript inference.
  outputSchema?: ZodSchema<any>;
  tracing?: TracingConfig;
  /**
   * Unified reasoning configuration. Controls both:
   * - Provider-native reasoning (OpenAI reasoning_effort, Anthropic thinking, Gemini thinkingConfig)
   * - Post-turn reflection (a short textual insight from the model after each tool turn)
   *
   * When omitted or `enabled=false` the agent behaves exactly as before.
   */
  reasoning?: ReasoningConfig;
};

// ─── Reasoning + Reflection ──────────────────────────────────────────────────
// Unified naming:
//  - `reasoning.native`     → provider-native reasoning pass-through
//  - `reasoning.reflection` → post-turn textual reflection step
//
// Top-level `enabled`/`level` act as a preset; explicit sub-keys always win.

export type ReasoningLevel = "low" | "medium" | "high";

export type ReflectionCadence = "off" | "every_turn" | "after_tool" | "on_branch";

export type ReflectionConfig = {
  enabled?: boolean;
  cadence?: ReflectionCadence;
  /**
   * - "piggyback" (default) — appends a short user-style "reflect now" message to the existing
   *   transcript, reusing provider prompt cache. No tools. Returned text becomes a reflection record.
   * - "separate" — dedicated tool-free call with a compact prompt (cheaper, smaller cache hit).
   */
  mode?: "piggyback" | "separate";
  maxTokens?: number;
  maxChars?: number;
  keepLast?: number;
  /** When true reflection messages are compressible by the summarizer. Default false. */
  summarize?: boolean;
  promptTemplate?: string;
  /** When true emits `reflection` SmartAgent events. Default true. */
  emitEvents?: boolean;
};

export type NativeReasoningConfig = {
  effort?: "minimal" | "low" | "medium" | "high";
  budgetTokens?: number;
  includeThoughts?: boolean;
  providerExtras?: Record<string, any>;
};

export type ReasoningConfig = {
  enabled?: boolean;
  level?: ReasoningLevel;
  /** Pass `false` to disable provider-native reasoning while keeping reflection. */
  native?: NativeReasoningConfig | false;
  /** Pass `false` to fully disable reflection. */
  reflection?: ReflectionConfig | false;
};

export type BuiltInRuntimeProfile = "fast" | "balanced" | "deep" | "research";
export type RuntimeProfile = BuiltInRuntimeProfile | "custom";

export type SummarizationMode = "incremental" | "full_rewrite";

export type ContextPolicy = "raw" | "summary_only" | "hybrid";

export type ToolResponseRetentionPolicy = "keep_full" | "keep_structured" | "summarize_archive" | "drop";

export type ToolResponseClassification = "critical" | "informative" | "verbose";

export type PlanningMode = "off" | "todo" | "planner_executor" | "reasoning_then_tools";

export type ReplanPolicy = "never" | "on_failure" | "on_conflict" | "every_n_steps";

export type DelegationMode = "off" | "role_based" | "automatic";

export type ChildContextPolicy = "minimal" | "scoped" | "full";

export type MemoryProviderKind = "inMemory" | "redis" | "postgres" | "mongo" | "s3";

export type MemoryScope = "session" | "user" | "workspace" | "tenant";

export type MemoryWritePolicy = "manual" | "auto_important" | "always";

export type MemoryReadPolicy = "recent_only" | "semantic" | "hybrid";

export type MemoryFact = {
  key: string;
  value: string;
  sourceTurn: number;
  confidence: number;
  ttl?: number | null;
  obsolete?: boolean;
  lastUpdatedAt?: string;
  scope?: MemoryScope;
  tags?: string[];
};

export interface MemoryStore {
  get(scope: MemoryScope, options?: { includeObsolete?: boolean; limit?: number }): Promise<MemoryFact[]>;
  upsert(scope: MemoryScope, facts: MemoryFact[]): Promise<void>;
  markObsolete(scope: MemoryScope, keys: string[]): Promise<void>;
  semanticSearch?(scope: MemoryScope, query: string, options?: { limit?: number }): Promise<MemoryFact[]>;
}

export type SummaryFactItem = {
  key: string;
  value: string;
  confidence?: number;
  source?: string;
};

export type StructuredSummary = {
  stable_facts: SummaryFactItem[];
  active_goals: string[];
  open_questions: string[];
  discarded_obsolete: string[];
  rawSummary?: string;
};

export type SummaryIntegrityCheck = {
  passed: boolean;
  criticalFactLoss: boolean;
  obsoleteFactRevived: boolean;
  notes: string[];
};

export type PlanStepRecord = {
  id: number;
  step: string;
  owner: "agent" | "user" | "tool" | string;
  exitCriteria: string;
  evidence?: string;
  status: "not-started" | "in-progress" | "completed" | "blocked";
  title?: string;
  description?: string;
};

export type SmartAgentSummarizationConfig = {
  enable?: boolean;
  maxTokens?: number;
  summaryTriggerTokens?: number;
  summaryPromptMaxTokens?: number;
  summaryCompressionRatioTarget?: number;
  summaryMode?: SummarizationMode;
  promptTemplate?: string;
  toolFreeCall?: boolean;
  integrityCheck?: boolean;
};

export type SmartAgentBudgetConfig = {
  systemReserveTokens?: number;
  goalsReserveTokens?: number;
  recentTurnsReserveTokens?: number;
  toolResponseReserveTokens?: number;
};

export type SmartAgentContextConfig = {
  policy?: ContextPolicy;
  lastTurnsToKeep?: number;
  toolResponsePolicy?: ToolResponseRetentionPolicy;
  budget?: SmartAgentBudgetConfig;
};

export type SmartAgentPlanningConfig = {
  mode?: PlanningMode;
  replanPolicy?: ReplanPolicy;
  everyNSteps?: number;
};

export type SmartAgentDelegationConfig = {
  mode?: DelegationMode;
  maxDelegationDepth?: number;
  maxChildCalls?: number;
  maxParallelChild?: number;
  childContextPolicy?: ChildContextPolicy;
  requireJsonOutputContract?: boolean;
};

export type SmartAgentMemoryConfig = {
  provider?: MemoryProviderKind;
  store?: MemoryStore;
  scope?: MemoryScope;
  writePolicy?: MemoryWritePolicy;
  readPolicy?: MemoryReadPolicy;
};

export type SmartAgentToolResponseConfig = {
  /**
   * Hard cap (in characters) applied at tool execution time to a single response.
   * Anything larger is truncated immediately with a get_tool_response retrieval hint
   * so a single oversized payload cannot blow up the next model call. Critical
   * tools are exempt from this cap.
   */
  maxToolResponseChars?: number;
  /** Hard cap (approx. tokens) for the same eager truncation rule. */
  maxToolResponseTokens?: number;
  /**
   * Retention policy applied to all non-critical tool responses by the summarizer
   * when it fires (context limit reached). Has no effect at execution time.
    * Defaults to context.toolResponsePolicy, or the active runtime profile default.
   */
  defaultPolicy?: ToolResponseRetentionPolicy;
  /**
   * Per-tool override of the summarizer retention policy. Wins over `defaultPolicy`.
   * Critical tools cannot be reduced regardless of override.
   */
  toolResponseRetentionByTool?: Record<string, ToolResponseRetentionPolicy>;
  /** Tool names whose responses are never reduced by the summarizer or hard cap. */
  criticalTools?: string[];
  /** Controls whether Zod-backed tool schemas fail fast or warn on invalid args. */
  schemaValidation?: "strict" | "warn";
};

export type SmartAgentCustomProfileConfig = {
  extends?: BuiltInRuntimeProfile;
  limits?: AgentLimits;
  summarization?: SmartAgentSummarizationConfig;
  context?: SmartAgentContextConfig;
  planning?: SmartAgentPlanningConfig;
  memory?: SmartAgentMemoryConfig;
  delegation?: SmartAgentDelegationConfig;
  toolResponses?: SmartAgentToolResponseConfig;
};

export type ProfileConfig = {
  limits: Required<AgentLimits>;
  summarization: Required<SmartAgentSummarizationConfig>;
  context: Required<SmartAgentContextConfig> & { budget: Required<SmartAgentBudgetConfig> };
  planning: Required<SmartAgentPlanningConfig>;
  memory: Required<Omit<SmartAgentMemoryConfig, "store">> & { store?: MemoryStore };
  delegation: Required<SmartAgentDelegationConfig>;
  toolResponses: Required<SmartAgentToolResponseConfig>;
};

export type ResolvedSmartAgentConfig = ProfileConfig & {
  runtimeProfile: RuntimeProfile;
  baseProfile: BuiltInRuntimeProfile;
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
  runtimeProfile?: RuntimeProfile;
  customProfile?: SmartAgentCustomProfileConfig;
  // Toggle token-aware context summarization. Default: true. Set to false to disable.
  summarization?: boolean | SmartAgentSummarizationConfig;
  context?: SmartAgentContextConfig;
  memory?: SmartAgentMemoryConfig;
  planning?: SmartAgentPlanningConfig;
  delegation?: SmartAgentDelegationConfig;
  toolResponses?: SmartAgentToolResponseConfig;
  // System prompt configuration
  systemPrompt?: string; // Plain string system prompt to append to defaults
  // Optional override for the built-in todo list planning instructions.
  // Applied only when planning mode injects todo guidance.
  todoListPrompt?: string;
  // Enable internal planning workflow (todo list tool + prompt hints)
  /** @deprecated Use planning.mode="todo" */
  useTodoList?: boolean;
  // Optional: normalize provider-specific usage into a common shape
  usageConverter?: (finalMessage: AIMessage, fullState: SmartState, model: any) => any;
  // Optional Zod schema for structured output; when provided, invoke() will attempt to parse
  // the final assistant content as JSON and validate it. Parsed value is returned as result.output
  // with full TypeScript inference.
  outputSchema?: ZodSchema<any>;
  tracing?: TracingConfig;
  /**
   * Unified reasoning configuration. Same shape as on `AgentOptions`. See `ReasoningConfig`.
   */
  reasoning?: ReasoningConfig;
};

// Runtime representation of an agent (used inside state.agent)
export type AgentRuntimeConfig = {
  name?: string;
  version?: string;
  model: any;
  tools: Array<ToolInterface<any, any, any>>;
  guardrails?: ConversationGuardrail[];
  systemPrompt?: string;
  todoListPrompt?: string;
  limits?: AgentLimits;
  useTodoList?: boolean;
  outputSchema?: ZodSchema<any>;
  // When using native structured output (response_format), this is set by StructuredOutputManager
  responseFormat?: Record<string, any>;
  tracing?: TracingConfig;
  runtimeProfile?: RuntimeProfile;
  smart?: ResolvedSmartAgentConfig;
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
  classification?: ToolResponseClassification;
  retentionPolicy?: ToolResponseRetentionPolicy;
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
  traceId?: string;
  spanId?: string;
  parentSpanId?: string;
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
  | { type: "http"; url: string }
  | { type: "otlp"; endpoint: string };

export type TraceSessionConfigSnapshot = {
  enabled: boolean;
  logData: boolean;
  sink: TraceSinkSnapshot;
};

export type TraceSessionFile = {
  sessionId: string;
  traceId?: string;
  rootSpanId?: string;
  threadId?: string;
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
  | { type: "http"; url: string; headers?: Record<string, string> }
  | { type: "otlp"; endpoint: string; headers?: Record<string, string> };

export type ResolvedTraceConfig = {
  enabled: boolean;
  mode: TracingMode;
  logData: boolean;
  sink: ResolvedTraceSink;
};

export type TraceSessionRuntime = {
  sessionId: string;
  startedAt: number;
  traceId?: string;
  rootSpanId?: string;
  currentIterationSpanId?: string;
  threadId?: string;
  sessionStarted?: boolean;
  agentInfo?: { name?: string; version?: string; model?: string; provider?: string };
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
    classification?: ToolResponseClassification;
    retentionPolicy?: ToolResponseRetentionPolicy;
    archiveId?: string;
    summary?: string;
    status?: "success" | "error" | "rejected" | "handoff";
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
  summaryRecords?: Array<StructuredSummary & { integrity?: SummaryIntegrityCheck; createdAt?: string }>;
  memoryFacts?: MemoryFact[];
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
    classification?: ToolResponseClassification;
    retentionPolicy?: ToolResponseRetentionPolicy;
    archiveId?: string;
    summary?: string;
    status?: "success" | "error" | "rejected" | "handoff";
  }>;
  plan?: { version: number; steps: PlanStepRecord[]; lastUpdated?: string; adherenceScore?: number } | null;
  planVersion?: number;
  /**
   * Post-turn reflection records produced by the reflection node. The SDK keeps the full
   * history here (even when only `keepLast` are re-injected into the prompt) so callers
   * can render them in a task/run timeline.
   */
  reflections?: ReflectionRecord[];
};

export type ReflectionRecord = {
  id: string;
  turn: number;
  /** Plain-text reflection produced by the model. */
  text: string;
  createdAt: string;
  durationMs?: number;
  /** Index of the last message present when this reflection was taken. */
  anchorMessageIndex?: number;
  /** Trigger cadence that fired this reflection. */
  trigger?: ReflectionCadence;
  /** Token usage for this specific reflection call. */
  usage?: {
    inputTokens?: number;
    outputTokens?: number;
    cachedInputTokens?: number;
    totalTokens?: number;
    reasoningTokens?: number;
  };
  /** Optional tool call ids / names the reflection commented on (for UI linking). */
  toolCallIds?: string[];
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
  operation?: "write" | "read" | "update";
  todoList?: PlanStepRecord[];
  version?: number;
  adherenceScore?: number;
};

export type SummarizationEvent = {
  type: "summarization";
  summary: string;
  /** Number of messages that were compressed/summarized */
  messagesCompressed?: number;
  /** Input tokens used for summarization prompt (from model response if available, otherwise estimated) */
  inputTokens?: number;
  /** Output tokens from summarization response (from model response if available, otherwise estimated) */
  outputTokens?: number;
  /** Cached input tokens from model response (prompt cache hit) */
  cachedInputTokens?: number;
  /** Total tokens (input + output) */
  totalTokens?: number;
  /** Duration of the summarization call in milliseconds */
  durationMs?: number;
  /** Previous summary content (if incremental summarization) */
  previousSummary?: string;
  /** Total token count before summarization */
  tokenCountBefore?: number;
  /** Total token count after summarization */
  tokenCountAfter?: number;
  /** @deprecated Use messagesCompressed instead */
  archivedCount?: number;
  structuredSummary?: StructuredSummary;
  integrity?: SummaryIntegrityCheck;
};

export type EvalFamily = "recall" | "state_continuity" | "summarization_fidelity" | "context_rollover" | "query_focused_summary";

export type EvalCase = {
  id: string;
  family: EvalFamily;
  prompt: string;
  expectedPhrases?: string[];
  forbiddenPhrases?: string[];
  expectedFacts?: Array<{ key: string; value: string }>;
  expectedToolNames?: string[];
};

export type EvalProfileDescriptor = {
  label: string;
  runtimeProfile: RuntimeProfile;
  baseProfile?: BuiltInRuntimeProfile;
  customProfile?: SmartAgentCustomProfileConfig;
};

export type EvalProfileTarget = RuntimeProfile | EvalProfileDescriptor;

export type EvalCaseResult = {
  id: string;
  family: EvalFamily;
  success: boolean;
  recallAccuracy: number;
  obsoleteDropAccuracy: number;
  trajectoryScore: number;
  recoveryRate: number;
  overToolingRate: number;
  latencyMs: number;
  totalTokens?: number;
  profile: RuntimeProfile;
  profileLabel?: string;
  baseProfile?: BuiltInRuntimeProfile;
  notes: string[];
};

export type EvalHarnessMetrics = {
  taskSuccess: number;
  recallAccuracy: number;
  obsoleteDropAccuracy: number;
  trajectoryScore: number;
  recoveryRate: number;
  overToolingRate: number;
  latencyMs: number;
  totalTokens: number;
  score: number;
};

export type EvalHarnessResult = {
  profile: RuntimeProfile;
  profileLabel: string;
  baseProfile?: BuiltInRuntimeProfile;
  metrics: EvalHarnessMetrics;
  cases: EvalCaseResult[];
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

export type ProgressEvent = {
  type: "progress";
  stage?: string;
  message?: string;
  percent?: number;
  detail?: any;
};

export type StreamEvent = {
  type: "stream";
  text: string;
  isFinal?: boolean;
};

export type CancelledEvent = {
  type: "cancelled";
  stage?: string;
  reason?: string;
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
  | GuardrailEvent
  | ProgressEvent
  | StreamEvent
  | CancelledEvent
  | ReflectionEvent;

export type ReflectionEvent = {
  type: "reflection";
  id: string;
  turn: number;
  text: string;
  trigger?: ReflectionCadence;
  durationMs?: number;
  usage?: {
    inputTokens?: number;
    outputTokens?: number;
    cachedInputTokens?: number;
    totalTokens?: number;
    reasoningTokens?: number;
  };
  toolCallIds?: string[];
};

export type CancellationTokenLike = {
  readonly isCancellationRequested: boolean;
  onCancellationRequested?: (listener: () => void) => { dispose(): void } | void;
};

export type AbortSignalLike = {
  readonly aborted: boolean;
};

export type ProgressUpdate = {
  stage?: string;
  message?: string;
  percent?: number;
  detail?: any;
};

export type StreamChunk = {
  text: string;
  isFinal?: boolean;
};

export type InvokeConfig = RunnableConfig & {
  // Optional per-call event hook (overrides SmartAgentOptions.onEvent if provided)
  onEvent?: (event: SmartAgentEvent) => void;
  // Optional per-call progress hook
  onProgress?: (progress: ProgressUpdate) => void;
  // Optional per-call streaming hook
  onStream?: (chunk: StreamChunk) => void;
  // Enable streaming if supported by model
  stream?: boolean;
  // Cancellation control
  cancellationToken?: CancellationTokenLike | AbortSignalLike;
  // Optional timeout for the full invoke (ms)
  timeoutMs?: number;
  // Optional per-call limits override
  limits?: Partial<AgentLimits>;
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
  // If outputSchema is set and parsing/validation failed, this describes the error.
  // When output is defined, outputError is undefined and vice versa.
  outputError?: import("./structuredOutput/types.js").StructuredOutputError;
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
