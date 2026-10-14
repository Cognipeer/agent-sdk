/**
 * Claude 5.x Sonnet / Opus reject forced tool use (`tool_choice` of type "any"
 * or "tool") with a 400. Haiku and older models accept it.
 */
export function supportsForcedToolChoice(model: unknown): boolean {
  if (typeof model !== "string") return true;
  const id = model.toLowerCase();
  const at = id.indexOf("claude-");
  if (at < 0) return true;
  const toks = id.slice(at + 7).split("-");
  let family = false;
  for (const tok of toks) {
    if (tok === "sonnet" || tok === "opus") {
      family = true;
      continue;
    }
    const m = /^(\d+)(?:@|:|$)/.exec(tok); // also Vertex-style `5@20260101`
    if (m) {
      if (m[1].length > 2) continue; // date suffix
      // Version number: if the family came before it, decide now; for the
      // `claude-5-sonnet` ordering keep scanning for the family.
      if (Number(m[1]) < 5) return true;
      if (family) return false;
      return !toks.some((t) => t === "sonnet" || t === "opus");
    }
  }
  return true;
}

/** True for the upstream 400 that says this model refuses forced tool_choice.
 * Plain substring checks only. */
export function forcedToolChoiceRejected(text: string): boolean {
  const t = text.toLowerCase();
  return t.indexOf("tool_choice") >= 0 && t.indexOf("not supported for this model") >= 0;
}
