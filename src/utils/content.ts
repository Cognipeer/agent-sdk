import type { ContentPart } from "../types.js";

/**
 * A non-text part of a message, normalized across the two shapes this SDK
 * accepts: the unified `{ type: "image" | "audio" | "file", source: … }` used by
 * the native providers, and the legacy OpenAI-style `{ type: "image_url", … }`.
 * A policy that had to know which of the two it was looking at would be wrong
 * for half of its callers.
 */
export type MediaAttachment = {
  /** Position in the content array, so a policy can rewrite the right part. */
  index: number;
  kind: "image" | "audio" | "video" | "file" | "unknown";
  mediaType?: string;
  sourceType?: "url" | "base64";
  url?: string;
  /** Decoded size for a base64 payload. Unknown for a URL — nobody fetched it. */
  approxBytes?: number;
  fileName?: string;
};

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


/**
 * The text a hook should reason about: the text parts only, joined.
 *
 * Deliberately not `contentToString`, which renders media as human-readable
 * descriptors (`[image:…]`) for logs and token counting. A guardrail scoring
 * that string would be scoring the SDK's own placeholder text, and a redactor
 * rewriting it would bake the placeholder into the message.
 */
export function textFromContent(content: string | ContentPart[] | unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((part) => isTextPart(part))
    .map((part) => (part as { text: string }).text ?? "")
    .join("\n");
}

function isTextPart(part: unknown): part is { type: "text"; text: string } {
  return !!part && typeof part === "object" && (part as { type?: string }).type === "text";
}

/**
 * Rewrite the text of a message's content, leaving every other part exactly as
 * it was — same objects, same order.
 *
 * This is the write-back half of every text-oriented hook. Assigning a plain
 * string over a multi-part `content` is the silent version of this operation:
 * the run still answers, it just answers without the image the user attached.
 */
export function mapTextParts(
  content: string | ContentPart[] | unknown,
  fn: (text: string) => string,
): string | ContentPart[] | unknown {
  if (typeof content === "string") return fn(content);
  if (!Array.isArray(content)) return content;
  return content.map((part) => (isTextPart(part) ? { ...part, text: fn(part.text) } : part));
}

/**
 * Put a whole replacement text back into a multi-part content.
 *
 * A hook that took `text` saw the CONCATENATION of every text part, so there is
 * no general way to split its answer back across them. With one text part (the
 * ordinary case) this is exact. With several, the replacement lands in the first
 * and the rest are dropped — media parts keep their positions either way. A
 * plugin that needs exact multi-part fidelity should return `content` instead,
 * which is why that field exists.
 */
export function replaceTextContent(
  content: string | ContentPart[] | unknown,
  text: string,
): string | ContentPart[] | unknown {
  if (typeof content === "string" || content == null) return text;
  if (!Array.isArray(content)) return text;

  const textIndexes = content.reduce<number[]>((acc, part, index) => {
    if (isTextPart(part)) acc.push(index);
    return acc;
  }, []);

  if (textIndexes.length === 0) {
    return text.length > 0 ? [{ type: "text", text } as ContentPart, ...content] : content;
  }

  const [first, ...rest] = textIndexes;
  const dropped = new Set(rest);
  return content
    .map((part, index) => (index === first ? { ...(part as object), text } : part))
    .filter((_part, index) => !dropped.has(index)) as ContentPart[];
}

function normalizeSource(source: unknown): Pick<MediaAttachment, "sourceType" | "url" | "mediaType" | "approxBytes"> {
  if (!source || typeof source !== "object") return {};
  const src = source as Record<string, unknown>;
  if (src.type === "base64" && typeof src.data === "string") {
    return {
      sourceType: "base64",
      mediaType: typeof src.mediaType === "string" ? src.mediaType : undefined,
      // base64 encodes 3 bytes per 4 characters; padding makes this an upper bound.
      approxBytes: Math.floor((src.data.length * 3) / 4),
    };
  }
  if (src.type === "url" && typeof src.url === "string") {
    return {
      sourceType: "url",
      url: src.url,
      mediaType: typeof src.mediaType === "string" ? src.mediaType : undefined,
    };
  }
  return {};
}

/** Every non-text part of a message, normalized for policy code. */
export function collectAttachments(content: string | ContentPart[] | unknown): MediaAttachment[] {
  if (!Array.isArray(content)) return [];
  const attachments: MediaAttachment[] = [];

  content.forEach((part, index) => {
    if (!part || typeof part !== "object") return;
    const type = (part as { type?: string }).type;
    if (!type || type === "text") return;

    if (type === "image" || type === "audio" || type === "video" || type === "file") {
      attachments.push({
        index,
        kind: type,
        fileName: typeof (part as { fileName?: string }).fileName === "string"
          ? (part as { fileName?: string }).fileName
          : undefined,
        ...normalizeSource((part as { source?: unknown }).source),
      });
      return;
    }

    if (type === "image_url") {
      const image = (part as { image_url?: unknown }).image_url;
      const url = typeof image === "string" ? image : (image as { url?: string })?.url;
      if (typeof url === "string" && url.startsWith("data:")) {
        const comma = url.indexOf(",");
        const header = url.slice(5, comma);
        attachments.push({
          index,
          kind: "image",
          sourceType: "base64",
          mediaType: header.split(";")[0] || undefined,
          approxBytes: Math.floor(((url.length - comma - 1) * 3) / 4),
        });
      } else {
        attachments.push({ index, kind: "image", sourceType: "url", url });
      }
      return;
    }

    attachments.push({ index, kind: "unknown" });
  });

  return attachments;
}
