/**
 * ContextPilot A/B comparison — REAL model, REAL API calls.
 *
 * Unlike context-pilot-comparison.ts (deterministic fake model), this script
 * loads real credentials from the repo root .env (OPENAI_API_KEY,
 * OPENAI_BASE_URL, OPENAI_MODEL) and drives an actual LLM through
 * `createSmartAgent`. The model genuinely decides when to call the tool and
 * what to say — nothing about its behavior is scripted.
 *
 * Scenario: a production incident investigation. A `search_server_logs` tool
 * returns a realistic ~180-line server log (deterministic content, so both
 * runs see the exact same raw data) containing one true root cause buried
 * among filler INFO/DEBUG noise. The model is asked to find the root cause
 * and its exact timestamp.
 *
 * The SAME prompt + SAME tool are run twice against two real agents:
 *   1) contextPilot: { enabled: false } -> baseline
 *   2) contextPilot: { enabled: true }  -> current feature/context-pilot
 *
 * For each run we report REAL numbers straight from the OpenAI-compatible
 * usage payload: prompt/completion/total tokens, wall-clock latency, how
 * many characters of the log were actually sent to the model, and whether
 * the model's final answer correctly names the root cause + timestamp.
 *
 * Run: npm run example:context-pilot-real-comparison (from examples/)
 * Requires: a valid .env at the repo root (see .env.example).
 */
import { existsSync, readFileSync } from "node:fs";
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
  console.error(
    `No OPENAI_API_KEY found (looked for .env at ${envPath}). ` +
      "This script requires real credentials — copy .env.example to .env at the repo root and fill it in."
  );
  process.exit(1);
}

const ROOT_CAUSE_TIMESTAMP = "03:14:07";
const ROOT_CAUSE_LINE =
  `ERROR ${ROOT_CAUSE_TIMESTAMP} [checkout-service] Connection pool exhausted contacting payment-gateway ` +
  "(db-pool-payments, max=20, waiting=47) — checkout requests failing with 504 Gateway Timeout since 03:14:07";

function buildServerLog(): string {
  const lines: string[] = [];
  const services = ["checkout-service", "inventory-service", "auth-service", "cart-service", "shipping-service"];
  for (let h = 0; h < 4; h += 1) {
    for (let m = 0; m < 40; m += 1) {
      const svc = services[(h * 40 + m) % services.length];
      const ts = `0${h}:${String(m % 60).padStart(2, "0")}:${String((m * 7) % 60).padStart(2, "0")}`;
      lines.push(`INFO ${ts} [${svc}] request handled in ${20 + (m % 30)}ms, status=200`);
      if (m % 11 === 0) lines.push(`DEBUG ${ts} [${svc}] cache hit ratio=${(0.8 + (m % 5) / 50).toFixed(2)}`);
    }
  }
  // Bury the true root cause roughly in the middle of the log.
  lines.splice(Math.floor(lines.length / 2), 0, ROOT_CAUSE_LINE);
  return lines.join("\n");
}

function buildModel() {
  return fromLangchainModel(
    new ChatOpenAI({
      model: modelName,
      apiKey,
      temperature: 0,
      ...(baseURL ? { configuration: { baseURL } } : {}),
    })
  );
}

async function runScenario(contextPilotEnabled: boolean) {
  const rawLog = buildServerLog();
  const searchServerLogs = createTool({
    name: "search_server_logs",
    description: "Returns the full raw server log for the last 4 hours across all services.",
    schema: z.object({ hours: z.number().optional().describe("How many hours back to search, default 4") }),
    func: async () => rawLog,
  });

  const agent = createSmartAgent({
    name: "IncidentInvestigator",
    model: buildModel(),
    tools: [searchServerLogs],
    limits: { maxToolCalls: 3 },
    contextPilot: { enabled: contextPilotEnabled },
  });

  const start = Date.now();
  const result = await agent.invoke({
    messages: [
      {
        role: "user",
        content:
          "Production checkout service is failing intermittently. Search the server logs and tell me " +
          "the exact root cause and its timestamp (HH:MM:SS).",
      },
    ],
  });
  const durationMs = Date.now() - start;

  const toolHistory: any[] = result.state?.toolHistory || [];
  const logEntry = toolHistory.find((t) => t.toolName === "search_server_logs");
  const rawChars = logEntry ? JSON.stringify(logEntry.rawOutput ?? logEntry.output).length : 0;
  const sentChars = logEntry ? JSON.stringify(logEntry.output).length : 0;

  const usageTotals = result.state?.usage?.totals || {};
  const usage = Object.values(usageTotals).reduce(
    (acc: any, u: any) => ({
      input: acc.input + (u?.input || 0),
      output: acc.output + (u?.output || 0),
      total: acc.total + (u?.total || 0),
    }),
    { input: 0, output: 0, total: 0 }
  );

  const finalText = String(result.content || "");
  const foundRootCause = finalText.includes(ROOT_CAUSE_TIMESTAMP) && /payment-?gateway/i.test(finalText);

  return {
    label: contextPilotEnabled ? "WITH ContextPilot" : "WITHOUT ContextPilot (baseline)",
    durationMs,
    toolCalls: toolHistory.length,
    rawChars,
    sentChars,
    promptTokens: usage.input,
    completionTokens: usage.output,
    totalTokens: usage.total,
    foundRootCause,
    finalText,
  };
}

async function main() {
  console.log(`Using real model: ${modelName}${baseURL ? ` via ${baseURL}` : ""}\n`);

  console.log("Running WITHOUT ContextPilot...");
  const withoutCp = await runScenario(false);
  console.log("Running WITH ContextPilot...");
  const withCp = await runScenario(true);

  console.log("\nContextPilot A/B comparison — REAL model, REAL API calls, identical prompt + tool\n");
  console.table([
    {
      Scenario: withoutCp.label,
      "Log chars sent": withoutCp.sentChars,
      "Prompt tokens": withoutCp.promptTokens,
      "Completion tokens": withoutCp.completionTokens,
      "Total tokens": withoutCp.totalTokens,
      "Latency (ms)": withoutCp.durationMs,
      "Found root cause": withoutCp.foundRootCause ? "yes" : "no",
    },
    {
      Scenario: withCp.label,
      "Log chars sent": withCp.sentChars,
      "Prompt tokens": withCp.promptTokens,
      "Completion tokens": withCp.completionTokens,
      "Total tokens": withCp.totalTokens,
      "Latency (ms)": withCp.durationMs,
      "Found root cause": withCp.foundRootCause ? "yes" : "no",
    },
  ]);

  const tokenDelta = withoutCp.promptTokens - withCp.promptTokens;
  const pct = withoutCp.promptTokens > 0 ? Math.round((tokenDelta / withoutCp.promptTokens) * 100) : 0;

  console.log(`Prompt-token delta: ${tokenDelta >= 0 ? "-" : "+"}${Math.abs(tokenDelta)} tokens (${pct}% ${tokenDelta >= 0 ? "reduction" : "increase"}).`);
  console.log(`Raw log size: ${withoutCp.rawChars} chars. Sent to model — baseline: ${withoutCp.sentChars} chars, ContextPilot: ${withCp.sentChars} chars.`);
  console.log(`Correctness: both runs ${withoutCp.foundRootCause && withCp.foundRootCause ? "correctly identified" : "did NOT both correctly identify"} the real root cause (payment-gateway pool exhaustion at ${ROOT_CAUSE_TIMESTAMP}).`);
  console.log(`\nFinal answer (baseline): ${withoutCp.finalText}`);
  console.log(`\nFinal answer (ContextPilot): ${withCp.finalText}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
