// ContextPilot: native context/token optimization layer for agent-sdk.
// Inspired by the compression/cache/relevance techniques found in the
// Headroom project, reimplemented here as zero-dependency, deterministic
// TypeScript so no native bindings or model downloads are required.

export type ContextPilotJsonCompressionConfig = {
  enabled?: boolean;
  /** Fraction (0-1) of array items to retain. Lower = more aggressive. */
  targetRatio?: number;
  /** Minimum array length before compression is even considered. */
  minItems?: number;
};

export type ContextPilotTextCompressionConfig = {
  enabled?: boolean;
  /** Fraction (0-1) of sentences to retain. */
  targetRatio?: number;
  /** Minimum character length before compression is even considered. */
  minChars?: number;
};

export type ContextPilotDiffCompressionConfig = {
  enabled?: boolean;
  /** Number of unchanged context lines to keep around each hunk boundary. */
  contextLines?: number;
};

export type ContextPilotLogCompressionConfig = {
  enabled?: boolean;
  /** Maximum number of retained lines after scoring. */
  maxLines?: number;
};

export type ContextPilotSearchCompressionConfig = {
  enabled?: boolean;
  /** Maximum number of retained match lines. */
  maxMatches?: number;
};

export type ContextPilotCompressionConfig = {
  json?: ContextPilotJsonCompressionConfig;
  text?: ContextPilotTextCompressionConfig;
  diff?: ContextPilotDiffCompressionConfig;
  log?: ContextPilotLogCompressionConfig;
  search?: ContextPilotSearchCompressionConfig;
};

export type ContextPilotCCRConfig = {
  enabled?: boolean;
  /** Time-to-live for stored originals, in milliseconds. */
  ttlMs?: number;
  /** Maximum number of entries kept in the reversible store (oldest evicted first). */
  maxEntries?: number;
};

export type ContextPilotCacheAlignmentConfig = {
  enabled?: boolean;
  /** Emit a one-time warning (event + trace) when volatile content is detected in the system prompt. */
  warnOnVolatilePrompt?: boolean;
};

export type ContextPilotDedupConfig = {
  enabled?: boolean;
  /** Minimum serialized size (chars) before a tool output is eligible for cross-turn dedup. */
  minChars?: number;
};

/**
 * ContextPilot: native context/token optimization layer.
 *
 * Runs deterministically (no extra model calls) at tool-execution time to
 * shrink large tool outputs before they enter the transcript, while keeping
 * every original payload recoverable via `get_tool_response`.
 */
export type ContextPilotConfig = {
  enabled?: boolean;
  compression?: ContextPilotCompressionConfig;
  ccr?: ContextPilotCCRConfig;
  cacheAlignment?: ContextPilotCacheAlignmentConfig;
  dedup?: ContextPilotDedupConfig;
  /** Tool names that should never be processed by ContextPilot. */
  excludeTools?: string[];
};

export type ResolvedContextPilotConfig = {
  enabled: boolean;
  compression: {
    json: Required<ContextPilotJsonCompressionConfig>;
    text: Required<ContextPilotTextCompressionConfig>;
    diff: Required<ContextPilotDiffCompressionConfig>;
    log: Required<ContextPilotLogCompressionConfig>;
    search: Required<ContextPilotSearchCompressionConfig>;
  };
  ccr: Required<ContextPilotCCRConfig>;
  cacheAlignment: Required<ContextPilotCacheAlignmentConfig>;
  dedup: Required<ContextPilotDedupConfig>;
  excludeTools: string[];
};

export type ContextPilotCompressorKind =
  | "jsonCrusher"
  | "textCrusher"
  | "diffCompressor"
  | "logCompressor"
  | "searchCompressor"
  | "none";

export type ContextPilotCompressionStats = {
  applied: boolean;
  compressorUsed: ContextPilotCompressorKind;
  originalTokens: number;
  compressedTokens: number;
  droppedItems?: number;
  ccrHash?: string;
  /** Set when this output was recognized as a cross-turn duplicate instead of compressed. */
  duplicateOf?: string;
};

export type ContextPilotResult = ContextPilotCompressionStats & {
  output: unknown;
};

export type VolatileContentPattern = "uuid" | "iso8601" | "unix_timestamp" | "jwt" | "hex_hash" | "api_key";

export type VolatileContentFinding = {
  pattern: VolatileContentPattern;
  match: string;
  index: number;
};
