// Lightweight message helpers to avoid hard dependency on LangChain
import type { SmartAgentOptions, SmartState, BaseMessage, SmartAgentEvent, SummarizationEvent } from "../types.js";
import { countApproxTokens } from "../utils/utilTokens.js";
import { recordTraceEvent, sanitizeTracePayload } from "../utils/tracing.js";
import { normalizeUsage } from "../utils/usage.js";

// Helper for lightweight message construction
const systemMessage = (content: string) => ({ role: 'system', content });
const humanMessage = (content: string) => ({ role: 'user', content });

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
function getSummarizationConfig(opts: SmartAgentOptions) {
  if (typeof opts.summarization === 'object') {
    return {
      enabled: opts.summarization.enable !== false,
      maxTokens: opts.summarization.maxTokens ?? 50000,
      // Max tokens we can send to the model for summarization prompt itself
      // This should be well under the model's context limit
            summaryPromptMaxTokens: opts.summarization.summaryPromptMaxTokens ?? 8000,
            promptTemplate: opts.summarization.promptTemplate
    };
  }
  // Fallback to default 50000 if not specified
  return {
    enabled: opts.summarization !== false,
    maxTokens: 50000,
        summaryPromptMaxTokens: 8000,
        promptTemplate: undefined
  }; 
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
    const config = getSummarizationConfig(opts);
    if (!config.enabled) return {};

    const model = (opts as any).model;
    const messages = state.messages || [];

    // Get onEvent and traceSession from state context
    const onEvent = (state.ctx as any)?.__onEvent as ((e: SmartAgentEvent) => void) | undefined;
    const traceSession = (state.ctx as any)?.__traceSession;

    // Check if there are any tool messages that can be compressed
    const compressableMessages = messages.filter(m => m.role === 'tool' && m.content !== "SUMMARIZED");
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

        const previousSummary = Array.isArray(state.summaries) && state.summaries.length > 0
            ? state.summaries[state.summaries.length - 1]
            : "";

        const defaultPrompt = `Please summarize the following conversation history and update any previous summary.
Focus on:
- User goals and intent.
- Key decisions made and actions taken.
- Important tool outputs and data retrieved.
- Current state of the task.

Previous summary (if any):
${previousSummary || "(none)"}

Conversation:
${conversationText}

Summary:`;

        const template = config.promptTemplate || defaultPrompt;
        const promptBody = template
            .replace(/\{\{\s*conversation\s*\}\}/g, conversationText)
            .replace(/\{\{\s*previousSummary\s*\}\}/g, previousSummary || "");

        const summaryPrompt = [
                systemMessage("You are a helpful assistant that summarizes conversation history efficiently."),
                humanMessage(promptBody)
        ];

    // Estimate input tokens for the summarization prompt (fallback if model doesn't provide usage)
    const inputTokensEstimate = countApproxTokens(summaryPrompt.map(m => m.content).join("\n"));

    let summaryText = "Summary unavailable.";
    let outputTokensEstimate = 0;
    let durationMs = 0;
    let inputTokensActual: number | undefined;
    let outputTokensActual: number | undefined;
    let cachedInputTokens: number | undefined;
    let totalTokensActual: number | undefined;
    
    const startTime = Date.now();
    try {
        const response = await model.invoke(summaryPrompt);
        durationMs = Date.now() - startTime;
        summaryText = typeof response.content === "string" 
            ? response.content 
            : Array.isArray(response.content) 
                ? response.content.map((c: any) => c.text || "").join("")
                : JSON.stringify(response.content);
        outputTokensEstimate = countApproxTokens(summaryText);
        
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
        console.error("[ContextSummarize] Failed to generate summary:", err);
        
        // Emit error event for onEvent
        const errorEvent: SummarizationEvent = {
          type: "summarization",
          summary: "",
          messagesCompressed: 0,
          inputTokens: inputTokensEstimate,
          outputTokens: 0,
          durationMs,
          previousSummary: previousSummary || undefined,
          tokenCountBefore,
          tokenCountAfter: tokenCountBefore,
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
          outputTokens: 0,
          error: { message: err?.message || String(err), stack: err?.stack },
          messageList: sanitizeTracePayload(summaryPrompt),
        });
        return {}; // Abort changes if summarization fails
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
      },
    });

    return {
        messages: finalMessages as any,
        summaries
    };
  };
}
