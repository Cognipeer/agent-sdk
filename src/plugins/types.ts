/**
 * Plugin layer — type surface.
 *
 * This module is TYPE-ONLY on purpose. `src/types.ts` imports `AgentPlugin`
 * from here while this file imports most of its payload types from there; a
 * runtime export in either direction would create a real module cycle. Keeping
 * everything here erasable (`import type` / `export type`) means the cycle
 * disappears at compile time.
 *
 * Three kinds of extension live in a plugin:
 *   - hooks         intercept   many run, chained, decisions merge
 *   - contributions add         many run, results accumulate
 *   - slots         replace     exactly one owner, conflict is a hard error
 */

import type {
  AgentInvokeResult,
  ContentPart,
  AgentSnapshot,
  AIMessage,
  ConversationGuardrail,
  GuardrailIncident,
  InvokeConfig,
  MemoryStore,
  Message,
  PendingToolApproval,
  PendingUserQuestion,
  SmartAgentEvent,
  SmartState,
  StructuredSummary,
  SummarizationMode,
  ToolApprovalResolution,
  ToolInterface,
} from "../types.js";
import type { Skill } from "../smart/skills/types.js";
import type { MediaAttachment } from "../utils/content.js";

export type MaybePromise<T> = T | Promise<T>;

/** How a plugin's failure is interpreted. `closed` turns an error into a deny. */
export type PluginFailureMode = "open" | "closed";

/** Merged verdict of a gate hook. Escalation order: allow &lt; ask &lt; deny. */
export type HookDecision = "allow" | "deny" | "ask";

export type PluginLogger = {
  debug(...args: unknown[]): void;
  warn(...args: unknown[]): void;
  error(...args: unknown[]): void;
};

// ─── Contexts ────────────────────────────────────────────────────────────────

/**
 * Passed to every hook and slot call. Scoped per plugin: `store` is private to
 * the plugin that received it and lives for exactly one run.
 */
export type HookContext = {
  /** Stable id for this invoke, always present. */
  runId: string;
  /**
   * The run's trace id, for correlating a decision with its timeline.
   *
   * Undefined when tracing is off, and also for hooks that run BEFORE the first
   * model call on a smart agent — the trace session is created inside the first
   * base leg, while `sessionStart` and `userPromptSubmit` run ahead of it.
   * `runId` is the identifier that is always available; treat this as an
   * additional join key, not a replacement.
   */
  traceId?: string;
  agentName?: string;
  /** Name of the hook currently executing — handy for shared handlers. */
  hookName: string;
  /**
   * Live agent state. Declared readonly because mutation must go through the
   * hook's return value; an in-place write is invisible to the composition
   * rules and makes execution order unobservable.
   */
  state: Readonly<SmartState>;
  /** Per-plugin, per-run scratch space. Never serialized into a snapshot. */
  store: Record<string, unknown>;
  /** Emit an event to the host's `onEvent`. */
  emit: (event: SmartAgentEvent) => void;
  logger: PluginLogger;
  /** The run's cancellation signal — forward it to outbound HTTP calls. */
  signal?: AbortSignal;
  /** Delegation depth. 0 is the root agent; children increment it. */
  depth: number;
};

/** Passed to `setup`, `tools`, `systemPrompt` and `wrapModel`. */
export type PluginSetupContext = {
  agentName?: string;
  agentVersion?: string;
  /** The agent's model, before any `wrapModel` in this plugin's own chain. */
  model: unknown;
  logger: PluginLogger;
  /** Register a teardown callback instead of returning one from `setup`. */
  onDispose: (fn: () => MaybePromise<void>) => void;
};

// ─── Hook map ────────────────────────────────────────────────────────────────

/**
 * The single source of truth for hook payloads. Every `output` field is
 * optional so that adding capability later is not a breaking change, and
 * returning `undefined` always means "nothing changed".
 */
export interface HookMap {
  /** Run is starting. Fires once per `invoke()`, including on resume. */
  sessionStart: {
    input: {
      messages: Message[];
      /** True when this invoke continues a paused/snapshotted run. */
      resumed: boolean;
      config?: InvokeConfig;
    };
    output: {
      /** Replace the starting transcript (e.g. hydrate from a conversation store). */
      messages?: Message[];
      /** Appended to the composed system prompt for this run. */
      systemPromptAppend?: string;
      metadata?: Record<string, unknown>;
    };
  };

  /**
   * A new user message is entering the transcript. Input-side guardrail point.
   *
   * A user turn is not always a string: it can carry images, audio, video or
   * files alongside its text. `text` is the concatenation of the text parts,
   * `content` is the whole thing, and `attachments` is the non-text half
   * normalized for policy code.
   */
  userPromptSubmit: {
    input: {
      /** Concatenated text parts. Empty string for a media-only turn. */
      text: string;
      /** The full content, string or parts. Return `content` to rewrite it exactly. */
      content: string | ContentPart[];
      /** Every non-text part, normalized across the unified and legacy shapes. */
      attachments: MediaAttachment[];
      message: Message;
    };
    output: {
      /**
       * Rewritten text — masking, normalization, injection stripping. Written
       * back into the text parts, never over the whole content: assigning a
       * string over a multi-part message is how an attached image disappears.
       * With several text parts the replacement lands in the first and the rest
       * are dropped, because the hook only ever saw their concatenation —
       * return `content` when that matters.
       */
      text?: string;
      /** Full control over the parts: reorder, drop an attachment, rewrite per part. */
      content?: string | ContentPart[];
      /** Extra system-level context appended for this turn only. */
      additionalContext?: string;
      decision?: "allow" | "deny";
      reason?: string;
      metadata?: Record<string, unknown>;
    };
  };

  /** Immediately before every model call, including retries and finalization. */
  preModelCall: {
    input: {
      messages: Message[];
      tools: ToolInterface[];
      /** Provider invoke options: signal, response_format, reasoning, … */
      params: Record<string, unknown>;
      model: unknown;
      /** 1-based loop iteration. */
      iteration: number;
    };
    output: {
      messages?: Message[];
      /** Narrow the tool menu for this call only. */
      tools?: ToolInterface[];
      /** Shallow-merged into the provider options — never replaces them wholesale. */
      params?: Record<string, unknown>;
      /** Skip the provider entirely and use this as the assistant turn. */
      shortCircuit?: AIMessage;
      decision?: "allow" | "deny";
      reason?: string;
      metadata?: Record<string, unknown>;
    };
  };

  /** The assistant turn came back, before the loop decides what to do with it. */
  postModelCall: {
    input: {
      message: AIMessage;
      usage?: Record<string, unknown>;
      durationMs: number;
      iteration: number;
      /** True when the message was produced by a `preModelCall` short-circuit. */
      shortCircuited: boolean;
    };
    output: {
      message?: AIMessage;
      decision?: "allow" | "deny";
      reason?: string;
      /** Re-run this model call. Bounded by `maxModelRetries`. */
      retry?: boolean;
      metadata?: Record<string, unknown>;
    };
  };

  /** After argument validation, before the approval gate. */
  preToolUse: {
    input: {
      toolName: string;
      toolCallId: string;
      args: unknown;
      tool: ToolInterface;
      /** Tool executions already recorded in this run. */
      executionCount: number;
    };
    output: {
      /** Corrected or constrained arguments. Re-validated against the schema. */
      args?: unknown;
      /** `ask` escalates to human approval; it can never be downgraded to `allow`. */
      decision?: HookDecision;
      /** Surfaced to the model as the tool result on `deny`. */
      reason?: string;
      /** Prompt text when this hook raised the approval. */
      approvalPrompt?: string;
      /** Skip execution and use this as the tool's output (cache, mock, stub). */
      result?: unknown;
      metadata?: Record<string, unknown>;
    };
  };

  /** Raw tool output, before ContextPilot compression and the hard cap. */
  postToolUse: {
    input: {
      toolName: string;
      toolCallId: string;
      args: unknown;
      output: unknown;
      error?: Error;
      durationMs: number;
      executionId: string;
    };
    output: {
      /** Rewritten output — redaction, normalization, schema coercion. */
      output?: unknown;
      decision?: "allow" | "deny";
      reason?: string;
      metadata?: Record<string, unknown>;
    };
  };

  /** Before the summarizer runs. */
  preCompact: {
    input: {
      reason: "token_pressure" | "manual";
      messages: Message[];
      tokenCount: number;
      threshold: number;
    };
    output: {
      /** Replace the candidate set (e.g. pin messages that must survive). */
      messages?: Message[];
      /** Skip compaction for this pass. */
      skip?: boolean;
      metadata?: Record<string, unknown>;
    };
  };

  /** After a summary was produced and applied. */
  postCompact: {
    input: {
      summary: StructuredSummary;
      tokensBefore: number;
      tokensAfter: number;
      /** Name of the strategy that produced it — `"builtin"` when no slot is filled. */
      strategy: string;
    };
    output: void;
  };

  /** The run produced a final answer and is about to return it. */
  preFinalAnswer: {
    input: { content: string; output?: unknown; message?: AIMessage };
    output: {
      content?: string;
      decision?: "allow" | "deny";
      reason?: string;
      /** Keep looping with this instruction instead of returning. Bounded. */
      continueWith?: string;
      metadata?: Record<string, unknown>;
    };
  };

  /** A sub-agent task is about to start. */
  subagentStart: {
    input: { name: string; task: string; depth: number };
    output: { task?: string; decision?: "allow" | "deny"; reason?: string };
  };

  /** A sub-agent finished and its result is returning to the parent. */
  subagentStop: {
    input: { name: string; result: unknown; depth: number; durationMs?: number };
    output: void;
  };

  /** Something needs a human, or a limit was hit. Observation only. */
  notification: {
    input: {
      kind: "approval" | "user_question" | "limit" | "error";
      detail: unknown;
    };
    output: void;
  };

  /** The run ended, on every exit path. */
  sessionEnd: {
    input: {
      status: "success" | "error" | "paused" | "cancelled";
      result?: AgentInvokeResult;
      error?: Error;
      usage?: SmartState["usage"];
      durationMs: number;
    };
    output: void;
  };
}

export type HookName = keyof HookMap;

export type HookHandler<K extends HookName> = (
  input: HookMap[K]["input"],
  ctx: HookContext,
) => MaybePromise<HookMap[K]["output"] | void>;

/** Hooks declared inline on the agent, or inside a plugin. */
export type HookRegistrations = {
  [K in HookName]?: HookHandler<K> | Array<HookHandler<K>>;
};

/** What a gate hook chain produced, after composition. */
export type GateResult<K extends HookName> = {
  decision: HookDecision;
  reason?: string;
  /** Plugin that produced the blocking decision, when there is one. */
  deniedBy?: string;
  /** The payload after every handler's mutations were applied in order. */
  input: HookMap[K]["input"];
  /** First short-circuit value offered, if any. */
  shortCircuit?: unknown;
  /** Whether any handler mutated the payload. */
  mutated: boolean;
  /**
   * Which plugins mutated it, in the order they ran.
   *
   * Plugin-level, not span-level: a handler returns a rewritten payload rather
   * than an op list, so "which rule changed this span" is not recoverable —
   * but "which plugin changed this" is, and that is the question an audit
   * trail is usually asked. A plugin that needs finer provenance reports it
   * through `metadata` (piiRedaction emits the entity types it matched).
   */
  mutatedBy: string[];
  /** Accumulated non-payload output (systemPromptAppend, additionalContext, …). */
  collected: Record<string, unknown[]>;
  /** Boolean flags OR-ed across handlers (skip, retry, …). */
  flags: Record<string, boolean>;
  /** Merged `metadata` objects from every handler. */
  metadata?: Record<string, unknown>;
};

// ─── Slots ───────────────────────────────────────────────────────────────────

export type SummarizerInput = {
  /**
   * The messages the SDK selected as compressable. Selection is not negotiable:
   * protected tool_call ids and the recency window are correctness-critical and
   * stay on the SDK side.
   */
  messages: Message[];
  /** Prior summary for incremental mode. */
  previousSummary?: StructuredSummary;
  /** Latest user request, so the summary can be query-focused. */
  query: string;
  budget: { targetTokens: number; maxTokens: number };
  /** The agent's model. A strategy is free to use a cheaper one. */
  model: unknown;
  mode: SummarizationMode;
};

export type SummarizerResult = {
  summary: StructuredSummary;
  /** Provider usage, so the SDK can bill the compaction call. */
  usage?: unknown;
  /** Recovery references for archived tool payloads. */
  archived?: Array<{ executionId: string; ref: string }>;
};

export type SummarizerStrategy = {
  name: string;
  /** Returning `null` means "could not compress" — same contract as the built-in `{}`. */
  compress(input: SummarizerInput, ctx: HookContext): MaybePromise<SummarizerResult | null>;
};

export type ConversationStore = {
  load(threadId: string): MaybePromise<Message[] | null | undefined>;
  append(threadId: string, messages: Message[]): MaybePromise<void>;
  clear?(threadId: string): MaybePromise<void>;
};

export type CheckpointStore = {
  save(id: string, snapshot: AgentSnapshot): MaybePromise<void>;
  load(id: string): MaybePromise<AgentSnapshot | null | undefined>;
  list?(prefix?: string): MaybePromise<string[]>;
  remove?(id: string): MaybePromise<void>;
};

export type ApprovalTransport = {
  /**
   * Deliver a pending approval to a human and wait for the answer. Returning
   * `null` leaves the run paused for the host to resolve the usual way.
   */
  request(
    pending: PendingToolApproval,
    ctx: HookContext,
  ): MaybePromise<ToolApprovalResolution | null>;
  /** Optional: same treatment for `ask_user_question`. */
  requestUserInput?(
    pending: PendingUserQuestion,
    ctx: HookContext,
  ): MaybePromise<unknown | null>;
};

export type SkillSource = {
  name: string;
  list(ctx: PluginSetupContext): MaybePromise<Skill[]>;
};

export type PromptSource = {
  name: string;
  /** Resolve a named, versioned prompt. `null` falls through to the default. */
  resolve(key: string, ctx: HookContext): MaybePromise<string | null | undefined>;
};

export type ContextBuilder = {
  name: string;
  build(
    input: { state: SmartState; defaultMessages: Message[] },
    ctx: HookContext,
  ): MaybePromise<Message[]>;
};

export type CostEstimator = (args: {
  modelName?: string;
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens?: number;
  reasoningTokens?: number;
}) => number;

/**
 * Slots replace an SDK default. Exactly one plugin may fill each one; two
 * claimants is a construction-time error, never a silent last-one-wins.
 */
export type PluginProvides = {
  summarizer?: SummarizerStrategy;
  tokenCounter?: (text: string) => number;
  costEstimator?: CostEstimator;
  memoryStore?: MemoryStore;
  conversationStore?: ConversationStore;
  checkpointStore?: CheckpointStore;
  approvalTransport?: ApprovalTransport;
  skillSource?: SkillSource;
  promptSource?: PromptSource;
  contextBuilder?: ContextBuilder;
};

export type SlotName = keyof PluginProvides;

// ─── Plugin ──────────────────────────────────────────────────────────────────

export type AgentPlugin = {
  /** Unique within one agent. A duplicate is a construction-time error. */
  name: string;
  version?: string;
  description?: string;

  /** Execution order; lower runs first. Default 100. */
  priority?: number;
  /** How this plugin's own errors and timeouts are interpreted. Default "open". */
  failureMode?: PluginFailureMode;
  /** Per-handler timeout in ms. Default 10_000. */
  timeoutMs?: number;
  /**
   * Whether children (sub-agents, `asTool` delegates) inherit this plugin.
   * Default true — a policy a delegation can shed is not a policy.
   */
  inheritToSubagents?: boolean;

  /** One-time construction. May return a disposer. */
  setup?: (ctx: PluginSetupContext) => MaybePromise<void | (() => MaybePromise<void>)>;
  dispose?: () => MaybePromise<void>;

  hooks?: HookRegistrations;

  /**
   * Whether this plugin's `preToolUse` handler can return `decision: "ask"`.
   * Defaults to true for any plugin that registers `preToolUse`.
   *
   * It exists for scheduling, not for policy: a call that may pause for a human
   * has to run in the sequential group, because the parallel fan-out has already
   * started its siblings by the time a pause is raised. Declaring `false` on a
   * pure redaction/audit hook keeps the tool batch parallel.
   */
  mayRequireApproval?: boolean;

  // ── Contributions ──────────────────────────────────────────────────────────
  tools?: ToolInterface[] | ((ctx: PluginSetupContext) => MaybePromise<ToolInterface[]>);
  systemPrompt?: string | ((current: string, ctx: PluginSetupContext) => string);
  toolDescriptions?: Record<string, string | ((defaultDescription: string) => string)>;
  wrapModel?: (model: unknown, ctx: PluginSetupContext) => unknown;

  // ── Slots ──────────────────────────────────────────────────────────────────
  provides?: PluginProvides;

  /** Bridge for v1 guardrails carried inside a plugin. */
  guardrails?: ConversationGuardrail[];

  /** Set by the SDK on internally-generated bridge plugins. */
  readonly __internal?: boolean;
};

/** Everything the plugin layer contributes, resolved once per agent. */
export type PluginContributions = {
  tools: ToolInterface[];
  toolDescriptions: Record<string, string | ((defaultDescription: string) => string)>;
  guardrails: ConversationGuardrail[];
  /** Applied in priority order, before any legacy `promptHooks.transformSystemPrompt`. */
  applySystemPrompt: (base: string) => string;
  /** Applied outermost-last, so the highest-priority plugin wraps first. */
  applyModelWrappers: (model: unknown) => unknown;
};

/** Emitted so the hook layer itself is observable. */
export type PluginEvent = {
  type: "plugin";
  plugin: string;
  hook: string;
  phase: "success" | "error" | "timeout";
  decision?: HookDecision;
  mutated?: boolean;
  shortCircuited?: boolean;
  reason?: string;
  durationMs?: number;
  error?: { message: string };
};

/**
 * A hook outcome worth putting on the trace timeline. Only material outcomes
 * are recorded — a decision that was not `allow`, a payload mutation, a
 * short-circuit, or a failure. Per-handler noise stays on the `plugin` event
 * stream, where it costs nothing.
 */
export type PluginTraceRecord = {
  plugin: string;
  hook: HookName;
  /** Plugins that had already rewritten this payload when the record was made. */
  mutatedBy?: string[];
  /**
   * `skipped` for a policy deny and for a fail-open error: neither is a system
   * failure, and `error` would flip the whole trace session's status for a run
   * that behaved exactly as configured. `error` is reserved for a fail-closed
   * failure, which does abort the run.
   */
  status: "success" | "error" | "skipped";
  decision?: HookDecision;
  mutated?: boolean;
  shortCircuited?: boolean;
  reason?: string;
  durationMs?: number;
  error?: { message: string };
};

export type PluginHostOptions = {
  /** Emit a `plugin` event for every handler, not just the interesting ones. */
  debug?: boolean;
  logger?: PluginLogger;
  /** Cap on `postModelCall.retry`. Default 2. */
  maxModelRetries?: number;
  /** Cap on `preFinalAnswer.continueWith`. Default 2. */
  maxContinuations?: number;
};

export type GuardrailIncidentLike = GuardrailIncident;
