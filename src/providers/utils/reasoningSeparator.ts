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

/**
 * `stripAnswerSeparator` for a stream: after reasoning deltas, the first answer
 * deltas lose up to two leading line breaks in total, however the server split
 * them over chunks (`"\n"`, `"\n"`, `"    print"` gives `"    print"`). A chunk
 * left empty still arrives, without `content`. Once the answer has a character
 * that is not one of those line breaks, every chunk passes as it came.
 */
export async function* stripStreamSeparator(
  chunks: AsyncIterable<ChatCompletionChunk>,
): AsyncGenerator<ChatCompletionChunk, void, unknown> {
  let reasoningSeen = false;
  let budget = SEPARATOR_BREAKS;
  let answerStarted = false;
  for await (const chunk of chunks) {
    if (answerStarted) {
      yield chunk;
      continue;
    }
    if (chunk.delta?.reasoning?.summary) reasoningSeen = true;
    const content = chunk.delta?.content;
    if (typeof content !== "string" || content.length === 0) {
      yield chunk;
      continue;
    }
    if (!reasoningSeen) {
      answerStarted = true;
      yield chunk;
      continue;
    }
    const { end, used } = skipBreaks(content, budget);
    budget -= used;
    if (end < content.length) answerStarted = true;
    if (end === 0) {
      yield chunk;
      continue;
    }
    const delta = { ...chunk.delta };
    if (end < content.length) delta.content = content.slice(end);
    else delete delta.content;
    yield { ...chunk, delta };
  }
}
