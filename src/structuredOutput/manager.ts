import type { ZodSchema } from "zod";
import type {
  StructuredOutputStrategy,
  StructuredOutputResult,
  StructuredOutputError,
  StructuredOutputManagerConfig,
} from "./types.js";
// formatZodError available from ./types.js for strategy implementations
import type { ToolBasedStrategy } from "./toolStrategy.js";
import type { NativeJsonSchemaStrategy } from "./nativeStrategy.js";
import type { ToolInterface } from "../types.js";

/**
 * Centralized manager for structured output across both base Agent and SmartAgent.
 *
 * Responsibilities:
 * - Prepare tools or response_format depending on the resolved strategy
 * - Build system prompt hints tailored to the strategy
 * - Build nudge/correction prompts for retries
 * - Parse final output from tool result or assistant content
 * - Report structured errors (never silently swallow)
 */
export class StructuredOutputManager<T> {
  readonly strategy: StructuredOutputStrategy;
  readonly schema: ZodSchema<T>;
  readonly maxRetries: number;

  constructor(
    schema: ZodSchema<T>,
    strategy: StructuredOutputStrategy,
    config?: StructuredOutputManagerConfig,
  ) {
    this.schema = schema;
    this.strategy = strategy;
    this.maxRetries = config?.maxRetries ?? 2;
  }

  // --- Setup Phase ---

  /**
   * Get the `response` tool for tool-based strategy.
   * Returns undefined for native strategy (no tool needed).
   */
  getResponseTool(): ToolInterface | undefined {
    if (this.strategy.kind !== "tool_based") return undefined;
    return (this.strategy as ToolBasedStrategy).createResponseTool(this.schema);
  }

  /**
   * Get response_format config for native strategy.
   * Returns undefined for tool-based strategy.
   */
  getResponseFormat(): Record<string, any> | undefined {
    if (this.strategy.kind !== "native") return undefined;
    return (this.strategy as NativeJsonSchemaStrategy).buildResponseFormat(this.schema);
  }

  /**
   * Build the system prompt hint that tells the model how to produce structured output.
   */
  buildSystemPromptHint(): string {
    if (this.strategy.kind === "native") {
      return [
        "A structured output schema is active.",
        "Your response MUST be valid JSON matching the output schema.",
        "Do NOT wrap the JSON in code fences or add any text before/after it.",
      ].join("\n");
    }

    // tool_based
    return [
      "A structured output schema is active.",
      "Do NOT output the final JSON directly as an assistant message.",
      "When completely finished, call tool `response` passing the final JSON matching the schema as its arguments (direct object).",
      "Call it exactly once then STOP producing further assistant messages.",
    ].join("\n");
  }

  /**
   * Build a nudge message for when the model didn't produce structured output.
   * Used by the agent loop when it needs to retry.
   */
  buildNudgeMessage(isLastAttempt: boolean): { role: string; content: string } {
    if (this.strategy.kind === "native") {
      return {
        role: "system",
        content: [
          "A structured output schema is active.",
          "You MUST respond with valid JSON matching the schema.",
          "Do NOT include any text outside the JSON object.",
          isLastAttempt ? "This is your FINAL attempt. Produce the JSON NOW." : "",
        ].filter(Boolean).join("\n"),
      };
    }

    // tool_based
    return {
      role: "system",
      content: [
        "A structured output schema is active.",
        "You MUST now call tool `response` with the final JSON object that matches the schema.",
        "Do not write the JSON in the assistant message.",
        "Call `response` exactly once, then stop.",
        isLastAttempt ? "Do NOT call any other tools. Produce the response NOW based on whatever information you have gathered so far." : "",
      ].filter(Boolean).join("\n"),
    };
  }

  /**
   * Build a correction message when schema validation failed.
   */
  buildCorrectionMessage(error: StructuredOutputError, _previousAttempt?: unknown): { role: string; content: string } {
    if (error.fieldErrors && error.fieldErrors.length > 0) {
      const fieldIssues = error.fieldErrors
        .map((f) => `- "${f.path}": ${f.message} (received: ${JSON.stringify(f.received)})`)
        .join("\n");

      const action = this.strategy.kind === "native"
        ? "Please output corrected JSON matching the schema."
        : "Please call `response` again with corrected values matching the schema.";

      return {
        role: "system",
        content: [
          "Your previous structured output had validation errors:",
          fieldIssues,
          "",
          action,
        ].join("\n"),
      };
    }

    // Generic correction
    return this.buildNudgeMessage(false);
  }

  // --- Parse Phase ---

  /**
   * Try to parse structured output from the tool-based finalization result.
   * Called when __structuredOutputParsed is available in ctx.
   */
  parseFromToolResult(data: unknown): StructuredOutputResult<T> {
    return { success: true, data: data as T, attempts: 1 };
  }

  /**
   * Try to parse structured output from assistant message content.
   * For native strategy: content should be valid JSON.
   * For tool-based strategy: last-resort fallback extraction from text.
   */
  parseFromContent(content: string): StructuredOutputResult<T> {
    if (this.strategy.kind === "native") {
      const result = (this.strategy as NativeJsonSchemaStrategy).extractOutput(content, this.schema);
      if ("data" in result) {
        return { success: true, data: result.data, attempts: 1 };
      }
      return { success: false, error: result.error, attempts: 1, rawContent: content };
    }

    // tool_based fallback
    const result = (this.strategy as ToolBasedStrategy).extractFromText(content, this.schema);
    if ("data" in result) {
      return { success: true, data: result.data, attempts: 1 };
    }
    return { success: false, error: result.error, attempts: 1, rawContent: content };
  }

  /**
   * Create a "no output" error result.
   */
  noOutputResult(attempts: number, rawContent?: string): StructuredOutputResult<T> {
    return {
      success: false,
      error: {
        type: "no_output",
        message: "Model did not produce structured output after all retry attempts.",
        rawContent,
      },
      attempts,
      rawContent,
    };
  }

  /**
   * Create a "max retries" error result.
   */
  maxRetriesResult(lastError: StructuredOutputError, attempts: number, rawContent?: string): StructuredOutputResult<T> {
    return {
      success: false,
      error: {
        ...lastError,
        type: "max_retries",
        message: `Structured output failed after ${attempts} attempts: ${lastError.message}`,
      },
      attempts,
      rawContent,
    };
  }
}
