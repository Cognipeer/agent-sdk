/**
 * TraceSessionFile to OTLP/JSON: a pure function, no I/O.
 *
 * The rules that make the output honest, whichever attribute vocabulary is on:
 *
 * - Timing. A record is stamped when it COMPLETES, so a span is
 *   [timestamp - durationMs, timestamp]. A span that holds others (iteration,
 *   sub-agent, the root) is widened to cover its exported children: containers
 *   are stamped at their start, or carry the wall-clock extent of a run that
 *   waited for a human. Nanoseconds are BigInt arithmetic, never a float.
 * - Status. UNSET for everything that is not a failure (success, skipped, retry,
 *   pending): a denied tool or a paused approval is a decision, not an error, and
 *   OK is reserved for an application that vouches for the outcome. ERROR only
 *   for `error`, with `error.type` and one `exception` event on that span. The
 *   root is ERROR only for a session-level error.
 * - Legs. A run that paused is exported leg by leg. Only the terminal leg carries
 *   the root span (OTLP cannot take a span back, so a root per leg would repeat
 *   one span id), and a sub-agent span that is still `pending` is held back: the
 *   segment that ends the run records it again under the same id.
 */

import type {
  TraceDataSection,
  TraceErrorRecord,
  TraceEventRecord,
  TraceSessionFile,
} from "../../types.js";
import { SDK_VERSION } from "../../version.js";
import { foldSupersededSpans, generateSpanId, generateTraceId } from "../tracing.js";
import type {
  OtlpConvertOptions,
  OtlpExportTraceServiceRequest,
  OtlpKeyValue,
  OtlpSpan,
  OtlpSpanEvent,
} from "./types.js";
import { ATTR, OPERATION, errorTypeOf, genAiProviderName, genAiUsageOf, type EnrichedUsage } from "./semconv.js";

export const SCOPE_NAME = "cognipeer-agent-sdk";

const SPAN_KIND_INTERNAL = 1;
const SPAN_KIND_CLIENT = 3;
/** W3C sampled bit plus the OTLP "parent is known" bit; 0x200 more when the parent is remote. */
const FLAGS_LOCAL = 0x101;
const FLAGS_REMOTE = 0x301;
const MAX_STATUS_MESSAGE = 1024;

/**
 * Optional record fields a later enrichment fills in (response facts, skip
 * reasons, provider-supplied tool call ids). The converter reads them when
 * present and works without them.
 */
type EventView = TraceEventRecord & EnrichedUsage & {
  responseId?: string;
  responseModel?: string;
  rawFinishReason?: string;
  streaming?: boolean;
  outputType?: "text" | "json";
  toolCallId?: string;
  skipReason?: string;
  error?: { message: string; stack?: string; type?: string } | null;
};

type SessionError = TraceErrorRecord & { errorName?: string };

type Node = {
  event: EventView;
  spanId: string;
  parentId: string;
  startNs: bigint;
  endNs: bigint;
};

// ─── Attribute helpers ─────────────────────────────────────────────────────

const str = (key: string, value: string | undefined | null): OtlpKeyValue | null =>
  value != null && value !== "" ? { key, value: { stringValue: value } } : null;
/** Kept for legacy parity: an empty string was an emitted value for the cognipeer keys. */
const strAllowEmpty = (key: string, value: string | undefined | null): OtlpKeyValue | null =>
  value != null ? { key, value: { stringValue: value } } : null;
const int = (key: string, value: number | undefined | null): OtlpKeyValue | null =>
  typeof value === "number" && Number.isFinite(value) ? { key, value: { intValue: String(Math.trunc(value)) } } : null;
const dbl = (key: string, value: number | undefined | null): OtlpKeyValue | null =>
  typeof value === "number" && Number.isFinite(value) ? { key, value: { doubleValue: value } } : null;
const bool = (key: string, value: boolean | undefined | null): OtlpKeyValue | null =>
  typeof value === "boolean" ? { key, value: { boolValue: value } } : null;
const strArray = (key: string, values: string[]): OtlpKeyValue => ({
  key,
  value: { arrayValue: { values: values.map((value) => ({ stringValue: value })) } },
});
const compact = (list: Array<OtlpKeyValue | null | undefined>): OtlpKeyValue[] =>
  list.filter((entry): entry is OtlpKeyValue => Boolean(entry));

// ─── Time ──────────────────────────────────────────────────────────────────

/** Whole nanoseconds from epoch milliseconds, without passing through a float product. */
function msToNs(ms: number): bigint {
  const whole = Math.floor(ms);
  return BigInt(whole) * 1_000_000n + BigInt(Math.round((ms - whole) * 1_000_000));
}

function parseMs(iso: string | undefined): number | undefined {
  if (!iso) return undefined;
  const value = Date.parse(iso);
  return Number.isNaN(value) ? undefined : value;
}

function durationNs(durationMs: unknown): bigint {
  return typeof durationMs === "number" && Number.isFinite(durationMs) && durationMs > 0 ? msToNs(durationMs) : 0n;
}

// ─── Classification ────────────────────────────────────────────────────────

type SpanClass = "chat" | "execute_tool" | "invoke_agent" | "plain";

/**
 * Which GenAI operation a record is, if any. A span claims an operation only when
 * it actually started: a call a plugin blocked, a tool a policy denied, a cache
 * hit or a short-circuited result are plain INTERNAL spans.
 */
function classify(event: EventView): SpanClass {
  if (event.type === "ai_call" || event.type === "summarization") {
    if (event.skipReason === "cancelled") return "chat";
    if (event.skipReason || event.status === "skipped") return "plain";
    return "chat";
  }
  if (event.type === "tool_call") {
    const source = (event.debug as { shortCircuitSource?: string } | undefined)?.shortCircuitSource;
    if (event.skipReason || event.status === "skipped" || source === "cache" || source === "plugin") return "plain";
    return "execute_tool";
  }
  if (event.type === "span" && event.actor?.role === "subagent") return "invoke_agent";
  return "plain";
}

const knownModel = (model: string | undefined): string | undefined =>
  model && model !== "unknown-model" ? model : undefined;

function toolNameOf(event: EventView): string | undefined {
  if (event.actor?.name) return event.actor.name;
  const label = event.label.replace(/\s#\d+$/, "");
  const dash = label.indexOf(" - ");
  return dash >= 0 ? label.slice(dash + 3) : undefined;
}

const stripSequence = (label: string): string => label.replace(/\s#\d+$/, "");

function cappedMessage(message: string | undefined): string {
  const text = message && message.length > 0 ? message : "Unknown error";
  return text.length > MAX_STATUS_MESSAGE ? text.slice(0, MAX_STATUS_MESSAGE) : text;
}

function exceptionEvent(
  timeNs: bigint,
  error: { message?: string; stack?: string; type?: string },
): OtlpSpanEvent {
  return {
    timeUnixNano: timeNs.toString(),
    name: "exception",
    attributes: compact([
      str("exception.type", errorTypeOf(error)),
      strAllowEmpty("exception.message", error.message ?? "Unknown error"),
      str("exception.stacktrace", error.stack),
    ]),
  };
}

// ─── Conversion ────────────────────────────────────────────────────────────

export function sessionToOtlp(file: TraceSessionFile, options: OtlpConvertOptions): OtlpExportTraceServiceRequest {
  const useCognipeer = options.semconv !== "gen_ai";
  const useGenAi = options.semconv !== "cognipeer";

  const traceId = file.traceId || generateTraceId();
  const rootSpanId = file.rootSpanId || generateSpanId();
  const parent = options.parent;
  const traceState = parent?.traceState || undefined;
  const flags = parent?.remote ? FLAGS_REMOTE : FLAGS_LOCAL;
  const agentName = file.agent?.name;

  // Records that are exported. A sub-agent span still `pending` is held back for
  // the segment that ends its run (see foldSupersededSpans).
  const everyEvent = file.events as EventView[];
  const exportedEvents = foldSupersededSpans(everyEvent).filter(
    (event) => !(event.type === "span" && event.status === "pending"),
  );

  const startMs = parseMs(file.startedAt);
  const nodes: Node[] = exportedEvents.map((event) => {
    const endMs = parseMs(event.timestamp) ?? startMs ?? Date.now();
    const endNs = msToNs(endMs);
    let startNs = endNs - durationNs(event.durationMs);
    if (startNs < 0n) startNs = 0n;
    return {
      event,
      spanId: event.spanId || generateSpanId(),
      parentId: event.parentSpanId || rootSpanId,
      startNs,
      endNs,
    };
  });

  // Containers cover their children, bottom-up.
  const childrenOf = new Map<string, Node[]>();
  for (const node of nodes) {
    const list = childrenOf.get(node.parentId);
    if (list) list.push(node);
    else childrenOf.set(node.parentId, [node]);
  }
  const settled = new Set<Node>();
  const inProgress = new Set<Node>();
  const widen = (node: Node): void => {
    if (settled.has(node) || inProgress.has(node)) return;
    inProgress.add(node);
    for (const child of childrenOf.get(node.spanId) ?? []) {
      if (child === node) continue;
      widen(child);
      if (child.startNs < node.startNs) node.startNs = child.startNs;
      if (child.endNs > node.endNs) node.endNs = child.endNs;
    }
    inProgress.delete(node);
    settled.add(node);
  };
  for (const node of nodes) widen(node);

  // Who owns a span, for gen_ai.agent.name on a tool: the nearest sub-agent
  // span above it, else the root agent. Looked up over every record, withheld
  // ones included, since a pending span still names its agent.
  const byId = new Map<string, EventView>();
  for (const event of everyEvent) if (event.spanId) byId.set(event.spanId, event);
  const agentOf = (event: EventView): string | undefined => {
    let cursor: EventView | undefined = event;
    for (let hops = 0; cursor && hops < 64; hops++) {
      if (cursor !== event && cursor.type === "span" && cursor.actor?.role === "subagent") return cursor.actor.name;
      cursor = cursor.parentSpanId ? byId.get(cursor.parentSpanId) : undefined;
    }
    return agentName;
  };

  const spans: OtlpSpan[] = [];

  // ── Root (terminal legs only) ───────────────────────────────────────────
  const sessionErrors = ((file.errors ?? []) as SessionError[]).filter((error) => error.eventId === "session");
  if (options.terminal) {
    const earliestChild = nodes.reduce<bigint | undefined>(
      (earliest, node) => (earliest === undefined || node.startNs < earliest ? node.startNs : earliest),
      undefined,
    );
    // The first part's start (the continuation keeps it), else the earliest child.
    let rootStart = startMs !== undefined ? msToNs(startMs) : earliestChild ?? msToNs(Date.now());
    let rootEnd = msToNs(parseMs(file.endedAt) ?? (startMs !== undefined ? startMs + (file.durationMs ?? 0) : Date.now()));
    for (const node of childrenOf.get(rootSpanId) ?? []) {
      if (node.startNs < rootStart) rootStart = node.startNs;
      if (node.endNs > rootEnd) rootEnd = node.endNs;
    }
    if (rootEnd < rootStart) rootEnd = rootStart;

    const rootName = useGenAi
      ? agentName ? `${OPERATION.invokeAgent} ${agentName}` : OPERATION.invokeAgent
      : `agent_session: ${agentName || "agent"}`;

    const summary = file.summary;
    const cumulativeEvents = summary?.eventCounts
      ? Object.values(summary.eventCounts).reduce((total, count) => total + (Number(count) || 0), 0)
      : file.events.length;

    const attributes: OtlpKeyValue[] = [];
    if (useCognipeer) {
      attributes.push(
        ...compact([
          strAllowEmpty("cognipeer.session.status", options.cancelled ? "partial" : file.status),
          dbl("cognipeer.session.duration_ms", file.durationMs),
          int("cognipeer.session.total_input_tokens", summary?.totalInputTokens),
          int("cognipeer.session.total_output_tokens", summary?.totalOutputTokens),
          int("cognipeer.session.total_cached_input_tokens", summary?.totalCachedInputTokens),
          int("cognipeer.session.total_bytes_in", summary?.totalBytesIn),
          int("cognipeer.session.total_bytes_out", summary?.totalBytesOut),
          int("cognipeer.session.event_count", cumulativeEvents),
        ]),
      );
      for (const [key, count] of Object.entries(summary?.eventCounts ?? {})) {
        attributes.push({ key: `cognipeer.session.event_count.${key}`, value: { intValue: String(count) } });
      }
    }
    if (useGenAi) {
      attributes.push(
        ...compact([
          str(ATTR.operationName, OPERATION.invokeAgent),
          str(ATTR.agentName, agentName),
          str(ATTR.agentVersion, file.agent?.version),
          str(ATTR.requestModel, knownModel(file.agent?.model)),
          str(ATTR.conversationId, file.threadId),
        ]),
      );
    }

    const root: OtlpSpan = {
      traceId,
      spanId: rootSpanId,
      parentSpanId: parent?.spanId ?? "",
      ...(traceState ? { traceState } : {}),
      flags,
      name: rootName,
      kind: SPAN_KIND_INTERNAL,
      startTimeUnixNano: rootStart.toString(),
      endTimeUnixNano: rootEnd.toString(),
      attributes,
      status: { code: 0 },
    };

    if (sessionErrors.length > 0) {
      root.status = {
        code: 2,
        message: cappedMessage(sessionErrors.map((error) => error.message).join("; ")),
      };
      if (useGenAi) root.attributes.push({ key: ATTR.errorType, value: { stringValue: errorTypeOf({ type: sessionErrors[0].errorName, stack: sessionErrors[0].stack }) } });
      root.events = sessionErrors.map((error) => {
        const at = parseMs(error.timestamp);
        return exceptionEvent(at !== undefined ? msToNs(at) : rootEnd, {
          message: error.message,
          stack: error.stack,
          type: error.errorName,
        });
      });
    }
    spans.push(root);
  }

  // ── Events ──────────────────────────────────────────────────────────────
  for (const node of nodes) {
    const event = node.event;
    const kind = classify(event);
    const failed = event.status === "error";
    const cancelledChat = kind === "chat" && event.skipReason === "cancelled";

    const attributes: OtlpKeyValue[] = [];
    if (useCognipeer) {
      attributes.push(
        ...compact([
          strAllowEmpty("cognipeer.event.type", event.type),
          strAllowEmpty("cognipeer.event.label", event.label),
          int("cognipeer.event.sequence", event.sequence),
          strAllowEmpty("cognipeer.actor.scope", event.actor?.scope),
          strAllowEmpty("cognipeer.actor.name", event.actor?.name),
          strAllowEmpty("cognipeer.actor.role", event.actor?.role),
          strAllowEmpty("cognipeer.model", event.model),
          int("cognipeer.tokens.reasoning", event.reasoningTokens),
          strAllowEmpty("cognipeer.finish_reason", event.finishReason),
          strAllowEmpty("cognipeer.provider", event.provider),
          strAllowEmpty("cognipeer.tool.details", event.toolDetails ? JSON.stringify(event.toolDetails) : undefined),
          int("cognipeer.tokens.input", event.inputTokens),
          int("cognipeer.tokens.output", event.outputTokens),
          int("cognipeer.tokens.total", event.totalTokens),
          int("cognipeer.tokens.cached_input", event.cachedInputTokens),
          int("cognipeer.bytes.request", event.requestBytes),
          int("cognipeer.bytes.response", event.responseBytes),
          strAllowEmpty("cognipeer.tool.execution_id", event.toolExecutionId),
          strAllowEmpty("cognipeer.retry_of", event.retryOf),
          strAllowEmpty("cognipeer.event.id", event.id),
        ]),
      );
      const sections: TraceDataSection[] | undefined = event.data?.sections;
      if (sections && sections.length > 0) {
        try {
          attributes.push({ key: "cognipeer.sections", value: { stringValue: JSON.stringify(sections) } });
        } catch {
          // Unserializable sections are dropped, as before.
        }
      }
      attributes.push({ key: "cognipeer.event.status", value: { stringValue: event.status } });
    }

    let name = event.label || event.type;
    let spanKind = SPAN_KIND_INTERNAL;
    if (kind === "chat") spanKind = SPAN_KIND_CLIENT;

    if (useGenAi) {
      const conversation = str(ATTR.conversationId, file.threadId);
      if (kind === "chat") {
        const model = knownModel(event.model);
        name = model ? `${OPERATION.chat} ${model}` : OPERATION.chat;
        attributes.push(
          ...compact([
            str(ATTR.operationName, OPERATION.chat),
            str(ATTR.providerName, genAiProviderName(event.provider)),
            str(ATTR.requestModel, model),
            str(ATTR.responseModel, event.responseModel),
            str(ATTR.responseId, event.responseId),
            bool(ATTR.requestStream, event.streaming),
            str(ATTR.outputType, event.outputType),
          ]),
        );
        if (failed || cancelledChat) {
          attributes.push(strArray(ATTR.finishReasons, ["error"]));
        } else {
          const reason = event.rawFinishReason ?? event.finishReason;
          if (reason) attributes.push(strArray(ATTR.finishReasons, [reason]));
        }
        const usageAllowed = !failed && !cancelledChat && (event.type !== "summarization" || event.debug?.usageFromModel === true);
        const usage = usageAllowed ? genAiUsageOf(event) : undefined;
        if (usage) {
          attributes.push(
            ...compact([
              int(ATTR.usageInput, usage.input),
              int(ATTR.usageOutput, usage.output),
              int(ATTR.usageCacheRead, usage.cacheRead),
              int(ATTR.usageCacheWrite, usage.cacheWrite),
              int(ATTR.usageReasoning, usage.reasoning),
            ]),
          );
        }
        if (conversation) attributes.push(conversation);
      } else if (kind === "execute_tool") {
        const tool = toolNameOf(event);
        name = tool ? `${OPERATION.executeTool} ${tool}` : OPERATION.executeTool;
        attributes.push(
          ...compact([
            str(ATTR.operationName, OPERATION.executeTool),
            str(ATTR.toolName, tool),
            str(ATTR.toolCallId, event.toolCallId),
            str(ATTR.toolType, "function"),
            str(ATTR.agentName, agentOf(event)),
            conversation,
          ]),
        );
      } else if (kind === "invoke_agent") {
        const child = event.actor?.name;
        name = child ? `${OPERATION.invokeAgent} ${child}` : OPERATION.invokeAgent;
        attributes.push(...compact([str(ATTR.operationName, OPERATION.invokeAgent), str(ATTR.agentName, child), conversation]));
      } else {
        name = stripSequence(name);
      }
    }

    const span: OtlpSpan = {
      traceId: event.traceId || traceId,
      spanId: node.spanId,
      parentSpanId: node.parentId,
      ...(traceState ? { traceState } : {}),
      flags,
      name,
      kind: spanKind,
      startTimeUnixNano: node.startNs.toString(),
      endTimeUnixNano: node.endNs.toString(),
      attributes,
      status: { code: 0 },
    };

    if (failed) {
      const error = event.error ?? { message: "Unknown error" };
      span.status = { code: 2, message: cappedMessage(error.message) };
      if (useGenAi) attributes.push({ key: ATTR.errorType, value: { stringValue: errorTypeOf(error) } });
      span.events = [exceptionEvent(node.endNs, error)];
    }
    spans.push(span);
  }

  return {
    resourceSpans: [
      {
        resource: { attributes: resourceAttributesOf(file, options, useCognipeer) },
        scopeSpans: [{ scope: { name: SCOPE_NAME, version: SDK_VERSION }, spans }],
      },
    ],
  };
}

function resourceAttributesOf(file: TraceSessionFile, options: OtlpConvertOptions, useCognipeer: boolean): OtlpKeyValue[] {
  const custom = options.resourceAttributes ?? {};
  const serviceName = options.serviceName || custom["service.name"] || file.agent?.name || "cognipeer-agent";
  const attributes: OtlpKeyValue[] = compact([
    str("service.name", serviceName),
    str("service.version", file.agent?.version),
  ]);
  if (useCognipeer) {
    attributes.push(
      ...compact([
        str("cognipeer.session.id", file.sessionId),
        str("cognipeer.thread.id", file.threadId),
        str("cognipeer.agent.model", file.agent?.model),
        str("cognipeer.agent.provider", file.agent?.provider),
        ...Object.entries(file.metadata ?? {}).map(([key, value]) => str(`cognipeer.metadata.${key}`, value)),
      ]),
    );
  }
  attributes.push(
    ...compact([
      str("telemetry.sdk.name", SCOPE_NAME),
      str("telemetry.sdk.language", "nodejs"),
      str("telemetry.sdk.version", SDK_VERSION),
    ]),
  );
  for (const [key, value] of Object.entries(custom)) {
    if (key === "service.name") continue;
    const index = attributes.findIndex((attr) => attr.key === key);
    const entry = str(key, value);
    if (!entry) continue;
    if (index >= 0) attributes[index] = entry;
    else attributes.push(entry);
  }
  return attributes;
}

/** Number of spans a request carries. */
export function countSpans(request: OtlpExportTraceServiceRequest): number {
  let total = 0;
  for (const rs of request.resourceSpans) for (const ss of rs.scopeSpans) total += ss.spans.length;
  return total;
}
