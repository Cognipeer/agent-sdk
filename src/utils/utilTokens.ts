/**
 * Estimates token count from text using a character-based heuristic.
 * 
 * This is a rough approximation:
 * - For Latin/ASCII text: ~4 characters per token (GPT-family models)
 * - For CJK/Unicode text: ~1.5 characters per token
 * 
 * For production accuracy, consider using a proper tokenizer like tiktoken.
 */
export function countApproxTokens(text: string): number {
  if (!text) return 0;
  // Count non-ASCII characters (CJK, Arabic, etc.) which use more tokens
  const nonAsciiCount = (text.match(/[^\x00-\x7F]/g) || []).length;
  const asciiCount = text.length - nonAsciiCount;
  // ASCII text: ~4 chars/token, non-ASCII: ~1.5 chars/token
  return Math.ceil(asciiCount / 4 + nonAsciiCount / 1.5);
}

/**
 * Extracts all text from a message, including content AND tool_calls arguments.
 * 
 * Standard `countApproxTokens` only counts `.content`, but assistant messages
 * with tool_calls often have `content: ""` while `tool_calls[].function.arguments`
 * can contain massive JSON strings. The actual LLM API counts both towards input tokens,
 * so we must include tool_calls to get an accurate estimate.
 * 
 * Also accounts for per-message overhead (role, name, formatting tokens).
 */
function extractMessageText(m: any): string {
  if (!m) return "";
  const parts: string[] = [];

  // 1. Role + name overhead (~4 tokens worth of text)
  parts.push(m.role || "");
  if (m.name) parts.push(m.name);

  // 2. Content field
  if (typeof m.content === "string") {
    parts.push(m.content);
  } else if (Array.isArray(m.content)) {
    for (const c of m.content) {
      if (typeof c === "string") parts.push(c);
      else if (c?.text) parts.push(c.text);
      else if (c?.content) parts.push(c.content);
      else if (c?.type === "tool_use" && c?.input) {
        // Anthropic/Bedrock native tool_use content blocks
        parts.push(c.name || "");
        parts.push(typeof c.input === "string" ? c.input : JSON.stringify(c.input));
      } else if (c != null && typeof c === "object") {
        parts.push(JSON.stringify(c));
      }
    }
  } else if (m.content != null && typeof m.content === "object") {
    parts.push(JSON.stringify(m.content));
  }

  // 3. Tool calls (assistant messages) — these are counted by the API but often missed
  if (Array.isArray(m.tool_calls)) {
    for (const tc of m.tool_calls) {
      if (tc?.function?.name) parts.push(tc.function.name);
      if (tc?.function?.arguments) {
        parts.push(
          typeof tc.function.arguments === "string"
            ? tc.function.arguments
            : JSON.stringify(tc.function.arguments)
        );
      }
      // LangChain normalized format (name + args at top level)
      if (tc?.name && !tc?.function?.name) parts.push(tc.name);
      if (tc?.args && !tc?.function?.arguments) {
        parts.push(typeof tc.args === "string" ? tc.args : JSON.stringify(tc.args));
      }
    }
  }

  // 4. additional_kwargs.tool_calls (LangChain Bedrock format)
  if (Array.isArray(m.additional_kwargs?.tool_calls)) {
    for (const tc of m.additional_kwargs.tool_calls) {
      if (tc?.function?.name) parts.push(tc.function.name);
      if (tc?.function?.arguments) {
        parts.push(
          typeof tc.function.arguments === "string"
            ? tc.function.arguments
            : JSON.stringify(tc.function.arguments)
        );
      }
    }
  }

  return parts.join("\n");
}

/**
 * Estimates the total token count for an array of messages.
 * 
 * Unlike counting only `.content`, this includes:
 * - `tool_calls[].function.arguments` (can be massive JSON)
 * - `tool_calls[].function.name`
 * - `additional_kwargs.tool_calls` (LangChain/Bedrock)
 * - Per-message overhead (role, name, formatting)
 * - Anthropic tool_use content blocks
 */
export function countMessagesTokens(messages: any[]): number {
  if (!Array.isArray(messages) || messages.length === 0) return 0;
  const allText = messages.map(extractMessageText).join("\n");
  // Add ~4 tokens per message for framing overhead (role delimiters, etc.)
  return countApproxTokens(allText) + messages.length * 4;
}
