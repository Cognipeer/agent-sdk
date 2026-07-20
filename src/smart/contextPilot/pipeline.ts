// ContextPilot pipeline: the main orchestrator that routes a tool's raw
// output through the appropriate compressor (JSON/array, diff, log, search,
// or plain text) and flags cross-turn duplicates. Never mutates `output` —
// the caller keeps the true original for `toolHistory.rawOutput` recovery.

import type { BaseMessage } from "../../types.js";
import { countApproxTokens } from "../../utils/utilTokens.js";
import { safeStringify } from "../../utils/content.js";
import { CCRStore } from "./ccrStore.js";
import { DedupTracker } from "./dedup.js";
import { compressJsonOutput } from "./jsonCrusher.js";
import { compressTextOutput } from "./textCrusher.js";
import { compressDiffOutput, compressLogOutput, compressSearchOutput, detectTextFormat } from "./formatCompressors.js";
import type { ContextPilotResult, ResolvedContextPilotConfig } from "./types.js";

export type ContextPilotRuntime = {
  ccrStore: CCRStore;
  dedupTracker: DedupTracker;
};

/** Creates a fresh (per-invoke) runtime: CCR store + dedup tracker. */
export function createContextPilotRuntime(config: ResolvedContextPilotConfig): ContextPilotRuntime {
  return {
    ccrStore: new CCRStore({ ttlMs: config.ccr.ttlMs, maxEntries: config.ccr.maxEntries }),
    dedupTracker: new DedupTracker(),
  };
}

/** Extracts the latest user message text, used as the relevance query for compression scoring. */
export function extractLatestUserQuery(messages: BaseMessage[] | undefined): string {
  if (!Array.isArray(messages)) return "";
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (message?.role !== "user") continue;
    if (typeof message.content === "string") return message.content;
    if (Array.isArray(message.content)) {
      return message.content
        .map((part: any) => (typeof part?.text === "string" ? part.text : ""))
        .filter(Boolean)
        .join(" ");
    }
  }
  return "";
}

function notApplied(output: unknown): ContextPilotResult {
  const tokens = countApproxTokens(safeStringify(output));
  return { applied: false, compressorUsed: "none", output, originalTokens: tokens, compressedTokens: tokens };
}

export type CompressToolOutputParams = {
  toolName: string;
  output: unknown;
  query: string;
  executionId: string;
  config: ResolvedContextPilotConfig;
  runtime: ContextPilotRuntime;
};

/**
 * ContextPilot entry point. Order of operations:
 *  1. Cross-turn duplicate check (short-circuits with a pointer if identical
 *     content was already seen in this run).
 *  2. Non-string (JSON-like) outputs go through the JSON/array compressor.
 *  3. String outputs are format-sniffed (diff/log/search/plain text) and
 *     routed to the matching compressor, falling back to generic text
 *     compression.
 */
export function compressToolOutput(params: CompressToolOutputParams): ContextPilotResult {
  const { toolName, output, query, executionId, config, runtime } = params;
  if (!config.enabled || config.excludeTools.includes(toolName)) return notApplied(output);

  // Drop-based compressors (json/text/diff/log/search) rely on the CCR store
  // to keep dropped/trimmed content recoverable via `get_tool_response`. If
  // the caller disabled CCR (`ccr.enabled: false`) or configured it to retain
  // nothing (`maxEntries: 0`), a stored hash would be evicted immediately —
  // producing a `get_tool_response` marker that can never be resolved. In
  // that case, skip all drop-based compression entirely rather than emit a
  // dead recovery reference; cross-turn dedup (which points at another
  // still-present transcript message, not the CCR store) is unaffected.
  const ccrAvailable = config.ccr.enabled && config.ccr.maxEntries > 0;

  if (config.dedup.enabled) {
    const serialized = typeof output === "string" ? output : safeStringify(output);
    if (serialized.length >= config.dedup.minChars) {
      const duplicate = runtime.dedupTracker.checkAndRegister(serialized, executionId, toolName);
      if (duplicate) {
        const originalTokens = countApproxTokens(serialized);
        const pointer = `DUPLICATE_TOOL_RESPONSE [toolName=${toolName}]\nIdentical to an earlier ${duplicate.toolName} result. Use get_tool_response with executionId="${duplicate.executionId}" to view it.`;
        return {
          applied: true,
          compressorUsed: "none",
          output: pointer,
          originalTokens,
          compressedTokens: countApproxTokens(pointer),
          duplicateOf: duplicate.executionId,
        };
      }
    }
  }

  if (typeof output !== "string") {
    if (ccrAvailable && config.compression.json.enabled) {
      const result = compressJsonOutput(output, query, config.compression.json, runtime.ccrStore);
      if (result.applied) return result;
    }
    return notApplied(output);
  }

  const format = detectTextFormat(output);
  if (ccrAvailable && format === "diff" && config.compression.diff.enabled) {
    const result = compressDiffOutput(output, config.compression.diff, runtime.ccrStore);
    if (result.applied) return result;
  } else if (ccrAvailable && format === "log" && config.compression.log.enabled) {
    const result = compressLogOutput(output, config.compression.log, runtime.ccrStore);
    if (result.applied) return result;
  } else if (ccrAvailable && format === "search" && config.compression.search.enabled) {
    const result = compressSearchOutput(output, config.compression.search, runtime.ccrStore);
    if (result.applied) return result;
  }

  if (ccrAvailable && config.compression.text.enabled) {
    const result = compressTextOutput(output, query, config.compression.text, runtime.ccrStore);
    if (result.applied) return result;
  }

  return notApplied(output);
}
