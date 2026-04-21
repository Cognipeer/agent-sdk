import type {
  SmartAgentEvent,
  SmartAgentOptions,
  SmartState,
  AgentRuntimeConfig,
  ToolInterface,
  Message,
  PendingToolApproval,
} from "../types.js";
import { nanoid } from "nanoid";
import { recordTraceEvent, sanitizeTracePayload, estimatePayloadBytes } from "../utils/tracing.js";
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
    let awaitingApproval = false;

    for (const tool of toolByName.values()) {
      const anyTool: any = tool as any;
      if (anyTool._stateRef && typeof anyTool._stateRef === "object") {
        anyTool._stateRef.toolHistory = state.toolHistory;
        anyTool._stateRef.toolHistoryArchived = state.toolHistoryArchived;
        anyTool._stateRef.pendingApprovals = pendingApprovals;
        anyTool._stateRef.ctx = state.ctx || (state.ctx = {});
        anyTool._stateRef.__onEvent = onEvent;
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

    type ToolExecutionResult =
      | { status: "success" | "error"; approval?: PendingToolApproval }
      | { status: "awaiting_approval" | "rejected"; approval: PendingToolApproval };

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

    const runOne = async (tc: { id?: string; name: string; args: any }): Promise<ToolExecutionResult> => {
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
        appended.push({ role: "tool", content: `Tool not found: ${tc.name}`, tool_call_id: tc.id || `${tc.name}_${appended.length}`, name: tc.name });
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
        appended.push({ role: "tool", content: errorMessage, tool_call_id: toolCallId, name: tc.name });
        markToolFailure(errorMessage, tc.name, toolCallId);
        onEvent?.({ type: "tool_call", phase: "error", name: tc.name, id: tc.id, args, error: { message: errorMessage } });
        toolCount += 1;
        return { status: "error" };
      }
      if (validatedArgs.ok) {
        args = validatedArgs.value;
      }

      const toolName = (tool as any).name || tc.name;
      const toolStateRef = (tool as any)._stateRef && typeof (tool as any)._stateRef === "object"
        ? (tool as any)._stateRef as Record<string, any>
        : null;

      if (toolStateRef) {
        toolStateRef.pendingApprovals = pendingApprovals;
        toolStateRef.ctx = state.ctx || (state.ctx = {});
        toolStateRef.__currentToolCallId = toolCallId;
        delete toolStateRef.__awaitingApproval;
      }

      const maxExecutionsPerRun = normalizeMaxExecutionsPerRun((tool as any).maxExecutionsPerRun);
      if (maxExecutionsPerRun !== null) {
        const currentExecutions = countSuccessfulToolExecutions(toolHistory, toolName);
        if (currentExecutions >= maxExecutionsPerRun) {
          const limitMessage = `Skipped tool due to per-tool execution limit: ${toolName} (${maxExecutionsPerRun}/run)`;
          appended.push({ role: "tool", content: limitMessage, tool_call_id: toolCallId, name: tc.name });
          onEvent?.({ type: "tool_call", phase: "skipped", name: toolName, id: tc.id, args });
          recordTraceEvent(traceSession, {
            type: "tool_call",
            label: `Tool Skipped - ${toolName}`,
            actor: { scope: "tool", name: toolName, role: "tool" },
            status: "skipped",
            toolExecutionId: tc.id,
            messageList: [
              {
                role: "assistant",
                name: toolName,
                content: limitMessage,
                tool_calls: [
                  {
                    id: tc.id,
                    type: "function",
                    function: { name: toolName, arguments: sanitizeTracePayload(args) },
                  },
                ],
              },
            ],
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
          appended.push({ role: "tool", content: `Tool call rejected: ${rejectionMessage}`, tool_call_id: toolCallId, name: tc.name });
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

      try {
        onEvent?.({ type: "tool_call", phase: "start", name: toolName, id: tc.id, args });
        onProgress?.({ stage: "tools", message: `Running tool ${tc.name}` });
        const anyTool = tool as any;
        const callOptions = { cancellationToken, signal: abortSignal };
        let output: any;
        if (typeof anyTool.func === "function") output = await anyTool.func(args, callOptions);
        else if (typeof anyTool.invoke === "function") output = await anyTool.invoke(args, callOptions);
        else if (typeof anyTool.call === "function") output = await anyTool.call(args, callOptions);
        else if (typeof anyTool._call === "function") output = await anyTool._call(args, callOptions);
        else if (typeof anyTool.run === "function") output = await anyTool.run(args, callOptions);
        else throw new Error("Tool is not invokable");

        const durationMs = Date.now() - start;
        const executionId = nanoid();

        if (output && typeof output === "object" && output.__handoff && output.__handoff.runtime) {
          toolHistory.push({ executionId, toolName, args, output: "handoff:ok", rawOutput: output, timestamp: new Date().toISOString(), tool_call_id: tc.id, status: "handoff" });
          appended.push({ role: "tool", content: "ok", tool_call_id: tc.id || `${tc.name}_${appended.length}`, name: tc.name });
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

        appended.push({ role: "tool", content: responsePolicy.content, tool_call_id: tc.id || `${tc.name}_${appended.length}`, name: tc.name });
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
        const messageList = [
          {
            role: "assistant",
            name: toolName,
            content: "",
            tool_calls: [
              {
                id: tc.id || executionId,
                type: "function",
                function: {
                  name: toolName,
                  arguments: sanitizedArgs,
                },
              },
            ],
          },
          {
            role: "tool",
            name: toolName,
            content: responsePolicy.content,
          },
        ];
        recordTraceEvent(traceSession, {
          type: "tool_call",
          label: `Tool Execution - ${toolName}`,
          actor: { scope: "tool", name: toolName, role: "tool" },
          durationMs,
          requestBytes: inputBytes,
          responseBytes: outputBytes,
          toolExecutionId: executionId,
          messageList,
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
        appended.push({ role: "tool", content: `Error executing tool: ${message}`, tool_call_id: tc.id || `${tc.name}_${appended.length}`, name: tc.name });
        markToolFailure(message, toolName, toolCallId);
        onEvent?.({ type: "tool_call", phase: "error", name: toolName, id: tc.id, args, error: { message } });
        onProgress?.({ stage: "tools", message: `Tool ${tc.name} failed`, detail: { error: message } });
        recordTraceEvent(traceSession, {
          type: "tool_call",
          label: `Tool Error - ${toolName}`,
          actor: { scope: "tool", name: toolName, role: "tool" },
          status: "error",
          durationMs,
          requestBytes: inputBytes,
          toolExecutionId: executionId,
          error: { message, stack: error?.stack },
          messageList: [
            {
              role: "assistant",
              name: toolName,
              content: "",
              tool_calls: [
                {
                  id: tc.id || executionId,
                  type: "function",
                  function: { name: toolName, arguments: sanitizedArgs },
                },
              ],
            },
            {
              role: "tool",
              name: toolName,
              content: `Error executing tool: ${message}`,
            },
          ],
        });
        toolCount += 1;
        return { status: "error", approval: approvalEntry };
      }
    };

    for (const tc of planned) {
      if (awaitingApproval) break;
      const cancelState = isCancelled();
      if (cancelState.cancelled) {
        const ctx = (state.ctx = state.ctx || {});
        (ctx as any).__cancelled = { stage: "tools", reason: cancelState.reason, timestamp: new Date().toISOString() };
        onEvent?.({ type: "cancelled", stage: "tools", reason: cancelState.reason });
        onProgress?.({ stage: "tools", message: "Cancelled", detail: { reason: cancelState.reason } });
        break;
      }
      const result = await runOne(tc);
      if (result.status === "awaiting_approval") {
        awaitingApproval = true;
        break;
      }
    }

    for (const tc of skipped) {
      onEvent?.({ type: "tool_call", phase: "skipped", name: tc.name, id: tc.id, args: tc.args });
      const sanitizedArgs = sanitizeTracePayload(tc.args);
      recordTraceEvent(traceSession, {
        type: "tool_call",
        label: `Tool Skipped - ${tc.name}`,
        actor: { scope: "tool", name: tc.name, role: "tool" },
        status: "skipped",
        toolExecutionId: tc.id,
        messageList: [
          {
            role: "assistant",
            name: tc.name,
            content: `Skipped tool due to tool-call limit: ${tc.name}`,
            tool_calls: [
              {
                id: tc.id,
                type: "function",
                function: { name: tc.name, arguments: sanitizedArgs },
              },
            ],
          },
        ],
      });
      appended.push({ role: "tool", content: `Skipped tool due to tool-call limit: ${tc.name}`, tool_call_id: tc.id || `${tc.name}_${appended.length}`, name: tc.name });
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

    return {
      messages: [...state.messages, ...appended],
      toolCallCount: toolCount,
      toolHistory,
      toolHistoryArchived,
      agent: state.agent,
      pendingApprovals,
    };
  };
}
