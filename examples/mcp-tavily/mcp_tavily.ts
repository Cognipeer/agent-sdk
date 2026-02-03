import { createSmartAgent, fromLangchainModel, fromLangchainTools } from "@cognipeer/agent-sdk";
import { ChatOpenAI } from "@langchain/openai";
import { MultiServerMCPClient } from "@langchain/mcp-adapters";

const TAVILY_API_KEY = process.env.TAVILY_API_KEY || "";
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";

const hasOpenAI = !!OPENAI_API_KEY;
const hasTavily = !!TAVILY_API_KEY;
if (!hasOpenAI) console.warn("OPENAI_API_KEY not set; will skip agent run.");
if (!hasTavily) console.warn("TAVILY_API_KEY not set; Tavily MCP won't authenticate.");

const client = new MultiServerMCPClient({
  throwOnLoadError: true,
  prefixToolNameWithServerName: true,
  useStandardContentBlocks: true,
  mcpServers: {
    "tavily-remote-mcp": {
      transport: "stdio",
      command: "npx",
      args: ["-y", "mcp-remote", `https://mcp.tavily.com/mcp/?tavilyApiKey=${TAVILY_API_KEY}`],
      env: {},
    },
  },
});

const tools = fromLangchainTools(await client.getTools());
console.log("Discovered MCP tools:", tools.map((t: any) => t.name));

const model = fromLangchainModel(new ChatOpenAI({ model: "gpt-4o-mini", temperature: 0, apiKey: OPENAI_API_KEY }));

const agent = createSmartAgent({
  model,
  tools,
  useTodoList: true,
  limits: { maxToolCalls: 10 },
  summarization: { enable: true, maxTokens: 6000 },
  tracing: { enabled: true },
});

try {
  if (!hasOpenAI || !hasTavily) {
    console.log("Skipping agent run because required API keys are missing.");
  } else {
    const res = await agent.invoke({
  messages: [{ role: 'user', content: "Use Tavily to find the latest LangChain MCP news and summarize in 3 bullets." }],
    });
    console.log("Final content:\n", res.content);
  }
} catch (err: any) {
  console.error("Error during MCP example:", err?.message || err);
} finally {
  await client.close();
}
