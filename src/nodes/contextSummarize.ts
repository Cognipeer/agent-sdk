// Lightweight message helpers to avoid hard dependency on LangChain
import type { SmartAgentOptions, SmartState, BaseMessage } from "../types.js";
import { countApproxTokens } from "../utils/utilTokens.js";

// Helper for lightweight message construction
const systemMessage = (content: string) => ({ role: 'system', content });
const humanMessage = (content: string) => ({ role: 'user', content });

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

    // Check if there are any tool messages that can be compressed
    const compressableMessages = messages.filter(m => m.role === 'tool' && m.content !== "SUMMARIZED");
    if (compressableMessages.length === 0) {
        // Nothing to compress. If we summarize, we only ADD tokens (summary).
        // Abort to prevent infinite loops or growing context.
        return {};
    }

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

    let summaryText = "Summary unavailable.";
    try {
        const response = await model.invoke(summaryPrompt);
        summaryText = typeof response.content === "string" 
            ? response.content 
            : Array.isArray(response.content) 
                ? response.content.map((c: any) => c.text || "").join("")
                : JSON.stringify(response.content);
    } catch (err) {
        console.error("[ContextSummarize] Failed to generate summary:", err);
        return {}; // Abort changes if summarization fails
    }

    // 2. Modify existing messages
    // Replace content of ALL tool messages with "SUMMARIZED".
    // We leave other messages intact to preserve the conversational flow structure,
    // but reducing the token load from large tool outputs.
    const newMessages = messages.map(m => {
        if (m.role === 'tool') {
            // Check if it's already summarized to avoid double-processing if run multiple times
            if (m.content === "SUMMARIZED") return m;
            
            return { 
                ...m, 
                content: "SUMMARIZED" 
            };
        }
        return m;
    });

    // 3. Append the summarization interaction
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

    return {
        messages: [...newMessages, assistantSummaryCall, toolSummaryResponse] as any,
        summaries
    };
  };
}
