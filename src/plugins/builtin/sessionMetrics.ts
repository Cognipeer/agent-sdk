/**
 * One structured record per run, shaped for a metrics pipeline.
 *
 * Only the things that have no ledger — how many model calls and tool calls
 * this leg actually made — are tallied in the plugin's own store. Every number
 * a billing or reliability dashboard will later be reconciled against is read
 * back off the state instead: `state.usage` is the single billing ledger and
 * `state.toolHistory` is the single record of what each call did. Both are part
 * of the snapshot, so they survive a pause/resume; a plugin-kept token counter
 * would restart at zero on resume and under-report the run's real bill.
 *
 * The counting hooks are gates, and a deny ends the chain. Sitting at priority
 * 1 — immediately after `auditLog` (0) and ahead of every policy plugin — is
 * what keeps a model turn that a guardrail later rejects inside the count: a
 * metric that only sees the traffic nothing objected to describes a different
 * agent than the one that ran.
 */

import type { AgentPlugin, CostEstimator, MaybePromise } from "../types.js";
import type { SmartState } from "../../types.js";
import { costEstimatorArgsOf, splitUsage } from "../../utils/usage.js";

export type SessionMetrics = {
  runId: string;
  agentName?: string;
  status: "success" | "error" | "paused" | "cancelled";
  durationMs: number;
  modelCalls: number;
  /** Every attempt, including the ones a policy refused. */
  toolCalls: number;
  failedToolCalls: number;
  /** Denied by a hook or by a human at the approval gate. */
  deniedToolCalls: number;
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  totalTokens: number;
  /** Present only when a `costEstimator` was configured. */
  estimatedCostUsd?: number;
  /**
   * What sub-agents spent during this run, kept apart from the figures above:
   * each child opens its own session and reports its own record, so folding
   * them in would count every child token twice in a pipeline that sums runs.
   * Present only when the run delegated.
   */
  subagentCalls?: number;
  subagentInputTokens?: number;
  subagentOutputTokens?: number;
  subagentTotalTokens?: number;
  /** Present only with a `costEstimator` and sub-agent calls. */
  subagentEstimatedCostUsd?: number;
  /** Executions per tool name. Opt-in — a wide tool menu makes this unbounded. */
  toolBreakdown?: Record<string, number>;
};

export type SessionMetricsConfig = {
  /** Where the record goes. Defaults to one JSON line on `console.log`. */
  sink?: (metrics: SessionMetrics) => MaybePromise<void>;
  /** Add per-tool execution counts. Off by default. */
  includeToolBreakdown?: boolean;
  /**
   * Pricing for `estimatedCostUsd`. Deliberately NOT published as the
   * `costEstimator` slot: a slot has exactly one owner, and a metrics plugin
   * that claimed it would make itself un-installable next to `budgetGuard`.
   */
  costEstimator?: CostEstimator;
  name?: string;
};

type Counters = { modelCalls: number; toolNames: Record<string, number>; startedAt?: number };

/** Per-run scratch. Absent only if `sessionStart` never fired for this leg. */
function counters(store: Record<string, unknown>): Counters {
  return (store.__metrics ??= { modelCalls: 0, toolNames: {} }) as Counters;
}

function sumTotals(byModel: Record<string, { input: number; output: number; total: number; cachedInput: number }>) {
  const totals = { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, totalTokens: 0 };
  for (const entry of Object.values(byModel)) {
    totals.inputTokens += Number(entry?.input) || 0;
    totals.outputTokens += Number(entry?.output) || 0;
    totals.cachedInputTokens += Number(entry?.cachedInput) || 0;
    totals.totalTokens += Number(entry?.total) || 0;
  }
  return totals;
}

function estimateCost(requests: NonNullable<SmartState["usage"]>["perRequest"], estimator: CostEstimator): number {
  let usd = 0;
  for (const request of requests) {
    usd += estimator(costEstimatorArgsOf(request)) || 0;
  }
  return usd;
}

/**
 * `toolHistory` alone carries the verdict of each attempt. A call denied at
 * `preToolUse` or refused by a human never reaches `postToolUse`, so the hook
 * counter cannot see it, while the history records it as `rejected`. The
 * archived copies in `toolHistoryArchived` are duplicates of these same rows
 * and are deliberately not counted.
 */
function toolOutcomes(state: SmartState) {
  const history = state.toolHistory ?? [];
  let failed = 0;
  let denied = 0;
  for (const record of history) {
    if (record?.status === "error") failed += 1;
    else if (record?.status === "rejected") denied += 1;
  }
  return { toolCalls: history.length, failedToolCalls: failed, deniedToolCalls: denied };
}

export function sessionMetrics(config: SessionMetricsConfig = {}): AgentPlugin {
  const sink =
    config.sink ??
    ((metrics: SessionMetrics) => {
      console.log(`[metrics] ${JSON.stringify(metrics)}`);
    });

  return {
    name: config.name ?? "session-metrics",
    priority: 1,
    // Observability: a missing metric is a reporting gap, not a safety hole.
    failureMode: "open",

    hooks: {
      sessionStart: (_input, ctx) => {
        counters(ctx.store).startedAt = Date.now();
        return undefined;
      },

      postModelCall: (_input, ctx) => {
        counters(ctx.store).modelCalls += 1;
        return undefined;
      },

      postToolUse: ({ toolName }, ctx) => {
        const counts = counters(ctx.store).toolNames;
        counts[toolName] = (counts[toolName] ?? 0) + 1;
        return undefined;
      },

      sessionEnd: async ({ status, durationMs }, ctx) => {
        const state = ctx.state as SmartState;
        const counted = counters(ctx.store);
        const usage = splitUsage(state.usage);
        const metrics: SessionMetrics = {
          runId: ctx.runId,
          agentName: ctx.agentName,
          status,
          // The host's own duration is authoritative; the `sessionStart` mark is
          // the fallback for a leg that inherited an already-open session.
          durationMs: durationMs ?? (counted.startedAt ? Date.now() - counted.startedAt : 0),
          modelCalls: counted.modelCalls,
          ...toolOutcomes(state),
          ...sumTotals(usage.own),
        };
        if (config.costEstimator) {
          metrics.estimatedCostUsd = estimateCost(usage.ownEntries, config.costEstimator);
        }
        if (usage.subagentCalls > 0) {
          const children = sumTotals(usage.subagent);
          metrics.subagentCalls = usage.subagentCalls;
          metrics.subagentInputTokens = children.inputTokens;
          metrics.subagentOutputTokens = children.outputTokens;
          metrics.subagentTotalTokens = children.totalTokens;
          if (config.costEstimator) {
            metrics.subagentEstimatedCostUsd = estimateCost(usage.subagentEntries, config.costEstimator);
          }
        }
        if (config.includeToolBreakdown) metrics.toolBreakdown = { ...counted.toolNames };

        try {
          await sink(metrics);
        } catch (err) {
          // `sessionEnd` observers cannot fail a run, but an unhandled throw
          // would still be logged as a plugin error and read like a bug in the
          // agent. A metrics pipeline being down is neither.
          ctx.logger.warn("session metrics sink failed:", err);
        }
      },
    },
  };
}
