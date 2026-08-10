import { nanoid } from "nanoid";

import type { AgentState, BaseMessage, SmartAgentEvent, ToolInterface } from "../../types.js";

/**
 * Deterministic pre-opening of skills at the start of an invoke.
 *
 * Some skills must not depend on the model choosing to discover them — an
 * organization policy, or the integration a scheduled run is about. Those keys
 * are passed per-invoke (`InvokeConfig.preopenedSkills`) and opened here BEFORE
 * the first model call, by invoking the very same `open_skill` tool the model
 * would have called. The run then continues normally: the skill's tools are
 * bound in the registry and `bind_skill_tools` can still widen the surface.
 *
 * The opening is written into the transcript as a real tool exchange (one
 * assistant message carrying the tool calls, then one tool message per call),
 * because that is the shape the model is trained on and the shape the rest of
 * the runtime — summarization, retention, `get_tool_response` — already
 * understands. Tool call ids are derived from the skill key rather than random,
 * so the same preopen set produces a byte-identical prefix on every run and the
 * provider-side prompt cache keeps hitting.
 */

export const PREOPEN_TOOL_CALL_PREFIX = "preopen_skill_";

const OPEN_SKILL_TOOL_NAME = "open_skill";

export type PreopenSkillsResult = {
  /** Synthetic transcript entries to append after the user message. */
  messages: BaseMessage[];
  /** Tool-history rows mirroring the synthetic calls. */
  toolHistory: NonNullable<AgentState["toolHistory"]>;
  /** Skill keys actually opened (available, resolved, not already open). */
  openedKeys: string[];
  /** Keys that were requested but could not be opened, with the reason. */
  skipped: Array<{ skillKey: string; reason: string }>;
};

/** Tool call ids must survive provider id charset rules; skill keys contain ':'. */
export function preopenToolCallId(skillKey: string): string {
  return `${PREOPEN_TOOL_CALL_PREFIX}${skillKey.replace(/[^a-zA-Z0-9_-]/g, "_")}`;
}

function messagesContainCallId(messages: BaseMessage[] | undefined, callId: string): boolean {
  if (!Array.isArray(messages)) return false;
  return messages.some((message) => {
    const calls = (message as any)?.tool_calls;
    return Array.isArray(calls) && calls.some((call: any) => call?.id === callId);
  });
}

function serializeToolContent(result: unknown): string {
  if (typeof result === "string") return result;
  try {
    return JSON.stringify(result);
  } catch {
    return String(result);
  }
}

/**
 * Open the requested skills through the real `open_skill` tool and return the
 * transcript + tool-history entries that describe the exchange. Binding side
 * effects (registry mutation + `__onToolsChanged`) happen inside the tool, so
 * the caller only has to merge the returned messages/history into its state.
 */
export async function preopenSkills(input: {
  skillKeys: string[];
  tools: ToolInterface[];
  /** Keys already open on the registry — a resumed run must not re-open them. */
  alreadyOpenedKeys?: string[];
  /** Existing transcript, used to keep the injection idempotent across resumes. */
  existingMessages?: BaseMessage[];
  onEvent?: (event: SmartAgentEvent) => void;
}): Promise<PreopenSkillsResult> {
  const empty: PreopenSkillsResult = { messages: [], toolHistory: [], openedKeys: [], skipped: [] };

  const requested = [...new Set(
    (input.skillKeys ?? []).map((key) => String(key ?? "").trim()).filter(Boolean)
  )];
  if (requested.length === 0) return empty;

  const openSkillTool = input.tools.find((tool) => (tool as any)?.name === OPEN_SKILL_TOOL_NAME);
  if (!openSkillTool) {
    return { ...empty, skipped: requested.map((skillKey) => ({ skillKey, reason: "open_skill tool is not wired" })) };
  }

  const alreadyOpen = new Set(input.alreadyOpenedKeys ?? []);
  const toolCalls: any[] = [];
  const toolMessages: BaseMessage[] = [];
  const toolHistory: NonNullable<AgentState["toolHistory"]> = [];
  const openedKeys: string[] = [];
  const skipped: Array<{ skillKey: string; reason: string }> = [];

  for (const skillKey of requested) {
    const toolCallId = preopenToolCallId(skillKey);

    if (alreadyOpen.has(skillKey) || messagesContainCallId(input.existingMessages, toolCallId)) {
      skipped.push({ skillKey, reason: "already open" });
      continue;
    }

    const args = { skillKey };
    input.onEvent?.({ type: "tool_call", phase: "start", name: OPEN_SKILL_TOOL_NAME, id: toolCallId, args });

    const start = Date.now();
    let result: any;
    try {
      result = await (openSkillTool as any).invoke(args);
    } catch (error) {
      const message = error instanceof Error ? error.message : "open_skill failed";
      input.onEvent?.({
        type: "tool_call", phase: "error", name: OPEN_SKILL_TOOL_NAME, id: toolCallId, args,
        error: { message }, durationMs: Date.now() - start
      });
      skipped.push({ skillKey, reason: message });
      continue;
    }
    const durationMs = Date.now() - start;

    // An unknown or unavailable skill returns { error }. Emitting a tool call
    // whose only content is an error would teach the model the capability is
    // broken, so the exchange is dropped from the transcript entirely.
    if (result && typeof result === "object" && typeof result.error === "string") {
      input.onEvent?.({
        type: "tool_call", phase: "skipped", name: OPEN_SKILL_TOOL_NAME, id: toolCallId, args,
        error: { message: result.error }, durationMs
      });
      skipped.push({ skillKey, reason: result.error });
      continue;
    }

    // Runtime-only marker: the tools are already bound on the registry, and the
    // smart loop rebuilds its tool sets from there.
    if (result && typeof result === "object") delete (result as any).__runtimeToolsDelta;

    toolCalls.push({
      id: toolCallId,
      type: "function",
      function: { name: OPEN_SKILL_TOOL_NAME, arguments: JSON.stringify(args) }
    });
    toolMessages.push({
      role: "tool",
      name: OPEN_SKILL_TOOL_NAME,
      tool_call_id: toolCallId,
      content: serializeToolContent(result)
    });
    toolHistory.push({
      executionId: nanoid(),
      toolName: OPEN_SKILL_TOOL_NAME,
      args,
      output: result,
      rawOutput: result,
      timestamp: new Date().toISOString(),
      tool_call_id: toolCallId,
      summarized: false,
      retentionPolicy: "keep_full",
      status: "success"
    });
    openedKeys.push(skillKey);

    input.onEvent?.({
      type: "tool_call", phase: "success", name: OPEN_SKILL_TOOL_NAME, id: toolCallId, args,
      result, durationMs
    });
  }

  if (toolCalls.length === 0) {
    return { ...empty, skipped };
  }

  const assistantMessage: BaseMessage = {
    role: "assistant",
    content: `Opening the ${openedKeys.join(", ")} skill${openedKeys.length > 1 ? "s" : ""} required for this task.`,
    tool_calls: toolCalls
  };

  return { messages: [assistantMessage, ...toolMessages], toolHistory, openedKeys, skipped };
}
