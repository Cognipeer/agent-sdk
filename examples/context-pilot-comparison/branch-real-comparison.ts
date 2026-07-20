/**
 * TRUE branch-vs-branch real-model comparison.
 *
 * Unlike full-real-benchmark.ts (which toggles `contextPilot.enabled` on the
 * SAME checked-out code), this script imports two DIFFERENT BUILDS of the
 * SDK:
 *
 *   - "BEFORE": the actual pre-ContextPilot code, built from the git
 *     merge-base commit where feature/context-pilot diverged from main
 *     (i.e. the real code as it existed before this feature was written —
 *     no `contextPilot` option exists at all in that build, no CCR store, no
 *     dedup tracker, no format-specific compressors).
 *   - "AFTER": the current feature/context-pilot code (this repo), with
 *     `contextPilot: { enabled: true }`.
 *
 * Setup performed once, out-of-band (see terminal history / README):
 *   git worktree add --detach ../agent-sdk-baseline <merge-base-sha>
 *   cd ../agent-sdk-baseline && npm install && npm run build
 *
 * This script then dynamically imports:
 *   ../../../agent-sdk-baseline/dist/index.mjs   -> BEFORE (real old code)
 *   @cognipeer/agent-sdk                          -> AFTER (this branch)
 *
 * Both runs use the exact same real model, same tool data, same prompts —
 * the only variable is which actual git commit's SDK code is executing.
 *
 * Run: npm run example:context-pilot-branch-comparison (from examples/)
 */
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config as loadEnv } from "dotenv";
import { ChatOpenAI } from "@langchain/openai";
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

const BASELINE_DIST = path.resolve(__dirname, "../../../agent-sdk-baseline/dist/index.mjs");
if (!existsSync(BASELINE_DIST)) {
  console.error(
    `Baseline (pre-ContextPilot) build not found at ${BASELINE_DIST}.\n` +
      "Run this once first:\n" +
      "  git worktree add --detach ../agent-sdk-baseline <merge-base-sha>\n" +
      "  cd ../agent-sdk-baseline && npm install && npm run build"
  );
  process.exit(1);
}

function buildLangchainModel() {
  return new ChatOpenAI({ model: modelName, apiKey, temperature: 0, ...(baseURL ? { configuration: { baseURL } } : {}) });
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

type Sdk = {
  createSmartAgent: any;
  createTool: any;
  fromLangchainModel: any;
  label: string;
};

type ScenarioResult = {
  phase: string;
  scenario: string;
  promptTokens: number;
  totalTokens: number;
  durationMs: number;
  toolCalls: number;
  checks: Record<string, boolean>;
  followUpPromptTokens?: number;
};

// ---------------------------------------------------------------------------
// Shared tool-data builders (identical raw data fed to both SDK builds)
// ---------------------------------------------------------------------------
function buildDiff(): string {
  const lines = [
    "diff --git a/src/billing/invoice.ts b/src/billing/invoice.ts",
    "index 1111111..2222222 100644",
    "--- a/src/billing/invoice.ts",
    "+++ b/src/billing/invoice.ts",
    "@@ -40,10 +40,12 @@ export function computeTotal(items: Item[]) {",
  ];
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

// ---------------------------------------------------------------------------
// Scenario 1: relevance-scoring style lookup in a large flat catalog
// (BEFORE: no relevance scoring / no compression at all — full raw catalog
//  goes to the model every time. AFTER: Faz 1 relevance + Faz 3 compression.)
// ---------------------------------------------------------------------------
async function scenario1(sdk: Sdk): Promise<ScenarioResult> {
  const catalog = Array.from({ length: 50 }, (_, i) => ({
    sku: `SKU-${1000 + i}`,
    name: i === 23 ? "titanium-hinge-77 heavy-duty bracket" : `generic-part-${i} unrelated hardware`,
    price: i === 23 ? 42.5 : 5 + (i % 10),
  }));
  const searchParts = sdk.createTool({
    name: "search_parts",
    description: "Search a hardware parts catalog by keyword.",
    schema: z.object({ query: z.string() }),
    func: async () => catalog,
  });

  const agentOptions: any = {
    name: "PartsAgent",
    model: sdk.fromLangchainModel(buildLangchainModel()),
    tools: [searchParts],
    limits: { maxToolCalls: 3 },
  };
  if (sdk.label === "AFTER") agentOptions.contextPilot = { enabled: true, compression: { json: { targetRatio: 0.2 } } };

  const agent = sdk.createSmartAgent(agentOptions);
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
    scenario: "Catalog lookup (50 items)",
    promptTokens: usage.input,
    totalTokens: usage.total,
    durationMs,
    toolCalls: toolHistory.length,
    checks: { "correct price (42.5) found": /42\.5/.test(answer) },
  };
}

// ---------------------------------------------------------------------------
// Scenario 2: search + a follow-up turn demanding the full unfiltered list
// (BEFORE: no CCR store / no get_tool_response — the follow-up just re-sends
//  the full raw ticket list again as ordinary conversation context. AFTER:
//  Faz 2 CCR store + Faz 6 get_tool_response recovery.)
// ---------------------------------------------------------------------------
async function scenario2(sdk: Sdk): Promise<ScenarioResult> {
  const tickets = Array.from({ length: 45 }, (_, i) => ({
    id: `TCK-${i}`,
    subject: i === 30 ? "checkout-timeout escalation from enterprise account Acme Corp" : `routine ticket ${i} about unrelated topic`,
  }));
  const searchTickets = sdk.createTool({
    name: "search_tickets",
    description: "Search the support ticket queue by keyword.",
    schema: z.object({ query: z.string() }),
    func: async () => tickets,
  });

  const agentOptions: any = {
    name: "TicketAgent",
    model: sdk.fromLangchainModel(buildLangchainModel()),
    tools: [searchTickets],
    limits: { maxToolCalls: 3 },
  };
  if (sdk.label === "AFTER") agentOptions.contextPilot = { enabled: true };

  const agent = sdk.createSmartAgent(agentOptions);
  const start = Date.now();
  const first = await agent.invoke({
    messages: [{ role: "user", content: "Search tickets for 'checkout-timeout escalation' and summarize the matching ticket." }],
  });

  let recoveredAll = false;
  let secondUsage = { input: 0, output: 0, total: 0 };
  let secondToolCalls = 0;
  const second = await agent.invoke({
    messages: [
      ...first.messages,
      { role: "user", content: "Actually I need the complete unfiltered ticket list, not just the summary. Retrieve the full original list." },
    ],
    toolHistory: first.state?.toolHistory,
    toolHistoryArchived: first.state?.toolHistoryArchived,
    ctx: first.state?.ctx,
  });
  secondUsage = sumUsage(second.state?.usage?.totals);
  const secondToolHistory: any[] = second.state?.toolHistory || [];
  secondToolCalls = secondToolHistory.length;
  if (sdk.label === "AFTER") {
    const recoveryEntry = secondToolHistory.find((t) => t.toolName === "get_tool_response");
    recoveredAll = Array.isArray(recoveryEntry?.output) && recoveryEntry.output.length === 45;
  } else {
    // BEFORE has no recovery tool at all — the model answers straight from the replayed
    // conversation, which still contains the full raw list in plain text (no compression, no
    // pointer). Consider "recovered" true if the follow-up answer actually lists ~45 tickets.
    const followUpAnswer = String(second.content || "");
    recoveredAll = (followUpAnswer.match(/TCK-\d+/g) || []).length >= 40;
  }
  const durationMs = Date.now() - start;

  const firstUsage = sumUsage(first.state?.usage?.totals);
  const firstToolHistory: any[] = first.state?.toolHistory || [];
  const answer = String(first.content || "");

  return {
    phase: "Faz 2 + 6",
    scenario: "Search + full-list follow-up (45 items)",
    promptTokens: firstUsage.input,
    totalTokens: firstUsage.total,
    followUpPromptTokens: secondUsage.input,
    durationMs,
    toolCalls: firstToolHistory.length + secondToolCalls,
    checks: {
      "escalation ticket summarized": /Acme|escalation|checkout-timeout/i.test(answer),
      "full ticket list recoverable in follow-up": recoveredAll,
    },
  };
}

// ---------------------------------------------------------------------------
// Scenario 3: diff + log + grep investigation
// (BEFORE: no format-specific compressors — raw diff/log/grep text sent as
//  -is. AFTER: Faz 4 diff/log/search compressors.)
// ---------------------------------------------------------------------------
async function scenario3(sdk: Sdk): Promise<ScenarioResult> {
  const getDiff = sdk.createTool({
    name: "get_diff",
    description: "Returns the diff of the most recent commit to src/billing/invoice.ts.",
    schema: z.object({}),
    func: async () => buildDiff(),
  });
  const searchLogs = sdk.createTool({
    name: "search_logs",
    description: "Returns recent billing service logs.",
    schema: z.object({}),
    func: async () => buildLogs(),
  });
  const grepCodebase = sdk.createTool({
    name: "grep_codebase",
    description: "Searches the codebase for usages of computeTotal.",
    schema: z.object({ query: z.string() }),
    func: async () => buildGrep(),
  });

  const agentOptions: any = {
    name: "BillingInvestigator",
    model: sdk.fromLangchainModel(buildLangchainModel()),
    tools: [getDiff, searchLogs, grepCodebase],
    limits: { maxToolCalls: 5 },
  };
  if (sdk.label === "AFTER") agentOptions.contextPilot = { enabled: true };

  const agent = sdk.createSmartAgent(agentOptions);
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
    scenario: "diff + log + grep investigation",
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
// Scenario 4: repeat identical tool call across 2 separate invokes
// (BEFORE: no dedup tracker — the second call's full payload is sent again
//  in full. AFTER: Faz 5 cross-turn dedup.)
// ---------------------------------------------------------------------------
async function scenario4(sdk: Sdk): Promise<ScenarioResult> {
  const lookupOrder = sdk.createTool({
    name: "lookup_order",
    description: "Looks up full order details by order id.",
    schema: z.object({ orderId: z.string() }),
    func: async ({ orderId }: { orderId: string }) => ({
      orderId,
      items: Array.from({ length: 30 }, (_, i) => ({ sku: `ITEM-${i}`, qty: i + 1, note: `line item ${i} padding to make payload large enough to trigger dedup` })),
    }),
  });

  const agentOptions: any = {
    name: "OrderAgent",
    model: sdk.fromLangchainModel(buildLangchainModel()),
    tools: [lookupOrder],
    limits: { maxToolCalls: 3 },
  };
  if (sdk.label === "AFTER") agentOptions.contextPilot = { enabled: true };

  const agent = sdk.createSmartAgent(agentOptions);
  const start = Date.now();
  const first = await agent.invoke({
    messages: [{ role: "user", content: "Look up order ORD-4471 and tell me how many items it has." }],
  });

  // Fresh conversation for the second invoke (no assistant memory of the previous answer) so the
  // real model is forced to call the tool again, giving the dedup mechanism a genuine duplicate
  // to catch (real models tend to answer from memory instead of re-calling a tool if the prior
  // turn is replayed to them).
  const second = await agent.invoke({
    messages: [{ role: "user", content: "Look up order ORD-4471 and tell me how many items it has." }],
    toolHistory: first.state?.toolHistory,
    toolHistoryArchived: first.state?.toolHistoryArchived,
    ctx: first.state?.ctx,
  });
  const durationMs = Date.now() - start;

  const usage1 = sumUsage(first.state?.usage?.totals);
  const usage2 = sumUsage(second.state?.usage?.totals);
  const firstToolHistory: any[] = first.state?.toolHistory || [];
  const firstExecutionIds = new Set(firstToolHistory.map((t) => t.executionId));
  const secondToolHistory: any[] = second.state?.toolHistory || [];
  const newLookupEntries = secondToolHistory.filter(
    (t) => t.toolName === "lookup_order" && !firstExecutionIds.has(t.executionId)
  );
  const modelDidReCall = newLookupEntries.length > 0;
  const dedupFired = sdk.label === "AFTER" ? newLookupEntries.some((t) => !!t.contextPilot?.duplicateOf) : false;

  return {
    phase: "Faz 5",
    scenario: "Repeat lookup_order across 2 invokes",
    promptTokens: usage1.input,
    totalTokens: usage1.total,
    followUpPromptTokens: usage2.input,
    durationMs,
    toolCalls: firstToolHistory.length + secondToolHistory.length,
    checks: {
      // BEFORE has no dedup mechanism at all, so it's expected (not a failure) for this to be
      // false there — only meaningful to require on AFTER, and only when a genuine repeat call
      // happened.
      "second identical call deduped (AFTER only, when model re-called it)":
        sdk.label === "AFTER" ? (modelDidReCall ? dedupFired : true) : true,
    },
  };
}

// ---------------------------------------------------------------------------
// Scenario 5: multi-tool investigation with one tool that must stay untouched
// (BEFORE: no excludeTools concept — irrelevant here since nothing is
//  compressed anyway. AFTER: Faz 7 excludeTools + deep profile + recovery.)
// ---------------------------------------------------------------------------
async function scenario5(sdk: Sdk): Promise<ScenarioResult> {
  const getDiff = sdk.createTool({
    name: "get_diff",
    description: "Returns the diff of the most recent commit to src/auth/session.ts.",
    schema: z.object({}),
    func: async () => buildDiff().replace(/invoice/g, "session").replace(/billing/g, "auth"),
  });
  const grepCodebase = sdk.createTool({
    name: "grep_codebase",
    description: "Searches the codebase for a term.",
    schema: z.object({ query: z.string() }),
    func: async () => buildGrep().replace(/computeTotal/g, "validateSession"),
  });
  const rawStatus = sdk.createTool({
    name: "raw_status",
    description: "Returns raw CI status, must never be altered.",
    schema: z.object({}),
    func: async () => ({ ci: "green", commit: "abc1234" }),
  });

  const agentOptions: any = {
    name: "GrandIntegrationAgent",
    model: sdk.fromLangchainModel(buildLangchainModel()),
    tools: [getDiff, grepCodebase, rawStatus],
    limits: { maxToolCalls: 6 },
  };
  if (sdk.label === "AFTER") {
    agentOptions.runtimeProfile = "deep";
    agentOptions.contextPilot = { enabled: true, excludeTools: ["raw_status"] };
  }

  const agent = sdk.createSmartAgent(agentOptions);
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
  const diffEntry = (first.state?.toolHistory || []).find((t: any) => t.toolName === "get_diff");
  if (sdk.label === "AFTER") {
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
      });
      secondUsage = sumUsage(second.state?.usage?.totals);
      const secondToolHistory: any[] = second.state?.toolHistory || [];
      secondToolCalls = secondToolHistory.length;
      const recoveryEntry = secondToolHistory.find((t: any) => t.toolName === "get_tool_response");
      recoveredDiff = typeof recoveryEntry?.output === "string" && recoveryEntry.output === diffEntry.rawOutput;
    }
  } else {
    // BEFORE has no CCR store / get_tool_response tool at all, so there's nothing to recover —
    // the raw diff is simply always available in full since nothing was ever compressed away.
    recoveredDiff = true;
  }
  const durationMs = Date.now() - start;

  const usage1 = sumUsage(first.state?.usage?.totals);
  const toolHistory: any[] = first.state?.toolHistory || [];
  const answer = String(first.content || "");
  const rawStatusEntry = toolHistory.find((t) => t.toolName === "raw_status");

  return {
    phase: "Faz 7",
    scenario: "diff + grep + excluded raw_status",
    promptTokens: usage1.input,
    totalTokens: usage1.total,
    followUpPromptTokens: sdk.label === "AFTER" ? secondUsage.input : undefined,
    durationMs,
    toolCalls: toolHistory.length + secondToolCalls,
    checks: {
      "summarized diff+grep+status": /validateSession|session\.ts|ci.*green|green.*ci/i.test(answer),
      "raw_status untouched (excludeTools, AFTER only)":
        sdk.label === "AFTER" ? rawStatusEntry?.contextPilot?.applied !== true : true,
      "full diff recoverable": recoveredDiff,
    },
  };
}

async function runScenarioForBothSdks(
  name: string,
  fn: (sdk: Sdk) => Promise<ScenarioResult>,
  before: Sdk,
  after: Sdk
) {
  console.log(`\n--- ${name}: running on BEFORE (pre-ContextPilot, commit-accurate) ---`);
  const beforeResult = await fn(before);
  console.log(`--- ${name}: running on AFTER (feature/context-pilot, ContextPilot enabled) ---`);
  const afterResult = await fn(after);
  return { before: beforeResult, after: afterResult };
}

async function main() {
  console.log(`Using real model: ${modelName}${baseURL ? ` via ${baseURL}` : ""}`);
  console.log(`BEFORE build: ${BASELINE_DIST}`);
  console.log("Loading both SDK builds (real pre-ContextPilot commit + current feature/context-pilot branch)...\n");

  const beforeModule: any = await import(BASELINE_DIST);
  const afterModule: any = await import("@cognipeer/agent-sdk");

  const before: Sdk = {
    label: "BEFORE",
    createSmartAgent: beforeModule.createSmartAgent,
    createTool: beforeModule.createTool,
    fromLangchainModel: beforeModule.fromLangchainModel,
  };
  const after: Sdk = {
    label: "AFTER",
    createSmartAgent: afterModule.createSmartAgent,
    createTool: afterModule.createTool,
    fromLangchainModel: afterModule.fromLangchainModel,
  };

  console.log("Running the true branch-vs-branch benchmark (this makes ~40-50 real API calls, may take a few minutes)...");

  const results = [
    await runScenarioForBothSdks("Scenario 1 (Faz 1+3)", scenario1, before, after),
    await runScenarioForBothSdks("Scenario 2 (Faz 2+6)", scenario2, before, after),
    await runScenarioForBothSdks("Scenario 3 (Faz 4)", scenario3, before, after),
    await runScenarioForBothSdks("Scenario 4 (Faz 5)", scenario4, before, after),
    await runScenarioForBothSdks("Scenario 5 (Faz 7)", scenario5, before, after),
  ];

  console.log("\n\n=================== FINAL REPORT: real BEFORE-commit vs real AFTER-commit ===================\n");
  const rows: Record<string, any>[] = [];
  let totalPromptBefore = 0;
  let totalPromptAfter = 0;
  let allChecksPassed = true;

  for (const { before: b, after: a } of results) {
    rows.push({
      Phase: b.phase,
      Scenario: b.scenario,
      "Prompt tok (BEFORE)": b.promptTokens,
      "Prompt tok (AFTER)": a.promptTokens,
      "Reduction %": b.promptTokens > 0 ? `${Math.round((1 - a.promptTokens / b.promptTokens) * 100)}%` : "n/a",
      "Follow-up (BEFORE)": b.followUpPromptTokens ?? "-",
      "Follow-up (AFTER)": a.followUpPromptTokens ?? "-",
      "Latency BEFORE (ms)": b.durationMs,
      "Latency AFTER (ms)": a.durationMs,
    });
    totalPromptBefore += b.promptTokens;
    totalPromptAfter += a.promptTokens;

    for (const [check, passed] of Object.entries(b.checks)) {
      if (!passed) {
        allChecksPassed = false;
        console.log(`[FAIL] ${b.phase} / BEFORE / ${check}`);
      }
    }
    for (const [check, passed] of Object.entries(a.checks)) {
      if (!passed) {
        allChecksPassed = false;
        console.log(`[FAIL] ${a.phase} / AFTER / ${check}`);
      }
    }
  }

  console.table(rows);
  const overallPct = totalPromptBefore > 0 ? Math.round((1 - totalPromptAfter / totalPromptBefore) * 100) : 0;
  console.log(
    `\nOverall real prompt-token reduction, real pre-ContextPilot commit vs real feature/context-pilot commit: ` +
      `${overallPct}% (${totalPromptBefore} -> ${totalPromptAfter} tokens).`
  );
  console.log(`All correctness checks passed: ${allChecksPassed ? "YES" : "NO (see [FAIL] lines above)"}.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
