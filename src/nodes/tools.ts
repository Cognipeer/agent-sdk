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

export function createToolsNode(initialTools: Array<ToolInterface<any, any, any>>, opts?: SmartAgentOptions) {
  const baseToolByName = new Map<string, ToolInterface>();
  for (const t of initialTools) baseToolByName.set((t as any).name, t);

  return async (state: SmartState): Promise<any> => {
    const runtime = state.agent || {
      name: opts?.name,
      model: opts?.model,
      tools: initialTools,
      limits: opts?.limits,
      systemPrompt: opts?.systemPrompt,
      useTodoList: opts?.useTodoList,
      outputSchema: (opts as any)?.outputSchema,
    } as AgentRuntimeConfig;
    const activeTools: Array<ToolInterface<any, any, any>> = runtime.tools as any;
    const toolByName = new Map<string, ToolInterface>();
    for (const t of activeTools) toolByName.set((t as any).name, t);
    const limits = {
      maxToolCalls: (runtime.limits?.maxToolCalls ?? 10) as number,
      maxParallelTools: Math.max(1, (runtime.limits?.maxParallelTools ?? 1) as number),
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
    // Sync latest state into context tools if they carry a stateRef
    for (const t of toolByName.values()) {
      const anyT: any = t as any;
      if (anyT._stateRef && typeof anyT._stateRef === "object") {
        anyT._stateRef.toolHistory = state.toolHistory;
        anyT._stateRef.toolHistoryArchived = state.toolHistoryArchived;
        anyT._stateRef.__onEvent = onEvent;
      }
    }
    const last = state.messages[state.messages.length - 1] as any;
    let toolCount = state.toolCallCount || 0;
    const toolCalls: Array<{ id?: string; name: string; args: any }> = Array.isArray(
      last?.tool_calls
    )
      ? last.tool_calls
      : [];


    const toolHistory = state.toolHistory || [];
    // Enforce global maxToolCalls across turns
    const remaining = Math.max(0, limits.maxToolCalls - toolCount);
    const planned = toolCalls.slice(0, remaining);
    const skipped = toolCalls.slice(remaining);

    // Emit immediate messages for any skipped due to limit
    for (const tc of skipped) {
      onEvent?.({ type: "tool_call", phase: "skipped", name: tc.name, id: tc.id, args: tc.args });
      const sanitizedArgs = sanitizeTracePayload(tc.args);
      const messageList = [
        {
          role: "assistant",
          name: tc.name,
          content: `Skipped tool due to tool-call limit: ${tc.name}`,
          tool_calls: [
            {
              id: tc.id,
              type: "function",
              function: {
                name: tc.name,
                arguments: sanitizedArgs,
              },
            },
          ],
        },
      ];
      recordTraceEvent(traceSession, {
        type: "tool_call",
        label: `Tool Skipped - ${tc.name}`,
        actor: { scope: "tool", name: tc.name, role: "tool" },
        status: "skipped",
        toolExecutionId: tc.id,
        messageList,
      });
      appended.push({
        role: "tool",
        content: `Skipped tool due to tool-call limit: ${tc.name}`,
        tool_call_id: tc.id || `${tc.name}_${appended.length}`,
        name: tc.name,
      });
    }

    type ToolExecutionResult =
      | { status: "success" | "error"; approval?: PendingToolApproval }
      | { status: "awaiting_approval" | "rejected"; approval: PendingToolApproval };

    const isCancelled = () => {
      if (abortSignal?.aborted) return { cancelled: true, reason: "aborted" };
      if (cancellationToken && cancellationToken.isCancellationRequested) return { cancelled: true, reason: "cancelled" };
      return { cancelled: false, reason: undefined } as const;
    };

    // Helper to run a single tool call
    const runOne = async (tc: { id?: string; name: string; args: any }): Promise<ToolExecutionResult> => {
      const cancelState = isCancelled();
      if (cancelState.cancelled) {
        const ctx = (state.ctx = state.ctx || {});
        (ctx as any).__cancelled = { stage: "tools", reason: cancelState.reason, timestamp: new Date().toISOString() };
        onEvent?.({ type: "cancelled", stage: "tools", reason: cancelState.reason });
        onProgress?.({ stage: "tools", message: "Cancelled", detail: { reason: cancelState.reason } });
        return { status: "error" };
      }
      const t = toolByName.get(tc.name);
      if (!t) {
        onEvent?.({ type: "tool_call", phase: "error", name: tc.name, id: tc.id, args: tc.args, error: { message: "Tool not found" } });
        appended.push({
          role: "tool",
          content: `Tool not found: ${tc.name}`,
          tool_call_id: tc.id || `${tc.name}_${appended.length}`,
          name: tc.name,
        });
        toolCount += 1;
        return { status: "error" };
      }
      let args: any = tc.args;
      if (typeof args === "string") {
        try { args = JSON.parse(args); } catch (_) { /* keep as string */ }
      }
      const toolCallId = tc.id || `${tc.name}_${toolCount + 1}`;
      let approvalEntry = pendingByCallId.get(toolCallId);
      const needsApproval = Boolean((t as any).needsApproval);
      if (needsApproval) {
        if (!approvalEntry) {
          approvalEntry = {
            id: nanoid(),
            toolCallId,
            toolName: (t as any).name || tc.name,
            args,
            status: "pending",
            requestedAt: new Date().toISOString(),
            metadata: (t as any).approvalPrompt || (t as any).approvalDefaults
              ? { prompt: (t as any).approvalPrompt, defaults: (t as any).approvalDefaults }
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
          appended.push({
            role: "tool",
            content: `Tool call rejected: ${rejectionMessage}`,
            tool_call_id: toolCallId,
            name: tc.name,
          });
          onEvent?.({ type: "tool_approval", status: "rejected", id: approvalEntry.id, toolName: approvalEntry.toolName, toolCallId: approvalEntry.toolCallId, comment: approvalEntry.comment, decidedBy: approvalEntry.decidedBy });
          approvalEntry.metadata = { ...(approvalEntry.metadata || {}), resolution: "rejected" };
          approvalEntry.status = "executed";
          approvalEntry.resolvedAt = new Date().toISOString();
          toolHistory.push({ executionId: nanoid(), toolName: (t as any).name, args, output: `Rejected: ${rejectionMessage}`, rawOutput: null, timestamp: new Date().toISOString(), tool_call_id: tc.id });
          pendingByCallId.set(toolCallId, approvalEntry);
          toolCount += 1;
          return { status: "rejected", approval: approvalEntry };
        }

        if (approvalEntry.status === "approved") {
          if (approvalEntry.approvedArgs !== undefined) {
            args = approvalEntry.approvedArgs;
          }
          onEvent?.({ type: "tool_approval", status: "approved", id: approvalEntry.id, toolName: approvalEntry.toolName, toolCallId: approvalEntry.toolCallId, decidedBy: approvalEntry.decidedBy, comment: approvalEntry.comment });
        }
      }
      const start = Date.now();
      try {
        onEvent?.({ type: "tool_call", phase: "start", name: (t as any).name, id: tc.id, args });
        onProgress?.({ stage: "tools", message: `Running tool ${tc.name}` });
        const sanitizedArgs = sanitizeTracePayload(args);
        const inputBytes = traceSession?.resolvedConfig.logData ? estimatePayloadBytes(sanitizedArgs) : undefined;
        let output: any;
        const anyTool = t as any;
        const callOptions = { cancellationToken, signal: abortSignal };
        if (typeof anyTool.func === "function") output = await anyTool.func(args, callOptions);
        else if (typeof anyTool.invoke === "function") output = await anyTool.invoke(args, callOptions);
        else if (typeof anyTool.call === "function") output = await anyTool.call(args, callOptions);
        else if (typeof anyTool._call === "function") output = await anyTool._call(args, callOptions);
        else if (typeof anyTool.run === "function") output = await anyTool.run(args, callOptions);
        else throw new Error("Tool is not invokable");
        // Detect handoff signature output: we decide that a handoff tool returns { __handoff: AgentRuntimeConfig }
        if (output && typeof output === 'object' && output.__handoff && output.__handoff.runtime) {
          const newRuntime: AgentRuntimeConfig = output.__handoff.runtime;
          // switch active agent; messages unchanged except we reply ok
          const executionId = nanoid();
          toolHistory.push({ executionId, toolName: (t as any).name, args, output: 'handoff:ok', rawOutput: output, timestamp: new Date().toISOString(), tool_call_id: tc.id });
          appended.push({ role: "tool", content: 'ok', tool_call_id: tc.id || `${tc.name}_${appended.length}`, name: tc.name });
          onEvent?.({ type: 'handoff', from: runtime.name, to: newRuntime.name, toolName: (t as any).name });
          state.agent = newRuntime;
          onEvent?.({ type: 'tool_call', phase: 'success', name: (t as any).name, id: tc.id, args, result: 'handoff', durationMs: Date.now() - start });
          toolCount += 1;
          if (needsApproval && approvalEntry) {
            approvalEntry.status = "executed";
            approvalEntry.resolvedAt = new Date().toISOString();
            approvalEntry.executionId = executionId;
            pendingByCallId.set(toolCallId, approvalEntry);
          }
          return { status: "success", approval: approvalEntry };
        }
        const content = typeof output === "string" ? output : JSON.stringify(output);
        if (output && typeof output === 'object' && output.__finalStructuredOutput) {
          if (!state.ctx) state.ctx = {};
          state.ctx.__structuredOutputParsed = output.data;
          state.ctx.__finalizedDueToStructuredOutput = true;
        }
        const durationMs = Date.now() - start;
        const executionId = nanoid();
        toolHistory.push({ executionId, toolName: (t as any).name, args, output, rawOutput: output, timestamp: new Date().toISOString(), tool_call_id: tc.id });
        appended.push({ role: "tool", content, tool_call_id: tc.id || `${tc.name}_${appended.length}`, name: tc.name });
        onEvent?.({ type: "tool_call", phase: "success", name: (t as any).name, id: tc.id, args, result: output, durationMs });
        onProgress?.({ stage: "tools", message: `Tool ${tc.name} completed`, detail: { durationMs } });

        if (needsApproval && approvalEntry) {
          approvalEntry.status = "executed";
          approvalEntry.resolvedAt = new Date().toISOString();
          approvalEntry.executionId = executionId;
          pendingByCallId.set(toolCallId, approvalEntry);
        }

        const sanitizedOutput = sanitizeTracePayload(output);
        const outputBytes = traceSession?.resolvedConfig.logData ? estimatePayloadBytes(sanitizedOutput) : undefined;
        const toolName = (t as any).name || tc.name;
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
            content: sanitizedOutput ?? output ?? "",
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
        });
        toolCount += 1;
  return { status: "success", approval: approvalEntry };
      } catch (e: any) {
        const durationMs = Date.now() - start;
        const executionId = nanoid();
        toolHistory.push({ executionId, toolName: (t as any).name, args, output: `Error executing tool: ${e?.message || String(e)}`, rawOutput: null, timestamp: new Date().toISOString(), tool_call_id: tc.id });
        appended.push({ role: "tool", content: `Error executing tool: ${e?.message || String(e)}`, tool_call_id: tc.id || `${tc.name}_${appended.length}`, name: tc.name });
        onEvent?.({ type: "tool_call", phase: "error", name: (t as any).name, id: tc.id, args, error: { message: e?.message || String(e) } });
        onProgress?.({ stage: "tools", message: `Tool ${tc.name} failed`, detail: { error: e?.message || String(e) } });
        const sanitizedArgs = sanitizeTracePayload(args);
        const inputBytes = traceSession?.resolvedConfig.logData ? estimatePayloadBytes(sanitizedArgs) : undefined;
        const toolName = (t as any).name || tc.name;
        const errorMessage = e?.message || String(e);
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
            content: `Error executing tool: ${errorMessage}`,
          },
        ];
        recordTraceEvent(traceSession, {
          type: "tool_call",
          label: `Tool Error - ${toolName}`,
          actor: { scope: "tool", name: toolName, role: "tool" },
          status: "error",
          durationMs,
          requestBytes: inputBytes,
          toolExecutionId: executionId,
          error: { message: e?.message || String(e), stack: e?.stack },
          messageList,
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
      if (result?.status === "awaiting_approval") {
        awaitingApproval = true;
        break;
      }
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
      agent: state.agent,
      pendingApprovals,
    };
  };
}
