import type {
  SmartState,
  Message,
  PendingUserQuestion,
  UserQuestionResolution,
  UserQuestionAnswerSet,
} from "../types.js";

const cloneQuestions = (questions: PendingUserQuestion[] | undefined) =>
  Array.isArray(questions) ? questions.map((entry) => ({ ...entry })) : [];

function validateAnswers(
  entry: PendingUserQuestion,
  answers: UserQuestionAnswerSet | undefined,
  cancelled: boolean,
): UserQuestionAnswerSet {
  if (cancelled) {
    return answers || {};
  }

  const allowFreeText = entry.allowFreeText !== false;
  const out: UserQuestionAnswerSet = {};
  const provided = answers || {};

  for (const question of entry.questions) {
    const required = question.required !== false;
    const key = question.question;
    const answer = provided[key] ?? provided[question.header || ""];

    if (!answer) {
      if (required) {
        throw new Error(`Missing answer for required question: "${key}".`);
      }
      continue;
    }

    const values = Array.isArray(answer.values) ? answer.values.filter((v) => typeof v === "string") : [];
    const freeText = typeof answer.freeText === "string" ? answer.freeText.trim() : "";
    const notes = typeof answer.notes === "string" ? answer.notes : undefined;

    if (freeText && !allowFreeText) {
      throw new Error(
        `Free-text answers are disabled for this agent (question: "${key}"). Pick one of the provided options.`,
      );
    }

    if (values.length === 0 && !freeText) {
      if (required) {
        throw new Error(`Question "${key}" requires either a selected option or free-text answer.`);
      }
      continue;
    }

    if (values.length > 1 && !question.multiSelect) {
      throw new Error(`Question "${key}" is single-select but received multiple values.`);
    }

    if (Array.isArray(question.options) && question.options.length > 0 && values.length > 0) {
      const allowedValues = new Set(
        question.options.map((option) => option.value ?? option.label),
      );
      for (const value of values) {
        if (!allowedValues.has(value)) {
          if (!allowFreeText) {
            throw new Error(
              `Value "${value}" is not one of the allowed options for question "${key}".`,
            );
          }
          // With free-text enabled, treat unknown values as a custom answer.
        }
      }
    }

    out[key] = { values, ...(freeText ? { freeText } : {}), ...(notes ? { notes } : {}) };
  }

  return out;
}

function buildToolResponseContent(entry: PendingUserQuestion, answers: UserQuestionAnswerSet, cancelled: boolean, notes?: string): string {
  if (cancelled) {
    return JSON.stringify({
      status: "cancelled",
      message: notes || "User dismissed the question without answering.",
    });
  }

  // Flatten into a compact, model-friendly shape.
  const payload = {
    status: "answered",
    answers: entry.questions.map((question) => {
      const key = question.question;
      const ans = answers[key];
      return {
        question: key,
        header: question.header,
        values: ans?.values ?? [],
        freeText: ans?.freeText,
        notes: ans?.notes,
      };
    }),
    ...(notes ? { reviewerNotes: notes } : {}),
  };
  return JSON.stringify(payload);
}

export function resolveUserQuestionState(
  state: SmartState,
  resolution: UserQuestionResolution,
): SmartState {
  const pending = cloneQuestions(state.pendingUserQuestions);
  const matchIndex = pending.findIndex(
    (entry) => entry.id === resolution.id || entry.toolCallId === resolution.id,
  );
  if (matchIndex === -1) {
    throw new Error(`Pending user question not found for id: ${resolution.id}`);
  }

  const entry = { ...pending[matchIndex] };
  if (entry.status === "answered" || entry.status === "executed" || entry.status === "cancelled") {
    throw new Error(`User question ${entry.id} already resolved (status: ${entry.status}).`);
  }

  const cancelled = resolution.cancelled === true;
  const validated = validateAnswers(entry, resolution.answers, cancelled);

  entry.status = cancelled ? "cancelled" : "answered";
  entry.answers = validated;
  entry.cancelled = cancelled || undefined;
  entry.answeredBy = resolution.answeredBy;
  entry.notes = resolution.notes;
  entry.answeredAt = new Date().toISOString();

  pending[matchIndex] = entry;

  // A sub-agent surfaces a CHILD question to the parent. The parent transcript
  // has no matching tool_call for it, so we must NOT inject a tool message at
  // the parent level and must KEEP `__resumeStage = "tools"` so the parent
  // re-runs the delegating sub-agent tool, which feeds the answer into the
  // child and resumes it.
  const isSubagentQuestion = Boolean((entry.metadata as any)?.__subagent);

  const ctx = { ...(state.ctx || {}) };
  delete ctx.__awaitingUserQuestion;
  // The original tool call set `__resumeStage = "tools"` so the runtime would
  // re-enter the tools node on resume; for a parent-level ask_user we already
  // injected the answer as a tool message, so the loop should run the agent
  // (not the tools node) first on the next invoke. For a sub-agent question we
  // keep it so the delegating tool re-runs.
  if (ctx.__resumeStage === "tools" && !isSubagentQuestion) {
    delete ctx.__resumeStage;
  }
  ctx.__userQuestionResolved = { id: entry.id, status: entry.status };

  if (isSubagentQuestion) {
    return {
      ...state,
      pendingUserQuestions: pending,
      ctx,
    };
  }

  const toolMessage: Message = {
    role: "tool",
    name: "ask_user_question",
    tool_call_id: entry.toolCallId,
    content: buildToolResponseContent(entry, validated, cancelled, resolution.notes),
  };

  return {
    ...state,
    pendingUserQuestions: pending,
    messages: [...(state.messages || []), toolMessage],
    ctx,
  };
}
