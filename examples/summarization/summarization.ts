import { z } from "zod";
import { createSmartAgent, createTool, fromLangchainModel } from "@cognipeer/agent-sdk";
import { ChatOpenAI } from "@langchain/openai";

const echo = createTool({
  name: "echo",
  description: "Echo back",
  schema: z.object({ text: z.string().optional() }),
  func: async ({ text }: any) => ({ echoed: text ?? "" }),
});

const apiKey = process.env.OPENAI_API_KEY || "";
const fallbackModel = {
  bindTools() { return this; },
  async invoke(_messages: any[]) {
    return { role: "assistant", content: "(fake) summarized conversation" } as any;
  },
};
const model = apiKey
  ? fromLangchainModel(new ChatOpenAI({ model: "gpt-4o-mini", apiKey }))
  : (fallbackModel as any);

const agent = createSmartAgent({
  model,
  tools: [echo],
  limits: { maxToolCalls: 5 },
  summarization: { enable: true, maxTokens: 500 },
  // summarization: false, // Uncomment to disable summarization entirely
});

const res = await agent.invoke({ messages: [{ role: 'user', content: "Start a very long session to trigger summarization." }] });
console.log(res.content);
