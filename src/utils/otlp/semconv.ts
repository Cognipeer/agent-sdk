/**
 * The OpenTelemetry GenAI vocabulary the exporter speaks, in one place.
 *
 * Pinned to open-telemetry/semantic-conventions-genai at commit 547934a (status
 * "development": names may still change upstream). No `schemaUrl` is set on the
 * exported scope because the version that commit belongs to is unpublished;
 * the commit is recorded here and in the docs instead.
 */

import type { TraceEventRecord } from "../../types.js";

export const GENAI_SEMCONV_COMMIT = "547934a";

export const ATTR = {
  operationName: "gen_ai.operation.name",
  providerName: "gen_ai.provider.name",
  requestModel: "gen_ai.request.model",
  responseModel: "gen_ai.response.model",
  responseId: "gen_ai.response.id",
  finishReasons: "gen_ai.response.finish_reasons",
  requestStream: "gen_ai.request.stream",
  outputType: "gen_ai.output.type",
  conversationId: "gen_ai.conversation.id",
  agentName: "gen_ai.agent.name",
  agentVersion: "gen_ai.agent.version",
  toolName: "gen_ai.tool.name",
  toolCallId: "gen_ai.tool.call.id",
  toolType: "gen_ai.tool.type",
  usageInput: "gen_ai.usage.input_tokens",
  usageOutput: "gen_ai.usage.output_tokens",
  usageCacheRead: "gen_ai.usage.cache_read.input_tokens",
  usageCacheWrite: "gen_ai.usage.cache_write.input_tokens",
  usageReasoning: "gen_ai.usage.reasoning.output_tokens",
  errorType: "error.type",
} as const;

export const OPERATION = {
  chat: "chat",
  executeTool: "execute_tool",
  invokeAgent: "invoke_agent",
} as const;

/**
 * `gen_ai.provider.name` well-known values (the pinned registry). Anything not
 * in this table is left off the span rather than invented.
 */
const PROVIDERS: Record<string, string> = {
  openai: "openai",
  chatopenai: "openai",
  azure: "azure.ai.openai",
  azureopenai: "azure.ai.openai",
  azurechatopenai: "azure.ai.openai",
  azureaiopenai: "azure.ai.openai",
  azureaiinference: "azure.ai.inference",
  anthropic: "anthropic",
  chatanthropic: "anthropic",
  bedrock: "aws.bedrock",
  awsbedrock: "aws.bedrock",
  chatbedrock: "aws.bedrock",
  chatbedrockconverse: "aws.bedrock",
  vertex: "gcp.vertex_ai",
  vertexai: "gcp.vertex_ai",
  gcpvertexai: "gcp.vertex_ai",
  chatvertexai: "gcp.vertex_ai",
  gemini: "gcp.gemini",
  gcpgemini: "gcp.gemini",
  chatgooglegenerativeai: "gcp.gemini",
  // Gemini API or Vertex: the name alone does not say which.
  google: "gcp.gen_ai",
  gcpgenai: "gcp.gen_ai",
  mistral: "mistral",
  mistralai: "mistral",
  chatmistralai: "mistral",
  groq: "groq",
  chatgroq: "groq",
  deepseek: "deepseek",
  chatdeepseek: "deepseek",
  cohere: "cohere",
  chatcohere: "cohere",
  xai: "x_ai",
  chatxai: "x_ai",
  perplexity: "perplexity",
  chatperplexity: "perplexity",
  watsonx: "ibm.watsonx.ai",
  ibmwatsonxai: "ibm.watsonx.ai",
};

/** The registry name for an SDK / LangChain provider hint, or undefined when it is not one the registry knows. */
export function genAiProviderName(hint: string | undefined): string | undefined {
  if (!hint) return undefined;
  const key = hint.toLowerCase().replace(/[^a-z0-9]/g, "");
  return key ? PROVIDERS[key] : undefined;
}

/** The exception class name carried by `error`, else `_OTHER`. */
export function errorTypeOf(error: { type?: string; stack?: string } | null | undefined): string {
  if (!error) return "_OTHER";
  if (typeof error.type === "string" && error.type.length > 0) return error.type;
  if (typeof error.stack === "string") {
    const match = /^\s*([A-Za-z_$][\w$.]*)\s*(?::|$)/m.exec(error.stack.split("\n", 1)[0] ?? "");
    if (match) return match[1];
  }
  return "_OTHER";
}

/** What a record's gen_ai usage attributes say, or undefined when it reported none. */
export function genAiUsageOf(event: TraceEventRecord & EnrichedUsage): {
  input: number;
  output: number;
  cacheRead?: number;
  cacheWrite?: number;
  reasoning?: number;
} | undefined {
  const num = (value: unknown) => (typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0);
  const input = num(event.inputTokens);
  const output = num(event.outputTokens);
  const cacheRead = num(event.cachedInputTokens);
  const cacheWrite = num(event.cacheWriteTokens);
  const reasoning = num(event.reasoningTokens);
  // Records always carry the four main counters, zeroed when the provider said
  // nothing, so all-zero is the closest the record gets to "not reported".
  if (input + output + cacheRead + cacheWrite + reasoning + num(event.totalTokens) === 0) return undefined;
  const basis = event.usageBasis ?? {};
  return {
    input: basis.inputExcludesCache ? input + cacheRead + cacheWrite : input,
    output: basis.outputExcludesReasoning ? output + reasoning : output,
    ...(cacheRead > 0 ? { cacheRead } : {}),
    ...(cacheWrite > 0 ? { cacheWrite } : {}),
    ...(reasoning > 0 ? { reasoning } : {}),
  };
}

/**
 * Fields a record may carry once the record enrichment lands: all optional, so
 * the converter works on today's records and picks the rest up as they appear.
 */
export type EnrichedUsage = {
  cacheWriteTokens?: number;
  usageBasis?: { inputExcludesCache?: boolean; outputExcludesReasoning?: boolean };
};
