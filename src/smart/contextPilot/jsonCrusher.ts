// SmartCrusher-equivalent: compresses large arrays (or the dominant array
// field of an object) by keeping only the most query-relevant items. Dropped
// items are never lost — they are stored in the CCR store and a marker
// referencing the CCR hash is appended so the model can recover them via
// `get_tool_response` if actually needed.

import { countApproxTokens } from "../../utils/utilTokens.js";
import { safeStringify } from "../../utils/content.js";
import { scoreItemsByRelevance, selectTopIndicesInOrder } from "./relevance.js";
import type { CCRStore } from "./ccrStore.js";
import type { ContextPilotJsonCompressionConfig, ContextPilotResult } from "./types.js";

export const CONTEXT_PILOT_JSON_MARKER_KEY = "__contextPilotDropped";

type ArrayTarget = { array: unknown[]; wrap: (compressedArray: unknown[]) => unknown };

function findCompressibleArray(output: unknown, minItems: number): ArrayTarget | null {
  if (Array.isArray(output)) {
    return { array: output, wrap: (arr) => arr };
  }
  if (output && typeof output === "object") {
    let bestKey: string | undefined;
    let bestArray: unknown[] | undefined;
    for (const [key, value] of Object.entries(output as Record<string, unknown>)) {
      if (Array.isArray(value) && (!bestArray || value.length > bestArray.length)) {
        bestKey = key;
        bestArray = value;
      }
    }
    if (bestKey && bestArray && bestArray.length >= minItems) {
      const key = bestKey;
      return {
        array: bestArray,
        wrap: (arr) => ({ ...(output as Record<string, unknown>), [key]: arr }),
      };
    }
  }
  return null;
}

function notApplied(output: unknown): ContextPilotResult {
  const tokens = countApproxTokens(safeStringify(output));
  return { applied: false, compressorUsed: "none", output, originalTokens: tokens, compressedTokens: tokens };
}

export function compressJsonOutput(
  output: unknown,
  query: string,
  config: Required<ContextPilotJsonCompressionConfig>,
  ccrStore: CCRStore,
): ContextPilotResult {
  if (!config.enabled) return notApplied(output);

  const target = findCompressibleArray(output, config.minItems);
  if (!target || target.array.length < config.minItems) return notApplied(output);

  const { array, wrap } = target;
  const itemTexts = array.map((item) => safeStringify(item));
  const scores = scoreItemsByRelevance(itemTexts, query);
  const keepCount = Math.max(1, Math.min(array.length, Math.ceil(array.length * config.targetRatio)));
  const keepIndices = new Set(selectTopIndicesInOrder(scores, keepCount));

  const droppedCount = array.length - keepIndices.size;
  if (droppedCount <= 0) return notApplied(output);

  const originalTokens = countApproxTokens(safeStringify(output));
  const ccrHash = ccrStore.store(output);
  const keptItems = array.filter((_item, index) => keepIndices.has(index));
  const marker = {
    [CONTEXT_PILOT_JSON_MARKER_KEY]: droppedCount,
    note: `${droppedCount} lower-relevance item(s) omitted by ContextPilot. Use get_tool_response with executionId="${ccrHash}" to retrieve the full original array if a dropped item is actually needed.`,
  };
  const compressedOutput = wrap([...keptItems, marker]);
  const compressedTokens = countApproxTokens(safeStringify(compressedOutput));

  // Guard against pointless compression (marker overhead outweighs savings on small arrays).
  if (compressedTokens >= originalTokens * 0.9) return notApplied(output);

  return {
    applied: true,
    compressorUsed: "jsonCrusher",
    output: compressedOutput,
    originalTokens,
    compressedTokens,
    droppedItems: droppedCount,
    ccrHash,
  };
}
