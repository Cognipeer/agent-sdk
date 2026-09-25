/**
 * Makes tool argument schemas acceptable to a provider's STRICT tool mode.
 *
 * OpenAI strict mode (`strict: true` on a function tool) has three rules that
 * ordinary tool schemas break:
 *
 *  1. every property must be listed in `required` — there are no optional
 *     arguments, so a tool with an optional `offset` makes the provider reject
 *     the WHOLE request (`400 Invalid schema for function … Missing 'offset'`);
 *  2. every object must be closed (`additionalProperties: false`), including
 *     each branch of a union — `manage_plan`'s `todoList` union failed here;
 *  3. there is no free-form object — `body: { type: object }` with no
 *     properties has no strict form at all.
 *
 * The transform keeps the tool's MEANING and changes only its wire form:
 *
 *  - an optional argument becomes required-but-nullable (the model sends
 *    `null` for "not given"), and `restore` drops those nulls again before the
 *    tool runs — the executor sees exactly the arguments it always saw;
 *  - objects (and union branches) are closed;
 *  - a free-form object/record/any becomes a JSON-encoded STRING, which
 *    `restore` parses back into the value the executor expects.
 *
 * `prepareStrictToolMenu` applies it at the one point every tool — the
 * caller's and the SDK's own (manage_plan, open_skill, spawn_subagent, …) —
 * passes through on its way to the provider, and `restoreToolCalls` maps the
 * model's strict-shaped arguments back before they are validated and run.
 */

import { z, type ZodTypeAny } from "zod";

export interface StrictTransform {
  schema: ZodTypeAny;
  /** Maps the model's strict-shaped arguments back to what the tool expects. */
  restore: (value: unknown) => unknown;
}

export type StrictRestorers = Map<string, StrictTransform["restore"]>;

const identity = (value: unknown) => value;

type AnyDef = any;

function describeLike<T extends ZodTypeAny>(schema: T, source: ZodTypeAny, suffix?: string): T {
  const description = [source.description, suffix].filter(Boolean).join(" ");
  return description ? (schema.describe(description) as T) : schema;
}

/** A value the schema cannot close: encoded as JSON text, decoded on the way in. */
function jsonString(source: ZodTypeAny): StrictTransform {
  return {
    schema: describeLike(z.string(), source, "(a JSON value, encoded as a string)"),
    restore: (value) => {
      if (typeof value !== "string") return value;
      try {
        return JSON.parse(value);
      } catch {
        return value;
      }
    },
  };
}

function unwrapOptional(schema: ZodTypeAny): { inner: ZodTypeAny; optional: boolean } {
  const def = schema._def as AnyDef;
  if (def?.typeName === "ZodOptional") return { inner: def.innerType, optional: true };
  if (def?.typeName === "ZodDefault") return { inner: def.innerType, optional: true };
  return { inner: schema, optional: false };
}

export function isZodSchema(schema: unknown): schema is ZodTypeAny {
  return Boolean(schema) && typeof (schema as { safeParse?: unknown }).safeParse === "function"
    && Boolean((schema as { _def?: unknown })._def);
}

export function toStrictCompatible(schema: ZodTypeAny): StrictTransform {
  const def = schema?._def as AnyDef;
  switch (def?.typeName) {
    case "ZodObject": {
      const shape = typeof def.shape === "function" ? def.shape() : def.shape;
      const keys = Object.keys(shape ?? {});
      const open = def.unknownKeys === "passthrough"
        || (def.catchall && def.catchall._def?.typeName !== "ZodNever");
      // No declared properties and open to anything: there is no strict way
      // to say that, so it travels as JSON text.
      if (keys.length === 0 && open) return jsonString(schema);

      const nextShape: Record<string, ZodTypeAny> = {};
      const restores: Record<string, { restore: StrictTransform["restore"]; optional: boolean }> = {};
      for (const key of keys) {
        const field = shape[key] as ZodTypeAny;
        const { inner, optional } = unwrapOptional(field);
        const child = toStrictCompatible(inner);
        const childSchema = describeLike(child.schema, field.description ? field : inner);
        nextShape[key] = optional ? childSchema.nullable() : childSchema;
        restores[key] = { restore: child.restore, optional };
      }
      return {
        schema: describeLike(z.object(nextShape), schema),
        restore: (value) => {
          if (!value || typeof value !== "object" || Array.isArray(value)) return value;
          const out: Record<string, unknown> = {};
          for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
            const entry = restores[key];
            // `null` for an optional argument means "not given": omit it, so
            // a tool that checks `=== undefined` or builds a query string
            // never sees a literal null.
            if (raw === null && entry?.optional) continue;
            out[key] = entry ? entry.restore(raw) : raw;
          }
          return out;
        },
      };
    }
    case "ZodOptional":
    case "ZodDefault": {
      const child = toStrictCompatible(def.innerType);
      return {
        schema: describeLike(child.schema.nullable(), schema),
        restore: (value) => (value === null ? undefined : child.restore(value)),
      };
    }
    case "ZodNullable": {
      const child = toStrictCompatible(def.innerType);
      return {
        schema: describeLike(child.schema.nullable(), schema),
        restore: (value) => (value === null ? null : child.restore(value)),
      };
    }
    case "ZodArray": {
      const child = toStrictCompatible(def.type);
      return {
        schema: describeLike(z.array(child.schema), schema),
        restore: (value) => (Array.isArray(value) ? value.map(child.restore) : value),
      };
    }
    case "ZodUnion":
    case "ZodDiscriminatedUnion": {
      const rawOptions: ZodTypeAny[] = def.options instanceof Map ? [...def.options.values()] : def.options;
      const options = rawOptions.map(toStrictCompatible);
      if (options.length === 1) return options[0];
      if (options.every((option, index) => option.schema === rawOptions[index])) {
        return { schema, restore: identity };
      }
      return {
        schema: describeLike(z.union(options.map((option) => option.schema) as [ZodTypeAny, ZodTypeAny, ...ZodTypeAny[]]), schema),
        restore: (value) => {
          // The model's value names no branch: the first branch whose
          // restored value its ORIGINAL schema accepts wins (a "not given"
          // null is only droppable where that branch has it optional).
          const candidates = options.map((option) => option.restore(value));
          const index = candidates.findIndex((candidate, i) => rawOptions[i].safeParse(candidate).success);
          return candidates[index >= 0 ? index : 0];
        },
      };
    }
    case "ZodEffects":
      return toStrictCompatible(def.schema);
    case "ZodRecord":
    case "ZodAny":
    case "ZodUnknown":
      return jsonString(schema);
    default:
      // Primitives, enums, literals: already strict.
      return { schema, restore: identity };
  }
}

/**
 * A tool's arguments must be an OBJECT schema. A top-level non-object (a
 * free-form tool whose contract is unknown turns into a JSON string) is
 * carried as an explicit required `input` field instead, and unwrapped back
 * into the object the tool expects.
 */
function topLevelObject(transform: StrictTransform): StrictTransform {
  if ((transform.schema._def as AnyDef)?.typeName === "ZodObject") return transform;
  return {
    schema: z.object({
      input: transform.schema.describe(
        transform.schema.description ?? "The tool arguments as a JSON object, encoded as a string",
      ),
    }),
    restore: (value) => {
      const input = value && typeof value === "object" ? (value as { input?: unknown }).input : undefined;
      const restored = transform.restore(input);
      return restored && typeof restored === "object" ? restored : {};
    },
  };
}

/** The strict transform of one tool's argument schema, top level included. */
export function toStrictToolSchema(schema: ZodTypeAny): StrictTransform {
  return topLevelObject(toStrictCompatible(schema));
}

/**
 * Restores one model message's tool-call arguments to the tools' ORIGINAL
 * shape: the "not given" nulls dropped, JSON-encoded free-form values decoded.
 * Handles the SDK/LangChain form (`args` object), the raw OpenAI form
 * (`function.arguments` string) and `additional_kwargs.tool_calls`.
 */
export function restoreToolCalls<M>(message: M, restorers: StrictRestorers): M {
  if (!message || typeof message !== "object" || restorers.size === 0) return message;
  const restoreList = (calls: unknown): unknown => {
    if (!Array.isArray(calls) || calls.length === 0) return calls;
    return calls.map((call: Record<string, unknown>) => {
      const fn = call?.function as { name?: string; arguments?: unknown } | undefined;
      const name = (call?.name as string | undefined) ?? fn?.name;
      const restore = name ? restorers.get(name) : undefined;
      if (!restore) return call;
      let next: Record<string, unknown> = call;
      if (call.args && typeof call.args === "object") next = { ...next, args: restore(call.args) };
      if (fn && typeof fn.arguments === "string") {
        try {
          next = { ...next, function: { ...fn, arguments: JSON.stringify(restore(JSON.parse(fn.arguments))) } };
        } catch {
          // Unparseable arguments are left for the tool node to report.
        }
      }
      return next;
    });
  };

  const m = message as unknown as { tool_calls?: unknown; additional_kwargs?: { tool_calls?: unknown } };
  const hasDirect = Array.isArray(m.tool_calls) && m.tool_calls.length > 0;
  const hasKwargs = Array.isArray(m.additional_kwargs?.tool_calls) && (m.additional_kwargs!.tool_calls as unknown[]).length > 0;
  if (!hasDirect && !hasKwargs) return message;
  return {
    ...(message as object),
    ...(hasDirect ? { tool_calls: restoreList(m.tool_calls) } : {}),
    ...(hasKwargs ? { additional_kwargs: { ...m.additional_kwargs, tool_calls: restoreList(m.additional_kwargs!.tool_calls) } } : {}),
  } as M;
}

/**
 * The menu to BIND in strict mode, plus the restorers for the model's calls.
 *
 * Each Zod-schema tool is bound through a view that shares everything with the
 * original (prototype-linked, so executors and metadata are the same) but
 * carries the strict schema. The original tool object is untouched: the tool
 * node still validates and runs calls against the schema the author wrote.
 * Tools whose schema is not Zod (raw JSON Schema, OpenAI function format) are
 * passed through unchanged for the provider adapter to normalize.
 */
// One view per (tool, schema): the menu is rebound on every model call, and
// rebuilding the transform — and the LangChain wrapper cached on the view —
// each iteration is wasted work.
const strictViews = new WeakMap<object, { schema: unknown; view: object; restore: StrictTransform["restore"] }>();

export function prepareStrictToolMenu<T extends object>(tools: T[]): { menu: T[]; restorers: StrictRestorers } {
  const restorers: StrictRestorers = new Map();
  const menu = tools.map((tool) => {
    const t = tool as { name?: unknown; schema?: unknown };
    if (!t || typeof t.name !== "string" || !isZodSchema(t.schema)) return tool;
    const cached = strictViews.get(tool);
    if (cached && cached.schema === t.schema) {
      restorers.set(t.name, cached.restore);
      return cached.view as T;
    }
    try {
      const transform = toStrictToolSchema(t.schema);
      const view = Object.create(tool) as Record<string, unknown>;
      view.schema = transform.schema;
      // A cached LangChain wrapper on the original carries the ORIGINAL
      // schema; the view must build its own.
      view.__lcTool = undefined;
      strictViews.set(tool, { schema: t.schema, view, restore: transform.restore });
      restorers.set(t.name, transform.restore);
      return view as T;
    } catch {
      return tool;
    }
  });
  return { menu, restorers };
}
