/**
 * Opening a plugin session — shared by the base agent and the smart driver.
 *
 * Both need the same two gates in the same order (`sessionStart`, then
 * `userPromptSubmit`) applied to the same transcript, and getting the order or
 * the resume guard subtly different in two places is how a policy ends up
 * enforced on one agent type and not the other.
 */

import type { InvokeConfig, Message } from "../types.js";
import type { PluginRunHost } from "./host.js";
import { collectAttachments, textFromContent } from "../utils/content.js";

export type OpenedSession = {
  /** The transcript to run with, after any hook rewrite or hydration. */
  messages: Message[];
  /** Set when a hook refused the turn before the first model call. */
  denied?: { reason: string; deniedBy?: string };
  /** Collected `sessionStart.systemPromptAppend` contributions, joined. */
  systemPromptAppend?: string;
};

export async function openPluginSession(
  runHost: PluginRunHost,
  params: { messages: Message[]; resumed: boolean; config?: InvokeConfig },
): Promise<OpenedSession> {
  let messages = params.messages;

  const startGate = await runHost.runGate("sessionStart", {
    messages,
    resumed: params.resumed,
    config: params.config,
  });
  if (startGate.input.messages !== messages) {
    messages = startGate.input.messages as Message[];
  }
  const appended = (startGate.collected.systemPromptAppend ?? []) as string[];
  const systemPromptAppend = appended.length > 0 ? appended.join("\n\n") : undefined;

  // Input guardrail point. Deliberately skipped on resume: the tail of a
  // resumed transcript is a tool result or an answered question, not a new user
  // turn, and rewriting it would break tool_call/tool_result adjacency.
  const last = messages[messages.length - 1];
  if (params.resumed || last?.role !== "user" || !runHost.has("userPromptSubmit")) {
    return { messages, systemPromptAppend };
  }

  // The hook gets all three views: the joined text it usually wants, the parts
  // it needs to preserve an attachment, and the normalized attachment list a
  // media policy reads.
  const content = last.content as string | import("../types.js").ContentPart[];
  const text = textFromContent(content);
  const promptGate = await runHost.runGate("userPromptSubmit", {
    text,
    content,
    attachments: collectAttachments(content),
    message: last,
  });

  if (promptGate.decision === "deny") {
    return {
      messages,
      systemPromptAppend,
      denied: {
        reason: promptGate.reason || "Request blocked by policy.",
        deniedBy: promptGate.deniedBy,
      },
    };
  }

  // The host's normalize step keeps `content` authoritative, so writing it back
  // preserves images, audio and files that a text-only rewrite would have
  // flattened away.
  if (promptGate.input.content !== content) {
    messages = [...messages.slice(0, -1), { ...last, content: promptGate.input.content } as Message];
  }

  const extra = (promptGate.collected.additionalContext ?? []) as string[];
  if (extra.length > 0) {
    // Appended before the loop, never mid-iteration: a message injected between
    // a model turn and the pending-tool-call scan pushes the assistant turn off
    // the tail, and its tool calls are then silently dropped.
    messages = [
      ...messages,
      { role: "system", name: "plugin_context", content: extra.join("\n\n") } as Message,
    ];
  }

  return { messages, systemPromptAppend };
}
