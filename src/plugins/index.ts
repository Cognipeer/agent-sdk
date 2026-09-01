export { createPluginHost, HookTimeoutError, HOOK_NAMES } from "./host.js";
export type { PluginHost, PluginRunHost } from "./host.js";
export { definePlugin, defineHook } from "./define.js";
export {
  CONSOLE_HOOK_MAP,
  HOOK_CONTRACT_VERSION,
  isHookImplemented,
  pluginCapabilities,
} from "./capabilities.js";
export type { CapabilityStatus, SdkCapabilities } from "./capabilities.js";

export type {
  AgentPlugin,
  ApprovalTransport,
  CheckpointStore,
  ContextBuilder,
  ConversationStore,
  CostEstimator,
  GateResult,
  HookContext,
  HookDecision,
  HookHandler,
  HookMap,
  HookName,
  HookRegistrations,
  MaybePromise,
  PluginContributions,
  PluginEvent,
  PluginFailureMode,
  PluginHostOptions,
  PluginLogger,
  PluginProvides,
  PluginSetupContext,
  PromptSource,
  SkillSource,
  SlotName,
  SummarizerInput,
  SummarizerResult,
  SummarizerStrategy,
} from "./types.js";

// ─── Built-in plugins ────────────────────────────────────────────────────────

export {
  createGuardrailPlugin,
  customGuardrail,
  httpGuardrail,
  normalizeVerdicts,
} from "./builtin/guardrail.js";
export type {
  GuardrailCallContext,
  GuardrailPhaseName,
  GuardrailPluginOptions,
  GuardrailRequest,
  GuardrailTransport,
  GuardrailVerdict,
  GuardrailViolation,
  HttpGuardrailOptions,
} from "./builtin/guardrail.js";

export { cognipeerGuardrail, mapConsoleHookVerdict } from "./builtin/cognipeerGuardrail.js";
export type { CognipeerGuardrailConfig } from "./builtin/cognipeerGuardrail.js";

export { portkeyGateway, portkeyGuardrail } from "./builtin/portkeyGuardrail.js";
export type { PortkeyGatewayConfig, PortkeyGuardrailConfig } from "./builtin/portkeyGuardrail.js";

export { piiRedaction, redactText, isValidIban, isValidLuhn, isValidTckn } from "./builtin/piiRedaction.js";
export type { PiiDetector, PiiEntity, PiiRedactionConfig, RedactionResult } from "./builtin/piiRedaction.js";

export { pathSandbox, toolPolicy } from "./builtin/toolPolicy.js";
export type { ToolPolicyConfig, ToolRule } from "./builtin/toolPolicy.js";

export { budgetGuard } from "./builtin/budgetGuard.js";
export type { BudgetGuardConfig } from "./builtin/budgetGuard.js";

export { auditLog } from "./builtin/auditLog.js";
export type { AuditEntry, AuditLogConfig } from "./builtin/auditLog.js";

export {
  checkpointing,
  conversationHistory,
  fileCheckpointStore,
  inMemoryCheckpointStore,
  inMemoryConversationStore,
} from "./builtin/stores.js";
export type { CheckpointPluginConfig, ConversationPluginConfig } from "./builtin/stores.js";

export { promptInjectionGuard } from "./builtin/promptInjectionGuard.js";
export type {
  InjectionScan,
  PromptInjectionFamily,
  PromptInjectionGuardConfig,
} from "./builtin/promptInjectionGuard.js";

export { outputGuard } from "./builtin/outputGuard.js";
export type { OutputGuardConfig } from "./builtin/outputGuard.js";

export { sessionMetrics } from "./builtin/sessionMetrics.js";
export type { SessionMetrics, SessionMetricsConfig } from "./builtin/sessionMetrics.js";

export { mcp } from "./builtin/mcp.js";
export type { McpConfig, McpConnection } from "./builtin/mcp.js";

export { rateLimit } from "./builtin/rateLimit.js";
export type { RateLimitConfig } from "./builtin/rateLimit.js";

export { responseCache } from "./builtin/responseCache.js";
export type { ResponseCacheConfig } from "./builtin/responseCache.js";

export {
  azureContentSafety,
  bedrockGuardrail,
  openAIModeration,
  regexGuardrail,
} from "./builtin/guardrailPresets.js";
export type {
  AzureContentSafetyConfig,
  BedrockGuardrailConfig,
  OpenAIModerationConfig,
  RegexGuardrailConfig,
} from "./builtin/guardrailPresets.js";

export { mediaPolicy } from "./builtin/mediaPolicy.js";
export type { MediaKind, MediaPolicyConfig } from "./builtin/mediaPolicy.js";

// Aliased: `defaultBuildPayload` is too generic a name for the shared surface,
// and it is exported at all so a caller can wrap the default instead of
// reconstructing the whole ingestion body to change one field.
export { langfuseTracing, defaultBuildPayload as langfuseDefaultPayload } from "./builtin/langfuse.js";
export type {
  LangfuseBuildContext,
  LangfuseEvent,
  LangfuseEventKind,
  LangfuseTracingConfig,
} from "./builtin/langfuse.js";

export { otelTracing } from "./builtin/otel.js";
export type { OtelTracingConfig } from "./builtin/otel.js";

export { parseApprovalDecision, webhookApproval } from "./builtin/approvalTransport.js";
export type { WebhookApprovalConfig } from "./builtin/approvalTransport.js";

export { detectLanguage, languageGuard } from "./builtin/languageGuard.js";
export type { LanguageGuardConfig } from "./builtin/languageGuard.js";
