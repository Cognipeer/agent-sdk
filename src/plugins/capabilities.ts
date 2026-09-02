/**
 * What this build actually implements.
 *
 * A policy configured as `mode: "enforce"` whose hook is never called is worse
 * than no policy: the console shows a control that does not exist. A host
 * cannot infer that from the type surface, because a declared hook and a wired
 * one look identical to TypeScript — so the runtime states it.
 *
 * This table is maintained BY HAND alongside the wiring. That is deliberate:
 * deriving it from the registry would only prove that a handler was registered,
 * not that any call site raises it, which is precisely the failure it exists to
 * make visible.
 */

import type { HookName, SlotName } from "./types.js";

/**
 * Bumped when the hook contract changes shape in a way a host must notice —
 * a hook gains or loses a call site, a payload field changes meaning, a slot
 * starts or stops being consumed. Independent of the package version.
 */
export const HOOK_CONTRACT_VERSION = 1;

export type CapabilityStatus = {
  /** True when a call site in the runtime actually raises this. */
  implemented: boolean;
  /** Why not, or what the caveat is. */
  notes?: string;
};

export type SdkCapabilities = {
  hookContractVersion: number;
  hooks: Record<HookName, CapabilityStatus>;
  slots: Record<SlotName, CapabilityStatus>;
  features: Record<string, CapabilityStatus>;
};

const HOOKS: Record<HookName, CapabilityStatus> = {
  sessionStart: { implemented: true },
  userPromptSubmit: {
    implemented: true,
    notes: "Fires once per run whenever the transcript tail is a NEW user turn — including a turn appended to a state that was restored from a snapshot. Skipped on a genuine resume, where the tail is a tool result rather than a user message.",
  },
  preModelCall: {
    implemented: true,
    notes: "Every provider call, including the post-loop structured-output finalize. Can mutate wire messages, narrow the tool menu, merge invoke params, or short-circuit.",
  },
  postModelCall: { implemented: true, notes: "Mutation replaces the assistant turn; it never appends a second one." },
  preToolUse: {
    implemented: true,
    notes: "After argument validation, before the approval gate. `ask` composes with the tool's own needsApproval and survives resume.",
  },
  postToolUse: {
    implemented: true,
    notes: "Raw output, before compression and the hard cap. Also fires on a tool ERROR, on a preToolUse `result` short-circuit and on a tool-cache hit (`input.source` says which). Does NOT fire for a call that parks the run.",
  },
  preCompact: { implemented: true },
  postCompact: { implemented: true },
  preFinalAnswer: {
    implemented: true,
    notes: "`continueWith` is accepted by the type but NOT implemented; it is reported and ignored.",
  },
  subagentStart: { implemented: true, notes: "Fresh spawns only, never on a human-in-the-loop resume." },
  subagentStop: { implemented: true },
  notification: { implemented: true, notes: "Kinds raised today: approval, user_question, limit." },
  sessionEnd: { implemented: true, notes: "Every exit path: success, error, paused, cancelled." },
};

const SLOTS: Record<SlotName, CapabilityStatus> = {
  memoryStore: { implemented: true, notes: "An explicit `memory.store` option still wins." },
  tokenCounter: { implemented: true, notes: "An explicit `tokenCounter` option still wins." },
  costEstimator: { implemented: true, notes: "An explicit `costEstimator` option still wins." },
  conversationStore: {
    implemented: true,
    notes: "The shipped `conversationHistory` plugin does the work through sessionStart/sessionEnd; the slot is the registry.",
  },
  checkpointStore: { implemented: true, notes: "Same shape, driven from sessionEnd." },
  summarizer: { implemented: false, notes: "Declared and validated, but no call site consumes it yet." },
  approvalTransport: {
    implemented: false,
    notes: "Declared and validated, but nothing calls it: a pending approval still reaches the host through state.pendingApprovals.",
  },
  skillSource: { implemented: false, notes: "Declared only. Skills still load from the configured source." },
  promptSource: { implemented: false, notes: "Declared only." },
  contextBuilder: { implemented: false, notes: "Declared only." },
};

const FEATURES: Record<string, CapabilityStatus> = {
  hookMutations: {
    implemented: true,
    notes: "Rewrites chain: handler N sees handler N-1's output, so several plugins' rewrites compose instead of the last one winning.",
  },
  mutationProvenance: {
    implemented: true,
    notes: "PLUGIN-level only: GateResult.mutatedBy and the hook trace event name which plugins rewrote a payload, in order. SPAN-level is not available — a handler returns a rewritten payload rather than an op list, so which characters a given rule changed is not recoverable. A plugin can report its own detail through `metadata`.",
  },
  streamGate: {
    implemented: false,
    notes: "There is no hook on stream deltas. `onStream` is synchronous and void, so a chunk cannot be held back or blocked in real time. A postModelCall rewrite fixes the transcript, never what was already emitted.",
  },
  subagentInheritance: {
    implemented: true,
    notes: "Plugins propagate to sub-agents and asTool children unless they declare inheritToSubagents:false. The LEGACY `guardrails` option is still NOT forwarded to spawned children.",
  },
  guardrailFailureMode: {
    implemented: true,
    notes: "Per-plugin failureMode open|closed for plugin hooks, and per-guardrail failureMode for v1 ConversationGuardrail rules.",
  },
  multimodalHooks: {
    implemented: true,
    notes: "userPromptSubmit carries text, the full content parts and a normalized attachment list; a text rewrite is written back into the text parts so attachments survive.",
  },
  traceSinkContribution: {
    implemented: false,
    notes: "The tracing runtime carries a single sink; configure sinks through `tracing`.",
  },
};

/**
 * Hook ids used by the Cognipeer Console's guardrail plane, mapped onto this
 * SDK's hooks.
 *
 * The Console plane originally had one input stage, which collapsed two
 * moments that behave differently: `userPromptSubmit` fires ONCE for a new
 * user turn and can see attachments, while `preModelCall` fires before EVERY
 * provider call — which is where the legacy `GuardrailPhase.Request` actually
 * ran. A policy meant to vet what a person typed wants the first; one meant to
 * vet every prompt reaching the model, including turns built from tool output,
 * wants the second. Mapping both to one id silently changes how often the
 * policy runs, and on a moderation-model guardrail that is a cost as well as a
 * semantics bug.
 *
 * The Console added `prompt.pre` for the first and kept `input.pre` meaning
 * the second, so every id below is single-valued.
 */
export const CONSOLE_HOOK_MAP: Readonly<Record<string, HookName | null>> = {
  "prompt.pre": "userPromptSubmit",
  "input.pre": "preModelCall",
  "output.pre": "postModelCall",
  "output.stream.delta": null,
  "tool.pre": "preToolUse",
  "tool.post": "postToolUse",
};

/** What this build implements. Safe to call at any time; allocates a fresh copy. */
export function pluginCapabilities(): SdkCapabilities {
  return {
    hookContractVersion: HOOK_CONTRACT_VERSION,
    hooks: { ...HOOKS },
    slots: { ...SLOTS },
    features: { ...FEATURES },
  };
}

/** Convenience for a host that only wants to know whether it can enforce. */
export function isHookImplemented(hook: HookName): boolean {
  return HOOKS[hook]?.implemented === true;
}
