// Client-safe entry ("@cognipeer/agent-sdk/model-rules"): the per-model rules and
// their pure helpers, with no Node built-ins in the import graph, so UI bundles
// can resolve the same rules the server uses.
export {
  MODEL_RULES,
  resolveModelRule,
  mapReasoningEffort,
  modelIdCandidates,
  allowsSampling,
  effortBudget,
  resolveReasoningProfile,
} from "./models/rules.js";
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
  ReasoningProfile,
  ReasoningProfileStyle,
} from "./models/rules.js";
export { SERVER_TYPES, normalizeServerType, describeServingReasoning } from "./models/serving.js";
export type { ServerType, ServingReasoningWire, ServingReasoningInfo } from "./models/serving.js";
