import { createHash } from "node:crypto";
import { ZodError } from "zod";
import type {
  ResolvedSmartAgentConfig,
  ToolInputRetentionPolicy,
  ToolInterface,
  ToolResponseClassification,
  ToolResponseRetentionPolicy,
  ToolRetentionSpec,
} from "../types.js";
import { countApproxTokens } from "../utils/utilTokens.js";
import { safeStringify } from "../utils/content.js";

/**
 * Tools the agent loop uses to steer ITSELF. Their arguments are never digested —
 * digesting them is never a win (the arguments are small) and always a risk:
 *  - `response` carries the run's final structured output,
 *  - `manage_todo_list` carries the living plan,
 *  - `ask_user_question` carries the question the user's answer replies to,
 *  - `open_skill` / `bind_skill_tools` / `search_skills` name the capability being
 *    loaded, which the rest of the run reasons about,
 *  - `get_tool_response` is the recovery path itself.
 * They also default to `keep_full` on the output axis (overridable per tool).
 */
export const CONTROL_PLANE_TOOL_NAMES: readonly string[] = [
  "response",
  "manage_todo_list",
  "get_tool_response",
  "ask_user_question",
  "open_skill",
  "bind_skill_tools",
  "search_skills",
];

/**
 * Delegation tools: the arguments ARE the brief handed to the child agent — the
 * parent must be able to say what it delegated. Never digested. The child's report
 * (the output) may still be archived and paged back in.
 */
export const DELEGATION_TOOL_NAMES: readonly string[] = [
  "delegate_to",
  "spawn_subagent",
  "spawn_subagents_parallel",
];

const INPUT_PROTECTED_TOOL_NAMES = new Set<string>([
  ...CONTROL_PLANE_TOOL_NAMES,
  ...DELEGATION_TOOL_NAMES,
]);

const CONTROL_PLANE_OUTPUT_DEFAULTS = new Set<string>(CONTROL_PLANE_TOOL_NAMES);

export const DEFAULT_MAX_TOOL_INPUT_FIELD_CHARS = 2000;
export const DEFAULT_TOOL_INPUT_DIGEST_HEAD_CHARS = 200;

/** Key marking a digested argument field. Recognized as a recovery reference. */
export const TOOL_INPUT_DIGEST_KEY = "__digest";

/**
 * Compact textual preview of a value for archive/structured retention. Used by
 * the summarizer when an old tool response is reduced to a placeholder. Not
 * used at tool execution time.
 */
export function summarizeObject(value: any): string {
  if (value == null) return "null";
  if (typeof value === "string") {
    return value.length > 240 ? `${value.slice(0, 240)}...` : value;
  }
  if (Array.isArray(value)) {
    const preview = value.slice(0, 3).map((entry) => safeStringify(entry).slice(0, 120)).join(" | ");
    return `array(length=${value.length}) ${preview}`.trim();
  }
  if (typeof value === "object") {
    const keys = Object.keys(value);
    const preview = keys.slice(0, 6).map((key) => `${key}=${safeStringify(value[key]).slice(0, 80)}`).join("; ");
    return `object(keys=${keys.length}) ${preview}`.trim();
  }
  return safeStringify(value);
}

export function classifyToolResponse(
  toolName: string,
  output: unknown,
  config: ResolvedSmartAgentConfig,
): ToolResponseClassification {
  const criticalTools = new Set(config.toolResponses.criticalTools);
  if (criticalTools.has(toolName)) return "critical";

  const serialized = safeStringify(output);
  const tokenCount = countApproxTokens(serialized);
  if (
    tokenCount >= config.toolResponses.maxToolResponseTokens
    || serialized.length >= config.toolResponses.maxToolResponseChars
  ) {
    return "verbose";
  }
  return "informative";
}

/**
 * Eager pass executed at tool-call time. The full payload is always preserved in
 * `toolHistory`; we only intervene when a single response would blow up the
 * very next model call. Critical tools are never truncated.
 */
export function applyToolResponseHardCap(
  toolName: string,
  output: unknown,
  executionId: string,
  config: ResolvedSmartAgentConfig,
): {
  classification: ToolResponseClassification;
  content: string;
  rawOutput: unknown;
  tokenCount: number;
  truncated: boolean;
} {
  const serialized = safeStringify(output);
  const tokenCount = countApproxTokens(serialized);
  const classification = classifyToolResponse(toolName, output, config);

  if (classification !== "verbose") {
    return { classification, content: serialized, rawOutput: output, tokenCount, truncated: false };
  }

  const cap = config.toolResponses.maxToolResponseChars;
  const head = serialized.slice(0, cap);
  const note = `\n... [TRUNCATED ${serialized.length - cap} chars by hard cap. Use get_tool_response with executionId="${executionId}" to fetch the full payload.]`;
  return {
    classification,
    content: head + note,
    rawOutput: output,
    tokenCount,
    truncated: true,
  };
}

/**
 * Tool-definition-declared retention specs, keyed by tool name. Built from the
 * runtime's live tool list so a skill-bound tool contributes its own declaration.
 */
export type ToolRetentionDeclarations = Map<string, ToolRetentionSpec>;

export function collectToolRetentionDeclarations(
  tools: Array<ToolInterface<any, any, any>> | undefined,
): ToolRetentionDeclarations {
  const declarations: ToolRetentionDeclarations = new Map();
  if (!Array.isArray(tools)) return declarations;
  for (const tool of tools) {
    const spec = (tool as any)?.retention as ToolRetentionSpec | undefined;
    const name = typeof tool?.name === "string" ? tool.name : "";
    if (!name || !spec || typeof spec !== "object") continue;
    declarations.set(name, spec);
  }
  return declarations;
}

/**
 * Resolves the retention policy applied by the summarizer when context limits
 * are reached. Critical tools are never reduced.
 *
 * Precedence (first match wins):
 *  1. `criticalTools` — absolute, never reduced (documented contract).
 *  2. `toolResponses.retentionByTool[name].output` — caller's two-axis override.
 *  3. `toolResponses.toolResponseRetentionByTool[name]` — legacy single-axis map.
 *  4. the tool definition's own `retention.output`.
 *  5. built-in control-plane default (`keep_full`).
 *  6. `toolResponses.defaultPolicy`.
 */
export function resolveSummarizationRetention(
  toolName: string,
  config: ResolvedSmartAgentConfig,
  declarations?: ToolRetentionDeclarations,
): ToolResponseRetentionPolicy {
  const criticalTools = new Set(config.toolResponses.criticalTools);
  if (criticalTools.has(toolName)) return "keep_full";

  const twoAxis = config.toolResponses.retentionByTool?.[toolName]?.output;
  if (twoAxis) return twoAxis;

  const legacy = config.toolResponses.toolResponseRetentionByTool[toolName];
  if (legacy) return legacy;

  const declared = declarations?.get(toolName)?.output;
  if (declared) return declared;

  if (CONTROL_PLANE_OUTPUT_DEFAULTS.has(toolName)) return "keep_full";

  return config.toolResponses.defaultPolicy;
}

/**
 * Resolves the retention policy applied to a tool call's ARGUMENTS.
 *
 * Precedence (first match wins):
 *  1. control-plane + delegation tools — always `keep` (hard invariant).
 *  2. `criticalTools` — a tool whose response may never be reduced does not get
 *     its request reduced either.
 *  3. `toolResponses.retentionByTool[name].input`.
 *  4. the tool definition's own `retention.input`.
 *  5. `toolResponses.defaultInputPolicy` (defaults to `keep`).
 *
 * The default is `keep`, so argument digesting never happens unless a tool or a
 * caller explicitly asks for it.
 */
export function resolveInputRetention(
  toolName: string,
  config: ResolvedSmartAgentConfig,
  declarations?: ToolRetentionDeclarations,
): ToolInputRetentionPolicy {
  if (INPUT_PROTECTED_TOOL_NAMES.has(toolName)) return "keep";

  const criticalTools = new Set(config.toolResponses.criticalTools);
  if (criticalTools.has(toolName)) return "keep";

  const twoAxis = config.toolResponses.retentionByTool?.[toolName]?.input;
  if (twoAxis) return twoAxis;

  const declared = declarations?.get(toolName)?.input;
  if (declared) return declared;

  return config.toolResponses.defaultInputPolicy;
}

function shortSha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex").slice(0, 16);
}

function isDigestMarker(value: unknown): boolean {
  return Boolean(
    value
    && typeof value === "object"
    && !Array.isArray(value)
    && TOOL_INPUT_DIGEST_KEY in (value as Record<string, unknown>),
  );
}

export type ToolInputDigestOptions = {
  /** Per-field character threshold. Strings at or below this are preserved verbatim. */
  maxFieldChars?: number;
  /** Leading characters of a digested field kept as a preview. */
  headChars?: number;
  /** Execution id embedded in each marker so the model can page the original back in. */
  executionId?: string;
};

export type ToolInputDigestResult = {
  /** The rewritten value. Identical reference when nothing was digested. */
  value: unknown;
  /** Dotted paths of the fields that were replaced by a digest marker. */
  digestedPaths: string[];
  /** Characters reclaimed from the serialized arguments. */
  reclaimedChars: number;
};

/**
 * Field-level argument digest.
 *
 * Walks the argument structure and replaces ONLY string leaves longer than
 * `maxFieldChars` with a compact descriptor. Every other field — paths, ids,
 * modes, indexes, booleans, short strings — is preserved verbatim, so a call like
 *
 *   { filePath: "/reports/q3.md", mode: "append", section: 3, content: "<60k>" }
 *
 * compacts to
 *
 *   { filePath: "/reports/q3.md", mode: "append", section: 3,
 *     content: { __digest: { chars: 61840, sha256: "…", head: "# Q3 …", recover: "…" } } }
 *
 * The model can still state exactly what it did; only the payload it no longer
 * needs to re-read is gone. Idempotent: an existing digest marker is left alone.
 */
export function digestToolInputValue(
  value: unknown,
  options?: ToolInputDigestOptions,
): ToolInputDigestResult {
  const maxFieldChars = options?.maxFieldChars ?? DEFAULT_MAX_TOOL_INPUT_FIELD_CHARS;
  const headChars = options?.headChars ?? DEFAULT_TOOL_INPUT_DIGEST_HEAD_CHARS;
  const executionId = options?.executionId;
  const digestedPaths: string[] = [];
  let reclaimedChars = 0;

  const walk = (node: unknown, path: string): unknown => {
    if (typeof node === "string") {
      if (node.length <= maxFieldChars) return node;
      digestedPaths.push(path || "(root)");
      const marker: Record<string, unknown> = {
        chars: node.length,
        sha256: shortSha256(node),
        head: node.slice(0, headChars),
      };
      if (executionId) {
        marker.recover = `get_tool_response executionId="${executionId}" part="input"`;
      }
      const replacement = { [TOOL_INPUT_DIGEST_KEY]: marker };
      reclaimedChars += node.length - safeStringify(replacement).length;
      return replacement;
    }

    if (Array.isArray(node)) {
      let changed = false;
      const next = node.map((entry, index) => {
        const walked = walk(entry, path ? `${path}[${index}]` : `[${index}]`);
        if (walked !== entry) changed = true;
        return walked;
      });
      return changed ? next : node;
    }

    if (node && typeof node === "object") {
      if (isDigestMarker(node)) return node;
      let changed = false;
      const next: Record<string, unknown> = {};
      for (const [key, entry] of Object.entries(node as Record<string, unknown>)) {
        const walked = walk(entry, path ? `${path}.${key}` : key);
        if (walked !== entry) changed = true;
        next[key] = walked;
      }
      return changed ? next : node;
    }

    return node;
  };

  const nextValue = walk(value, "");
  return { value: nextValue, digestedPaths, reclaimedChars: Math.max(0, reclaimedChars) };
}

/**
 * Digest a serialized `tool_call.function.arguments` JSON string in place.
 * Returns the input string unchanged when nothing needed digesting, when the
 * string is not parseable JSON (never guess at a non-JSON payload), or when the
 * result would not actually be smaller.
 */
export function digestToolInputArguments(
  argumentsJson: string,
  options?: ToolInputDigestOptions,
): { arguments: string; digestedPaths: string[]; reclaimedChars: number } {
  const unchanged = { arguments: argumentsJson, digestedPaths: [] as string[], reclaimedChars: 0 };
  if (typeof argumentsJson !== "string" || argumentsJson.length === 0) return unchanged;

  let parsed: unknown;
  try {
    parsed = JSON.parse(argumentsJson);
  } catch {
    return unchanged;
  }

  const digested = digestToolInputValue(parsed, options);
  if (digested.digestedPaths.length === 0) return unchanged;

  const serialized = safeStringify(digested.value);
  if (serialized.length >= argumentsJson.length) return unchanged;

  return {
    arguments: serialized,
    digestedPaths: digested.digestedPaths,
    reclaimedChars: argumentsJson.length - serialized.length,
  };
}

/**
 * Renders the placeholder content used when the summarizer reduces an old tool
 * message according to the resolved retention policy. The full payload is still
 * fetchable via `get_tool_response` using the executionId/toolCallId reference.
 */
export function renderRetainedToolMessage(args: {
  policy: ToolResponseRetentionPolicy;
  rawOutput: unknown;
  toolName: string;
  toolCallId?: string;
  executionId?: string;
  prebuiltSummary?: string;
}): string {
  const { policy, rawOutput, toolName, toolCallId, executionId, prebuiltSummary } = args;
  if (policy === "keep_full") {
    return typeof rawOutput === "string" ? rawOutput : safeStringify(rawOutput);
  }

  const summary = prebuiltSummary || summarizeObject(rawOutput);
  const refs = [
    `toolName=${toolName}`,
    toolCallId ? `toolCallId=${toolCallId}` : null,
    executionId ? `executionId=${executionId}` : null,
  ].filter(Boolean).join("; ");
  const refId = executionId || toolCallId || "";

  if (policy === "keep_structured") {
    return `STRUCTURED_TOOL_RESPONSE [${refs}]\nPreview: ${summary}\nUse get_tool_response with executionId "${refId}" to fetch the full payload when a specific field is needed.`;
  }

  if (policy === "summarize_archive") {
    return `ARCHIVED_TOOL_RESPONSE [${refs}]\nSummary: ${summary}\nUse get_tool_response with executionId "${refId}" to fetch the full payload.`;
  }

  return `DROPPED_TOOL_RESPONSE [${refs}]\nUse get_tool_response with executionId "${refId}" only if you must recover the original payload.`;
}

export function validateToolArgs(
  tool: ToolInterface<any, any, any>,
  args: unknown,
): { ok: true; value: any } | { ok: false; message: string } {
  const schema = (tool as any).schema;
  if (!schema || typeof schema.parse !== "function") {
    return { ok: true, value: args };
  }

  try {
    return { ok: true, value: schema.parse(args) };
  } catch (error) {
    if (error instanceof ZodError) {
      const message = error.issues.map((issue) => `${issue.path.join(".") || "root"}: ${issue.message}`).join("; ");
      return { ok: false, message };
    }
    return { ok: false, message: error instanceof Error ? error.message : String(error) };
  }
}
