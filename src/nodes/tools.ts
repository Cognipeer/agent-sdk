import type {
  SmartAgentEvent,
  SmartAgentOptions,
  SmartState,
  AgentRuntimeConfig,
  ToolInterface,
  Message,
  PendingToolApproval,
  PendingUserQuestion,
  TraceDataSection,
  TraceToolDetails,
} from "../types.js";
import { nanoid } from "nanoid";
import { zodToJsonSchema } from "zod-to-json-schema";
import { recordTraceEvent, sanitizeTracePayload, estimatePayloadBytes } from "../utils/tracing.js";
import { extractToolItems, summarizeToolOutput } from "../utils/traceSections.js";
import { getResolvedSmartConfig } from "../smart/runtimeConfig.js";
import { applyToolResponseHardCap, validateToolArgs } from "../smart/toolResponses.js";

function normalizeMaxExecutionsPerRun(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return null;
  const normalized = Math.trunc(parsed);
  return normalized >= 0 ? normalized : null;
}

function countSuccessfulToolExecutions(toolHistory: SmartState["toolHistory"], toolName: string): number {
  if (!Array.isArray(toolHistory)) return 0;
  return toolHistory.filter((entry) => entry?.toolName === toolName && (entry?.status === "success" || entry?.status === "handoff")).length;
}

function normalizeToolCall(call: any): { id?: string; name: string; args: any } | null {
  if (!call || typeof call !== "object") return null;

  const name = call.name ?? call.tool ?? call.function?.name ?? call.function_call?.name;
  if (typeof name !== "string" || name.length === 0) return null;

  return {
    id: call.id,
    name,
    args: call.args ?? call.arguments ?? call.input ?? call.function?.arguments ?? call.function_call?.arguments,
  };
}

function normalizeToolSchema(tool: ToolInterface, toolName: string): any {
  const schema = (tool as any).schema;
  if (!schema) return undefined;

  if (typeof schema === "object" && (schema as any)._def) {
    try {
      return sanitizeTracePayload((zodToJsonSchema as any)(schema, { name: toolName }));
    } catch {
      // Fall through to generic serialization.
    }
  }

  if (schema && typeof schema === "object" && typeof (schema as any).toJSON === "function") {
    try {
      return sanitizeTracePayload((schema as any).toJSON());
    } catch {
      // Fall through to generic serialization.
    }
  }

  return sanitizeTracePayload(schema);
}

function buildToolDetails(tool: ToolInterface | undefined, toolName: string): TraceToolDetails | undefined {
  if (!tool) return undefined;
  const details: TraceToolDetails = { name: toolName };
  if (typeof (tool as any).description === "string" && (tool as any).description.trim().length > 0) {
    details.description = (tool as any).description;
  }

  const inputSchema = normalizeToolSchema(tool, toolName);
  if (inputSchema !== undefined) details.inputSchema = inputSchema;

  const needsApproval = typeof (tool as any).needsApproval === "boolean" ? (tool as any).needsApproval : undefined;
  if (needsApproval !== undefined || (tool as any).approvalPrompt !== undefined || (tool as any).approvalDefaults !== undefined) {
    details.approval = {
      required: needsApproval,
      prompt: typeof (tool as any).approvalPrompt === "string" ? (tool as any).approvalPrompt : undefined,
      defaults: (tool as any).approvalDefaults !== undefined ? sanitizeTracePayload((tool as any).approvalDefaults) : undefined,
    };
  }

  const cache = (tool as any).cache;
  if (cache !== undefined) {
    details.cache = {
      enabled: Boolean(cache),
      scope: cache && typeof cache === "object" && typeof cache.scope === "string" ? cache.scope : undefined,
      ttlMs: cache && typeof cache === "object" && typeof cache.ttlMs === "number" ? cache.ttlMs : undefined,
      hasKeyFn: Boolean(cache && typeof cache === "object" && typeof cache.keyFn === "function"),
    };
  }

  const retry = (tool as any).retry;
  if (retry && typeof retry === "object") {
    details.retry = {
      maxRetries: typeof retry.maxRetries === "number" ? retry.maxRetries : undefined,
      backoffMs: typeof retry.backoffMs === "number" ? retry.backoffMs : undefined,
      circuitBreakerThreshold: typeof retry.circuitBreakerThreshold === "number" ? retry.circuitBreakerThreshold : undefined,
      hasShouldRetry: typeof retry.shouldRetry === "function",
    };
  }

  if ((tool as any).maxExecutionsPerRun !== undefined) {
    details.limits = { maxExecutionsPerRun: (tool as any).maxExecutionsPerRun };
  }

  if (typeof (tool as any).__source === "string") {
    details.source = (tool as any).__source;
  }

  return details;
}

function buildToolTraceSections(params: {
  args?: any;
  classification?: any;
  durationMs?: number;
  executionId?: string;
  output?: any;
  retentionPolicy?: any;
  status: "success" | "error" | "skipped" | "cached" | string;
  summary?: string;
  toolDetails?: TraceToolDetails;
  toolName: string;
  fromCache?: boolean;
}): TraceDataSection[] {
  const sanitizedArgs = sanitizeTracePayload(params.args ?? {});
  const sanitizedOutput = sanitizeTracePayload(params.output);
  const summary = params.summary ?? summarizeToolOutput(sanitizedOutput);
  const items = extractToolItems(sanitizedOutput);

  return [
    {
      kind: "tool_call",
      label: `Tool Call: ${params.toolName}`,
      tool: params.toolName,
      arguments: sanitizedArgs,
      toolDetails: params.toolDetails,
    },
    {
      kind: "tool_result",
      label: `Tool Result: ${params.toolName}`,
      tool: params.toolName,
      summary,
      items,
      output: sanitizedOutput,
      toolDetails: params.toolDetails,
      execution: {
        id: params.executionId,
        status: params.status,
        durationMs: params.durationMs,
        fromCache: params.fromCache,
      },
      classification: params.classification,
      retentionPolicy: params.retentionPolicy,
    },
  ];
}

export function createToolsNode(initialTools: Array<ToolInterface<any, any, any>>, opts?: SmartAgentOptions) {
  return async (state: SmartState): Promise<any> => {
    const runtime = state.agent || {
      name: opts?.name,
      model: opts?.model,
      tools: initialTools,
      limits: opts?.limits,
      systemPrompt: opts?.systemPrompt,
      todoListPrompt: opts?.todoListPrompt,
      useTodoList: opts?.useTodoList,
      outputSchema: (opts as any)?.outputSchema,
    } as AgentRuntimeConfig;
    const resolved = getResolvedSmartConfig(opts || ({} as SmartAgentOptions), runtime as any);
    const activeTools: Array<ToolInterface<any, any, any>> = runtime.tools as any;
    const toolByName = new Map<string, ToolInterface>();
    for (const tool of activeTools) toolByName.set((tool as any).name, tool);

    const limits = {
      maxToolCalls: (runtime.limits?.maxToolCalls ?? resolved.limits.maxToolCalls ?? 10) as number,
      maxParallelTools: Math.max(1, (runtime.limits?.maxParallelTools ?? resolved.limits.maxParallelTools ?? 1) as number),
    };
    const appended: Message[] = [];
    const onEvent = (state.ctx as any)?.__onEvent as ((e: SmartAgentEvent) => void) | undefined;
    const onProgress = (state.ctx as any)?.__onProgress as ((progress: { stage?: string; message?: string; percent?: number; detail?: any }) => void) | undefined;
    const cancellationToken = (state.ctx as any)?.__cancellationToken as any;
    const abortSignal = (state.ctx as any)?.__abortSignal as AbortSignal | undefined;
    const traceSession = (state.ctx as any)?.__traceSession;
    const pendingApprovals: PendingToolApproval[] = Array.isArray(state.pendingApprovals)
      ? state.pendingApprovals.map((entry) => ({ ...entry }))
      : [];
    const pendingByCallId = new Map(pendingApprovals.map((entry) => [entry.toolCallId, entry]));
    const pendingUserQuestions: PendingUserQuestion[] = Array.isArray(state.pendingUserQuestions)
      ? state.pendingUserQuestions.map((entry) => ({ ...entry }))
      : [];
    let awaitingApproval = false;
    let awaitingUserQuestion = false;

    for (const tool of toolByName.values()) {
      const anyTool: any = tool as any;
      if (anyTool._stateRef && typeof anyTool._stateRef === "object") {
        anyTool._stateRef.toolHistory = state.toolHistory;
        anyTool._stateRef.toolHistoryArchived = state.toolHistoryArchived;
        anyTool._stateRef.pendingApprovals = pendingApprovals;
        anyTool._stateRef.pendingUserQuestions = pendingUserQuestions;
        anyTool._stateRef.messages = state.messages;
        anyTool._stateRef.ctx = state.ctx || (state.ctx = {});
        anyTool._stateRef.__onEvent = onEvent;
        // Expose parent runtime to delegation-aware tools (asTool sub-agents).
        anyTool._stateRef.parentRuntime = runtime;
      }
    }

    const last = state.messages[state.messages.length - 1] as any;
    let toolCount = state.toolCallCount || 0;
    const toolCalls: Array<{ id?: string; name: string; args: any }> = Array.isArray(last?.tool_calls)
      ? last.tool_calls
          .map((toolCall: any) => normalizeToolCall(toolCall))
          .filter((toolCall: { id?: string; name: string; args: any } | null): toolCall is { id?: string; name: string; args: any } => toolCall !== null)
      : [];
    const toolHistory = state.toolHistory || [];
    const toolHistoryArchived = state.toolHistoryArchived || [];
    const remaining = Math.max(0, limits.maxToolCalls - toolCount);
    const planned = toolCalls.slice(0, remaining);
    const skipped = toolCalls.slice(remaining);
    // Per-tool slot used to preserve append order across parallel execution.
    // Bedrock / Anthropic adapters expect tool_result blocks in the same order
    // as tool_use blocks in the assistant turn; we honor that by writing each
    // call's output messages to its planned index and flattening at the end.
    const orderedSlots: Message[][] = planned.map(() => []);

    type ToolExecutionResult =
      | { status: "success" | "error"; approval?: PendingToolApproval }
      | { status: "awaiting_approval" | "rejected"; approval: PendingToolApproval }
      | { status: "awaiting_user_question"; userQuestion: PendingUserQuestion };

    const isCancelled = () => {
      if (abortSignal?.aborted) return { cancelled: true, reason: "aborted" };
      if (cancellationToken && cancellationToken.isCancellationRequested) return { cancelled: true, reason: "cancelled" };
      return { cancelled: false, reason: undefined } as const;
    };

    const markToolFailure = (message: string, toolName: string, toolCallId?: string) => {
      const ctx = { ...(state.ctx || {}) } as any;
      ctx.__lastToolError = message;
      if (toolCallId) {
        ctx.__toolSchemaError = { toolName, toolCallId, message };
      }
      if (resolved.planning.replanPolicy === "on_failure") {
        ctx.__planNeedsReplan = true;
      }
      state.ctx = ctx;
    };

    // Each runOne writes its tool/result messages to the provided slot. We
    // keep `appended` as the canonical accumulator but slots let parallel
    // execution preserve the deterministic planned order.
    const runOne = async (
      tc: { id?: string; name: string; args: any },
      slot: Message[] = appended,
    ): Promise<ToolExecutionResult> => {
      const push = (msg: Message) => slot.push(msg);
      const cancelState = isCancelled();
      if (cancelState.cancelled) {
        const ctx = (state.ctx = state.ctx || {});
        (ctx as any).__cancelled = { stage: "tools", reason: cancelState.reason, timestamp: new Date().toISOString() };
        onEvent?.({ type: "cancelled", stage: "tools", reason: cancelState.reason });
        onProgress?.({ stage: "tools", message: "Cancelled", detail: { reason: cancelState.reason } });
        return { status: "error" };
      }

      const tool = toolByName.get(tc.name);
      if (!tool) {
        push({ role: "tool", content: `Tool not found: ${tc.name}`, tool_call_id: tc.id || `${tc.name}_unknown`, name: tc.name });
        onEvent?.({ type: "tool_call", phase: "error", name: tc.name, id: tc.id, args: tc.args, error: { message: "Tool not found" } });
        toolCount += 1;
        return { status: "error" };
      }

      let args: any = tc.args;
      if (typeof args === "string") {
        try { args = JSON.parse(args); } catch { /* keep raw string */ }
      }

      const toolCallId = tc.id || `${tc.name}_${toolCount + 1}`;
      const validatedArgs = validateToolArgs(tool, args);
      if (!validatedArgs.ok && resolved.toolResponses.schemaValidation === "strict") {
        const errorMessage = `Tool argument validation failed for ${tc.name}: ${validatedArgs.message}`;
        push({ role: "tool", content: errorMessage, tool_call_id: toolCallId, name: tc.name });
        markToolFailure(errorMessage, tc.name, toolCallId);
        onEvent?.({ type: "tool_call", phase: "error", name: tc.name, id: tc.id, args, error: { message: errorMessage } });
        toolCount += 1;
        return { status: "error" };
      }
      if (validatedArgs.ok) {
        args = validatedArgs.value;
      }

      const toolName = (tool as any).name || tc.name;
      const toolDetails = buildToolDetails(tool, toolName);
      const toolStateRef = (tool as any)._stateRef && typeof (tool as any)._stateRef === "object"
        ? (tool as any)._stateRef as Record<string, any>
        : null;

      if (toolStateRef) {
        toolStateRef.pendingApprovals = pendingApprovals;
        toolStateRef.pendingUserQuestions = pendingUserQuestions;
        toolStateRef.ctx = state.ctx || (state.ctx = {});
        toolStateRef.__currentToolCallId = toolCallId;
        delete toolStateRef.__awaitingApproval;
      }

      const maxExecutionsPerRun = normalizeMaxExecutionsPerRun((tool as any).maxExecutionsPerRun);
      if (maxExecutionsPerRun !== null) {
        const currentExecutions = countSuccessfulToolExecutions(toolHistory, toolName);
        if (currentExecutions >= maxExecutionsPerRun) {
          const limitMessage = `Skipped tool due to per-tool execution limit: ${toolName} (${maxExecutionsPerRun}/run)`;
          push({ role: "tool", content: limitMessage, tool_call_id: toolCallId, name: tc.name });
          onEvent?.({ type: "tool_call", phase: "skipped", name: toolName, id: tc.id, args });
          recordTraceEvent(traceSession, {
            type: "tool_call",
            label: `Tool Skipped - ${toolName}`,
            actor: { scope: "tool", name: toolName, role: "tool" },
            status: "skipped",
            toolDetails,
            toolExecutionId: tc.id,
            sections: buildToolTraceSections({
              args,
              executionId: tc.id,
              output: limitMessage,
              status: "skipped",
              summary: limitMessage,
              toolDetails,
              toolName,
            }),
          });
          toolCount += 1;
          return { status: "error" };
        }
      }

      let approvalEntry = pendingByCallId.get(toolCallId);
      const needsApproval = Boolean((tool as any).needsApproval);
      if (needsApproval) {
        if (!approvalEntry) {
          approvalEntry = {
            id: nanoid(),
            toolCallId,
            toolName: (tool as any).name || tc.name,
            args,
            status: "pending",
            requestedAt: new Date().toISOString(),
            metadata: (tool as any).approvalPrompt || (tool as any).approvalDefaults
              ? { prompt: (tool as any).approvalPrompt, defaults: (tool as any).approvalDefaults }
              : undefined,
          };
          pendingApprovals.push(approvalEntry);
          pendingByCallId.set(toolCallId, approvalEntry);
          onEvent?.({ type: "tool_approval", status: "pending", id: approvalEntry.id, toolName: approvalEntry.toolName, toolCallId: approvalEntry.toolCallId, args });
        } else if (!approvalEntry.args) {
          approvalEntry.args = args;
        }

        if (approvalEntry.status === "pending") {
          awaitingApproval = true;
          const ctx = (state.ctx = state.ctx || {});
          ctx.__awaitingApproval = {
            approvalId: approvalEntry.id,
            toolCallId: approvalEntry.toolCallId,
            toolName: approvalEntry.toolName,
            requestedAt: approvalEntry.requestedAt,
          };
          ctx.__resumeStage = "tools";
          return { status: "awaiting_approval", approval: approvalEntry };
        }

        if (approvalEntry.status === "rejected") {
          const rejectionMessage = approvalEntry.comment || "Tool call rejected by reviewer.";
          push({ role: "tool", content: `Tool call rejected: ${rejectionMessage}`, tool_call_id: toolCallId, name: tc.name });
          approvalEntry.metadata = { ...(approvalEntry.metadata || {}), resolution: "rejected" };
          approvalEntry.status = "executed";
          approvalEntry.resolvedAt = new Date().toISOString();
          pendingByCallId.set(toolCallId, approvalEntry);
          toolHistory.push({ executionId: nanoid(), toolName: (tool as any).name, args, output: `Rejected: ${rejectionMessage}`, rawOutput: null, timestamp: new Date().toISOString(), tool_call_id: tc.id, status: "rejected" });
          onEvent?.({ type: "tool_approval", status: "rejected", id: approvalEntry.id, toolName: approvalEntry.toolName, toolCallId: approvalEntry.toolCallId, comment: approvalEntry.comment, decidedBy: approvalEntry.decidedBy });
          toolCount += 1;
          return { status: "rejected", approval: approvalEntry };
        }

        if (approvalEntry.status === "approved" && approvalEntry.approvedArgs !== undefined) {
          args = approvalEntry.approvedArgs;
          onEvent?.({ type: "tool_approval", status: "approved", id: approvalEntry.id, toolName: approvalEntry.toolName, toolCallId: approvalEntry.toolCallId, decidedBy: approvalEntry.decidedBy, comment: approvalEntry.comment });
        }
      }

      const start = Date.now();
      const sanitizedArgs = sanitizeTracePayload(args);
      const inputBytes = traceSession?.resolvedConfig.logData ? estimatePayloadBytes(sanitizedArgs) : undefined;

      // ── Tool result cache (opt-in via `cache: true` on the tool) ──────────
      const cacheCfg = (tool as any).cache;
      const cacheEnabled = cacheCfg === true || (cacheCfg && typeof cacheCfg === "object");
      const cacheKeyFn: ((a: any) => string) | undefined = cacheEnabled && typeof cacheCfg === "object" ? cacheCfg.keyFn : undefined;
      const stableJson = (value: any): string => {
        try {
          if (value === null || typeof value !== "object") return JSON.stringify(value);
          if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
          const keys = Object.keys(value).sort();
          return `{${keys.map((k) => JSON.stringify(k) + ":" + stableJson(value[k])).join(",")}}`;
        } catch {
          return String(value);
        }
      };
      const cacheKey = cacheEnabled ? `${toolName}|${cacheKeyFn ? cacheKeyFn(args) : stableJson(args)}` : undefined;
      const toolCache = (state.toolCache = state.toolCache || {});
      let cachedHit: any = undefined;
      if (cacheKey && Object.prototype.hasOwnProperty.call(toolCache, cacheKey)) {
        const entry = toolCache[cacheKey];
        const ttl = cacheEnabled && typeof cacheCfg === "object" ? cacheCfg.ttlMs : undefined;
        if (!ttl || (entry?.timestamp && Date.now() - entry.timestamp <= ttl)) {
          cachedHit = entry?.value;
        }
      }

      // ── Circuit breaker (consecutive failure cap per tool) ────────────────
      const retryCfg = (tool as any).retry;
      const failureStats = (state.ctx as any).__toolFailureCounts ||= {} as Record<string, number>;
      if (retryCfg?.circuitBreakerThreshold && failureStats[toolName] >= retryCfg.circuitBreakerThreshold) {
        const breakerMsg = `Tool ${toolName} circuit breaker open after ${failureStats[toolName]} consecutive failures`;
        push({ role: "tool", content: breakerMsg, tool_call_id: toolCallId, name: tc.name });
        markToolFailure(breakerMsg, toolName, toolCallId);
        onEvent?.({ type: "tool_call", phase: "error", name: toolName, id: tc.id, args, error: { message: breakerMsg } });
        recordTraceEvent(traceSession, {
          type: "tool_call",
          label: `Tool Error - ${toolName}`,
          actor: { scope: "tool", name: toolName, role: "tool" },
          status: "error",
          requestBytes: inputBytes,
          toolDetails,
          toolExecutionId: toolCallId,
          error: { message: breakerMsg },
          sections: buildToolTraceSections({
            args,
            executionId: toolCallId,
            output: { message: breakerMsg },
            status: "error",
            summary: breakerMsg,
            toolDetails,
            toolName,
          }),
        });
        toolCount += 1;
        return { status: "error" };
      }

      try {
        if (cachedHit !== undefined) {
          // Short-circuit: serve from cache without re-invoking the tool.
          const executionId = nanoid();
          const responsePolicy = applyToolResponseHardCap(toolName, cachedHit, executionId, resolved);
          toolHistory.push({
            executionId,
            toolName,
            args,
            output: cachedHit,
            rawOutput: cachedHit,
            timestamp: new Date().toISOString(),
            tool_call_id: tc.id,
            summarized: false,
            originalTokenCount: responsePolicy.tokenCount,
            classification: responsePolicy.classification,
            retentionPolicy: "keep_full",
            fromCache: true,
            status: "success",
          });
          push({ role: "tool", content: responsePolicy.content, tool_call_id: tc.id || `${tc.name}_${toolCount}`, name: tc.name });
          onEvent?.({ type: "tool_call", phase: "success", name: toolName, id: tc.id, args, result: cachedHit, durationMs: 0 });
          const sanitizedCachedHit = sanitizeTracePayload(cachedHit);
          const outputBytes = traceSession?.resolvedConfig.logData ? estimatePayloadBytes(sanitizedCachedHit) : undefined;
          recordTraceEvent(traceSession, {
            type: "tool_call",
            label: `Tool Execution - ${toolName}`,
            actor: { scope: "tool", name: toolName, role: "tool" },
            durationMs: 0,
            requestBytes: inputBytes,
            responseBytes: outputBytes,
            toolDetails,
            toolExecutionId: executionId,
            sections: buildToolTraceSections({
              args,
              classification: responsePolicy.classification,
              durationMs: 0,
              executionId,
              fromCache: true,
              output: sanitizedCachedHit,
              retentionPolicy: "keep_full",
              status: "cached",
              summary: responsePolicy.content,
              toolDetails,
              toolName,
            }),
            debug: {
              classification: responsePolicy.classification,
              retentionPolicy: "keep_full",
              originalTokenCount: responsePolicy.tokenCount,
              truncated: responsePolicy.truncated,
              fromCache: true,
            },
          });
          toolCount += 1;
          return { status: "success" };
        }
        onEvent?.({ type: "tool_call", phase: "start", name: toolName, id: tc.id, args });
        onProgress?.({ stage: "tools", message: `Running tool ${tc.name}` });
        const anyTool = tool as any;
        const callOptions = { cancellationToken, signal: abortSignal };
        const invokeOnce = async (): Promise<any> => {
          if (typeof anyTool.func === "function") return anyTool.func(args, callOptions);
          if (typeof anyTool.invoke === "function") return anyTool.invoke(args, callOptions);
          if (typeof anyTool.call === "function") return anyTool.call(args, callOptions);
          if (typeof anyTool._call === "function") return anyTool._call(args, callOptions);
          if (typeof anyTool.run === "function") return anyTool.run(args, callOptions);
          throw new Error("Tool is not invokable");
        };

        let output: any;
        const maxRetries = Math.max(0, Number(retryCfg?.maxRetries) || 0);
        const backoffMs = Math.max(0, Number(retryCfg?.backoffMs) || 250);
        let attempt = 0;
        // First attempt + up to maxRetries retries with exponential backoff.
        // shouldRetry can short-circuit retries for non-transient errors.
        // eslint-disable-next-line no-constant-condition
        while (true) {
          try {
            output = await invokeOnce();
            failureStats[toolName] = 0;
            break;
          } catch (retryErr) {
            attempt += 1;
            const shouldRetry = retryCfg?.shouldRetry
              ? retryCfg.shouldRetry(retryErr, attempt)
              : true;
            if (attempt > maxRetries || !shouldRetry) {
              failureStats[toolName] = (failureStats[toolName] || 0) + 1;
              throw retryErr;
            }
            await new Promise((r) => setTimeout(r, backoffMs * Math.pow(2, attempt - 1)));
          }
        }

        if (cacheKey) {
          toolCache[cacheKey] = { value: output, timestamp: Date.now() };
        }

        const durationMs = Date.now() - start;
        const executionId = nanoid();

        if (output && typeof output === "object" && output.__handoff && output.__handoff.runtime) {
          toolHistory.push({ executionId, toolName, args, output: "handoff:ok", rawOutput: output, timestamp: new Date().toISOString(), tool_call_id: tc.id, status: "handoff" });
          push({ role: "tool", content: "ok", tool_call_id: tc.id || `${tc.name}_${toolCount}`, name: tc.name });
          state.agent = output.__handoff.runtime as AgentRuntimeConfig;
          onEvent?.({ type: "handoff", from: runtime.name, to: state.agent?.name, toolName });
          onEvent?.({ type: "tool_call", phase: "success", name: toolName, id: tc.id, args, result: "handoff", durationMs });
          if (needsApproval && approvalEntry) {
            approvalEntry.status = "executed";
            approvalEntry.resolvedAt = new Date().toISOString();
            approvalEntry.executionId = executionId;
            pendingByCallId.set(toolCallId, approvalEntry);
          }
          toolCount += 1;
          return { status: "success", approval: approvalEntry };
        }

        if (output && typeof output === "object" && (output as any).__awaitingToolApproval) {
          if (toolStateRef?.ctx && typeof toolStateRef.ctx === "object") {
            state.ctx = toolStateRef.ctx;
          }

          const pendingApproval = pendingApprovals.find((entry) =>
            entry.toolCallId === (output as any).toolCallId || entry.id === (output as any).approvalId
          );

          if (!pendingApproval) {
            throw new Error(`Tool ${toolName} requested approval but no pending approval entry was recorded.`);
          }

          awaitingApproval = true;
          return {
            status: "awaiting_approval",
            approval: pendingApproval
          };
        }

        if (output && typeof output === "object" && (output as any).__awaitingUserQuestion) {
          if (toolStateRef?.ctx && typeof toolStateRef.ctx === "object") {
            state.ctx = toolStateRef.ctx;
          }

          const pendingQuestion = pendingUserQuestions.find((entry) =>
            entry.toolCallId === (output as any).toolCallId || entry.id === (output as any).id
          );

          if (!pendingQuestion) {
            throw new Error(`Tool ${toolName} requested a user question but no pending question entry was recorded.`);
          }

          awaitingUserQuestion = true;
          return {
            status: "awaiting_user_question",
            userQuestion: pendingQuestion,
          };
        }

        if (output && typeof output === "object" && output.__finalStructuredOutput) {
          if (!state.ctx) state.ctx = {};
          state.ctx.__structuredOutputParsed = output.data;
          state.ctx.__finalizedDueToStructuredOutput = true;
        }

        const responsePolicy = applyToolResponseHardCap(toolName, output, executionId, resolved);
        const timestamp = new Date().toISOString();

        toolHistory.push({
          executionId,
          toolName,
          args,
          output,
          rawOutput: output,
          timestamp,
          tool_call_id: tc.id,
          summarized: false,
          originalTokenCount: responsePolicy.tokenCount,
          classification: responsePolicy.classification,
          retentionPolicy: "keep_full",
          summary: undefined,
          archiveId: undefined,
          status: "success",
        });

        push({ role: "tool", content: responsePolicy.content, tool_call_id: tc.id || `${tc.name}_${toolCount}`, name: tc.name });
        onEvent?.({ type: "tool_call", phase: "success", name: toolName, id: tc.id, args, result: output, durationMs });
        onProgress?.({ stage: "tools", message: `Tool ${tc.name} completed`, detail: { durationMs } });

        if (needsApproval && approvalEntry) {
          approvalEntry.status = "executed";
          approvalEntry.resolvedAt = new Date().toISOString();
          approvalEntry.executionId = executionId;
          pendingByCallId.set(toolCallId, approvalEntry);
        }

        const sanitizedOutput = sanitizeTracePayload(output);
        const outputBytes = traceSession?.resolvedConfig.logData ? estimatePayloadBytes(sanitizedOutput) : undefined;
        recordTraceEvent(traceSession, {
          type: "tool_call",
          label: `Tool Execution - ${toolName}`,
          actor: { scope: "tool", name: toolName, role: "tool" },
          durationMs,
          requestBytes: inputBytes,
          responseBytes: outputBytes,
          toolDetails,
          toolExecutionId: executionId,
          sections: buildToolTraceSections({
            args: sanitizedArgs,
            classification: responsePolicy.classification,
            durationMs,
            executionId,
            output: sanitizedOutput,
            retentionPolicy: "keep_full",
            status: "success",
            summary: responsePolicy.content,
            toolDetails,
            toolName,
          }),
          debug: {
            classification: responsePolicy.classification,
            retentionPolicy: "keep_full",
            originalTokenCount: responsePolicy.tokenCount,
            truncated: responsePolicy.truncated,
          },
        });
        toolCount += 1;
        return { status: "success", approval: approvalEntry };
      } catch (error: any) {
        const durationMs = Date.now() - start;
        const executionId = nanoid();
        const message = error?.message || String(error);
        toolHistory.push({ executionId, toolName, args, output: `Error executing tool: ${message}`, rawOutput: null, timestamp: new Date().toISOString(), tool_call_id: tc.id, status: "error" });
        push({ role: "tool", content: `Error executing tool: ${message}`, tool_call_id: tc.id || `${tc.name}_${toolCount}`, name: tc.name });
        markToolFailure(message, toolName, toolCallId);
        onEvent?.({ type: "tool_call", phase: "error", name: toolName, id: tc.id, args, error: { message } });
        onProgress?.({ stage: "tools", message: `Tool ${tc.name} failed`, detail: { error: message } });
        const errorOutput = { message, stack: error?.stack };
        recordTraceEvent(traceSession, {
          type: "tool_call",
          label: `Tool Error - ${toolName}`,
          actor: { scope: "tool", name: toolName, role: "tool" },
          status: "error",
          durationMs,
          requestBytes: inputBytes,
          responseBytes: traceSession?.resolvedConfig.logData ? estimatePayloadBytes(errorOutput) : undefined,
          toolDetails,
          toolExecutionId: executionId,
          error: { message, stack: error?.stack },
          sections: buildToolTraceSections({
            args: sanitizedArgs,
            durationMs,
            executionId,
            output: errorOutput,
            status: "error",
            summary: `Error executing tool: ${message}`,
            toolDetails,
            toolName,
          }),
        });
        toolCount += 1;
        return { status: "error", approval: approvalEntry };
      }
    };

    // Split into two index groups: tools that need human approval must run
    // sequentially (the first pending one short-circuits the turn), tools that
    // do not need approval can be fanned out up to `maxParallelTools`.
    const approvalIndices: number[] = [];
    const parallelIndices: number[] = [];
    planned.forEach((tc, idx) => {
      const t = toolByName.get(tc.name);
      if (t && (t as any).needsApproval) approvalIndices.push(idx);
      else parallelIndices.push(idx);
    });

    let shouldStop = false;
    const checkCancellationStop = () => {
      const cancelState = isCancelled();
      if (cancelState.cancelled) {
        const ctx = (state.ctx = state.ctx || {});
        (ctx as any).__cancelled = { stage: "tools", reason: cancelState.reason, timestamp: new Date().toISOString() };
        onEvent?.({ type: "cancelled", stage: "tools", reason: cancelState.reason });
        onProgress?.({ stage: "tools", message: "Cancelled", detail: { reason: cancelState.reason } });
        shouldStop = true;
        return true;
      }
      return false;
    };

    // Approval-requiring tools: sequential so the first pending approval can
    // break the turn deterministically.
    for (const idx of approvalIndices) {
      if (awaitingApproval || awaitingUserQuestion || shouldStop) break;
      if (checkCancellationStop()) break;
      const result = await runOne(planned[idx], orderedSlots[idx]);
      if (result.status === "awaiting_approval") {
        awaitingApproval = true;
        break;
      }
      if (result.status === "awaiting_user_question") {
        awaitingUserQuestion = true;
        break;
      }
    }

    // Fan out non-approval tools with bounded concurrency.
    if (!awaitingApproval && !awaitingUserQuestion && !shouldStop && parallelIndices.length > 0) {
      const concurrency = Math.max(1, Math.min(limits.maxParallelTools, parallelIndices.length));
      let cursor = 0;
      const workerError: { err?: unknown } = {};
      const workers: Promise<void>[] = [];
      for (let w = 0; w < concurrency; w++) {
        workers.push((async () => {
          while (true) {
            if (workerError.err || shouldStop || awaitingApproval || awaitingUserQuestion) return;
            const i = cursor++;
            if (i >= parallelIndices.length) return;
            if (checkCancellationStop()) return;
            const idx = parallelIndices[i];
            try {
              const result = await runOne(planned[idx], orderedSlots[idx]);
              if (result.status === "awaiting_approval") {
                awaitingApproval = true;
                return;
              }
              if (result.status === "awaiting_user_question") {
                awaitingUserQuestion = true;
                return;
              }
            } catch (err) {
              workerError.err = err;
              return;
            }
          }
        })());
      }
      await Promise.all(workers);
      if (workerError.err) throw workerError.err;
    }

    // Flatten per-planned-index slots into the canonical appended order so
    // tool_result blocks line up with the assistant turn's tool_use order.
    for (const slot of orderedSlots) {
      if (slot.length > 0) appended.push(...slot);
    }

    for (const tc of skipped) {
      onEvent?.({ type: "tool_call", phase: "skipped", name: tc.name, id: tc.id, args: tc.args });
      const toolDetails = buildToolDetails(toolByName.get(tc.name), tc.name);
      const skipMessage = `Skipped tool due to tool-call limit: ${tc.name}`;
      recordTraceEvent(traceSession, {
        type: "tool_call",
        label: `Tool Skipped - ${tc.name}`,
        actor: { scope: "tool", name: tc.name, role: "tool" },
        status: "skipped",
        toolDetails,
        toolExecutionId: tc.id,
        sections: buildToolTraceSections({
          args: tc.args,
          executionId: tc.id,
          output: skipMessage,
          status: "skipped",
          summary: skipMessage,
          toolDetails,
          toolName: tc.name,
        }),
      });
      appended.push({ role: "tool", content: skipMessage, tool_call_id: tc.id || `${tc.name}_${appended.length}`, name: tc.name });
      toolCount += 1;
    }

    if (!awaitingApproval && state.ctx?.__awaitingApproval) {
      const ctx = { ...state.ctx };
      delete ctx.__awaitingApproval;
      if (!pendingApprovals.some((entry) => entry.status !== "executed")) {
        delete ctx.__resumeStage;
      }
      state.ctx = Object.keys(ctx).length > 0 ? ctx : undefined;
    }

    // New tool results invalidate any prior "summarizer had nothing to
    // compress" verdict — fresh raw payloads are now in scope. Without this,
    // a previously-exhausted summarization run would silently suppress
    // legitimate compaction on subsequent turns.
    const appendedHasToolResult = appended.some((m) => m.role === "tool");
    if (appendedHasToolResult && state.ctx?.__summarizationExhausted) {
      const ctx = { ...state.ctx };
      delete ctx.__summarizationExhausted;
      state.ctx = Object.keys(ctx).length > 0 ? ctx : undefined;
    }

    return {
      messages: [...state.messages, ...appended],
      toolCallCount: toolCount,
      toolHistory,
      toolHistoryArchived,
      toolCache: state.toolCache,
      // Explicitly propagate ctx so callers using `{ ...state, ...delta }`
      // do not silently capture a stale ctx reference. Mutations to
      // __summarizationExhausted / __awaitingApproval / __awaitingUserQuestion /
      // __structuredOutputParsed are made on this object during execution.
      ctx: state.ctx,
      agent: state.agent,
      pendingApprovals,
      pendingUserQuestions,
    };
  };
}
