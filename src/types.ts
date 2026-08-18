// LangChain specific types are removed from core; we define lightweight internal shapes.
// If the user uses LangChain, they can still pass LC message objects; we treat them opaquely.
import type { ZodSchema } from "zod";
import type { ContextPilotConfig, ContextPilotCompressionStats, ResolvedContextPilotConfig } from "./smart/contextPilot/types.js";

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
/**
 * Decides, per call, whether this invocation needs human approval.
 *
 * Return `true` to pause. Returning a non-boolean is treated as `false` except
 * for a thrown error, which is treated as `true` — see `needsApproval`.
 */
export type ToolApprovalPredicate = (args: any) => boolean;

export interface ToolInterface<TInput = any, TOutput = any, TCallOptions = any> {
  name: string;
  description?: string;
  // Either invoke(arg) or call(arg)
  invoke?: (input: TInput, config?: TCallOptions) => Promise<TOutput> | TOutput;
  call?: (input: TInput, config?: TCallOptions) => Promise<TOutput> | TOutput;
  schema?: any; // optional JSON schema / zod inference
  /**
   * Whether a call must pause for a human before it runs.
   *
   * A boolean decides for the tool as a whole. A PREDICATE decides per call, with
   * the parsed arguments in hand — which is the only way to express "ask before
   * `rm`, but not before `ls`", because the interesting half of a dangerous tool
   * is usually its arguments, not its name.
   *
   * The predicate runs inside the tools node, immediately before the call would
   * execute, and it must not throw: a predicate that throws is treated as
   * `true`, because a policy that cannot decide has not granted permission.
   */
  needsApproval?: boolean | ToolApprovalPredicate;
  /**
   * The text shown to whoever is asked. A function receives the same arguments
   * the predicate saw, so the prompt can quote what is actually about to happen
   * ("Delete 3 files under /src?") instead of describing the tool in general.
   */
  approvalPrompt?: string | ((args: any) => string | undefined);
  approvalDefaults?: any;
  maxExecutionsPerRun?: number | null;
  /**
   * Context-retention hint declared by the tool author: what the summarizer may do
   * to this tool's arguments and response under context pressure. The tool author
   * knows whether the arguments are the payload (a file write) or just identity (a
   * lookup); a global policy cannot. A caller-supplied
   * `toolResponses.retentionByTool[name]` still overrides this per axis.
   */
  retention?: ToolRetentionSpec;
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
  /**
   * Cap on cumulative model output tokens across the whole invoke. Once
   * exceeded the loop terminates after the current iteration with a
   * `metadata` event explaining the reason and emits `finalAnswer` so callers
   * can still recover the partial result.
   */
  maxTotalOutputTokens?: number;
  /**
   * Cap on cumulative cost in USD. Requires `costEstimator` on the agent
   * options to be a no-op-free check; otherwise this limit is ignored.
   */
  maxCostUsd?: number;
  /**
   * Cap on total wall-clock time for the invoke in milliseconds. Identical
   * semantics to `InvokeConfig.timeoutMs` but lives on the agent definition
   * so server-side defaults can be enforced without per-call wiring.
   */
  maxWallClockMs?: number;
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
  /**
   * Optional caller-supplied session id. When set, the trace session is keyed
   * by this value instead of an auto-generated `sess_…` id, so the emitted
   * traces can be correlated with the caller's own run/task/chat identifiers.
   * When omitted, a random session id is generated (previous behavior).
   */
  sessionId?: string;
  /**
   * Optional display name for the agent that owns this trace session. Overrides
   * the SmartAgent's own `name` in the emitted session/start payload — useful
   * when the same agent implementation runs under several logical names.
   */
  agentName?: string;
  /**
   * Arbitrary key-value tags forwarded to every tracing payload for downstream
   * attribution/reporting; not interpreted by the SDK itself.
   */
  metadata?: Record<string, string>;
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
  /**
   * Optional drop-in token counter. When provided, all internal token
   * estimates (summarization trigger, hard caps, context budget) use this
   * function instead of the built-in character heuristic. Recommended:
   * tiktoken / @anthropic-ai/tokenizer for production accuracy.
   */
  tokenCounter?: (text: string) => number;
  /**
   * Pluggable cost estimator: returns USD cost for a single model call's
   * usage. Used by the `maxCostUsd` budget limit. When omitted the SDK has
   * no built-in pricing table and the cost limit is a no-op.
   */
  costEstimator?: (args: {
    modelName?: string;
    inputTokens: number;
    outputTokens: number;
    cachedInputTokens?: number;
    reasoningTokens?: number;
  }) => number;
  /**
   * Human-in-the-loop hooks. When `askUser` is enabled, the agent gains a
   * built-in `ask_user_question` tool that pauses the run with structured
   * questions for the host application to answer.
   */
  humanInTheLoop?: HumanInTheLoopOptions;
  /**
   * ContextPilot: native, deterministic context/token optimization layer.
   * Compresses large tool outputs (JSON arrays, logs, diffs, search results,
   * long text) at execution time using relevance scoring, while keeping every
   * original payload recoverable via `get_tool_response`. **Opt-in** — disabled
   * unless `contextPilot: { enabled: true }` (or an equivalent override) is
   * passed explicitly.
   */
  contextPilot?: ContextPilotConfig;
};

// ─── Reasoning + Reflection ──────────────────────────────────────────────────
// Unified naming:
//  - `reasoning.native`     → provider-native reasoning pass-through
//  - `reasoning.reflection` → post-turn textual reflection step
//
// Top-level `enabled`/`level` act as a preset; explicit sub-keys always win.

export type ReasoningLevel = "minimal" | "low" | "medium" | "high";

export type ReflectionCadence = "off" | "every_turn" | "after_tool" | "on_branch" | "initial_then_after_tool";

/** Context passed to reflection lifecycle hooks. */
export type ReflectionHookContext = {
  state: SmartState;
  /** The turn number (state.toolCallCount) at the time of the decision. */
  turn: number;
  trigger: ReflectionCadence;
  ranToolsThisTurn: boolean;
};

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
  /**
   * Hard cap on the number of reflection calls within a single invoke. Once
   * the cap is hit subsequent qualifying turns no longer trigger reflection.
   * Default: unlimited.
   */
  maxPerRun?: number;
  /**
   * Minimum number of tool-bearing turns between reflections. Defaults to 1
   * (reflect on every qualifying turn). Set to 2 to reflect every other tool
   * turn, etc. Independent of `cadence`.
   */
  everyNTurns?: number;
  /**
   * Where to route the reflection text in addition to the reflection record:
   * - "memory" — store as a low-confidence agent-scoped `MemoryFact`.
   * - "plan"   — append the note to the active plan's `lastReflection` field.
   * - "none"   — record only (default).
   */
  feedTo?: "memory" | "plan" | "none";
  /**
   * Custom predicate that overrides the built-in cadence decision. Return true
   * to force a reflection on this turn, false to skip. `maxPerRun`/`everyNTurns`
   * throttles still apply on top of this.
   */
  shouldReflect?: (ctx: ReflectionHookContext) => boolean;
  /**
   * Build the reflection prompt body. Receives the resolved default prompt and
   * the char budget; return the prompt text to send. Overrides `promptTemplate`.
   */
  buildPrompt?: (ctx: ReflectionHookContext & { defaultPrompt: string; maxChars: number }) => string;
  /** Side-effect hook invoked after a reflection record is produced. */
  onReflection?: (record: ReflectionRecord, ctx: ReflectionHookContext) => void;
};

export type NativeReasoningConfig = {
  /** `none` is OFF — a value that gets SENT. See ReasoningEffort in providers/types.ts. */
  effort?: "none" | "minimal" | "low" | "medium" | "high";
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

/**
 * Retention policy for a tool call's ARGUMENTS (the `tool_use` input), applied by
 * the summarizer when it compacts an old exchange.
 *
 * - `keep`   — arguments are never modified. The safe default, and correct for the
 *              overwhelming majority of tools whose arguments are identity/query
 *              data (ids, paths, queries, flags).
 * - `digest` — oversized *string fields only* are replaced with a compact
 *              `{__digest:{chars,sha256,head,executionId}}` descriptor. Every small
 *              scalar (path, id, mode, index) survives verbatim, so the model can
 *              still say what it did — it just cannot re-read the payload. The
 *              original arguments stay in `toolHistory` and are retrievable with
 *              `get_tool_response({executionId, part:"input"})`.
 *
 * Reach for `digest` on content-authoring tools whose arguments carry the payload
 * (file writes, document chunks, generated code/HTML). Those are the calls where
 * archiving the *response* frees nothing, because the bulk was in the request.
 */
export type ToolInputRetentionPolicy = "keep" | "digest";

/**
 * Two-axis context retention for a single tool. Input and output are independent
 * because value density is per-tool: a file-write tool carries its payload in the
 * arguments and returns `{ok:true}`, while a search tool carries a short query and
 * returns the bulk. One axis cannot serve both.
 */
export type ToolRetentionSpec = {
  /** Argument retention. Defaults to `toolResponses.defaultInputPolicy` ("keep"). */
  input?: ToolInputRetentionPolicy;
  /** Response retention. Defaults to `toolResponses.defaultPolicy`. */
  output?: ToolResponseRetentionPolicy;
};

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
   *
   * @deprecated Prefer `retentionByTool`, which also covers argument retention.
   * Still fully honored: it is consulted for the output axis after `retentionByTool`.
   */
  toolResponseRetentionByTool?: Record<string, ToolResponseRetentionPolicy>;
  /**
   * Retention policy applied to a tool call's ARGUMENTS when no per-tool policy is
   * set. Defaults to `"keep"` — argument digesting is strictly opt-in, so enabling
   * it is always a deliberate per-tool (or per-agent) decision.
   */
  defaultInputPolicy?: ToolInputRetentionPolicy;
  /**
   * Two-axis per-tool retention override, keyed by tool name. Wins over the tool
   * definition's own `retention` and over the axis defaults. Either axis may be
   * omitted to fall through to the next source.
   *
   * ```ts
   * retentionByTool: {
   *   create_text_file: { input: "digest", output: "summarize_archive" },
   *   read_skills:      { output: "keep_full" },
   * }
   * ```
   */
  retentionByTool?: Record<string, ToolRetentionSpec>;
  /** Tool names whose responses are never reduced by the summarizer or hard cap. */
  criticalTools?: string[];
  /**
   * Per-field character threshold for argument digesting. A string argument field
   * longer than this is replaced by a digest descriptor; shorter fields, and every
   * non-string scalar, are preserved verbatim. Defaults to 2000.
   */
  maxToolInputFieldChars?: number;
  /**
   * How many leading characters of a digested field to keep as a human/model
   * readable preview. Defaults to 200.
   */
  maxToolInputDigestHeadChars?: number;
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
  contextPilot?: ContextPilotConfig;
};

export type ProfileConfig = {
  limits: Required<AgentLimits>;
  summarization: Required<SmartAgentSummarizationConfig>;
  context: Required<SmartAgentContextConfig> & { budget: Required<SmartAgentBudgetConfig> };
  planning: Required<SmartAgentPlanningConfig>;
  memory: Required<Omit<SmartAgentMemoryConfig, "store">> & { store?: MemoryStore };
  delegation: Required<SmartAgentDelegationConfig>;
  toolResponses: Required<SmartAgentToolResponseConfig>;
  contextPilot: ResolvedContextPilotConfig;
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
  /**
   * ContextPilot: native, deterministic context/token optimization layer.
   * See `AgentOptions.contextPilot` for details. **Opt-in** — disabled by default.
   */
  contextPilot?: ContextPilotConfig;
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
  /** See AgentOptions.tokenCounter. */
  tokenCounter?: (text: string) => number;
  /** See AgentOptions.costEstimator. */
  costEstimator?: AgentOptions["costEstimator"];
  /** See AgentOptions.humanInTheLoop. */
  humanInTheLoop?: HumanInTheLoopOptions;
  /**
   * Progressive capability disclosure. When provided, the agent binds a skill's
   * tools on demand via the built-in open_skill / bind_skill_tools tools, which
   * keeps the bound-tool count per step small. An empty array is a no-op.
   *
   * How the model discovers the catalog is set by `skillPolicy.disclosure`:
   * cheap skill headers in the system prompt (`"catalog"`, the default), or a
   * `search_skills` tool with nothing in the prompt (`"search"`).
   */
  skills?: import("./smart/skills/types.js").Skill[];
  /**
   * Caps, tiering and discovery mode for skills. Defaults to
   * DEFAULT_SKILL_POLICY (i.e. `disclosure: "catalog"`).
   */
  skillPolicy?: import("./smart/skills/types.js").SkillPolicy;
  /**
   * Sub-agents for dynamic problem decomposition. When provided (or when
   * `subagentPolicy.mode` enables ad-hoc spawning), the agent exposes
   * `delegate_to` / `spawn_subagent` / `spawn_subagents_parallel` tools and a
   * `<available_subagents>` catalog in its system prompt. Children inherit the
   * parent model (unless a `SubagentDef.model` override is given), and the
   * parent's event/streaming/cancellation/trace wiring.
   */
  subagents?: import("./smart/subagents/types.js").SubagentDef[];
  /** Caps/modes for sub-agent spawning. Defaults to DEFAULT_SUBAGENT_POLICY. */
  subagentPolicy?: import("./smart/subagents/types.js").SubagentPolicy;
  /**
   * Hooks to intercept/override the SDK's otherwise-static prompt surfaces:
   * the composed system prompt, built-in tool descriptions, and the sub-agent
   * catalog block. See {@link PromptHooks}.
   */
  promptHooks?: PromptHooks;
};

/**
 * Override points for the SDK's built-in (otherwise static) prompt surfaces.
 * Every hook is optional and additive — when omitted the defaults are used.
 */
export type PromptHooks = {
  /**
   * Transform the fully-composed system prompt right before it is sent. Receives
   * the default prompt and returns the prompt to use.
   */
  transformSystemPrompt?: (prompt: string, ctx: { agentName: string }) => string;
  /**
   * Override built-in tool descriptions by tool name (e.g. `delegate_to`,
   * `spawn_subagent`, `spawn_subagents_parallel`, `open_skill`,
   * `ask_user_question`). A string replaces the description; a function receives
   * the default and returns the replacement.
   */
  toolDescriptions?: Record<string, string | ((defaultDescription: string) => string)>;
  /**
   * Override the `<available_subagents>` catalog block. Receives the default
   * block and the active sub-agent definitions.
   */
  subagentCatalog?: (defaultBlock: string, subagents: import("./smart/subagents/types.js").SubagentDef[]) => string;
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
  humanInTheLoop?: HumanInTheLoopRuntimeConfig;
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
  toolDetails?: TraceToolDetails;
};

export type TraceToolDetails = {
  name: string;
  description?: string;
  inputSchema?: any;
  approval?: {
    /** Set only when the tool answers statically. Absent when `conditional`. */
    required?: boolean;
    /**
     * The tool decides per call from its arguments, so no single answer can be
     * recorded here. The actual verdict for each call is on its approval entry.
     */
    conditional?: boolean;
    prompt?: string;
    defaults?: any;
  };
  cache?: {
    enabled: boolean;
    scope?: string;
    ttlMs?: number;
    hasKeyFn?: boolean;
  };
  retry?: {
    maxRetries?: number;
    backoffMs?: number;
    circuitBreakerThreshold?: number;
    hasShouldRetry?: boolean;
  };
  limits?: {
    maxExecutionsPerRun?: number | null;
  };
  source?: string;
  metadata?: Record<string, any>;
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
  toolDetails?: TraceToolDetails;
  execution?: {
    id?: string;
    status?: "success" | "error" | "skipped" | "cached" | string;
    durationMs?: number;
    fromCache?: boolean;
  };
  classification?: ToolResponseClassification;
  retentionPolicy?: ToolResponseRetentionPolicy;
};

export type TraceToolResponseSection = {
  id?: string;
  kind: "tool_response";
  label: string;
  tool: string;
  summary?: string;
  items?: TraceToolResultItem[];
  output?: any;
  toolDetails?: TraceToolDetails;
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

/** One tool of the menu offered to the model on a single call. */
export type TraceToolDefinition = {
  name: string;
  description?: string;
  /** JSON-schema `parameters` object (flat, no $ref wrapper). */
  parameters?: Record<string, any>;
  /** Set when `parameters` was dropped to fit the section size budget. */
  truncated?: boolean;
};

/**
 * The tool MENU bound to one model call ("which tools was the model offered
 * on this turn?"). Rides on the `ai_call` event — never per session, because
 * the menu can change between calls. Matches the Cognipeer console ingest
 * contract for section kind `tool_definitions`.
 */
export type TraceToolDefinitionsSection = {
  id?: string;
  kind: "tool_definitions";
  label: string;
  tools: TraceToolDefinition[];
  /** Set when the tool list itself was truncated to fit the size budget. */
  truncated?: boolean;
};

/**
 * The structured-output contract bound to one model call — the other half of
 * the request that decides the SHAPE of the answer (the tool menu being the
 * first half). Without it a trace cannot distinguish "the model chose to write
 * prose" from "nothing ever asked it for JSON", and any replay of the call
 * (evaluation, prompt optimization) silently runs under a looser contract than
 * production did.
 *
 * Rides on the `ai_call` event, never per session: a run can enforce a schema
 * on its final turn only, and each call records the contract it actually sent.
 */
export type TraceResponseFormatSection = {
  id?: string;
  kind: "response_format";
  label: string;
  /** `json_schema` | `json_object` | `text` — the wire `response_format.type`. */
  type: string;
  /** Which strategy produced it: native `response_format` or the `response` tool. */
  strategy?: "native" | "tool_based";
  /** `json_schema.name` when the provider takes a named schema. */
  schemaName?: string;
  /** `json_schema.strict` — whether the provider enforces the schema. */
  strict?: boolean;
  /** The JSON Schema as sent. Dropped (with `truncated`) when over budget. */
  schema?: Record<string, any>;
  /** Set when `schema` was dropped to fit the section size budget. */
  truncated?: boolean;
};

export type TraceDataSection =
  | TraceMessageSection
  | TraceToolCallSection
  | TraceToolResultSection
  | TraceToolResponseSection
  | TraceSummarySection
  | TraceMetadataSection
  | TraceToolDefinitionsSection
  | TraceResponseFormatSection;

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
  /**
   * Reasoning tokens billed inside `outputTokens` (a SUBSET of it, matching
   * OpenAI's `completion_tokens_details.reasoning_tokens`). Recorded because
   * on a reasoning model they are routinely most of the output bill while
   * being invisible in the response text — a spend investigation that only
   * sees `outputTokens` cannot explain where the money went.
   */
  reasoningTokens?: number;
  /**
   * Why the model stopped: `stop` | `tool_calls` | `length` | `content_filter`
   * | `error`. `length` is the single most common explanation for a truncated
   * or unparseable structured response, and without it that failure is
   * indistinguishable from a model that simply answered badly.
   */
  finishReason?: string;
  requestBytes?: number;
  responseBytes?: number;
  model?: string;
  provider?: string;
  toolDetails?: TraceToolDetails;
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
  /** Arbitrary key-value tags from `TracingConfig.metadata`, forwarded as-is for downstream attribution/reporting. */
  metadata?: Record<string, string>;
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
  /** Caller-supplied agent name override (from TracingConfig.agentName). */
  configAgentName?: string;
  /** Caller-supplied attribution tags (from TracingConfig.metadata). */
  configMetadata?: Record<string, string>;
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
    /** Set when ContextPilot compressed this tool's output before it entered the transcript. */
    contextPilot?: ContextPilotCompressionStats;
  }>;
  toolCache?: Record<string, any>;
  toolCallCount?: number;
  metadata?: Record<string, any>;
  ctx?: Record<string, any>;
  pendingApprovals?: PendingToolApproval[];
  pendingUserQuestions?: PendingUserQuestion[];
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
  plan?: { version: number; steps: PlanStepRecord[]; lastUpdated?: string; adherenceScore?: number; lastReflection?: string } | null;
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
  source: "manage_plan" | "manage_todo_list" | "system";
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

// ─── Ask-User (Human-in-the-Loop questions) ──────────────────────────────────
// Lets the model pause the agent and surface a structured prompt back to the
// host application. Mirrors the Claude Code "AskUserQuestion" UX: one or more
// related questions with multi-choice options and (optionally) free-text.

export type UserQuestionOption = {
  /** Label shown to the user. */
  label: string;
  /** Value returned in the resolution. Defaults to `label` when omitted. */
  value?: string;
  /** Optional helper text rendered alongside the option. */
  description?: string;
  /** Optional code / ASCII preview rendered when the option is focused. */
  preview?: string;
};

export type UserQuestionItem = {
  /** The full question text shown to the user. */
  question: string;
  /** Short label (chip / tag) displayed alongside the question. */
  header?: string;
  /** When true the user may pick multiple options. Default: false. */
  multiSelect?: boolean;
  /** Placeholder shown for the free-text input (when enabled globally). */
  placeholder?: string;
  /** Predefined options; omit for a pure free-text question. */
  options?: UserQuestionOption[];
  /** When true the user must answer this item. Default: true. */
  required?: boolean;
};

export type UserQuestionStatus = "pending" | "answered" | "cancelled" | "executed";

export type UserQuestionAnswer = {
  /** Selected option values. Single-select questions report exactly one entry. */
  values: string[];
  /** Populated when the user typed a custom answer (only when free-text is enabled). */
  freeText?: string;
  /** Optional reviewer notes. */
  notes?: string;
};

/** Keyed by the question text (or `header`, if both questions share text). */
export type UserQuestionAnswerSet = Record<string, UserQuestionAnswer>;

export type PendingUserQuestion = {
  id: string;
  toolCallId: string;
  toolName: "ask_user_question";
  questions: UserQuestionItem[];
  status: UserQuestionStatus;
  requestedAt: string;
  answeredAt?: string;
  answeredBy?: string;
  answers?: UserQuestionAnswerSet;
  cancelled?: boolean;
  notes?: string;
  /** Snapshot of the global free-text flag at request time, for UI rendering. */
  allowFreeText?: boolean;
  metadata?: Record<string, any>;
};

export type UserQuestionResolution = {
  id: string;
  answers?: UserQuestionAnswerSet;
  answeredBy?: string;
  notes?: string;
  /** When true the tool call is reported back as cancelled / unanswered. */
  cancelled?: boolean;
};

export type UserQuestionEvent = {
  type: "user_question";
  status: "pending" | "answered" | "cancelled";
  id: string;
  toolCallId: string;
  questions?: UserQuestionItem[];
  answers?: UserQuestionAnswerSet;
  answeredBy?: string;
  allowFreeText?: boolean;
};

// Runtime configuration carried on AgentRuntimeConfig / ctx so the tool and
// the resolver share a single source of truth.
export type HumanInTheLoopAskUserConfig = {
  enabled: boolean;
  allowFreeText: boolean;
  promptOverride?: string;
};

export type HumanInTheLoopRuntimeConfig = {
  askUser?: HumanInTheLoopAskUserConfig;
};

export type HumanInTheLoopOptions = {
  askUser?: boolean | {
    /** Allow the user to type a custom "Other" answer. Default: true. */
    allowFreeText?: boolean;
    /** Override the built-in tool description. */
    promptOverride?: string;
    /** Convenience: subscribe to user_question events without setting up onEvent. */
    onQuestion?: (event: UserQuestionEvent) => void;
  };
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

export type SubagentEvent = {
  type: "subagent";
  /** Lifecycle phase of a delegated sub-agent run. */
  phase: "start" | "result" | "error" | "paused";
  /** Sub-agent name (registry) or role (ad-hoc). */
  name: string;
  /** Unique per-spawn id. */
  id: string;
  mode: "registry" | "adhoc";
  /** Parent tool_call id that owns this sub-agent. */
  parentToolCallId?: string;
  /** True when spawned inside `spawn_subagents_parallel`. */
  parallel?: boolean;
  /** Task input (on `start`). */
  input?: string;
  /** Final content (on `result`). */
  content?: string;
  error?: { message: string };
  durationMs?: number;
};

/**
 * Origin-stamp fields the runtime attaches to any event that was forwarded from
 * a delegated child. Sub-agent children stamp `subagentId` / `subagentName`;
 * `asTool` delegated children stamp `delegatedTo`. All optional and absent on a
 * top-level agent's own events.
 */
export type DelegationEventStamp = {
  /** Per-spawn id of the sub-agent that produced this forwarded event. */
  subagentId?: string;
  /** Sub-agent name / role that produced this forwarded event. */
  subagentName?: string;
  /** Name of the `asTool` child agent this forwarded event came from. */
  delegatedTo?: string;
};

export type SmartAgentEvent = (
  | ToolCallEvent
  | ToolApprovalEvent
  | UserQuestionEvent
  | PlanEvent
  | SummarizationEvent
  | FinalAnswerEvent
  | MetadataEvent
  | HandoffEvent
  | GuardrailEvent
  | ProgressEvent
  | StreamEvent
  | CancelledEvent
  | SubagentEvent
  | ReflectionEvent
) & DelegationEventStamp;

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
  /**
   * Keys of `skills` to open deterministically at the start of this invoke,
   * before the first model call. Each one is opened through the real
   * `open_skill` tool and written into the transcript as an assistant tool call
   * plus its tool result, so the model starts the run with the skill's guidance
   * and tools already bound instead of having to discover them. Unknown or
   * unavailable keys are skipped. Ignored when the agent has no `skills`.
   */
  preopenedSkills?: string[];
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
  resolveUserQuestion: (state: SmartState, resolution: UserQuestionResolution) => SmartState;
  // Convert this agent into a tool usable by another agent. Accepts optional overrides.
  asTool: (opts: { toolName: string; description?: string; inputDescription?: string } ) => ToolInterface<any, any, any>;
  // Create a handoff descriptor so another agent can switch control to this one mid-conversation
  asHandoff: (opts: { toolName?: string; description?: string; schema?: ZodSchema<any>; }) => HandoffDescriptor<TOutput>;
  __runtime: AgentRuntimeConfig;
};

// Smart Agent instance (same as AgentInstance for now, but semantically separate)
export type SmartAgentInstance<TOutput = unknown> = AgentInstance<TOutput>;
