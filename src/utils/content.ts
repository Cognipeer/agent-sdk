import type { ContentPart } from "../types.js";

// Convert content (string | parts[]) to a human-readable string for logging, token counting, or summarization.
export function contentToString(content: string | ContentPart[] | any): string {
  try {
    if (content == null) return "";
    if (typeof content === "string") return content;
    if (Array.isArray(content)) {
      return content
        .map((p) => {
          if (!p || typeof p !== "object") return String(p);
          if ((p as any).type === "text") return String((p as any).text ?? "");
          if ((p as any).type === "image_url") {
            const img = (p as any).image_url;
            const url = typeof img === "string" ? img : img?.url;
            const detail = typeof img === "string" ? undefined : img?.detail;
            return `[image:${url || "unknown"}${detail ? ` detail=${detail}` : ""}]`;
          }
          // generic fallback
          return JSON.stringify(p);
        })
        .join("\n");
    }
    // unknown object
    return JSON.stringify(content);
  } catch {
    return String(content);
  }
}

// Merge an array of messages' contents into a single string (used in token counting decisions)
export function mergeContentsToString(contents: Array<string | ContentPart[] | any>): string {
  return contents.map((c) => contentToString(c)).join("\n");
}

// Safely convert any value to string via JSON.stringify, with fallback.
export function safeStringify(value: unknown, pretty = false): string {
  if (value == null) return "";
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, pretty ? 2 : undefined) ?? String(value);
  } catch {
    return String(value);
  }
}

// Extract text from a message object (handles string content, ContentPart arrays, etc.)
export function extractMessageText(message: any): string {
  if (!message) return "";
  const content = message.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part: any) => (typeof part === "string" ? part : part?.text ?? part?.content ?? ""))
      .join("");
  }
  return "";
}
