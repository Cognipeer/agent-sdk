/**
 * sanitizeGeminiSchema: numeric enums are marked `format: "enum"`, a boolean
 * const / enum is dropped, and an `allOf` is merged instead of discarded.
 */

import { describe, it, expect } from "vitest";
import { VertexProvider } from "../../../src/providers/vertex.js";
import { sanitizeGeminiSchema } from "../../../src/providers/utils/geminiSchema.js";

const deepFreeze = <T>(o: T): T => {
  if (o && typeof o === "object") {
    for (const v of Object.values(o)) deepFreeze(v);
    Object.freeze(o);
  }
  return o;
};

describe("numeric enums carry format: enum", () => {
  it("an integer enum is marked, its values written as strings", () => {
    expect(sanitizeGeminiSchema({ type: "integer", enum: [1, 2, 3] })).toEqual({ type: "integer", format: "enum", enum: ["1", "2", "3"] });
  });

  it("an integer const becomes a one-value marked enum", () => {
    expect(sanitizeGeminiSchema({ type: "integer", const: 5 })).toEqual({ type: "integer", format: "enum", enum: ["5"] });
  });

  it("a number enum and const are marked too", () => {
    expect(sanitizeGeminiSchema({ type: "number", enum: [0.5, 1.5] })).toEqual({ type: "number", format: "enum", enum: ["0.5", "1.5"] });
    expect(sanitizeGeminiSchema({ type: "number", const: 1.5 })).toEqual({ type: "number", format: "enum", enum: ["1.5"] });
  });

  it("format: enum replaces a format such as int32 on the same node", () => {
    expect(sanitizeGeminiSchema({ type: "integer", format: "int32", enum: [1, 2] })).toEqual({ type: "integer", format: "enum", enum: ["1", "2"] });
  });

  it("a plain integer or number keeps its own format", () => {
    expect(sanitizeGeminiSchema({ type: "integer", format: "int64" })).toEqual({ type: "integer", format: "int64" });
    expect(sanitizeGeminiSchema({ type: "number", format: "double" })).toEqual({ type: "number", format: "double" });
  });

  it("other keys and nullability are kept", () => {
    expect(sanitizeGeminiSchema({ type: "integer", enum: [1, 2, null], description: "d", default: 1 })).toEqual({
      type: "integer",
      format: "enum",
      enum: ["1", "2"],
      nullable: true,
      description: "d",
      default: 1,
    });
    expect(sanitizeGeminiSchema({ type: ["integer", "null"], enum: [1, 2] })).toEqual({ type: "integer", format: "enum", enum: ["1", "2"], nullable: true });
  });

  it("is applied at every depth: properties, items and union branches", () => {
    expect(
      sanitizeGeminiSchema({
        type: "object",
        properties: {
          n: { type: "integer", const: 3 },
          list: { type: "array", items: { type: "integer", enum: [1, 2] } },
          either: { anyOf: [{ type: "number", enum: [0.5] }, { type: "string" }] },
        },
      }),
    ).toEqual({
      type: "object",
      properties: {
        n: { type: "integer", format: "enum", enum: ["3"] },
        list: { type: "array", items: { type: "integer", format: "enum", enum: ["1", "2"] } },
        either: { anyOf: [{ type: "number", format: "enum", enum: ["0.5"] }, { type: "string" }] },
      },
    });
  });

  it("string enums stay as they were: no format", () => {
    expect(sanitizeGeminiSchema({ type: "string", enum: ["a", "b"] })).toEqual({ type: "string", enum: ["a", "b"] });
    expect(sanitizeGeminiSchema({ type: "string", const: "x" })).toEqual({ type: "string", enum: ["x"] });
    expect(sanitizeGeminiSchema({ type: "string", format: "date-time" })).toEqual({ type: "string", format: "date-time" });
  });
});

describe("boolean const / enum is dropped", () => {
  it("keeps the boolean type and nothing of the value", () => {
    expect(sanitizeGeminiSchema({ type: "boolean", const: true })).toEqual({ type: "boolean" });
    expect(sanitizeGeminiSchema({ type: "boolean", const: false })).toEqual({ type: "boolean" });
    expect(sanitizeGeminiSchema({ type: "boolean", enum: [true, false] })).toEqual({ type: "boolean" });
  });

  it("keeps the description and the other keys", () => {
    expect(sanitizeGeminiSchema({ type: "boolean", const: true, description: "flag", default: true })).toEqual({
      type: "boolean",
      description: "flag",
      default: true,
    });
  });

  it("a nullable boolean stays nullable", () => {
    expect(sanitizeGeminiSchema({ type: ["boolean", "null"], const: true })).toEqual({ type: "boolean", nullable: true });
  });

  it("a const / enum with no type, made of booleans, becomes a boolean", () => {
    expect(sanitizeGeminiSchema({ const: false })).toEqual({ type: "boolean" });
    expect(sanitizeGeminiSchema({ enum: [true, false] })).toEqual({ type: "boolean" });
  });

  it("reaches properties", () => {
    expect(sanitizeGeminiSchema({ type: "object", properties: { on: { type: "boolean", const: true } }, required: ["on"] })).toEqual({
      type: "object",
      properties: { on: { type: "boolean" } },
      required: ["on"],
    });
  });

  it("a typeless enum that is not all booleans keeps its string values", () => {
    expect(sanitizeGeminiSchema({ enum: ["a", "b"] })).toEqual({ enum: ["a", "b"] });
    expect(sanitizeGeminiSchema({ enum: [1, "a"] })).toEqual({ enum: ["1", "a"] });
  });
});

describe("allOf is merged", () => {
  it("two object members: properties joined, required lists concatenated without duplicates", () => {
    const out = sanitizeGeminiSchema({
      allOf: [
        { type: "object", properties: { a: { type: "string" } }, required: ["a"] },
        { type: "object", properties: { b: { type: "integer" } }, required: ["b", "a"] },
      ],
    });
    expect(out).toEqual({
      type: "object",
      properties: { a: { type: "string" }, b: { type: "integer" } },
      required: ["a", "b"],
    });
  });

  it("three members merge the same way", () => {
    expect(
      sanitizeGeminiSchema({
        allOf: [
          { type: "object", properties: { a: { type: "string" } }, required: ["a"] },
          { type: "object", properties: { b: { type: "string" } }, required: ["b"] },
          { type: "object", properties: { c: { type: "string" } }, required: ["c", "a"] },
        ],
      }),
    ).toEqual({
      type: "object",
      properties: { a: { type: "string" }, b: { type: "string" }, c: { type: "string" } },
      required: ["a", "b", "c"],
    });
  });

  it("the later member wins a key both set; the node's own keys win over all members", () => {
    expect(
      sanitizeGeminiSchema({
        allOf: [
          { type: "object", description: "first", properties: { a: { type: "string", description: "A1" } } },
          { type: "object", description: "second", properties: { a: { type: "string", description: "A2" }, b: { type: "string" } } },
        ],
      }),
    ).toEqual({
      type: "object",
      description: "second",
      properties: { a: { type: "string", description: "A2" }, b: { type: "string" } },
    });

    expect(
      sanitizeGeminiSchema({
        description: "outer",
        allOf: [
          { type: "object", description: "first", properties: { a: { type: "string" } }, required: ["a"] },
          { type: "object", description: "second", properties: { b: { type: "string" } } },
        ],
      }),
    ).toEqual({
      type: "object",
      description: "outer",
      properties: { a: { type: "string" }, b: { type: "string" } },
      required: ["a"],
    });
  });

  it("the node's own properties and required list join the members'", () => {
    expect(
      sanitizeGeminiSchema({
        type: "object",
        properties: { c: { type: "string" } },
        required: ["c"],
        allOf: [
          { type: "object", properties: { a: { type: "string" } }, required: ["a"] },
          { type: "object", properties: { b: { type: "string" } }, required: ["b"] },
        ],
      }),
    ).toEqual({
      type: "object",
      properties: { a: { type: "string" }, b: { type: "string" }, c: { type: "string" } },
      required: ["a", "b", "c"],
    });
  });

  it("a property both members define has to satisfy both", () => {
    expect(
      sanitizeGeminiSchema({
        allOf: [
          { type: "object", properties: { p: { type: "object", properties: { x: { type: "string" } }, required: ["x"] } } },
          { type: "object", properties: { p: { type: "object", properties: { y: { type: "string" } }, required: ["y"] } } },
        ],
      }),
    ).toEqual({
      type: "object",
      properties: { p: { type: "object", properties: { x: { type: "string" }, y: { type: "string" } }, required: ["x", "y"] } },
    });
  });

  it("a property named like an Object.prototype member is a property, not a collision", () => {
    expect(
      sanitizeGeminiSchema({
        allOf: [
          { type: "object", properties: { constructor: { type: "string" } } },
          { type: "object", properties: { constructor: { type: "string", description: "x" }, toString: { type: "string" } } },
        ],
      }),
    ).toEqual({
      type: "object",
      properties: { constructor: { type: "string", description: "x" }, toString: { type: "string" } },
    });
  });

  it("array members merge their items too", () => {
    expect(
      sanitizeGeminiSchema({
        allOf: [
          { type: "array", items: { type: "object", properties: { a: { type: "string" } } } },
          { type: "array", items: { type: "object", properties: { b: { type: "string" } } } },
        ],
      }),
    ).toEqual({ type: "array", items: { type: "object", properties: { a: { type: "string" }, b: { type: "string" } } } });
  });

  it("members are merged after their $ref pointers are inlined", () => {
    expect(
      sanitizeGeminiSchema({
        $defs: { Base: { type: "object", properties: { id: { type: "string" } }, required: ["id"] } },
        allOf: [{ $ref: "#/$defs/Base" }, { type: "object", properties: { name: { type: "string" } }, required: ["name"] }],
      }),
    ).toEqual({
      type: "object",
      properties: { id: { type: "string" }, name: { type: "string" } },
      required: ["id", "name"],
    });
  });

  it("a nullable member makes the result nullable", () => {
    expect(
      sanitizeGeminiSchema({
        allOf: [
          { type: "object", nullable: true, properties: { a: { type: "string" } } },
          { type: "object", properties: { b: { type: "string" } } },
        ],
      }),
    ).toEqual({ type: "object", nullable: true, properties: { a: { type: "string" }, b: { type: "string" } } });
  });

  it("a member without a type joins the one that has it", () => {
    expect(sanitizeGeminiSchema({ allOf: [{ description: "just text" }, { type: "object", properties: { a: { type: "string" } } }] })).toEqual({
      type: "object",
      description: "just text",
      properties: { a: { type: "string" } },
    });
  });

  it("a member that says nothing is skipped", () => {
    expect(sanitizeGeminiSchema({ allOf: [true, { type: "string" }] })).toEqual({ type: "string" });
  });

  it("a member that is a union stays an anyOf next to the merged object", () => {
    expect(
      sanitizeGeminiSchema({
        allOf: [
          { type: "object", properties: { a: { type: "string" } }, required: ["a"] },
          { anyOf: [{ type: "object", properties: { b: { type: "string" } } }, { type: "object", properties: { c: { type: "string" } } }] },
        ],
      }),
    ).toEqual({
      type: "object",
      properties: { a: { type: "string" } },
      required: ["a"],
      anyOf: [
        { type: "object", properties: { b: { type: "string" } } },
        { type: "object", properties: { c: { type: "string" } } },
      ],
    });
  });

  it("members that cannot be merged (different types) are sent as anyOf, none is dropped", () => {
    expect(
      sanitizeGeminiSchema({
        allOf: [
          { type: "string", description: "s" },
          { type: "integer", description: "i" },
        ],
      }),
    ).toEqual({ anyOf: [{ type: "string", description: "s" }, { type: "integer", description: "i" }] });
  });

  it("two unions cannot share one anyOf: they become alternatives", () => {
    expect(
      sanitizeGeminiSchema({
        allOf: [
          { anyOf: [{ type: "string" }, { type: "integer" }] },
          { anyOf: [{ type: "number" }, { type: "boolean" }] },
        ],
      }),
    ).toEqual({
      anyOf: [
        { anyOf: [{ type: "string" }, { type: "integer" }] },
        { anyOf: [{ type: "number" }, { type: "boolean" }] },
      ],
    });
  });

  it("a one-member allOf still merges into the node", () => {
    expect(sanitizeGeminiSchema({ description: "outer", allOf: [{ type: "object", properties: { a: { type: "string" } } }] })).toEqual({
      type: "object",
      description: "outer",
      properties: { a: { type: "string" } },
    });
  });

  it("reaches allOf nested in properties, items and unions", () => {
    const pair = [
      { type: "object", properties: { a: { type: "string" } }, required: ["a"] },
      { type: "object", properties: { b: { type: "number" } }, required: ["b"] },
    ];
    const merged = { type: "object", properties: { a: { type: "string" }, b: { type: "number" } }, required: ["a", "b"] };
    expect(sanitizeGeminiSchema({ type: "object", properties: { item: { allOf: pair } } })).toEqual({ type: "object", properties: { item: merged } });
    expect(sanitizeGeminiSchema({ type: "array", items: { allOf: pair } })).toEqual({ type: "array", items: merged });
    expect(sanitizeGeminiSchema({ anyOf: [{ allOf: pair }, { type: "null" }] })).toEqual({ ...merged, nullable: true });
  });

  it("is never an empty schema for members that say something, and drops the keywords Gemini does not know", () => {
    const out: any = sanitizeGeminiSchema({
      $schema: "http://json-schema.org/draft-07/schema#",
      type: "object",
      additionalProperties: false,
      properties: {
        x: {
          allOf: [
            { type: "object", properties: { id: { type: "string" } }, required: ["id"], additionalProperties: false },
            { type: "object", properties: { n: { type: "number" } }, required: ["n"], additionalProperties: false },
          ],
        },
      },
      required: ["x"],
    });
    expect(out).toEqual({
      type: "object",
      properties: { x: { type: "object", properties: { id: { type: "string" }, n: { type: "number" } }, required: ["id", "n"] } },
      required: ["x"],
    });
    expect(Object.keys(out.properties.x).length).toBeGreaterThan(0);
  });

  it("numeric enums and boolean consts inside merged members get the same treatment", () => {
    expect(
      sanitizeGeminiSchema({
        description: "outer",
        allOf: [
          { type: "object", properties: { a: { type: "integer", enum: [1, 2] } }, required: ["a"] },
          { type: "object", properties: { b: { type: "boolean", const: true } }, required: ["b"] },
        ],
      }),
    ).toEqual({
      type: "object",
      description: "outer",
      properties: { a: { type: "integer", format: "enum", enum: ["1", "2"] }, b: { type: "boolean" } },
      required: ["a", "b"],
    });
  });

  it("never mutates its input, and is idempotent", () => {
    const input = deepFreeze({
      description: "outer",
      allOf: [
        { type: "object", properties: { a: { type: "integer", enum: [1, 2] } }, required: ["a"] },
        { type: "object", properties: { a: { type: "integer" }, b: { type: "boolean", const: true } }, required: ["b", "a"] },
      ],
    });
    const snapshot = structuredClone(input);
    const once = sanitizeGeminiSchema(input);
    expect(input).toEqual(snapshot);
    expect(sanitizeGeminiSchema(once)).toEqual(once);
    // The merged lists are new arrays, not the input's.
    expect((once as any).required).not.toBe((input as any).allOf[0].required);
  });
});

describe("Vertex request body: enum and allOf schemas", () => {
  const parameters = {
    type: "object",
    properties: {
      level: { type: "integer", enum: [1, 2, 3] },
      on: { type: "boolean", const: true },
      who: { allOf: [{ type: "object", properties: { id: { type: "string" } }, required: ["id"] }, { type: "object", properties: { n: { type: "number" } }, required: ["n"] }] },
    },
    required: ["level"],
  };
  const clean = {
    type: "object",
    properties: {
      level: { type: "integer", format: "enum", enum: ["1", "2", "3"] },
      on: { type: "boolean" },
      who: { type: "object", properties: { id: { type: "string" }, n: { type: "number" } }, required: ["id", "n"] },
    },
    required: ["level"],
  };

  function send(request: Record<string, any>) {
    const bodies: any[] = [];
    const fn = (async (_url: any, init: any) => {
      bodies.push(JSON.parse(init.body));
      return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: "ok" }] }, finishReason: "STOP" }], usageMetadata: {} }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch;
    const provider = new VertexProvider({ provider: "vertex", projectId: "proj", accessToken: "tok", fetch: fn } as any);
    return provider.complete({ model: "gemini-2.0-flash", messages: [{ role: "user", content: "hi" }], ...request } as any).then(() => bodies[0]);
  }

  it("function declaration parameters", async () => {
    const body = await send({ tools: [{ name: "set_level", description: "d", parameters }] });
    expect(body.tools[0].functionDeclarations[0].parameters).toEqual(clean);
  });

  it("the structured-output responseSchema", async () => {
    const body = await send({ responseFormat: { type: "json_schema", schema: parameters } });
    expect(body.generationConfig.responseSchema).toEqual(clean);
  });
});
