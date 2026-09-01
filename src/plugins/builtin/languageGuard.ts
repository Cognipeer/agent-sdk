/**
 * Keeps the assistant answering in the language it is supposed to answer in.
 *
 * The failure this fixes is mundane and constant: a Turkish user asks a
 * question, a tool returns an English document, and the model drifts into the
 * language of its context instead of the language of its reader.
 *
 * Two hooks, because the problem has two halves:
 *   - `preModelCall` adds a system-level instruction naming the required
 *     language to every call. This is the half that actually fixes drift —
 *     prevention, on the request, where the model can still act on it.
 *   - `preFinalAnswer` measures the answer and, under `action: "deny"`, refuses
 *     it with a reason naming both the detected and the required language, so
 *     the loop gets a specific, actionable correction instead of a retry.
 *
 * `deny` is a BACKSTOP FOR DRIFT, not a gate you can demonstrate on demand.
 * The instruction the first hook adds is the last message on the wire, so it
 * outranks a user asking for another language: measured against a real model,
 * five of five attempts to force a mismatch came back in the required language
 * and the refusal never fired. That is the design working — prevention is the
 * fix, enforcement is the safety net for the long tail where it slips. Enable
 * `deny` for that tail, not for a guarantee, and pin `detect` if you need a
 * deterministic test.
 *
 * Note what is deliberately NOT done. `preFinalAnswer` does not rewrite the
 * answer: translating locally would return text the model never wrote and
 * nobody reviewed (the same reasoning `outputGuard` gives for only repairing
 * `maxChars`). And a mismatch is not surfaced at `userPromptSubmit` either —
 * the user's language is not the thing being constrained.
 *
 * ── The detector is a heuristic ─────────────────────────────────────────────
 * `detectLanguage` is stopwords plus script and diacritic evidence. It is fast,
 * dependency-free and offline, and it is wrong on short text: "Ok" and "Merci"
 * carry no signal, and a two-sentence answer full of code and proper nouns
 * carries very little. `minChars` (default 40, measured after code fences,
 * inline code, URLs and e-mail addresses are removed) is the guard against
 * judging text that cannot be judged, and an undetectable answer is always
 * allowed. Pass `detect` to swap in a real classifier when the cost is worth it.
 */

import type { AgentPlugin, HookContext } from "../types.js";
import type { Message } from "../../types.js";

export type LanguageGuardConfig = {
  /**
   * BCP-47-ish tag the answer must be in ("tr", "en-GB"). Only the base subtag
   * is compared. The function form reads it per run — typically off
   * `state.metadata` for a per-user locale.
   */
  language: string | ((ctx: HookContext) => string | undefined);
  /**
   * `instruct` (default) only steers the request. `deny` additionally refuses a
   * final answer in the wrong language, costing an extra model turn.
   */
  action?: "deny" | "instruct";
  /** Replace the built-in heuristic. Receives the answer with code/URLs stripped. */
  detect?: (text: string) => string | undefined;
  /** Below this many characters of prose the answer is never judged. Default 40. */
  minChars?: number;
  name?: string;
  priority?: number;
};

// ─── Detection ───────────────────────────────────────────────────────────────

/**
 * Code, identifiers and URLs are English-shaped in every language and are the
 * single biggest source of false "this answer is in English" verdicts, so they
 * are removed before anything is counted or measured.
 */
function stripNoise(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`[^`\n]*`/g, " ")
    .replace(/https?:\/\/\S+/g, " ")
    .replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, " ");
}

type LatinProfile = {
  code: string;
  /** Function words: the strongest cheap signal in a Latin-script language. */
  stopwords: Set<string>;
  /** Characters that all but pin this language down. */
  strongChars?: RegExp;
  /** Diacritics several of these languages share — weak evidence alone. */
  weakChars?: RegExp;
};

const words = (list: string) => new Set(list.split(" "));

const LATIN_PROFILES: LatinProfile[] = [
  {
    code: "tr",
    stopwords: words("ve bir bu için ile de da mi ne çok daha var yok değil ama gibi olarak olduğunu sonra kadar"),
    // ı, ğ, ş and the dotted capital İ do not occur in the other profiles here;
    // ç/ö/ü do, which is why they are only weak evidence.
    strongChars: /[ığşĞŞİ]/g,
    weakChars: /[çöüÇÖÜ]/g,
  },
  {
    code: "en",
    stopwords: words("the and is are was were of to in that for with you it this on be have has not from will can your"),
  },
  {
    code: "de",
    stopwords: words("der die das und ist nicht ein eine mit für sich auch den dem zu ich wir aber oder wird haben sind noch"),
    strongChars: /[äßÄ]/g,
    weakChars: /[öüÖÜ]/g,
  },
  {
    code: "fr",
    stopwords: words("le les des une est et dans pour avec pas qui que du je nous mais sur plus au ce vous être"),
    strongChars: /[éèêàôûœÉÈÊÀ]/g,
    weakChars: /[çÇ]/g,
  },
  {
    code: "es",
    stopwords: words("el los las una un y es de que para con por se pero muy como del está son más también"),
    strongChars: /[ñáíóúÑ¿¡]/g,
    weakChars: /[éÉ]/g,
  },
];

function countMatches(text: string, pattern: RegExp): number {
  const matches = text.match(pattern);
  return matches ? matches.length : 0;
}

/**
 * Best-effort language of a piece of text: a script check first (a non-Latin
 * script settles it outright), then stopword and diacritic scoring across the
 * Latin profiles. Returns `undefined` when the evidence is thin or two
 * languages score within a point of each other — saying "I don't know" is the
 * only honest answer a heuristic this small can give, and every caller here
 * treats it as "allow".
 */
export function detectLanguage(text: string): string | undefined {
  const cleaned = stripNoise(text);
  const letters = countMatches(cleaned, /\p{L}/gu);
  if (letters === 0) return undefined;

  const arabic = countMatches(cleaned, /[\u0600-\u06FF\u0750-\u077F]/g);
  // A fifth of the letters in an Arabic block is not something Latin prose does
  // by accident; the ratio (rather than a count) keeps a quoted phrase from
  // flipping a long English answer.
  if (arabic / letters >= 0.2) return "ar";

  // Locale-independent lowercasing on purpose: `toLocaleLowerCase("tr")` maps
  // every English "I" to "ı" and would manufacture the exact Turkish signal
  // this function is trying to measure.
  const tokens = cleaned.toLowerCase().split(/[^\p{L}\p{M}']+/u).filter(Boolean);

  let best: { code: string; score: number } | undefined;
  let runnerUp = 0;
  for (const profile of LATIN_PROFILES) {
    let score = 0;
    for (const token of tokens) if (profile.stopwords.has(token)) score += 1;
    // Diacritics are capped: one heavily accented word should not outweigh a
    // page of function words.
    if (profile.strongChars) score += Math.min(countMatches(cleaned, profile.strongChars), 4) * 1.5;
    if (profile.weakChars) score += Math.min(countMatches(cleaned, profile.weakChars), 4) * 0.25;

    if (!best || score > best.score) {
      runnerUp = best?.score ?? runnerUp;
      best = { code: profile.code, score };
    } else if (score > runnerUp) {
      runnerUp = score;
    }
  }

  if (!best || best.score < 2 || best.score - runnerUp < 1) return undefined;
  return best.code;
}

// ─── Naming ──────────────────────────────────────────────────────────────────

const LANGUAGE_NAMES: Record<string, string> = {
  ar: "Arabic",
  de: "German",
  en: "English",
  es: "Spanish",
  fr: "French",
  it: "Italian",
  nl: "Dutch",
  pt: "Portuguese",
  ru: "Russian",
  tr: "Turkish",
};

/** Compare on the base subtag: "tr-TR" and "tr" are the same requirement. */
function baseTag(tag: string | undefined): string | undefined {
  const base = tag?.trim().toLowerCase().split(/[-_]/)[0];
  return base ? base : undefined;
}

/** Names the language for a human and for the model, tag included so an unknown tag still reads. */
function describe(tag: string): string {
  const name = LANGUAGE_NAMES[tag];
  return name ? `${name} (${tag})` : tag;
}

// ─── Plugin ──────────────────────────────────────────────────────────────────

export function languageGuard(config: LanguageGuardConfig): AgentPlugin {
  const name = config.name ?? "language-guard";
  const action = config.action ?? "instruct";
  const minChars = config.minChars ?? 40;
  const detect = config.detect ?? detectLanguage;

  const required = (ctx: HookContext): string | undefined =>
    baseTag(typeof config.language === "function" ? config.language(ctx) : config.language);

  const instructionFor = (tag: string) =>
    `Language requirement: write every response entirely in ${describe(tag)}, whatever language the ` +
    `user's request, the tool results or any retrieved document happen to be in. Leave code, identifiers, ` +
    `URLs and proper nouns as they are.`;

  return {
    name,
    // After redaction and the guardrail transports (10-25) so a mismatch is
    // judged on the text the reader will actually see, and next to `outputGuard`
    // (800) because both are final-answer contract checks — 810 so a hard
    // contract failure is reported before a language mismatch is.
    priority: config.priority ?? 810,
    // A heuristic detector is never allowed to be the thing that stops an agent.
    failureMode: "open",

    hooks: {
      preModelCall: ({ messages }, ctx) => {
        const tag = required(ctx);
        if (!tag) return undefined;
        const instruction = instructionFor(tag);

        const marker = (message: Message) => (message as Record<string, unknown>).__languageGuard === name;
        const existing = messages.filter(marker);
        // Idempotent: the loop calls this hook once per iteration over messages
        // that may already carry the instruction, and appending each time would
        // grow the prompt without bound.
        if (existing.length === 1 && existing[0] === messages[messages.length - 1] && existing[0].content === instruction) {
          return undefined;
        }

        const rest = messages.filter((message) => !marker(message));
        // Appended rather than prepended: the instruction competes with the
        // language of tool output and retrieved documents that sit late in the
        // transcript, and recency is what wins that competition. It also leaves
        // any existing leading system message exactly where the provider wants it.
        return {
          messages: [...rest, { role: "system", content: instruction, __languageGuard: name } as Message],
        };
      },

      preFinalAnswer: ({ content }, ctx) => {
        const tag = required(ctx);
        if (!tag) return undefined;

        const prose = stripNoise(content ?? "").trim();
        // Short answers carry no reliable signal; judging them would deny
        // correct one-word replies for no reason.
        if (prose.length < minChars) return undefined;

        const detected = baseTag(detect(prose));
        if (!detected || detected === tag) return undefined;

        ctx.emit({
          type: "metadata",
          languageMismatch: { plugin: name, expected: tag, detected, enforced: action === "deny" },
        } as never);

        if (action !== "deny") return undefined;
        return {
          decision: "deny",
          reason:
            `Answer appears to be in ${describe(detected)} but the required language is ${describe(tag)}. ` +
            `Rewrite the entire answer in ${describe(tag)}.`,
        };
      },
    },
  };
}
