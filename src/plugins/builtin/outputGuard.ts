/**
 * Contract check on the final answer.
 *
 * Prompt engineering states the shape an answer must have; nothing verifies it.
 * This is the verification step: length bounds, required and forbidden shapes,
 * and an escape hatch for the checks that only the caller can express. A
 * violation denies with the rule that failed named in the reason, so the
 * failure is actionable rather than a generic "output rejected".
 *
 * Only `maxChars` can be repaired automatically. Every other rule describes
 * something the answer is missing or must not contain, and there is no honest
 * local edit for that — silently patching a non-conforming answer would return
 * something the model never wrote and nobody reviewed.
 */

import type { AgentPlugin, HookContext } from "../types.js";

export type OutputGuardConfig = {
  /** Upper bound on the answer's length. */
  maxChars?: number;
  /** Lower bound, checked after trimming — whitespace is not an answer. */
  minChars?: number;
  /** Every pattern must match. Use for required sections, citations, formats. */
  mustMatch?: RegExp[];
  /** No pattern may match. Use for banned phrases, internal markers, hedges. */
  mustNotMatch?: RegExp[];
  /** Reject an empty or whitespace-only answer. Default true. */
  forbidEmpty?: boolean;
  /** Caller-defined rule. Return a violation message, or `undefined` to pass. */
  custom?: (content: string, ctx: HookContext) => string | undefined;
  /**
   * `deny` (default) hands the reason back so the loop can try again.
   * `truncate` applies to `maxChars` only; anything else still denies.
   */
  action?: "deny" | "truncate";
  name?: string;
  priority?: number;
};

/**
 * A caller's pattern may carry `g`, which makes `test()` resume from the
 * previous call's `lastIndex` — the same rule would then pass and fail on
 * alternate runs. Tested through a stateless copy instead.
 */
function stateless(pattern: RegExp): RegExp {
  const flags = pattern.flags.replace(/[gy]/g, "");
  return flags === pattern.flags ? pattern : new RegExp(pattern.source, flags);
}

/**
 * Cuts at the last whitespace so the answer does not end mid-word, and always
 * carries the marker: a truncation the reader cannot see is worse than a long
 * answer, because it reads as a complete — and wrong — one. That means a
 * pathologically small `maxChars` yields marker-only output slightly over the
 * limit, which is the right way to fail here.
 */
function truncateAtWordBoundary(content: string, maxChars: number): string {
  const marker = `\n\n[truncated: answer exceeded ${maxChars} characters]`;
  const room = maxChars - marker.length;
  if (room <= 0) return marker.trimStart();
  const head = content.slice(0, room);
  const onBoundary = head.replace(/\s+\S*$/, "");
  return `${onBoundary || head}${marker}`;
}

export function outputGuard(config: OutputGuardConfig = {}): AgentPlugin {
  const forbidEmpty = config.forbidEmpty ?? true;
  const action = config.action ?? "deny";

  /** Rules that describe the answer's content, in the order worth reporting. */
  const violation = (content: string, ctx: HookContext): string | undefined => {
    const trimmed = content.trim();

    if (forbidEmpty && trimmed.length === 0) {
      return "forbidEmpty: the final answer is empty.";
    }
    if (config.minChars !== undefined && trimmed.length < config.minChars) {
      return `minChars: the final answer is ${trimmed.length} characters, below the required ${config.minChars}.`;
    }
    for (const pattern of config.mustMatch ?? []) {
      if (!stateless(pattern).test(content)) {
        return `mustMatch: the final answer does not match ${pattern}.`;
      }
    }
    for (const pattern of config.mustNotMatch ?? []) {
      if (stateless(pattern).test(content)) {
        return `mustNotMatch: the final answer matches the forbidden pattern ${pattern}.`;
      }
    }
    return config.custom?.(content, ctx);
  };

  return {
    name: config.name ?? "output-guard",
    /**
     * Late by design: piiRedaction (10) and the guardrail plugins (20) rewrite
     * the answer, so a contract checked before them would be checked against
     * text that is not what gets returned. Still ahead of checkpointing (900),
     * which should persist a run whose answer already passed.
     */
    priority: config.priority ?? 800,
    /**
     * A shape contract, not a security control: if this hook itself breaks, an
     * unvalidated answer is a far better outcome than a failed run.
     */
    failureMode: "open",

    hooks: {
      preFinalAnswer: ({ content }, ctx) => {
        const failed = violation(content, ctx);
        if (failed) {
          ctx.emit({
            type: "metadata",
            outputGuard: { violation: failed, plugin: config.name ?? "output-guard" },
          } as never);
          return { decision: "deny", reason: failed };
        }

        if (config.maxChars !== undefined && content.length > config.maxChars) {
          if (action === "truncate") {
            return { content: truncateAtWordBoundary(content, config.maxChars) };
          }
          return {
            decision: "deny",
            reason: `maxChars: the final answer is ${content.length} characters, above the allowed ${config.maxChars}.`,
          };
        }

        // No return value at all, so a passing answer is handed on untouched —
        // returning `{ content }` would mark the gate mutated for a no-op.
        return undefined;
      },
    },
  };
}
