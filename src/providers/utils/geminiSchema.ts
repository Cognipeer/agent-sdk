// Turns a JSON Schema into what the Vertex AI / Gemini `Schema` object accepts.
//
// The `Schema` message is "a subset of the OpenAPI 3.0 Schema Object"
// (cloud.google.com Agent Platform REST reference, `Schema`). Zod / hand-written
// JSON Schema carries keywords it does not have (`$schema`, `$id`,
// `additionalProperties`, `const`, `examples`, `type: ["string", "null"]`,
// `oneOf`, `$ref` / `definitions`, ...). Sent as they are, a strict endpoint
// answers 400 "Unknown name ...". This module rewrites such a schema into the
// supported subset; it is used for function declaration `parameters` and for the
// structured-output `responseSchema`.

import { inlineJsonSchemaRefs } from "./jsonSchemaRefs.js";

type Json = Record<string, any>;

/** Keys copied over as they are (their values are plain data, not sub-schemas). */
const SCALAR_KEYS = [
  "format",
  "title",
  "description",
  "default",
  "example",
  "minItems",
  "maxItems",
  "minProperties",
  "maxProperties",
  "minimum",
  "maximum",
  "minLength",
  "maxLength",
  "pattern",
  "propertyOrdering",
  "required",
] as const;

/**
 * Returns a copy of `schema` that only uses what the Gemini `Schema` object
 * lists: type, format, title, description, nullable, default, items, minItems,
 * maxItems, enum, properties, propertyOrdering, required, minProperties,
 * maxProperties, minimum, maximum, minLength, maxLength, pattern, example, anyOf.
 *
 *  - In-document `$ref` / `$defs` / `definitions` are inlined first. A reference
 *    that cannot be inlined (recursive, or pointing outside the document) becomes
 *    a bare `{ type: "object" }` that keeps its `description`.
 *  - Keys the Schema object does not know are dropped: `$schema`, `$id`,
 *    `additionalProperties`, `examples`, `exclusiveMinimum`, `not`, ...
 *  - `const` becomes a one-value `enum` (Gemini enums hold strings; numbers and
 *    booleans are written as their string form). Enum values are stringified.
 *  - `type: ["string", "null"]`, `anyOf` / `oneOf` branches of `{ type: "null" }`
 *    and `null` enum members become the type plus `nullable: true`. A union that
 *    is left with one branch collapses into it; `oneOf` is sent as `anyOf`;
 *    a one-element `allOf` is merged into its parent.
 *  - Recursive; the input is never mutated. Non-object input is returned as is.
 */
export function sanitizeGeminiSchema<T = Json>(schema: T): T {
  if (!isObject(schema)) return schema;
  return convert(inlineJsonSchemaRefs(schema)) as T;
}

function convert(node: unknown): Json {
  // A boolean schema (`true` / `false`) has no Schema equivalent.
  if (!isObject(node)) return {};

  // Only a reference that inlining left in place reaches this point.
  if (typeof node.$ref === "string") {
    return { type: "object", ...(typeof node.description === "string" ? { description: node.description } : {}) };
  }

  if (Array.isArray(node.allOf) && node.allOf.length === 1 && isObject(node.allOf[0])) {
    const { allOf, ...rest } = node;
    return convert({ ...allOf[0], ...rest });
  }

  const out: Json = {};
  let nullable = node.nullable === true;
  let typeBranches: Json[] | undefined;

  if (typeof node.type === "string") {
    out.type = node.type;
  } else if (Array.isArray(node.type)) {
    const names = node.type.filter((t: unknown): t is string => typeof t === "string");
    const real = names.filter((t: string) => t !== "null");
    if (real.length < names.length) nullable = true;
    if (real.length === 1) out.type = real[0];
    else if (real.length > 1) typeBranches = real.map((t: string) => ({ type: t }));
    else if (names.length > 0) out.type = "null";
  }

  for (const key of SCALAR_KEYS) {
    if (key in node && node[key] !== undefined) out[key] = clone(node[key]);
  }

  // enum / const
  if (Array.isArray(node.enum)) {
    if (node.enum.includes(null)) nullable = true;
    const values = node.enum.filter((v: unknown) => v !== null && typeof v !== "object").map(String);
    if (values.length > 0) out.enum = values;
  } else if ("const" in node) {
    const v = node.const;
    if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") out.enum = [String(v)];
  }

  if (isObject(node.properties)) {
    const properties: Json = {};
    for (const [name, child] of Object.entries(node.properties)) properties[name] = convert(child);
    out.properties = properties;
  }

  if (isObject(node.items)) {
    out.items = convert(node.items);
  } else if (Array.isArray(node.items) && node.items.length > 0) {
    // Tuple form: Gemini has one `items` schema, so the positions become a union.
    const branches = node.items.map(convert);
    out.items = branches.length === 1 ? branches[0] : { anyOf: branches };
  }

  // Unions: `anyOf` (or `oneOf`, sent as `anyOf`), plus a multi-type array.
  const union: unknown[] | undefined = Array.isArray(node.anyOf) ? node.anyOf : Array.isArray(node.oneOf) ? node.oneOf : undefined;
  let branches: Json[] = [];
  if (union) {
    for (const member of union) {
      if (isNullSchema(member)) nullable = true;
      else branches.push(convert(member));
    }
  }
  if (typeBranches) branches = [...typeBranches, ...branches];

  if (branches.length === 1) {
    // A single remaining branch: the node itself wins over it where both speak.
    const [only] = branches;
    const merged = { ...only, ...out };
    if (nullable) merged.nullable = true;
    return merged;
  }
  if (branches.length > 1) out.anyOf = branches;

  if (nullable) out.nullable = true;
  return out;
}

function isNullSchema(node: unknown): boolean {
  return isObject(node) && node.type === "null" && !("enum" in node) && !("anyOf" in node);
}

function clone<T>(value: T): T {
  return typeof value === "object" && value !== null ? structuredClone(value) : value;
}

function isObject(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
