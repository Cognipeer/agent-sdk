import { ChatOpenAI } from "@langchain/openai";
import { fromLangchainModel } from "@cognipeer/agent-sdk";
import { z } from "zod";
import { createAgent } from "@cognipeer/agent-sdk";

async function main() {
  // Base model (replace with env OPENAI_API_KEY configured)
  const model = fromLangchainModel(new ChatOpenAI({ model: "gpt-4o-mini" }));

  const financeAgent = createAgent({
    name: "Finance",
    model,
    tools: [],
    systemPrompt: "You are an expert financial analyst."
  });

  const codingAgent = createAgent({
    name: "Coder",
    model,
    tools: [],
    systemPrompt: "Produce concise and clean code."
  });

  // Root agent can hand off to codingAgent when code implementation is required.
  const rootAgent = createAgent({
    name: "Root",
    model,
    tools: [],
    handoffs: [ codingAgent.asHandoff({
      toolName: "handoff_to_coder",
      description: "Transfer the conversation to the Coder agent, which will write the code and answer the user. Call only when the user needs code written; Root stops responding after this call.",
    }) ]
  });

  const events: any[] = [];
  const res = await rootAgent.invoke({ messages: [ { role: 'user', content: "Calculate a ROI and then write a small TypeScript function for it." } ] }, {
    onEvent: (e) => { events.push(e); }
  });

  console.log("Final content:\n", res.content);
  console.log("Handoff events: ", events.filter(e => e.type === 'handoff'));
}

main().catch(e => console.error(e));
