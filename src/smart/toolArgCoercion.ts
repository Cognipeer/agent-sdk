import type { ZodTypeAny } from "zod";

/**
 * Best-effort repair of tool arguments that a model produced in the right SHAPE
 * but the wrong TYPES.
 *
 * ── WHY THIS EXISTS ────────────────────────────────────────────────────────
 * Grammar-constrained and smaller open-weight backends (measured on Qwen-class
 * models behind vLLM) reliably emit tool arguments that are semantically correct
 * and syntactically wrong:
 *
 *   · a nested object arrives as a JSON *string*:
 *       `expectedResult: "{\"kind\":\"file\"}"`  → "expected object, received string"
 *   · a number arrives as a string:   `timeoutSeconds: "60"`
 *   · a boolean arrives as a string:  `replaceAll: "true"`
 *   · an optional field the backend must still emit arrives as a placeholder:
 *       `sandboxId: ""` / `"null"` / `"none"`
 *   · a single value arrives where a one-element array was wanted
 *   · every argument arrives wrapped in one envelope key: `{ "input": {...} }`
 *
 * None of these are the model misunderstanding the task. They are transport and
 * decoding artifacts, and rejecting them costs a whole turn to recover from
 * something no reasoning was needed to fix.
 *
 * ── WHERE IT RUNS ──────────────────────────────────────────────────────────
 * Strictly as a RECOVERY path: `validateToolArgs` parses the raw arguments first
 * and only calls this when that fails. A model that emits well-typed arguments
 * never touches this code, so the healthy path keeps its exact previous
 * behaviour and a schema stays a real contract rather than a suggestion.
 *
 * Coercion never invents a value. It only re-types one the model already sent,
 * or removes a placeholder standing in for an absence — so a genuinely missing
 * required argument still fails, loudly, as it should.
 */

/** Strings that carry no value: what a backend emits when it must fill a key it has nothing for. */
const PLACEHOLDER_TEXT = new Set(["", "null", "undefined", "none", "nil", "n/a", "na"]);

/** Envelope keys a model wraps the whole argument object in when it over-imitates a schema. */
const ENVELOPE_KEYS = ["input", "args", "arguments", "params", "parameters", "payload"];

type ZodDef = { typeName?: string; [key: string]: any };

function defOf(schema: unknown): ZodDef | null {
  const def = (schema as any)?._def;
  return def && typeof def === "object" ? def : null;
}

function isPlaceholder(value: unknown): boolean {
  return typeof value === "string" && PLACEHOLDER_TEXT.has(value.trim().toLowerCase());
}

function parseJsonish(value: string): { ok: true; value: unknown } | { ok: false } {
  const text = value.trim();
  if (!text.startsWith("{") && !text.startsWith("[")) return { ok: false };
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch {
    return { ok: false };
  }
}

function safeParses(schema: ZodTypeAny, value: unknown): boolean {
  try {
    return (schema as any).safeParse(value).success === true;
  } catch {
    return false;
  }
}

/**
 * Re-type `value` so it satisfies `schema`, walking both together.
 *
 * Returns the original value untouched whenever nothing needs repairing or
 * nothing sensible can be done — this must never throw, because it runs on the
 * error path and a throw here would replace a useful validation message with a
 * crash.
 */
export function coerceToolArgs(schema: unknown, value: unknown): unknown {
  try {
    return coerceNode(schema as ZodTypeAny, value, 0);
  } catch {
    return value;
  }
}

function coerceNode(schema: ZodTypeAny, value: unknown, depth: number): unknown {
  if (depth > 12) return value;
  const def = defOf(schema);
  if (!def) return value;

  switch (def.typeName) {
    case "ZodOptional":
    case "ZodNullable": {
      // A placeholder standing in for "nothing" IS nothing; anything else is a
      // real value that the inner type still has to accept.
      if (value === undefined || value === null) return value;
      if (isPlaceholder(value)) return undefined;
      return coerceNode(def.innerType, value, depth + 1);
    }

    case "ZodDefault":
    case "ZodCatch":
    case "ZodReadonly":
    case "ZodBranded":
      return coerceNode(def.innerType, value, depth + 1);

    case "ZodEffects":
      // Refinements/transforms sit on top of a real schema; repair against that.
      return coerceNode(def.schema, value, depth + 1);

    case "ZodPipeline":
      return coerceNode(def.in, value, depth + 1);

    case "ZodLazy":
      return coerceNode(def.getter(), value, depth + 1);

    case "ZodObject":
      return coerceObject(def, value, depth);

    case "ZodRecord": {
      const unwrapped = unwrapJsonString(value);
      if (!unwrapped || typeof unwrapped !== "object" || Array.isArray(unwrapped)) return unwrapped ?? value;
      const out: Record<string, unknown> = {};
      for (const [key, entry] of Object.entries(unwrapped as Record<string, unknown>)) {
        out[key] = def.valueType ? coerceNode(def.valueType, entry, depth + 1) : entry;
      }
      return out;
    }

    case "ZodArray": {
      const unwrapped = unwrapJsonString(value);
      const items = Array.isArray(unwrapped)
        ? unwrapped
        // A single value where a list was wanted: the model answered the
        // question, it just did not put brackets round the answer.
        : unwrapped === undefined || unwrapped === null
          ? unwrapped
          : [unwrapped];
      if (!Array.isArray(items)) return items;
      return items.map((item) => coerceNode(def.type, item, depth + 1));
    }

    case "ZodTuple": {
      const unwrapped = unwrapJsonString(value);
      if (!Array.isArray(unwrapped)) return unwrapped ?? value;
      const items: ZodTypeAny[] = def.items ?? [];
      return unwrapped.map((item, index) => (items[index] ? coerceNode(items[index], item, depth + 1) : item));
    }

    case "ZodNumber": {
      if (typeof value === "number") return value;
      if (typeof value === "string" && value.trim() !== "") {
        const parsed = Number(value.trim());
        if (Number.isFinite(parsed)) return parsed;
      }
      if (typeof value === "boolean") return value ? 1 : 0;
      return value;
    }

    case "ZodBoolean": {
      if (typeof value === "boolean") return value;
      if (typeof value === "string") {
        const text = value.trim().toLowerCase();
        if (text === "true" || text === "yes" || text === "1") return true;
        if (text === "false" || text === "no" || text === "0") return false;
      }
      if (value === 1) return true;
      if (value === 0) return false;
      return value;
    }

    case "ZodString": {
      if (typeof value === "string") return value;
      if (typeof value === "number" || typeof value === "boolean") return String(value);
      // A structured value where prose was wanted: keep the content rather than
      // discard the model's work.
      if (value && typeof value === "object") {
        try {
          return JSON.stringify(value);
        } catch {
          return value;
        }
      }
      return value;
    }

    case "ZodEnum": {
      if (typeof value !== "string") return value;
      const values: string[] = def.values ?? [];
      if (values.includes(value)) return value;
      const match = values.find((option) => option.toLowerCase() === value.trim().toLowerCase());
      return match ?? value;
    }

    case "ZodNativeEnum": {
      if (typeof value !== "string") return value;
      const values = Object.values(def.values ?? {}).filter((option): option is string => typeof option === "string");
      if (values.includes(value)) return value;
      return values.find((option) => option.toLowerCase() === value.trim().toLowerCase()) ?? value;
    }

    case "ZodUnion":
    case "ZodDiscriminatedUnion": {
      const options: ZodTypeAny[] = def.options
        ? (Array.isArray(def.options) ? def.options : Array.from(def.options.values()))
        : [];
      for (const option of options) {
        const candidate = coerceNode(option, value, depth + 1);
        if (safeParses(option, candidate)) return candidate;
      }
      return value;
    }

    default:
      return value;
  }
}

/** A JSON object/array that arrived as a string is the same JSON object/array. */
function unwrapJsonString(value: unknown): unknown {
  if (typeof value !== "string") return value;
  if (isPlaceholder(value)) return undefined;
  const parsed = parseJsonish(value);
  return parsed.ok ? parsed.value : value;
}

function coerceObject(def: ZodDef, value: unknown, depth: number): unknown {
  const unwrapped = unwrapJsonString(value);
  if (!unwrapped || typeof unwrapped !== "object" || Array.isArray(unwrapped)) return unwrapped ?? value;

  const shape: Record<string, ZodTypeAny> = typeof def.shape === "function" ? def.shape() : (def.shape ?? {});
  const shapeKeys = Object.keys(shape);
  let source = unwrapped as Record<string, unknown>;

  // Whole argument object wrapped in one envelope key. Only unwrap when the
  // envelope's contents look more like this schema than the envelope does,
  // so a tool that genuinely declares an `input` parameter is left alone.
  if (depth === 0 && shapeKeys.length > 0) {
    const keys = Object.keys(source);
    if (keys.length === 1 && !shapeKeys.includes(keys[0]) && ENVELOPE_KEYS.includes(keys[0].toLowerCase())) {
      const inner = unwrapJsonString(source[keys[0]]);
      if (inner && typeof inner === "object" && !Array.isArray(inner)) {
        source = inner as Record<string, unknown>;
      }
    }
  }

  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(source)) {
    const field = shape[key];
    if (!field) {
      out[key] = entry;
      continue;
    }
    const coerced = coerceNode(field, entry, depth + 1);
    // Dropping the key entirely (rather than setting undefined) is what lets an
    // optional field's placeholder disappear without tripping a strict object.
    if (coerced === undefined) continue;
    out[key] = coerced;
  }
  return out;
}
