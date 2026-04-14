// Structured Output Module
// Provides strategy-based structured output with native provider support and tool-based fallback.

export { StructuredOutputManager } from "./manager.js";
export { ToolBasedStrategy } from "./toolStrategy.js";
export { NativeJsonSchemaStrategy } from "./nativeStrategy.js";
export { resolveStrategy, getModelCapabilities } from "./resolver.js";
export {
  formatZodError,
  getNestedValue,
} from "./types.js";
export type {
  ModelCapabilities,
  StructuredOutputStrategy,
  StructuredOutputResult,
  StructuredOutputError,
  StructuredOutputFieldError,
  StructuredOutputManagerConfig,
} from "./types.js";
