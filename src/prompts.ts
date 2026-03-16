import type { PlanningMode } from "./types.js";

const DEFAULT_TODO_LIST_PROMPT = `Planning tools are available when they materially improve execution.

Rules:
1) Use "manage_todo_list" for multi-step work, delegation, recovery after a failed attempt, or when the user explicitly asks for a plan.
2) Do NOT create a plan for direct Q&A, simple recall from existing context, or a single straightforward tool lookup unless the user asks for one.
3) If a task is multi-step and no valid plan exists yet, create one before substantial execution.
4) Use operation="write" only to create or fully replace the entire plan. After a plan exists, default to operation="update" for progress, evidence, status, owner changes, blockers, or reprioritization.
5) When using operation="update", send only the changed items. Do not resend unchanged plan items unless the whole plan structure is being rewritten.
6) Include expectedVersion from the latest successful plan state whenever you update an existing plan. If you do not know the latest version, read the plan first.
7) Keep exactly ONE item "in-progress" at a time.
8) Update the plan whenever a step starts, completes, becomes blocked, fails, or the approach changes. Do not finish a multi-step task with stale plan state.
9) If tool results materially change the task state, sync the plan before the final answer.
10) Reuse prior tool results already present in the conversation before calling tools again.
11) If an update fails because of a version mismatch, read the latest plan and retry instead of blindly rewriting it.
12) Repeating full operation="write" calls for the same plan is a mistake unless the plan structure itself changed.
13) Keep the plan internal unless the user explicitly asks to see it.`;

function buildPlanningBlock(todoListPrompt?: string) {
  const promptBody = todoListPrompt?.trim() || DEFAULT_TODO_LIST_PROMPT;
  if (promptBody.startsWith("<planning>")) {
    return promptBody;
  }
  return `<planning>\n${promptBody}\n</planning>`;
}

export function buildSystemPrompt(
  extra?: string,
  planning?: boolean | PlanningMode,
  name: string = "Agent",
  todoListPrompt?: string,
) {
  const extraTrimmed = extra?.trim();
  const agentHeader = `Agent Name: ${name}`;
  const planningMode = typeof planning === "string"
    ? planning
    : planning
    ? "todo"
    : "off";
  const planningBlock = planningMode !== "off"
    ? buildPlanningBlock(todoListPrompt)
    : "";
  return [
    agentHeader,
    "You are an advanced AI agent that is concise, accurate, and helpful.",
    "Follow these rules:",
    "- Use tools only when they add value; avoid redundant calls.",
    "- Never fabricate tool results; if unavailable, say so briefly.",
    "- Prefer short, structured answers; use bullet points when helpful.",
    "- Keep privacy and safety: do not reveal secrets or sensitive data.",
    "- If inputs are ambiguous or missing, ask one concise clarifying question.",
    "- Reuse prior tool results already present in the conversation when sufficient.",
    planningBlock,
    extraTrimmed ? `Extra instructions: ${extraTrimmed}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}
