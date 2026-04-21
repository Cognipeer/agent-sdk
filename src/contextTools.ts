import { z } from "zod";
import { createTool } from "./tool.js";
import { recordTraceEvent } from "./utils/tracing.js";
// no message helpers needed here

const todoStatusSchema = z.enum(["not-started", "in-progress", "completed", "blocked"]);

const todoWriteItemSchema = z.object({
  id: z.number().int().min(1).describe("Sequential id starting from 1"),
  step: z.string().min(1).optional(),
  title: z.string().min(1).optional(),
  description: z.string().min(1).optional(),
  owner: z.string().min(1).optional(),
  exitCriteria: z.string().min(1).optional(),
  status: todoStatusSchema,
  evidence: z.string().max(300).optional(),
});

const todoUpdateItemSchema = z.object({
  id: z.number().int().min(1).describe("Existing todo id to update"),
  step: z.string().min(1).optional(),
  title: z.string().min(1).optional(),
  description: z.string().min(1).optional(),
  owner: z.string().min(1).optional(),
  exitCriteria: z.string().min(1).optional(),
  status: todoStatusSchema.optional(),
  evidence: z.string().max(300).optional(),
});

function normalizeTodoItem(item: any, existing?: any) {
  const id = item.id ?? existing?.id;
  const step = item.step || item.title || item.description || existing?.step || existing?.title || existing?.description || `Step ${id}`;
  const title = item.title || item.step || existing?.title || existing?.step || `Step ${id}`;
  const description = item.description || item.step || item.title || existing?.description || existing?.step || existing?.title || `Step ${id}`;

  return {
    ...existing,
    ...item,
    id,
    step,
    title,
    description,
    owner: item.owner || existing?.owner || "agent",
    exitCriteria: item.exitCriteria || existing?.exitCriteria || description || `Complete step ${id}`,
    status: item.status || existing?.status,
    evidence: item.evidence ?? existing?.evidence,
  };
}

function validatePlanInvariants(todoList: any[], requireSequentialIds: boolean) {
  const ids = todoList.map((item) => item.id);
  const uniqueIds = new Set(ids);
  if (uniqueIds.size !== ids.length) {
    return { ok: false, error: "Todo ids must be unique." } as const;
  }

  if (requireSequentialIds) {
    const expectedIds = Array.from({ length: todoList.length }, (_, index) => index + 1);
    const isSequential = ids.every((id, index) => id === expectedIds[index]);
    if (!isSequential) {
      return { ok: false, error: "Todo ids must be sequential starting from 1 for write operations." } as const;
    }
  }

  const inProgressCount = todoList.filter((item) => item.status === "in-progress").length;
  if (inProgressCount > 1) {
    return { ok: false, error: "Only one todo item may be in-progress at a time." } as const;
  }

  return { ok: true } as const;
}

function calculateAdherenceScore(todoList: any[]) {
  const completedCount = todoList.filter((item) => item.status === "completed").length;
  return todoList.length === 0 ? 1 : Number((completedCount / todoList.length).toFixed(2));
}

function formatTodoListSummary(todoList: any[]) {
  if (!Array.isArray(todoList) || todoList.length === 0) {
    return "No plan items.";
  }

  return todoList
    .map((item) => `${item.id}. ${item.title || item.step || item.description || `Step ${item.id}`} [${item.status}]`)
    .join("\n");
}

// Create context tools like get_tool_response, manage_todo_list
export function createContextTools(
  stateRef: { toolHistory?: any[]; toolHistoryArchived?: any[]; todoList?: any[]; planVersion?: number; adherenceScore?: number },
  opts?: { planningEnabled?: boolean; outputSchema?: any }
) {
  const tools = [] as any[];

  if (opts?.planningEnabled) {
  const manageTodo = createTool({
      name: "manage_todo_list",
      description:
        "Manage a structured todo list to track progress and plan tasks throughout your coding session.\n\nOperations:\n- read: return the current plan\n- write: replace the full plan with a complete ordered todoList\n- update: patch existing todo items by id without resending the whole plan\n\nRules:\n- Use write only when creating or fully rewriting the plan\n- After a plan exists, prefer update for status, evidence, or owner changes\n- Update payloads should contain only the changed items\n- When using update, pass expectedVersion to avoid overwriting a newer plan\n- Keep ids unique; write operations must keep ids sequential starting from 1\n- Keep at most ONE item in-progress at a time\n- If update fails due to version mismatch, read the latest plan and retry",
      schema: z.object({
        operation: z.enum(["write", "read", "update"]),
        expectedVersion: z.number().int().min(0).optional(),
        todoList: z.array(z.union([todoWriteItemSchema, todoUpdateItemSchema])).optional()
      }),
      func: async ({ operation, expectedVersion, todoList }) => {
        const toolStateRef = (manageTodo as any)._stateRef as undefined | { __onEvent?: (e: any) => void; ctx?: { __traceSession?: any } };
        const onEvent = toolStateRef?.__onEvent;
        const emitPlanEvent = (list: any[]) => {
          const version = stateRef.planVersion || 1;
          const adherenceScore = stateRef.adherenceScore || 0;
          const planData = {
            source: "manage_todo_list",
            operation,
            version,
            adherenceScore,
            count: Array.isArray(list) ? list.length : 0,
          };
          onEvent?.({ type: "plan", todoList: list, ...planData });

          const traceSession = toolStateRef?.ctx?.__traceSession;
          recordTraceEvent(traceSession, {
            type: "plan",
            label: `Plan ${operation}`,
            actor: { scope: "agent", name: "manage_todo_list", role: "planner" },
            sections: [
              {
                kind: "summary",
                label: "Todo List",
                content: formatTodoListSummary(list),
              },
              {
                kind: "metadata",
                label: "Plan Metadata",
                data: planData,
              },
            ],
            debug: planData,
          });
        };

        const currentVersion = stateRef.planVersion || 0;
        if (operation === "read") {
          const list = stateRef.todoList || [];
          emitPlanEvent(list);
          return list;
        }

        if (typeof expectedVersion === "number" && expectedVersion !== currentVersion) {
          return {
            status: "error",
            operation,
            error: "Plan version mismatch. Read the latest plan and retry.",
            version: currentVersion,
            adherenceScore: stateRef.adherenceScore || 0,
          } as const;
        }

        if (!Array.isArray(todoList)) {
          return {
            status: "error",
            operation,
            error: "todoList is required for write and update operations.",
            version: currentVersion,
            adherenceScore: stateRef.adherenceScore || 0,
          } as const;
        }

        if (operation === "write") {
          const parsed = z.array(todoWriteItemSchema).safeParse(todoList);
          if (!parsed.success) {
            return {
              status: "error",
              operation,
              error: parsed.error.issues[0]?.message || "Invalid todoList for write.",
              version: currentVersion,
              adherenceScore: stateRef.adherenceScore || 0,
            } as const;
          }
          const normalizedList = parsed.data.map((item) => normalizeTodoItem(item));
          const validation = validatePlanInvariants(normalizedList, true);
          if (!validation.ok) {
            return {
              status: "error",
              operation,
              error: validation.error,
              version: currentVersion,
              adherenceScore: stateRef.adherenceScore || 0,
            } as const;
          }
          stateRef.todoList = normalizedList;
        } else if (operation === "update") {
          const parsed = z.array(todoUpdateItemSchema).safeParse(todoList);
          if (!parsed.success) {
            return {
              status: "error",
              operation,
              error: parsed.error.issues[0]?.message || "Invalid todoList for update.",
              version: currentVersion,
              adherenceScore: stateRef.adherenceScore || 0,
            } as const;
          }
          const currentList = Array.isArray(stateRef.todoList) ? stateRef.todoList : [];
          if (currentList.length === 0) {
            return {
              status: "error",
              operation,
              error: "No existing plan to update. Use write first.",
              version: currentVersion,
              adherenceScore: stateRef.adherenceScore || 0,
            } as const;
          }

          const currentMap = new Map(currentList.map((item) => [item.id, item]));
          const patchMap = new Map<number, (typeof parsed.data)[number]>();
          for (const item of parsed.data) {
            if (patchMap.has(item.id)) {
              return {
                status: "error",
                operation,
                error: "Update payload contains duplicate todo ids.",
                version: currentVersion,
                adherenceScore: stateRef.adherenceScore || 0,
              } as const;
            }
            patchMap.set(item.id, item);
            if (!currentMap.has(item.id)) {
              return {
                status: "error",
                operation,
                error: `Cannot update missing todo id ${item.id}. Use write to replace the plan.`,
                version: currentVersion,
                adherenceScore: stateRef.adherenceScore || 0,
              } as const;
            }
          }

          const mergedList = currentList.map((item) => {
            const patch = patchMap.get(item.id);
            return patch ? normalizeTodoItem(patch, item) : item;
          });
          const validation = validatePlanInvariants(mergedList, false);
          if (!validation.ok) {
            return {
              status: "error",
              operation,
              error: validation.error,
              version: currentVersion,
              adherenceScore: stateRef.adherenceScore || 0,
            } as const;
          }
          stateRef.todoList = mergedList;
        }

        stateRef.planVersion = currentVersion + 1;
        stateRef.adherenceScore = calculateAdherenceScore(stateRef.todoList || []);
        const payload = {
          status: "ok",
          operation,
          count: Array.isArray(todoList) ? todoList.length : undefined,
          version: stateRef.planVersion || 1,
          adherenceScore: stateRef.adherenceScore || 0,
        } as const;
        emitPlanEvent(stateRef.todoList || []);
        return payload;
      }
    });
    (manageTodo as any)._stateRef = stateRef;
    tools.push(manageTodo);
  }

  // get_tool_response retrieves original raw output by executionId
  const getTool = createTool({
    name: "get_tool_response",
    description:
      "RETRIEVE the full output of a tool execution whose response was archived, dropped, or later compacted in conversation history. Use this only when the preview or summary is missing a specific field, identifier, snippet, or exact payload you still need to finish the task. Do not call it reflexively for every archived response. When a tool response appears as 'ARCHIVED_TOOL_RESPONSE [executionId=xxx]', 'DROPPED_TOOL_RESPONSE [executionId=xxx]', or 'SUMMARIZED_TOOL_RESPONSE [...]', pass the referenced executionId to this tool to get the complete data. You can also pass the original tool_call_id from the tool call.",
    schema: z.object({ executionId: z.string().describe("Tool execution id or original tool_call_id") }),
    maxExecutionsPerRun: 8,
    func: async ({ executionId }) => {
      const matchesExecution = (t: any) => t?.executionId === executionId || t?.tool_call_id === executionId;
      let execution = stateRef.toolHistory?.find((t) => matchesExecution(t));
      if (!execution) {
        execution = stateRef.toolHistoryArchived?.find((t) => matchesExecution(t));
      }
      if (execution) {
        return execution.rawOutput || execution.output;
      }
      return "Execution not found. Please check the executionId.";
    }
  });
  // mark mutable stateRef for toolsNode sync
  (getTool as any)._stateRef = stateRef;
  tools.push(getTool);

  // Note: Structured output response tool is now managed by StructuredOutputManager
  // in the base agent (createAgent). No duplicate tool creation needed here.

  return tools;
}
