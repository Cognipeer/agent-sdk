/**
 * ContextPilot A/B comparison.
 *
 * Runs the EXACT same conversation twice against createSmartAgent:
 *   1) contextPilot: { enabled: false }  -> baseline (pre-ContextPilot) behavior
 *   2) contextPilot: { enabled: true }   -> current feature/context-pilot behavior
 *
 * Both runs use a deterministic fake model (no API key / network needed), so
 * the comparison is 100% reproducible. The scenario:
 *   - The model searches a 40-item product catalog for "target-widget-42".
 *   - The model issues the *exact same* search again (simulating a model that
 *     re-checks its work) to show cross-turn dedup.
 *   - In the ContextPilot run only, a follow-up turn recovers the full
 *     original (uncompressed) data via the real get_tool_response tool to
 *     prove no data is actually lost.
 *
 * Run: npm run example:context-pilot-comparison (from examples/)
 */
import { createSmartAgent, createTool } from "@cognipeer/agent-sdk";
import { z } from "zod";

function buildCatalog(): Array<{ id: number; title: string; description: string }> {
  return Array.from({ length: 40 }, (_, i) => ({
    id: i,
    title: i === 7 ? "target-widget-42 premium pricing kit" : `filler-product-${i} generic accessory`,
    description:
      i === 7
        ? "The target-widget-42 premium pricing kit includes volume discounts, enterprise tiers, and a full pricing sheet."
        : `A generic accessory item ${i} with no relation to widget pricing, used only to pad out the catalog response so it is large enough to trigger compression heuristics in the benchmark.`,
  }));
}

function extractCcrHash(content: unknown): string | undefined {
  const text = typeof content === "string" ? content : JSON.stringify(content ?? "");
  // CCR hashes are 16-char sha1-derived hex strings (see ccrStore.ts hashOf).
  // Require a full-length hex run so we don't accidentally match a stray
  // hex-looking prefix of an unrelated id (e.g. "call_1" -> "ca").
  const match = /executionId=\\?"([a-f0-9]{16})/.exec(text);
  return match?.[1];
}

type Phase = "search_1" | "search_2" | "final" | "recover" | "final_after_recover";

function createFakeModel() {
  let phase: Phase = "search_1";
  return {
    modelName: "deterministic-comparison-model",
    bindTools() {
      return this;
    },
    async invoke(messages: any[]): Promise<any> {
      if (phase === "search_1") {
        phase = "search_2";
        return toolCall("call_1", "search_items", { query: "target-widget-42 pricing" });
      }
      if (phase === "search_2") {
        phase = "final";
        // Deliberately identical query -> identical tool output -> dedup candidate.
        return toolCall("call_2", "search_items", { query: "target-widget-42 pricing" });
      }
      if (phase === "final") {
        phase = "recover";
        return { role: "assistant", content: "Found target-widget-42 premium pricing kit." };
      }
      if (phase === "recover") {
        // Look for the compression marker (16-hex ccrHash) among ALL
        // search_items tool messages -- the *second* call was deduped and
        // only points at the first call's executionId (not a ccrHash), so we
        // must scan every candidate rather than just the most recent one.
        const searchMessages = messages.filter((m: any) => m.role === "tool" && m.name === "search_items");
        let ccrHash: string | undefined;
        for (const m of searchMessages) {
          ccrHash = extractCcrHash(m?.content);
          if (ccrHash) break;
        }
        phase = "final_after_recover";
        if (!ccrHash) return { role: "assistant", content: "Nothing to recover." };
        return toolCall("call_recover", "get_tool_response", { executionId: ccrHash });
      }
      return { role: "assistant", content: "Recovered the full original list." };
    },
  };

  function toolCall(id: string, name: string, args: Record<string, unknown>) {
    return {
      role: "assistant",
      content: "",
      tool_calls: [{ id, type: "function", name, args, function: { name, arguments: JSON.stringify(args) } }],
    };
  }
}

async function runScenario(contextPilotEnabled: boolean) {
  const searchItems = createTool({
    name: "search_items",
    description: "Search a large product catalog.",
    schema: z.object({ query: z.string() }),
    func: async () => buildCatalog(),
  });

  const agent = createSmartAgent({
    name: "ComparisonAgent",
    model: createFakeModel(),
    tools: [searchItems],
    limits: { maxToolCalls: 6 },
    contextPilot: { enabled: contextPilotEnabled },
  });

  const first = await agent.invoke({
    messages: [{ role: "user", content: "Find target-widget-42 in the catalog, double-check, then tell me the price." }],
  });

  const toolHistory: any[] = first.state?.toolHistory || [];
  const searchEntries = toolHistory.filter((t) => t.toolName === "search_items");

  let recoveredFullData = false;
  if (contextPilotEnabled) {
    const second = await agent.invoke({
      messages: [...first.messages, { role: "user", content: "Actually give me the full unfiltered list too." }],
      toolHistory: first.state?.toolHistory,
      toolHistoryArchived: first.state?.toolHistoryArchived,
      ctx: first.state?.ctx,
    } as any);
    const recoveryEntry = (second.state?.toolHistory || []).find((t: any) => t.toolName === "get_tool_response");
    recoveredFullData = Array.isArray(recoveryEntry?.output) && recoveryEntry.output.length === 40;
  }

  const rawCharsTotal = searchEntries.reduce((sum, e) => sum + JSON.stringify(e.rawOutput ?? e.output).length, 0);
  const sentCharsTotal = searchEntries.reduce((sum, e) => sum + JSON.stringify(e.output).length, 0);
  const dedupedCalls = searchEntries.filter((e) => e.contextPilot?.duplicateOf).length;

  return {
    label: contextPilotEnabled ? "WITH ContextPilot" : "WITHOUT ContextPilot (baseline)",
    calls: searchEntries.length,
    rawCharsTotal,
    sentCharsTotal,
    dedupedCalls,
    recoveredFullData,
  };
}

async function main() {
  const withoutCp = await runScenario(false);
  const withCp = await runScenario(true);

  const approxTokens = (chars: number) => Math.round(chars / 4);
  const reduction = (a: number, b: number) => `${Math.round((1 - b / a) * 100)}%`;

  console.log("\nContextPilot A/B comparison — same conversation, same fake model, same 40-item catalog\n");
  console.table([
    {
      Scenario: withoutCp.label,
      "search_items calls": withoutCp.calls,
      "Deduped calls": withoutCp.dedupedCalls,
      "Chars sent to model": withoutCp.sentCharsTotal,
      "Approx tokens sent": approxTokens(withoutCp.sentCharsTotal),
    },
    {
      Scenario: withCp.label,
      "search_items calls": withCp.calls,
      "Deduped calls": withCp.dedupedCalls,
      "Chars sent to model": withCp.sentCharsTotal,
      "Approx tokens sent": approxTokens(withCp.sentCharsTotal),
    },
  ]);

  console.log(
    `Token reduction: ${reduction(withoutCp.sentCharsTotal, withCp.sentCharsTotal)} fewer chars sent to the model ` +
      `(${withoutCp.sentCharsTotal} -> ${withCp.sentCharsTotal} chars) across the identical 2-call scenario.`
  );
  console.log(
    `Cross-turn dedup: baseline sent the duplicate search result in full again (${withoutCp.dedupedCalls} deduped), ` +
      `ContextPilot replaced it with a pointer (${withCp.dedupedCalls} deduped).`
  );
  console.log(
    `Data safety: despite compressing/deduping, the full original 40-item catalog was ` +
      `${withCp.recoveredFullData ? "SUCCESSFULLY" : "NOT"} recovered via get_tool_response in a follow-up turn.`
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
