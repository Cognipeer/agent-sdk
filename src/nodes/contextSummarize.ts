// Lightweight message helpers to avoid hard dependency on LangChain
import type {
    SmartAgentOptions,
    SmartState,
    BaseMessage,
    SmartAgentEvent,
    StructuredSummary,
    SummarizationEvent,
    SummaryIntegrityCheck,
} from "../types.js";
import { countApproxTokens } from "../utils/utilTokens.js";
import { recordTraceEvent, sanitizeTracePayload } from "../utils/tracing.js";
import { normalizeUsage } from "../utils/usage.js";
import { getResolvedSmartConfig } from "../smart/runtimeConfig.js";
import { renderStructuredSummary } from "../smart/contextPolicy.js";

// Helper for lightweight message construction
const systemMessage = (content: string) => ({ role: 'system', content });
const humanMessage = (content: string) => ({ role: 'user', content });

function isSyntheticSummaryToolMessage(message: BaseMessage): boolean {
    return message.role === 'tool' && message.name === 'summarize_context';
}

function isSyntheticSummaryAssistantMessage(message: BaseMessage): boolean {
    if (message.role !== 'assistant' || !Array.isArray(message.tool_calls)) {
        return false;
    }

    return message.tool_calls.some((toolCall: any) => {
        const toolName = toolCall?.function?.name || toolCall?.name;
        return toolName === 'summarize_context';
    });
}

/**
 * Validates message sequence to ensure OpenAI API compatibility.
 * Every tool message must follow an assistant message with a matching tool_call.
 * This prevents "messages with role 'tool' must be a response to a preceeding message with 'tool_calls'" errors.
 */
function validateMessageSequence(messages: BaseMessage[]): BaseMessage[] {
    const validated: BaseMessage[] = [];
    const pendingToolCallIds = new Set<string>();
    
    for (const m of messages) {
        if (m.role === 'assistant') {
            // Clear any pending tool calls when we see a new assistant message without tool_calls
            if (!m.tool_calls || m.tool_calls.length === 0) {
                pendingToolCallIds.clear();
            } else {
                // Register new tool calls
                m.tool_calls.forEach((tc: any) => {
                    if (tc.id) pendingToolCallIds.add(tc.id);
                });
            }
            validated.push(m);
        } else if (m.role === 'tool') {
            const toolCallId = m.tool_call_id;
            // Only include tool messages that have a pending (expected) tool_call_id
            if (toolCallId && pendingToolCallIds.has(toolCallId)) {
                pendingToolCallIds.delete(toolCallId);
                validated.push(m);
            }
            // Otherwise, this is an orphan tool message - skip it
        } else {
            // user, system messages - always include
            validated.push(m);
        }
    }
    
    return validated;
}

/**
 * Gets the summarization configuration normalized
 */
function extractJsonObject(text: string): string | null {
    const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (fenced?.[1]) return fenced[1].trim();
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start >= 0 && end > start) {
        return text.slice(start, end + 1);
    }
    return null;
}

function normalizeStructuredSummary(input: any, fallbackText: string): StructuredSummary {
    const summary: StructuredSummary = {
        stable_facts: Array.isArray(input?.stable_facts)
            ? input.stable_facts
                    .filter((fact: any) => fact && typeof fact === "object")
                    .map((fact: any) => ({
                        key: String(fact.key || "unknown"),
                        value: String(fact.value || ""),
                        confidence: typeof fact.confidence === "number" ? fact.confidence : 0.7,
                        source: fact.source ? String(fact.source) : undefined,
                    }))
            : [],
        active_goals: Array.isArray(input?.active_goals) ? input.active_goals.map((goal: any) => String(goal)) : [],
        open_questions: Array.isArray(input?.open_questions) ? input.open_questions.map((question: any) => String(question)) : [],
        discarded_obsolete: Array.isArray(input?.discarded_obsolete || input?.obsolete_discarded)
            ? (input.discarded_obsolete || input.obsolete_discarded).map((item: any) => String(item))
            : [],
        rawSummary: typeof input?.rawSummary === "string" ? input.rawSummary : fallbackText,
    };

    if (summary.stable_facts.length === 0 && fallbackText) {
        const importantLines = fallbackText
            .split("\n")
            .map((line) => line.trim())
            .filter(Boolean)
            .slice(0, 8);
        summary.stable_facts = importantLines.map((line, index) => ({
            key: `fact_${index + 1}`,
            value: line,
            confidence: 0.5,
        }));
    }

    return summary;
}

function normalizeFactKeySegment(value: string): string {
    return value
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "_")
        .replace(/^_+|_+$/g, "")
        || "item";
}

function extractCanonicalFacts(messages: BaseMessage[]): StructuredSummary["stable_facts"] {
    const facts = new Map<string, StructuredSummary["stable_facts"][number]>();

    for (const message of messages) {
        const content = typeof message.content === "string"
            ? message.content
            : Array.isArray(message.content)
                ? message.content.map((part: any) => part?.text ?? part?.content ?? String(part ?? "")).join("\n")
                : "";
        if (!content) continue;

        const lines = content.split("\n").map((line) => line.trim()).filter(Boolean);
        for (const line of lines) {
            if (!/^[A-Z0-9_]+\|/.test(line) || !line.includes("=")) continue;

            const segments = line.split("|").map((segment) => segment.trim()).filter(Boolean);
            const label = segments[0];
            const entries = segments.slice(1)
                .map((segment) => {
                    const eqIndex = segment.indexOf("=");
                    if (eqIndex <= 0) return null;
                    return {
                        key: segment.slice(0, eqIndex).trim(),
                        value: segment.slice(eqIndex + 1).trim(),
                    };
                })
                .filter((entry): entry is { key: string; value: string } => Boolean(entry?.key));
            if (entries.length === 0) continue;

            const identifier = entries.find((entry) => ["code", "id", "project", "name", "key"].includes(entry.key.toLowerCase()))?.value;
            const keyPrefix = [normalizeFactKeySegment(label), identifier ? normalizeFactKeySegment(identifier) : undefined]
                .filter(Boolean)
                .join(".");

            for (const entry of entries) {
                const normalizedEntryKey = normalizeFactKeySegment(entry.key);
                const factKey = keyPrefix ? `${keyPrefix}.${normalizedEntryKey}` : `${normalizeFactKeySegment(label)}.${normalizedEntryKey}`;
                facts.set(factKey, {
                    key: factKey,
                    value: entry.value,
                    confidence: 0.98,
                    source: "canonical_tool_output",
                });
            }
        }
    }

    return [...facts.values()];
}

function mergeStableFacts(
    summary: StructuredSummary,
    additionalFacts: StructuredSummary["stable_facts"],
): StructuredSummary {
    if (additionalFacts.length === 0) return summary;

    const merged = new Map(summary.stable_facts.map((fact) => [fact.key, fact]));
    for (const fact of additionalFacts) {
        const existing = merged.get(fact.key);
        if (!existing || (fact.confidence || 0) >= (existing.confidence || 0)) {
            merged.set(fact.key, fact);
        }
    }

    return {
        ...summary,
        stable_facts: [...merged.values()],
    };
}

function runIntegrityCheck(previous: StructuredSummary | undefined, current: StructuredSummary): SummaryIntegrityCheck {
    const notes: string[] = [];
    const previousKeys = new Set((previous?.stable_facts || []).map((fact) => fact.key));
    const currentKeys = new Set(current.stable_facts.map((fact) => fact.key));
    const obsoleteKeys = new Set(current.discarded_obsolete);
    const criticalFactLoss = [...previousKeys].some((key) => !obsoleteKeys.has(key) && !currentKeys.has(key));
    const obsoleteFactRevived = current.stable_facts.some((fact) => obsoleteKeys.has(fact.key));

    if (criticalFactLoss) {
        notes.push("Missing previously retained facts; merged forward during integrity repair.");
    }
    if (obsoleteFactRevived) {
        notes.push("Obsolete facts reappeared; removed during integrity repair.");
    }

    return {
        passed: !criticalFactLoss && !obsoleteFactRevived,
        criticalFactLoss,
        obsoleteFactRevived,
        notes,
    };
}

function repairStructuredSummary(previous: StructuredSummary | undefined, current: StructuredSummary, integrity: SummaryIntegrityCheck): StructuredSummary {
    if (!previous) return current;
    const nextFacts = [...current.stable_facts];
    if (integrity.criticalFactLoss) {
        const existingKeys = new Set(nextFacts.map((fact) => fact.key));
        for (const fact of previous.stable_facts) {
            if (!existingKeys.has(fact.key) && !current.discarded_obsolete.includes(fact.key)) {
                nextFacts.push(fact);
            }
        }
    }
    const filteredFacts = integrity.obsoleteFactRevived
        ? nextFacts.filter((fact) => !current.discarded_obsolete.includes(fact.key))
        : nextFacts;
    return { ...current, stable_facts: filteredFacts };
}

/**
 * Creates the summarization node.
 * 
 * Logic:
 * 1. Check if summarization is enabled.
 * 2. Convert current conversation history into a text suitable for summarization.
 * 3. Invoke the model to generate a summary of the conversation.
 * 4. Rewrite the message history:
 *    - All tool messages (role='tool') have their content replaced with "SUMMARIZED".
 *    - A new assistant message calling 'summarize_context' is appended.
 *    - A new tool message with the summary content is appended.
 */
export function createContextSummarizeNode(opts: SmartAgentOptions) {
  return async (state: SmartState): Promise<Partial<SmartState>> => {
        const resolved = getResolvedSmartConfig(opts, state.agent as any);
        const config = resolved.summarization;
        if (!config.enable) return {};

    const model = (opts as any).model;
    const messages = state.messages || [];

    // Get onEvent and traceSession from state context
    const onEvent = (state.ctx as any)?.__onEvent as ((e: SmartAgentEvent) => void) | undefined;
    const traceSession = (state.ctx as any)?.__traceSession;

    // Check if there are any tool messages that can be compressed
    const compressableMessages = messages.filter(
        (m) => m.role === 'tool' && m.content !== "SUMMARIZED" && !isSyntheticSummaryToolMessage(m),
    );
    if (compressableMessages.length === 0) {
        // Nothing to compress. If we summarize, we only ADD tokens (summary).
        // Abort to prevent infinite loops or growing context.
        return {};
    }

    // Calculate token count before summarization
    const allTextBefore = messages
      .map((m: any) => typeof m.content === "string" ? m.content : Array.isArray(m.content) ? m.content.map((c: any) => (typeof c === 'string' ? c : c?.text ?? c?.content ?? '')).join('') : '')
      .join("\n");
    const tokenCountBefore = countApproxTokens(allTextBefore);

    // 1. Generate Summary
    // We convert current messages to a simple text format for the model to summarize.
    // IMPORTANT: We must truncate the conversation to fit within summaryPromptMaxTokens
    // to avoid "input too large" errors from the model.
    
    // Build conversation text from RECENT messages, respecting token budget
    const summaryPromptMaxTokens = config.summaryPromptMaxTokens;
    // Reserve ~500 tokens for the system prompt and instructions
    const availableTokensForConversation = summaryPromptMaxTokens - 500;
    
    // Build messages from newest to oldest, stopping when we hit the budget
    const messageTexts: string[] = [];
    let accumulatedTokens = 0;
    
    // Process messages from end to start (most recent first)
    for (let i = messages.length - 1; i >= 0; i--) {
        const m = messages[i];
        if (isSyntheticSummaryToolMessage(m) || isSyntheticSummaryAssistantMessage(m)) {
            continue;
        }
        let content = "";
        if (typeof m.content === "string") content = m.content;
        else if (Array.isArray(m.content)) {
            content = m.content.map((c: any) => c.text || JSON.stringify(c)).join(" ");
        }
        
        // Truncate individual message content if it's too large (e.g., huge tool outputs)
        const maxContentLength = 2000; // ~500 tokens per message max
        if (content.length > maxContentLength) {
            content = content.substring(0, maxContentLength) + "... [TRUNCATED]";
        }
        
        let prefix = `${m.role.toUpperCase()}`;
        if (m.name) prefix += ` (${m.name})`;
        
        const messageText = `${prefix}: ${content}`;
        const messageTokens = countApproxTokens(messageText);
        
        if (accumulatedTokens + messageTokens > availableTokensForConversation) {
            // We've hit our budget, stop adding more messages
            // Add a note that earlier messages were omitted
            messageTexts.unshift("[Earlier conversation history omitted for brevity]");
            break;
        }
        
        messageTexts.unshift(messageText);
        accumulatedTokens += messageTokens;
    }
    
    const conversationText = messageTexts.join("\n\n");
    const canonicalFacts = extractCanonicalFacts(compressableMessages);

        const previousSummary = Array.isArray(state.summaries) && state.summaries.length > 0
            ? state.summaries[state.summaries.length - 1]
            : "";
        const previousStructuredSummary = Array.isArray(state.summaryRecords) && state.summaryRecords.length > 0
            ? state.summaryRecords[state.summaryRecords.length - 1]
            : undefined;

        const defaultPrompt = `Summarize the conversation into strict JSON.

Return exactly one JSON object with this schema:
{
  "stable_facts": [{ "key": string, "value": string, "confidence": number }],
  "active_goals": [string],
  "open_questions": [string],
  "discarded_obsolete": [string],
  "rawSummary": string
}

Rules:
- Keep stable_facts only for facts that future turns must remember.
- Put invalidated or superseded fact keys in discarded_obsolete.
- Preserve active_goals still relevant to the user.
- Preserve unresolved questions.
- Do not include prose outside JSON.
- Target compression ratio: ${config.summaryCompressionRatioTarget}.
- Summary mode: ${config.summaryMode}.

Previous summary text:
${previousSummary || "(none)"}

Previous structured summary:
${previousStructuredSummary ? JSON.stringify(previousStructuredSummary) : "(none)"}

Conversation:
${conversationText}

Canonical facts extracted from tool outputs:
${canonicalFacts.length > 0 ? canonicalFacts.map((fact) => `- ${fact.key}: ${fact.value}`).join("\n") : "(none)"}`;

        const template = config.promptTemplate || defaultPrompt;
        const promptBody = template
            .replace(/\{\{\s*conversation\s*\}\}/g, conversationText)
            .replace(/\{\{\s*previousSummary\s*\}\}/g, previousSummary || "");

        const summaryPrompt = [
            systemMessage("You are a helpful assistant that summarizes conversation history efficiently. Return strict JSON only."),
            humanMessage(promptBody)
        ];

    // Estimate input tokens for the summarization prompt (fallback if model doesn't provide usage)
    const inputTokensEstimate = countApproxTokens(summaryPrompt.map(m => m.content).join("\n"));

    let summaryText = "Summary unavailable.";
    let structuredSummary: StructuredSummary | undefined;
    let integrity: SummaryIntegrityCheck | undefined;
    let outputTokensEstimate = 0;
    let durationMs = 0;
    let inputTokensActual: number | undefined;
    let outputTokensActual: number | undefined;
    let cachedInputTokens: number | undefined;
    let totalTokensActual: number | undefined;
    
    const startTime = Date.now();
        try {
                if (!model || typeof model.invoke !== "function") {
                    throw new Error("Summarization model is unavailable.");
                }
                const response = await model.invoke(summaryPrompt);
        durationMs = Date.now() - startTime;
        summaryText = typeof response.content === "string" 
            ? response.content 
            : Array.isArray(response.content) 
                ? response.content.map((c: any) => c.text || "").join("")
                : JSON.stringify(response.content);
        outputTokensEstimate = countApproxTokens(summaryText);

                const jsonText = extractJsonObject(summaryText);
                const parsed = jsonText ? JSON.parse(jsonText) : undefined;
                structuredSummary = normalizeStructuredSummary(parsed, summaryText);
                structuredSummary = mergeStableFacts(structuredSummary, canonicalFacts);
                integrity = config.integrityCheck
                    ? runIntegrityCheck(previousStructuredSummary, structuredSummary)
                    : { passed: true, criticalFactLoss: false, obsoleteFactRevived: false, notes: [] };
                if (integrity && !integrity.passed) {
                    structuredSummary = repairStructuredSummary(previousStructuredSummary, structuredSummary, integrity);
                    integrity = { ...integrity, passed: true };
                }
                summaryText = renderStructuredSummary(structuredSummary);
        
        // Extract actual token usage from model response if available
        const rawUsage = (response as any)?.usage 
          || (response as any)?.response_metadata?.token_usage 
          || (response as any)?.response_metadata?.tokenUsage
          || (response as any)?.response_metadata?.usage;
        const normalized = normalizeUsage(rawUsage);
        if (normalized) {
          inputTokensActual = normalized.prompt_tokens;
          outputTokensActual = normalized.completion_tokens;
          totalTokensActual = normalized.total_tokens;
          cachedInputTokens = normalized.prompt_tokens_details?.cached_tokens;
        }
    } catch (err: any) {
        durationMs = Date.now() - startTime;
                structuredSummary = normalizeStructuredSummary(undefined, previousSummary || conversationText.slice(0, 800));
                structuredSummary = mergeStableFacts(structuredSummary, canonicalFacts);
                integrity = { passed: true, criticalFactLoss: false, obsoleteFactRevived: false, notes: ["Fallback summary generated locally."] };
                summaryText = renderStructuredSummary(structuredSummary);
        
        // Emit error event for onEvent
        const errorEvent: SummarizationEvent = {
          type: "summarization",
                    summary: summaryText,
                    messagesCompressed: compressableMessages.length,
          inputTokens: inputTokensEstimate,
                    outputTokens: countApproxTokens(summaryText),
          durationMs,
          previousSummary: previousSummary || undefined,
          tokenCountBefore,
                    tokenCountAfter: tokenCountBefore,
                    structuredSummary,
                    integrity,
        };
        onEvent?.(errorEvent);
        
        // Record trace event for error
        recordTraceEvent(traceSession, {
          type: "summarization",
          label: "Context Summarization Failed",
          actor: { scope: "system", name: "summarizer", role: "summarization" },
          status: "error",
          durationMs,
          inputTokens: inputTokensEstimate,
                    outputTokens: countApproxTokens(summaryText),
          error: { message: err?.message || String(err), stack: err?.stack },
          messageList: sanitizeTracePayload(summaryPrompt),
        });
                // Continue with local fallback summary to avoid losing the compaction step.
    }

    // 2. Build a map of tool_call_id -> assistant message index
    // This ensures we only keep tool messages that have a matching assistant with tool_calls
    const toolCallIdToAssistantIdx = new Map<string, number>();
    messages.forEach((m, idx) => {
        if (m.role === 'assistant' && m.tool_calls && Array.isArray(m.tool_calls)) {
            m.tool_calls.forEach((tc: any) => {
                if (tc.id) {
                    toolCallIdToAssistantIdx.set(tc.id, idx);
                }
            });
        }
    });

    // 3. Modify existing messages
    // Replace content of tool messages with "SUMMARIZED", but only if they have a matching assistant.
    // Filter out orphan tool messages that don't have a preceding assistant with tool_calls.
    const newMessages = messages.map((m) => {
        if (m.role === 'tool') {
            if (isSyntheticSummaryToolMessage(m)) {
                return m;
            }
            const toolCallId = m.tool_call_id;
            
            // Check if this tool message has a matching assistant with tool_calls
            if (!toolCallId || !toolCallIdToAssistantIdx.has(toolCallId)) {
                // Orphan tool message - mark for removal
                return null;
            }
            
            // Check if it's already summarized to avoid double-processing
            if (m.content === "SUMMARIZED") return m;
            
            return { 
                ...m, 
                content: "SUMMARIZED" 
            };
        }
        return m;
    }).filter((m): m is NonNullable<typeof m> => m !== null);

    // 4. Validate message sequence - ensure every tool message follows an assistant with matching tool_calls
    const validatedMessages = validateMessageSequence(newMessages);

    // 5. Append the summarization interaction
    // We inject a fake tool call and response to represent the summarization event in the history.
    const summaryToolCallId = `call_summary_${Date.now()}`;
    
    // The assistant "calls" the summarizer
    const assistantSummaryCall: BaseMessage = {
        role: "assistant", // "assistant"
        content: "Context limit reached. Summarizing conversation history to reduce token usage.",
        tool_calls: [
            {
                id: summaryToolCallId,
                type: "function",
                function: {
                    name: "summarize_context",
                    arguments: "{}"
                }
            }
        ]
    };

    // The tool "responds" with the summary
    const toolSummaryResponse: BaseMessage = {
        role: "tool",
        tool_call_id: summaryToolCallId,
        name: "summarize_context", // Matches the tool name in the call
        content: summaryText
    };

        const summaries = Array.isArray(state.summaries) ? [...state.summaries, summaryText] : [summaryText];
        const summaryRecords = Array.isArray(state.summaryRecords)
            ? [...state.summaryRecords, { ...(structuredSummary || normalizeStructuredSummary(undefined, summaryText)), integrity, createdAt: new Date().toISOString() }]
            : [{ ...(structuredSummary || normalizeStructuredSummary(undefined, summaryText)), integrity, createdAt: new Date().toISOString() }];

    // Calculate token count after summarization
    const finalMessages = [...validatedMessages, assistantSummaryCall, toolSummaryResponse];
    const allTextAfter = finalMessages
      .map((m: any) => typeof m.content === "string" ? m.content : Array.isArray(m.content) ? m.content.map((c: any) => (typeof c === 'string' ? c : c?.text ?? c?.content ?? '')).join('') : '')
      .join("\n");
    const tokenCountAfter = countApproxTokens(allTextAfter);

    // Emit successful summarization event (use actual values from model response if available, fallback to estimates)
    const summarizationEvent: SummarizationEvent = {
      type: "summarization",
      summary: summaryText,
      messagesCompressed: compressableMessages.length,
      inputTokens: inputTokensActual ?? inputTokensEstimate,
      outputTokens: outputTokensActual ?? outputTokensEstimate,
      cachedInputTokens: cachedInputTokens,
      totalTokens: totalTokensActual ?? ((inputTokensActual ?? inputTokensEstimate) + (outputTokensActual ?? outputTokensEstimate)),
      durationMs,
      previousSummary: previousSummary || undefined,
      tokenCountBefore,
      tokenCountAfter,
      archivedCount: compressableMessages.length, // deprecated field for backward compatibility
            structuredSummary,
            integrity,
    };
    onEvent?.(summarizationEvent);

    // Record trace event for successful summarization
    recordTraceEvent(traceSession, {
      type: "summarization",
      label: "Context Summarization",
      actor: { scope: "system", name: "summarizer", role: "summarization" },
      status: "success",
      durationMs,
      inputTokens: inputTokensActual ?? inputTokensEstimate,
      outputTokens: outputTokensActual ?? outputTokensEstimate,
      cachedInputTokens: cachedInputTokens,
      totalTokens: totalTokensActual,
      messageList: sanitizeTracePayload([
        ...summaryPrompt,
        { role: "assistant", content: summaryText, name: "summarization_result" }
      ]),
      debug: {
        messagesCompressed: compressableMessages.length,
        tokenCountBefore,
        tokenCountAfter,
        tokensSaved: tokenCountBefore - tokenCountAfter,
        previousSummaryLength: previousSummary?.length || 0,
        usageFromModel: inputTokensActual !== undefined,
        cachedInputTokens: cachedInputTokens,
                integrity,
      },
    });

    return {
        messages: finalMessages as any,
                summaries,
                summaryRecords,
                watchdog: {
                    ...(state.watchdog || {}),
                    compactions: (state.watchdog?.compactions || 0) + 1,
                    lastAction: "summarized",
                },
    };
  };
}
