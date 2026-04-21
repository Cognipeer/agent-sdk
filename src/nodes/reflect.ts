// Reflection node — produces a short textual insight after a tool turn.
//
// Design goals:
//  - Piggyback on the existing transcript so the provider's prompt cache is
//    reused (no re-assembly of the whole context). We simply append a
//    `role:"user"` "reflect now" message and call the model with tool_choice:"none".
//  - The returned assistant text is **NOT** committed back as a real assistant
//    turn — it is captured in `state.reflections` and mirrored into the prompt
//    as a `role:"system"` "agent_reflection" message so the main model can see
//    the last few reflections without polluting the actual tool/assistant chain.
//  - Summarization respects `reflection.summarize`: when false (default) these
//    system messages are skipped by the summarizer and kept verbatim.

import type { SmartState, SmartAgentOptions, SmartAgentEvent, ReflectionRecord, ReflectionCadence } from "../types.js";
import type { ResolvedReflectionConfig } from "../smart/reasoning.js";
import { randomUUID } from "node:crypto";
import { normalizeUsage } from "../utils/usage.js";
import { recordTraceEvent } from "../utils/tracing.js";

const REFLECTION_SYSTEM_NAME = "agent_reflection";
const REFLECTION_ASK_NAME = "agent_reflection_ask";

const DEFAULT_REFLECT_PROMPT =
`Reflect briefly — plain text, no JSON, no tool calls.
Structure your note (1–2 sentences each):
1) What the latest tool results actually tell us (facts, surprises).
2) What is still missing or uncertain before we can finish the user's task.
3) The single next step you plan to take, and why that step over alternatives.
Be concrete. Do not repeat the task description. Do not apologize. Max ${"${maxChars}"} characters total.`;

function trimToChars(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return text.slice(0, maxChars - 1).trimEnd() + "…";
}

function countToolCallsInLastTurn(state: SmartState): { ids: string[]; names: string[] } {
  const ids: string[] = [];
  const names: string[] = [];
  for (let i = state.messages.length - 1; i >= 0; i--) {
    const m: any = state.messages[i];
    if (m?.role === "tool") {
      if (m.tool_call_id) ids.push(m.tool_call_id);
      if (m.name) names.push(m.name);
    } else if (m?.role === "assistant") {
      // Reached the assistant turn that produced these tool results — stop.
      break;
    }
  }
  return { ids, names };
}

function stripReflectionAskMessages(messages: any[]): any[] {
  return messages.filter((m) => !(m?.role === "user" && m?.name === REFLECTION_ASK_NAME));
}

export function shouldRunReflection(
  cadence: ReflectionCadence,
  state: SmartState,
  ranToolsThisTurn: boolean,
): boolean {
  if (cadence === "off") return false;
  if (cadence === "every_turn") return true;
  if (cadence === "after_tool") return ranToolsThisTurn;
  if (cadence === "on_branch") {
    // Fire when the last assistant turn changed tool usage pattern: tools just started
    // or stopped compared to the previous assistant turn. Simple heuristic.
    if (!ranToolsThisTurn) return false;
    const reflections = state.reflections || [];
    const lastReflectionTurn = reflections[reflections.length - 1]?.turn ?? -1;
    const currentTurnId = (state.toolCallCount ?? 0);
    return currentTurnId - lastReflectionTurn >= 2;
  }
  return false;
}

export function createReflectionNode(opts: SmartAgentOptions, resolved: ResolvedReflectionConfig) {
  return async function reflectNode(
    state: SmartState,
    trigger: ReflectionCadence,
  ): Promise<Partial<SmartState>> {
    if (!resolved.enabled) return {};

    const runtime = (state as any).agent || {
      model: (opts as any).model,
      name: opts.name,
      version: opts.version,
    };
    const model: any = runtime.model;
    if (!model?.invoke && !model?.stream) return {};

    const onEvent = (state.ctx as any)?.__onEvent as ((e: SmartAgentEvent) => void) | undefined;
    const traceSession = (state.ctx as any)?.__traceSession;

    const maxChars = resolved.maxChars;
    const promptBody = (resolved.promptTemplate || DEFAULT_REFLECT_PROMPT).replace(/\$\{maxChars\}/g, String(maxChars));

    // Piggyback: append ask as user message on top of the existing transcript.
    // This maximises the provider prompt-cache hit rate vs. building a new one.
    const baseMessages = stripReflectionAskMessages([...(state.messages as any[])]);
    const askMessage: any = {
      role: "user",
      name: REFLECTION_ASK_NAME,
      content: promptBody,
    };
    const messagesForCall =
      resolved.mode === "piggyback" ? [...baseMessages, askMessage]
      : buildSeparateCallMessages(baseMessages, promptBody);

    const start = Date.now();
    let response: any;
    try {
      response = await model.invoke(messagesForCall, {
        // tool_choice:"none" so the model won't try to call tools during reflection
        tool_choice: "none",
        toolChoice: "none",
        // Override max_tokens for the reflection call. BaseChatModel passes this through
        // to the adapter which forwards into the provider body.
        max_tokens: resolved.maxTokens,
        maxTokens: resolved.maxTokens,
      });
    } catch (err: any) {
      recordTraceEvent(traceSession, {
        type: "reflection" as any,
        label: "Reflection error",
        actor: { scope: "agent", name: opts.name || "agent", role: "reflection" },
        status: "error",
        error: { message: err?.message || String(err) },
      });
      return {};
    }

    const durationMs = Date.now() - start;
    const rawText = extractText(response);
    const text = trimToChars(String(rawText ?? "").trim(), maxChars);
    if (!text) return {};

    const rawUsage = (response as any)?.usage_metadata
      || (response as any)?.response_metadata?.usage
      || (response as any)?.usage
      || (response as any)?.additional_kwargs?.usage;
    const usage = normalizeUsage(rawUsage);
    const { ids, names } = countToolCallsInLastTurn(state);
    const turn = (state.toolCallCount ?? 0);
    const record: ReflectionRecord = {
      id: safeRandomId(),
      turn,
      text,
      createdAt: new Date().toISOString(),
      durationMs,
      anchorMessageIndex: state.messages.length,
      trigger,
      usage: usage ? {
        inputTokens: usage.prompt_tokens,
        outputTokens: usage.completion_tokens,
        cachedInputTokens: usage.prompt_tokens_details?.cached_tokens,
        totalTokens: usage.total_tokens,
        reasoningTokens: usage.completion_tokens_details?.reasoning_tokens,
      } : undefined,
      toolCallIds: ids.length > 0 ? ids : undefined,
    };

    recordTraceEvent(traceSession, {
      type: "reflection" as any,
      label: `Reflection turn ${turn}`,
      actor: { scope: "agent", name: opts.name || "agent", role: "reflection" },
      status: "success",
      durationMs,
      inputTokens: record.usage?.inputTokens,
      outputTokens: record.usage?.outputTokens,
      cachedInputTokens: record.usage?.cachedInputTokens,
      totalTokens: record.usage?.totalTokens,
      debug: { text, toolNames: names },
    });

    if (resolved.emitEvents) {
      try {
        onEvent?.({
          type: "reflection",
          id: record.id,
          turn,
          text,
          trigger,
          durationMs,
          usage: record.usage,
          toolCallIds: record.toolCallIds,
        });
      } catch (e) {
        // onEvent failures must never break the loop
      }
    }

    // Now update the live message list: remove any previous ask message and the
    // provisional assistant response (if any) — the reflection is stored as a
    // compact `system` "agent_reflection" message so the main model sees it on
    // the next turn without it participating in the tool_calls chain.
    const nextMessages = stripReflectionAskMessages([...(state.messages as any[])]);
    const reflections = [...(state.reflections || []), record];

    // Keep only last N reflections as live system messages; older ones stay in
    // `state.reflections` for persistence/UI but are pruned from the prompt.
    const kept = reflections.slice(-Math.max(1, resolved.keepLast));
    const prunedMessages = nextMessages.filter(
      (m: any) => !(m?.role === "system" && m?.name === REFLECTION_SYSTEM_NAME),
    );
    for (const r of kept) {
      prunedMessages.push({
        role: "system",
        name: REFLECTION_SYSTEM_NAME,
        content: `<agent_reflection turn=${r.turn} at=${r.createdAt}>\n${r.text}\n</agent_reflection>`,
        metadata: { reflectionId: r.id, reflectionTurn: r.turn, reflectionTrigger: r.trigger },
      });
    }

    return { messages: prunedMessages, reflections };
  };
}

function extractText(chunk: any): string {
  if (chunk == null) return "";
  if (typeof chunk === "string") return chunk;
  if (typeof chunk?.content === "string") return chunk.content;
  if (Array.isArray(chunk?.content)) {
    return chunk.content.map((c: any) => (typeof c === "string" ? c : c?.text ?? c?.content ?? "")).join("");
  }
  if (typeof chunk?.text === "string") return chunk.text;
  return "";
}

function buildSeparateCallMessages(base: any[], promptBody: string): any[] {
  // Compact build: keep only the system prompt, last 2 user messages, and most recent
  // assistant+tool messages so the call is cheap but still grounded.
  const systemMessages = base.filter((m) => m?.role === "system");
  const tail = base.slice(-8);
  return [
    ...systemMessages,
    ...tail,
    { role: "user", name: REFLECTION_ASK_NAME, content: promptBody },
  ];
}

function safeRandomId(): string {
  try {
    return randomUUID();
  } catch {
    return `r_${Math.random().toString(36).slice(2, 10)}_${Date.now().toString(36)}`;
  }
}

export { REFLECTION_SYSTEM_NAME, REFLECTION_ASK_NAME };
