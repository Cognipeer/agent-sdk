/**
 * Sub-agents: dynamic problem decomposition.
 *
 * Demonstrates the three built-in tools created when you pass `subagents` /
 * `subagentPolicy` to createSmartAgent:
 *   - delegate_to(subagent, input)          → a predefined registry sub-agent
 *   - spawn_subagent({ role, prompt, ... })  → an ad-hoc specialist
 *   - spawn_subagents_parallel({ tasks })    → concurrent fan-out
 *
 * Runs out-of-the-box against a scripted fake model (no API key needed). Set
 * OPENAI_API_KEY to drive it with a real model instead.
 */
import { createSmartAgent, createTool, type SubagentDef, type SmartAgentEvent } from "@cognipeer/agent-sdk";
import { z } from "zod";

// A tool the sub-agents can borrow from the parent (by name).
const search = createTool({
  name: "search",
  description: "Search a knowledge base",
  schema: z.object({ q: z.string() }),
  func: async ({ q }) => ({ q, hits: [`result for ${q}`] }),
});

// Leaf model: a sub-agent that just answers from its system prompt.
function leafModel(answer: string) {
  return {
    modelName: "leaf",
    bindTools() { return this; },
    async invoke() { return { role: "assistant", content: answer }; },
  } as any;
}

// Registry: predefined, named sub-agents.
const researcher: SubagentDef = {
  name: "researcher",
  header: "gathers facts for a question",
  systemPrompt: "You are a focused researcher. Answer concisely.",
  model: leafModel("Berlin is the capital of Germany."),
  tools: ["search"], // borrow the parent's search tool by name
};

const writer: SubagentDef = {
  name: "writer",
  header: "turns notes into prose",
  systemPrompt: "You are a writer. Produce a one-sentence summary.",
  model: leafModel("Summary: the capital of Germany is Berlin."),
};

// Parent (orchestrator) model. With a real model this is your LLM; here it is
// scripted but STATELESS — it decides purely from the messages, so the ad-hoc
// children (which inherit this same model) behave deterministically by reading
// their own role prompt. A real LLM is stateless in exactly this way.
function orchestratorModel() {
  return {
    modelName: "orchestrator",
    bindTools() { return this; },
    async invoke(msgs: any[]) {
      const sysText = String(msgs.find((m) => m.role === "system")?.content ?? "");
      // Ad-hoc children carry their role `prompt` as the system message.
      if (sysText.includes("Verify the claim")) return { role: "assistant", content: "Verified: correct." };
      if (sysText.includes("Translate to German")) return { role: "assistant", content: "Berlin ist die Hauptstadt Deutschlands." };

      // Orchestrator path: drive the sequence by how many results we've collected.
      const step = msgs.filter((m) => m.role === "tool").length;
      const call = (id: string, name: string, args: any) => ({ role: "assistant", content: "", tool_calls: [{ id, type: "function", function: { name, arguments: JSON.stringify(args) } }] });
      if (step === 0) return call("c1", "delegate_to", { subagent: "researcher", input: "What is the capital of Germany?" });
      if (step === 1) return call("c2", "spawn_subagent", { role: "fact-checker", prompt: "Verify the claim in one line.", input: "Verify: Berlin is the capital of Germany." });
      if (step === 2) return call("c3", "spawn_subagents_parallel", { tasks: [
        { subagent: "writer", input: "Summarize the finding." },
        { role: "translator", prompt: "Translate to German in one line.", input: "Translate: Berlin is the capital." },
      ] });
      return { role: "assistant", content: "Done — researched, verified, summarized and translated via sub-agents." };
    },
  } as any;
}

const apiKey = process.env.OPENAI_API_KEY;
const model = orchestratorModel(); // swap for a real model when OPENAI_API_KEY is set

const agent = createSmartAgent({
  name: "orchestrator",
  model,
  tools: [search],
  subagents: [researcher, writer],
  // Hybrid is the default; shown here for clarity. Tune the caps as needed.
  subagentPolicy: {
    mode: "registry_and_adhoc",
    maxDepth: 2,
    maxChildCalls: 8,
    maxParallel: 4,
    childContextPolicy: "scoped",
    allowAdhocTools: true,
  },
  summarization: false,
});

const res = await agent.invoke(
  { messages: [{ role: "user", content: "Research the capital of Germany, verify it, then summarize and translate." }] },
  {
    onEvent: (e: SmartAgentEvent) => {
      if (e.type === "subagent") {
        console.log(`[subagent:${e.phase}] ${e.name}${e.content ? " → " + e.content : ""}`);
      }
    },
  },
);

console.log("\nFinal:", res.content);
console.log("(set OPENAI_API_KEY and replace orchestratorModel() to run against a real model)", Boolean(apiKey));
