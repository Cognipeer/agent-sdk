/**
 * Guardrail presets — four more services on the seam in `guardrail.ts`.
 *
 * Each one is the same three decisions `cognipeerGuardrail` makes and nothing
 * more: where to POST, how to authenticate, and how that service's response
 * becomes a `GuardrailVerdict`. None of them re-implements the plugin — the
 * caching, shadow mode, phase skipping and fail-closed behaviour all stay in
 * `createGuardrailPlugin`, so a fix there reaches every preset at once.
 *
 * How much a preset is allowed to assume differs per service, and that
 * difference is stated per function rather than hidden:
 *
 *   openAIModeration     the wire contract is public, stable and versioned, so
 *                        the mapper reads its fields directly and is strict
 *                        about a shape it does not recognise.
 *   azureContentSafety   path and body are what the docs look like, but they
 *                        are NOT verified here — they live behind
 *                        `buildRequest` / `mapVerdict` overrides, and the
 *                        default mapper falls back to the forgiving
 *                        `normalizeVerdicts` when it sees an unfamiliar body.
 *   bedrockGuardrail     same caveat, plus SigV4 signing reused from
 *                        `src/providers/utils/sigv4.ts`.
 *   regexGuardrail       no wire contract at all: in-process patterns, so a
 *                        team can adopt the guardrail plugin shape before it
 *                        has a service to point at.
 *
 * Priorities sit in the 20-25 guardrail band already used by `cognipeer` (20)
 * and `portkey` (25), ordered cheapest-first on purpose. R3 makes the first
 * deny terminal for the chain, so putting the local matcher ahead of the
 * network ones (and the free moderation call ahead of the billed ones) means
 * the most expensive check is the one most likely never to be made — and a
 * locally-detectable violation is never shipped to a third party at all.
 */

import type { AgentPlugin } from "../types.js";
import { signRequest, type SigV4Credentials } from "../../providers/utils/sigv4.js";
import {
  createGuardrailPlugin,
  customGuardrail,
  httpGuardrail,
  normalizeVerdicts,
  type GuardrailCallContext,
  type GuardrailPhaseName,
  type GuardrailRequest,
  type GuardrailTransport,
  type GuardrailVerdict,
  type GuardrailViolation,
} from "./guardrail.js";

function joinUrl(base: string, path: string): string {
  return `${base.replace(/\/+$/, "")}${path.startsWith("/") ? path : `/${path}`}`;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : undefined;
}

// ─── OpenAI moderation ───────────────────────────────────────────────────────

export type OpenAIModerationConfig = {
  /** Defaults to `OPENAI_API_KEY`. */
  apiKey?: string;
  /** Moderation model. Default `omni-moderation-latest`. */
  model?: string;
  /** Origin only — the `/v1/moderations` path is appended. Defaults to `OPENAI_BASE_URL`, then the public API. */
  baseUrl?: string;
  /**
   * What a flagged result becomes. `block` (default) refuses the turn; `mask`
   * substitutes `maskWith`, which is how a team replaces a violating answer
   * with a fixed refusal instead of failing the run.
   */
  action?: "block" | "mask";
  /** Replacement used when `action` is `mask`. */
  maskWith?: string;
  /** Surfaces to guard. Default: input + output. */
  apply?: GuardrailPhaseName[];
  /** `shadow` reports what would have been blocked without blocking. */
  mode?: "enforce" | "shadow";
  /** Default true — a moderation outage blocks rather than silently stops moderating. */
  failClosed?: boolean;
  /** Per-check ceiling. Default 3000ms. */
  timeoutMs?: number;
  /** Retries after the first attempt. Default 1. */
  retries?: number;
  priority?: number;
  /** Memoize verdicts per run. Default true. */
  cache?: boolean | { maxEntries?: number };
  metadata?: Record<string, unknown>;
  name?: string;
};

const DEFAULT_OPENAI_BASE_URL = "https://api.openai.com";
const DEFAULT_MODERATION_MODEL = "omni-moderation-latest";

/**
 * `results[i].categories` is a flat map of category name to boolean, and
 * `category_scores` carries the confidence for each. Naming the true ones in
 * the message is the difference between "blocked by policy" and an answer an
 * operator can act on.
 */
function moderationVerdicts(
  response: unknown,
  requests: GuardrailRequest[],
  action: "block" | "mask",
  maskWith: string,
): GuardrailVerdict[] {
  const results = asRecord(response)?.results;
  // The contract here is documented and stable, so an unrecognised body means
  // something is genuinely wrong — a proxy, an error envelope, a truncated
  // response. Throwing hands the decision to the plugin's failureMode instead
  // of silently allowing content nobody actually moderated.
  if (!Array.isArray(results) || results.length < requests.length) {
    throw new Error(
      `OpenAI moderation returned ${
        Array.isArray(results) ? `${results.length} results for ${requests.length} inputs` : "no results array"
      }.`,
    );
  }

  return requests.map((_request, index) => {
    const result = asRecord(results[index]);
    if (!result || result.flagged !== true) return { action: "allow", raw: result };

    const categories = asRecord(result.categories) ?? {};
    const scores = asRecord(result.category_scores) ?? {};
    const flagged = Object.keys(categories).filter((key) => categories[key] === true);
    const violations: GuardrailViolation[] = flagged.map((category) => ({
      type: category,
      detail: typeof scores[category] === "number" ? `score ${(scores[category] as number).toFixed(4)}` : undefined,
    }));
    const message = `OpenAI moderation flagged: ${flagged.length > 0 ? flagged.join(", ") : "unspecified category"}.`;

    return action === "mask"
      ? { action: "mask", maskedContent: maskWith, message, violations, raw: result }
      : { action: "block", message, violations, raw: result };
  });
}

/**
 * OpenAI's moderation endpoint. Free, fast and text-only, which is why it sits
 * at the cheap end of the guardrail band.
 */
export function openAIModeration(config: OpenAIModerationConfig = {}): AgentPlugin {
  const apiKey = config.apiKey ?? process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error("[agent-sdk] openAIModeration requires an apiKey (pass `apiKey` or set OPENAI_API_KEY).");
  }
  const baseUrl = config.baseUrl ?? process.env.OPENAI_BASE_URL ?? DEFAULT_OPENAI_BASE_URL;
  const model = config.model ?? DEFAULT_MODERATION_MODEL;
  const action = config.action ?? "block";
  const maskWith = config.maskWith ?? "[removed by moderation policy]";

  const transport = httpGuardrail({
    name: "openai-moderation",
    url: joinUrl(baseUrl, "/v1/moderations"),
    headers: { Authorization: `Bearer ${apiKey}` },
    timeoutMs: config.timeoutMs ?? 3000,
    retries: config.retries ?? 1,
    // `input` accepts an array and the results come back in order, so a batch
    // is one request rather than N.
    buildRequest: (requests) => ({ model, input: requests.map((request) => request.content) }),
    mapVerdict: (response, requests) => moderationVerdicts(response, requests, action, maskWith),
  });

  return createGuardrailPlugin({
    name: config.name ?? "openai-moderation",
    transport,
    apply: config.apply ?? ["input", "output"],
    mode: config.mode,
    failClosed: config.failClosed,
    timeoutMs: config.timeoutMs ?? 3000,
    // Cheapest network guardrail in the band: it should run before the billed
    // ones so a deny it raises spares them the call entirely.
    priority: config.priority ?? 22,
    cache: config.cache,
    metadata: config.metadata,
  });
}

// ─── Azure AI Content Safety ─────────────────────────────────────────────────

export type AzureContentSafetyConfig = {
  /** Resource endpoint, e.g. `https://my-resource.cognitiveservices.azure.com`. Defaults to `AZURE_CONTENT_SAFETY_ENDPOINT`. */
  endpoint?: string;
  /** Defaults to `AZURE_CONTENT_SAFETY_KEY`. */
  apiKey?: string;
  /** Block when a requested category reaches this severity. Default 4. */
  severityThreshold?: number;
  /** Categories to analyse. Default: Hate, SelfHarm, Sexual, Violence. */
  categories?: string[];
  /** `api-version` query parameter. */
  apiVersion?: string;
  /** Override the analyze path (rarely needed). */
  path?: string;
  apply?: GuardrailPhaseName[];
  mode?: "enforce" | "shadow";
  failClosed?: boolean;
  timeoutMs?: number;
  retries?: number;
  priority?: number;
  cache?: boolean | { maxEntries?: number };
  metadata?: Record<string, unknown>;
  /** Escape hatch: build the wire request yourself. */
  buildRequest?: (requests: GuardrailRequest[], ctx: GuardrailCallContext) => unknown;
  /** Escape hatch: map the response to verdicts, in request order. */
  mapVerdict?: (response: unknown, requests: GuardrailRequest[]) => GuardrailVerdict[];
  name?: string;
};

const DEFAULT_AZURE_PATH = "/contentsafety/text:analyze";
const DEFAULT_AZURE_API_VERSION = "2024-09-01";
const DEFAULT_AZURE_CATEGORIES = ["Hate", "SelfHarm", "Sexual", "Violence"];
const DEFAULT_AZURE_SEVERITY_THRESHOLD = 4;

/**
 * Reads the per-category severity list. The field names below are what the
 * service documentation looks like, NOT something this SDK has verified — when
 * they are wrong, `mapVerdict` is the one place that has to move. Anything the
 * shape-reader does not recognise falls through to `normalizeVerdicts`, which
 * already understands the common blocked/flagged envelopes.
 */
function azureVerdicts(
  response: unknown,
  requests: GuardrailRequest[],
  categories: Set<string>,
  threshold: number,
): GuardrailVerdict[] {
  const body = asRecord(response);
  const analysis = body?.categoriesAnalysis ?? body?.categoriesAnalysisResult;
  const blocklists = Array.isArray(body?.blocklistsMatch) ? (body!.blocklistsMatch as unknown[]) : [];
  if (!Array.isArray(analysis)) return normalizeVerdicts(response, requests);

  const breaches: GuardrailViolation[] = [];
  for (const entry of analysis) {
    const record = asRecord(entry);
    const category = typeof record?.category === "string" ? record.category : undefined;
    const severity = Number(record?.severity);
    if (!category || !Number.isFinite(severity)) continue;
    // An empty `categories` set means "analyse everything the service returned".
    if (categories.size > 0 && !categories.has(category)) continue;
    if (severity >= threshold) breaches.push({ type: category, severity: String(severity) });
  }
  for (const match of blocklists) {
    const record = asRecord(match);
    breaches.push({
      type: "Blocklist",
      id: typeof record?.blocklistName === "string" ? record.blocklistName : undefined,
      detail: typeof record?.blocklistItemText === "string" ? record.blocklistItemText : undefined,
    });
  }

  const verdict: GuardrailVerdict =
    breaches.length === 0
      ? { action: "allow", raw: response }
      : {
          action: "block",
          message: `Azure Content Safety blocked: ${breaches
            .map((breach) => (breach.severity ? `${breach.type} severity ${breach.severity}` : `${breach.type} ${breach.id ?? ""}`.trim()))
            .join(", ")}.`,
          violations: breaches,
          raw: response,
        };
  // The analyze endpoint judges one text per call, so a single body answers
  // whichever single request produced it.
  return requests.map(() => verdict);
}

/**
 * Azure AI Content Safety. The path, body and response field names default to
 * what the public documentation describes, but they are UNVERIFIED here: both
 * ends of the contract are overridable (`buildRequest` / `mapVerdict`) exactly
 * so a shape change is a one-line configuration fix rather than a fork.
 */
export function azureContentSafety(config: AzureContentSafetyConfig = {}): AgentPlugin {
  const endpoint = config.endpoint ?? process.env.AZURE_CONTENT_SAFETY_ENDPOINT;
  const apiKey = config.apiKey ?? process.env.AZURE_CONTENT_SAFETY_KEY;
  if (!endpoint) {
    throw new Error(
      "[agent-sdk] azureContentSafety requires an endpoint (pass `endpoint` or set AZURE_CONTENT_SAFETY_ENDPOINT).",
    );
  }
  if (!apiKey) {
    throw new Error(
      "[agent-sdk] azureContentSafety requires an apiKey (pass `apiKey` or set AZURE_CONTENT_SAFETY_KEY).",
    );
  }

  const categories = config.categories ?? DEFAULT_AZURE_CATEGORIES;
  const threshold = config.severityThreshold ?? DEFAULT_AZURE_SEVERITY_THRESHOLD;
  const requested = new Set(categories);

  const transport = httpGuardrail({
    name: "azure-content-safety",
    url: `${joinUrl(endpoint, config.path ?? DEFAULT_AZURE_PATH)}?api-version=${encodeURIComponent(
      config.apiVersion ?? DEFAULT_AZURE_API_VERSION,
    )}`,
    headers: { "Ocp-Apim-Subscription-Key": apiKey },
    timeoutMs: config.timeoutMs ?? 3000,
    retries: config.retries ?? 1,
    // The analyze endpoint takes exactly one `text`; batching would silently
    // drop every request after the first.
    batch: false,
    buildRequest:
      config.buildRequest ??
      ((requests) => ({
        text: requests[0]?.content ?? "",
        categories,
        outputType: "FourSeverityLevels",
      })),
    mapVerdict:
      config.mapVerdict ?? ((response, requests) => azureVerdicts(response, requests, requested, threshold)),
  });

  return createGuardrailPlugin({
    name: config.name ?? "azure-content-safety",
    transport,
    apply: config.apply,
    mode: config.mode,
    failClosed: config.failClosed,
    timeoutMs: config.timeoutMs ?? 3000,
    // Billed per call, so behind the free moderation check but ahead of the
    // signed Bedrock round trip.
    priority: config.priority ?? 23,
    cache: config.cache,
    metadata: config.metadata,
  });
}

// ─── AWS Bedrock ApplyGuardrail ──────────────────────────────────────────────

export type BedrockGuardrailConfig = {
  /** Guardrail id from Bedrock. */
  guardrailIdentifier: string;
  /** Guardrail version, e.g. `"1"` or `"DRAFT"`. */
  guardrailVersion: string;
  /** Defaults to `AWS_REGION`, then `AWS_DEFAULT_REGION`, then `us-east-1`. */
  region?: string;
  /** Defaults to the standard `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` / `AWS_SESSION_TOKEN` variables. */
  credentials?: SigV4Credentials;
  /** Override the runtime host (VPC endpoint, a local mock). */
  baseUrl?: string;
  apply?: GuardrailPhaseName[];
  mode?: "enforce" | "shadow";
  failClosed?: boolean;
  timeoutMs?: number;
  /** Retries after the first attempt. Default 1; each attempt is signed afresh. */
  retries?: number;
  priority?: number;
  cache?: boolean | { maxEntries?: number };
  metadata?: Record<string, unknown>;
  /** Escape hatch: build the wire request yourself. */
  buildRequest?: (request: GuardrailRequest, ctx: GuardrailCallContext) => unknown;
  /** Escape hatch: map the response to a verdict. */
  mapVerdict?: (response: unknown, request: GuardrailRequest) => GuardrailVerdict;
  name?: string;
};

const BEDROCK_RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);

/**
 * ApplyGuardrail speaks SigV4, which `httpGuardrail` cannot express: its
 * headers are resolved without the body, and a signature covers the body. So
 * the transport seam — not the plugin — is what gets a second implementation
 * here, and it is the smallest one that signs, times out, and honours the run's
 * cancellation.
 */
function bedrockTransport(options: {
  url: string;
  region: string;
  credentials: SigV4Credentials;
  timeoutMs: number;
  retries: number;
  buildRequest: (request: GuardrailRequest, ctx: GuardrailCallContext) => unknown;
  mapVerdict: (response: unknown, request: GuardrailRequest) => GuardrailVerdict;
}): GuardrailTransport {
  const send = async (request: GuardrailRequest, ctx: GuardrailCallContext): Promise<unknown> => {
    const fetchFn = typeof globalThis.fetch === "function" ? globalThis.fetch.bind(globalThis) : undefined;
    if (!fetchFn) throw new Error("Guardrail transport requires fetch to be available in this runtime.");

    const body = JSON.stringify(options.buildRequest(request, ctx)) ?? "";
    let lastError: unknown;

    for (let attempt = 0; attempt <= options.retries; attempt += 1) {
      // Re-signed per attempt: the signature covers `x-amz-date`, so a retry
      // that reused the first attempt's headers would drift out of the
      // acceptable clock skew window and fail as a 403 rather than a retry.
      const headers = signRequest({
        method: "POST",
        url: options.url,
        headers: { "content-type": "application/json" },
        body,
        region: options.region,
        service: "bedrock",
        credentials: options.credentials,
      });

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), options.timeoutMs);
      const onAbort = () => controller.abort();
      ctx.signal?.addEventListener("abort", onAbort, { once: true });

      let response: Response | undefined;
      let retryable = false;
      try {
        response = await fetchFn(options.url, { method: "POST", headers, body, signal: controller.signal });
      } catch (err) {
        lastError = new Error(`network error - ${err instanceof Error ? err.message : String(err)}`);
        retryable = true;
      } finally {
        clearTimeout(timer);
        ctx.signal?.removeEventListener("abort", onAbort);
      }

      if (response) {
        if (response.ok) return response.json();
        let text = "";
        try {
          text = await response.text();
        } catch {
          /* body is optional context */
        }
        lastError = new Error(
          `HTTP ${response.status}${response.statusText ? ` ${response.statusText}` : ""}${
            text ? ` - ${text.slice(0, 200)}` : ""
          }`,
        );
        retryable = BEDROCK_RETRYABLE_STATUS.has(response.status);
      }

      if (!retryable || attempt === options.retries) break;
      await new Promise((resolve) => setTimeout(resolve, 150 * (attempt + 1)));
    }

    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  };

  return {
    name: "bedrock-guardrail",
    async evaluate(requests, ctx) {
      const verdicts: GuardrailVerdict[] = [];
      // ApplyGuardrail judges one payload per call — there is no batch form.
      for (const request of requests) {
        verdicts.push(options.mapVerdict(await send(request, ctx), request));
      }
      return verdicts;
    },
  };
}

/**
 * Reads the intervention flag and the assessment list. As with Azure, these
 * field names are what the documentation describes and are UNVERIFIED here;
 * `buildRequest` / `mapVerdict` are the two places to correct.
 *
 * Intervention maps to `block`, never to `mask`, even though the response
 * carries the guardrail's own rewritten text: substituting it would need this
 * SDK to be sure the field means "safe replacement for the original" on every
 * phase, including a tool call whose content is JSON. `mapVerdict` is there for
 * teams who have confirmed that and want the masked text.
 */
function bedrockVerdict(response: unknown, _request: GuardrailRequest): GuardrailVerdict {
  const body = asRecord(response);
  if (!body) return { action: "allow", raw: response };
  const action = typeof body.action === "string" ? body.action.toUpperCase() : undefined;
  if (action !== "GUARDRAIL_INTERVENED") return { action: "allow", raw: response };

  const violations: GuardrailViolation[] = [];
  for (const assessment of Array.isArray(body.assessments) ? body.assessments : []) {
    const record = asRecord(assessment);
    if (!record) continue;
    for (const [group, value] of Object.entries(record)) {
      // Each assessment group (`topicPolicy`, `contentPolicy`, …) holds a list
      // of matches under its own key; the shared shape is the name/type field.
      const entries = Object.values(asRecord(value) ?? {}).find((candidate) => Array.isArray(candidate));
      for (const entry of Array.isArray(entries) ? entries : []) {
        const match = asRecord(entry);
        if (!match) continue;
        violations.push({
          type: typeof match.type === "string" ? match.type : group,
          id: typeof match.name === "string" ? match.name : undefined,
          severity: typeof match.confidence === "string" ? match.confidence : undefined,
          detail: typeof match.match === "string" ? match.match : undefined,
        });
      }
    }
  }

  const named = violations.map((violation) => violation.id ?? violation.type).filter(Boolean);
  return {
    action: "block",
    message: `Bedrock guardrail intervened${named.length > 0 ? `: ${named.join(", ")}` : "."}`,
    violations: violations.length > 0 ? violations : undefined,
    raw: response,
  };
}

/**
 * AWS Bedrock ApplyGuardrail. Signing is reused from the provider layer
 * (`src/providers/utils/sigv4.ts`) rather than reimplemented — one signer, one
 * place for a signing bug to be fixed.
 */
export function bedrockGuardrail(config: BedrockGuardrailConfig): AgentPlugin {
  if (!config?.guardrailIdentifier || !config?.guardrailVersion) {
    throw new Error("[agent-sdk] bedrockGuardrail requires both `guardrailIdentifier` and `guardrailVersion`.");
  }
  const region = config.region ?? process.env.AWS_REGION ?? process.env.AWS_DEFAULT_REGION ?? "us-east-1";
  const credentials: SigV4Credentials = config.credentials ?? {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID ?? "",
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY ?? "",
    sessionToken: process.env.AWS_SESSION_TOKEN,
  };
  if (!credentials.accessKeyId || !credentials.secretAccessKey) {
    throw new Error(
      "[agent-sdk] bedrockGuardrail requires AWS credentials (pass `credentials` or set AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY).",
    );
  }

  const base = config.baseUrl ?? `https://bedrock-runtime.${region}.amazonaws.com`;
  const url = joinUrl(
    base,
    `/guardrail/${encodeURIComponent(config.guardrailIdentifier)}/version/${encodeURIComponent(
      config.guardrailVersion,
    )}/apply`,
  );

  const transport = bedrockTransport({
    url,
    region,
    credentials,
    timeoutMs: config.timeoutMs ?? 3000,
    retries: Math.max(0, config.retries ?? 1),
    buildRequest:
      config.buildRequest ??
      ((request) => ({
        // Bedrock distinguishes the two directions and applies different
        // policies to each; a tool call is agent-produced, so it is graded on
        // the OUTPUT side.
        source: request.phase === "input" ? "INPUT" : "OUTPUT",
        content: [{ text: { text: request.content } }],
      })),
    mapVerdict: config.mapVerdict ?? bedrockVerdict,
  });

  return createGuardrailPlugin({
    name: config.name ?? "bedrock-guardrail",
    transport,
    apply: config.apply,
    mode: config.mode,
    failClosed: config.failClosed,
    timeoutMs: config.timeoutMs ?? 3000,
    // Last of the network guardrails: a signed round trip is the most
    // expensive check in the band, so it benefits most from an earlier deny.
    priority: config.priority ?? 24,
    cache: config.cache,
    metadata: config.metadata,
  });
}

// ─── In-process regex guardrail ──────────────────────────────────────────────

export type RegexGuardrailConfig = {
  /** Any match denies the turn. */
  block?: RegExp[];
  /** Applied in order; a changed text becomes a `mask` verdict. */
  mask?: Array<{ pattern: RegExp; replacement: string }>;
  apply?: GuardrailPhaseName[];
  mode?: "enforce" | "shadow";
  failClosed?: boolean;
  priority?: number;
  cache?: boolean | { maxEntries?: number };
  metadata?: Record<string, unknown>;
  name?: string;
};

/**
 * `g` and `y` make a regex stateful: `lastIndex` survives the call, so the same
 * detector object reused on a second string starts scanning from wherever the
 * first one stopped and quietly misses a match. The fix piiRedaction documents
 * is a fresh instance per pass — here the test path additionally drops those
 * two flags, because `test()` has no reason to advance a cursor at all.
 */
function matchesAnywhere(pattern: RegExp, text: string): boolean {
  return new RegExp(pattern.source, pattern.flags.replace(/[gy]/g, "")).test(text);
}

/**
 * `g` is forced on for masking for the opposite reason: without it `replace`
 * substitutes only the first hit while the verdict claims the whole text was
 * covered.
 */
function applyMasks(text: string, masks: Array<{ pattern: RegExp; replacement: string }>): {
  text: string;
  hits: GuardrailViolation[];
} {
  let output = text;
  const hits: GuardrailViolation[] = [];
  for (const rule of masks) {
    const flags = rule.pattern.flags.includes("g") ? rule.pattern.flags : `${rule.pattern.flags}g`;
    const pattern = new RegExp(rule.pattern.source, flags);
    let count = 0;
    // A function replacer, not the string form: `$&`, `$1` and friends inside a
    // caller's replacement would otherwise be expanded as substitution
    // patterns, so a literal "$100" would silently become something else.
    output = output.replace(pattern, () => {
      count += 1;
      return rule.replacement;
    });
    if (count > 0) hits.push({ type: String(rule.pattern), detail: `${count} match${count === 1 ? "" : "es"}` });
  }
  return { text: output, hits };
}

/**
 * A guardrail with no service behind it. The point is adoption order: a team
 * can put the plugin, its phases, its shadow mode and its incident events in
 * place today with a list of patterns, then swap the transport for a real
 * service later without touching anything else in the agent.
 */
export function regexGuardrail(config: RegexGuardrailConfig = {}): AgentPlugin {
  const blockPatterns = config.block ?? [];
  const maskRules = config.mask ?? [];

  const transport = customGuardrail((request) => {
    // Blocking wins over masking: a rule that says "this must never appear"
    // cannot be satisfied by rewriting the text around it.
    const blocked = blockPatterns.filter((pattern) => matchesAnywhere(pattern, request.content));
    if (blocked.length > 0) {
      return {
        action: "block",
        message: `Blocked by local pattern policy: ${blocked.map(String).join(", ")}.`,
        violations: blocked.map((pattern) => ({ type: String(pattern) })),
      };
    }

    if (maskRules.length === 0) return { action: "allow" };
    const masked = applyMasks(request.content, maskRules);
    if (masked.hits.length === 0) return { action: "allow" };
    return {
      action: "mask",
      maskedContent: masked.text,
      message: `Masked by local pattern policy: ${masked.hits.map((hit) => hit.type).join(", ")}.`,
      violations: masked.hits,
    };
  }, "regex");

  return createGuardrailPlugin({
    name: config.name ?? "regex-guardrail",
    transport,
    apply: config.apply,
    mode: config.mode,
    failClosed: config.failClosed,
    // Ahead of every network guardrail (20-25): a violation this can catch
    // locally should never be shipped to a third-party service to be judged,
    // and the check itself costs no round trip.
    priority: config.priority ?? 18,
    cache: config.cache,
    metadata: config.metadata,
  });
}
