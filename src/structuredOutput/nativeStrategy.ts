import type { ZodError, ZodSchema } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import type { StructuredOutputStrategy, StructuredOutputError } from "./types.js";
import { formatZodError, getNestedValue } from "./types.js";

/**
 * Native JSON Schema strategy for providers that support `response_format`.
 *
 * Works with OpenAI (gpt-4o+), Google Gemini, and similar providers
 * that accept `response_format: { type: "json_schema", json_schema: {...} }`.
 *
 * The model guarantees valid JSON output matching the schema — no tool needed.
 */
export class NativeJsonSchemaStrategy implements StructuredOutputStrategy {
  readonly kind = "native" as const;

  private resolveJsonPointer(document: Record<string, any>, pointer: string): unknown {
    if (!pointer.startsWith("#/")) {
      return undefined;
    }

    const segments = pointer
      .slice(2)
      .split("/")
      .map((segment) => segment.replace(/~1/g, "/").replace(/~0/g, "~"));

    let current: unknown = document;
    for (const segment of segments) {
      if (!current || typeof current !== "object" || !(segment in (current as Record<string, unknown>))) {
        return undefined;
      }
      current = (current as Record<string, unknown>)[segment];
    }

    return current;
  }

  private unwrapRootObjectSchema(schema: Record<string, any>): Record<string, any> {
    if (schema.type === "object") {
      return schema;
    }

    const ref = typeof schema.$ref === "string" ? schema.$ref : null;
    if (!ref) {
      return schema;
    }

    const resolved = this.resolveJsonPointer(schema, ref);
    if (!resolved || typeof resolved !== "object" || Array.isArray(resolved)) {
      return schema;
    }

    const resolvedSchema = { ...(resolved as Record<string, any>) };
    if (resolvedSchema.type !== "object") {
      return schema;
    }

    if (schema.definitions && resolvedSchema.definitions === undefined) {
      resolvedSchema.definitions = schema.definitions;
    }

    if (schema.$defs && resolvedSchema.$defs === undefined) {
      resolvedSchema.$defs = schema.$defs;
    }

    return resolvedSchema;
  }


  /**
   * Convert a Zod schema to the JSON Schema object used in response_format.
   */
  toJsonSchema(schema: ZodSchema<any>, name = "structured_response"): Record<string, any> {
    // `target: "openAi"` is the library's real strict-mode switch. The options
    // used before it (`openaiStrictMode`, `nameStrategy: "duplicate-ref"`,
    // `$refStrategy: "extract-to-root"`, `nullableStrategy`) do not exist in
    // zod-to-json-schema and were silently ignored, which had teeth:
    //   • an unrecognised `$refStrategy` makes `get$ref` return undefined, so a
    //     recursive schema (z.lazy) recursed until `RangeError: Maximum call
    //     stack size exceeded` — thrown here, before any request was sent;
    //   • repeated sub-schemas were re-inlined at every use site instead of
    //     being referenced once;
    //   • strict mode never ran, so the hand-rolled pass below had to force
    //     `required` — turning every `.optional()` field into one the model MUST
    //     invent a value for, because it was marked required with no null branch.
    // `target: "openAi"` emits `type: [T, "null"]` for optional fields, marks
    // everything required, and sets `additionalProperties: false` at every
    // level, so no post-processing is needed beyond unwrapping the root $ref.
    // ts-expect-error is for the DEPTH of zod's generic instantiation only —
    // the option keys below are all valid for the pinned zod-to-json-schema.
    // @ts-expect-error zodToJsonSchema type instantiation can be excessively deep with complex schemas
    const result = zodToJsonSchema(schema, {
      name,
      target: "openAi",
      $refStrategy: "root",
    });
    return this.unwrapRootObjectSchema(result as Record<string, any>);
  }

  /**
   * Build response_format configuration for the model call.
   * Returns the object that should be spread into model invocation options.
   */
  buildResponseFormat(schema: ZodSchema<any>, name?: string): Record<string, any> {
    const schemaName = name || "structured_response";
    const jsonSchema = this.toJsonSchema(schema, schemaName);
    // Remove $schema and other meta keys that some providers don't accept
    delete jsonSchema["$schema"];

    return {
      response_format: {
        type: "json_schema",
        json_schema: {
          name: schemaName,
          strict: true,
          schema: jsonSchema,
        },
      },
    };
  }

  /**
   * Parse and validate model response content.
   * With native support, content is guaranteed JSON — but we still validate with Zod
   * for type safety and field-level error reporting.
   */
  extractOutput<T>(content: string, schema: ZodSchema<T>): { data: T } | { error: StructuredOutputError } {
    try {
      const raw = JSON.parse(content);
      const validated = (schema as any).parse(raw);
      return { data: validated };
    } catch (e: any) {
      if (e?.issues) {
        return { error: formatZodError(e as ZodError<T>, content) };
      }
      return {
        error: {
          type: "parse_error",
          message: `Failed to parse native structured output: ${e?.message}`,
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
      "Your previous JSON response had validation errors:",
      fieldIssues,
      "",
      "Please output corrected JSON matching the schema.",
    ].join("\n");
  }
}
