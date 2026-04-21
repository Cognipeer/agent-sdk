import { ZodError } from "zod";
import type {
  ResolvedSmartAgentConfig,
  ToolInterface,
  ToolResponseClassification,
  ToolResponseRetentionPolicy,
} from "../types.js";
import { countApproxTokens } from "../utils/utilTokens.js";
import { safeStringify } from "../utils/content.js";

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
 * Resolves the retention policy applied by the summarizer when context limits
 * are reached. Critical tools are never reduced. Per-tool override beats the
 * default policy.
 */
export function resolveSummarizationRetention(
  toolName: string,
  config: ResolvedSmartAgentConfig,
): ToolResponseRetentionPolicy {
  const criticalTools = new Set(config.toolResponses.criticalTools);
  if (criticalTools.has(toolName)) return "keep_full";
  const byTool = config.toolResponses.toolResponseRetentionByTool[toolName];
  return byTool || config.toolResponses.defaultPolicy;
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
