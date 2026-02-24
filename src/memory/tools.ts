import * as z from "zod";
import type { LtmAdapter, SmartState, ToolInterface } from "../types.js";
import { createTool } from "../tool.js";

type WorkingMemoryState = {
  facts: Record<string, { value: string; confidence?: number; source?: string }>;
  decisions: Array<{ decision: string; rationale?: string; ts: string }>;
  openLoops: Array<{ item: string; status: "open" | "closed"; ts: string }>;
};

function getMemory(stateRef: { state?: SmartState }): WorkingMemoryState {
  const state = stateRef.state;
  if (!state) return { facts: {}, decisions: [], openLoops: [] };
  const ctx = (state.ctx = state.ctx || {});
  if (!ctx.__workingMemory) {
    ctx.__workingMemory = { facts: {}, decisions: [], openLoops: [] } as WorkingMemoryState;
  }
  return ctx.__workingMemory as WorkingMemoryState;
}

export function createWorkingMemoryTools(stateRef: { state?: SmartState }): ToolInterface[] {
  const wmSetFact = createTool({
    name: "wm_set_fact",
    description: "Store a verified fact for the current invocation.",
    schema: z.object({ key: z.string(), value: z.string(), confidence: z.number().min(0).max(1).optional(), source: z.string().optional() }),
    func: async ({ key, value, confidence, source }) => {
      const wm = getMemory(stateRef);
      wm.facts[key] = { value, confidence, source };
      return { ok: true, key };
    },
  });

  const wmGetFact = createTool({
    name: "wm_get_fact",
    description: "Read a fact from invocation working memory.",
    schema: z.object({ key: z.string() }),
    func: async ({ key }) => {
      const wm = getMemory(stateRef);
      return { key, record: wm.facts[key] ?? null };
    },
  });

  const wmAddDecision = createTool({
    name: "wm_add_decision",
    description: "Record a decision and rationale for this invocation.",
    schema: z.object({ decision: z.string(), rationale: z.string().optional() }),
    func: async ({ decision, rationale }) => {
      const wm = getMemory(stateRef);
      wm.decisions.push({ decision, rationale, ts: new Date().toISOString() });
      return { ok: true, total: wm.decisions.length };
    },
  });

  const wmAddOpenLoop = createTool({
    name: "wm_add_open_loop",
    description: "Track an open loop (pending task/question) for the invocation.",
    schema: z.object({ item: z.string(), status: z.enum(["open", "closed"]).optional() }),
    func: async ({ item, status }) => {
      const wm = getMemory(stateRef);
      wm.openLoops.push({ item, status: status || "open", ts: new Date().toISOString() });
      return { ok: true, total: wm.openLoops.length };
    },
  });

  const wmSnapshot = createTool({
    name: "wm_snapshot",
    description: "Return a compact working-memory snapshot (facts/decisions/open loops).",
    schema: z.object({}).passthrough(),
    func: async () => {
      const wm = getMemory(stateRef);
      return wm;
    },
  });

  return [wmSetFact, wmGetFact, wmAddDecision, wmAddOpenLoop, wmSnapshot];
}

export function createLtmTools(adapter: LtmAdapter): ToolInterface[] {
  const ltmWrite = createTool({
    name: "ltm_write",
    description: "Write a long-term memory record using the configured LTM adapter.",
    schema: z.object({ key: z.string().optional(), value: z.string(), scope: z.string().optional(), confidence: z.number().min(0).max(1).optional(), ttlSeconds: z.number().int().positive().optional() }),
    func: async (args) => adapter.write(args),
  });

  const ltmSearch = createTool({
    name: "ltm_search",
    description: "Search long-term memory records via adapter.",
    schema: z.object({ query: z.string(), scope: z.string().optional(), limit: z.number().int().positive().max(20).optional() }),
    func: async ({ query, scope, limit }) => adapter.search({ query, scope, limit }),
  });

  const tools: ToolInterface[] = [ltmWrite, ltmSearch];

  if (adapter.get) {
    tools.push(
      createTool({
        name: "ltm_get",
        description: "Get a long-term memory record by id.",
        schema: z.object({ id: z.string() }),
        func: async ({ id }) => adapter.get?.(id),
      }),
    );
  }

  if (adapter.forget) {
    tools.push(
      createTool({
        name: "ltm_forget",
        description: "Forget long-term memory records by id/scope.",
        schema: z.object({ id: z.string().optional(), scope: z.string().optional() }).refine((v) => Boolean(v.id || v.scope), { message: "id or scope required" }),
        func: async ({ id, scope }) => adapter.forget?.({ id, scope }),
      }),
    );
  }

  return tools;
}
