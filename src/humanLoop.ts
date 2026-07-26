import { z } from "zod";
import { nanoid } from "nanoid";
import { createTool } from "./tool.js";
import { recordTraceEvent } from "./utils/tracing.js";
import type {
  PendingUserQuestion,
  UserQuestionItem,
  HumanInTheLoopAskUserConfig,
} from "./types.js";

/**
 * The built-in ask-user tool's name. Exported because more than one layer has to
 * recognise it: `createSmartAgent` builds the tool into the list it hands to
 * `createAgent`, which must then not attach a second one of its own.
 */
export const ASK_USER_TOOL_NAME = "ask_user_question";

export type AskUserStateRef = {
  pendingUserQuestions?: PendingUserQuestion[];
  ctx?: Record<string, any>;
  __onEvent?: (event: any) => void;
  __currentToolCallId?: string;
};

const DEFAULT_DESCRIPTION_WITH_FREETEXT =
  "Pause the agent and surface a structured prompt to the human user when you genuinely cannot proceed without their input. " +
  "Group up to 4 closely related questions into a single call. " +
  "Prefer concrete options the user can pick over open-ended free-text — list `options` whenever you can anticipate the choices. " +
  "The user may type a custom answer for any question. " +
  "Do not use this tool for things you can deduce from the conversation, the system prompt, or another tool. " +
  "After the user answers, their selections come back as the tool result.";

const DEFAULT_DESCRIPTION_NO_FREETEXT =
  "Pause the agent and surface a structured multi-choice prompt to the human user when you genuinely cannot proceed without their input. " +
  "Group up to 4 closely related questions into a single call. " +
  "Every question MUST include at least two `options` — free-text answers are disabled for this agent. " +
  "Do not use this tool for things you can deduce from the conversation, the system prompt, or another tool. " +
  "After the user picks, their selections come back as the tool result.";

function buildOptionSchema() {
  return z
    .object({
      label: z.string().min(1).describe("Display text the user sees"),
      value: z
        .string()
        .min(1)
        .optional()
        .describe("Value returned in the answer; defaults to label"),
      description: z.string().optional(),
      preview: z
        .string()
        .optional()
        .describe("Optional code / ASCII preview rendered when this option is focused"),
    })
    .strict();
}

function buildQuestionSchema(allowFreeText: boolean) {
  const optionSchema = buildOptionSchema();
  const baseShape = {
    question: z.string().min(1).describe("Full question shown to the user"),
    header: z
      .string()
      .max(40)
      .optional()
      .describe("Short chip / tag rendered next to the question (max ~12 chars recommended)"),
    multiSelect: z.boolean().optional().describe("Allow multiple selections. Default: false"),
    placeholder: z.string().optional(),
    required: z.boolean().optional().describe("Default: true"),
  } as const;

  if (allowFreeText) {
    return z
      .object({
        ...baseShape,
        options: z.array(optionSchema).min(2).max(12).optional(),
      })
      .strict();
  }

  return z
    .object({
      ...baseShape,
      options: z
        .array(optionSchema)
        .min(2)
        .max(12)
        .describe("Required: free-text answers are disabled for this agent"),
    })
    .strict();
}

export function createAskUserQuestionTool(
  stateRef: AskUserStateRef,
  config: HumanInTheLoopAskUserConfig,
) {
  const allowFreeText = config.allowFreeText !== false;
  const description = config.promptOverride
    ?? (allowFreeText ? DEFAULT_DESCRIPTION_WITH_FREETEXT : DEFAULT_DESCRIPTION_NO_FREETEXT);
  const questionSchema = buildQuestionSchema(allowFreeText);

  const askUser = createTool({
    name: ASK_USER_TOOL_NAME,
    description,
    schema: z
      .object({
        questions: z
          .array(questionSchema)
          .min(1)
          .max(4)
          .describe("1-4 related questions to ask in a single pause."),
      })
      .strict(),
    func: async ({ questions }) => {
      const ref = ((askUser as any)._stateRef ||= {}) as AskUserStateRef;
      const onEvent = ref.__onEvent;
      if (!ref.ctx) ref.ctx = {};
      const ctx = ref.ctx;
      const toolCallId = ref.__currentToolCallId || `ask_user_${nanoid(6)}`;
      if (!ref.pendingUserQuestions) ref.pendingUserQuestions = [];
      const pendingList = ref.pendingUserQuestions;

      const entry: PendingUserQuestion = {
        id: nanoid(),
        toolCallId,
        toolName: ASK_USER_TOOL_NAME,
        questions: questions as UserQuestionItem[],
        status: "pending",
        requestedAt: new Date().toISOString(),
        allowFreeText,
      };
      pendingList.push(entry);

      ctx.__awaitingUserQuestion = {
        id: entry.id,
        toolCallId: entry.toolCallId,
        requestedAt: entry.requestedAt,
      };
      ctx.__resumeStage = "tools";

      onEvent?.({
        type: "user_question",
        status: "pending",
        id: entry.id,
        toolCallId: entry.toolCallId,
        questions: entry.questions,
        allowFreeText,
      });

      recordTraceEvent(ctx.__traceSession, {
        type: "user_question",
        label: "Ask User",
        actor: { scope: "agent", name: "ask_user_question", role: "user_interaction" },
        status: "success",
        sections: [
          {
            kind: "metadata",
            label: "Pending Question",
            data: {
              id: entry.id,
              toolCallId: entry.toolCallId,
              questions: entry.questions,
              allowFreeText,
            },
          },
        ],
      });

      return {
        __awaitingUserQuestion: true,
        id: entry.id,
        toolCallId: entry.toolCallId,
      };
    },
  });

  (askUser as any)._stateRef = stateRef;
  (askUser as any).__source = "human-in-the-loop";
  return askUser;
}
