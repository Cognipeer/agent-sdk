/**
 * PII redaction — the reference implementation of the mutation path.
 *
 * This plugin never blocks. It rewrites, which is the thing the v1 guardrail
 * engine structurally could not do: a guardrail could only decide that a
 * message containing a national id was unacceptable, not hand back the same
 * message with the id masked.
 *
 * Detectors that can be checksummed are checksummed. A bare 11-digit or
 * 16-digit regex matches order numbers, timestamps and product codes, and a
 * redactor with a high false-positive rate gets switched off — which protects
 * nothing at all.
 */

import type { AgentPlugin, HookContext } from "../types.js";
import type { AIMessage, Message } from "../../types.js";
import { extractMessageText, mapTextParts } from "../../utils/content.js";

export type PiiEntity =
  | "TCKN"
  | "IBAN"
  | "EMAIL"
  | "PHONE_TR"
  | "CREDIT_CARD"
  | "IP"
  | "JWT"
  | "API_KEY";

export type PiiDetector = {
  entity: string;
  pattern: RegExp;
  /** Second-stage check; a match that fails it is not a finding. */
  validate?: (match: string) => boolean;
};

export type PiiRedactionConfig = {
  /** Which built-in detectors to run. Default: all of them. */
  entities?: PiiEntity[];
  /** Extra detectors, run after the built-ins. */
  detectors?: PiiDetector[];
  /** Where to redact. Default: user input, tool output and the final answer. */
  apply?: Array<"input" | "toolOutput" | "modelOutput" | "finalAnswer">;
  /** Build the replacement token. Default: `[REDACTED:ENTITY]`. */
  mask?: (entity: string, match: string) => string;
  /**
   * Keep the last N characters visible (`[REDACTED:IBAN:…4821]`). Useful when
   * the model must still be able to tell two redacted values apart.
   */
  keepLast?: number;
  priority?: number;
  name?: string;
};

// ─── Validators ──────────────────────────────────────────────────────────────

/** Turkish national identification number, with its two checksum digits. */
export function isValidTckn(value: string): boolean {
  const digits = value.replace(/\D/g, "");
  if (digits.length !== 11 || digits[0] === "0") return false;
  const d = digits.split("").map(Number);
  const oddSum = d[0] + d[2] + d[4] + d[6] + d[8];
  const evenSum = d[1] + d[3] + d[5] + d[7];
  // The published algorithm takes a mathematical modulo, but JS `%` keeps the
  // sign of the dividend — without the floor every id where 7*oddSum < evenSum
  // would be read as invalid and passed through unredacted.
  const tenth = (((oddSum * 7 - evenSum) % 10) + 10) % 10;
  if (tenth !== d[9]) return false;
  const firstTen = d.slice(0, 10).reduce((total, digit) => total + digit, 0);
  return firstTen % 10 === d[10];
}

/** Luhn — catches most typos and nearly all non-card digit runs. */
export function isValidLuhn(value: string): boolean {
  const digits = value.replace(/\D/g, "");
  if (digits.length < 13 || digits.length > 19) return false;
  let sum = 0;
  let double = false;
  for (let index = digits.length - 1; index >= 0; index -= 1) {
    let digit = Number(digits[index]);
    if (double) {
      digit *= 2;
      if (digit > 9) digit -= 9;
    }
    sum += digit;
    double = !double;
  }
  return sum % 10 === 0;
}

/** ISO 13616 mod-97 check. */
export function isValidIban(value: string): boolean {
  const normalized = value.replace(/[\s-]/g, "").toUpperCase();
  if (!/^[A-Z]{2}\d{2}[A-Z0-9]{11,30}$/.test(normalized)) return false;
  const rearranged = normalized.slice(4) + normalized.slice(0, 4);
  let remainder = 0;
  for (const char of rearranged) {
    const code = char >= "A" && char <= "Z" ? String(char.charCodeAt(0) - 55) : char;
    for (const digit of code) {
      remainder = (remainder * 10 + Number(digit)) % 97;
    }
  }
  return remainder === 1;
}

const BUILTIN_DETECTORS: Record<PiiEntity, PiiDetector> = {
  TCKN: { entity: "TCKN", pattern: /\b[1-9]\d{10}\b/g, validate: isValidTckn },
  IBAN: { entity: "IBAN", pattern: /\b[A-Z]{2}\d{2}[\s-]?(?:[A-Z0-9][\s-]?){11,30}\b/g, validate: isValidIban },
  EMAIL: { entity: "EMAIL", pattern: /\b[\w.%+-]+@[\w.-]+\.[A-Za-z]{2,}\b/g },
  PHONE_TR: { entity: "PHONE_TR", pattern: /(?:\+90|0)?[\s-]?5\d{2}[\s-]?\d{3}[\s-]?\d{2}[\s-]?\d{2}\b/g },
  CREDIT_CARD: { entity: "CREDIT_CARD", pattern: /\b(?:\d[ -]?){13,19}\b/g, validate: isValidLuhn },
  IP: { entity: "IP", pattern: /\b(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)\b/g },
  JWT: { entity: "JWT", pattern: /\beyJ[\w-]{8,}\.[\w-]{8,}\.[\w-]{8,}\b/g },
  API_KEY: { entity: "API_KEY", pattern: /\b(?:sk|pk|rk|api|key)[-_][A-Za-z0-9_-]{16,}\b/gi },
};

export type RedactionResult = { text: string; findings: Array<{ entity: string; count: number }> };

export function redactText(
  text: string,
  detectors: PiiDetector[],
  mask: (entity: string, match: string) => string,
): RedactionResult {
  if (!text) return { text, findings: [] };
  let output = text;
  const findings: Array<{ entity: string; count: number }> = [];

  for (const detector of detectors) {
    let count = 0;
    // The `g` flag makes the regex stateful; a fresh instance per pass keeps
    // `lastIndex` from leaking between calls on a shared detector object. It is
    // also forced on: a caller-supplied detector without it would mask only the
    // first match while the finding claimed the whole surface was covered.
    const flags = detector.pattern.flags.includes("g")
      ? detector.pattern.flags
      : `${detector.pattern.flags}g`;
    const pattern = new RegExp(detector.pattern.source, flags);
    output = output.replace(pattern, (match) => {
      if (detector.validate && !detector.validate(match)) return match;
      count += 1;
      return mask(detector.entity, match);
    });
    if (count > 0) findings.push({ entity: detector.entity, count });
  }

  return { text: output, findings };
}

export function piiRedaction(config: PiiRedactionConfig = {}): AgentPlugin {
  const entities = config.entities ?? (Object.keys(BUILTIN_DETECTORS) as PiiEntity[]);
  const detectors = [...entities.map((entity) => BUILTIN_DETECTORS[entity]).filter(Boolean), ...(config.detectors ?? [])];
  const applied = new Set(config.apply ?? ["input", "toolOutput", "finalAnswer"]);
  const keepLast = config.keepLast ?? 0;
  const mask =
    config.mask ??
    ((entity: string, match: string) => {
      const tail = keepLast > 0 ? `:…${match.replace(/\s/g, "").slice(-keepLast)}` : "";
      return `[REDACTED:${entity}${tail}]`;
    });

  const announce = (findings: RedactionResult["findings"], ctx: HookContext, where: string) => {
    if (findings.length === 0) return;
    ctx.emit({
      type: "metadata",
      piiRedaction: { where, findings, plugin: config.name ?? "pii-redaction" },
    } as never);
  };

  return {
    name: config.name ?? "pii-redaction",
    // Runs before guardrail plugins (priority 20) on purpose: a guardrail
    // service should receive the masked text, not the raw identifier.
    priority: config.priority ?? 10,
    failureMode: "open",

    hooks: {
      userPromptSubmit: ({ content, text }, ctx) => {
        if (!applied.has("input")) return undefined;
        // `content` is authoritative in the runtime, but a caller driving the
        // host directly (a test harness, a custom embedding) may only supply
        // the text view.
        const target = content ?? text;
        // Per text PART rather than over the joined string: a turn can be
        // "here is my email" + <image> + "and my IBAN", and rewriting the
        // concatenation would merge the two text parts and move the image.
        const findings: RedactionResult["findings"] = [];
        const next = mapTextParts(target, (partText) => {
          const result = redactText(partText, detectors, mask);
          findings.push(...result.findings);
          return result.text;
        });
        if (findings.length === 0) return undefined;
        announce(findings, ctx, "input");
        return Array.isArray(target) ? { content: next as typeof content } : { text: next as string };
      },

      postToolUse: ({ output, toolName }, ctx) => {
        if (!applied.has("toolOutput")) return undefined;
        const asText = typeof output === "string" ? output : safeJson(output);
        if (!asText) return undefined;
        const result = redactText(asText, detectors, mask);
        if (result.findings.length === 0) return undefined;
        announce(result.findings, ctx, `tool:${toolName}`);
        if (typeof output === "string") return { output: result.text };
        try {
          return { output: JSON.parse(result.text) };
        } catch {
          // Masking changed the shape past re-parsing; the redacted string is
          // still strictly better than emitting the raw payload.
          return { output: result.text };
        }
      },

      postModelCall: ({ message }, ctx) => {
        if (!applied.has("modelOutput")) return undefined;
        const text = extractMessageText(message as unknown as Message);
        if (!text) return undefined;
        const result = redactText(text, detectors, mask);
        if (result.findings.length === 0) return undefined;
        announce(result.findings, ctx, "modelOutput");
        return { message: { ...(message as AIMessage), content: result.text } };
      },

      preFinalAnswer: ({ content }, ctx) => {
        if (!applied.has("finalAnswer")) return undefined;
        const result = redactText(content, detectors, mask);
        if (result.findings.length === 0) return undefined;
        announce(result.findings, ctx, "finalAnswer");
        return { content: result.text };
      },
    },
  };
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value) ?? "";
  } catch {
    return "";
  }
}
