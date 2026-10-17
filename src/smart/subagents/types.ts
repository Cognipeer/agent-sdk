import type { ZodSchema } from "zod";
import type { AgentLimits, AgentState, ChildContextPolicy, Message, ToolInterface } from "../../types.js";

/**
 * Sub-agent primitive — dynamic problem-solving by delegating self-contained
 * subtasks to focused child agents.
 *
 * Two complementary disclosure modes (hybrid by default):
 *  - **Registry** — predefined, named sub-agents (`delegate_to(name, input)`).
 *  - **Ad-hoc**   — the orchestrator writes a role + prompt + tool subset at
 *    runtime (`spawn_subagent({ role, prompt, input, tools })`).
 *  - **Parallel** — fan out independent subtasks concurrently
 *    (`spawn_subagents_parallel({ tasks })`).
 *
 * The primitive reuses the existing delegation guards (depth / child-call
 * budget / context policy) and forwards events, streaming, cancellation and
 * tracing from the parent run into each child. Model-agnostic: a child uses its
 * own `model` override when given, otherwise the parent's model.
 */

/** A predefined sub-agent the orchestrator can invoke by name. */
export type SubagentDef = {
  /** Stable id used by `delegate_to`. */
  name: string;
  /** Human-friendly title (defaults to `name`). */
  title?: string;
  /** One-line "what + when to use" shown in the `<available_subagents>` catalog. */
  header: string;
  /**
   * Role / system prompt for the child agent. This is fully under your control
   * — it is the per-sub-agent prompt-override surface.
   */
  systemPrompt?: string;
  /**
   * Tool surface for the child:
   *  - `ToolInterface[]` — explicit tools.
   *  - `string[]`        — names resolved against the PARENT's live tool set.
   *  - function          — built lazily at spawn time.
   * When omitted the child runs tool-free (pure reasoning).
   */
  tools?: ToolInterface[] | string[] | (() => ToolInterface[] | Promise<ToolInterface[]>);
  /** Optional model override. Defaults to the parent agent's model (model-agnostic). */
  model?: any;
  /** Optional JSON output contract for the child. */
  outputSchema?: ZodSchema<any>;
  /** Optional per-child limits override. */
  limits?: AgentLimits;
  /** Override the parent policy's context-seeding behaviour for this sub-agent. */
  childContextPolicy?: ChildContextPolicy;
  /** Gate: hide this sub-agent from the catalog when it returns false. */
  isAvailable?: () => boolean | Promise<boolean>;
  /** Free-form metadata surfaced on `subagent` events. */
  metadata?: Record<string, any>;
};

export type SubagentMode = "off" | "registry_only" | "registry_and_adhoc";

export type SubagentPolicy = {
  /** `registry_and_adhoc` (default) enables both named + ad-hoc spawning. */
  mode: SubagentMode;
  /** Max nesting depth. Shares the delegation depth counter. */
  maxDepth: number;
  /** Total spawn budget per run (across delegate_to + spawn + parallel). */
  maxChildCalls: number;
  /** Fan-out width for `spawn_subagents_parallel`. */
  maxParallel: number;
  /** Default context seeding for children. Overridable per-`SubagentDef`. */
  childContextPolicy: ChildContextPolicy;
  /** Whether ad-hoc spawns may reference the parent's tools by name. */
  allowAdhocTools: boolean;
  /**
   * Forward the children's streamed text to the parent's `onStream` / `stream`
   * events. Off by default: a host that appends `chunk.text` would print every
   * child's words as if they were the parent's answer. When on, each forwarded
   * chunk carries `subagentName` / `subagentId`.
   */
  streamChildren?: boolean;
};

export const DEFAULT_SUBAGENT_POLICY: SubagentPolicy = {
  mode: "registry_and_adhoc",
  maxDepth: 2,
  maxChildCalls: 8,
  maxParallel: 4,
  childContextPolicy: "scoped",
  allowAdhocTools: true,
};

/**
 * How a child run ended.
 *  - `ok`           — finished and produced an answer.
 *  - `incomplete`   — stopped early (a limit, the tool-call cap, no answer): `content` is partial.
 *  - `blocked`      — refused by policy (a `subagentStart` gate or an output guardrail).
 *  - `needs_input`  — wanted a human (parallel fan-out cannot ask).
 *  - `cancelled`    — the run was cancelled while the child was working.
 *  - `error`        — threw, or its structured output failed.
 */
export type SubagentStatus = "ok" | "incomplete" | "blocked" | "needs_input" | "cancelled" | "error";

/** Model calls a child made, in the parent's `state.usage` shape. */
export type SubagentUsage = {
  perRequest: NonNullable<AgentState["usage"]>["perRequest"];
  totals: NonNullable<AgentState["usage"]>["totals"];
};

/**
 * Result of a single sub-agent run. The model sees a projection of it
 * (`toModelResult`: no `input`, `usage` or `durationMs`); hosts get the whole
 * thing on `subagent` events, `subagentStop` observers and the registry.
 */
export type SubagentResult = {
  /** Sub-agent name (registry) or role (ad-hoc). */
  name: string;
  mode: "registry" | "adhoc";
  status: SubagentStatus;
  /** The input the sub-agent was tasked with. Not echoed to the model. */
  input?: string;
  /** Final assistant content from the child (partial unless `status` is `ok`). */
  content?: string;
  /** Parsed structured output, when the child had an `outputSchema`. */
  output?: any;
  /** Latest child summary, when summarization fired. */
  summary?: string;
  /** Set when the child produced no usable result (`error`, `blocked`, `needs_input`). */
  error?: string;
  /** Why a result is partial or cancelled. */
  note?: string;
  /**
   * The model calls this run made. Already merged into the parent's
   * `state.usage` (each entry tagged `subagent`), so a parent budget sees them.
   */
  usage?: SubagentUsage;
  durationMs?: number;
};

/**
 * Mutable per-invoke registry. Records spawn budget usage and completed
 * results. Mirrors the SkillRegistryRef pattern. The durable child-pause state
 * (for HITL resume) lives in `state.ctx.__subagentPending`, NOT here, so it
 * survives the parent invoke boundary.
 */
export type SubagentRegistryRef = {
  /** Cumulative spawns this run (delegate + adhoc + each parallel child). */
  spawnedCount: number;
  /** Completed results, in completion order. */
  results: SubagentResult[];
};

export function createSubagentRegistryRef(): SubagentRegistryRef {
  return { spawnedCount: 0, results: [] };
}

/**
 * Durable per-tool-call pause record, stored in `state.ctx.__subagentPending`
 * so a child that paused for human input (approval / ask-user) can be resumed
 * after the host answers at the parent level. Only data — no functions — so it
 * survives snapshot serialization for the in-memory resume path.
 */
export type SubagentPendingRecord = {
  /** Parent tool_call id that owns this paused child. */
  parentToolCallId: string;
  /** Sub-agent name / role. */
  name: string;
  mode: "registry" | "adhoc";
  /** Ad-hoc spec (role/prompt/tools/input) to rebuild the child agent. */
  adhoc?: { role: string; prompt?: string; toolNames?: string[]; outputContract?: string };
  /** The task input the child was running. */
  input: string;
  /** Serializable child SmartState (agent omitted) to restore + resume. */
  childState: any;
  /** Maps the child's pending approval/question id -> parent-surfaced id. */
  pendingKind: "approval" | "user_question";
  pendingId: string;
};

export type SubagentToolNames = {
  delegate: string;
  spawn: string;
  parallel: string;
};

export const DEFAULT_SUBAGENT_TOOL_NAMES: SubagentToolNames = {
  delegate: "delegate_to",
  spawn: "spawn_subagent",
  parallel: "spawn_subagents_parallel",
};

/** Re-export for convenience in the tool/registry modules. */
export type { Message };
