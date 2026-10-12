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

export type MediaKind = "image" | "audio" | "video" | "file";

const MEDIA_PART_KINDS: Record<string, MediaKind> = {
  image: "image",
  image_url: "image",
  input_image: "image",
  image_file: "image",
  audio: "audio",
  input_audio: "audio",
  video: "video",
  video_url: "video",
  file: "file",
  input_file: "file",
  document: "file",
};

function isRecord(value: unknown): value is Record<string, any> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function nonEmpty(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function kindFromMediaType(mediaType: string | undefined): MediaKind {
  const top = mediaType?.split("/")[0];
  return top === "image" || top === "audio" || top === "video" ? top : "file";
}

function inlineDataOf(part: Record<string, any>): Record<string, any> | undefined {
  const inline = part.inlineData ?? part.inline_data ?? part.fileData ?? part.file_data;
  return isRecord(inline) ? inline : undefined;
}

/**
 * What kind of attachment a content part is, or undefined for text and for
 * anything that is not a media part.
 *
 * Covers the unified shape (`image`/`audio`/`file` with a `source`), the
 * OpenAI shapes (`image_url`, `input_audio`, `file`, `input_image`, `input_file`)
 * and Gemini's untyped `inlineData` / `fileData`.
 */
export function mediaKindOf(part: unknown): MediaKind | undefined {
  if (!isRecord(part)) return undefined;
  const type = nonEmpty(part.type);
  if (type) return MEDIA_PART_KINDS[type];
  const inline = inlineDataOf(part);
  if (inline) return kindFromMediaType(nonEmpty(inline.mimeType) ?? nonEmpty(inline.mime_type));
  return undefined;
}

/** True when the content is an array holding at least one media part. */
export function hasMediaPart(content: unknown): boolean {
  return Array.isArray(content) && content.some((part) => mediaKindOf(part) !== undefined);
}

function urlOfPart(part: Record<string, any>): string | undefined {
  const image = part.image_url;
  const video = part.video_url;
  return (
    nonEmpty(typeof image === "string" ? image : image?.url)
    ?? nonEmpty(typeof video === "string" ? video : video?.url)
    ?? nonEmpty(part.url)
    ?? nonEmpty(part.source?.url)
    ?? nonEmpty(inlineDataOf(part)?.fileUri)
    ?? nonEmpty(inlineDataOf(part)?.file_uri)
  );
}

function mediaTypeOfPart(part: Record<string, any>): string | undefined {
  const image = isRecord(part.image_url) ? part.image_url : undefined;
  const source = isRecord(part.source) ? part.source : undefined;
  const inline = inlineDataOf(part);
  const audioFormat = nonEmpty(part.input_audio?.format);
  const fromDataUrl = /^data:([^;,]+)/i.exec(urlOfPart(part) ?? "")?.[1];
  return (
    nonEmpty(part.mediaType)
    ?? nonEmpty(part.media_type)
    ?? nonEmpty(part.mimeType)
    ?? nonEmpty(part.mime_type)
    ?? nonEmpty(source?.mediaType)
    ?? nonEmpty(source?.media_type)
    ?? nonEmpty(image?.mediaType)
    ?? nonEmpty(image?.media_type)
    ?? nonEmpty(inline?.mimeType)
    ?? nonEmpty(inline?.mime_type)
    ?? nonEmpty(fromDataUrl)
    ?? (audioFormat ? `audio/${audioFormat}` : undefined)
  );
}

function nameOfPart(part: Record<string, any>): string | undefined {
  const file = isRecord(part.file) ? part.file : undefined;
  const image = isRecord(part.image_url) ? part.image_url : undefined;
  const source = isRecord(part.source) ? part.source : undefined;
  return (
    nonEmpty(part.name)
    ?? nonEmpty(part.fileName)
    ?? nonEmpty(part.filename)
    ?? nonEmpty(part.file_name)
    ?? nonEmpty(file?.filename)
    ?? nonEmpty(file?.fileName)
    ?? nonEmpty(image?.name)
    ?? nonEmpty(source?.fileName)
    ?? nonEmpty(source?.filename)
    ?? nonEmpty(part.fileId)
    ?? nonEmpty(part.file_id)
    ?? nonEmpty(file?.file_id)
    ?? nonEmpty(file?.fileId)
    ?? nonEmpty(image?.fileId)
    ?? nonEmpty(image?.file_id)
    ?? nonEmpty(part.image_file?.file_id)
  );
}

/** The last path segment of a plain URL, or the id of a `session-file://` reference. Never a query string. */
function labelFromUrl(url: string | undefined): string | undefined {
  if (!url || url.startsWith("data:")) return undefined;
  try {
    const parsed = new URL(url);
    if (parsed.protocol === "session-file:") return nonEmpty(parsed.hostname) ?? nonEmpty(parsed.pathname.replace(/^\/+/, ""));
    if (parsed.protocol === "http:" || parsed.protocol === "https:") {
      return nonEmpty(decodeURIComponent(parsed.pathname.split("/").filter(Boolean).pop() ?? ""));
    }
  } catch {
    /* not a URL worth naming */
  }
  return undefined;
}

const PLACEHOLDER_LABEL_MAX = 80;

/**
 * A short, human-readable stand-in for a media part: `[image: photo.png]`,
 * `[image: image/png]`, `[audio]`. Undefined for text and non-media parts.
 *
 * This is what anything that flattens content to TEXT must use for an
 * attachment — token estimation, the summarizer's input, trace display. The
 * alternative, `JSON.stringify(part)`, writes the whole base64 payload into the
 * text: an image of ~400 tokens counts as 18,000 and a summarizer reads (and is
 * truncated into) a wall of base64 instead of knowing a picture was there.
 *
 * The label is the part's own `name`, else its file id, else its media type.
 */
export function describeContentPart(part: unknown): string | undefined {
  const kind = mediaKindOf(part);
  if (!kind || !isRecord(part)) return undefined;
  const label = nameOfPart(part) ?? mediaTypeOfPart(part) ?? labelFromUrl(urlOfPart(part));
  if (!label) return `[${kind}]`;
  const clean = label.replace(/[\r\n\]]+/g, " ").slice(0, PLACEHOLDER_LABEL_MAX);
  return `[${kind}: ${clean}]`;
}

/**
 * One content part as plain text: strings and text parts as they are, media as
 * its placeholder, anything else through `fallback` (default: its own `text` /
 * `content`, else its JSON).
 */
export function contentPartToText(part: unknown, fallback?: (part: unknown) => string): string {
  if (typeof part === "string") return part;
  if (!isRecord(part)) return part == null ? "" : String(part);
  const media = describeContentPart(part);
  if (media) return media;
  if (typeof part.text === "string") return part.text;
  if (typeof part.content === "string") return part.content;
  if (fallback) return fallback(part);
  try {
    return JSON.stringify(part);
  } catch {
    return String(part);
  }
}

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
            // A remote URL is short and is what a log reader wants. Anything
            // else — an inline data URL, a `{ base64 }` image, a reference to a
            // stored file — is described by name / id / media type instead.
            if (typeof url === "string" && /^https?:\/\//i.test(url)) {
              const detail = typeof img === "string" ? undefined : img?.detail;
              return `[image:${url}${detail ? ` detail=${detail}` : ""}]`;
            }
            return describeContentPart(p) ?? "[image]";
          }
          const media = describeContentPart(p);
          if (media) return media;
          // generic fallback
          return JSON.stringify(p);
        })
        .join("\n");
    }
    // unknown object
    return describeContentPart(content) ?? JSON.stringify(content);
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
