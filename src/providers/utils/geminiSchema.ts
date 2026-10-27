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
 *  - `const` becomes a one-value `enum` (Gemini enums hold strings, so values are
 *    written as their string form). On an `integer` / `number` node the enum is
 *    marked with `format: "enum"`, which is how the reference says to mark one
 *    (its integer example is `{type: INTEGER, format: enum, enum: ["101", ...]}`);
 *    that replaces a `format` such as `int32` there. A boolean `const` / `enum` has
 *    no enum form and is dropped: the `boolean` type says all there is to say.
 *  - `type: ["string", "null"]`, `anyOf` / `oneOf` branches of `{ type: "null" }`
 *    and `null` enum members become the type plus `nullable: true`. A union that
 *    is left with one branch collapses into it; `oneOf` is sent as `anyOf`.
 *  - `allOf` (`z.intersection`, inheritance) members are merged into one schema:
 *    properties are joined, `required` lists concatenated and de-duplicated, later
 *    members and the node's own keys win. Members that cannot be merged (a
 *    different `type`, or two unions) are sent as `anyOf` alternatives, so no
 *    member is dropped.
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

  // Every `allOf` member has to hold, which the Schema cannot say: they are merged
  // (the node's own keys win over the members'), never dropped.
  if (Array.isArray(node.allOf) && node.allOf.length > 0) {
    const { allOf, ...rest } = node;
    const members = combine(allOf.map((member: unknown) => convert(member)));
    const own = convert(rest);
    return members.anyOf && own.anyOf ? combine([members, own]) : mergeTwo(members, own);
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
  let values: unknown[] = [];
  if (Array.isArray(node.enum)) {
    if (node.enum.includes(null)) nullable = true;
    values = node.enum.filter((v: unknown) => v !== null && typeof v !== "object");
  } else if ("const" in node) {
    const v = node.const;
    if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") values = [v];
  }
  if (values.length > 0) {
    if (out.type === "boolean" || (out.type === undefined && !typeBranches && values.every((v) => typeof v === "boolean"))) {
      // No enum form for a boolean: the type is all that is left to say.
      out.type = "boolean";
    } else {
      out.enum = values.map(String);
      // Vertex: "To mark a field as an enum, set format to enum" (integer example included).
      if (out.type === "integer" || out.type === "number") out.format = "enum";
    }
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

/**
 * Schemas that all have to hold, as one. The first that says anything anchors the
 * result; each later one is merged into it when the two fit together (see
 * `canMerge`) and kept as an `anyOf` alternative when not. Empty schemas (`true`,
 * `{}`) say nothing and are skipped; with nothing left the result is `{}`.
 */
function combine(parts: Json[]): Json {
  let merged: Json | undefined;
  const alternatives: Json[] = [];
  for (const part of parts) {
    if (Object.keys(part).length === 0) continue;
    if (!merged) merged = part;
    else if (canMerge(merged, part)) merged = mergeTwo(merged, part);
    else alternatives.push(part);
  }
  if (alternatives.length === 0) return merged ?? {};
  return { anyOf: merged ? [merged, ...alternatives] : alternatives };
}

/** Two converted schemas fit together unless their types differ or both are unions (one `anyOf` cannot hold two). */
function canMerge(a: Json, b: Json): boolean {
  if (a.anyOf && b.anyOf) return false;
  return a.type === undefined || b.type === undefined || a.type === b.type;
}

/** `b` merged over `a` (converted schemas): `b`'s keys win, but properties and `required` lists are joined. */
function mergeTwo(a: Json, b: Json): Json {
  const out: Json = { ...a, ...b };
  if (isObject(a.properties) && isObject(b.properties)) {
    const properties: Json = { ...a.properties };
    for (const [name, child] of Object.entries<Json>(b.properties)) {
      // A property both define has to satisfy both definitions.
      properties[name] = Object.prototype.hasOwnProperty.call(properties, name) ? combine([properties[name], child]) : child;
    }
    out.properties = properties;
  }
  for (const key of ["required", "propertyOrdering"] as const) {
    if (Array.isArray(a[key]) && Array.isArray(b[key])) out[key] = [...new Set([...a[key], ...b[key]])];
  }
  if (isObject(a.items) && isObject(b.items)) out.items = combine([a.items, b.items]);
  if (a.nullable === true || b.nullable === true) out.nullable = true;
  return out;
}

function clone<T>(value: T): T {
  return typeof value === "object" && value !== null ? structuredClone(value) : value;
}

function isObject(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
