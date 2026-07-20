import { createAgent, createTool, fromLangchainModel } from "@cognipeer/agent-sdk";
import { ChatOpenAI } from "@langchain/openai"; // optional
import { z } from "zod";

const echo = createTool({
  name: "echo",
  description: "Echo back",
  schema: z.object({ text: z.string().min(1) }),
  func: async ({ text }) => ({ echoed: text }),
});

let turn = 0;
const fakeModel = {
  bindTools() { return this; },
  async invoke(messages: any[]) {
    turn++;
    if (turn === 1) {
      return {
        role: 'assistant',
        content: "",
        tool_calls: [{ id: "call_1", type: 'function', function: { name: "echo", arguments: JSON.stringify({ text: "hi" }) } }],
      };
    }
    return { role: 'assistant', content: "done" };
  },
};

const apiKey = process.env.OPENAI_API_KEY || "";
const baseURL = process.env.OPENAI_BASE_URL;
const modelName = process.env.OPENAI_MODEL || "gpt-4o-mini";
const model = apiKey
  ? fromLangchainModel(new ChatOpenAI({
      model: modelName,
      apiKey,
      ...(baseURL ? { configuration: { baseURL } } : {}),
    }))
  : (fakeModel as any);

const agent = createAgent({
  model,
  tools: [echo],
  limits: { maxToolCalls: 3 },
});

const res = await agent.invoke({ messages: [{ role: 'user', content: "say hi via echo" }] });
console.log("Content:", res.content);
console.log("Usage:", JSON.stringify(res.metadata));
