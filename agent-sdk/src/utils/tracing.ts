import fs from "node:fs";
import path from "node:path";
import { Buffer } from "node:buffer";
import { nanoid } from "nanoid";
import type {
  AgentRuntimeConfig,
  ResolvedTraceConfig,
  ResolvedTraceSink,
  SmartAgentOptions,
  SmartAgentTracingConfig,
  TraceDataSection,
  TraceErrorRecord,
  TraceEventRecord,
  TraceSessionConfigSnapshot,
  TraceSessionFile,
  TraceSessionRuntime,
  TraceSessionStatus,
  TraceSessionSummary,
  TraceSinkConfig,
  TraceSinkSnapshot,
  TraceToolCallSection,
} from "../types.js";

const DEFAULT_COGNIPEER_URL = "https://api.cognipeer.com/v1/client/tracing/sessions";

export function fileSink(path?: string): TraceSinkConfig {
  return { type: "file", path };
}

type CustomSinkArg =
  | ((event: TraceEventRecord) => void | Promise<void>)
  | {
    onEvent?: (event: TraceEventRecord) => void | Promise<void>;
    onSession?: (session: TraceSessionFile) => void | Promise<void>;
  };

export function customSink(handler: CustomSinkArg): TraceSinkConfig {
  if (typeof handler === "function") {
    return { type: "custom", onEvent: handler };
  }
  return {
    type: "custom",
    onEvent: typeof handler?.onEvent === "function" ? handler.onEvent : undefined,
    onSession: typeof handler?.onSession === "function" ? handler.onSession : undefined,
  };
}

export function cognipeerSink(apiKey: string): TraceSinkConfig;
export function cognipeerSink(url: string | undefined, apiKey: string): TraceSinkConfig;
export function cognipeerSink(first: string | undefined, second?: string): TraceSinkConfig {
  if (second === undefined) {
    const apiKey = first ?? "";
    return { type: "cognipeer", apiKey };
  }
  const url = typeof first === "string" && first.trim().length > 0 ? first.trim() : undefined;
  return { type: "cognipeer", url, apiKey: second };
}

export function httpSink(url: string, headers?: Record<string, string>): TraceSinkConfig {
  return { type: "http", url, headers };
}
function resolveLogsBaseDir(customPath?: string, ensureDirectory = true) {
  const root = process.cwd();
  const base = customPath && customPath.trim().length > 0 ? customPath : path.join(root, "logs");
  if (ensureDirectory) {
    ensureDir(base);
  }
  return base;
}

function coerceToString(value: unknown): string | undefined {
  if (value == null) return undefined;
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  if (typeof value === "function" && value.length === 0) {
    try {
      return coerceToString((value as () => unknown)());
    } catch {
      return undefined;
    }
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      const normalized = coerceToString(item);
      if (normalized) return normalized;
    }
    return undefined;
  }
  return undefined;
}

function firstNonEmptyString(...candidates: Array<unknown>): string | undefined {
  for (const candidate of candidates) {
    const normalized = coerceToString(candidate);
    if (normalized) return normalized;
  }
  return undefined;
}

export function getModelName(model: any): string | undefined {
  if (!model) return undefined;

  const maybeLc = model?._lc;
  const direct = firstNonEmptyString(
    model?.model,
    model?.options?.model,
    model?.params?.model,
    model?.config?.model,
    model?.configuration?.model,
    model?.metadata?.model,
    model?.lc_kwargs?.model,
    maybeLc?.model,
    maybeLc?.options?.model,
    maybeLc?.params?.model,
    maybeLc?.config?.model,
    maybeLc?.configuration?.model,
    maybeLc?.metadata?.model,
    maybeLc?.lc_kwargs?.model,
    model?.metadata?.modelName,
    maybeLc?.metadata?.modelName,
    model?.modelName,
    maybeLc?.modelName,
    model?.lc_alias,
    model?.model_id,
    model?.id,
    maybeLc?.model_id,
    maybeLc?.id,
    model?._model,
    model?._modelName,
    model?.__model
  );
  if (direct) return direct;

  const maybeClient = model?.client || model?.api || model?.service;
  const clientValue = firstNonEmptyString(
    maybeClient?.model,
    maybeClient?.config?.model,
    maybeClient?.options?.model,
    maybeClient?.default?.model
  );
  if (clientValue) return clientValue;

  const fnNames = firstNonEmptyString(model?._modelId, model?._llmType, maybeLc?._modelId, maybeLc?._llmType, model?.constructor?.name);
  return fnNames;
}

export function getProviderName(model: any): string | undefined {
  if (!model) return undefined;

  const direct = firstNonEmptyString(
    model?.provider,
    model?.options?.provider,
    model?.params?.provider,
    model?.config?.provider,
    model?.configuration?.provider,
    model?.metadata?.provider,
    model?.lc_kwargs?.provider,
    model?.lc_alias,
    model?.__provider
  );
  if (direct) return direct;

  const maybeLc = model?._lc;
  const lcValue = maybeLc
    ? firstNonEmptyString(
      maybeLc?.provider,
      maybeLc?.options?.provider,
      maybeLc?.config?.provider,
      maybeLc?.configuration?.provider,
      maybeLc?.metadata?.provider,
      maybeLc?.lc_kwargs?.provider,
      maybeLc?.client?.config?.provider
    )
    : undefined;
  if (lcValue) return lcValue;

  const maybeClient = model?.client || model?.api || model?.service;
  return firstNonEmptyString(
    maybeClient?.provider,
    maybeClient?.config?.provider,
    maybeClient?.options?.provider,
    maybeClient?.metadata?.provider
  );
}

function inferModelFromMessages(messageList?: any[]): string | undefined {
  if (!Array.isArray(messageList)) return undefined;
  for (let i = messageList.length - 1; i >= 0; i -= 1) {
    const message = messageList[i];
    if (!message) continue;
    const candidate = firstNonEmptyString(
      message?.metadata?.model,
      message?.metadata?.modelName,
      message?.metadata?.modelNames,
      message?.metadata?.model_id,
      message?.response_metadata?.model,
      message?.response_metadata?.modelName,
      message?.response_metadata?.modelNames,
      message?.response_metadata?.model_id,
      message?.usage_metadata?.model,
      message?.model,
      message?.modelName,
      message?.model_id,
      message?.additional_kwargs?.model,
      message?.additional_kwargs?.modelName,
      message?.info?.model,
      message?.annotations?.model
    );
    if (candidate) return candidate;
  }
  return undefined;
}

function inferProviderFromMessages(messageList?: any[]): string | undefined {
  if (!Array.isArray(messageList)) return undefined;
  for (let i = messageList.length - 1; i >= 0; i -= 1) {
    const message = messageList[i];
    if (!message) continue;
    const candidate = firstNonEmptyString(
      message?.metadata?.provider,
      message?.metadata?.providers,
      message?.response_metadata?.provider,
      message?.response_metadata?.providers,
      message?.usage_metadata?.provider,
      message?.provider,
      message?.additional_kwargs?.provider,
      message?.info?.provider,
      message?.annotations?.provider
    );
    if (candidate) return candidate;
  }
  return undefined;
}

const DEFAULT_TRACE_CONFIG = {
  enabled: false,
  logData: true,
} as const;

function ensureDir(p: string) {
  if (!fs.existsSync(p)) {
    fs.mkdirSync(p, { recursive: true });
  }
}

function withDefaults(config?: SmartAgentTracingConfig): ResolvedTraceConfig {
  const enabled = Boolean(config?.enabled);
  const logData = config?.logData ?? DEFAULT_TRACE_CONFIG.logData;

  let sink: ResolvedTraceSink;
  try {
    sink = resolveSink(config?.sink);
  } catch (err) {
    if (typeof console !== "undefined" && typeof console.warn === "function") {
      console.warn("Invalid tracing sink configuration. Falling back to file sink.", err);
    }
    sink = resolveSink({ type: "file" });
  }

  return {
    enabled,
    logData,
    mode: "batched",
    sink,
  };
}

function resolveSink(sink?: TraceSinkConfig): ResolvedTraceSink {
  const candidate = sink ?? { type: "file" };
  switch (candidate.type) {
    case "file": {
      const baseDir = resolveLogsBaseDir(candidate.path, false);
      return { type: "file", baseDir };
    }
    case "custom": {
      const onEvent = typeof candidate.onEvent === "function" ? candidate.onEvent : undefined;
      const onSession = typeof candidate.onSession === "function" ? candidate.onSession : undefined;
      return { type: "custom", onEvent, onSession };
    }
    case "cognipeer": {
      const apiKey = typeof candidate.apiKey === "string" ? candidate.apiKey.trim() : "";
      if (!apiKey) {
        throw new Error("cognipeer sink requires a non-empty apiKey");
      }
      const url = typeof candidate.url === "string" && candidate.url.trim().length > 0
        ? candidate.url.trim()
        : DEFAULT_COGNIPEER_URL;
      return { type: "cognipeer", url, apiKey };
    }
    case "http": {
      const url = typeof candidate.url === "string" ? candidate.url.trim() : "";
      if (!url) {
        throw new Error("http sink requires a non-empty url");
      }
      const headers = candidate.headers ? { ...candidate.headers } : undefined;
      return headers ? { type: "http", url, headers } : { type: "http", url };
    }
    default: {
      if (typeof console !== "undefined" && typeof console.warn === "function") {
        console.warn("Unknown tracing sink type. Falling back to file sink.", candidate);
      }
      return resolveSink({ type: "file" });
    }
  }
}

function snapshotSink(runtime: TraceSessionRuntime): TraceSinkSnapshot {
  const sink = runtime.resolvedConfig.sink;
  switch (sink.type) {
    case "file":
      return { type: "file", path: runtime.fileBaseDir || sink.baseDir };
    case "custom":
      return { type: "custom" };
    case "cognipeer":
      return { type: "cognipeer", url: sink.url };
    case "http":
      return { type: "http", url: sink.url };
    default:
      return { type: "custom" };
  }
}

function buildConfigSnapshot(runtime: TraceSessionRuntime): TraceSessionConfigSnapshot {
  return {
    enabled: runtime.resolvedConfig.enabled,
    logData: runtime.resolvedConfig.logData,
    sink: snapshotSink(runtime),
  };
}

async function postTraceSession(
  url: string,
  headers: Record<string, string> | undefined,
  payload: TraceSessionFile
): Promise<void> {
  const fetchFn = typeof globalThis.fetch === "function" ? globalThis.fetch.bind(globalThis) : undefined;
  if (!fetchFn) {
    throw new Error("HTTP sink requires fetch to be available in this runtime.");
  }

  const finalHeaders = { ...(headers || {}) } as Record<string, string>;
  if (!Object.keys(finalHeaders).some((key) => key.toLowerCase() === "content-type")) {
    finalHeaders["content-type"] = "application/json";
  }

  const response = await fetchFn(url, {
    method: "POST",
    headers: finalHeaders,
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    let responseText = "";
    try {
      responseText = await response.text();
    } catch {
      // ignore
    }
    const statusLine = `HTTP ${response.status}${response.statusText ? ` ${response.statusText}` : ""}`;
    const bodyPreview = responseText ? ` - ${responseText.slice(0, 200)}` : "";
    throw new Error(`${statusLine}${bodyPreview}`);
  }
}

function createEmptySummary(): TraceSessionSummary {
  return {
    totalDurationMs: 0,
    totalInputTokens: 0,
    totalOutputTokens: 0,
    totalCachedInputTokens: 0,
    totalBytesIn: 0,
    totalBytesOut: 0,
    eventCounts: {},
  };
}

function generateSessionId(): string {
  return `sess_${nanoid(18)}`;
}

function generateEventId(sequence: number): string {
  return `evt_${String(sequence).padStart(4, "0")}_${nanoid(4)}`;
}

function defaultEventLabel(type: string): string {
  switch (type) {
    case "ai_call":
      return "Assistant Response";
    case "tool_call":
      return "Tool Execution";
    case "session":
      return "Session Event";
    default:
      return type.replace(/_/g, " ").replace(/\b\w/g, (char) => char.toUpperCase());
  }
}

function ensureUniqueSections(eventId: string, sections?: TraceDataSection[]): TraceDataSection[] | undefined {
  if (!sections || sections.length === 0) return undefined;
  const labelCounts = new Map<string, number>();
  const normalized: TraceDataSection[] = [];
  let counter = 1;

  for (const section of sections) {
    const baseLabel = section.label?.trim().length ? section.label.trim() : defaultSectionLabel(section.kind);
    const nextCount = (labelCounts.get(baseLabel) || 0) + 1;
    labelCounts.set(baseLabel, nextCount);
    const finalLabel = nextCount > 1 ? `${baseLabel} (${nextCount})` : baseLabel;

    let id = section.id?.trim();
    if (!id) {
      id = `${section.kind}-${eventId}-${String(counter).padStart(2, "0")}`;
    }
    counter += 1;

    normalized.push({
      ...section,
      id,
      label: finalLabel,
    } as TraceDataSection);
  }

  return normalized;
}

function defaultSectionLabel(kind: TraceDataSection["kind"]): string {
  switch (kind) {
    case "message":
      return "Message";
    case "tool_call":
      return "Tool Call";
    case "tool_result":
      return "Tool Result";
    case "tool_response":
      return "Tool Response";
    case "summary":
      return "Summary";
    case "metadata":
      return "Details";
    default:
      return "Section";
  }
}

function buildMessageLabel(role: string, index: number): string {
  const normalized = role?.trim().length ? role.trim() : "message";
  const base = `${normalized.charAt(0).toUpperCase()}${normalized.slice(1)} Message`;
  return index > 1 ? `${base} #${index}` : base;
}

function toDisplayString(value: any): string {
  const sanitized = sanitizeTracePayload(value);
  if (sanitized == null) return "";
  if (typeof sanitized === "string") return sanitized;
  if (Array.isArray(sanitized)) {
    return sanitized
      .map((item) => toDisplayString(item))
      .filter((part) => part && part.trim().length > 0)
      .join("\n");
  }
  if (typeof sanitized === "object") {
    if (typeof (sanitized as any).text === "string" && Object.keys(sanitized).length === 1) {
      return (sanitized as any).text;
    }
    if (typeof (sanitized as any).content === "string") {
      return (sanitized as any).content;
    }
    try {
      return JSON.stringify(sanitized, null, 2);
    } catch {
      return String(sanitized);
    }
  }
  return String(sanitized);
}

function parseToolArguments(args: any): any {
  if (args == null) return undefined;
  if (typeof args === "string") {
    try {
      return JSON.parse(args);
    } catch {
      return args;
    }
  }
  return args;
}

function collectToolCallSectionsFromMessage(message: any): TraceToolCallSection[] {
  const sections: TraceToolCallSection[] = [];
  if (!message) return sections;

  const addCall = (call: any) => {
    if (!call) return;
    const toolName = call?.name || call?.tool || call?.function?.name || call?.function_call?.name || "tool";
    const rawArgs = call?.arguments ?? call?.args ?? call?.input ?? call?.function?.arguments ?? call?.function_call?.arguments;
    const parsedArgs = parseToolArguments(rawArgs);
    const argumentsPayload = sanitizeTracePayload(parsedArgs ?? rawArgs ?? {});
    sections.push({
      kind: "tool_call",
      label: `Tool Call: ${toolName}`,
      tool: toolName,
      arguments: argumentsPayload,
    });
  };

  const directCalls = Array.isArray(message?.tool_calls) ? message.tool_calls : undefined;
  if (directCalls) {
    directCalls.forEach((call: any) => addCall(call));
  }

  return sections;
}

function convertMessageListToSections(messageList?: any[]): TraceDataSection[] | undefined {
  if (!Array.isArray(messageList) || messageList.length === 0) return undefined;
  const sections: TraceDataSection[] = [];
  const roleCounts = new Map<string, number>();

  for (const message of messageList) {
    if (!message) continue;

    const toolSections = collectToolCallSectionsFromMessage(message);
    if (toolSections.length > 0) {
      sections.push(...toolSections);
      continue;
    }

    const role = typeof message?.role === "string" ? message.role : "assistant";
    const next = (roleCounts.get(role) || 0) + 1;
    roleCounts.set(role, next);

    let content = toDisplayString(message?.content ?? "");
    if (!content || !content.trim().length) {
      if (toolSections.length > 0) {
        content = "[tool call]";
      } else if (typeof message?.content === "undefined" || message?.content === null) {
        continue;
      } else {
        content = toDisplayString(sanitizeTracePayload(message?.content));
        if (!content || !content.trim().length) continue;
      }
    }

    sections.push({
      kind: "message",
      label: buildMessageLabel(role, next),
      role,
      content,
      metadata: typeof message?.name === "string" ? { name: message.name } : undefined,
    });
  }

  return sections.length > 0 ? sections : undefined;
}

export function createTraceSession(opts: SmartAgentOptions): TraceSessionRuntime | undefined {
  const cfg = withDefaults(opts.tracing);
  if (!cfg.enabled) return undefined;

  const sessionId = generateSessionId();
  const runtime: TraceSessionRuntime = {
    sessionId,
    startedAt: Date.now(),
    resolvedConfig: cfg,
    events: [],
    summary: createEmptySummary(),
    status: "in_progress",
    errors: [],
  };

  if (cfg.sink.type === "file") {
    const baseDir = cfg.sink.baseDir;
    ensureDir(baseDir);
    const sessionDir = path.join(baseDir, sessionId);
    ensureDir(sessionDir);
    runtime.fileBaseDir = baseDir;
    runtime.fileSessionDir = sessionDir;
  }

  return runtime;
}

export function recordTraceEvent(
  session: TraceSessionRuntime | undefined,
  event: {
    type: string;
    label?: string;
    timestamp?: string;
    actor?: TraceEventRecord["actor"];
    status?: TraceEventRecord["status"];
    durationMs?: number;
    inputTokens?: number;
    outputTokens?: number;
    totalTokens?: number;
    cachedInputTokens?: number;
    requestBytes?: number;
    responseBytes?: number;
    model?: string;
    provider?: string;
    toolExecutionId?: string;
    retryOf?: string;
    error?: { message: string; stack?: string } | null;
    messageList?: any[];
    debug?: Record<string, any>;
  }
): TraceEventRecord | undefined {
  if (!session) return undefined;


  const sequence = session.events.length + 1;
  const id = generateEventId(sequence);
  const timestampIso = event.timestamp || new Date().toISOString();
  const status = event.status ?? "success";
  const baseLabel = event.label?.trim().length ? event.label.trim() : defaultEventLabel(event.type);
  const eventLabel = `${baseLabel} #${sequence}`;

  const durationMs = event.durationMs !== undefined ? Number(event.durationMs) : undefined;
  if (!Number.isNaN(durationMs ?? NaN) && durationMs !== undefined) {
    session.summary.totalDurationMs += durationMs;
  }

  const inputTokens = event.inputTokens !== undefined ? Number(event.inputTokens) : undefined;
  if (!Number.isNaN(inputTokens ?? NaN) && inputTokens !== undefined) {
    session.summary.totalInputTokens += inputTokens;
  }

  const outputTokens = event.outputTokens !== undefined ? Number(event.outputTokens) : undefined;
  if (!Number.isNaN(outputTokens ?? NaN) && outputTokens !== undefined) {
    session.summary.totalOutputTokens += outputTokens;
  }

  const cachedInputTokens = event.cachedInputTokens !== undefined ? Number(event.cachedInputTokens) : undefined;
  if (!Number.isNaN(cachedInputTokens ?? NaN) && cachedInputTokens !== undefined) {
    session.summary.totalCachedInputTokens += cachedInputTokens;
  }

  const totalTokens = event.totalTokens !== undefined ? Number(event.totalTokens) : undefined;
  const requestBytes = event.requestBytes !== undefined ? Number(event.requestBytes) : undefined;
  if (!Number.isNaN(requestBytes ?? NaN) && requestBytes !== undefined) {
    session.summary.totalBytesIn += requestBytes;
  }

  const responseBytes = event.responseBytes !== undefined ? Number(event.responseBytes) : undefined;
  if (!Number.isNaN(responseBytes ?? NaN) && responseBytes !== undefined) {
    session.summary.totalBytesOut += responseBytes;
  }

  session.summary.eventCounts[event.type] = (session.summary.eventCounts[event.type] || 0) + 1;

  let sections: TraceDataSection[] | undefined;
  if (session.resolvedConfig.logData) {
    const converted = convertMessageListToSections(event.messageList);
    sections = ensureUniqueSections(id, converted);
  }

  const resolvedModel = event.model ?? inferModelFromMessages(event.messageList);
  const resolvedProvider = event.provider ?? inferProviderFromMessages(event.messageList);

  // For ai_call events, always include token fields (even if undefined/0) for consistency
  const isAiCall = event.type === "ai_call";
  
  const record: TraceEventRecord = {
    sessionId: session.sessionId,
    id,
    type: event.type,
    label: eventLabel,
    sequence,
    timestamp: timestampIso,
    actor: event.actor,
    status,
    durationMs,
    ...(isAiCall ? {
      inputTokens: inputTokens ?? 0,
      outputTokens: outputTokens ?? 0,
      totalTokens: totalTokens ?? 0,
      cachedInputTokens: cachedInputTokens ?? 0,
    } : {
      ...(inputTokens !== undefined && { inputTokens }),
      ...(outputTokens !== undefined && { outputTokens }),
      ...(totalTokens !== undefined && { totalTokens }),
      ...(cachedInputTokens !== undefined && { cachedInputTokens }),
    }),
    requestBytes,
    responseBytes,
    model: resolvedModel,
    provider: resolvedProvider,
    toolExecutionId: event.toolExecutionId,
    retryOf: event.retryOf,
    error: event.error ?? (status === "error" ? { message: "Unknown error" } : undefined) ?? undefined,
    data: sections ? { sections } : undefined,
    debug: event.debug,
  };

  if (status === "error") {
    const errorInfo = event.error ?? { message: "Unknown error" };
    session.errors.push({
      eventId: id,
      message: errorInfo.message,
      stack: errorInfo.stack,
      type: event.type,
      timestamp: timestampIso,
    });
  }

  session.events.push(record);
  const sink = session.resolvedConfig.sink;
  if (sink.type === "custom" && typeof sink.onEvent === "function") {
    try {
      const cloned = JSON.parse(JSON.stringify(record));
      const result = sink.onEvent(cloned);
      if (result && typeof (result as PromiseLike<void>).then === "function") {
        (result as PromiseLike<void>).then(undefined, (error: unknown) => {
          if (typeof console !== "undefined" && typeof console.warn === "function") {
            console.warn("Trace custom sink onEvent rejected", error);
          }
        });
      }
    } catch (err) {
      if (typeof console !== "undefined" && typeof console.warn === "function") {
        console.warn("Trace custom sink onEvent failed", err);
      }
    }
  }
  return record;
}

export async function finalizeTraceSession(session: TraceSessionRuntime | undefined, params: {
  agentRuntime?: AgentRuntimeConfig;
  status?: TraceSessionStatus;
  error?: { message?: string; stack?: string } | null;
} = {}): Promise<TraceSessionFile | undefined> {
  if (!session) return undefined;

  const endedAtMs = Date.now();
  const endedAtIso = new Date(endedAtMs).toISOString();
  const durationMs = endedAtMs - session.startedAt;
  const startedAtIso = new Date(session.startedAt).toISOString();

  const agentInfo = params.agentRuntime
    ? {
      name: params.agentRuntime.name,
      version: params.agentRuntime.version,
      model: getModelName(params.agentRuntime.model),
      provider: getProviderName(params.agentRuntime.model),
    }
    : undefined;

  if (params.error) {
    session.errors.push({
      eventId: "session",
      message: params.error.message || "Unknown error",
      stack: params.error.stack,
      type: "session",
      timestamp: endedAtIso,
    });
  }

  const configSnapshot = buildConfigSnapshot(session);
  const initialStatus: TraceSessionStatus = params.status
    ? params.status
    : session.errors.length > 0
      ? "error"
      : "success";

  const buildPayload = (status: TraceSessionStatus): TraceSessionFile => ({
    sessionId: session.sessionId,
    startedAt: startedAtIso,
    endedAt: endedAtIso,
    durationMs,
    agent: agentInfo,
    config: configSnapshot,
    summary: session.summary,
    events: session.events,
    status,
    errors: session.errors,
  });

  const payloadForSink = buildPayload(initialStatus);
  let sinkFailed = false;
  const sink = session.resolvedConfig.sink;

  if (sink.type === "cognipeer" || sink.type === "http") {
    try {
      const headers = sink.type === "cognipeer"
        ? { Authorization: `Bearer ${sink.apiKey}` }
        : sink.headers;
      await postTraceSession(sink.url, headers, payloadForSink);
    } catch (err) {
      sinkFailed = true;
      const message = err instanceof Error ? err.message : String(err);
      session.errors.push({
        eventId: "sink",
        message,
        type: "sink",
        timestamp: endedAtIso,
      });
    }
  }

  const hadNonSinkErrors = session.errors.some((error) => error.type && error.type !== "sink");
  let status: TraceSessionStatus = params.status ?? (hadNonSinkErrors ? "error" : "success");
  if (status === "success" && sinkFailed) {
    status = "partial";
  }

  let finalPayload = buildPayload(status);

  if (sink.type === "file" && session.fileSessionDir) {
    try {
      const filePath = path.join(session.fileSessionDir, "trace.session.json");
      await fs.promises.writeFile(filePath, JSON.stringify(finalPayload, null, 2), "utf8");
    } catch (err) {
      sinkFailed = true;
      const message = err instanceof Error ? err.message : String(err);
      session.errors.push({
        eventId: "sink",
        message,
        type: "sink",
        timestamp: endedAtIso,
      });
      if (status === "success") {
        status = "partial";
        finalPayload = buildPayload(status);
      }
    }
  }

  if (sink.type === "custom" && typeof sink.onSession === "function") {
    try {
      const cloned = JSON.parse(JSON.stringify(finalPayload));
      await sink.onSession(cloned);
    } catch (err) {
      sinkFailed = true;
      const message = err instanceof Error ? err.message : String(err);
      session.errors.push({
        eventId: "sink",
        message,
        type: "sink",
        timestamp: endedAtIso,
      });
      if (status === "success") {
        status = "partial";
        finalPayload = buildPayload(status);
      }
    }
  }

  if (!params.status) {
    const finalHadNonSinkErrors = session.errors.some((error) => error.type && error.type !== "sink");
    const hasSinkErrors = session.errors.some((error) => error.type === "sink");
    let computedStatus: TraceSessionStatus = finalHadNonSinkErrors ? "error" : "success";
    if (computedStatus === "success" && hasSinkErrors) {
      computedStatus = "partial";
    }
    if (computedStatus !== status) {
      status = computedStatus;
      finalPayload = buildPayload(status);
    }
  }

  return finalPayload;
}

export type { ResolvedTraceConfig };

export function sanitizeTracePayload(value: any): any {
  try {
    const cache = new WeakSet();
    const json = JSON.stringify(
      value,
      (_key, val) => {
        if (typeof val === "function") return `[Function ${val.name || "anonymous"}]`;
        if (typeof val === "bigint") return val.toString();
        if (val instanceof Error) return { message: val.message, stack: val.stack };
        if (val && typeof val === "object") {
          if (cache.has(val)) return "[Circular]";
          cache.add(val);
        }
        return val;
      },
      2
    );
    return JSON.parse(json);
  } catch {
    try {
      return typeof value === "string" ? value : String(value);
    } catch {
      return "[Unserializable]";
    }
  }
}

export function estimatePayloadBytes(value: any): number {
  try {
    const json = JSON.stringify(value);
    return Buffer.byteLength(json ?? "", "utf8");
  } catch {
    try {
      return Buffer.byteLength(String(value ?? ""), "utf8");
    } catch {
      return 0;
    }
  }
}
