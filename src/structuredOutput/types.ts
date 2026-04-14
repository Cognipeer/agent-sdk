import type { ZodError } from "zod";

// --- Model Capabilities ---

/** Describes what a model/provider natively supports. */
export type ModelCapabilities = {
  /** How the model supports structured output:
   *  - "native": model accepts response_format with json_schema (OpenAI, Gemini, etc.)
   *  - "tool_based": structured output must be emulated via a response tool
   */
  structuredOutput?: "native" | "tool_based";
  /** Whether tools must be bound with strict=true for native structured output auto-parsing. */
  strictToolCalling?: boolean;
  /** Whether the model supports streaming */
  streaming?: boolean;
  /** Provider identifier (e.g. "openai", "anthropic", "bedrock", "google") */
  provider?: string;
};

// --- Structured Output Error ---

export type StructuredOutputFieldError = {
  path: string;
  expected: string;
  received: string;
  message: string;
};

export type StructuredOutputError = {
  type: "parse_error" | "validation_error" | "no_output" | "max_retries";
  message: string;
  fieldErrors?: StructuredOutputFieldError[];
  rawContent?: string;
};

// --- Structured Output Result ---

export type StructuredOutputResult<T> =
  | { success: true; data: T; attempts: number }
  | { success: false; error: StructuredOutputError; attempts: number; rawContent?: string };

// --- Strategy Interface ---

/**
 * Encapsulates how structured output is achieved for a given model/provider.
 * NativeJsonSchemaStrategy uses response_format; ToolBasedStrategy uses a response tool.
 */
export interface StructuredOutputStrategy {
  readonly kind: "native" | "tool_based";

  /**
   * Build a correction prompt when validation fails.
   * The prompt tells the model exactly which fields were wrong.
   */
  buildCorrectionPrompt(error: ZodError<any>, previousAttempt: unknown): string;
}

// --- Manager Config ---

export type StructuredOutputManagerConfig = {
  maxRetries?: number;
};

// --- Helper: get nested value for error messages ---

export function getNestedValue(obj: unknown, path: (string | number)[]): unknown {
  let current: any = obj;
  for (const key of path) {
    if (current == null || typeof current !== "object") return undefined;
    current = current[key];
  }
  return current;
}

// --- Helper: format ZodError into StructuredOutputError ---

export function formatZodError(error: ZodError<any>, rawContent?: string): StructuredOutputError {
  const fieldErrors: StructuredOutputFieldError[] = error.issues.map((issue) => ({
    path: issue.path.join(".") || "root",
    expected: (issue as any).expected ?? issue.code,
    received: (issue as any).received ?? "unknown",
    message: issue.message,
  }));

  return {
    type: "validation_error",
    message: `Schema validation failed: ${fieldErrors.map((f) => `${f.path}: ${f.message}`).join("; ")}`,
    fieldErrors,
    rawContent,
  };
}
