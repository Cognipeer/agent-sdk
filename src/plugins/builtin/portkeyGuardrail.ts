/**
 * Portkey — two integration shapes, because Portkey supports two.
 *
 *   Gateway    all model traffic flows through Portkey and its guardrails run
 *              on their hop. No extra latency, but it only covers model calls —
 *              tool arguments and tool output never reach it.
 *   Standalone the model talks to its provider directly and we call Portkey's
 *              guardrail API ourselves. Full coverage including the tool
 *              surface, at the cost of an extra round trip per checked turn.
 *
 * Gateway mode is deliberately NOT a `wrapModel` contribution. Retargeting an
 * arbitrary already-constructed model object is guesswork; building the
 * provider config that points at the gateway is exact. `portkeyGateway()`
 * returns that config.
 */

import type { AgentPlugin } from "../types.js";
import type { OpenAICompatibleProviderConfig } from "../../providers/types.js";
import {
  createGuardrailPlugin,
  httpGuardrail,
  normalizeVerdicts,
  type GuardrailCallContext,
  type GuardrailPhaseName,
  type GuardrailRequest,
  type GuardrailVerdict,
} from "./guardrail.js";

const DEFAULT_PORTKEY_BASE_URL = "https://api.portkey.ai/v1";

export type PortkeyGatewayConfig = {
  /** Defaults to `PORTKEY_API_KEY`. */
  apiKey?: string;
  /** Portkey config id carrying the guardrail attachment. */
  configId?: string;
  /** Portkey virtual key for the upstream provider credentials. */
  virtualKey?: string;
  baseURL?: string;
  defaultModel?: string;
  /** Merged last, so it can override anything above. */
  headers?: Record<string, string>;
};

/**
 * Build the provider config that routes model traffic through the Portkey
 * gateway. Hand the result to `createProvider`:
 *
 *   const model = fromNativeProvider(createProvider(portkeyGateway({ configId })));
 */
export function portkeyGateway(config: PortkeyGatewayConfig = {}): OpenAICompatibleProviderConfig {
  const apiKey = config.apiKey ?? process.env.PORTKEY_API_KEY;
  if (!apiKey) {
    throw new Error("[agent-sdk] portkeyGateway requires an apiKey (pass `apiKey` or set PORTKEY_API_KEY).");
  }
  return {
    provider: "openai-compatible",
    // The gateway authenticates with its own header; the upstream credential
    // travels as a virtual key, so this field only has to be non-empty.
    apiKey,
    baseURL: config.baseURL ?? DEFAULT_PORTKEY_BASE_URL,
    defaultModel: config.defaultModel,
    defaultHeaders: {
      "x-portkey-api-key": apiKey,
      ...(config.configId ? { "x-portkey-config": config.configId } : {}),
      ...(config.virtualKey ? { "x-portkey-virtual-key": config.virtualKey } : {}),
      ...(config.headers ?? {}),
    },
  };
}

export type PortkeyGuardrailConfig = {
  /** Defaults to `PORTKEY_API_KEY`. */
  apiKey?: string;
  baseUrl?: string;
  /** Path of the guardrail evaluation endpoint. */
  path?: string;
  /** Guardrail / check ids to run. */
  checks?: string[];
  apply?: GuardrailPhaseName[];
  mode?: "enforce" | "shadow";
  failClosed?: boolean;
  timeoutMs?: number;
  retries?: number;
  priority?: number;
  batch?: boolean;
  cache?: boolean | { maxEntries?: number };
  metadata?: Record<string, unknown>;
  /** Escape hatch for the exact wire shape. */
  buildRequest?: (requests: GuardrailRequest[], ctx: GuardrailCallContext) => unknown;
  mapVerdict?: (response: unknown, requests: GuardrailRequest[]) => GuardrailVerdict[];
  name?: string;
};

/**
 * Standalone-mode Portkey guardrails. Covers the tool surface that gateway mode
 * cannot see, so the two are complementary rather than alternatives — running
 * gateway for model traffic and this for tools is a valid configuration.
 */
export function portkeyGuardrail(config: PortkeyGuardrailConfig = {}): AgentPlugin {
  const apiKey = config.apiKey ?? process.env.PORTKEY_API_KEY;
  if (!apiKey) {
    throw new Error("[agent-sdk] portkeyGuardrail requires an apiKey (pass `apiKey` or set PORTKEY_API_KEY).");
  }
  const base = (config.baseUrl ?? DEFAULT_PORTKEY_BASE_URL).replace(/\/+$/, "");
  const path = config.path ?? "/guardrails/evaluate";

  const transport = httpGuardrail({
    name: "portkey",
    url: `${base}${path.startsWith("/") ? path : `/${path}`}`,
    headers: { "x-portkey-api-key": apiKey },
    timeoutMs: config.timeoutMs ?? 3000,
    retries: config.retries ?? 1,
    batch: config.batch,
    buildRequest:
      config.buildRequest ??
      ((requests, ctx) => ({
        checks: config.checks,
        traceId: ctx.traceId,
        items: requests.map((request) => ({
          type: request.phase,
          text: request.content,
          subject: request.subject,
          metadata: request.metadata,
        })),
      })),
    mapVerdict: config.mapVerdict ?? normalizeVerdicts,
  });

  return createGuardrailPlugin({
    name: config.name ?? "portkey-guardrail",
    transport,
    apply: config.apply,
    mode: config.mode,
    failClosed: config.failClosed,
    timeoutMs: config.timeoutMs ?? 3000,
    priority: config.priority ?? 25,
    cache: config.cache,
    metadata: config.metadata,
  });
}
