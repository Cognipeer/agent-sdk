// A reasoning chat template ends the thinking with a blank line before the
// answer (`</think>\n\n4`). A server that splits the thinking out into its own
// field (`reasoning` / `reasoning_content`) can hand the answer over with that
// blank line still in front: `"\n\n4"`. These helpers remove that separator and
// nothing else: at most two leading line breaks (`\n` or `\r\n`), never spaces
// or tabs, so indented code and Markdown survive. They act only when reasoning
// came back before the answer; the provider applies them only for server types
// that leave the separator (see `leavesReasoningSeparator`).

import type { ChatCompletionChunk, ChatCompletionResponse } from "../types.js";

/** Line breaks of the template's separator that may still be removed. */
const SEPARATOR_BREAKS = 2;

/** Index just past up to `budget` leading line breaks of `text`, and how many were consumed. */
function skipBreaks(text: string, budget: number): { end: number; used: number } {
  let end = 0;
  let used = 0;
  while (used < budget) {
    if (text.startsWith("\r\n", end)) end += 2;
    else if (text[end] === "\n") end += 1;
    else break;
    used++;
  }
  return { end, used };
}

/**
 * The answer without the template's separator, when the reasoning came back in
 * its own field. An answer that was only the separator (a tool call followed)
 * becomes null.
 */
export function stripAnswerSeparator(response: ChatCompletionResponse): ChatCompletionResponse {
  if (!response.reasoning?.summary || typeof response.content !== "string") return response;
  const { end } = skipBreaks(response.content, SEPARATOR_BREAKS);
  if (end === 0) return response;
  const content = response.content.slice(end);
  return { ...response, content: content.length > 0 ? content : null };
}

/** `chunk` with its delta's `content` replaced (removed when `content` is empty or undefined); everything else kept. */
function withContent(chunk: ChatCompletionChunk, content?: string): ChatCompletionChunk {
  const delta = { ...chunk.delta };
  if (content) delta.content = content;
  else delete delta.content;
  return { ...chunk, delta };
}

/**
 * `stripAnswerSeparator` for a stream: after reasoning deltas, the first answer
 * deltas lose up to two leading line breaks in total, however the server split
 * them over chunks (`"\n"`, `"\n"`, `"    print"` gives `"    print"`; a CRLF
 * split as `"\r"`, `"\n"` is one line break). A chunk left empty still arrives,
 * without `content`, with its other fields (usage, finish reason, ...).
 *
 * A chunk whose answer text is a lone trailing `"\r"` (the possible first half of
 * a CRLF) is held back, whole, until the next chunk decides: content starting
 * with `"\n"` completes the line break (the held chunk goes out without content);
 * anything else, or the end of the stream, makes the CR answer text (the held
 * chunk goes out with it, before the next chunk). Usage on a chunk is not an end
 * of the answer (vLLM `continuous_usage_stats` puts it on every chunk); a finish
 * reason is, so a chunk that carries one is never held and every character is
 * out by the time the finish reason arrives. Once the answer has a character
 * that is not one of those line breaks, every chunk passes as it came.
 */
export async function* stripStreamSeparator(
  chunks: AsyncIterable<ChatCompletionChunk>,
): AsyncGenerator<ChatCompletionChunk, void, unknown> {
  let reasoningSeen = false;
  let budget = SEPARATOR_BREAKS;
  let answerStarted = false;
  /** The chunk held back on a lone trailing CR, while the separator budget lasts. */
  let held: ChatCompletionChunk | undefined;
  for await (const chunk of chunks) {
    let current = chunk;
    if (held) {
      const content = current.delta?.content;
      if (typeof content === "string" && content.startsWith("\n")) {
        // CRLF: one separator line break; the rest of this chunk goes on below.
        yield withContent(held);
        budget--;
        current = withContent(current, content.slice(1));
      } else {
        // The CR is answer text.
        yield withContent(held, "\r");
        answerStarted = true;
      }
      held = undefined;
    }
    if (answerStarted) {
      yield current;
      continue;
    }
    if (current.delta?.reasoning?.summary) reasoningSeen = true;
    const content = current.delta?.content;
    if (typeof content !== "string" || content.length === 0) {
      yield current;
      continue;
    }
    if (!reasoningSeen) {
      answerStarted = true;
      yield current;
      continue;
    }
    const { end, used } = skipBreaks(content, budget);
    budget -= used;
    const rest = content.slice(end);
    if (budget > 0 && rest === "\r" && !current.finishReason) {
      held = current;
      continue;
    }
    if (rest.length > 0) answerStarted = true;
    yield end === 0 ? current : withContent(current, rest);
  }
  // The stream ended on the undecided CR: it was answer text.
  if (held) yield withContent(held, "\r");
}
