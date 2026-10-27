/**
 * Spend ceiling for a run.
 *
 * Counters are derived from `state.usage` rather than kept in the plugin's own
 * store, which makes the budget correct across a pause/resume boundary for
 * free: plugin stores are per-run and would reset to zero on resume, while
 * `state.usage` is part of the snapshot.
 */

import type { AgentPlugin, CostEstimator, HookContext } from "../types.js";
import type { SmartState } from "../../types.js";
import { costEstimatorArgsOf, splitUsage } from "../../utils/usage.js";

export type BudgetGuardConfig = {
  /** Hard ceiling in USD. Requires `costEstimator`. */
  maxUsd?: number;
  /** Hard ceiling on cumulative output tokens across the run. */
  maxOutputTokens?: number;
  /** Hard ceiling on model calls. */
  maxModelCalls?: number;
  /**
   * Per-run pricing. Without it the USD ceiling is inert — the SDK carries no
   * built-in price table, and a stale one is worse than none.
   */
  costEstimator?: CostEstimator;
  /** `deny` stops the run; `warn` only emits. Default `deny`. */
  onExceeded?: "deny" | "warn";
  /** Emit a `metadata` event once this fraction of the budget is used. Default 0.8. */
  warnAt?: number;
  priority?: number;
  name?: string;
};

type Spend = { usd: number; outputTokens: number; modelCalls: number };

function measure(state: SmartState, estimator?: CostEstimator): Spend {
  const usage = state.usage;
  const spend: Spend = { usd: 0, outputTokens: 0, modelCalls: 0 };
  if (!usage) return spend;

  for (const totals of Object.values(usage.totals ?? {})) {
    spend.outputTokens += Number(totals?.output) || 0;
  }
  const requests = usage.perRequest ?? [];
  // Money and output tokens include what sub-agents spent for this run. The call
  // count does not: a child enforces its own copy of this guard on its own
  // calls, and the number of children is already bounded by `maxChildCalls`.
  spend.modelCalls = splitUsage(usage).ownCalls;

  if (estimator) {
    for (const request of requests) {
      spend.usd += estimator(costEstimatorArgsOf(request)) || 0;
    }
  }

  return spend;
}

export function budgetGuard(config: BudgetGuardConfig = {}): AgentPlugin {
  const enforce = (config.onExceeded ?? "deny") === "deny";
  const warnAt = config.warnAt ?? 0.8;

  const breach = (spend: Spend): string | undefined => {
    if (config.maxUsd !== undefined && config.costEstimator && spend.usd > config.maxUsd) {
      return `Cost ceiling exceeded: $${spend.usd.toFixed(4)} of $${config.maxUsd}.`;
    }
    if (config.maxOutputTokens !== undefined && spend.outputTokens > config.maxOutputTokens) {
      return `Output token ceiling exceeded: ${spend.outputTokens} of ${config.maxOutputTokens}.`;
    }
    if (config.maxModelCalls !== undefined && spend.modelCalls >= config.maxModelCalls) {
      return `Model call ceiling reached: ${spend.modelCalls} of ${config.maxModelCalls}.`;
    }
    return undefined;
  };

  const fraction = (spend: Spend): number => {
    const ratios: number[] = [];
    if (config.maxUsd && config.costEstimator) ratios.push(spend.usd / config.maxUsd);
    if (config.maxOutputTokens) ratios.push(spend.outputTokens / config.maxOutputTokens);
    if (config.maxModelCalls) ratios.push(spend.modelCalls / config.maxModelCalls);
    return ratios.length > 0 ? Math.max(...ratios) : 0;
  };

  return {
    name: config.name ?? "budget-guard",
    priority: config.priority ?? 5,
    failureMode: "open",

    hooks: {
      preModelCall: (_input, ctx: HookContext) => {
        const spend = measure(ctx.state as SmartState, config.costEstimator);
        const exceeded = breach(spend);

        if (!exceeded) {
          const used = fraction(spend);
          if (used >= warnAt && !ctx.store.__warned) {
            ctx.store.__warned = true;
            ctx.emit({ type: "metadata", budget: { ...spend, usedFraction: Number(used.toFixed(3)) } } as never);
          }
          return undefined;
        }

        ctx.emit({ type: "metadata", budgetExceeded: { ...spend, reason: exceeded, enforced: enforce } } as never);
        return enforce ? { decision: "deny", reason: exceeded } : undefined;
      },

      sessionEnd: ({ status }, ctx) => {
        const spend = measure(ctx.state as SmartState, config.costEstimator);
        ctx.emit({ type: "metadata", budgetSummary: { ...spend, status } } as never);
      },
    },
  };
}
