/**
 * Prompt / response content for GenAI spans (`gen_ai.input.messages`,
 * `gen_ai.output.messages`, `gen_ai.system_instructions`, `gen_ai.tool.definitions`,
 * `gen_ai.tool.call.arguments`, `gen_ai.tool.call.result`).
 *
 * Content is OFF unless an exporter asks for it, and it is two steps:
 *
 * 1. At RECORD time (`buildCapturedContent`, called by `recordTraceEvent` only when
 *    some exporter wants content): the messages, response, tool menu and tool
 *    arguments / result are copied into a plain, bounded structure. A copy, because
 *    the transcript is mutated and rewritten after the call; reasoning parts and
 *    binary payloads never make it in. It rides on the record under a
 *    NON-ENUMERABLE symbol key, so the file sink, the custom sink's JSON clones,
 *    the cognipeer / http sinks and anything persisted never see it.
 * 2. At EXPORT time (`contentAttributes`): per exporter, the redact hook runs
 *    first, then the caps (whole messages are dropped, oldest first; JSON is never
 *    cut in the middle), then the encoding.
 */

import { Buffer } from "node:buffer";
import { contentPartToText } from "../content.js";
import type {
  OtlpAnyValue,
  OtlpContentField,
  OtlpContentOptions,
  OtlpKeyValue,
  ResolvedOtlpContent,
} from "./types.js";
import { ATTR } from "./semconv.js";

/** Symbol key of the captured content on a trace record. Not enumerable. */
export const CAPTURE = Symbol.for("cognipeer.agent-sdk.traceCapture");

const DEFAULTS = {
  maxStringChars: 4096,
  maxMessages: 32,
  maxAttributeBytes: 32768,
} as const;

const FIELDS: OtlpContentField[] = ["system", "input", "output", "tools", "toolArgs", "toolResults", "sections"];

/** Content options with the defaults filled in. */
export function resolveContentOptions(content: boolean | OtlpContentOptions | undefined): ResolvedOtlpContent {
  const given: OtlpContentOptions = typeof content === "object" && content !== null ? content : {};
  const enabled = typeof content === "boolean" ? content : given.enabled === true;
  const positive = (value: unknown, fallback: number) =>
    typeof value === "number" && Number.isFinite(value) && value >= 1 ? Math.floor(value) : fallback;
  return {
    enabled,
    include: Array.isArray(given.include) ? given.include.filter((field) => FIELDS.includes(field)) : [...FIELDS],
    maxStringChars: positive(given.maxStringChars, DEFAULTS.maxStringChars),
    maxMessages: positive(given.maxMessages, DEFAULTS.maxMessages),
    maxAttributeBytes: positive(given.maxAttributeBytes, DEFAULTS.maxAttributeBytes),
    redact: typeof given.redact === "function" ? given.redact : undefined,
    encoding: given.encoding === "structured" ? "structured" : "json",
  };
}

// ─── The captured shape ─────────────────────────────────────────────────────

type TextPart = { type: "text"; content: string };
type ToolCallPart = { type: "tool_call"; id?: string; name: string; arguments: unknown };
type ToolResponsePart = { type: "tool_call_response"; id?: string; response: unknown };
type UriPart = { type: "uri"; modality: string; uri: string; mime_type?: string };
export type CapturedPart = TextPart | ToolCallPart | ToolResponsePart | UriPart;
export type CapturedMessage = { role: string; parts: CapturedPart[]; name?: string };
export type CapturedToolDefinition = { type: "function"; name: string; description?: string; parameters?: unknown };

export type CapturedContent = {
  /** Text of the system messages, kept apart from `input`. */
  system?: TextPart[];
  /** Every message the provider was sent, system messages excluded. */
  input?: CapturedMessage[];
  /** The assistant message the provider answered with. */
  output?: CapturedMessage;
  tools?: CapturedToolDefinition[];
  toolArgs?: unknown;
  /** Present only for a tool that ran to completion. */
  toolResults?: unknown;
};

export type CaptureSource = {
  /** The messages as they went to the provider. */
  input?: unknown[];
  /** The provider's answer. */
  output?: unknown;
  toolDefinitions?: Array<{ name: string; description?: string; parameters?: unknown }>;
  toolArguments?: unknown;
  /** Set (even to undefined) only when the tool completed. */
  toolResult?: unknown;
  hasToolResult?: boolean;
};

export type CaptureLimits = { maxStringChars: number; maxMessages: number };

const isRecord = (value: unknown): value is Record<string, any> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** A plain JSON copy, or undefined when the value cannot be serialised (a cycle, a BigInt). */
function plain(value: unknown): unknown {
  if (value === undefined) return undefined;
  try {
    const text = JSON.stringify(value);
    return text === undefined ? undefined : JSON.parse(text);
  } catch {
    return undefined;
  }
}

const TRUNCATED_MARKER = /\.\.\.\[truncated (\d+) chars\]$/;

/** Cuts `text` to `max` chars and says how many were lost; a text cut earlier is not cut (or marked) twice. */
function truncateText(text: string, max: number): string {
  const earlier = TRUNCATED_MARKER.exec(text);
  const body = earlier ? text.slice(0, earlier.index) : text;
  if (body.length <= max) return text;
  const lost = body.length - max + (earlier ? Number(earlier[1]) : 0);
  return `${body.slice(0, max)}...[truncated ${lost} chars]`;
}

/** Cuts every long string inside `value` (it must be plain JSON data). */
function capStrings(value: unknown, max: number): unknown {
  if (typeof value === "string") return truncateText(value, max);
  if (Array.isArray(value)) return value.map((item) => capStrings(item, max));
  if (isRecord(value)) {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) out[key] = capStrings(item, max);
    return out;
  }
  return value;
}

/** JSON text as an object: `{"a":1}` becomes `{a:1}`; a scalar or array becomes `{ value }`. */
function asObject(value: unknown): unknown {
  let parsed: unknown = value;
  if (typeof value === "string") {
    try {
      parsed = JSON.parse(value);
    } catch {
      parsed = value;
    }
  }
  const copy = plain(parsed);
  if (copy === undefined) return undefined;
  return isRecord(copy) ? copy : { value: copy };
}

const REASONING_PART_TYPES = new Set(["thinking", "redacted_thinking", "reasoning", "reasoning_content"]);

function textOf(content: unknown): string {
  if (content == null) return "";
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return contentPartToText(content, () => "");
  return content
    .filter((part) => !(isRecord(part) && REASONING_PART_TYPES.has(String(part.type))))
    .map((part) => contentPartToText(part, () => ""))
    .filter((text) => text.length > 0)
    .join("\n");
}

function toolCallPartsOf(message: Record<string, any>): ToolCallPart[] {
  const calls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
  const parts: ToolCallPart[] = [];
  for (const call of calls) {
    if (!isRecord(call)) continue;
    const name = call.name ?? call.function?.name;
    if (typeof name !== "string" || !name) continue;
    const args = call.args ?? call.arguments ?? call.function?.arguments;
    const coerced = asObject(args ?? {});
    // An id the SDK made up (Vertex, the tools node) is not the provider's, and says nothing downstream.
    const id = typeof call.id === "string" && call.id && !call.idSynthesized ? call.id : undefined;
    parts.push({ type: "tool_call", ...(id ? { id } : {}), name, arguments: coerced ?? {} });
  }
  return parts;
}

function messageOf(raw: unknown): CapturedMessage | undefined {
  if (!isRecord(raw)) return undefined;
  const role = typeof raw.role === "string" ? raw.role : "user";
  const parts: CapturedPart[] = [];

  if (role === "tool") {
    const text = textOf(raw.content);
    const parsed = (() => {
      try {
        return JSON.parse(text);
      } catch {
        return text;
      }
    })();
    parts.push({
      type: "tool_call_response",
      ...(typeof raw.tool_call_id === "string" && raw.tool_call_id ? { id: raw.tool_call_id } : {}),
      response: plain(parsed) ?? text,
    });
    return { role, parts, ...(typeof raw.name === "string" && raw.name ? { name: raw.name } : {}) };
  }

  const text = textOf(raw.content);
  if (text) parts.push({ type: "text", content: text });
  if (role === "assistant") parts.push(...toolCallPartsOf(raw));
  if (parts.length === 0 && role !== "assistant") parts.push({ type: "text", content: "" });
  return { role, parts };
}

/**
 * Copies what a record's content attributes need, bounded by `limits` (the widest
 * the interested exporters allow, so nothing any of them wants is lost here and
 * the memory held until the session ends stays bounded).
 */
export function buildCapturedContent(source: CaptureSource, limits: CaptureLimits): CapturedContent {
  const out: CapturedContent = {};

  if (Array.isArray(source.input)) {
    const system: TextPart[] = [];
    const messages: CapturedMessage[] = [];
    for (const raw of source.input) {
      const message = messageOf(raw);
      if (!message) continue;
      if (message.role === "system") {
        const content = message.parts.map((part) => (part.type === "text" ? part.content : "")).join("\n");
        if (content) system.push({ type: "text", content });
      } else {
        messages.push(message);
      }
    }
    if (system.length > 0) out.system = capStrings(system, limits.maxStringChars) as TextPart[];
    // Only the most recent messages can be exported; the rest are never held.
    const recent = messages.slice(-limits.maxMessages);
    out.input = capStrings(recent, limits.maxStringChars) as CapturedMessage[];
  }

  if (source.output !== undefined && source.output !== null) {
    const message = messageOf({ ...(isRecord(source.output) ? source.output : { content: String(source.output) }), role: "assistant" });
    if (message) out.output = capStrings(message, limits.maxStringChars) as CapturedMessage;
  }

  if (Array.isArray(source.toolDefinitions) && source.toolDefinitions.length > 0) {
    out.tools = capStrings(
      source.toolDefinitions
        .filter((tool) => tool && typeof tool.name === "string")
        .map((tool) => ({
          type: "function" as const,
          name: tool.name,
          ...(tool.description ? { description: tool.description } : {}),
          ...(tool.parameters !== undefined ? { parameters: plain(tool.parameters) } : {}),
        })),
      limits.maxStringChars,
    ) as CapturedToolDefinition[];
  }

  if (source.toolArguments !== undefined) {
    const args = asObject(source.toolArguments);
    if (args !== undefined) out.toolArgs = capStrings(args, limits.maxStringChars);
  }
  if (source.hasToolResult || source.toolResult !== undefined) {
    const result = asObject(source.toolResult);
    if (result !== undefined) out.toolResults = capStrings(result, limits.maxStringChars);
  }
  return out;
}

/** The content a record holds, if any. */
export function capturedContentOf(event: unknown): CapturedContent | undefined {
  return (event as { [CAPTURE]?: CapturedContent } | null | undefined)?.[CAPTURE];
}

/** Attaches captured content to a record where JSON, spread and Object.keys cannot reach it. */
export function attachCapturedContent(record: object, content: CapturedContent): void {
  Object.defineProperty(record, CAPTURE, { value: content, enumerable: false, configurable: true, writable: true });
}

// ─── Export ─────────────────────────────────────────────────────────────────

/** Providers whose APIs take system instructions apart from the messages (the pinned spec's list). */
const SEPARATE_SYSTEM = new Set(["anthropic", "aws.bedrock", "gcp.vertex_ai", "gcp.gemini"]);

function toAnyValue(value: unknown): OtlpAnyValue | undefined {
  if (value === null || value === undefined) return undefined;
  if (typeof value === "string") return { stringValue: value };
  if (typeof value === "boolean") return { boolValue: value };
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return undefined;
    return Number.isInteger(value) && Number.isSafeInteger(value) ? { intValue: String(value) } : { doubleValue: value };
  }
  if (Array.isArray(value)) {
    return { arrayValue: { values: value.map((item) => toAnyValue(item) ?? { stringValue: "" }) } };
  }
  if (isRecord(value)) {
    const values: OtlpKeyValue[] = [];
    for (const [key, item] of Object.entries(value)) {
      const any = toAnyValue(item);
      if (any) values.push({ key, value: any });
    }
    return { kvlistValue: { values } };
  }
  return undefined;
}

const byteLength = (text: string): number => Buffer.byteLength(text, "utf8");

/**
 * redact, then caps, then encoding. Returns undefined when the field is dropped
 * (redact said so, redact threw, or there is nothing to say).
 */
function render(
  value: unknown,
  field: OtlpContentField,
  options: ResolvedOtlpContent,
  info: { eventType: string; spanId?: string; toolName?: string; model?: string },
): OtlpAnyValue | undefined {
  let working: unknown = plain(value);
  if (working === undefined) return undefined;

  if (options.redact) {
    try {
      // A copy: the hook may mutate what it is given.
      working = options.redact(plain(working), { field, ...info });
    } catch {
      return undefined;
    }
    working = plain(working);
    if (working === undefined || working === null) return undefined;
  }

  working = capStrings(working, options.maxStringChars);
  if ((field === "input" || field === "system" || field === "sections") && Array.isArray(working) && working.length > options.maxMessages) {
    working = working.slice(-options.maxMessages);
  }

  let text = JSON.stringify(working);
  if (text === undefined) return undefined;
  if (byteLength(text) > options.maxAttributeBytes) {
    if (field === "input" && Array.isArray(working)) {
      // Whole messages, oldest first; the most recent one always stays if it can.
      const messages = [...working];
      while (messages.length > 1 && byteLength(JSON.stringify(messages)) > options.maxAttributeBytes) messages.shift();
      working = messages;
      text = JSON.stringify(working);
    }
    if (byteLength(text) > options.maxAttributeBytes) {
      working = { truncated: true };
      text = JSON.stringify(working);
    }
  }
  return options.encoding === "structured" ? toAnyValue(working) : { stringValue: text };
}

/**
 * The content attributes for one span. `kind` is the GenAI operation the span
 * claims; a span that is not `chat` or `execute_tool` carries none.
 */
export function contentAttributes(
  kind: "chat" | "execute_tool",
  event: { type: string; spanId?: string; model?: string; actor?: { name?: string }; finishReason?: string; rawFinishReason?: string },
  provider: string | undefined,
  options: ResolvedOtlpContent | undefined,
): OtlpKeyValue[] {
  if (!options?.enabled) return [];
  const captured = capturedContentOf(event);
  if (!captured) return [];
  const include = new Set(options.include);
  const info = {
    eventType: event.type,
    ...(event.spanId ? { spanId: event.spanId } : {}),
    ...(kind === "execute_tool" && event.actor?.name ? { toolName: event.actor.name } : {}),
    ...(event.model ? { model: event.model } : {}),
  };
  const attrs: OtlpKeyValue[] = [];
  const add = (key: string, value: OtlpAnyValue | undefined) => {
    if (value) attrs.push({ key, value });
  };

  if (kind === "chat") {
    const separate = provider !== undefined && SEPARATE_SYSTEM.has(provider);
    const system = captured.system ?? [];
    if (separate) {
      if (include.has("system") && system.length > 0) add(ATTR.systemInstructions, render(system, "system", options, info));
      if (include.has("input") && captured.input) add(ATTR.inputMessages, render(captured.input, "input", options, info));
    } else if (include.has("input") && (captured.input || system.length > 0)) {
      // The system prompt stays in the messages, in front, and is not counted against the cap.
      const messages = captured.input ?? [];
      const capped = messages.slice(-options.maxMessages);
      const withSystem = system.length > 0 ? [{ role: "system", parts: system }, ...capped] : capped;
      add(ATTR.inputMessages, render(withSystem, "input", { ...options, maxMessages: options.maxMessages + 1 }, info));
    }
    if (include.has("output") && captured.output) {
      const reason = event.rawFinishReason ?? event.finishReason;
      const finish = reason === "tool_calls" ? "tool_call" : reason;
      add(ATTR.outputMessages, render([{ ...captured.output, ...(finish ? { finish_reason: finish } : {}) }], "output", options, info));
    }
    if (include.has("tools") && captured.tools) add(ATTR.toolDefinitions, render(captured.tools, "tools", options, info));
  } else {
    if (include.has("toolArgs") && captured.toolArgs !== undefined) add(ATTR.toolCallArguments, render(captured.toolArgs, "toolArgs", options, info));
    if (include.has("toolResults") && captured.toolResults !== undefined) add(ATTR.toolCallResult, render(captured.toolResults, "toolResults", options, info));
  }
  return attrs;
}

/**
 * The `cognipeer.sections` attribute of one span: the record's sections as the
 * Console reads them. Two kinds, and they are not treated alike.
 *
 * - Identity sections (ids, status, timestamps; see `TraceMetadataSection.identity`)
 *   always go. They are what lets a viewer pair an approval with its decision.
 * - Everything else is payload (prompts, replies, tool arguments and results,
 *   tool menus): it goes only when content capture is on for this exporter, and
 *   then it passes the same gate as the `gen_ai.*` content, redact hook first,
 *   caps second (whole sections are dropped oldest first; a payload that still
 *   does not fit is left out, identity sections are never cut).
 *
 * Returns undefined when there is nothing to carry.
 */
export function sectionsAttribute(
  sections: Array<{ identity?: boolean } & Record<string, any>> | undefined,
  event: { type: string; spanId?: string; model?: string },
  options: ResolvedOtlpContent | undefined,
): OtlpKeyValue | undefined {
  if (!sections || sections.length === 0) return undefined;
  const identity = sections.filter((section) => section.identity === true);
  const payload = sections.filter((section) => section.identity !== true);

  let kept: unknown[] = [];
  if (options?.enabled && options.include.includes("sections") && payload.length > 0) {
    kept = redactedSections(payload, options, event);
  }
  const max = options?.maxAttributeBytes ?? DEFAULTS.maxAttributeBytes;
  const encode = (list: unknown[]): string | undefined => {
    try {
      return JSON.stringify(list);
    } catch {
      return undefined;
    }
  };
  let text = encode([...identity, ...kept]);
  while (text !== undefined && kept.length > 0 && byteLength(text) > max) {
    kept.shift();
    text = encode([...identity, ...kept]);
  }
  if (text === undefined) {
    // Unserializable sections are dropped, as before; the identity ones may still go.
    text = encode(identity);
  }
  if (text === undefined || text === "[]") return undefined;
  return { key: "cognipeer.sections", value: { stringValue: text } };
}

/** The payload sections after the redact hook and the string / count caps; [] when the hook refuses them. */
function redactedSections(
  payload: unknown[],
  options: ResolvedOtlpContent,
  event: { type: string; spanId?: string; model?: string },
): unknown[] {
  let working: unknown = plain(payload);
  if (working === undefined) return [];
  if (options.redact) {
    try {
      working = plain(options.redact(plain(working), {
        field: "sections",
        eventType: event.type,
        ...(event.spanId ? { spanId: event.spanId } : {}),
        ...(event.model ? { model: event.model } : {}),
      }));
    } catch {
      return [];
    }
    // A hook that returns something other than the list of sections has not
    // vouched for it: fail closed.
    if (!Array.isArray(working)) return [];
  }
  const capped = capStrings(working, options.maxStringChars);
  return Array.isArray(capped) ? capped.slice(-options.maxMessages) : [];
}
