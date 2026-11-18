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
 * split as `"\r"`, `"\n"` is one line break). Chunks pass in order with every
 * field they carry; a chunk left empty still arrives, without `content`.
 *
 * A lone trailing `"\r"` in the answer text (the possible first half of a CRLF)
 * is taken out of its chunk and kept undecided, across any chunks without answer
 * text (an empty delta, `content: ""`, reasoning or usage only), until one of:
 *  - answer text starting with `"\n"`: the CRLF is one separator line break;
 *  - other answer text: the CR is answer text and goes in front of it;
 *  - a finish reason: the CR is answer text and goes out with that chunk, so
 *    every character is out by the time the finish reason arrives (a chunk that
 *    carries one never leaves a CR undecided);
 *  - the end of the stream: the CR goes out in a last chunk of its own, with the
 *    final (cumulative) usage when there was one.
 * Usage is not an end of the answer (vLLM `continuous_usage_stats` puts it on
 * every chunk). Once the answer has a character that is not one of those line
 * breaks, every chunk passes as it came.
 */
export async function* stripStreamSeparator(
  chunks: AsyncIterable<ChatCompletionChunk>,
): AsyncGenerator<ChatCompletionChunk, void, unknown> {
  let reasoningSeen = false;
  let budget = SEPARATOR_BREAKS;
  let answerStarted = false;
  /** A lone trailing CR taken out of the answer text, not yet known to be half of a CRLF. */
  let pendingCR = false;
  let last: ChatCompletionChunk | undefined;
  let lastUsage: ChatCompletionChunk["usage"];
  for await (const chunk of chunks) {
    last = chunk;
    if (chunk.usage) lastUsage = chunk.usage;
    if (answerStarted) {
      yield chunk;
      continue;
    }
    if (chunk.delta?.reasoning?.summary) reasoningSeen = true;
    const content = chunk.delta?.content;
    if (typeof content !== "string" || content.length === 0) {
      if (pendingCR && chunk.finishReason) {
        // The answer ends on the CR: it is answer text, delivered with the finish reason.
        pendingCR = false;
        answerStarted = true;
        yield withContent(chunk, "\r");
        continue;
      }
      yield chunk;
      continue;
    }
    if (!reasoningSeen) {
      answerStarted = true;
      yield chunk;
      continue;
    }
    let text = content;
    if (pendingCR) {
      pendingCR = false;
      if (text.startsWith("\n")) {
        budget--;
        text = text.slice(1);
      } else {
        text = `\r${text}`;
      }
    }
    const { end, used } = skipBreaks(text, budget);
    budget -= used;
    let rest = text.slice(end);
    if (budget > 0 && rest === "\r" && !chunk.finishReason) {
      pendingCR = true;
      rest = "";
    }
    if (rest.length > 0) answerStarted = true;
    yield rest === content ? chunk : withContent(chunk, rest);
  }
  // The stream ended on the undecided CR: it was answer text.
  if (pendingCR && last) yield { id: last.id, model: last.model, delta: { content: "\r" }, ...(lastUsage ? { usage: lastUsage } : {}) };
}
