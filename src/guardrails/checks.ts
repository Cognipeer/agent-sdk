import AjvModule, { type ValidateFunction, type ErrorObject, type Options } from "ajv";
import { z } from "zod";
import type { JSONSchema7 } from "json-schema";
import type {
  GuardrailRule,
  GuardrailContext,
  GuardrailDisposition,
  SmartAgentInstance,
} from "../types.js";
import { contentToString, mergeContentsToString } from "../utils/content.js";

const Ajv = (AjvModule as unknown as { default?: new (options?: Options) => any })?.default ?? (AjvModule as unknown as new (options?: Options) => any);
const defaultAjv = new Ajv({ allErrors: true } satisfies Options);
(defaultAjv as any).opts.strict = false;

function ensureRegExp(pattern: RegExp | string, flags?: string): RegExp {
  if (pattern instanceof RegExp) return pattern;
  return new RegExp(pattern, flags ?? "i");
}

function latestText(context: GuardrailContext): string {
  return contentToString(context.latestMessage?.content ?? "");
}

function threadText(context: GuardrailContext): string {
  return mergeContentsToString(context.messages.map((msg) => msg.content));
}

export type RegexRuleOptions = {
  id?: string;
  title?: string;
  description?: string;
  pattern: RegExp | string;
  flags?: string;
  matchDisposition?: GuardrailDisposition;
  selector?: (context: GuardrailContext) => string;
  allowIfMatch?: boolean;
  failureMessage?: string;
};

export function regexRule(options: RegexRuleOptions): GuardrailRule {
  const regex = ensureRegExp(options.pattern, options.flags);
  const selector = options.selector || latestText;
  const failureMessage =
    options.failureMessage || `Message violates pattern: ${regex.toString()}`;
  const matchDisposition = options.matchDisposition || "block";
  const allowIfMatch = options.allowIfMatch === true;

  return {
    id: options.id,
    title: options.title || "Regex compliance",
    description: options.description,
    async evaluate(context) {
      const text = selector(context) ?? "";
      const matches = regex.test(text);
      const passed = allowIfMatch ? matches : !matches;
      const disposition = matches ? matchDisposition : "allow";
      return {
        passed,
        reason: matches ? failureMessage : undefined,
        disposition,
        details: matches ? { pattern: regex.toString(), textSnippet: text.slice(0, 200) } : undefined,
      };
    },
  };
}

export type JsonSchemaRuleOptions = {
  id?: string;
  title?: string;
  description?: string;
  schema: JSONSchema7 | z.ZodTypeAny;
  selector?: (context: GuardrailContext) => string;
  disposition?: GuardrailDisposition;
  allowOnParseError?: boolean;
};

function compileValidator(
  schema: JSONSchema7 | z.ZodTypeAny
): ((input: unknown) => { valid: boolean; errors?: string[] }) {
  if ((schema as z.ZodTypeAny)?._def) {
    const typed = schema as z.ZodTypeAny;
    return (input: unknown) => {
      const result = typed.safeParse(input);
      return {
        valid: result.success,
        errors: result.success
          ? undefined
          : result.error.issues.map((issue) => issue.message),
      };
    };
  }

  const validator: ValidateFunction = defaultAjv.compile(schema as JSONSchema7);
  return (input: unknown) => {
    const valid = validator(input);
    const errors = (validator.errors as ErrorObject[] | null | undefined)?.map((err) => {
      const path = ("instancePath" in err && typeof err.instancePath === "string" && err.instancePath.length > 0)
        ? err.instancePath
        : ((err as any).dataPath as string | undefined);
      return `${path || "/"} ${err.message || "invalid"}`;
    });
    return { valid: !!valid, errors };
  };
}

export function jsonSchemaRule(options: JsonSchemaRuleOptions): GuardrailRule {
  const selector = options.selector || latestText;
  const disposition = options.disposition || "block";
  const validator = compileValidator(options.schema);

  return {
    id: options.id,
    title: options.title || "JSON schema validation",
    description: options.description,
    async evaluate(context) {
      const text = selector(context) ?? "";
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch (err) {
        if (options.allowOnParseError) {
          return { passed: true };
        }
        return {
          passed: false,
          disposition,
          reason: "Message content is not valid JSON.",
          details: { error: err instanceof Error ? err.message : String(err) },
        };
      }

      const result = validator(parsed);
      if (result.valid) {
        return { passed: true };
      }
      return {
        passed: false,
        disposition,
        reason: "Message JSON failed schema validation.",
        details: { errors: result.errors },
      };
    },
  };
}

export type CodeDetectionRuleOptions = {
  id?: string;
  title?: string;
  description?: string;
  selector?: (context: GuardrailContext) => string;
  disposition?: GuardrailDisposition;
  allowList?: Array<RegExp | string>;
};

function containsAllowListed(text: string, allowList?: Array<RegExp | string>): boolean {
  if (!allowList?.length) return false;
  return allowList.some((pattern) => ensureRegExp(pattern).test(text));
}

const codePattern = /```[\s\S]*?```|\b(function|class|import|export|const|let|var)\b|<[^>]+>/i;

export function codePresenceRule(options: CodeDetectionRuleOptions = {}): GuardrailRule {
  const selector = options.selector || latestText;
  const disposition = options.disposition || "warn";

  return {
    id: options.id,
    title: options.title || "Code presence detection",
    description: options.description,
    async evaluate(context) {
      const text = selector(context) ?? "";
      if (!text) return { passed: true };
      if (containsAllowListed(text, options.allowList)) {
        return { passed: true };
      }
      const matches = codePattern.test(text);
      if (!matches) return { passed: true };
      return {
        passed: false,
        disposition,
        reason: "Potential code content detected in message.",
        details: { snippet: text.slice(0, 200) },
      };
    },
  };
}

const guardianSchema = z.object({
  allow: z.boolean().describe("Whether the message should be allowed."),
  disposition: z.enum(["allow", "warn", "block"]).optional(),
  reason: z
    .string()
    .max(400, "Reason must be 400 characters or fewer.")
    .optional(),
  details: z.record(z.any()).optional(),
});

/** Which judge backend `agentVerdictRule` uses to produce its verdict. */
export type GuardrailJudgeEngine = "llm" | "jev";

/** Token usage reported by a Jev `systemOne` call. */
export type JevUsage = {
  readonly input_tokens: number;
  readonly output_tokens: number;
};

/** Answer shape returned for a Jev `noul` (yes/no probability) question. */
export type JevNoulAnswer = {
  readonly type: "noul";
  /** Probability of a "yes" answer, from zero to one. */
  readonly noul: number;
};

export type JevSystemOneResult = {
  readonly model?: string;
  readonly answers?: Record<string, JevNoulAnswer | { readonly type: string } | undefined>;
  readonly usage?: JevUsage;
};

/**
 * Structural subset of `@typesafe-ai/sdk`'s `TypeSafeClient`.
 * Declared locally so the optional peer dependency is never referenced by the
 * published type declarations.
 */
export type JevClientLike = {
  systemOne(
    request: { state: any; questions: Record<string, any>; model?: string },
    options?: any
  ): PromiseLike<JevSystemOneResult>;
};

export type JevEngineOptions = {
  /** Pre-built `TypeSafeClient` (or compatible stub). Skips the dynamic import entirely. */
  client?: JevClientLike;
  /** API key; falls back to the SDK's own `TYPESAFE_API_KEY` convention. */
  apiKey?: string;
  /** API root; falls back to the SDK's own `TYPESAFE_BASE_URL` convention. */
  baseURL?: string;
  /** Model override; falls back to the SDK's own `TYPESAFE_DEFAULT_MODEL` convention. */
  model?: string;
  /** Risk probability at or above which the message fails the rule. Defaults to 0.5. */
  threshold?: number;
  /** Customizes the `noul` question instructions, mirroring `payloadBuilder`. */
  question?: (context: GuardrailContext) => string;
  /** Optional descriptions of the yes/no outcomes passed to the `noul` question. */
  criteria?: { true?: string; false?: string };
};

export type AgentRuleOptions = {
  id?: string;
  title?: string;
  description?: string;
  /** Guardian agent. Required for the default `"llm"` engine; unused by `"jev"`. */
  agent?: SmartAgentInstance<z.infer<typeof guardianSchema>>;
  systemPrompt?: string;
  payloadBuilder?: (context: GuardrailContext) => string;
  dispositionFallback?: GuardrailDisposition;
  /** Judge backend. Defaults to `"llm"` for full backward compatibility. */
  engine?: GuardrailJudgeEngine;
  /** Configuration for the `"jev"` engine. Ignored by the `"llm"` engine. */
  jev?: JevEngineOptions;
};

function defaultPayload(context: GuardrailContext): string {
  const latest = latestText(context);
  const transcript = threadText(context);
  return JSON.stringify(
    {
      phase: context.phase,
      latestMessage: latest,
      transcript,
      metadata: {
        runtime: {
          name: context.runtime?.name,
          version: context.runtime?.version,
        },
      },
    },
    null,
    2
  );
}

const DEFAULT_JEV_THRESHOLD = 0.5;
const JEV_QUESTION_KEY = "shouldBlock";
const DEFAULT_JEV_QUESTION =
  "Does this conversation payload pose a safety, security, or policy risk that should stop the agent from continuing? Answer yes when the latest message or action should be blocked, and no when it is safe to allow.";
const DEFAULT_JEV_CRITERIA = {
  true: "The payload is unsafe, non-compliant, or otherwise warrants blocking.",
  false: "The payload is benign and the agent should be allowed to continue.",
};

async function resolveJevClient(config: JevEngineOptions): Promise<JevClientLike> {
  if (config.client) return config.client;

  let mod: any;
  try {
    // @ts-ignore - optional peer dependency; it may not be installed, and the
    // build must not depend on its type declarations being resolvable.
    mod = await import("@typesafe-ai/sdk");
  } catch {
    throw new Error(
      "Jev engine requires @typesafe-ai/sdk to be installed. Run `npm install @typesafe-ai/sdk`, or pass a pre-built client via `jev.client`."
    );
  }

  const ClientCtor = mod?.TypeSafeClient ?? mod?.default?.TypeSafeClient;
  if (typeof ClientCtor !== "function") {
    throw new Error("@typesafe-ai/sdk did not export a TypeSafeClient constructor.");
  }

  const clientConfig: Record<string, string> = {};
  if (config.apiKey) clientConfig.apiKey = config.apiKey;
  if (config.baseURL) clientConfig.baseURL = config.baseURL;
  if (config.model) clientConfig.defaultModel = config.model;
  return new ClientCtor(clientConfig) as JevClientLike;
}

export function agentVerdictRule(options: AgentRuleOptions): GuardrailRule {
  const payloadBuilder = options.payloadBuilder || defaultPayload;
  const fallbackDisposition = options.dispositionFallback || "block";
  const engine = options.engine || "llm";
  const jevOptions = options.jev || {};
  const jevThreshold =
    typeof jevOptions.threshold === "number" ? jevOptions.threshold : DEFAULT_JEV_THRESHOLD;
  let jevClientPromise: Promise<JevClientLike> | undefined;

  async function evaluateWithJev(context: GuardrailContext) {
    if (!jevClientPromise) {
      jevClientPromise = resolveJevClient(jevOptions).catch((err) => {
        jevClientPromise = undefined;
        throw err;
      });
    }
    const client = await jevClientPromise;

    const instructions = jevOptions.question
      ? jevOptions.question(context)
      : DEFAULT_JEV_QUESTION;

    const result = await client.systemOne({
      state: payloadBuilder(context),
      questions: {
        [JEV_QUESTION_KEY]: {
          type: "noul",
          instructions,
          criteria: jevOptions.criteria ?? DEFAULT_JEV_CRITERIA,
        },
      },
      ...(jevOptions.model ? { model: jevOptions.model } : {}),
    });

    const answer = result?.answers?.[JEV_QUESTION_KEY] as JevNoulAnswer | undefined;
    const probability = typeof answer?.noul === "number" ? answer.noul : undefined;
    if (probability === undefined) {
      return {
        passed: false,
        disposition: fallbackDisposition,
        reason: "Jev engine did not return a noul probability.",
        details: { jevModel: result?.model, jevUsage: result?.usage },
      };
    }

    const passed = probability < jevThreshold;
    return {
      passed,
      disposition: passed ? ("allow" as GuardrailDisposition) : fallbackDisposition,
      reason: passed
        ? undefined
        : `Jev risk probability ${probability.toFixed(3)} met or exceeded threshold ${jevThreshold}.`,
      details: {
        jevProbability: probability,
        jevThreshold,
        jevModel: result?.model,
        jevUsage: result?.usage,
      },
    };
  }

  return {
    id: options.id,
    title: options.title || "Agent-based guardrail",
    description: options.description,
    async evaluate(context) {
      if (engine === "jev") {
        return evaluateWithJev(context);
      }

      if (!options.agent) {
        throw new Error("agentVerdictRule requires an `agent` when using the default 'llm' engine.");
      }

      const payload = payloadBuilder(context);
      const systemPrompt =
        options.systemPrompt ||
        "You are a safety auditor. Review the provided conversation payload and decide whether it should continue. Return JSON with keys allow (boolean), optional disposition ('allow' | 'warn' | 'block'), optional reason (string), and optional details (object).";

      const review = await options.agent.invoke({
        messages: [
          { role: "system", content: systemPrompt } as any,
          { role: "user", content: payload } as any,
        ],
      });

      let parsed = review.output;
      if (!parsed) {
        try {
          parsed = guardianSchema.parse(JSON.parse(review.content));
        } catch {
          parsed = guardianSchema.parse({ allow: false, reason: "Guard agent did not return structured output." });
        }
      }

      const disposition = parsed.disposition || (parsed.allow ? "allow" : fallbackDisposition);
      return {
        passed: parsed.allow,
        disposition,
        reason: parsed.reason,
        details: parsed.details,
      };
    },
  };
}

export type CustomRuleCallback = (
  context: GuardrailContext
) =>
  | boolean
  | {
      allow: boolean;
      reason?: string;
      disposition?: GuardrailDisposition;
      details?: Record<string, any>;
    }
  | Promise<
      | boolean
      | {
          allow: boolean;
          reason?: string;
          disposition?: GuardrailDisposition;
          details?: Record<string, any>;
        }
    >;

export type CustomRuleOptions = {
  id?: string;
  title?: string;
  description?: string;
  callback: CustomRuleCallback;
  defaultDisposition?: GuardrailDisposition;
};

export function customCallbackRule(options: CustomRuleOptions): GuardrailRule {
  const fallbackDisposition = options.defaultDisposition || "block";
  return {
    id: options.id,
    title: options.title || "Custom callback guardrail",
    description: options.description,
    async evaluate(context) {
      const outcome = await options.callback(context);
      if (typeof outcome === "boolean") {
        return {
          passed: outcome,
          disposition: outcome ? "allow" : fallbackDisposition,
        };
      }
      return {
        passed: outcome.allow,
        disposition: outcome.disposition || (outcome.allow ? "allow" : fallbackDisposition),
        reason: outcome.reason,
        details: outcome.details,
      };
    },
  };
}
