import type { Message, SmartAgentOptions, SmartState, ToolInterface } from "../types.js";
import { normalizeUsage } from "../utils/usage.js";
import { recordTraceEvent, sanitizeTracePayload, estimatePayloadBytes, getModelName, getProviderName } from "../utils/tracing.js";

// Minimal agent node: no system prompt injection. Invokes model with messages as-is.
export function createAgentCoreNode(opts: SmartAgentOptions) {
  return async (state: SmartState): Promise<Partial<SmartState>> => {
    const runtime = state.agent || {
      name: opts.name,
      version: opts.version,
      model: opts.model,
      tools: (opts.tools as any) || [],
      guardrails: (opts as any).guardrails,
      systemPrompt: undefined,
      limits: opts.limits,
      useTodoList: undefined,
      outputSchema: (opts as any).outputSchema,
      tracing: opts.tracing,
    };

    const tools: Array<ToolInterface<any, any, any>> = (runtime.tools as any) ?? [];
    const modelWithTools = (runtime.model)?.bindTools
      ? (runtime.model).bindTools(tools)
      : runtime.model;

    const traceSession = (state.ctx as any)?.__traceSession;
    const actorName = runtime.name ?? opts.name ?? "agent";
    const actorVersion = runtime.version ?? opts.version;
    const start = Date.now();
    const shouldLogPrompt = !!traceSession && traceSession.resolvedConfig.logData;
    const promptPayload = shouldLogPrompt ? sanitizeTracePayload(state.messages) : undefined;
    const promptBytes = promptPayload !== undefined ? estimatePayloadBytes(promptPayload) : undefined;

    // Bedrock (Claude) requires strict tool_use -> tool_result adjacency.
    // We both normalize (insert placeholder tool_result if missing) and log a compact dump.
    const extractToolUses = (m: any): Array<{ id: string; name?: string }> => {
      const tcs = m?.tool_calls || m?.additional_kwargs?.tool_calls;
      if (!Array.isArray(tcs)) return [];
      return tcs
        .map((tc: any) => ({ id: tc?.id, name: tc?.function?.name || tc?.name }))
        .filter((x: any) => typeof x.id === "string" && x.id.length > 0);
    };

    const normalizeBedrockToolPairing = (input: any[]): any[] => {
      const msgs = Array.isArray(input) ? [...input] : [];
      for (let i = 0; i < msgs.length; i++) {
        const m = msgs[i];
        if (m?.role !== "assistant") continue;

        const toolUses = extractToolUses(m);
        if (toolUses.length === 0) continue;

        // Bedrock expects exactly one "next message" containing the corresponding tool_result blocks.
        // In our message format we represent tool_result as role:'tool' messages with tool_call_id.
        // If the next message isn't a tool result for the first tool_use id, insert placeholders.
        const next = msgs[i + 1];

        // If next is a tool message for the first id, we assume pairing is okay and let downstream validate.
        const firstId = toolUses[0]?.id;
        const nextIsToolForFirst = !!(next && next.role === "tool" && next.tool_call_id === firstId);
        if (nextIsToolForFirst) continue;

        // Insert placeholder tool results for all tool uses on this assistant turn.
        const placeholders = toolUses.map((tu) => ({
          role: "tool",
          name: tu.name || "unknown_tool",
          tool_call_id: tu.id,
          content: "SUMMARIZED/DEFERRED: tool result missing in transcript; inserted placeholder for Bedrock tool_result adjacency.",
        }));
        msgs.splice(i + 1, 0, ...placeholders);

        // Skip over inserted placeholders
        i += placeholders.length;
      }
      return msgs;
    };

    const debugToolPairing = (messagesToSend: any[]) => {
      try {
        const msgs: any[] = Array.isArray(messagesToSend) ? messagesToSend : [];
        const toolUseIds: string[] = [];
        const missingResults: Array<{ id: string; atIndex: number; tool?: string }> = [];

        for (let i = 0; i < msgs.length; i++) {
          const m = msgs[i];
          if (m?.role === "assistant") {
            for (const tu of extractToolUses(m)) {
              toolUseIds.push(tu.id);
              const next = msgs[i + 1];
              if (!(next && next.role === "tool" && (next.tool_call_id === tu.id || next.tool_call_id === m?.tool_call_id))) {
                missingResults.push({ id: tu.id, atIndex: i, tool: tu.name });
              }
            }
          }
        }

      } catch (e) {
        // Debug tool pairing failed silently
      }
    };

    let response: any;
    try {
  const normalizedMessages = normalizeBedrockToolPairing([...(state.messages as any[])]);
  debugToolPairing(normalizedMessages);
  response = await modelWithTools.invoke(normalizedMessages);
    } catch (err: any) {
      const durationMs = Date.now() - start;
      recordTraceEvent(traceSession, {
        type: "ai_call",
        label: "Assistant Error",
        actor: { scope: "agent", name: actorName, role: "assistant", version: actorVersion },
        status: "error",
        durationMs,
        requestBytes: promptBytes,
        model: getModelName((runtime as any).model || (opts as any).model),
        provider: getProviderName((runtime as any).model || (opts as any).model),
        error: { message: err?.message || String(err), stack: err?.stack },
        messageList: state.messages,
      });
      throw err;
    }
    const messagesWithResponse: Message[] = [
      ...state.messages,
      response as any,
    ];

    // Usage tracking (per-request, aggregated by model)
    const rawUsage = (response as any)?.usage 
      || (response as any)?.response_metadata?.token_usage 
      || (response as any)?.response_metadata?.tokenUsage  // LangChain camelCase
      || (response as any)?.response_metadata?.usage;
    const normalized = normalizeUsage(rawUsage);
    const modelName = getModelName((runtime as any).model || (opts as any).model) || "unknown_model";
    const durationMs = Date.now() - start;

    const shouldLogResponse = !!traceSession && traceSession.resolvedConfig.logData;
    const responsePayload = shouldLogResponse ? sanitizeTracePayload(response) : undefined;
    const responseBytes = responsePayload !== undefined ? estimatePayloadBytes(responsePayload) : undefined;

    recordTraceEvent(traceSession, {
      type: "ai_call",
      label: "Assistant Response",
      actor: { scope: "agent", name: actorName, role: "assistant", version: actorVersion },
      durationMs,
      inputTokens: normalized?.prompt_tokens,
      outputTokens: normalized?.completion_tokens,
      totalTokens: normalized?.total_tokens,
      cachedInputTokens: normalized?.prompt_tokens_details?.cached_tokens,
      requestBytes: promptBytes,
      responseBytes: responseBytes,
      model: modelName,
      provider: getProviderName((runtime as any).model || (opts as any).model),
      messageList: messagesWithResponse,
    });
    if (normalized) {
      const usageState = state.usage || { perRequest: [], totals: {} };
      const id = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
      const turn = usageState.perRequest.length + 1;
      const timestamp = new Date().toISOString();
      const cachedInputTok = normalized.prompt_tokens_details?.cached_tokens;
      usageState.perRequest.push({ id, modelName, usage: normalized, timestamp, turn, cachedInput: cachedInputTok });
      const inputTok = normalized.prompt_tokens;
      const outputTok = normalized.completion_tokens;
      const totalTok = normalized.total_tokens;
      const key = modelName as string;
      const agg = usageState.totals[key] || { input: 0, output: 0, total: 0, cachedInput: 0 };
      usageState.totals[key] = {
        input: agg.input + (Number(inputTok) || 0),
        output: agg.output + (Number(outputTok) || 0),
        total: agg.total + (Number(totalTok) || 0),
        cachedInput: agg.cachedInput + (Number(cachedInputTok) || 0),
      };
      (state as any).usage = usageState;
    }

    return { messages: messagesWithResponse, usage: (state as any).usage };
  };
}
