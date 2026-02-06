import { sanitizeTracePayload } from "./tracing.js";
import type {
  TraceDataSection,
  TraceMessageSection,
  TraceSummarySection,
  TraceMetadataSection,
  TraceToolCallSection,
  TraceToolResultItem,
  TraceToolResponseSection,
} from "../types.js";

function truncate(text: string, max = 500): string {
  if (!text) return "";
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

function toPlainString(value: any): string {
  if (value == null) return "";
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function parseJsonLike(value: any): any {
  if (Array.isArray(value)) {
    if (value.length === 1) {
      return parseJsonLike(value[0]);
    }
    return value.map((item) => parseJsonLike(item));
  }
  if (value && typeof value === "object") {
    if (typeof (value as any).text === "string" && Object.keys(value).length === 1) {
      try {
        return JSON.parse((value as any).text);
      } catch {
        return (value as any).text;
      }
    }
    return value;
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return "";
    try {
      return JSON.parse(trimmed);
    } catch {
      return value;
    }
  }
  return value;
}

export function summarizeToolOutput(output: any): string {
  if (output == null) return "";
  if (typeof output === "string") return truncate(output.trim());
  if (Array.isArray(output)) {
    const preview = output
      .slice(0, 3)
      .map((item, index) => `${index + 1}. ${truncate(toPlainString(item))}`)
      .join("\n");
    const suffix = output.length > 3 ? `\n… (+${output.length - 3} more)` : "";
    return `${preview}${suffix}`.trim();
  }
  if (typeof output === "object") {
    if (Array.isArray((output as any).items)) {
      return summarizeToolOutput((output as any).items);
    }
    return truncate(toPlainString(output));
  }
  return truncate(String(output));
}

export function extractToolItems(output: any): TraceToolResultItem[] | undefined {
  const source = Array.isArray(output) ? output : Array.isArray(output?.items) ? output.items : undefined;
  if (!Array.isArray(source) || source.length === 0) return undefined;
  return source.slice(0, 5).map((item) => {
    if (item && typeof item === "object") {
      const snippetSource = (item as any).content ?? (item as any).snippet ?? (item as any).description ?? (item as any).text ?? (item as any).summary ?? item;
      return {
        title: typeof (item as any).title === "string" ? (item as any).title : undefined,
        url: typeof (item as any).url === "string" ? (item as any).url : undefined,
        snippet: truncate(toPlainString(snippetSource)),
      } as TraceToolResultItem;
    }
    return { snippet: truncate(toPlainString(item)) } as TraceToolResultItem;
  });
}

function capitalize(word: string): string {
  return word.charAt(0).toUpperCase() + word.slice(1);
}

export function formatMessageContent(content: any): string {
  if (content == null) return "";
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((item) => {
        if (typeof item === "string") return item;
        if (item && typeof item === "object") {
          if (typeof (item as any).text === "string") return (item as any).text;
          if (typeof (item as any).content === "string") return (item as any).content;
          try {
            return JSON.stringify(item);
          } catch {
            return String(item);
          }
        }
        try {
          return JSON.stringify(item);
        } catch {
          return String(item);
        }
      })
      .filter(Boolean)
      .join("\n");
  }
  if (typeof content === "object") {
    if (typeof (content as any).text === "string") return (content as any).text;
    if (typeof (content as any).content === "string") return (content as any).content;
    try {
      return JSON.stringify(content, null, 2);
    } catch {
      return String(content);
    }
  }
  return String(content);
}

function buildMessageLabel(role: string, index: number): string {
  const normalizedRole = role || "message";
  const base = `${capitalize(normalizedRole)} Message`;
  return index > 1 ? `${base} #${index}` : base;
}

export function buildPromptSections(messages: any[]): TraceDataSection[] {
  if (!Array.isArray(messages)) return [];
  const roleCounts = new Map<string, number>();
  const sections: TraceDataSection[] = [];

  for (const msg of messages) {
    const role = typeof msg?.role === "string" ? msg.role : "system";
    const nextCount = (roleCounts.get(role) || 0) + 1;
    roleCounts.set(role, nextCount);
    const label = buildMessageLabel(role, nextCount);
    const content = formatMessageContent(msg?.content);

    sections.push({
      kind: "message",
      label,
      role,
      content,
      metadata: msg?.name ? { name: msg.name } : undefined,
    } as TraceMessageSection);
  }

  return sections;
}

function parseArguments(args: any): any {
  if (args == null) return args;
  if (typeof args === "string") {
    try {
      return JSON.parse(args);
    } catch {
      return args;
    }
  }
  return args;
}

function toToolCallSection(call: any, index: number): TraceToolCallSection {
  const toolName = call?.name || call?.tool || call?.function?.name || `tool_${index + 1}`;
  const rawArgs = call?.arguments ?? call?.args ?? call?.input ?? call?.function?.arguments ?? call?.function_call?.arguments;
  const parsedArgs = parseArguments(rawArgs);
  return {
    kind: "tool_call",
    label: `Tool Call: ${toolName}`,
    tool: toolName,
    arguments: sanitizeTracePayload(parsedArgs ?? rawArgs ?? {}),
  } as TraceToolCallSection;
}

export function extractToolCalls(response: any): TraceToolCallSection[] {
  const calls: TraceToolCallSection[] = [];
  const candidateSets = [
    Array.isArray(response?.tool_calls) ? response.tool_calls : null,
    Array.isArray(response?.additional_kwargs?.tool_calls) ? response.additional_kwargs.tool_calls : null,
  ];

  for (const set of candidateSets) {
    if (Array.isArray(set)) {
      set.forEach((call, idx) => calls.push(toToolCallSection(call, idx)));
    }
  }

  const functionCall = response?.function_call || response?.additional_kwargs?.function_call;
  if (functionCall) {
    calls.push(toToolCallSection(functionCall, calls.length));
  }

  return calls;
}

export function buildAssistantMessageSection(
  response: any,
  options?: { label?: string }
): TraceMessageSection | null {
  const content = formatMessageContent(response?.content ?? response);
  if (!content) return null;
  return {
    kind: "message",
    label: options?.label ?? "Assistant Message",
    role: "assistant",
    content,
    metadata: response?.name ? { name: response.name } : undefined,
  } as TraceMessageSection;
}

export function buildLastUserMessageSections(messages: any[]): TraceDataSection[] {
  if (!Array.isArray(messages)) return [];
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const msg = messages[i];
    if (msg?.role === "user") {
      return buildPromptSections([msg]);
    }
  }
  return [];
}

function findLastIndex<T>(arr: T[], predicate: (value: T, index: number, array: T[]) => boolean): number {
  for (let i = arr.length - 1; i >= 0; i -= 1) {
    if (predicate(arr[i], i, arr)) {
      return i;
    }
  }
  return -1;
}

function isAssistantToolCallMessage(message: any): boolean {
  if (!message) return false;
  return extractToolCalls(message).length > 0;
}

function buildToolResponseSectionFromMessage(message: any): TraceToolResponseSection | null {
  if (!message) return null;
  const toolName = message?.name || message?.metadata?.name || message?.tool || message?.tool_call_id || "tool";
  const parsed = parseJsonLike(message?.content ?? message);
  const sanitizedOutput = sanitizeTracePayload(parsed ?? (message?.content ?? message));
  const summarySource = sanitizedOutput ?? parsed ?? message?.content ?? message;
  const summary = summarizeToolOutput(summarySource);
  const items = extractToolItems(summarySource);
  const fallback = summary || formatMessageContent(message?.content ?? message);
  if (!fallback) return null;
  return {
    kind: "tool_response",
    label: `Tool Response: ${toolName}`,
    tool: toolName,
    summary: fallback,
    items,
    output: sanitizedOutput,
  } as TraceToolResponseSection;
}

function collectToolResponseSections(messages: any[], startIndex: number): TraceToolResponseSection[] {
  if (!Array.isArray(messages)) return [];
  const sections: TraceToolResponseSection[] = [];
  for (let i = startIndex + 1; i < messages.length; i += 1) {
    const msg = messages[i];
    if (!msg) continue;
    const role = msg.role;
    const hasToolName = typeof msg?.name === "string" && msg.name.length > 0;
    const hasToolId = typeof msg?.tool_call_id === "string" && msg.tool_call_id.length > 0;
    if (role === "tool" || hasToolName || hasToolId) {
      const section = buildToolResponseSectionFromMessage(msg);
      if (section) sections.push(section);
    }
  }
  return sections;
}

export function buildToolCallTurnSections(messages: any[], response: any): TraceDataSection[] {
  const toolCalls = extractToolCalls(response);
  if (toolCalls.length === 0) return [];
  const sections: TraceDataSection[] = [];
  sections.push(...buildLastUserMessageSections(messages));
  sections.push(...toolCalls);
  return sections;
}

export function buildFinalAgentSections(messages: any[], response: any): TraceDataSection[] {
  if (!Array.isArray(messages)) return [];
  const assistantToolIndex = findLastIndex(messages, (msg) => isAssistantToolCallMessage(msg));
  if (assistantToolIndex === -1) return [];
  const sections: TraceDataSection[] = [];
  sections.push(...buildLastUserMessageSections(messages));
  const assistantToolMessage = messages[assistantToolIndex];
  sections.push(...extractToolCalls(assistantToolMessage));
  sections.push(...collectToolResponseSections(messages, assistantToolIndex));
  const assistantMessage = buildAssistantMessageSection(response, { label: "AI Message" });
  if (assistantMessage) sections.push(assistantMessage);
  return sections;
}

export function buildAssistantResponseSections(response: any): TraceDataSection[] {
  if (!response) return [];
  const sections: TraceDataSection[] = [];
  const assistantMessage = buildAssistantMessageSection(response);
  if (assistantMessage) {
    sections.push(assistantMessage);
  }
  sections.push(...extractToolCalls(response));

  return sections;
}

/**
 * Builds dedicated trace sections for a summarization event.
 *
 * This produces a structured representation with:
 * 1. A "summary" section containing the generated summary text.
 * 2. A "metadata" section with detailed summarization statistics
 *    (tokens before/after, messages compressed, previous summary, etc.).
 * 3. Optionally, the summarization prompt messages for debugging.
 */
export function buildSummarizationSections(opts: {
  summaryText: string;
  previousSummary?: string;
  messagesCompressed: number;
  tokenCountBefore: number;
  tokenCountAfter: number;
  inputTokens?: number;
  outputTokens?: number;
  cachedInputTokens?: number;
  durationMs?: number;
  promptMessages?: any[];
}): TraceDataSection[] {
  const sections: TraceDataSection[] = [];

  // 1. The generated summary as a dedicated "summary" section
  sections.push({
    kind: "summary",
    label: "Context Summary",
    content: opts.summaryText,
  } as TraceSummarySection);

  // 2. Summarization statistics as a "metadata" section
  const tokensSaved = opts.tokenCountBefore - opts.tokenCountAfter;
  const reductionPct = opts.tokenCountBefore > 0
    ? Math.round((tokensSaved / opts.tokenCountBefore) * 100)
    : 0;

  const metaData: Record<string, any> = {
    messagesCompressed: opts.messagesCompressed,
    tokenCountBefore: opts.tokenCountBefore,
    tokenCountAfter: opts.tokenCountAfter,
    tokensSaved,
    reductionPercent: reductionPct,
  };

  if (opts.inputTokens !== undefined) metaData.inputTokens = opts.inputTokens;
  if (opts.outputTokens !== undefined) metaData.outputTokens = opts.outputTokens;
  if (opts.cachedInputTokens !== undefined) metaData.cachedInputTokens = opts.cachedInputTokens;
  if (opts.durationMs !== undefined) metaData.durationMs = opts.durationMs;
  if (opts.previousSummary) metaData.previousSummaryLength = opts.previousSummary.length;

  sections.push({
    kind: "metadata",
    label: "Summarization Stats",
    data: metaData,
  } as TraceMetadataSection);

  // 3. Optionally include the prompt that was sent to the model
  if (Array.isArray(opts.promptMessages) && opts.promptMessages.length > 0) {
    for (const msg of opts.promptMessages) {
      const role = typeof msg?.role === "string" ? msg.role : "system";
      const content = formatMessageContent(msg?.content ?? "");
      if (content) {
        sections.push({
          kind: "message",
          label: `Summarization Prompt (${role})`,
          role,
          content,
        } as TraceMessageSection);
      }
    }
  }

  return sections;
}
