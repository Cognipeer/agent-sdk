import { GuardrailPhase, type ConversationGuardrail } from "../types.js";
import { evaluateGuardrails, createGuardrail } from "./engine.js";
import {
  regexRule,
  jsonSchemaRule,
  codePresenceRule,
  agentVerdictRule,
  customCallbackRule,
} from "./checks.js";
import type {
  RegexRuleOptions,
  JsonSchemaRuleOptions,
  CodeDetectionRuleOptions,
  AgentRuleOptions,
  GuardrailJudgeEngine,
  JevEngineOptions,
  JevClientLike,
  JevNoulAnswer,
  JevSystemOneResult,
  JevUsage,
  CustomRuleOptions,
  CustomRuleCallback,
} from "./checks.js";

export {
  evaluateGuardrails,
  createGuardrail,
  regexRule,
  jsonSchemaRule,
  codePresenceRule,
  agentVerdictRule,
  customCallbackRule,
};

export type {
  RegexRuleOptions,
  JsonSchemaRuleOptions,
  CodeDetectionRuleOptions,
  AgentRuleOptions,
  GuardrailJudgeEngine,
  JevEngineOptions,
  JevClientLike,
  JevNoulAnswer,
  JevSystemOneResult,
  JevUsage,
  CustomRuleOptions,
  CustomRuleCallback,
};

type GuardrailPresetBase = {
  guardrailId?: string;
  guardrailTitle?: string;
  guardrailDescription?: string;
  phases?: GuardrailPhase[];
  haltOnViolation?: boolean;
  onViolation?: ConversationGuardrail["onViolation"];
  metadata?: Record<string, any>;
};

export type RegexGuardrailOptions = GuardrailPresetBase & {
  rule?: Omit<RegexRuleOptions, "pattern">;
};

export function createRegexGuardrail(
  pattern: RegExp | string,
  options?: RegexGuardrailOptions
): ConversationGuardrail {
  const rule = regexRule({ pattern, ...(options?.rule || {}) });
  return createGuardrail({
    id: options?.guardrailId,
    title: options?.guardrailTitle || options?.rule?.title || "Regex Guardrail",
    description: options?.guardrailDescription || options?.rule?.description,
    appliesTo: options?.phases,
    checks: [rule],
    haltOnViolation: options?.haltOnViolation,
    onViolation: options?.onViolation,
    metadata: options?.metadata,
  });
}

export type JsonGuardrailOptions = GuardrailPresetBase & {
  rule?: Omit<JsonSchemaRuleOptions, "schema">;
};

export function createJsonGuardrail(
  schema: JsonSchemaRuleOptions["schema"],
  options?: JsonGuardrailOptions
): ConversationGuardrail {
  const rule = jsonSchemaRule({ schema, ...(options?.rule || {}) });
  return createGuardrail({
    id: options?.guardrailId,
    title: options?.guardrailTitle || options?.rule?.title || "JSON Schema Guardrail",
    description: options?.guardrailDescription || options?.rule?.description,
    appliesTo: options?.phases,
    checks: [rule],
    haltOnViolation: options?.haltOnViolation,
    onViolation: options?.onViolation,
    metadata: options?.metadata,
  });
}

export type CodeGuardrailOptions = GuardrailPresetBase & {
  rule?: CodeDetectionRuleOptions;
};

export function createCodeGuardrail(options?: CodeGuardrailOptions): ConversationGuardrail {
  const ruleOptions = { disposition: "warn" as const, ...(options?.rule || {}) };
  const rule = codePresenceRule(ruleOptions);
  return createGuardrail({
    id: options?.guardrailId,
    title: options?.guardrailTitle || ruleOptions.title || "Code Presence Guardrail",
    description: options?.guardrailDescription || ruleOptions.description,
    appliesTo: options?.phases,
    checks: [rule],
    haltOnViolation: options?.haltOnViolation,
    onViolation: options?.onViolation,
    metadata: options?.metadata,
  });
}
