/**
 * inlineJsonSchemaRefs: the Responses API rejects zod-to-json-schema's
 * mid-document `$ref` pointers ("reference to component
 * '#/definitions/structured_response/properties/goals/items' which was not
 * found in the schema"), so `text.format.schema` is sent with them inlined.
 */
import { describe, it, expect } from "vitest";
import { z } from "zod";

import { inlineJsonSchemaRefs } from "../../../src/providers/utils/jsonSchemaRefs.js";
import { NativeJsonSchemaStrategy } from "../../../src/structuredOutput/nativeStrategy.js";

/** The schema exactly as the SDK builds it for response_format. */
function sdkSchema(schema: z.ZodTypeAny): Record<string, any> {
  return new NativeJsonSchemaStrategy().buildResponseFormat(schema).response_format.json_schema.schema;
}

const item = z.object({ text: z.string(), weight: z.number().optional() });
/** One item schema reused by two properties — the shape of the reported failure. */
const reused = () => sdkSchema(z.object({ summary: z.string(), goals: z.array(item), durableFacts: z.array(item) }));

type Tree = { name: string; children: Tree[] };
const treeNode: z.ZodType<Tree> = z.lazy(() => z.object({ name: z.string(), children: z.array(treeNode) }));
const recursive = () => sdkSchema(z.object({ tree: treeNode }));

const hasRef = (value: unknown) => JSON.stringify(value).includes('"$ref"');

/** Deep-freezes so any write to the input throws. */
function frozen<T>(value: T): T {
  if (value && typeof value === "object") {
    Object.values(value).forEach(frozen);
    Object.freeze(value);
  }
  return value;
}

describe("inlineJsonSchemaRefs", () => {
  it("returns the very same object when there is no $ref", () => {
    const plain = sdkSchema(z.object({ a: z.string(), b: z.array(z.object({ c: z.number() })) }));
    expect(hasRef(plain)).toBe(false);
    expect(inlineJsonSchemaRefs(plain)).toBe(plain);

    const withUnusedDefinitions = { type: "object", properties: {}, definitions: { x: { type: "string" } } };
    expect(inlineJsonSchemaRefs(withUnusedDefinitions)).toBe(withUnusedDefinitions);

    expect(inlineJsonSchemaRefs(undefined)).toBe(undefined);
    expect(inlineJsonSchemaRefs(true)).toBe(true);
  });

  it("inlines the reported pointer and drops the definitions it no longer needs", () => {
    const input = reused();
    expect(input.properties.durableFacts.items).toEqual({
      $ref: "#/definitions/structured_response/properties/goals/items",
    });

    const out = inlineJsonSchemaRefs(input);
    expect(hasRef(out)).toBe(false);
    expect(out).not.toHaveProperty("definitions");
    expect(out.properties.durableFacts.items).toEqual(input.properties.goals.items);
    // Everything else, strict-mode keys included, is as built.
    const { definitions: _d, ...rest } = input;
    expect({ ...out, properties: { ...out.properties, durableFacts: rest.properties.durableFacts } }).toEqual(rest);
  });

  it("resolves $defs and nested $refs inside a target", () => {
    const out = inlineJsonSchemaRefs({
      type: "object",
      properties: { a: { $ref: "#/$defs/A" } },
      $defs: { A: { type: "object", properties: { b: { $ref: "#/$defs/B" } } }, B: { type: "string" } },
    });
    expect(out).toEqual({ type: "object", properties: { a: { type: "object", properties: { b: { type: "string" } } } } });
  });

  it("unescapes ~1 and ~0 in pointer segments", () => {
    const out = inlineJsonSchemaRefs({
      type: "object",
      properties: { x: { $ref: "#/$defs/a~1b" }, y: { $ref: "#/$defs/c~0d" } },
      $defs: { "a/b": { type: "string" }, "c~d": { type: "number" } },
    });
    expect(out).toEqual({ type: "object", properties: { x: { type: "string" }, y: { type: "number" } } });
  });

  it("resolves array indexes in a pointer", () => {
    const out = inlineJsonSchemaRefs({
      anyOf: [{ type: "string" }, { $ref: "#/anyOf/0" }],
    });
    expect(out).toEqual({ anyOf: [{ type: "string" }, { type: "string" }] });
  });

  it("keeps sibling keywords, merged over the inlined schema", () => {
    const out = inlineJsonSchemaRefs({
      type: "object",
      properties: { a: { $ref: "#/definitions/T", description: "local", title: "A" } },
      definitions: { T: { type: "string", description: "shared" } },
    });
    expect(out.properties.a).toEqual({ type: "string", description: "local", title: "A" });
  });

  it("inlines a root that is itself a $ref", () => {
    const out = inlineJsonSchemaRefs({ $ref: "#/definitions/R", definitions: { R: { type: "object", properties: {} } } });
    expect(out).toEqual({ type: "object", properties: {} });
  });

  it("keeps a recursive $ref and the definitions it needs, without truncating", () => {
    const input = recursive();
    expect(hasRef(input)).toBe(true);
    const out = inlineJsonSchemaRefs(input);
    // Nothing here can be inlined, so the schema is the one sent today.
    expect(out).toEqual(input);
  });

  it("inlines what it can next to a recursion and keeps only the definitions still needed", () => {
    const out = inlineJsonSchemaRefs({
      type: "object",
      properties: {
        node: { $ref: "#/definitions/Node" },
        label: { $ref: "#/definitions/Label" },
      },
      definitions: {
        Node: { type: "object", properties: { next: { $ref: "#/definitions/Node" }, tag: { $ref: "#/definitions/Tag" } } },
        Label: { type: "string" },
        Tag: { type: "number" },
        Unused: { type: "boolean" },
      },
    });
    expect(out.properties.label).toEqual({ type: "string" });
    expect(out.properties.node).toEqual({ $ref: "#/definitions/Node" });
    // Node is kept verbatim, and Tag with it because Node still points at it.
    expect(out.definitions).toEqual({
      Node: { type: "object", properties: { next: { $ref: "#/definitions/Node" }, tag: { $ref: "#/definitions/Tag" } } },
      Tag: { type: "number" },
    });
  });

  it("detects a cycle through two definitions", () => {
    const input = {
      type: "object",
      properties: { a: { $ref: "#/$defs/A" } },
      $defs: {
        A: { type: "object", properties: { b: { $ref: "#/$defs/B" } } },
        B: { type: "object", properties: { a: { $ref: "#/$defs/A" } } },
      },
    };
    expect(inlineJsonSchemaRefs(input)).toEqual(input);
  });

  it("leaves an unresolvable $ref untouched", () => {
    const out = inlineJsonSchemaRefs({
      type: "object",
      properties: {
        missing: { $ref: "#/definitions/Missing" },
        external: { $ref: "other.json#/x" },
        ok: { $ref: "#/definitions/Ok" },
      },
      definitions: { Ok: { type: "string" } },
    });
    expect(out).toEqual({
      type: "object",
      properties: {
        missing: { $ref: "#/definitions/Missing" },
        external: { $ref: "other.json#/x" },
        ok: { type: "string" },
      },
    });
  });

  it("is idempotent", () => {
    const cases = [
      reused(),
      recursive(),
      {
        type: "object",
        properties: { node: { $ref: "#/definitions/Node" }, label: { $ref: "#/definitions/Label" }, bad: { $ref: "#/nope" } },
        definitions: { Node: { properties: { next: { $ref: "#/definitions/Node" } } }, Label: { type: "string" } },
      },
    ];
    for (const input of cases) {
      const once = inlineJsonSchemaRefs(input);
      expect(inlineJsonSchemaRefs(once)).toEqual(once);
    }
  });

  it("never mutates its input", () => {
    for (const make of [reused, recursive]) {
      const input = make();
      const before = JSON.stringify(input);
      const out = inlineJsonSchemaRefs(frozen(input));
      expect(JSON.stringify(input)).toBe(before);
      expect(out).not.toBe(input);
    }
  });

  it("returns objects that share nothing with the input", () => {
    const input = reused();
    const out = inlineJsonSchemaRefs(input);
    out.properties.goals.items.properties.text.type = "number";
    expect(input.properties.goals.items.properties.text.type).toBe("string");
  });
});
