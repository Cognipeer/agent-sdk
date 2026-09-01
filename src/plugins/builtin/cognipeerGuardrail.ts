/**
 * Cognipeer Console guardrail — the first-party preset.
 *
 * Talks to the Console's HOOK plane, not its single-shot evaluator:
 *
 *   POST {baseUrl}/api/client/v1/guardrails/hooks/evaluate
 *   Authorization: Bearer <api key>
 *   { hook, guardrail_keys, text?, tool_name?, tool_args?, tool_result?, … }
 *
 * Three properties of that contract shape everything below, and getting any of
 * them wrong turns a working policy into a silent one:
 *
 *   `decision`  is the EFFECTIVE verdict, already neutralised in monitor mode.
 *               Priority runs block > redact > warn > flag > allow.
 *   `enforced`  false means the decision was NOT applied — a dry run. Blocking
 *               on `decision === "block"` without checking this turns every
 *               monitoring policy into an enforcing one on the day it is
 *               switched on for observation.
 *   `passed`    means "no blocking finding", NOT "the request was allowed".
 *               The two diverge in monitor mode, which is exactly when someone
 *               reads the wrong one.
 *
 * `subject` (or `redacted_text` for the text case) is filled only when the
 * service actually rewrote something; when it is present it REPLACES what was
 * sent rather than being merged with it.
 *
 * The endpoint answers 200 for a finding as readily as for a clean check, and
 * only emits 246/446 when a guardrail opts into verdict status codes — so both
 * are declared as verdict-carrying rather than treated as transport failures.
 * An unknown key answers 404 ON PURPOSE: a vacuous allow read as "content is
 * safe" is the failure the whole plane exists to avoid.
 */

import type { AgentPlugin } from "../types.js";
import {
  createGuardrailPlugin,
  httpGuardrail,
  type GuardrailCallContext,
  type GuardrailPhaseName,
  type GuardrailRequest,
  type GuardrailVerdict,
} from "./guardrail.js";

const DEFAULT_BASE_URL = "https://console.cognipeer.com";
const DEFAULT_HOOK_PATH = "/api/client/v1/guardrails/hooks/evaluate";

/**
 * SDK hook → the Console plane's hook id.
 *
 * `userPromptSubmit` maps to `input.pre` because that is what the deployed
 * Console accepts today — it answers 400 to anything outside its five ids, and
 * under the default fail-closed posture a 400 on every turn reads as "blocked"
 * rather than as a version mismatch. The Console is adding `prompt.pre` for
 * exactly this distinction (once per user turn, versus once per model call);
 * point at it with `hookIds: { userPromptSubmit: "prompt.pre" }` when the
 * deployment carries it.
 */
const DEFAULT_HOOK_IDS: Record<string, string> = {
  userPromptSubmit: "input.pre",
  preModelCall: "input.pre",
  postModelCall: "output.pre",
  preToolUse: "tool.pre",
  postToolUse: "tool.post",
};

/** Fallback when a request carries no hook name (a caller driving the transport directly). */
const PHASE_IDS: Record<GuardrailPhaseName, string> = {
  input: "input.pre",
  output: "output.pre",
  tool: "tool.pre",
  tool_result: "tool.post",
};

export type CognipeerGuardrailConfig = {
  /** Guardrail keys from the Console. Defaults to `COGNIPEER_GUARDRAIL_KEYS` (comma-separated). */
  guardrailKeys?: string[];
  /** Convenience for the single-key case. */
  guardrailKey?: string;
  /** Defaults to `COGNIPEER_API_KEY`. */
  apiKey?: string;
  /** Defaults to `COGNIPEER_BASE_URL`, then the production console. Point at localhost for local runs. */
  baseUrl?: string;
  /** Override the hook-evaluate path. */
  path?: string;
  /** Surfaces to guard. Default: input + output. Add `"tool"` / `"tool_result"` for the tool surface. */
  apply?: GuardrailPhaseName[];
  /** Restrict to specific check families, e.g. `["pii"]`. */
  only?: string[];
  /** Override the SDK-hook → Console-hook-id mapping, merged over the default. */
  hookIds?: Record<string, string>;
  /** Ask the service to evaluate without enforcing. Independent of `mode`. */
  shadow?: boolean;
  /** `shadow` here reports locally without acting, whatever the service says. */
  mode?: "enforce" | "shadow";
  /** Default true — an unreachable or misconfigured policy blocks rather than silently stops guarding. */
  failClosed?: boolean;
  /** Per-check ceiling. Default 3000ms; also sent as `budget_ms`. */
  timeoutMs?: number;
  retries?: number;
  priority?: number;
  cache?: boolean | { maxEntries?: number };
  metadata?: Record<string, unknown>;
  buildRequest?: (requests: GuardrailRequest[], ctx: GuardrailCallContext) => unknown;
  mapVerdict?: (response: unknown, requests: GuardrailRequest[]) => GuardrailVerdict[];
  name?: string;
};

function joinUrl(base: string, path: string): string {
  return `${base.replace(/\/+$/, "")}${path.startsWith("/") ? path : `/${path}`}`;
}

/** A refusal carries a structured message, not a string. */
type BlockedMessage = { reasonClass?: string; body?: string; mode?: string; status?: number; traceId?: string };

type HookResponse = {
  decision?: string;
  would_be_decision?: string;
  enforced?: boolean;
  mode?: string;
  disabled?: boolean;
  passed?: boolean;
  subject?: unknown;
  redacted_text?: string | null;
  blocked_message?: string | BlockedMessage | null;
  message?: string | null;
  findings?: unknown[];
  codes?: unknown[];
  risk_score?: number;
  trace_id?: string;
  degraded?: boolean;
};

/** The Console's hook response, mapped onto the transport's three-valued verdict. */
export function mapConsoleHookVerdict(response: unknown, requests: GuardrailRequest[]): GuardrailVerdict[] {
  const body = (response ?? {}) as HookResponse;
  const decision = String(body.decision ?? "allow").toLowerCase();
  const enforced = body.enforced !== false;

  const rewritten =
    typeof body.redacted_text === "string" && body.redacted_text.length > 0
      ? body.redacted_text
      : typeof body.subject === "string" && body.subject.length > 0
        ? body.subject
        : undefined;

  // `blocked_message` is an object ({ reasonClass, body, mode, status, traceId }),
  // not a string — assigning it straight through renders the refusal a user
  // reads as "[object Object]".
  const blocked = body.blocked_message;
  const message =
    (typeof blocked === "string" ? blocked : blocked?.body)
    || body.message
    || undefined;
  const violations = Array.isArray(body.findings) ? (body.findings as GuardrailVerdict["violations"]) : undefined;

  // `mode: "replace"` asks for SUBSTITUTION, not refusal: the turn continues
  // with this text standing in for what was there. Refusing instead is a
  // different product behaviour, and a guardrail that chose the softer one
  // would silently get the harder one.
  const replaceMode = typeof blocked === "object" && blocked !== null && blocked.mode === "replace";

  let action: GuardrailVerdict["action"];
  let masked: string | undefined;

  if (!enforced || body.disabled === true) {
    // Monitor / dry run. The service already decided this should not act; a
    // client that blocked anyway would turn every observation policy into an
    // enforcing one the moment it was switched on to watch.
    action = "allow";
  } else if (decision === "block") {
    if (replaceMode && message) {
      action = "mask";
      masked = message;
    } else {
      action = "block";
    }
  } else if (decision === "redact") {
    // A redact with nothing to substitute cannot be honoured, and treating it
    // as allow would drop the finding silently.
    action = rewritten !== undefined ? "mask" : "block";
    masked = rewritten;
  } else {
    // warn / flag / allow all let the turn continue; the finding still rides
    // out on the verdict for reporting.
    action = "allow";
  }

  const verdict: GuardrailVerdict = {
    action,
    message,
    maskedContent: action === "mask" ? masked : undefined,
    violations,
    raw: response,
  };
  // Every request in a batch shares one hook evaluation.
  return requests.map(() => verdict);
}

export function cognipeerGuardrail(config: CognipeerGuardrailConfig = {}): AgentPlugin {
  const apiKey = config.apiKey ?? process.env.COGNIPEER_API_KEY;
  const baseUrl = config.baseUrl ?? process.env.COGNIPEER_BASE_URL ?? DEFAULT_BASE_URL;
  const keys =
    config.guardrailKeys
    ?? (config.guardrailKey ? [config.guardrailKey] : undefined)
    ?? process.env.COGNIPEER_GUARDRAIL_KEYS?.split(",").map((key) => key.trim()).filter(Boolean)
    ?? (process.env.COGNIPEER_GUARDRAIL_KEY ? [process.env.COGNIPEER_GUARDRAIL_KEY] : undefined);

  if (!apiKey) {
    throw new Error(
      "[agent-sdk] cognipeerGuardrail requires an apiKey (pass `apiKey` or set COGNIPEER_API_KEY).",
    );
  }
  if ((!keys || keys.length === 0) && !config.buildRequest) {
    // An unknown or missing key answers 404 on every turn, which under the
    // default fail-closed posture reads as "everything is blocked" rather than
    // as the configuration mistake it is.
    throw new Error(
      "[agent-sdk] cognipeerGuardrail requires at least one guardrailKey (pass `guardrailKeys`/`guardrailKey` or set COGNIPEER_GUARDRAIL_KEYS).",
    );
  }

  const timeoutMs = config.timeoutMs ?? 3000;

  const transport = httpGuardrail({
    name: "cognipeer",
    url: joinUrl(baseUrl, config.path ?? DEFAULT_HOOK_PATH),
    headers: { Authorization: `Bearer ${apiKey}` },
    timeoutMs,
    retries: config.retries ?? 1,
    // One hook evaluation per request: the endpoint takes a single surface.
    batch: false,
    // 446 (block) and 246 (passed with findings) carry a verdict, not an error.
    verdictStatuses: [246, 446],
    buildRequest:
      config.buildRequest ??
      ((requests, ctx) => {
        const [request] = requests;
        const hookIds = { ...DEFAULT_HOOK_IDS, ...(config.hookIds ?? {}) };
        const hookId = (request.hook && hookIds[request.hook]) || PHASE_IDS[request.phase];
        return {
          hook: hookId,
          guardrail_keys: keys,
          text: request.phase === "tool" ? undefined : request.content,
          tool_name: request.subject,
          tool_args: request.toolArgs,
          tool_result: request.phase === "tool_result" ? request.toolResult : undefined,
          provider_ref: "agent-sdk",
          request_id: ctx.runId,
          trace_id: ctx.traceId,
          budget_ms: timeoutMs,
          only: config.only,
          shadow: config.shadow,
          metadata: request.metadata,
          attachments: request.attachments,
        };
      }),
    mapVerdict: config.mapVerdict ?? mapConsoleHookVerdict,
  });

  return createGuardrailPlugin({
    name: config.name ?? "cognipeer-guardrail",
    transport,
    apply: config.apply,
    mode: config.mode,
    failClosed: config.failClosed,
    timeoutMs,
    priority: config.priority ?? 20,
    cache: config.cache,
    metadata: config.metadata,
  });
}
