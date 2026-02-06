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

    const rawTools: Array<ToolInterface<any, any, any>> = (runtime.tools as any) ?? [];
    // Deduplicate tools by name – last-wins so user overrides take precedence
    const seenNames = new Map<string, number>();
    const tools: Array<ToolInterface<any, any, any>> = [];
    for (const t of rawTools) {
      const tName = (t as any).name ?? (t as any).schema?.title;
      if (tName && seenNames.has(tName)) {
        // Replace the earlier occurrence with this one (last-wins)
        tools[seenNames.get(tName)!] = t;
      } else {
        if (tName) seenNames.set(tName, tools.length);
        tools.push(t);
      }
    }
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
      
      // Phase 1: Build a set of all valid tool_call IDs from assistant messages
      const validToolCallIds = new Set<string>();
      for (const m of msgs) {
        if (m?.role === 'assistant') {
          for (const tu of extractToolUses(m)) {
            if (tu.id) validToolCallIds.add(tu.id);
          }
        }
      }
      
      // Phase 2: Filter out orphan tool messages (those without a matching assistant tool_call)
      const filteredMsgs = msgs.filter((m) => {
        if (m?.role === 'tool') {
          const toolCallId = m.tool_call_id;
          if (!toolCallId || !validToolCallIds.has(toolCallId)) {
            // Orphan tool message - remove it
            return false;
          }
        }
        return true;
      });
      
      // Phase 3: Ensure tool messages immediately follow their corresponding assistant message
      // OpenAI requires: assistant(tool_calls) -> tool(tool_call_id) -> tool(tool_call_id) -> ...
      for (let i = 0; i < filteredMsgs.length; i++) {
        const m = filteredMsgs[i];
        if (m?.role !== "assistant") continue;

        const toolUses = extractToolUses(m);
        if (toolUses.length === 0) continue;

        // Bedrock expects exactly one "next message" containing the corresponding tool_result blocks.
        // In our message format we represent tool_result as role:'tool' messages with tool_call_id.
        // If the next message isn't a tool result for the first tool_use id, insert placeholders.
        const next = filteredMsgs[i + 1];

        // If next is a tool message for the first id, we assume pairing is okay and let downstream validate.
        const firstId = toolUses[0]?.id;
        const nextIsToolForFirst = !!(next && next.role === "tool" && next.tool_call_id === firstId);
        if (nextIsToolForFirst) continue;

        // Insert placeholder tool results for all tool uses on this assistant turn.
        const placeholders = toolUses.map((tu) => ({
          role: "tool",
          name: tu.name || "unknown_tool",
          tool_call_id: tu.id,
          content: "SUMMARIZED/DEFERRED: tool result missing in transcript; inserted placeholder for tool_result adjacency.",
        }));
        filteredMsgs.splice(i + 1, 0, ...placeholders);

        // Skip over inserted placeholders
        i += placeholders.length;
      }
      return filteredMsgs;
    };



    const onEvent = (state.ctx as any)?.__onEvent as ((e: any) => void) | undefined;
    const onStream = (state.ctx as any)?.__onStream as ((chunk: { text: string; isFinal?: boolean }) => void) | undefined;
    const streamingEnabled = Boolean((state.ctx as any)?.__streaming);
    const cancellationToken = (state.ctx as any)?.__cancellationToken as any;
    const abortSignal = (state.ctx as any)?.__abortSignal as AbortSignal | undefined;

    const extractText = (chunk: any) => {
      if (chunk == null) return "";
      if (typeof chunk === "string") return chunk;
      if (typeof chunk?.content === "string") return chunk.content;
      if (Array.isArray(chunk?.content)) {
        return chunk.content.map((c: any) => (typeof c === "string" ? c : c?.text ?? c?.content ?? "")).join("");
      }
      if (typeof chunk?.text === "string") return chunk.text;
      if (typeof chunk?.delta?.content === "string") return chunk.delta.content;
      return "";
    };

    let response: any;
    try {
  /**
   * Ensures tool_call/tool_use IDs are unique across the entire message history.
   *
   * LangChain Bedrock adapter returns assistant messages where the same tool call
   * appears in BOTH `tool_calls[]` (LangChain normalized) AND `content[]` as
   * `{type:"tool_use", id:"..."}` (Anthropic native). When these messages are
   * sent back through LangChain, BOTH representations get serialised into
   * separate `tool_use` content blocks, causing Bedrock to reject with:
   *   "messages.N.content.M: tool_use ids must be unique"
   *
   * Phase 1 – Deduplicate within each message: if an assistant message has
   *   tool_calls AND content[].tool_use with overlapping IDs, strip the
   *   tool_use blocks from content (tool_calls is the canonical source).
   *
   * Phase 2 – Deduplicate across messages: if the same tool_call ID appears
   *   in two different assistant messages (e.g. after summarisation), rename
   *   the later occurrence and patch corresponding tool-result messages.
   */
  const ensureUniqueToolCallIds = (input: any[]): any[] => {
    const msgs = Array.isArray(input) ? input.map((m) => ({ ...m })) : [];
    const usedIds = new Set<string>();
    let counter = 0;

    for (let i = 0; i < msgs.length; i++) {
      const m = msgs[i];
      if (m?.role !== "assistant") continue;

      const hasToolCalls = Array.isArray(m.tool_calls) && m.tool_calls.length > 0;
      const contentArr = Array.isArray(m.content) ? m.content : [];
      const hasContentToolUse = contentArr.some((c: any) => c?.type === "tool_use" && c?.id);
      const hasAdditionalToolCalls = Array.isArray(m.additional_kwargs?.tool_calls) && m.additional_kwargs.tool_calls.length > 0;

      if (!hasToolCalls && !hasContentToolUse && !hasAdditionalToolCalls) continue;

      // ------------------------------------------------------------------
      // Phase 1: Remove redundant tool_use content blocks when the same ID
      //          already exists in tool_calls (prevents intra-message dupes).
      // ------------------------------------------------------------------
      if (hasToolCalls && hasContentToolUse) {
        const toolCallIds = new Set<string>(
          m.tool_calls.filter((tc: any) => tc?.id).map((tc: any) => tc.id)
        );
        // Strip content blocks whose ID is already covered by tool_calls
        const filtered = contentArr.filter((c: any) => {
          if (c?.type === "tool_use" && c?.id && toolCallIds.has(c.id)) return false;
          return true;
        });
        // If we removed all content blocks, keep the text content or set empty string
        if (filtered.length === 0) {
          m.content = "";
        } else if (filtered.length !== contentArr.length) {
          m.content = filtered.length === 1 && filtered[0]?.type === "text"
            ? (filtered[0].text ?? "")
            : filtered;
        }
      }
      // Same for additional_kwargs: strip tool_use from content if additional_kwargs covers them
      if (hasAdditionalToolCalls && Array.isArray(m.content)) {
        const akIds = new Set<string>(
          m.additional_kwargs.tool_calls.filter((tc: any) => tc?.id).map((tc: any) => tc.id)
        );
        const arr = m.content as any[];
        const filtered = arr.filter((c: any) => {
          if (c?.type === "tool_use" && c?.id && akIds.has(c.id)) return false;
          return true;
        });
        if (filtered.length !== arr.length) {
          m.content = filtered.length === 0
            ? ""
            : filtered.length === 1 && filtered[0]?.type === "text"
              ? (filtered[0].text ?? "")
              : filtered;
        }
      }

      // ------------------------------------------------------------------
      // Phase 2: Ensure IDs are unique across different assistant messages.
      // ------------------------------------------------------------------

      // Deep-clone tool_calls so we don't mutate the originals
      if (hasToolCalls) {
        m.tool_calls = m.tool_calls.map((tc: any) => ({ ...tc }));
      }
      if (hasAdditionalToolCalls) {
        m.additional_kwargs = { ...m.additional_kwargs };
        m.additional_kwargs.tool_calls = m.additional_kwargs.tool_calls.map((tc: any) => ({ ...tc }));
      }
      // Clone remaining content tool_use blocks if any survived Phase 1
      const remainingContentArr = Array.isArray(m.content) ? m.content : [];
      const hasRemainingContentToolUse = remainingContentArr.some((c: any) => c?.type === "tool_use" && c?.id);
      if (hasRemainingContentToolUse) {
        m.content = remainingContentArr.map((c: any) =>
          (c && typeof c === "object") ? { ...c } : c
        );
      }

      // Collect all IDs from this message
      const idsInMessage = new Set<string>();
      if (hasToolCalls) {
        for (const tc of m.tool_calls) { if (tc?.id) idsInMessage.add(tc.id); }
      }
      if (hasRemainingContentToolUse) {
        for (const c of m.content as any[]) { if (c?.type === "tool_use" && c?.id) idsInMessage.add(c.id); }
      }
      if (hasAdditionalToolCalls) {
        for (const tc of m.additional_kwargs.tool_calls) { if (tc?.id) idsInMessage.add(tc.id); }
      }

      for (const id of idsInMessage) {
        if (!usedIds.has(id)) {
          usedIds.add(id);
          continue;
        }

        // Duplicate across messages – generate a unique replacement
        const newId = `${id}_${Date.now()}_${counter++}`;

        if (hasToolCalls) {
          for (const tc of m.tool_calls) { if (tc.id === id) tc.id = newId; }
        }
        if (hasRemainingContentToolUse && Array.isArray(m.content)) {
          for (const c of m.content as any[]) { if (c?.type === "tool_use" && c.id === id) c.id = newId; }
        }
        if (hasAdditionalToolCalls) {
          for (const tc of m.additional_kwargs.tool_calls) { if (tc.id === id) tc.id = newId; }
        }

        // Patch corresponding downstream tool-result messages
        for (let j = i + 1; j < msgs.length; j++) {
          const next = msgs[j];
          if (next?.role === "assistant") break;
          if (next?.role === "tool" && next.tool_call_id === id) {
            next.tool_call_id = newId;
          }
          // Anthropic-style tool_result inside content arrays
          if (Array.isArray(next?.content)) {
            let contentCloned = false;
            for (let k = 0; k < (next.content as any[]).length; k++) {
              const block = (next.content as any[])[k];
              if (block?.type === "tool_result" && block.tool_use_id === id) {
                if (!contentCloned) {
                  next.content = (next.content as any[]).map((x: any) => (x && typeof x === "object") ? { ...x } : x);
                  contentCloned = true;
                }
                (next.content as any[])[k].tool_use_id = newId;
              }
            }
          }
        }

        usedIds.add(newId);
      }
    }

    return msgs;
  };

  const normalizedMessages = ensureUniqueToolCallIds(
    normalizeBedrockToolPairing([...(state.messages as any[])])
  );
  if (streamingEnabled && typeof (modelWithTools as any).stream === "function") {
    let streamedText = "";
    let streamedMessage: any | undefined;
    const streamResult = (modelWithTools as any).stream(normalizedMessages, { signal: abortSignal, cancellationToken });
    const stream = typeof (streamResult as Promise<unknown>)?.then === "function" ? await streamResult : streamResult;
    for await (const chunk of stream) {
      if ((cancellationToken && cancellationToken.isCancellationRequested) || abortSignal?.aborted) {
        break;
      }
      if (chunk && typeof chunk === "object" && (chunk as any).role) {
        streamedMessage = chunk;
      }
      const text = extractText(chunk);
      if (text) {
        streamedText += text;
        onStream?.({ text });
        onEvent?.({ type: "stream", text });
      }
    }
    if (streamedMessage) {
      response = { ...streamedMessage };
      if (response.content == null || response.content === "") {
        response.content = streamedText;
      }
    } else {
      response = { role: "assistant", content: streamedText } as any;
    }
  } else {
    response = await modelWithTools.invoke(normalizedMessages, { signal: abortSignal, cancellationToken });
  }
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
    const rawUsage = (response as any)?.usage_metadata  // LangChain v0.3+ normalized
      || (response as any)?.usage 
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
