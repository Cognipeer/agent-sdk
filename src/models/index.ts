export {
  MODEL_RULES,
  resolveModelRule,
  mapReasoningEffort,
  modelIdCandidates,
  allowsSampling,
  applyDropParams,
  effortBudget,
  mergeRulePatch,
  rememberModelRulePatch,
  getLearnedModelRulePatch,
  listLearnedModelRules,
  clearLearnedModelRules,
} from "./rules.js";
export type {
  ModelRule,
  ModelRules,
  ResolvedModelRule,
  RulePatch,
  RuleFamily,
  RuleSource,
  ReasoningStyle,
  OffMechanism,
  TemperatureRule,
  MaxTokensParam,
  EffortMapping,
  SamplingField,
  ReasoningEffort,
} from "./rules.js";
export { ModelRequestError } from "./errors.js";
export type { ModelRequestErrorCode, ModelRequestErrorInit } from "./errors.js";
export { parseModelError, runWithModelAdjustments, asModelRequestError, MAX_ADJUSTMENTS } from "./adjust.js";
export type { ModelRuleLearnedEvent, ParsedModelError } from "./adjust.js";
