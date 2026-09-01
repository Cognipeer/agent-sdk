/**
 * Webhook-backed human-in-the-loop transport for the `approvalTransport` slot.
 *
 * ── Runtime status (read this before wiring it into a product) ───────────────
 * The `approvalTransport` slot is DECLARED (`PluginProvides`) and RESOLVED (the
 * host validates single ownership and exposes it on `host.slots`), but as of
 * this file's writing NOTHING IN THE RUNTIME CALLS IT: `grep -rn
 * approvalTransport src` finds only the type, the slot list and the docs table,
 * and the tools node still pauses the run and waits for `resolveToolApproval`.
 * Nothing reads `host.slots` at all yet, so this is the state of every slot
 * rather than a gap peculiar to this one.
 * Installing this plugin today changes no behaviour. It ships now because
 * the contract — `request()` returning a resolution, or `null` to leave the run
 * paused — is already fixed, and the tests below pin it so the day the tools
 * node consumes the slot the transport is already proven against it.
 *
 * ── Wire contract ───────────────────────────────────────────────────────────
 * The default request body and the default response parsing are THIS SDK's own
 * convention, not a schema published by any approval product. Nothing here was
 * verified against Slack, Teams, Jira, ServiceNow, PagerDuty or any other
 * system, and no such schema is invented and presented as fact. Point `url` at
 * an endpoint you control, or override `buildRequest` / `parseDecision` — the
 * same two-function escape hatch `cognipeerGuardrail` uses for exactly this
 * reason.
 *
 * ── Safety posture ──────────────────────────────────────────────────────────
 * "I could not get an answer" is `null`, which leaves the approval pending so
 * the host resolves it the ordinary way. That is the default on timeout and on
 * a delivery failure: an unreachable webhook must never silently become a "yes",
 * and it must not become an automatic "no" either, because a rejected tool call
 * is a wrong answer handed to the model. `onTimeout: "reject"` opts into the
 * strict reading for deployments that would rather fail the call than leave a
 * run parked.
 */

import type { AgentPlugin, ApprovalTransport, HookContext } from "../types.js";
import type { PendingToolApproval, ToolApprovalResolution } from "../../types.js";

export type WebhookApprovalConfig = {
  /** Where the pending approval is POSTed so a human can see it. */
  url: string;
  /** Static headers, or a thunk so a rotating token is read per call. */
  headers?: Record<string, string> | (() => Record<string, string>);
  /**
   * Status endpoint polled until a decision appears. A function receives the
   * pending approval, so a per-approval URL can be built. When omitted, the
   * POST response itself must carry the decision (or a `pollUrl`/`statusUrl`
   * field, which is the default convention this transport understands).
   */
  pollUrl?: string | ((pending: PendingToolApproval, ctx: HookContext) => string | undefined);
  /** Gap between status checks. Default 2000ms. */
  pollIntervalMs?: number;
  /** Total budget for one approval, POST included. Default 300_000ms (5 min). */
  timeoutMs?: number;
  /** Override the POST body. Default: `{ type, runId, agentName, depth, approval }`. */
  buildRequest?: (pending: PendingToolApproval, ctx: HookContext) => unknown;
  /**
   * Map a webhook or poll response to a resolution. Returning `null`/`undefined`
   * means "no decision yet" and keeps polling — it is not an error.
   */
  parseDecision?: (
    response: unknown,
    pending: PendingToolApproval,
  ) => ToolApprovalResolution | null | undefined;
  /**
   * What an expired budget means. Default `leave-pending` (return `null`, run
   * stays paused). `reject` resolves the approval as refused instead.
   */
  onTimeout?: "reject" | "leave-pending";
  name?: string;
};

const APPROVED_WORDS = new Set([
  "approved", "approve", "allow", "allowed", "accept", "accepted", "yes", "ok", "true",
]);
const REJECTED_WORDS = new Set([
  "rejected", "reject", "denied", "deny", "declined", "decline", "no", "false", "cancelled", "canceled",
]);

function resolveHeaders(headers: WebhookApprovalConfig["headers"]): Record<string, string> {
  const base = typeof headers === "function" ? headers() : headers;
  const out: Record<string, string> = { ...(base ?? {}) };
  if (!Object.keys(out).some((key) => key.toLowerCase() === "content-type")) {
    out["content-type"] = "application/json";
  }
  return out;
}

function pickString(obj: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = obj[key];
    if (typeof value === "string" && value.length > 0) return value;
  }
  return undefined;
}

/** Reviewer tools commonly wrap the payload; look one level in before giving up. */
function unwrap(response: unknown): Record<string, unknown> | undefined {
  if (!response || typeof response !== "object") return undefined;
  const obj = response as Record<string, unknown>;
  for (const key of ["approval", "decision", "result", "data"]) {
    const nested = obj[key];
    if (nested && typeof nested === "object" && !Array.isArray(nested)) {
      // Only descend when the nesting actually carries a verdict; `decision:
      // "approved"` is a string and must be read at this level.
      const inner = nested as Record<string, unknown>;
      if ("approved" in inner || "status" in inner || "decision" in inner || "state" in inner) return inner;
    }
  }
  return obj;
}

/**
 * Forgiving on purpose, in the same spirit as `normalizeVerdicts`: the shape of
 * whatever ticketing system sits behind the webhook can change without an SDK
 * release, and a strict parser would turn a field rename into every approval
 * timing out.
 */
export function parseApprovalDecision(
  response: unknown,
  pending: PendingToolApproval,
): ToolApprovalResolution | null {
  const obj = unwrap(response);
  if (!obj) return null;

  let approved: boolean | undefined;
  if (typeof obj.approved === "boolean") approved = obj.approved;
  else {
    const word = pickString(obj, ["decision", "status", "state", "action", "result", "verdict"])?.toLowerCase();
    if (word && APPROVED_WORDS.has(word)) approved = true;
    else if (word && REJECTED_WORDS.has(word)) approved = false;
    // "pending" / "open" / "waiting" and anything unrecognised fall through as
    // undefined, which means "still waiting" rather than "denied".
  }
  if (approved === undefined) return null;

  const resolution: ToolApprovalResolution = {
    // The id is taken from the pending approval, never from the response: the
    // host matches resolutions by id, and honouring a remote id would let a
    // stale or misrouted webhook resolve a different tool call.
    id: pending.id,
    approved,
  };
  // Only an explicitly-named edit is honoured. A plain `args` echo is
  // indistinguishable from an edit, and silently re-writing tool arguments from
  // an ambiguous field is the one mistake here with real blast radius.
  const edited = obj.approvedArgs ?? obj.approved_args ?? obj.updatedArgs;
  if (edited !== undefined) resolution.approvedArgs = edited;
  const decidedBy = pickString(obj, ["decidedBy", "decided_by", "approver", "actor", "user"]);
  if (decidedBy) resolution.decidedBy = decidedBy;
  const comment = pickString(obj, ["comment", "reason", "note", "message"]);
  if (comment) resolution.comment = comment;
  return resolution;
}

/** Resolves early on abort, so a cancelled run does not sit out a poll gap. */
function delay(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal?.addEventListener("abort", done, { once: true });
  });
}

export function webhookApproval(config: WebhookApprovalConfig): AgentPlugin {
  const pollIntervalMs = config.pollIntervalMs ?? 2000;
  const timeoutMs = config.timeoutMs ?? 300_000;
  const buildRequest =
    config.buildRequest ??
    ((pending: PendingToolApproval, ctx: HookContext) => ({
      type: "tool_approval_request",
      runId: ctx.runId,
      agentName: ctx.agentName,
      depth: ctx.depth,
      approval: {
        id: pending.id,
        toolCallId: pending.toolCallId,
        toolName: pending.toolName,
        args: pending.args,
        requestedAt: pending.requestedAt,
        metadata: pending.metadata,
      },
    }));
  const parseDecision = config.parseDecision ?? parseApprovalDecision;

  const fetchJson = async (
    url: string,
    init: { method: string; body?: string },
    deadline: number,
    signal?: AbortSignal,
  ): Promise<unknown> => {
    const fetchFn = typeof globalThis.fetch === "function" ? globalThis.fetch.bind(globalThis) : undefined;
    if (!fetchFn) throw new Error("webhookApproval requires fetch to be available in this runtime.");

    const controller = new AbortController();
    // A hung request must not outlive the approval budget, so the per-request
    // ceiling is simply whatever is left of it.
    const timer = setTimeout(() => controller.abort(), Math.max(0, deadline - Date.now()));
    const onAbort = () => controller.abort();
    signal?.addEventListener("abort", onAbort, { once: true });

    try {
      const response = await fetchFn(url, {
        method: init.method,
        headers: resolveHeaders(config.headers),
        body: init.body,
        signal: controller.signal,
      });
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}${response.statusText ? ` ${response.statusText}` : ""}`);
      }
      try {
        return await response.json();
      } catch {
        // An empty 202 body is a legitimate "received, nobody has decided yet".
        return undefined;
      }
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    }
  };

  const settle = (pending: PendingToolApproval, why: string): ToolApprovalResolution | null =>
    config.onTimeout === "reject"
      ? { id: pending.id, approved: false, decidedBy: "webhook-approval", comment: why }
      : null;

  const readDecision = (
    response: unknown,
    pending: PendingToolApproval,
    ctx: HookContext,
  ): ToolApprovalResolution | null => {
    try {
      const parsed = parseDecision(response, pending);
      // A caller-supplied parser is trusted for the verdict but not for the id.
      return parsed ? { ...parsed, id: pending.id } : null;
    } catch (err) {
      ctx.logger.warn("approval response could not be parsed:", err);
      return null;
    }
  };

  const transport: ApprovalTransport = {
    async request(pending, ctx) {
      const deadline = Date.now() + timeoutMs;

      let posted: unknown;
      try {
        posted = await fetchJson(
          config.url,
          { method: "POST", body: JSON.stringify(buildRequest(pending, ctx)) },
          deadline,
          ctx.signal,
        );
      } catch (err) {
        if (ctx.signal?.aborted) return null;
        ctx.logger.warn(`approval webhook delivery failed for "${pending.toolName}":`, err);
        // Same class as a timeout: no human ever saw the request, so the same
        // configured policy applies.
        return settle(pending, `approval webhook unreachable: ${err instanceof Error ? err.message : String(err)}`);
      }

      const direct = readDecision(posted, pending, ctx);
      if (direct) return direct;

      const statusUrl =
        (typeof config.pollUrl === "function" ? config.pollUrl(pending, ctx) : config.pollUrl) ??
        (posted && typeof posted === "object"
          ? pickString(posted as Record<string, unknown>, ["pollUrl", "statusUrl"])
          : undefined);
      if (!statusUrl) {
        return settle(pending, "approval webhook returned no decision and no poll URL was configured");
      }

      while (!ctx.signal?.aborted && Date.now() < deadline) {
        await delay(Math.min(pollIntervalMs, deadline - Date.now()), ctx.signal);
        if (ctx.signal?.aborted || Date.now() >= deadline) break;
        try {
          const polled = await fetchJson(statusUrl, { method: "GET" }, deadline, ctx.signal);
          const decided = readDecision(polled, pending, ctx);
          if (decided) return decided;
        } catch (err) {
          if (ctx.signal?.aborted) break;
          // A transient 5xx must not lose an approval a human may still answer;
          // the deadline is the only thing that ends the wait.
          ctx.logger.debug("approval poll failed, continuing until the deadline:", err);
        }
      }

      // A cancelled run is not a timeout — the run is going away and there is
      // nothing left to reject, so `onTimeout` deliberately does not apply.
      if (ctx.signal?.aborted) return null;
      return settle(pending, `no approval decision within ${timeoutMs}ms`);
    },
  };

  return {
    name: config.name ?? "webhook-approval",
    // Priority orders hook chains, and this plugin registers no hooks: slot
    // ownership is exclusive by construction, so nothing here is order-sensitive.
    // The default is kept rather than a made-up number that implies otherwise.
    priority: 100,
    // Not a security control in the fail-closed sense: the host's failureMode
    // governs hooks, and this plugin has none. The safety property lives in
    // `request()` returning `null`, which keeps the run paused for a human.
    failureMode: "open",
    provides: { approvalTransport: transport },
  };
}
