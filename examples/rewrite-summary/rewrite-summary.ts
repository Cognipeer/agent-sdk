import { createSmartAgent, createTool } from "@cognipeer/agent-sdk";
import { z } from "zod";

let turn = 0;
const fakeModel = {
  bindTools() { return this; },
  async invoke(messages: any[]) {
    turn++;
    if (turn === 1) {
  return { role: 'assistant', content: "", tool_calls: [{ id: "call_1", type: 'function', function: { name: "heavy_echo", arguments: JSON.stringify({ text: "hello" }) } }] };
    }
  return { role: 'assistant', content: "final after summarization" };
  },
};

const heavyEcho = createTool({
  name: "heavy_echo",
  description: "Echo back a very long string",
  schema: z.object({ text: z.string() }),
  func: async ({ text }) => ({ echoed: text + "-" + "X".repeat(4000) }),
});

const agent = createSmartAgent({
  model: fakeModel as any,
  tools: [heavyEcho],
  limits: { maxToolCalls: 5, maxToken: 200 },
});

let state: any = { messages: [{ role: 'user', content: "please run heavy_echo" }] };
let res = await agent.invoke(state);
state = { ...state, messages: res.messages };
state.messages.push({ role: 'user', content: "go on" });
res = await agent.invoke(state);
console.log("Final result:", res.content);
