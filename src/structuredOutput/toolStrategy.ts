import type { ZodError, ZodSchema } from "zod";
import type { StructuredOutputStrategy, StructuredOutputError } from "./types.js";
import { formatZodError, getNestedValue } from "./types.js";
import { createTool } from "../tool.js";
import type { ToolInterface } from "../types.js";

/**
 * Tool-based structured output strategy.
 *
 * Injects a hidden `response` tool that the model must call with the final JSON.
 * This is the universal fallback that works with all providers.
 */
export class ToolBasedStrategy implements StructuredOutputStrategy {
  readonly kind = "tool_based" as const;

  /**
   * Create the `response` tool for a given Zod schema.
   * The tool validates input against the schema and returns a sentinel object
   * that the tools node picks up to finalize the structured output.
   */
  createResponseTool<T>(schema: ZodSchema<T>): ToolInterface {
    return createTool({
      name: "response",
      description:
        "Finalize the answer by returning the final structured JSON matching the required schema. Call exactly once when you are fully done, then stop.",
      schema: schema as any,
      func: async (data: any) => {
        try {
          const validated = (schema as any).parse ? (schema as any).parse(data) : data;
          return { __finalStructuredOutput: true, data: validated };
        } catch (e: any) {
          // Return structured error so the model can self-correct
          const zodError = e as ZodError<T>;
          if (zodError?.issues) {
            const soError = formatZodError(zodError);
            return {
              error: "Schema validation failed",
              details: soError.message,
              fieldErrors: soError.fieldErrors,
            };
          }
          return { error: "Schema validation failed", details: e?.message };
        }
      },
    });
  }

  /**
   * Try to extract structured output from raw assistant text content.
   * Used as a last resort when the model writes JSON directly instead of calling the tool.
   */
  extractFromText<T>(content: string, schema: ZodSchema<T>): { data: T } | { error: StructuredOutputError } {
    let jsonText: string | null = null;

    // Try fenced code block first
    const fenced = content.match(/```(?:json)?\n([\s\S]*?)```/i);
    if (fenced && fenced[1]) {
      jsonText = fenced[1].trim();
    } else {
      // Find first { or [
      const braceIdx = content.indexOf("{");
      const bracketIdx = content.indexOf("[");
      const candidates = [braceIdx, bracketIdx].filter((i) => i >= 0).sort((a, b) => a - b);
      if (candidates.length > 0) {
        jsonText = content.slice(candidates[0]).trim();
      }
    }

    try {
      const raw = JSON.parse(jsonText ?? content);
      const validated = (schema as any).parse(raw);
      return { data: validated };
    } catch (e: any) {
      if (e?.issues) {
        return { error: formatZodError(e as ZodError<T>, content) };
      }
      return {
        error: {
          type: "parse_error",
          message: `Failed to parse JSON from assistant message: ${e?.message}`,
          rawContent: content,
        },
      };
    }
  }

  buildCorrectionPrompt(error: ZodError<any>, previousAttempt: unknown): string {
    const fieldIssues = error.issues
      .map((issue) => {
        const pathStr = issue.path.join(".") || "root";
        const received = getNestedValue(previousAttempt, issue.path);
        return `- "${pathStr}": ${issue.message} (received: ${JSON.stringify(received)})`;
      })
      .join("\n");

    return [
      "Your previous structured output had validation errors:",
      fieldIssues,
      "",
      "Please call `response` again with corrected values matching the schema.",
    ].join("\n");
  }
}
