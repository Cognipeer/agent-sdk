import type { Message, SmartAgentOptions, SmartState, ToolInterface } from "../types.js";
import { normalizeUsage, recordUsage } from "../utils/usage.js";
import { recordTraceEvent, sanitizeTracePayload, estimatePayloadBytes, getModelName, getProviderName } from "../utils/tracing.js";
import { toToolDefinition } from "../providers/adapter.js";
import { buildSystemPrompt } from "../prompts.js";
import { getResolvedSmartConfig } from "../smart/runtimeConfig.js";
import { detectVolatileContent } from "../smart/contextPilot/index.js";
import type { PluginRunHost } from "../plugins/host.js";

// Minimal agent node: no system prompt injection. Invokes model with messages as-is.
export function createAgentCoreNode(opts: SmartAgentOptions) {
  return async (state: SmartState): Promise<Partial<SmartState>> => {
    const runtime: any = state.agent || {
      name: opts.name,
      version: opts.version,
      model: opts.model,
      tools: (opts.tools as any) || [],
      guardrails: (opts as any).guardrails,
      systemPrompt: undefined,
      todoListPrompt: opts.todoListPrompt,
      limits: opts.limits,
      useTodoList: undefined,
      outputSchema: (opts as any).outputSchema,
      tracing: opts.tracing,
      responseFormat: undefined,
    };

    // The tool menu and the wire message list are both mutable for one call: a
    // preModelCall hook may narrow the menu or inject context. Everything
    // derived from them — the binding, the trace menu, the prompt payload — is
    // computed AFTER the hook, so the trace describes the request that was
    // actually sent rather than the one we intended to send.
    let tools: Array<ToolInterface<any, any, any>> = (runtime.tools as any) ?? [];
    const shouldUseStrictToolCalling = Boolean(
      runtime.responseFormat
      && (runtime.model as any)?.capabilities?.strictToolCalling
    );
    const bindToolMenu = (menu: Array<ToolInterface<any, any, any>>) =>
      (runtime.model)?.bindTools
        ? (runtime.model).bindTools(
            menu,
            shouldUseStrictToolCalling ? { strict: true } : undefined,
          )
        : runtime.model;
    /** bindTools is optional; without it a menu mutation never reaches the wire. */
    const menuMutationReachesProvider = typeof (runtime.model)?.bindTools === "function";

    const traceSession = (state.ctx as any)?.__traceSession;
    const actorName = runtime.name ?? opts.name ?? "agent";
    const actorVersion = runtime.version ?? opts.version;

    // Tool MENU bound to THIS call, recorded on the ai_call trace event so
    // observability can answer "which tools was the model offered on this
    // turn?" (the menu can change between iterations). Built once per call;
    // a schema-conversion failure must never break the model invocation.
    let traceToolDefinitions: Array<{ name: string; description?: string; parameters?: Record<string, any> }> | undefined;
    const computeTraceToolDefinitions = (menu: Array<ToolInterface<any, any, any>>) => {
      if (!traceSession || !traceSession.resolvedConfig.logData || menu.length === 0) return undefined;
      try {
        return menu.map((tool) => {
          const def = toToolDefinition(tool, shouldUseStrictToolCalling ? true : undefined);
          return { name: def.name, description: def.description || undefined, parameters: def.parameters };
        });
      } catch {
        return menu
          .map((tool: any) => ({ name: typeof tool?.name === "string" ? tool.name : "" }))
          .filter((tool) => tool.name.length > 0);
      }
    };

    // Reassigned once the hook has run, so hook latency is not billed as model
    // latency and the payload reflects the final wire messages.
    let start = Date.now();
    const shouldLogPrompt = !!traceSession && traceSession.resolvedConfig.logData;
    let promptPayload: any;
    let promptBytes: number | undefined;

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

      } catch {
        // Debug tool pairing failed silently
      }
    };

    const onEvent = (state.ctx as any)?.__onEvent as ((e: any) => void) | undefined;
    const onStream = (state.ctx as any)?.__onStream as ((chunk: { text: string; isFinal?: boolean }) => void) | undefined;
    const streamingEnabled = Boolean((state.ctx as any)?.__streaming);
    const cancellationToken = (state.ctx as any)?.__cancellationToken as any;
    const abortSignal = (state.ctx as any)?.__abortSignal as AbortSignal | undefined;

    // ContextPilot cache alignment: one-time-per-run warning when the system
    // prompt contains volatile substrings (UUIDs, timestamps, JWTs, hashes,
    // API keys) that would defeat provider-side prompt caching by changing on
    // every request. Detection-only — the system prompt is never rewritten.
    const resolvedForCachePilot = getResolvedSmartConfig(opts, runtime as any);
    if (resolvedForCachePilot.contextPilot.enabled && resolvedForCachePilot.contextPilot.cacheAlignment.enabled) {
      const ctxForCacheWarning = (state.ctx = state.ctx || {});
      if (!ctxForCacheWarning.__contextPilotCacheWarned) {
        const systemMessages = (state.messages || []).filter((m: any) => m?.role === "system");
        const systemText = systemMessages
          .map((m: any) => (typeof m.content === "string" ? m.content : ""))
          .join("\n");
        const findings = detectVolatileContent(systemText);
        if (findings.length > 0) {
          ctxForCacheWarning.__contextPilotCacheWarned = true;
          if (resolvedForCachePilot.contextPilot.cacheAlignment.warnOnVolatilePrompt) {
            const patternCounts = findings.reduce((acc: Record<string, number>, finding) => {
              acc[finding.pattern] = (acc[finding.pattern] || 0) + 1;
              return acc;
            }, {});
            onEvent?.({
              type: "metadata",
              reason: "context_pilot_cache_alignment",
              message: "Volatile content detected in system prompt; this may defeat provider-side prompt caching.",
              patternCounts,
            } as any);
            recordTraceEvent(traceSession, {
              type: "metadata",
              label: "ContextPilot: volatile system prompt content",
              actor: { scope: "agent", name: actorName, role: "agent" },
              sections: [
                {
                  kind: "metadata",
                  label: "Volatile content findings",
                  data: { patternCounts, totalFindings: findings.length },
                },
              ],
            });
          }
        }
      }
    }

    // Native structured output: pass response_format to model invocation if set
    const responseFormat = (runtime as any).responseFormat as Record<string, any> | undefined;

    // Structured-output CONTRACT recorded on the ai_call trace event, so
    // observability can answer "was this call required to return JSON, and
    // against which schema?" — the question a malformed-output investigation
    // starts from, and the contract a replay (evaluation / prompt optimizer)
    // has to reproduce to be measuring the same system.
    //
    // Both strategies are reported through the same section: the native one
    // carries the wire `response_format`, the tool-based one carries the
    // schema of the injected `response` tool, which enforces the very same
    // contract by another route.
    let traceResponseFormat: Record<string, any> | undefined = responseFormat;
    let traceResponseFormatStrategy: "native" | "tool_based" | undefined = responseFormat ? "native" : undefined;
    // Derived from the FINAL tool menu, so it must run after preModelCall.
    const resolveTraceResponseFormat = () => {
      if (traceResponseFormat || !(runtime as any).outputSchema) return;
      const responseTool = traceToolDefinitions?.find((tool) => tool.name === "response");
      if (responseTool?.parameters) {
        traceResponseFormat = {
          type: "json_schema",
          json_schema: { name: "response", strict: false, schema: responseTool.parameters },
        };
        traceResponseFormatStrategy = "tool_based";
      }
    };

    // Unified reasoning pass-through: when the loop resolved a ReasoningConfig we
    // place the native shape on ctx.__reasoning. We forward it into invoke options
    // so native providers (OpenAI/Anthropic/Vertex) can map it to their own body.
    const reasoningForCall = (state.ctx as any)?.__reasoning;
    const reasoningInvokeOpts = reasoningForCall ? { reasoning: reasoningForCall } : undefined;

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

    // ── Plugin gate: preModelCall ────────────────────────────────────────────
    // Raised here rather than in the run loop because this is the only place
    // where the tool menu, the wire messages and the invoke options all exist
    // together. One consequence worth knowing: it therefore also covers the
    // post-loop structured-output finalize call, which no guardrail reached
    // before the plugin layer existed.
    const host = (state.ctx as any)?.__plugins as PluginRunHost | undefined;
    const iteration = Number((state.ctx as any)?.__iteration) || ((state as any).usage?.perRequest?.length ?? 0) + 1;

    // Wire messages are SEPARATE from the transcript: adjacency normalization
    // and any hook injection apply to what the provider sees, never to what is
    // persisted. `messagesWithResponse` below is still built from state.messages.
    let wireMessages: any[] = [...(state.messages as any[])];

    // A handoff replaces `state.agent` with the TARGET agent's runtime mid-run.
    // The tool menu follows it; the persona has to follow it too, or the target
    // answers under its predecessor's instructions and its own systemPrompt and
    // name never reach the model — which reads as an agent ignoring the tools it
    // was just handed.
    //
    // This is deliberately applied to `wireMessages` and never to the
    // transcript: persisting the target's persona would leave the caller's
    // returned messages describing an agent that is no longer in control, and
    // the next turn would run the original agent under it.
    //
    // The originating agent's skill/subagent catalog is NOT carried over — those
    // tools left the menu with the handoff. Plugin contributions ARE, because the
    // plugins still govern the run and their hooks still fire.
    const handoffActive = Boolean((state.ctx as any)?.__handoffActive);
    if (
      handoffActive
      && runtime.name !== opts.name
      && wireMessages[0]?.role === "system"
      && ((runtime as any).systemPrompt || runtime.name)
    ) {
      let persona = buildSystemPrompt(
        (runtime as any).systemPrompt,
        (runtime as any).useTodoList === true,
        runtime.name || "Agent",
        (runtime as any).todoListPrompt,
      );
      const contribute = (state.ctx as any)?.__applySystemPromptContribution;
      if (typeof contribute === "function") persona = contribute(persona);
      const append = (state.ctx as any)?.__pluginSystemPromptAppend;
      if (append) persona = `${persona}\n\n${append}`;
      wireMessages = [{ ...wireMessages[0], content: persona }, ...wireMessages.slice(1)];
    }

    let invokeParams: Record<string, any> = {
      signal: abortSignal,
      cancellationToken,
      ...(responseFormat || {}),
      ...(reasoningInvokeOpts || {}),
    };
    let shortCircuited: any;

    if (host?.has("preModelCall")) {
      const gate = await host.runGate("preModelCall", {
        messages: wireMessages as any,
        tools,
        params: invokeParams,
        model: runtime.model,
        iteration,
      });

      if (gate.input.tools !== tools) {
        if (menuMutationReachesProvider) {
          tools = gate.input.tools as any;
        } else {
          // Recording a restriction that never reached the wire would make the
          // trace claim a guarantee the run does not have.
          onEvent?.({
            type: "metadata",
            pluginWarning: "preModelCall tool-menu mutation ignored: this model has no bindTools()",
          } as any);
        }
      }
      wireMessages = gate.input.messages as any[];
      invokeParams = gate.input.params as Record<string, any>;

      if (gate.decision === "deny") {
        const reason = gate.reason || "Model call blocked by a plugin policy.";
        (state.ctx = state.ctx || {}).__guardrailBlocked = {
          phase: "request",
          incident: { reason, deniedBy: gate.deniedBy, hook: "preModelCall" },
        };
        recordTraceEvent(traceSession, {
          type: "ai_call",
          label: "Assistant Blocked (plugin)",
          actor: { scope: "agent", name: actorName, role: "assistant", version: actorVersion },
          // "skipped", never "error": a fail-open plugin denial is a policy
          // outcome, and an "error" status would flip the whole trace session
          // status to error for a run that behaved exactly as configured.
          status: "skipped",
          model: getModelName((runtime as any).model || (opts as any).model),
          provider: getProviderName((runtime as any).model || (opts as any).model),
          messageList: state.messages,
        });
        // Exactly one appended message, no tool_calls, so the loop terminates.
        return {
          messages: [
            ...state.messages,
            {
              role: "assistant",
              name: "guardrail",
              content: reason,
              metadata: { plugin: { hook: "preModelCall", deniedBy: gate.deniedBy, reason } },
            } as any,
          ],
          usage: (state as any).usage,
        };
      }

      if (gate.shortCircuit !== undefined) shortCircuited = gate.shortCircuit;
    }

    // Everything derived from the final menu / wire messages.
    const modelWithTools = bindToolMenu(tools);
    traceToolDefinitions = computeTraceToolDefinitions(tools);
    resolveTraceResponseFormat();
    promptPayload = shouldLogPrompt ? sanitizeTracePayload(wireMessages) : undefined;
    promptBytes = promptPayload !== undefined ? estimatePayloadBytes(promptPayload) : undefined;

    // A hook owns the semantic content of the message it returns, but not the
    // accounting: dropping `usage` would silently zero the run's bill, so the
    // provider's own fields are re-attached when the hook did not set them.
    // `tool_calls` is deliberately NOT preserved — stripping them is a
    // legitimate way to stop the model from acting.
    const preserveProviderFields = (original: any, next: any): any => {
      if (!next || typeof next !== "object") return next;
      const merged: any = { ...next };
      for (const key of ["usage", "usage_metadata", "response_metadata"]) {
        if (merged[key] === undefined && original?.[key] !== undefined) merged[key] = original[key];
      }
      return merged;
    };

    let response: any;
    let modelAttempt = 0;
    const maxModelRetries = host?.maxModelRetries ?? 0;

    while (true) {
      start = Date.now();

      if (shortCircuited !== undefined) {
        response = shortCircuited;
        recordTraceEvent(traceSession, {
          type: "ai_call",
          label: "Assistant (plugin short-circuit)",
          actor: { scope: "agent", name: actorName, role: "assistant", version: actorVersion },
          status: "skipped",
          model: getModelName((runtime as any).model || (opts as any).model),
          provider: getProviderName((runtime as any).model || (opts as any).model),
          messageList: state.messages,
          toolDefinitions: traceToolDefinitions,
        });
      } else {
        try {
          // Adjacency normalization stays the LAST transform before the wire.
          const normalizedMessages = normalizeBedrockToolPairing([...wireMessages]);
          debugToolPairing(normalizedMessages);
          if (streamingEnabled && typeof (modelWithTools as any).stream === "function") {
            let streamedText = "";
            let streamedMessage: any | undefined;
            for await (const chunk of (modelWithTools as any).stream(normalizedMessages, invokeParams)) {
              if ((cancellationToken && cancellationToken.isCancellationRequested) || abortSignal?.aborted) {
                break;
              }
              if (chunk && typeof chunk === "object" && (chunk as any).role) {
                streamedMessage = chunk;
              }
              const text = extractText(chunk);
              // The provider adapter yields text deltas as plain strings and
              // then closes the stream with the FULLY ASSEMBLED message. Its
              // text is everything already sent, so emitting it as one more
              // delta makes a consumer that concatenates chunks render the
              // whole answer twice.
              //
              // Detected by value rather than by position, because a
              // LangChain-style model yields role-bearing objects for every
              // delta — there the text is a fragment, not the accumulation, so
              // it still goes out.
              const isAssembledMessage =
                Boolean(chunk && typeof chunk === "object" && (chunk as any).role)
                && text.length > 0
                && text === streamedText;
              if (text && !isAssembledMessage) {
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
            response = await modelWithTools.invoke(normalizedMessages, invokeParams);
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
            toolDefinitions: traceToolDefinitions,
            responseFormat: traceResponseFormat,
            responseFormatStrategy: traceResponseFormatStrategy,
          });
          throw err;
        }
      }

      // ── Plugin gate: postModelCall ─────────────────────────────────────────
      // Before usage extraction and the trace event, so both describe the
      // message that actually enters the transcript.
      if (!host?.has("postModelCall")) break;

      const postGate = await host.runGate("postModelCall", {
        message: response,
        usage: (response as any)?.usage,
        durationMs: Date.now() - start,
        iteration,
        shortCircuited: shortCircuited !== undefined,
      });

      if (postGate.input.message !== response) {
        response = preserveProviderFields(response, postGate.input.message);
      }

      if (postGate.decision === "deny") {
        const reason = postGate.reason || "Response blocked by a plugin policy.";
        (state.ctx = state.ctx || {}).__guardrailBlocked = {
          phase: "response",
          incident: { reason, deniedBy: postGate.deniedBy, hook: "postModelCall" },
          replaced: response,
        };
        // REPLACE, never append: the unsafe turn must not stay in the
        // transcript, and a dangling tool_calls tail must not survive.
        response = {
          role: "assistant",
          name: "guardrail",
          content: reason,
          metadata: { plugin: { hook: "postModelCall", deniedBy: postGate.deniedBy, reason } },
          usage: (response as any)?.usage,
        };
        break;
      }

      if (postGate.flags.retry && shortCircuited === undefined && modelAttempt < maxModelRetries) {
        modelAttempt += 1;
        continue;
      }
      break;
    }
    const messagesWithResponse: Message[] = [
      ...state.messages,
      response as any,
    ];

    // Usage tracking (per-request, aggregated by model)
    const rawUsage = (response as any)?.usage
      || (response as any)?.usage_metadata
      || (response as any)?.response_metadata?.token_usage
      || (response as any)?.response_metadata?.tokenUsage  // LangChain camelCase
      || (response as any)?.response_metadata?.usage
      || (response as any)?.response_metadata?.usage_metadata
      || (response as any)?.response_metadata?.usageMetadata;
    const normalized = normalizeUsage(rawUsage);
    const modelName = getModelName((runtime as any).model || (opts as any).model) || "unknown_model";
    const durationMs = Date.now() - start;

    const shouldLogResponse = !!traceSession && traceSession.resolvedConfig.logData;
    const responsePayload = shouldLogResponse ? sanitizeTracePayload(response) : undefined;
    const responseBytes = responsePayload !== undefined ? estimatePayloadBytes(responsePayload) : undefined;

    // Why the model stopped. `length` is the single most common explanation for
    // a truncated or unparseable structured response — without it that failure
    // is indistinguishable from a model that simply answered badly.
    const finishReason = (response as any)?.response_metadata?.finish_reason
      ?? (response as any)?.response_metadata?.finishReason
      ?? (response as any)?.finishReason;

    recordTraceEvent(traceSession, {
      type: "ai_call",
      label: "Assistant Response",
      actor: { scope: "agent", name: actorName, role: "assistant", version: actorVersion },
      durationMs,
      inputTokens: normalized?.prompt_tokens,
      outputTokens: normalized?.completion_tokens,
      totalTokens: normalized?.total_tokens,
      cachedInputTokens: normalized?.prompt_tokens_details?.cached_tokens,
      // A subset of completion_tokens, and on a reasoning model routinely most
      // of the output bill while being invisible in the response text.
      reasoningTokens: normalized?.completion_tokens_details?.reasoning_tokens,
      finishReason: typeof finishReason === "string" ? finishReason : undefined,
      requestBytes: promptBytes,
      responseBytes: responseBytes,
      model: modelName,
      provider: getProviderName((runtime as any).model || (opts as any).model),
      messageList: messagesWithResponse,
      toolDefinitions: traceToolDefinitions,
      responseFormat: traceResponseFormat,
      responseFormatStrategy: traceResponseFormatStrategy,
    });
    if (normalized) {
      recordUsage(state, modelName, normalized);
    }

    return { messages: messagesWithResponse, usage: (state as any).usage };
  };
}
