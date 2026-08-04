import { describe, expect, it } from "vitest";
import { z } from "zod";

import { coerceToolArgs } from "../src/smart/toolArgCoercion.js";
import { validateToolArgs } from "../src/smart/toolResponses.js";

const expectedResultSchema = z.object({
  kind: z.enum(["message", "table", "file"]),
  format: z.enum(["markdown", "csv", "xlsx", "json"]).nullable().optional(),
  columns: z.array(z.string()).max(24).nullable().optional(),
  minRows: z.number().int().min(0).nullable().optional(),
  description: z.string().min(1).max(1000)
}).nullable();

const createTaskSchema = z.object({
  name: z.string().min(1),
  prompt: z.string().min(12),
  scheduleType: z.enum(["immediate", "cron", "delayed"]),
  delaySeconds: z.number().int().positive().nullable().optional(),
  expectedResult: expectedResultSchema.optional(),
  dependsOn: z.array(z.string().uuid()).max(8).nullable().optional()
});

const tool = { name: "create_task", schema: createTaskSchema } as never;

describe("tool argument coercion", () => {
  it("repairs a nested object that arrived as a JSON string", () => {
    const result = validateToolArgs(tool, {
      name: "Weekly report",
      prompt: "Produce the weekly revenue report from the CRM.",
      scheduleType: "immediate",
      expectedResult: '{"kind":"file","description":"An xlsx with revenue rows","format":"xlsx"}'
    });

    expect(result.ok).toBe(true);
    expect(result.ok && result.coerced).toBe(true);
    expect(result.ok && result.value.expectedResult).toEqual({
      kind: "file",
      description: "An xlsx with revenue rows",
      format: "xlsx"
    });
  });

  it("repairs stringified numbers and placeholder optionals", () => {
    const result = validateToolArgs(tool, {
      name: "Digest",
      prompt: "Summarize yesterday's incoming webhooks.",
      scheduleType: "delayed",
      delaySeconds: "600",
      dependsOn: ""
    });

    expect(result.ok).toBe(true);
    expect(result.ok && result.value.delaySeconds).toBe(600);
    expect(result.ok && result.value.dependsOn).toBeUndefined();
  });

  it("wraps a single value where a list was expected", () => {
    const schema = z.object({ columns: z.array(z.string()) });
    expect(coerceToolArgs(schema, { columns: "revenue" })).toEqual({ columns: ["revenue"] });
  });

  it("unwraps an envelope key the model wrapped every argument in", () => {
    const result = validateToolArgs(tool, {
      input: { name: "X", prompt: "Do the thing carefully.", scheduleType: "immediate" }
    });
    expect(result.ok).toBe(true);
    expect(result.ok && result.value.name).toBe("X");
  });

  it("leaves well-typed arguments untouched and does not mark them coerced", () => {
    const result = validateToolArgs(tool, {
      name: "X",
      prompt: "Do the thing carefully.",
      scheduleType: "immediate",
      delaySeconds: 30
    });
    expect(result.ok).toBe(true);
    expect(result.ok && result.coerced).toBeUndefined();
  });

  it("still rejects a genuinely missing required argument, with the expected shape", () => {
    const result = validateToolArgs(tool, { name: "X", scheduleType: "immediate" });
    expect(result.ok).toBe(false);
    expect(!result.ok && result.message).toContain("prompt");
    expect(!result.ok && result.message).toContain("Expected arguments:");
  });

  it("coerces booleans sent as strings", () => {
    const schema = z.object({ replaceAll: z.boolean().nullable().optional() });
    expect(schema.safeParse(coerceToolArgs(schema, { replaceAll: "true" })).success).toBe(true);
  });
});
