// TextCrusher-equivalent: extractive compression of long plain-text tool
// output (docs, search snippets, freeform text). Scores sentences by BM25
// relevance to the query plus a mild recency bias, drops near-duplicate
// sentences, and keeps the top `targetRatio` fraction in original order.

import { countApproxTokens } from "../../utils/utilTokens.js";
import { scoreItemsByRelevance, selectTopIndicesInOrder } from "./relevance.js";
import type { CCRStore } from "./ccrStore.js";
import type { ContextPilotResult, ContextPilotTextCompressionConfig } from "./types.js";

function splitIntoSentences(text: string): string[] {
  // Split on sentence punctuation and newlines (dominant boundary in tool output/logs).
  return text
    .split(/(?<=[.!?。！？\n])\s*/u)
    .map((sentence) => sentence.trim())
    .filter(Boolean);
}

function normalizeForDedup(sentence: string): string {
  return sentence.toLowerCase().replace(/\s+/g, " ").trim();
}

function notApplied(text: string): ContextPilotResult {
  const tokens = countApproxTokens(text);
  return { applied: false, compressorUsed: "none", output: text, originalTokens: tokens, compressedTokens: tokens };
}

export function compressTextOutput(
  text: string,
  query: string,
  config: Required<ContextPilotTextCompressionConfig>,
  ccrStore: CCRStore,
): ContextPilotResult {
  if (!config.enabled || text.length < config.minChars) return notApplied(text);

  const rawSentences = splitIntoSentences(text);
  if (rawSentences.length < 6) return notApplied(text);

  // Near-duplicate suppression: keep only the first occurrence of each sentence.
  const seenNormalized = new Set<string>();
  const dedupedIndices: number[] = [];
  rawSentences.forEach((sentence, index) => {
    const key = normalizeForDedup(sentence);
    if (seenNormalized.has(key)) return;
    seenNormalized.add(key);
    dedupedIndices.push(index);
  });

  const relevanceScores = scoreItemsByRelevance(dedupedIndices.map((i) => rawSentences[i]), query);
  const recencyBoost = dedupedIndices.map((_value, position) => position / Math.max(1, dedupedIndices.length - 1));
  const combinedScores = relevanceScores.map((score, i) => score + recencyBoost[i] * 0.25);

  const keepCount = Math.max(3, Math.ceil(dedupedIndices.length * config.targetRatio));
  const keepPositions = new Set(selectTopIndicesInOrder(combinedScores, keepCount));
  const keptSentences = dedupedIndices
    .filter((_index, position) => keepPositions.has(position))
    .map((i) => rawSentences[i]);

  const droppedCount = rawSentences.length - keptSentences.length;
  if (droppedCount <= 0) return notApplied(text);

  const originalTokens = countApproxTokens(text);
  const ccrHash = ccrStore.store(text);
  const compressedText = `${keptSentences.join(" ")}\n[ContextPilot: ${droppedCount} lower-relevance sentence(s) omitted. Use get_tool_response with executionId="${ccrHash}" to retrieve the full original text.]`;
  const compressedTokens = countApproxTokens(compressedText);

  if (compressedTokens >= originalTokens * 0.9) return notApplied(text);

  return {
    applied: true,
    compressorUsed: "textCrusher",
    output: compressedText,
    originalTokens,
    compressedTokens,
    droppedItems: droppedCount,
    ccrHash,
  };
}
