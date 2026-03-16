import { ZodError } from "zod";
import type {
  ResolvedSmartAgentConfig,
  ToolInterface,
  ToolResponseClassification,
  ToolResponseRetentionPolicy,
} from "../types.js";
import { countApproxTokens } from "../utils/utilTokens.js";

function safeStringify(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function summarizeObject(value: any): string {
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

export function classifyToolResponse(toolName: string, output: unknown, config: ResolvedSmartAgentConfig): ToolResponseClassification {
  const serialized = safeStringify(output);
  const tokenCount = countApproxTokens(serialized);
  const criticalTools = new Set(config.toolResponses.criticalTools);

  if (criticalTools.has(toolName)) return "critical";
  if (tokenCount >= config.toolResponses.maxToolResponseTokens || serialized.length >= config.toolResponses.maxToolResponseChars) {
    return "verbose";
  }
  if (serialized === "ok" || serialized === "true" || serialized === "null") {
    return "redundant";
  }
  return "informative";
}

export function resolveToolResponsePolicy(
  toolName: string,
  output: unknown,
  config: ResolvedSmartAgentConfig,
): {
  classification: ToolResponseClassification;
  retentionPolicy: ToolResponseRetentionPolicy;
  content: string;
  rawOutput: unknown;
  summary: string;
  tokenCount: number;
} {
  const serialized = safeStringify(output);
  const tokenCount = countApproxTokens(serialized);
  const classification = classifyToolResponse(toolName, output, config);
  const byTool = config.toolResponses.toolResponseRetentionByTool[toolName];
  let retentionPolicy: ToolResponseRetentionPolicy = byTool || config.toolResponses.defaultPolicy;

  if (classification === "critical") {
    retentionPolicy = byTool || "keep_structured";
  } else if (classification === "verbose") {
    retentionPolicy = byTool || config.toolResponses.largeResponsePolicy;
  } else if (classification === "redundant") {
    retentionPolicy = byTool || "drop";
  }

  const summary = summarizeObject(output);
  if (retentionPolicy === "keep_full") {
    return { classification, retentionPolicy, content: serialized, rawOutput: output, summary, tokenCount };
  }
  if (retentionPolicy === "keep_structured") {
    return { classification, retentionPolicy, content: summary, rawOutput: output, summary, tokenCount };
  }
  if (retentionPolicy === "summarize_archive") {
    return {
      classification,
      retentionPolicy,
      content: `ARCHIVED_TOOL_RESPONSE: ${summary}`,
      rawOutput: output,
      summary,
      tokenCount,
    };
  }
  return {
    classification,
    retentionPolicy,
    content: `DROPPED_TOOL_RESPONSE: ${summary}`,
    rawOutput: output,
    summary,
    tokenCount,
  };
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