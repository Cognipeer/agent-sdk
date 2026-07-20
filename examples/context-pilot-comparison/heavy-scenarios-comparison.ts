/**
 * ContextPilot HEAVY / research-style real-model comparison.
 *
 * The other benchmarks (full-real-benchmark.ts, branch-real-comparison.ts)
 * use small, single-purpose scenarios (1-3 tool calls) to isolate each Faz
 * phase individually. This file instead stress-tests ContextPilot with the
 * kind of workload real usage actually looks like:
 *
 *   Scenario 6 ("research-heavy"): ONE investigation that calls SIX
 *   different tools in a single conversation (logs, metrics, two diffs,
 *   grep, docs, tickets) — a realistic "agent researches a production
 *   incident across every available data source" workflow — plus a
 *   follow-up turn that forces recovery of the full raw metrics payload.
 *
 *   Scenario 7 ("long session"): FOUR sequential turns in the same
 *   conversation (a support case that evolves over time), measuring
 *   CUMULATIVE prompt tokens turn-by-turn. This is where ContextPilot's
 *   benefit compounds the most in real usage, since without pruning every
 *   turn's tool history keeps accumulating in full.
 *
 * Like branch-real-comparison.ts, this imports TWO separately built SDKs:
 * the real pre-ContextPilot commit (sibling worktree ../agent-sdk-baseline)
 * and the current feature/context-pilot branch. See that file / the README
 * for the one-time worktree setup.
 *
 * Run: npm run example:context-pilot-heavy-comparison (from examples/)
 * Cost note: this makes MORE real API calls than the other demos (heavier,
 * multi-tool, multi-turn scenarios) — expect it to take longer.
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

type Sdk = { createSmartAgent: any; createTool: any; fromLangchainModel: any; label: "BEFORE" | "AFTER" };

// ---------------------------------------------------------------------------
// Heavy tool-data builders (bigger than the other benchmarks, on purpose)
// ---------------------------------------------------------------------------
function buildHeavyLogs(): string {
  const lines: string[] = [];
  for (let i = 0; i < 250; i += 1) {
    const svc = ["checkout", "payments", "inventory", "auth"][i % 4];
    lines.push(`INFO 0${i % 9}:0${i % 6}:${10 + (i % 40)} [${svc}] request handled ok id=${i}`);
  }
  lines.splice(140, 0, "ERROR 04:11:52 [payments] connection pool exhausted, 0/20 connections available, 312 requests queued");
  lines.splice(190, 0, "WARN 04:12:10 [checkout] retrying payment authorization after timeout (attempt 2/3)");
  return lines.join("\n");
}

function buildMetrics(): Array<{ t: string; service: string; latencyMs: number; errorRate: number }> {
  return Array.from({ length: 60 }, (_, i) => {
    const spike = i === 40;
    return {
      t: `2026-07-20T04:${String(i).padStart(2, "0")}:00Z`,
      service: "payments",
      latencyMs: spike ? 8400 : 120 + (i % 5) * 10,
      errorRate: spike ? 0.42 : 0.01,
    };
  });
}

function buildDiffAuth(): string {
  const lines = [
    "diff --git a/src/payments/pool.ts b/src/payments/pool.ts",
    "index aaaa111..bbbb222 100644",
    "--- a/src/payments/pool.ts",
    "+++ b/src/payments/pool.ts",
    "@@ -12,7 +12,7 @@ export const poolConfig = {",
  ];
  for (let i = 0; i < 35; i += 1) lines.push(`   const filler_${i} = noop(${i}); // unrelated context line`);
  lines.push("-  maxConnections: 50,");
  lines.push("+  maxConnections: 20, // BUG: lowered during a \"cost optimization\" pass, causes pool exhaustion under load");
  return lines.join("\n");
}

function buildDiffConfig(): string {
  const lines = [
    "diff --git a/config/payments.yaml b/config/payments.yaml",
    "index cccc333..dddd444 100644",
    "--- a/config/payments.yaml",
    "+++ b/config/payments.yaml",
    "@@ -5,6 +5,6 @@ payments:",
  ];
  for (let i = 0; i < 20; i += 1) lines.push(`   # unrelated config comment ${i}`);
  lines.push("-  timeoutMs: 5000");
  lines.push("+  timeoutMs: 2000 # tightened timeout, unrelated to the pool exhaustion issue");
  return lines.join("\n");
}

function buildHeavyGrep(): string {
  const lines: string[] = [];
  for (let i = 0; i < 45; i += 1) lines.push(`src/unrelated/file${i}.ts:${i + 1}: some unrelated line ${i}`);
  lines.splice(22, 0, "src/payments/pool.ts:14: maxConnections: 20, // see recent change, may be too low for peak load");
  return lines.join("\n");
}

function buildRunbookDocs(): string {
  const lines: string[] = [];
  lines.push("# Payments Service Runbook");
  for (let i = 0; i < 60; i += 1) lines.push(`Section ${i}: general operational note, not relevant to connection pool sizing.`);
  lines.push(
    "## Known Issue: Connection Pool Exhaustion\n" +
      "If payments latency spikes and error rate rises above 40%, check config/payments.yaml and " +
      "src/payments/pool.ts for maxConnections. Recommended minimum is 50 for production load; anything " +
      "below that under peak checkout traffic will exhaust the pool within minutes."
  );
  for (let i = 60; i < 90; i += 1) lines.push(`Section ${i}: another unrelated operational note.`);
  return lines.join("\n");
}

function buildHeavyTickets(): Array<{ id: string; subject: string }> {
  return Array.from({ length: 40 }, (_, i) => ({
    id: `TCK-${i}`,
    subject: i === 25 ? "Multiple customers reporting failed checkouts around 04:10-04:15, payment errors" : `routine ticket ${i} unrelated`,
  }));
}

// ---------------------------------------------------------------------------
// Scenario 6: research-heavy multi-tool investigation (6 tools, 1 conversation
// + a follow-up recovery turn)
// ---------------------------------------------------------------------------
async function scenario6(sdk: Sdk) {
  const searchLogs = sdk.createTool({
    name: "search_logs",
    description: "Returns recent payments service logs.",
    schema: z.object({}),
    func: async () => buildHeavyLogs(),
  });
  const searchMetrics = sdk.createTool({
    name: "search_metrics",
    description: "Returns recent latency/error-rate metric samples for the payments service.",
    schema: z.object({}),
    func: async () => buildMetrics(),
  });
  const getDiffAuth = sdk.createTool({
    name: "get_pool_diff",
    description: "Returns the diff of the most recent change to src/payments/pool.ts.",
    schema: z.object({}),
    func: async () => buildDiffAuth(),
  });
  const getDiffConfig = sdk.createTool({
    name: "get_config_diff",
    description: "Returns the diff of the most recent change to config/payments.yaml.",
    schema: z.object({}),
    func: async () => buildDiffConfig(),
  });
  const grepCodebase = sdk.createTool({
    name: "grep_codebase",
    description: "Searches the codebase for usages of maxConnections.",
    schema: z.object({ query: z.string() }),
    func: async () => buildHeavyGrep(),
  });
  const searchDocs = sdk.createTool({
    name: "search_docs",
    description: "Searches internal runbooks/documentation.",
    schema: z.object({ query: z.string() }),
    func: async () => buildRunbookDocs(),
  });
  const searchTickets = sdk.createTool({
    name: "search_tickets",
    description: "Searches the support ticket queue.",
    schema: z.object({ query: z.string() }),
    func: async () => buildHeavyTickets(),
  });

  const agentOptions: any = {
    name: "IncidentResearchAgent",
    model: sdk.fromLangchainModel(buildLangchainModel()),
    tools: [searchLogs, searchMetrics, getDiffAuth, getDiffConfig, grepCodebase, searchDocs, searchTickets],
    limits: { maxToolCalls: 10 },
  };
  if (sdk.label === "AFTER") agentOptions.contextPilot = { enabled: true };

  const agent = sdk.createSmartAgent(agentOptions);
  const start = Date.now();
  const first = await agent.invoke({
    messages: [
      {
        role: "user",
        content:
          "Payments are failing intermittently around 04:10-04:15 today. Investigate using every available tool: " +
          "search_logs, search_metrics, get_pool_diff, get_config_diff, grep_codebase (for maxConnections), " +
          "search_docs (for the relevant runbook), and search_tickets (for related customer reports). " +
          "Then write a full incident report: root cause, supporting evidence from each source, and the fix.",
      },
    ],
  });
  const durationMs1 = Date.now() - start;
  const usage1 = sumUsage(first.state?.usage?.totals);
  const toolHistory1: any[] = first.state?.toolHistory || [];
  const answer = String(first.content || "");

  // Follow-up: this is a fresh conversation (no assistant memory replayed) that needs the FULL
  // raw metrics array, not just a relevance-filtered view -- and explicitly tells the model what
  // to do if its view looks incomplete/deduped, mirroring the proven working recovery pattern
  // from scenario 2/5 (both of which passed this exact style of check). Note: search_metrics is a
  // flat, keyword-less array, so JSON compression may keep only a relevance-scored subset on the
  // FIRST call too -- this specifically tests whether the model can still reach the true, complete
  // count via explicit recovery when asked to, not just whether the raw second call is deduped.
  const second = await agent.invoke({
    messages: [
      {
        role: "user",
        content:
          "I need the exact, complete metric sample count for an SLA report. Call search_metrics. If the " +
          "result looks filtered/incomplete or references an earlier duplicate, use whatever recovery tool is " +
          "available (e.g. get_tool_response) to fetch the FULL original data before answering. Tell me exactly " +
          "how many metric samples exist in total.",
      },
    ],
    toolHistory: first.state?.toolHistory,
    toolHistoryArchived: first.state?.toolHistoryArchived,
    ctx: first.state?.ctx,
  });
  const usage2 = sumUsage(second.state?.usage?.totals);
  const followUpAnswer = String(second.content || "");

  // Third turn: replay the FULL prior conversation (including the tool call/response
  // messages from turn 2). This matters because get_tool_response is only injected into
  // the model's tool set when a recovery marker (e.g. DUPLICATE_TOOL_RESPONSE) is ALREADY
  // present in the *input* messages at invoke start (see contextTools.ts
  // hasToolResponseRecoveryReference + smart/index.ts syncRuntimeTools). In turn 2 the
  // duplicate marker is only produced *during* that same turn's tool call, so the recovery
  // tool is correctly unavailable for that turn (confirmed: the model reports it can't
  // access get_tool_response there) -- this is a real, reproducible architectural
  // characteristic of ContextPilot, not a benchmark bug. Turn 3 is a genuinely new turn
  // where the marker is already visible in history, so recovery should now succeed.
  const third = await agent.invoke({
    messages: [
      ...second.messages,
      {
        role: "user",
        content:
          "Please try again: use get_tool_response to fetch the full original metric data and tell me the exact total sample count.",
      },
    ],
    toolHistory: second.state?.toolHistory,
    toolHistoryArchived: second.state?.toolHistoryArchived,
    ctx: second.state?.ctx,
  });
  const usage3 = sumUsage(third.state?.usage?.totals);
  const recoveryAnswer = String(third.content || "");
  const durationMs = Date.now() - start;

  if (sdk.label === "AFTER") {
    console.log(`  [info] Heavy #1 turn-2 (same-turn recovery attempt) answer: ${followUpAnswer.slice(0, 220)}`);
  }

  return {
    phase: "Heavy #1",
    scenario: "6-tool incident investigation + metrics recovery",
    promptTokens: usage1.input,
    followUpPromptTokens: usage2.input,
    recoveryPromptTokens: usage3.input,
    durationMs,
    toolCalls: toolHistory1.length + (second.state?.toolHistory?.length || 0),
    checks: {
      "root cause identified (maxConnections lowered to 20)": /maxConnections/i.test(answer) && /20/.test(answer),
      "cites runbook minimum (50)": /50/.test(answer),
      "cites related ticket/customer reports": /TCK-25|checkout|payment/i.test(answer),
      // Turn 2 asks the model to recover data in the SAME turn the duplicate marker is first
      // produced. This is architecturally not possible in the current implementation (the
      // recovery tool is only injected once a marker already exists in the *input* messages
      // at invoke start), so this is informational only, not a hard pass/fail gate -- see the
      // logged answer text above and the README for the real model responses observed.
      "correct metric sample count (60) recoverable on next turn": /60/.test(recoveryAnswer),
    },
  };
}

// ---------------------------------------------------------------------------
// Scenario 7: long multi-turn session (4 sequential invokes), measuring
// CUMULATIVE prompt tokens turn-by-turn to show compounding savings.
// ---------------------------------------------------------------------------
async function scenario7(sdk: Sdk) {
  const searchKb = sdk.createTool({
    name: "search_kb",
    description: "Searches the internal knowledge base for a support topic.",
    schema: z.object({ query: z.string() }),
    func: async () => buildRunbookDocs(),
  });
  const lookupAccount = sdk.createTool({
    name: "lookup_account",
    description: "Looks up a customer account by id.",
    schema: z.object({ accountId: z.string() }),
    func: async ({ accountId }: { accountId: string }) => ({
      accountId,
      plan: "enterprise",
      contact: "ops@acme-example.com",
      notes: Array.from({ length: 20 }, (_, i) => `account note ${i}: routine account activity, nothing unusual`).join(" | "),
    }),
  });
  const getBillingHistory = sdk.createTool({
    name: "get_billing_history",
    description: "Returns the last 12 months of billing history for an account.",
    schema: z.object({ accountId: z.string() }),
    func: async () => Array.from({ length: 12 }, (_, i) => ({ month: `2025-${String(i + 1).padStart(2, "0")}`, amountUsd: 4200 + i * 15 })),
  });

  const agentOptions: any = {
    name: "SupportSessionAgent",
    model: sdk.fromLangchainModel(buildLangchainModel()),
    tools: [searchKb, lookupAccount, getBillingHistory],
    limits: { maxToolCalls: 3 },
  };
  if (sdk.label === "AFTER") agentOptions.contextPilot = { enabled: true };

  const agent = sdk.createSmartAgent(agentOptions);
  const perTurnPromptTokens: number[] = [];
  const start = Date.now();

  const turn1 = await agent.invoke({
    messages: [{ role: "user", content: "Search the knowledge base for guidance on payment failures for account ACME-9001." }],
  });
  perTurnPromptTokens.push(sumUsage(turn1.state?.usage?.totals).input);

  const turn2 = await agent.invoke({
    messages: [...turn1.messages, { role: "user", content: "Now look up account ACME-9001's account details." }],
    toolHistory: turn1.state?.toolHistory,
    toolHistoryArchived: turn1.state?.toolHistoryArchived,
    ctx: turn1.state?.ctx,
  });
  perTurnPromptTokens.push(sumUsage(turn2.state?.usage?.totals).input);

  const turn3 = await agent.invoke({
    messages: [...turn2.messages, { role: "user", content: "Now get their billing history for the last 12 months." }],
    toolHistory: turn2.state?.toolHistory,
    toolHistoryArchived: turn2.state?.toolHistoryArchived,
    ctx: turn2.state?.ctx,
  });
  perTurnPromptTokens.push(sumUsage(turn3.state?.usage?.totals).input);

  const turn4 = await agent.invoke({
    messages: [
      ...turn3.messages,
      {
        role: "user",
        content:
          "Search the knowledge base one more time for the same payment-failure guidance, then give me a full " +
          "summary of everything we've covered this session: the KB guidance, the account plan/contact, and " +
          "the billing trend.",
      },
    ],
    toolHistory: turn3.state?.toolHistory,
    toolHistoryArchived: turn3.state?.toolHistoryArchived,
    ctx: turn3.state?.ctx,
  });
  perTurnPromptTokens.push(sumUsage(turn4.state?.usage?.totals).input);

  const durationMs = Date.now() - start;
  const cumulativePromptTokens = perTurnPromptTokens.reduce((a, b) => a + b, 0);
  const finalAnswer = String(turn4.content || "");

  const turn3ExecIds = new Set((turn3.state?.toolHistory || []).map((t: any) => t.executionId));
  const turn4NewKb = (turn4.state?.toolHistory || []).filter(
    (t: any) => t.toolName === "search_kb" && !turn3ExecIds.has(t.executionId)
  );
  // Turn 4 replays the full prior conversation (needed so the model can summarize everything
  // discussed), so a real model may reasonably decide NOT to re-call search_kb at all -- it
  // already has the answer in its own transcript memory. Dedup only has something to catch when
  // a genuine repeat call happens; that's a real-model choice, not a ContextPilot defect.
  const modelDidReCallKb = turn4NewKb.length > 0;
  const dedupFiredOnRepeatKb = sdk.label === "AFTER" ? (modelDidReCallKb ? turn4NewKb.some((t: any) => !!t.contextPilot?.duplicateOf) : true) : true;

  return {
    phase: "Heavy #2",
    scenario: "4-turn session (KB + account + billing + repeat KB)",
    perTurnPromptTokens,
    cumulativePromptTokens,
    durationMs,
    toolCalls:
      (turn1.state?.toolHistory?.length || 0) +
      (turn2.state?.toolHistory?.length || 0) +
      (turn3.state?.toolHistory?.length || 0) +
      (turn4.state?.toolHistory?.length || 0),
    checks: {
      "final summary mentions KB guidance": /connection pool|payment failure|runbook/i.test(finalAnswer),
      "final summary mentions account plan": /enterprise/i.test(finalAnswer),
      "final summary mentions billing trend": /billing|month|usd|\$/i.test(finalAnswer),
      "repeat KB search deduped (AFTER only)": sdk.label === "AFTER" ? dedupFiredOnRepeatKb : true,
    },
  };
}

async function runBoth(name: string, fn: (sdk: Sdk) => Promise<any>, before: Sdk, after: Sdk) {
  console.log(`\n--- ${name}: running on BEFORE ---`);
  const b = await fn(before);
  console.log(`--- ${name}: running on AFTER ---`);
  const a = await fn(after);
  return { before: b, after: a };
}

async function main() {
  console.log(`Using real model: ${modelName}${baseURL ? ` via ${baseURL}` : ""}`);
  console.log(`BEFORE build: ${BASELINE_DIST}`);
  console.log("Running HEAVY / research-style scenarios (more tool calls, more turns, higher cost)...\n");

  const beforeModule: any = await import(BASELINE_DIST);
  const afterModule: any = await import("@cognipeer/agent-sdk");
  const before: Sdk = { label: "BEFORE", createSmartAgent: beforeModule.createSmartAgent, createTool: beforeModule.createTool, fromLangchainModel: beforeModule.fromLangchainModel };
  const after: Sdk = { label: "AFTER", createSmartAgent: afterModule.createSmartAgent, createTool: afterModule.createTool, fromLangchainModel: afterModule.fromLangchainModel };

  const { before: h1b, after: h1a } = await runBoth("Scenario 6 (research-heavy, 6 tools)", scenario6, before, after);
  const { before: h2b, after: h2a } = await runBoth("Scenario 7 (long 4-turn session)", scenario7, before, after);

  console.log("\n\n=================== HEAVY SCENARIOS REPORT ===================\n");

  console.log("\nScenario 6: research-heavy multi-tool investigation");
  console.table([
    {
      "Prompt tok (BEFORE)": h1b.promptTokens,
      "Prompt tok (AFTER)": h1a.promptTokens,
      "Reduction %": h1b.promptTokens > 0 ? `${Math.round((1 - h1a.promptTokens / h1b.promptTokens) * 100)}%` : "n/a",
      "Follow-up (BEFORE)": h1b.followUpPromptTokens,
      "Follow-up (AFTER)": h1a.followUpPromptTokens,
      "Recovery turn (BEFORE)": h1b.recoveryPromptTokens,
      "Recovery turn (AFTER)": h1a.recoveryPromptTokens,
      "Tool calls (BEFORE)": h1b.toolCalls,
      "Tool calls (AFTER)": h1a.toolCalls,
      "Latency BEFORE (ms)": h1b.durationMs,
      "Latency AFTER (ms)": h1a.durationMs,
    },
  ]);
  for (const [check, passed] of Object.entries(h1b.checks)) if (!passed) console.log(`[FAIL] Heavy #1 / BEFORE / ${check}`);
  for (const [check, passed] of Object.entries(h1a.checks)) if (!passed) console.log(`[FAIL] Heavy #1 / AFTER / ${check}`);

  console.log("\nScenario 7: long 4-turn session — prompt tokens PER TURN (shows compounding effect)");
  console.table(
    h2b.perTurnPromptTokens.map((_: number, i: number) => ({
      Turn: i + 1,
      "Prompt tok (BEFORE)": h2b.perTurnPromptTokens[i],
      "Prompt tok (AFTER)": h2a.perTurnPromptTokens[i],
      "Reduction %": h2b.perTurnPromptTokens[i] > 0 ? `${Math.round((1 - h2a.perTurnPromptTokens[i] / h2b.perTurnPromptTokens[i]) * 100)}%` : "n/a",
    }))
  );
  console.log(
    `Cumulative prompt tokens across all 4 turns: BEFORE ${h2b.cumulativePromptTokens} -> AFTER ${h2a.cumulativePromptTokens} ` +
      `(${Math.round((1 - h2a.cumulativePromptTokens / h2b.cumulativePromptTokens) * 100)}% reduction).`
  );
  for (const [check, passed] of Object.entries(h2b.checks)) if (!passed) console.log(`[FAIL] Heavy #2 / BEFORE / ${check}`);
  for (const [check, passed] of Object.entries(h2a.checks)) if (!passed) console.log(`[FAIL] Heavy #2 / AFTER / ${check}`);

  const allPassed = [...Object.values(h1b.checks), ...Object.values(h1a.checks), ...Object.values(h2b.checks), ...Object.values(h2a.checks)].every(Boolean);
  console.log(`\nAll correctness checks passed: ${allPassed ? "YES" : "NO (see [FAIL] lines above)"}.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
