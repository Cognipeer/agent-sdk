/**
 * ContextPilot FULL real-model benchmark — covers every phase (Faz 1-7)
 * exercised by the 31 deterministic e2e tests in
 * tests/unit/smart/contextPilotIntegration.test.ts, but here driven by a
 * REAL OpenAI-compatible model (credentials from the repo root .env) instead
 * of a scripted fake model. Nothing about the model's tool-calling or final
 * answers is scripted — only the tool *data* is fixed so both runs
 * (contextPilot on/off) see byte-identical raw inputs.
 *
 * Scope note: the 31 unit tests include several pure-algorithm edge cases
 * (BM25 length normalization, keyword-stuffing saturation, TTL/eviction
 * timing, textCrusher's keep-floor-of-3, etc.) that test internal scoring/
 * storage math directly and do not depend on which model is calling them —
 * re-running those specific edge cases through a real, paid model would burn
 * API budget without adding new evidence (the math is identical regardless
 * of caller). Instead, this benchmark runs one real, end-to-end scenario per
 * *phase* that exercises the same underlying mechanism live against a real
 * model, so every phase gets real proof, without needlessly repeating pure
 * unit-math 31 times over the network.
 *
 * Phases covered here:
 *   Scenario 1 -> Faz 1 (relevance) + Faz 3 (JSON compression ratio)
 *   Scenario 2 -> Faz 2 (CCR store) + Faz 6 (get_tool_response recovery)
 *   Scenario 3 -> Faz 4 (diff / log / search format-specific compressors)
 *   Scenario 4 -> Faz 5 (cross-turn dedup + cache-alignment warning)
 *   Scenario 5 -> Faz 7 (grand integration: multiple compressors,
 *                        excludeTools bypass, non-default profile, 2 invokes
 *                        sharing runtime, final CCR recovery)
 *
 * Run: npm run example:context-pilot-full-benchmark (from examples/)
 * Requires: a valid .env at the repo root (see .env.example). Makes ~50-60
 * real API calls total (2 runs x 5 scenarios, some multi-turn) — takes a few
 * minutes and a small amount of real API cost.
 */
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config as loadEnv } from "dotenv";
import { ChatOpenAI } from "@langchain/openai";
import { createSmartAgent, createTool, fromLangchainModel } from "@cognipeer/agent-sdk";
import { z } from "zod";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const envPath = path.resolve(__dirname, "../../.env");
if (existsSync(envPath)) loadEnv({ path: envPath });

const apiKey = process.env.OPENAI_API_KEY;
const baseURL = process.env.OPENAI_BASE_URL;
const modelName = process.env.OPENAI_MODEL || "gpt-4o-mini";

if (!apiKey) {
  console.error(`No OPENAI_API_KEY found (looked for .env at ${envPath}).`);
  process.exit(1);
}

function buildModel() {
  return fromLangchainModel(
    new ChatOpenAI({ model: modelName, apiKey, temperature: 0, ...(baseURL ? { configuration: { baseURL } } : {}) })
  );
}

function sumUsage(usageTotals: Record<string, any> | undefined) {
  return Object.values(usageTotals || {}).reduce(
    (acc: any, u: any) => ({
      input: acc.input + (u?.input || 0),
      output: acc.output + (u?.output || 0),
      total: acc.total + (u?.total || 0),
    }),
    { input: 0, output: 0, total: 0 }
  );
}

type ScenarioResult = {
  phase: string;
  scenario: string;
  promptTokens: number;
  totalTokens: number;
  durationMs: number;
  toolCalls: number;
  checks: Record<string, boolean>;
  /** Tokens spent on an optional follow-up (recovery/re-check) invoke that only
   * exists in the ContextPilot run — kept OUT of the primary reduction-%
   * comparison since baseline has no equivalent turn to compare against. */
  followUpPromptTokens?: number;
};

// ---------------------------------------------------------------------------
// Scenario 1: Faz 1 (relevance) + Faz 3 (custom JSON targetRatio)
// ---------------------------------------------------------------------------
async function scenario1(contextPilotEnabled: boolean): Promise<ScenarioResult> {
  const catalog = Array.from({ length: 50 }, (_, i) => ({
    sku: `SKU-${1000 + i}`,
    name: i === 23 ? "titanium-hinge-77 heavy-duty bracket" : `generic-part-${i} unrelated hardware`,
    price: i === 23 ? 42.5 : 5 + (i % 10),
  }));
  const searchParts = createTool({
    name: "search_parts",
    description: "Search a hardware parts catalog by keyword.",
    schema: z.object({ query: z.string() }),
    func: async () => catalog,
  });

  const agent = createSmartAgent({
    name: "PartsAgent",
    model: buildModel(),
    tools: [searchParts],
    limits: { maxToolCalls: 3 },
    contextPilot: { enabled: contextPilotEnabled, compression: { json: { targetRatio: 0.2 } } },
  });

  const start = Date.now();
  const result = await agent.invoke({
    messages: [{ role: "user", content: "Search the parts catalog for 'titanium-hinge-77' and tell me its exact price." }],
  });
  const durationMs = Date.now() - start;

  const toolHistory: any[] = result.state?.toolHistory || [];
  const usage = sumUsage(result.state?.usage?.totals);
  const answer = String(result.content || "");

  return {
    phase: "Faz 1 + 3",
    scenario: "Relevance scoring + custom JSON targetRatio (50-item catalog)",
    promptTokens: usage.input,
    totalTokens: usage.total,
    durationMs,
    toolCalls: toolHistory.length,
    checks: { "correct price (42.5) found": /42\.5/.test(answer) },
  };
}

// ---------------------------------------------------------------------------
// Scenario 2: Faz 2 (CCR store) + Faz 6 (get_tool_response recovery)
// ---------------------------------------------------------------------------
async function scenario2(contextPilotEnabled: boolean): Promise<ScenarioResult> {
  const tickets = Array.from({ length: 45 }, (_, i) => ({
    id: `TCK-${i}`,
    subject: i === 30 ? "checkout-timeout escalation from enterprise account Acme Corp" : `routine ticket ${i} about unrelated topic`,
  }));
  const searchTickets = createTool({
    name: "search_tickets",
    description: "Search the support ticket queue by keyword.",
    schema: z.object({ query: z.string() }),
    func: async () => tickets,
  });

  const agent = createSmartAgent({
    name: "TicketAgent",
    model: buildModel(),
    tools: [searchTickets],
    limits: { maxToolCalls: 3 },
    contextPilot: { enabled: contextPilotEnabled },
  });

  const start = Date.now();
  const first = await agent.invoke({
    messages: [{ role: "user", content: "Search tickets for 'checkout-timeout escalation' and summarize the matching ticket." }],
  });

  let recoveredAll = false;
  let secondUsage = { input: 0, output: 0, total: 0 };
  let secondToolCalls = 0;
  if (contextPilotEnabled) {
    const second = await agent.invoke({
      messages: [
        ...first.messages,
        { role: "user", content: "Actually I need the complete unfiltered ticket list, not just the summary. Retrieve the full original list." },
      ],
      toolHistory: first.state?.toolHistory,
      toolHistoryArchived: first.state?.toolHistoryArchived,
      ctx: first.state?.ctx,
    } as any);
    secondUsage = sumUsage(second.state?.usage?.totals);
    const secondToolHistory: any[] = second.state?.toolHistory || [];
    secondToolCalls = secondToolHistory.length;
    const recoveryEntry = secondToolHistory.find((t) => t.toolName === "get_tool_response");
    recoveredAll = Array.isArray(recoveryEntry?.output) && recoveryEntry.output.length === 45;
  }
  const durationMs = Date.now() - start;

  const firstUsage = sumUsage(first.state?.usage?.totals);
  const firstToolHistory: any[] = first.state?.toolHistory || [];
  const answer = String(first.content || "");

  return {
    phase: "Faz 2 + 6",
    scenario: "CCR store + real get_tool_response recovery across 2 invokes (45-item queue)",
    promptTokens: firstUsage.input,
    totalTokens: firstUsage.total,
    followUpPromptTokens: contextPilotEnabled ? secondUsage.input : undefined,
    durationMs,
    toolCalls: firstToolHistory.length + secondToolCalls,
    checks: {
      "escalation ticket summarized": /Acme|escalation|checkout-timeout/i.test(answer),
      "full 45-item list recovered (ContextPilot run only)": contextPilotEnabled ? recoveredAll : true,
    },
  };
}

// ---------------------------------------------------------------------------
// Scenario 3: Faz 4 (diff / log / search format-specific compressors)
// ---------------------------------------------------------------------------
function buildDiff(): string {
  const lines = ["diff --git a/src/billing/invoice.ts b/src/billing/invoice.ts", "index 1111111..2222222 100644", "--- a/src/billing/invoice.ts", "+++ b/src/billing/invoice.ts", "@@ -40,10 +40,12 @@ export function computeTotal(items: Item[]) {"];
  for (let i = 0; i < 40; i += 1) lines.push(`   const filler_${i} = noopHelper(${i}); // unrelated context line`);
  lines.push("-  return subtotal;");
  lines.push("+  return subtotal * (1 - discountRate); // BUG: discountRate not clamped to [0,1], can go negative");
  return lines.join("\n");
}
function buildLogs(): string {
  const lines: string[] = [];
  for (let i = 0; i < 120; i += 1) lines.push(`INFO 0${i % 9}:0${i % 6}:${10 + (i % 40)} [billing] invoice computed ok id=${i}`);
  lines.splice(60, 0, "ERROR 03:22:41 [billing] computeTotal returned negative total (-14.50) for invoice INV-7788, discountRate=1.4");
  return lines.join("\n");
}
function buildGrep(): string {
  const lines: string[] = [];
  for (let i = 0; i < 35; i += 1) lines.push(`src/unrelated/file${i}.ts:${i + 1}: some unrelated line ${i}`);
  lines.splice(18, 0, "src/billing/invoiceController.ts:52: const total = computeTotal(order.items); // no discountRate validation here either");
  return lines.join("\n");
}

async function scenario3(contextPilotEnabled: boolean): Promise<ScenarioResult> {
  const getDiff = createTool({
    name: "get_diff",
    description: "Returns the diff of the most recent commit to src/billing/invoice.ts.",
    schema: z.object({}),
    func: async () => buildDiff(),
  });
  const searchLogs = createTool({
    name: "search_logs",
    description: "Returns recent billing service logs.",
    schema: z.object({}),
    func: async () => buildLogs(),
  });
  const grepCodebase = createTool({
    name: "grep_codebase",
    description: "Searches the codebase for usages of computeTotal.",
    schema: z.object({ query: z.string() }),
    func: async () => buildGrep(),
  });

  const agent = createSmartAgent({
    name: "BillingInvestigator",
    model: buildModel(),
    tools: [getDiff, searchLogs, grepCodebase],
    limits: { maxToolCalls: 5 },
    contextPilot: { enabled: contextPilotEnabled },
  });

  const start = Date.now();
  const result = await agent.invoke({
    messages: [
      {
        role: "user",
        content:
          "Invoices are showing negative totals in production. Call get_diff to see the recent change to invoice.ts, " +
          "call search_logs to find the error, and call grep_codebase to find where computeTotal is used elsewhere. " +
          "Then explain the root cause bug.",
      },
    ],
  });
  const durationMs = Date.now() - start;

  const toolHistory: any[] = result.state?.toolHistory || [];
  const usage = sumUsage(result.state?.usage?.totals);
  const answer = String(result.content || "");

  return {
    phase: "Faz 4",
    scenario: "diff + log + grep format-specific compressors in one investigation",
    promptTokens: usage.input,
    totalTokens: usage.total,
    durationMs,
    toolCalls: toolHistory.length,
    checks: {
      "identified discountRate clamping bug": /discountRate/i.test(answer) && /(clamp|negative|not (validated|clamped))/i.test(answer),
    },
  };
}

// ---------------------------------------------------------------------------
// Scenario 4: Faz 5 (cross-turn dedup + cache-alignment warning)
// ---------------------------------------------------------------------------
async function scenario4(contextPilotEnabled: boolean): Promise<ScenarioResult> {
  const lookupOrder = createTool({
    name: "lookup_order",
    description: "Looks up full order details by order id.",
    schema: z.object({ orderId: z.string() }),
    func: async ({ orderId }: { orderId: string }) => ({
      orderId,
      items: Array.from({ length: 30 }, (_, i) => ({ sku: `ITEM-${i}`, qty: i + 1, note: `line item ${i} padding to make payload large enough to trigger dedup` })),
    }),
  });

  const events: any[] = [];
  const agent = createSmartAgent({
    name: "OrderAgent",
    model: buildModel(),
    tools: [lookupOrder],
    limits: { maxToolCalls: 3 },
    contextPilot: { enabled: contextPilotEnabled },
    systemPrompt:
      `Session sk-abcdefghijklmnopqrstuvwxyz123456 issued at ${new Date().toISOString()} for request ` +
      "123e4567-e89b-12d3-a456-426614174000.",
  });

  const start = Date.now();
  const first = await agent.invoke(
    { messages: [{ role: "user", content: "Look up order ORD-4471 and tell me how many items it has." }] },
    { onEvent: (event: any) => events.push(event) }
  );

  // Deliberately start a FRESH conversation (no assistant memory of the previous answer) so the
  // real model has no choice but to call the tool again — only ctx/toolHistory are carried over,
  // which is what actually drives cross-turn dedup + CCR recovery. If we instead replayed the
  // prior assistant turn, real models tend to just answer from their own conversational memory
  // instead of re-invoking the tool, which starves the dedup mechanism of a real duplicate to catch.
  const second = await agent.invoke(
    {
      messages: [{ role: "user", content: "Look up order ORD-4471 and tell me how many items it has." }],
      toolHistory: first.state?.toolHistory,
      toolHistoryArchived: first.state?.toolHistoryArchived,
      ctx: first.state?.ctx,
    } as any,
    { onEvent: (event: any) => events.push(event) }
  );
  const durationMs = Date.now() - start;

  const usage1 = sumUsage(first.state?.usage?.totals);
  const usage2 = sumUsage(second.state?.usage?.totals);
  const firstToolHistory: any[] = first.state?.toolHistory || [];
  const firstExecutionIds = new Set(firstToolHistory.map((t) => t.executionId));
  const secondToolHistory: any[] = second.state?.toolHistory || [];
  // Only entries that are genuinely NEW in the second invoke count as a real repeat call — the
  // second invoke's toolHistory input already carries the first invoke's entries forward, so a
  // naive `.find()` would otherwise match the stale first-invoke entry even if the model never
  // called the tool again.
  const newLookupEntries = secondToolHistory.filter(
    (t) => t.toolName === "lookup_order" && !firstExecutionIds.has(t.executionId)
  );
  const modelDidReCall = newLookupEntries.length > 0;
  const dedupFired = newLookupEntries.some((t) => !!t.contextPilot?.duplicateOf);
  const cacheEventFired = events.some((e) => e.type === "metadata" && e.reason === "context_pilot_cache_alignment");

  return {
    phase: "Faz 5",
    scenario: "Cross-turn dedup (repeat lookup_order call) + cache-alignment warning (volatile system prompt)",
    promptTokens: usage1.input,
    totalTokens: usage1.total,
    followUpPromptTokens: usage2.input,
    durationMs,
    toolCalls: (first.state?.toolHistory?.length || 0) + secondToolHistory.length,
    checks: {
      // If the model didn't actually re-call the tool, dedup had nothing to catch — that's a
      // real-model behavior choice, not a ContextPilot defect, so only fail this check when a
      // genuine repeat call happened but wasn't deduped.
      "second identical call deduped (when model re-called it)": contextPilotEnabled ? (modelDidReCall ? dedupFired : true) : true,
      "cache-alignment warning fired (ContextPilot run only)": contextPilotEnabled ? cacheEventFired : true,
    },
  };
}

// ---------------------------------------------------------------------------
// Scenario 5: Faz 7 grand integration (diff + search, excludeTools, deep
// profile, 2 invokes sharing runtime, final CCR recovery)
// ---------------------------------------------------------------------------
async function scenario5(contextPilotEnabled: boolean): Promise<ScenarioResult> {
  const getDiff = createTool({
    name: "get_diff",
    description: "Returns the diff of the most recent commit to src/auth/session.ts.",
    schema: z.object({}),
    func: async () => buildDiff().replace(/invoice/g, "session").replace(/billing/g, "auth"),
  });
  const grepCodebase = createTool({
    name: "grep_codebase",
    description: "Searches the codebase for a term.",
    schema: z.object({ query: z.string() }),
    func: async () => buildGrep().replace(/computeTotal/g, "validateSession"),
  });
  const rawStatus = createTool({
    name: "raw_status",
    description: "Returns raw CI status, must never be altered.",
    schema: z.object({}),
    func: async () => ({ ci: "green", commit: "abc1234" }),
  });

  const agent = createSmartAgent({
    name: "GrandIntegrationAgent",
    model: buildModel(),
    tools: [getDiff, grepCodebase, rawStatus],
    limits: { maxToolCalls: 6 },
    runtimeProfile: "deep",
    contextPilot: { enabled: contextPilotEnabled, excludeTools: ["raw_status"] },
  });

  const start = Date.now();
  const first = await agent.invoke({
    messages: [
      {
        role: "user",
        content:
          "Call get_diff to review the session.ts change, call grep_codebase for validateSession usages, and call raw_status for CI status. Summarize all three.",
      },
    ],
  });

  let recoveredDiff = false;
  let secondUsage = { input: 0, output: 0, total: 0 };
  let secondToolCalls = 0;
  if (contextPilotEnabled) {
    const diffEntry = (first.state?.toolHistory || []).find((t: any) => t.toolName === "get_diff");
    const ccrHash = diffEntry?.contextPilot?.ccrHash;
    if (ccrHash) {
      const second = await agent.invoke({
        messages: [
          ...first.messages,
          { role: "user", content: `Now retrieve the full original diff using get_tool_response with executionId "${ccrHash}".` },
        ],
        toolHistory: first.state?.toolHistory,
        toolHistoryArchived: first.state?.toolHistoryArchived,
        ctx: first.state?.ctx,
      } as any);
      secondUsage = sumUsage(second.state?.usage?.totals);
      const secondToolHistory: any[] = second.state?.toolHistory || [];
      secondToolCalls = secondToolHistory.length;
      const recoveryEntry = secondToolHistory.find((t: any) => t.toolName === "get_tool_response");
      recoveredDiff = typeof recoveryEntry?.output === "string" && recoveryEntry.output === diffEntry.rawOutput;
    }
  }
  const durationMs = Date.now() - start;

  const usage1 = sumUsage(first.state?.usage?.totals);
  const toolHistory: any[] = first.state?.toolHistory || [];
  const answer = String(first.content || "");
  const rawStatusEntry = toolHistory.find((t) => t.toolName === "raw_status");

  return {
    phase: "Faz 7",
    scenario: "Grand integration: diff+grep compressors, excludeTools bypass, deep profile, CCR recovery",
    promptTokens: usage1.input,
    totalTokens: usage1.total,
    followUpPromptTokens: contextPilotEnabled ? secondUsage.input : undefined,
    durationMs,
    toolCalls: toolHistory.length + secondToolCalls,
    checks: {
      "summarized diff+grep+status": /validateSession|session\.ts|ci.*green|green.*ci/i.test(answer),
      "raw_status left untouched by excludeTools": rawStatusEntry ? rawStatusEntry.contextPilot?.applied !== true : true,
      "full diff recovered via get_tool_response (ContextPilot run only)": contextPilotEnabled ? recoveredDiff : true,
    },
  };
}

async function runBoth(name: string, fn: (enabled: boolean) => Promise<ScenarioResult>) {
  console.log(`\n--- ${name}: running WITHOUT ContextPilot ---`);
  const off = await fn(false);
  console.log(`--- ${name}: running WITH ContextPilot ---`);
  const on = await fn(true);
  return { off, on };
}

async function main() {
  console.log(`Using real model: ${modelName}${baseURL ? ` via ${baseURL}` : ""}`);
  console.log("Running the full Faz 1-7 real-model benchmark (this makes ~50-60 real API calls, may take a few minutes)...\n");

  const results = [
    await runBoth("Scenario 1 (Faz 1+3)", scenario1),
    await runBoth("Scenario 2 (Faz 2+6)", scenario2),
    await runBoth("Scenario 3 (Faz 4)", scenario3),
    await runBoth("Scenario 4 (Faz 5)", scenario4),
    await runBoth("Scenario 5 (Faz 7)", scenario5),
  ];

  console.log("\n\n=================== FINAL REPORT: ContextPilot real-model A/B, all phases ===================\n");
  const rows: Record<string, any>[] = [];
  let totalPromptOff = 0;
  let totalPromptOn = 0;
  let allChecksPassed = true;

  for (const { off, on } of results) {
    rows.push({
      Phase: off.phase,
      Scenario: off.scenario.slice(0, 46),
      "Prompt tok (off)": off.promptTokens,
      "Prompt tok (on)": on.promptTokens,
      "Reduction %": off.promptTokens > 0 ? `${Math.round((1 - on.promptTokens / off.promptTokens) * 100)}%` : "n/a",
      "Recovery/re-check follow-up (on only)": on.followUpPromptTokens ?? "-",
      "Latency off (ms)": off.durationMs,
      "Latency on (ms)": on.durationMs,
    });
    totalPromptOff += off.promptTokens;
    totalPromptOn += on.promptTokens;

    for (const [check, passed] of Object.entries({ ...off.checks })) {
      if (!passed) {
        allChecksPassed = false;
        console.log(`[FAIL] ${off.phase} / baseline / ${check}`);
      }
    }
    for (const [check, passed] of Object.entries({ ...on.checks })) {
      if (!passed) {
        allChecksPassed = false;
        console.log(`[FAIL] ${on.phase} / ContextPilot / ${check}`);
      }
    }
  }

  console.table(rows);
  const overallPct = totalPromptOff > 0 ? Math.round((1 - totalPromptOn / totalPromptOff) * 100) : 0;
  console.log(`\nOverall real prompt-token reduction across all 5 phases: ${overallPct}% (${totalPromptOff} -> ${totalPromptOn} tokens).`);
  console.log(`All correctness checks passed: ${allChecksPassed ? "YES" : "NO (see [FAIL] lines above)"}.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
