// Public surface of the ContextPilot module.

export * from "./types.js";
export { tokenize, scoreItemsByRelevance, selectTopIndicesInOrder } from "./relevance.js";
export { CCRStore } from "./ccrStore.js";
export { DedupTracker } from "./dedup.js";
export { detectVolatileContent } from "./cacheAligner.js";
export { compressJsonOutput, CONTEXT_PILOT_JSON_MARKER_KEY } from "./jsonCrusher.js";
export { compressTextOutput } from "./textCrusher.js";
export { compressDiffOutput, compressLogOutput, compressSearchOutput, detectTextFormat } from "./formatCompressors.js";
export {
  compressToolOutput,
  createContextPilotRuntime,
  extractLatestUserQuery,
} from "./pipeline.js";
export type { ContextPilotRuntime, CompressToolOutputParams } from "./pipeline.js";
