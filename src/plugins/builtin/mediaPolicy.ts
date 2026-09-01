/**
 * What a user is allowed to attach.
 *
 * A multimodal turn is an untrusted upload path with a per-token price tag: a
 * single high-resolution image can cost more than the conversation around it,
 * a video the provider does not support fails deep inside the request, and a
 * `http://` URL is a server-side fetch of whatever the sender wants. None of
 * that is visible to a text guardrail, which sees only the caption.
 *
 * Structural checks only — kind, count, size, media type, source. Deciding
 * whether a picture is acceptable is a content question and belongs to a
 * moderation service; this decides whether it should be there at all.
 */

import type { AgentPlugin } from "../types.js";
import type { ContentPart } from "../../types.js";
import type { MediaAttachment } from "../../utils/content.js";

export type MediaKind = "image" | "audio" | "video" | "file" | "unknown";

export type MediaPolicyConfig = {
  /** Kinds that may be attached. Default: every kind. */
  allow?: MediaKind[];
  /** Kinds that may never be attached. Checked after `allow`. */
  deny?: MediaKind[];
  /** Cap on attachments in one turn. */
  maxAttachments?: number;
  /** Cap on a single attachment, in bytes. Only measurable for inline data. */
  maxBytesPerAttachment?: number;
  /** Cap on the total inline bytes in one turn. */
  maxTotalBytes?: number;
  /** Exact media types, or a prefix ending in `/` (e.g. `"image/"`). */
  allowedMediaTypes?: string[];
  /** Reject `http://` sources. Default true — the provider fetches these server-side. */
  requireHttps?: boolean;
  /**
   * `deny` refuses the turn and tells the user why; `strip` drops the offending
   * parts and lets the run continue on what is left. Default `deny`, because
   * silently answering about a picture the model never received is worse than
   * saying no.
   */
  action?: "deny" | "strip";
  name?: string;
  priority?: number;
};

type Violation = { attachment: MediaAttachment; reason: string };

function describe(attachment: MediaAttachment): string {
  const parts: string[] = [attachment.kind];
  if (attachment.mediaType) parts.push(attachment.mediaType);
  if (attachment.fileName) parts.push(attachment.fileName);
  return parts.join(" ");
}

function mediaTypeAllowed(mediaType: string | undefined, allowed: string[]): boolean {
  if (!mediaType) return false;
  return allowed.some((entry) =>
    entry.endsWith("/") ? mediaType.startsWith(entry) : mediaType === entry,
  );
}

export function mediaPolicy(config: MediaPolicyConfig = {}): AgentPlugin {
  const allow = config.allow ? new Set<MediaKind>(config.allow) : undefined;
  const deny = config.deny ? new Set<MediaKind>(config.deny) : undefined;
  const requireHttps = config.requireHttps !== false;
  const action = config.action ?? "deny";

  const inspect = (attachments: MediaAttachment[]): Violation[] => {
    const violations: Violation[] = [];
    let totalBytes = 0;

    for (const attachment of attachments) {
      if (allow && !allow.has(attachment.kind)) {
        violations.push({
          attachment,
          reason: `${describe(attachment)} attachments are not accepted here.`,
        });
        continue;
      }
      if (deny?.has(attachment.kind)) {
        violations.push({
          attachment,
          reason: `${describe(attachment)} attachments are not accepted here.`,
        });
        continue;
      }
      if (config.allowedMediaTypes && !mediaTypeAllowed(attachment.mediaType, config.allowedMediaTypes)) {
        violations.push({
          attachment,
          reason: `Media type ${attachment.mediaType ?? "unknown"} is not accepted (allowed: ${config.allowedMediaTypes.join(", ")}).`,
        });
        continue;
      }
      if (
        config.maxBytesPerAttachment !== undefined
        && attachment.approxBytes !== undefined
        && attachment.approxBytes > config.maxBytesPerAttachment
      ) {
        violations.push({
          attachment,
          reason: `Attachment is too large: ${attachment.approxBytes} bytes exceeds the ${config.maxBytesPerAttachment} byte size limit.`,
        });
        continue;
      }
      if (requireHttps && attachment.sourceType === "url" && attachment.url?.startsWith("http://")) {
        violations.push({
          attachment,
          // The provider dereferences this URL from its own network, so a
          // plaintext one is both interceptable and a request the sender chose.
          reason: `Attachment URL must use https (got ${attachment.url.slice(0, 60)}).`,
        });
        continue;
      }
      totalBytes += attachment.approxBytes ?? 0;
    }

    if (config.maxTotalBytes !== undefined && totalBytes > config.maxTotalBytes) {
      violations.push({
        attachment: attachments[0],
        reason: `Attachments total ${totalBytes} bytes, over the ${config.maxTotalBytes} byte limit for one message.`,
      });
    }

    return violations;
  };

  return {
    name: config.name ?? "media-policy",
    // Ahead of the guardrail presets (20) so a refused attachment is never sent
    // to a policy service, and after piiRedaction (10) so a caption is already
    // masked by the time it is quoted in a refusal.
    priority: config.priority ?? 14,
    failureMode: "closed",

    hooks: {
      userPromptSubmit: ({ content, attachments }, ctx) => {
        if (attachments.length === 0) return undefined;

        if (config.maxAttachments !== undefined && attachments.length > config.maxAttachments) {
          return {
            decision: "deny",
            reason: `This message carries ${attachments.length} attachments; at most ${config.maxAttachments} are accepted.`,
          };
        }

        const violations = inspect(attachments);
        if (violations.length === 0) return undefined;

        ctx.emit({
          type: "metadata",
          mediaPolicy: {
            plugin: config.name ?? "media-policy",
            action,
            violations: violations.map((v) => ({ kind: v.attachment.kind, reason: v.reason })),
          },
        } as never);

        if (action === "deny") {
          return { decision: "deny", reason: violations.map((v) => v.reason).join(" ") };
        }

        // Strip: drop the offending parts by index and keep the rest in order.
        if (!Array.isArray(content)) return undefined;
        const dropped = new Set(violations.map((v) => v.attachment?.index).filter((i) => i !== undefined));
        return { content: (content as ContentPart[]).filter((_part, index) => !dropped.has(index)) };
      },
    },
  };
}
