// Inlines in-document `$ref`s for the Responses API's `text.format.schema`.
//
// zod-to-json-schema (`$refStrategy: "root"`) references a reused sub-schema by
// a pointer into the middle of the document, e.g.
// `#/definitions/structured_response/properties/goals/items`. Chat Completions
// accepts that; the Responses validator rejects it with
// "reference to component '…' which was not found in the schema". Inlining the
// reference is the same schema without the pointer.

type Json = Record<string, any>;

const DEFINITION_KEYS = ["definitions", "$defs"] as const;

/**
 * Returns `schema` with every resolvable, non-recursive in-document `$ref`
 * replaced by the schema it points to, and `definitions` / `$defs` entries
 * dropped once nothing references them.
 *
 *  - No `$ref` anywhere: the input object itself is returned (`===`).
 *  - The input is never mutated; rewriting happens on a clone.
 *  - Sibling keywords next to a `$ref` are kept, merged over the inlined schema.
 *  - A `$ref` whose target can reach itself (recursion) is kept as it is, with
 *    the definition entries it still needs, kept verbatim. Nothing is truncated.
 *  - A `$ref` that does not resolve inside the document is left untouched.
 *  - Idempotent.
 */
export function inlineJsonSchemaRefs<T>(schema: T): T {
  if (!isObject(schema) || !containsRef(schema)) return schema;

  const root: Json = structuredClone(schema) as Json;
  const selfReaching = new Map<Json, boolean>();

  const targetOf = (ref: string): Json | undefined => {
    const target = resolvePointer(root, ref);
    return isObject(target) ? target : undefined;
  };

  /** True when following refs from inside `target` leads back to `target`. */
  const reachesItself = (target: Json): boolean => {
    const known = selfReaching.get(target);
    if (known !== undefined) return known;
    const seen = new Set<Json>();
    const walk = (node: unknown): boolean => {
      if (Array.isArray(node)) return node.some(walk);
      if (!isObject(node)) return false;
      if (typeof node.$ref === "string") {
        const next = targetOf(node.$ref);
        if (next === target) return true;
        if (next && !seen.has(next)) {
          seen.add(next);
          if (walk(next)) return true;
        }
      }
      return Object.entries(node).some(([key, value]) => key !== "$ref" && walk(value));
    };
    const result = walk(target);
    selfReaching.set(target, result);
    return result;
  };

  /** Refs left in place, for deciding which definitions are still needed. */
  const keptRefs = new Set<string>();

  const expand = (node: unknown): unknown => {
    if (Array.isArray(node)) return node.map(expand);
    if (!isObject(node)) return node;

    if (typeof node.$ref === "string") {
      const target = targetOf(node.$ref);
      if (target && !reachesItself(target)) {
        const { $ref: _inlined, ...siblings } = node;
        return { ...(expand(target) as Json), ...expandEntries(siblings) };
      }
      keptRefs.add(node.$ref);
      // Unresolved or recursive: the node stays, its siblings are still walked.
      return expandEntries(node);
    }
    return expandEntries(node);
  };

  const expandEntries = (node: Json): Json => {
    const out: Json = {};
    for (const [key, value] of Object.entries(node)) out[key] = key === "$ref" ? value : expand(value);
    return out;
  };

  // The root's definition blocks are not walked as schema: they are either
  // dropped or kept verbatim below, so a kept `$ref` still resolves to exactly
  // what it resolved to before.
  const { definitions: _definitions, $defs: _defs, ...rootBody } = root;
  // A root that is itself a reference is resolved like any other node.
  const result: Json = typeof root.$ref === "string" ? (expand(rootBody) as Json) : expandEntries(rootBody);
  for (const key of DEFINITION_KEYS) delete result[key];

  for (const key of DEFINITION_KEYS) {
    const block = root[key];
    if (!isObject(block)) continue;
    const needed = neededEntries(key, block, keptRefs);
    if (needed.length === 0) continue;
    const kept: Json = {};
    for (const name of Object.keys(block)) if (needed.includes(name)) kept[name] = block[name];
    result[key] = kept;
  }
  return result as T;
}

/** Names in `block` (the root's `key` block) that a kept ref still needs,
 * following refs inside the kept entries until nothing new is added. */
function neededEntries(key: string, block: Json, keptRefs: Set<string>): string[] {
  const needed: string[] = [];
  const queue = [...keptRefs];
  while (queue.length > 0) {
    const ref = queue.shift()!;
    const segments = pointerSegments(ref);
    if (!segments || segments[0] !== key || segments.length < 2) continue;
    const name = segments[1];
    if (needed.includes(name) || !(name in block)) continue;
    needed.push(name);
    collectRefs(block[name], queue);
  }
  return needed;
}

function collectRefs(node: unknown, into: string[]): void {
  if (Array.isArray(node)) {
    node.forEach((child) => collectRefs(child, into));
    return;
  }
  if (!isObject(node)) return;
  if (typeof node.$ref === "string") into.push(node.$ref);
  for (const [k, value] of Object.entries(node)) if (k !== "$ref") collectRefs(value, into);
}

function containsRef(node: unknown): boolean {
  if (Array.isArray(node)) return node.some(containsRef);
  if (!isObject(node)) return false;
  if (typeof node.$ref === "string") return true;
  return Object.values(node).some(containsRef);
}

/** `#` or `#/a/b` → segments (`~1` → `/`, `~0` → `~`); anything else → null. */
function pointerSegments(ref: string): string[] | null {
  if (ref === "#") return [];
  if (!ref.startsWith("#/")) return null;
  return ref
    .slice(2)
    .split("/")
    .map((segment) => segment.replace(/~1/g, "/").replace(/~0/g, "~"));
}

function resolvePointer(document: Json, ref: string): unknown {
  const segments = pointerSegments(ref);
  if (!segments) return undefined;
  let current: unknown = document;
  for (const segment of segments) {
    if (Array.isArray(current)) {
      if (!/^\d+$/.test(segment)) return undefined;
      current = current[Number(segment)];
    } else if (isObject(current) && Object.prototype.hasOwnProperty.call(current, segment)) {
      current = current[segment];
    } else {
      return undefined;
    }
  }
  return current;
}

function isObject(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
