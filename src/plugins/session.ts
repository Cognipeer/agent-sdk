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
  params: {
    messages: Message[];
    /** Continues a paused OR snapshot-restored run. Reported to `sessionStart`. */
    resumed: boolean;
    /**
     * A LIVE pause marker is present (`__paused`, `__resumeStage`,
     * `__awaitingApproval`, `__awaitingUserQuestion`) — the run is mid-turn and
     * its user turn was already gated. Unlike `__restoredFromSnapshot` these
     * are stripped on entry, so they cannot outlive the invoke they belong to.
     */
    pausedMidRun?: boolean;
    config?: InvokeConfig;
  },
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

  // Input guardrail point. Skipped when the tail is not a user turn (a genuine
  // resume ends in a tool result or an answered question, and rewriting that
  // tail would break tool_call/tool_result adjacency) and when a LIVE pause
  // marker says the run is mid-turn (a checkpoint before the first model call
  // leaves a user tail that was already gated). Deliberately NOT keyed on
  // `resumed`: that also covers `__restoredFromSnapshot`, which used to ride
  // out on every later `result.state`, so one restore silently switched the
  // input guardrail off for the rest of the conversation. After a snapshot
  // round-trip a paused user turn and a freshly appended one look identical,
  // and gating both is the safe reading.
  const last = messages[messages.length - 1];
  if (params.pausedMidRun || last?.role !== "user" || !runHost.has("userPromptSubmit")) {
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
