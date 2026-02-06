import { createAgent, createTool, fromLangchainModel } from "@cognipeer/agent-sdk";
import { z } from "zod";

async function main() {
  const accessKeyId = process.env.AWS_ACCESS_KEY_ID || "";
  const secretAccessKey = process.env.AWS_SECRET_ACCESS_KEY || "";
  const region = process.env.AWS_REGION || "eu-central-1";
  const modelId = process.env.BEDROCK_MODEL_ID || "eu.anthropic.claude-sonnet-4-5-20250929-v1:0";

  if (!accessKeyId || !secretAccessKey) {
    throw new Error(
      "Missing AWS credentials. Set AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY in your terminal."
    );
  }

  let BedrockChat: any;
  try {
    ({ BedrockChat } = await import("@langchain/community/chat_models/bedrock"));
  } catch (err) {
    console.error("Failed to load @langchain/community/chat_models/bedrock:", err);
    throw new Error(
      "Missing dependency: @langchain/community. Install it in examples before running this file."
    );
  }

  const bedrockModel = new BedrockChat({
    model: modelId,
    region,
    credentials: { accessKeyId, secretAccessKey },
  });

  const model = fromLangchainModel(bedrockModel);

  const echoTool = createTool({
    name: "echo",
    description: "Echo back the given text",
    schema: z.object({ text: z.string().min(1) }),
    func: async ({ text }) => ({ echoed: text }),
  });

  const agent = createAgent({
    name: "BedrockAgent",
    model,
    tools: [echoTool],
    limits: { maxToolCalls: 3 },
  });

  const result = await agent.invoke(
    {
      messages: [
        {
          role: "user",
          content:
            "Use the echo tool once and return the echoed message: hello from bedrock.",
        },
      ],
    },
    {
      onEvent: (e: any) => {
        if (e?.type === "tool_call") {
          console.log("Tool event:", e.type, e?.tool?.name ?? e?.toolName ?? "unknown");
        }
      },
    }
  );

  console.log("Final content:", result.content);
  console.log("Messages:", result.messages);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
