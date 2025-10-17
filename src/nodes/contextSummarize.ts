// Lightweight message helpers to avoid hard dependency on LangChain
type LiteMsg = { role: string; content: any; name?: string; [k: string]: any };
const systemMessage = (content: string): LiteMsg => ({ role: 'system', content });
const humanMessage = (content: string): LiteMsg => ({ role: 'user', content });
// tool messages use role 'tool'
const toolMessage = (name: string, content: any, tool_call_id?: string): LiteMsg => ({ role: 'tool', name, content, tool_call_id });
import type { SmartAgentEvent, SmartAgentOptions, SmartState } from "../types.js";
import { nanoid } from "nanoid";
import { countApproxTokens } from "../utils/utilTokens.js";

// This node performs archival and message rewriting when a summarization pass is required.
// It moves all prior tool responses into the archive, stamping them with ids, and then injects
// a synthetic tool call + response pair that represents the summarization action.
export function createContextSummarizeNode(opts: SmartAgentOptions) {
    return async (state: SmartState): Promise<Partial<SmartState>> => {
        const messages = state.messages || [];
    const summaryTokenLimit = opts.limits?.summaryTokenLimit ?? 100000;
    const model = (opts as any).model;

        // Identify all tool calls and responses prior to the last assistant/tool-call turn
        // We'll archive tool responses and mark them as summarized with executionId tags.
        const archived = state.toolHistoryArchived ? [...state.toolHistoryArchived] : [];
        const live = state.toolHistory ? [...state.toolHistory] : [];

        // Build a quick lookup by tool_call_id from both archived and live to support cross-turn rewriting
        const byCallId = new Map<string, any>();
        for (const item of archived) {
            if (item.tool_call_id) byCallId.set(item.tool_call_id, item);
        }
        for (const item of live) {
            if (item.tool_call_id) byCallId.set(item.tool_call_id, item);
        }

        // Ensure every history item has an executionId
        for (const item of live) {
            if (!item.executionId) item.executionId = nanoid();
        }

        // We don't mutate tool calls themselves; we only mark tool responses in messages
        // with a placeholder content containing the execution id.
        // Helper: flatten message content to string
        const getText = (m: any) => {
            if (!m) return "";
            const c = m.content;
            if (typeof c === "string") return c;
            if (Array.isArray(c)) return c.map((p: any) => (typeof p === "string" ? p : p?.text ?? p?.content ?? "")).join("");
            return String(c ?? "");
        };

        // Build a robust, compact system instruction
        const sysText = "You are a concise summarization assistant for a tool-using agent. Summarize prior tool executions into a compact brief that preserves key facts, decisions, and outputs. Reference executionId values where helpful. Avoid repeating raw data; prefer synthesis.";
    const sys = systemMessage(sysText);

        // Token-aware chunking and iterative summarization to respect provider limits
        let summaryText = "";
        try {
            const limit = Math.max(1000, Number(summaryTokenLimit) || 100000);
            const safetyBuffer = Math.floor(Math.min(4000, limit * 0.05)); // keep 5% or up to 4k as buffer
            const perCallBudget = Math.max(500, limit - safetyBuffer);
            const safeToolPair = (opts as any)?.safeToolPair !== false; // default true

            // Create chunks ensuring (when enabled) that an AI tool-call message and its ToolMessage responses
            // are not split across different chunks. We allow slight token overflow to keep pairs intact.
            const chunks: any[][] = [];
            let current: any[] = [];
            let currentTokens = countApproxTokens(sysText);
            // Track pending tool call ids from the last AI message added to current chunk.
            let pendingToolCalls: Set<string> = new Set();

            const extractToolCallIds = (msg: any): string[] => {
                const tc = msg?.additional_kwargs?.tool_calls;
                if (!Array.isArray(tc) || tc.length === 0) return [];
                return tc.map((c: any) => c?.id).filter((id: any) => typeof id === "string");
            };

            for (let i = 0; i < messages.length; i++) {
                const m = messages[i];
                const text = getText(m);
                const tks = countApproxTokens(text);
                const isAIWithToolCalls = safeToolPair && (m as any)?.role === 'assistant' && extractToolCallIds(m).length > 0;
                const isToolMsg = safeToolPair && (m as any)?.role === 'tool';
                const toolCallId = isToolMsg ? (m as any).tool_call_id : undefined;

                // If adding this message would exceed budget, decide whether to split or to keep grouping with tool pairs.
                const wouldExceed = currentTokens + tks > perCallBudget && current.length > 0;

                if (wouldExceed) {
                    let forceAddToCurrent = false;
                    if (safeToolPair) {
                        // Case 1: We're in the middle of unresolved tool calls and this is one of their responses -> keep going (overflow ok)
                        if (isToolMsg && toolCallId && pendingToolCalls.has(toolCallId)) {
                            forceAddToCurrent = true;
                        } else if (isAIWithToolCalls) {
                            // Starting a new AI tool call set: better to start a new chunk if current has content.
                            // We'll push current chunk first to avoid mixing separate tool call groups.
                        } else if (pendingToolCalls.size > 0) {
                            // We're still expecting tool responses but this message is not a matching tool response.
                            // Conclude current chunk now to avoid losing alignment; start new chunk.
                        }
                    }

                    if (!forceAddToCurrent) {
                        // Close current chunk if we are not force-keeping this message inside it.
                        if (current.length > 0) {
                            chunks.push(current);
                        }
                        current = [];
                        currentTokens = countApproxTokens(sysText);
                        pendingToolCalls = new Set();
                    }
                }

                // Add the message to current chunk
                current.push(m);
                currentTokens += tks;

                // If we just added an AI tool-call message, register its tool call ids as pending.
                if (isAIWithToolCalls) {
                    for (const id of extractToolCallIds(m)) pendingToolCalls.add(id);
                }
                // If it's a tool message that resolves a pending call id, mark it resolved.
                if (isToolMsg && toolCallId && pendingToolCalls.has(toolCallId)) {
                    pendingToolCalls.delete(toolCallId);
                }

                // If we've exceeded budget AND there are no more pending tool call responses expected, we can safely flush.
                if (currentTokens >= perCallBudget && pendingToolCalls.size === 0) {
                    chunks.push(current);
                    current = [];
                    currentTokens = countApproxTokens(sysText);
                    pendingToolCalls = new Set();
                }
            }
            if (current.length > 0) {
                chunks.push(current);
            }

            // For each chunk, ask model to summarize that chunk
            const partials: string[] = [];
            for (const chunk of chunks) {
                let resp: any = null;
                try {
                    resp = await (model?.invoke ? model.invoke([sys, ...chunk]) : null);
                    const c = resp?.content;
                    const text = typeof c === "string" ? c : Array.isArray(c) ? c.map((p: any) => (typeof p === "string" ? p : p?.text ?? p?.content ?? "")).join("") : "";
                    partials.push((text || "").trim());
                } catch (e) {
                    // If a chunk fails, continue with a placeholder
                    console.error("Summarization chunk failed:", e);
                    partials.push("[summary unavailable for one chunk]");
                }
            }

            // If more than one partial, iteratively merge them under the same token budget
            const mergeSysText = "You merge partial summaries into a single cohesive, non-redundant summary that preserves key facts and decisions. Be concise.";
            const mergeSys = systemMessage(mergeSysText);

            const mergeIteratively = async (texts: string[]): Promise<string> => {
                if (texts.length === 0) return "";
                if (texts.length === 1) return texts[0];
                // Build groups such that each merge call stays under budget
                const groups: string[][] = [];
                let group: string[] = [];
                let toks = countApproxTokens(mergeSysText);
                for (const t of texts) {
                    const tt = `- ${t}`;
                    const tk = countApproxTokens(tt);
                    if (toks + tk > perCallBudget && group.length > 0) {
                        groups.push(group);
                        group = [];
                        toks = countApproxTokens(mergeSysText);
                    }
                    group.push(tt);
                    toks += tk;
                }
                if (group.length > 0) groups.push(group);

                const next: string[] = [];
                for (const g of groups) {
                    const mergePrompt = humanMessage(`Merge the following partial summaries into a single concise brief. Avoid duplication, keep key facts and decisions.\n\n${g.join("\n")}\n\nMerged summary:`);
                    try {
                        const r: any = await (model?.invoke ? model.invoke([mergeSys, mergePrompt]) : null);
                        const cc = r?.content;
                        const txt = typeof cc === "string" ? cc : Array.isArray(cc) ? cc.map((p: any) => (typeof p === "string" ? p : p?.text ?? p?.content ?? "")).join("") : "";
                        next.push((txt || "").trim());
                    } catch (e) {
                        console.error("Merge summarization failed:", e);
                        next.push(g.join(" "));
                    }
                }
                return mergeIteratively(next);
            };

            summaryText = await mergeIteratively(partials);
            if (!summaryText) summaryText = "Context summarized.";
        } catch (e) {
            console.error("Error during context summarization:", e);
            summaryText = "Context summarized.";
        }
        const rewritten: any[] = [];
        const alreadySummarized = (content: any) => {
            const text = typeof content === "string" ? content : Array.isArray(content) ? content.map((p: any) => (typeof p === "string" ? p : p?.text ?? p?.content ?? "")).join("") : String(content ?? "");
            return /\bSUMMARIZED\b/.test(text);
        };
        for (const m of messages) {
            if (m.getType() === "tool") {
                const toolMessageObj = m as any;
                // Skip if already summarized
                if (alreadySummarized((toolMessageObj as any).content) || toolMessageObj.name === "context_summarize" || toolMessageObj.name === 'manage_todo_list') {
                    rewritten.push(m);
                    continue;
                }
                const callId = (toolMessageObj as any).tool_call_id as string | undefined;
                const safeId = callId || `summarized_${nanoid(6)}`;
                let hist = callId ? byCallId.get(callId) : undefined;
                if (!hist) {
                    // Create a stub history entry if we don't have one (cross-invoke case)
                    hist = {
                        executionId: nanoid(),
                        toolName: (toolMessageObj as any).name || "unknown_tool",
                        args: null,
                        output: typeof (toolMessageObj as any).content === "string" ? (toolMessageObj as any).content : (Array.isArray((toolMessageObj as any).content) ? (toolMessageObj as any).content.map((p: any) => (typeof p === "string" ? p : p?.text ?? p?.content ?? "")).join("") : String((toolMessageObj as any).content ?? "")),
                        rawOutput: undefined,
                        timestamp: new Date().toISOString(),
                        summarized: true,
                        messageId: undefined,
                        tool_call_id: callId,
                        fromCache: false,
                    };
                    if (callId) byCallId.set(callId, hist);
                    // Persist stub to archive so it can be recovered by get_tool_response
                    archived.push({ ...hist });
                }
                if (!hist.executionId) hist.executionId = nanoid();
                hist.summarized = true;
                // Replace message content with summarized reference
                rewritten.push({
                    role: 'tool',
                    content: `SUMMARIZED executionId:'${hist.executionId}'`,
                    tool_call_id: safeId,
                    name: (toolMessage as any).name,
                });
                continue;
            }
            rewritten.push(m);
        }

        // After rewriting, create a synthetic assistant "tool call" to represent summarization
        const summarizeCallId = `summarize_${nanoid(6)}`;
        const summarizeArgs = { reason: "Exceeded token limit: summarize prior tool outputs for context." };
        const syntheticAssistant = {
            role: 'assistant',
            content: "",
            additional_kwargs: {
                tool_calls: [
                    { id: summarizeCallId, type: "function", function: { name: "context_summarize", arguments: JSON.stringify(summarizeArgs) } },
                ],
            },
        } as any;

        // And its synthetic tool response containing the actual summary content
        const syntheticToolResp = {
            role: 'tool',
            content: `${summaryText}`,
            tool_call_id: summarizeCallId,
            name: "context_summarize",
        } as any;

        // Return updated message list and move all current tool history items into archive
        // Mark all live items as summarized and merge with archived; de-duplicate by tool_call_id
        for (const item of live) item.summarized = true;
        const merged = [...archived, ...live];
        const dedupMap = new Map<string | undefined, any>();
        for (const it of merged) {
            const key = it.tool_call_id || `${it.toolName}:${it.timestamp}`;
            // Prefer the latest information (live overwrites archived)
            dedupMap.set(key, { ...it });
        }
    const newArchived = Array.from(dedupMap.values());
    const onEvent = (state.ctx as any)?.__onEvent as ((e: SmartAgentEvent) => void) | undefined;
    onEvent?.({ type: "summarization", summary: summaryText, archivedCount: newArchived.length });
        return {
            messages: [...rewritten, syntheticAssistant as any, syntheticToolResp],
            toolHistoryArchived: newArchived,
            toolHistory: [],
            ctx: { ...(state.ctx || {}), __contextSummarized: true },
        };
    };
}
