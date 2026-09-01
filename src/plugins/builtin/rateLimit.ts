/**
 * Token-bucket throttle for model and tool calls.
 *
 * The thing this protects against is not a hostile user, it is one agent: a
 * retry loop or a fan-out of sub-agents can put a month of traffic through a
 * shared upstream in a minute, and the upstream's own 429 arrives too late to
 * be cheap. So the ceiling is enforced here, where a refusal is still just a
 * tool result the model can read.
 *
 * Buckets live in this closure — one set per `rateLimit()` call, i.e. per agent
 * — and are keyed by `config.key?.(ctx) ?? "default"`. They deliberately do NOT
 * live in `ctx.store`: that store is per RUN, so a bucket kept there would be
 * full again on every `invoke()` and would limit nothing across runs, which is
 * exactly the traffic pattern worth limiting. Keying also matters: without a
 * `key`, two tenants sharing one agent instance share one budget, and the noisy
 * one starves the quiet one.
 */

import type { AgentPlugin, HookContext } from "../types.js";

export type RateLimitConfig = {
  /** Model calls allowed per minute, across the whole agent. */
  modelCallsPerMinute?: number;
  /** Tool executions allowed per minute, summed over every tool. */
  toolCallsPerMinute?: number;
  /** Extra per-tool ceilings, checked on top of `toolCallsPerMinute`. */
  perToolPerMinute?: Record<string, number>;
  /**
   * Bucket identity — a tenant, an end user, an api key. Everything the same
   * key returns shares one budget; a missing key puts every caller in one.
   */
  key?: (ctx: HookContext) => string;
  /**
   * `deny` refuses immediately and lets the model decide what to do; `wait`
   * blocks the call until a token frees, which smooths a burst instead of
   * surfacing it. Default `deny`.
   */
  onExceeded?: "deny" | "wait";
  /** Upper bound on a `wait`, after which the call is denied anyway. Default 5000. */
  maxWaitMs?: number;
  name?: string;
  priority?: number;
};

type Bucket = {
  /** Burst size. A bucket starts full, so a cold agent is not throttled. */
  capacity: number;
  refillPerMs: number;
  tokens: number;
  updatedAt: number;
  /** Human-readable subject of the limit, used in the refusal. */
  label: string;
};

type Attempt = { ok: true } | { ok: false; label: string; capacity: number; waitMs: number };

/**
 * Sleep that also wakes on the run's cancellation signal: a cancelled run must
 * not be held open by a throttle waiting on a bucket nobody will drain.
 */
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const done = () => {
      if (timer !== undefined) clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolve();
    };
    timer = setTimeout(done, ms);
    signal?.addEventListener("abort", done, { once: true });
  });
}

export function rateLimit(config: RateLimitConfig = {}): AgentPlugin {
  const mode = config.onExceeded ?? "deny";
  const maxWaitMs = config.maxWaitMs ?? 5_000;
  const buckets = new Map<string, Bucket>();

  const bucketFor = (id: string, label: string, perMinute: number): Bucket => {
    let bucket = buckets.get(id);
    if (!bucket) {
      bucket = {
        capacity: perMinute,
        refillPerMs: perMinute / 60_000,
        tokens: perMinute,
        updatedAt: Date.now(),
        label,
      };
      buckets.set(id, bucket);
    }
    return bucket;
  };

  /**
   * Refill from elapsed wall-clock time rather than from a timer: there is no
   * scheduler to own here, an idle agent costs nothing, and a bucket that is
   * never touched again does not keep a handle alive. `Math.max(0, …)` is the
   * only concession to a clock that moves backwards — it stalls the refill for
   * that interval instead of granting a windfall of tokens.
   */
  const refill = (bucket: Bucket, now: number): void => {
    const elapsed = Math.max(0, now - bucket.updatedAt);
    bucket.updatedAt = now;
    bucket.tokens = Math.min(bucket.capacity, bucket.tokens + elapsed * bucket.refillPerMs);
  };

  const waitMsFor = (bucket: Bucket): number =>
    bucket.refillPerMs > 0 ? Math.ceil((1 - bucket.tokens) / bucket.refillPerMs) : Number.POSITIVE_INFINITY;

  /**
   * All-or-nothing across the applicable buckets. Taking them one at a time
   * would charge the global tool budget for a call the per-tool ceiling then
   * refuses — the caller would pay for traffic that never happened.
   */
  const consume = (applicable: Bucket[]): Attempt => {
    const now = Date.now();
    for (const bucket of applicable) refill(bucket, now);

    const empty = applicable.filter((bucket) => bucket.tokens < 1);
    if (empty.length === 0) {
      for (const bucket of applicable) bucket.tokens -= 1;
      return { ok: true };
    }

    const worst = empty.reduce((slowest, bucket) =>
      waitMsFor(bucket) > waitMsFor(slowest) ? bucket : slowest,
    );
    return { ok: false, label: worst.label, capacity: worst.capacity, waitMs: waitMsFor(worst) };
  };

  const enforce = async (applicable: Bucket[], ctx: HookContext) => {
    if (applicable.length === 0) return undefined;

    let attempt = consume(applicable);
    if (mode === "wait") {
      const deadline = Date.now() + maxWaitMs;
      while (!attempt.ok) {
        const remaining = deadline - Date.now();
        // A wait longer than the budget is a deny either way; sleeping first
        // would only make the refusal arrive later.
        if (!Number.isFinite(attempt.waitMs) || attempt.waitMs > remaining) break;
        await sleep(Math.max(1, attempt.waitMs), ctx.signal);
        if (ctx.signal?.aborted) break;
        attempt = consume(applicable);
      }
    }

    if (attempt.ok) return undefined;

    ctx.emit({
      type: "metadata",
      rateLimit: { limit: attempt.label, perMinute: attempt.capacity, retryAfterMs: attempt.waitMs },
    } as never);

    // Phrased as an instruction, not a stack trace: on `preToolUse` this text
    // is handed to the model as the tool result, and "retry later" is the only
    // part of it the model can act on.
    return {
      decision: "deny" as const,
      reason: `Rate limit reached for ${attempt.label} (${attempt.capacity}/min), retry later.`,
    };
  };

  return {
    name: config.name ?? "rate-limit",
    /**
     * Just after `budgetGuard` (5) and after `auditLog` (0), before any policy
     * plugin. Admission control belongs at the front so an expensive gate never
     * runs for a call that is about to be refused — but behind the budget, so a
     * run that is out of money reports the ceiling that actually ended it
     * rather than a transient "retry later" that will never come true.
     */
    priority: config.priority ?? 8,
    // A throughput control, not a security control: if the bucket arithmetic
    // ever throws, letting the call through beats killing the run.
    failureMode: "open",
    // Never returns `ask`, so the tool batch stays parallel.
    mayRequireApproval: false,
    /**
     * The host's default 10s per-handler timeout would fire mid-wait and, being
     * fail-open, would wave the call through — the throttle would look like it
     * worked while doing nothing. Give the handler room for the wait it was
     * configured to perform.
     */
    timeoutMs: mode === "wait" ? maxWaitMs + 10_000 : undefined,

    hooks: {
      preModelCall: (_input, ctx) => {
        if (config.modelCallsPerMinute === undefined) return undefined;
        const key = config.key?.(ctx) ?? "default";
        return enforce(
          [bucketFor(`${key}::model`, "model calls", config.modelCallsPerMinute)],
          ctx,
        );
      },

      preToolUse: ({ toolName }, ctx) => {
        const key = config.key?.(ctx) ?? "default";
        const applicable: Bucket[] = [];
        if (config.toolCallsPerMinute !== undefined) {
          applicable.push(bucketFor(`${key}::tools`, "tool calls", config.toolCallsPerMinute));
        }
        const perTool = config.perToolPerMinute?.[toolName];
        if (perTool !== undefined) {
          applicable.push(bucketFor(`${key}::tool:${toolName}`, `tool "${toolName}"`, perTool));
        }
        return enforce(applicable, ctx);
      },
    },
  };
}
