// CacheAligner: detects "volatile" substrings (UUIDs, timestamps, JWTs,
// hashes, API keys) that would change on every request. Detection-only —
// ContextPilot never rewrites the system prompt; it surfaces a warning so
// the host application can move volatile values out of the cached prefix
// (important for provider-side prompt caching, e.g. Anthropic/OpenAI).

import type { VolatileContentFinding, VolatileContentPattern } from "./types.js";

const PATTERNS: Array<{ kind: VolatileContentPattern; regex: RegExp }> = [
  { kind: "uuid", regex: /\b[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\b/g },
  { kind: "iso8601", regex: /\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?\b/g },
  { kind: "jwt", regex: /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g },
  { kind: "hex_hash", regex: /\b[0-9a-fA-F]{64}\b|\b[0-9a-fA-F]{40}\b|\b[0-9a-fA-F]{32}\b/g },
  { kind: "api_key", regex: /\b(?:sk|pk|ghp|gho|ghu|ghs)-[A-Za-z0-9]{10,}\b/g },
  { kind: "unix_timestamp", regex: /\b1\d{12}\b(?!\d)|\b1\d{9}\b(?!\d)/g },
];

/**
 * Scans `text` for volatile content and returns up to `limit` findings.
 * Cheap regex-only detection, no ML, safe to call on every system prompt.
 */
export function detectVolatileContent(text: string, limit = 20): VolatileContentFinding[] {
  if (!text) return [];
  const findings: VolatileContentFinding[] = [];
  for (const { kind, regex } of PATTERNS) {
    regex.lastIndex = 0;
    let match: RegExpExecArray | null;
    while (findings.length < limit && (match = regex.exec(text)) !== null) {
      findings.push({ pattern: kind, match: match[0], index: match.index });
      if (regex.lastIndex === match.index) regex.lastIndex += 1; // guard against zero-length loops
    }
  }
  return findings;
}
