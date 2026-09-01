import { nanoid } from "nanoid";
import { GuardrailPhase } from "../types.js";
import type {
  ConversationGuardrail,
  GuardrailContext,
  GuardrailIncident,
  GuardrailOutcome,
  GuardrailRule,
  GuardrailDisposition,
  SmartState,
  SmartAgentOptions,
  AgentRuntimeConfig,
  SmartAgentEvent,
} from "../types.js";

export type GuardrailEvaluationParams = {
  guardrails?: ConversationGuardrail[];
  phase: GuardrailPhase;
  state: SmartState;
  runtime: AgentRuntimeConfig;
  options: SmartAgentOptions;
  emit?: (event: SmartAgentEvent) => void;
};

function ensureArray<T>(value: T[] | undefined): T[] {
  return Array.isArray(value) ? value : [];
}

function buildContext(
  params: Omit<GuardrailEvaluationParams, "guardrails" | "emit">
): GuardrailContext {
  const latest = params.state.messages[params.state.messages.length - 1];
  return {
    phase: params.phase,
    messages: params.state.messages,
    latestMessage: latest,
    state: params.state,
    runtime: params.runtime,
    options: params.options,
  };
}

function normalizeDisposition(
  passed: boolean,
  disposition?: GuardrailDisposition
): GuardrailDisposition {
  if (disposition) return disposition;
  return passed ? "allow" : "block";
}

export async function evaluateGuardrails(
  params: GuardrailEvaluationParams
): Promise<GuardrailOutcome> {
  const incidents: GuardrailIncident[] = [];
  const guardrails = ensureArray(params.guardrails).filter((guardrail) =>
    ensureArray(guardrail.appliesTo).includes(params.phase)
  );

  if (guardrails.length === 0) {
    return { ok: true, incidents };
  }

  const context = buildContext(params);

  for (const guardrail of guardrails) {
    for (const rule of ensureArray(guardrail.rules)) {
      let result: Awaited<ReturnType<GuardrailRule["evaluate"]>>;
      try {
        result = await rule.evaluate(context);
      } catch (err) {
        // A throw is an availability event, not a verdict. Which one it becomes
        // is the guardrail author's call: "closed" (the default, and the
        // historical behaviour) blocks, "open" records a warning and continues,
        // so a transient backend blip does not hard-block every turn.
        result = {
          passed: false,
          reason: err instanceof Error ? err.message : String(err ?? "Unknown error"),
          details: { thrown: true },
          disposition: (guardrail.failureMode === "open" ? "warn" : "block") as GuardrailDisposition,
        } as Awaited<ReturnType<GuardrailRule["evaluate"]>>;
      }

      const passed = result?.passed !== false;
      const disposition = normalizeDisposition(passed, result?.disposition);

      if (passed && disposition === "allow") {
        continue;
      }

      const incident: GuardrailIncident = {
        guardrailId: guardrail.id ?? rule.id ?? nanoid(8),
        guardrailTitle: guardrail.title,
        ruleId: rule.id,
        ruleTitle: rule.title,
        phase: params.phase,
        reason: result?.reason,
        details: result?.details,
        disposition,
      };

      let effectiveDisposition = incident.disposition;
      if (typeof guardrail.onViolation === "function") {
        try {
          const override = await guardrail.onViolation(incident, context);
          if (override) {
            effectiveDisposition = override;
            incident.disposition = override;
          }
        } catch (err) {
          effectiveDisposition = "block";
          incident.disposition = "block";
          incident.details = {
            ...(incident.details || {}),
            onViolationError: err instanceof Error ? err.message : String(err ?? "Unknown error"),
          };
          if (!incident.reason) {
            incident.reason = "Guardrail onViolation handler threw an error.";
          }
        }
      }

      incidents.push(incident);

      params.emit?.({
        type: "guardrail",
        phase: params.phase,
        guardrailId: incident.guardrailId,
        guardrailTitle: incident.guardrailTitle,
        ruleId: incident.ruleId,
        ruleTitle: incident.ruleTitle,
        disposition: effectiveDisposition,
        reason: incident.reason,
        details: incident.details,
      });

      if (effectiveDisposition === "block" && guardrail.haltOnViolation !== false) {
        break;
      }
    }
  }

  const ok = incidents.every((incident) => incident.disposition !== "block");
  return { ok, incidents };
}

export type CreateGuardrailOptions = {
  id?: string;
  title?: string;
  description?: string;
  appliesTo?: GuardrailPhase[];
  checks: GuardrailRule[];
  haltOnViolation?: boolean;
  onViolation?: ConversationGuardrail["onViolation"];
  metadata?: Record<string, any>;
};

export function createGuardrail(options: CreateGuardrailOptions): ConversationGuardrail {
  const appliesTo = options.appliesTo?.length
    ? options.appliesTo
    : [GuardrailPhase.Request, GuardrailPhase.Response];

  return {
    id: options.id,
    title: options.title,
    description: options.description,
    appliesTo,
    rules: options.checks,
    haltOnViolation: options.haltOnViolation,
    onViolation: options.onViolation,
    metadata: options.metadata,
  };
}
