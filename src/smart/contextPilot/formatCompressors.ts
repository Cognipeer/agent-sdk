// Format-specific compressors (Faz 6): DiffCompressor, LogCompressor and
// SearchCompressor equivalents, mirroring Headroom's content-shape-aware
// compression strategies for git diffs, structured logs, and grep/search
// results respectively.

import { countApproxTokens } from "../../utils/utilTokens.js";
import type { CCRStore } from "./ccrStore.js";
import type {
  ContextPilotDiffCompressionConfig,
  ContextPilotLogCompressionConfig,
  ContextPilotResult,
  ContextPilotSearchCompressionConfig,
} from "./types.js";

function notApplied(text: string): ContextPilotResult {
  const tokens = countApproxTokens(text);
  return { applied: false, compressorUsed: "none", output: text, originalTokens: tokens, compressedTokens: tokens };
}

/** Cheap content-shape detector used to route a text tool output to the right compressor. */
export function detectTextFormat(text: string): "diff" | "log" | "search" | "text" {
  const sample = text.slice(0, 2000);
  if (/^diff --git |^---\s|^\+\+\+\s|^@@ -\d+/m.test(sample)) return "diff";
  if (/^[\w./-]+:\d+:/m.test(sample) || /^[\w./-]+-\d+-/m.test(sample)) return "search";
  if (/\b(ERROR|FAIL|FAILED|WARN|PASS|PASSED)\b/.test(sample) && text.split("\n").length > 15) return "log";
  return "text";
}

/**
 * Keeps hunk headers and every added/removed line verbatim, trims unchanged
 * context lines beyond `contextLines` around each hunk boundary.
 */
export function compressDiffOutput(
  text: string,
  config: Required<ContextPilotDiffCompressionConfig>,
  ccrStore: CCRStore,
): ContextPilotResult {
  if (!config.enabled) return notApplied(text);
  const lines = text.split("\n");
  const kept: string[] = [];
  let contextRun = 0;
  let trimmedAny = false;

  for (const line of lines) {
    const isHeader = line.startsWith("diff --git") || line.startsWith("---") || line.startsWith("+++") || line.startsWith("@@");
    const isChange = line.startsWith("+") || line.startsWith("-");
    if (isHeader || isChange) {
      kept.push(line);
      contextRun = 0;
      continue;
    }
    if (contextRun < config.contextLines) {
      kept.push(line);
      contextRun += 1;
    } else {
      trimmedAny = true;
    }
  }

  if (!trimmedAny) return notApplied(text);

  const originalTokens = countApproxTokens(text);
  const ccrHash = ccrStore.store(text);
  const compressedText = `${kept.join("\n")}\n[ContextPilot: unchanged context lines beyond ${config.contextLines} trimmed. Use get_tool_response with executionId="${ccrHash}" to retrieve the full diff.]`;
  const compressedTokens = countApproxTokens(compressedText);
  if (compressedTokens >= originalTokens * 0.9) return notApplied(text);

  return { applied: true, compressorUsed: "diffCompressor", output: compressedText, originalTokens, compressedTokens, ccrHash };
}

const LOG_LEVEL_SCORE: Array<{ regex: RegExp; score: number }> = [
  { regex: /\b(FAIL|FAILED|ERROR|FATAL|EXCEPTION|TRACEBACK)\b/i, score: 1 },
  { regex: /\b(WARN|WARNING)\b/i, score: 0.7 },
  { regex: /\b(PASS|PASSED|OK|SUCCESS)\b/i, score: 0.4 },
  { regex: /\bINFO\b/i, score: 0.3 },
  { regex: /\b(DEBUG|TRACE)\b/i, score: 0.1 },
];

function scoreLogLine(line: string): number {
  for (const { regex, score } of LOG_LEVEL_SCORE) {
    if (regex.test(line)) return score;
  }
  return 0.2;
}

/**
 * Scores each line by log-level keywords (errors/failures always win) and
 * keeps the top `maxLines`, always preserving the first and last line.
 */
export function compressLogOutput(
  text: string,
  config: Required<ContextPilotLogCompressionConfig>,
  ccrStore: CCRStore,
): ContextPilotResult {
  if (!config.enabled) return notApplied(text);
  const lines = text.split("\n").filter((line) => line.length > 0);
  if (lines.length <= config.maxLines) return notApplied(text);

  const scored = lines.map((line, index) => ({ line, index, score: scoreLogLine(line) }));
  const mustKeep = new Set<number>([0, lines.length - 1]);
  const ranked = scored
    .filter((entry) => !mustKeep.has(entry.index))
    .sort((a, b) => b.score - a.score)
    .slice(0, Math.max(0, config.maxLines - mustKeep.size))
    .map((entry) => entry.index);

  const keepIndices = new Set<number>([...mustKeep, ...ranked]);
  const droppedCount = lines.length - keepIndices.size;
  if (droppedCount <= 0) return notApplied(text);

  const originalTokens = countApproxTokens(text);
  const ccrHash = ccrStore.store(text);
  const keptLines = lines.filter((_line, index) => keepIndices.has(index));
  const compressedText = `${keptLines.join("\n")}\n[ContextPilot: ${droppedCount} lower-priority log line(s) omitted (errors/warnings preserved). Use get_tool_response with executionId="${ccrHash}" to retrieve the full log.]`;
  const compressedTokens = countApproxTokens(compressedText);
  if (compressedTokens >= originalTokens * 0.9) return notApplied(text);

  return { applied: true, compressorUsed: "logCompressor", output: compressedText, originalTokens, compressedTokens, droppedItems: droppedCount, ccrHash };
}

/**
 * Keeps up to `maxMatches` grep/ripgrep-style match lines (`file:line:content`
 * or `file-line-content`), biased towards file diversity via a soft per-file cap.
 */
export function compressSearchOutput(
  text: string,
  config: Required<ContextPilotSearchCompressionConfig>,
  ccrStore: CCRStore,
): ContextPilotResult {
  if (!config.enabled) return notApplied(text);
  const lines = text.split("\n").filter((line) => line.length > 0);
  if (lines.length <= config.maxMatches) return notApplied(text);

  const perFileCount = new Map<string, number>();
  const perFileCap = Math.max(3, Math.ceil(config.maxMatches / 4));
  const kept: string[] = [];
  for (const line of lines) {
    if (kept.length >= config.maxMatches) break;
    const fileKey = line.split(/[:-]/)[0] || "unknown";
    const count = perFileCount.get(fileKey) || 0;
    if (count >= perFileCap) continue;
    perFileCount.set(fileKey, count + 1);
    kept.push(line);
  }

  const droppedCount = lines.length - kept.length;
  if (droppedCount <= 0) return notApplied(text);

  const originalTokens = countApproxTokens(text);
  const ccrHash = ccrStore.store(text);
  const compressedText = `${kept.join("\n")}\n[ContextPilot: ${droppedCount} additional match(es) omitted. Use get_tool_response with executionId="${ccrHash}" to retrieve all matches.]`;
  const compressedTokens = countApproxTokens(compressedText);
  if (compressedTokens >= originalTokens * 0.9) return notApplied(text);

  return { applied: true, compressorUsed: "searchCompressor", output: compressedText, originalTokens, compressedTokens, droppedItems: droppedCount, ccrHash };
}
