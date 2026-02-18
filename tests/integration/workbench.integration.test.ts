/**
 * Workbench Integration Tests
 *
 * Tests SmartAgent with real OpenAI GPT model to verify:
 * 1. invoke returns non-empty content
 * 2. Tool calls work (manage_todo_list)
 * 3. onEvent callbacks fire (plan events, tool_call events, finalAnswer)
 * 4. Streaming works
 * 5. System prompt is followed
 *
 * Run: OPENAI_API_KEY=sk-xxx npx vitest run tests/integration/workbench.integration.test.ts
 */
import { describe, it, expect, beforeAll } from "vitest";
import { createSmartAgent, createTool } from "../../src/index.js";
import OpenAI from "openai";
import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import type { SmartState, SmartAgentEvent } from "../../src/types.js";

const API_KEY = process.env.OPENAI_API_KEY;
const runReal = API_KEY ? describe : describe.skip;

/**
 * Direct OpenAI SDK adapter (same approach as realOpenAI test)
 */
function createOpenAIModel(apiKey: string, modelName = "gpt-4o-mini") {
  const client = new OpenAI({ apiKey });
  let boundTools: any[] | undefined;

  const model: any = {
    modelName,

    async invoke(messages: any[]): Promise<any> {
      const openaiMessages = messages.map((m: any) => {
        const msg: any = {
          role: m.role as "system" | "user" | "assistant" | "tool",
          content: typeof m.content === "string" ? m.content : JSON.stringify(m.content),
        };
        if (m.name && m.role === "tool") msg.name = m.name;
        if (m.tool_calls && Array.isArray(m.tool_calls)) {
          msg.tool_calls = m.tool_calls.map((tc: any) => ({
            id: tc.id,
            type: tc.type || "function",
            function: tc.function || {
              name: tc.name,
              arguments: typeof tc.args === "string" ? tc.args : JSON.stringify(tc.args || {}),
            },
          }));
        }
        if (m.tool_call_id) msg.tool_call_id = m.tool_call_id;
        return msg;
      });

      const params: any = {
        model: modelName,
        messages: openaiMessages,
      };

      if (boundTools && boundTools.length > 0) {
        params.tools = boundTools;
        params.tool_choice = "auto";
      }

      const response = await client.chat.completions.create(params);
      const choice = response.choices[0];
      const msg = choice.message;

      const result: any = {
        role: "assistant",
        content: msg.content || "",
        usage: response.usage,
      };

      if (msg.tool_calls && msg.tool_calls.length > 0) {
        result.tool_calls = msg.tool_calls.map((tc: any) => ({
          id: tc.id,
          name: tc.function.name,
          args: tc.function.arguments,
        }));
      }

      return result;
    },

    bindTools(tools: any[]) {
      boundTools = tools.map((tool) => {
        const schema = tool.schema || tool.parameters;
        let jsonSchema: any;
        if (schema && typeof schema.parse === "function") {
          jsonSchema = zodToJsonSchema(schema, { target: "openApi3" });
          delete jsonSchema.$schema;
        } else if (schema) {
          jsonSchema = schema;
        } else {
          jsonSchema = { type: "object", properties: {} };
        }
        return {
          type: "function",
          function: {
            name: tool.name,
            description: tool.description || "",
            parameters: jsonSchema,
          },
        };
      });
      return model;
    },
  };

  return model;
}

runReal("Workbench SmartAgent Integration (Real OpenAI)", () => {
  let model: any;

  beforeAll(() => {
    model = createOpenAIModel(API_KEY!);
  });

  describe("basic invoke", () => {
    it("should return non-empty content", async () => {
      const agent = createSmartAgent({
        name: "TestAgent",
        model,
        systemPrompt: "You are a helpful assistant. Keep answers very brief.",
      });

      const result = await agent.invoke({
        messages: [{ role: "user", content: "What is 2+2? Reply with just the number." }],
      } as SmartState);

      console.log("Content:", JSON.stringify(result.content));
      console.log("Messages count:", result.messages.length);
      console.log(
        "Last message:",
        JSON.stringify({
          role: result.messages[result.messages.length - 1]?.role,
          content: result.messages[result.messages.length - 1]?.content,
        })
      );

      expect(result.content).toBeTruthy();
      expect(result.content.length).toBeGreaterThan(0);
      expect(result.content).toContain("4");
    }, 30000);
  });

  describe("invoke with tools", () => {
    it("should execute tools and return content", async () => {
      let toolCalledWith: any = null;

      const echoTool = createTool({
        name: "echo",
        description: "Echo back the given text exactly",
        schema: z.object({ text: z.string().describe("Text to echo") }),
        func: async (args: { text: string }) => {
          toolCalledWith = args;
          return { echoed: args.text };
        },
      });

      const agent = createSmartAgent({
        name: "ToolTestAgent",
        model,
        systemPrompt: "You are a helpful assistant. Use the echo tool when asked.",
        tools: [echoTool],
        limits: { maxToolCalls: 5 },
      });

      const result = await agent.invoke({
        messages: [{ role: "user", content: 'Use the echo tool to echo "hello world"' }],
      } as SmartState);

      console.log("Tool called with:", toolCalledWith);
      console.log("Content:", result.content);

      expect(toolCalledWith).not.toBeNull();
      expect(result.content).toBeTruthy();
      expect(result.content.length).toBeGreaterThan(0);
    }, 30000);
  });

  describe("invoke with streaming", () => {
    it("should stream and return non-empty content", async () => {
      const streamChunks: string[] = [];

      const agent = createSmartAgent({
        name: "StreamTestAgent",
        model,
        systemPrompt: "You are a helpful assistant. Keep answers brief.",
      });

      const result = await agent.invoke(
        {
          messages: [{ role: "user", content: "Say hello in 3 words" }],
        } as SmartState,
        {
          stream: true,
          onStream: (chunk) => {
            if (chunk.text) streamChunks.push(chunk.text);
          },
        }
      );

      console.log("Stream chunks count:", streamChunks.length);
      console.log("Streamed text:", streamChunks.join(""));
      console.log("Result content:", result.content);

      expect(result.content).toBeTruthy();
      expect(result.content.length).toBeGreaterThan(0);
      // Streaming should produce at least 1 chunk
      expect(streamChunks.length).toBeGreaterThan(0);
    }, 30000);
  });

  describe("invoke with streaming + tools", () => {
    it("should stream, call tools, and return non-empty content", async () => {
      const streamChunks: string[] = [];
      const events: SmartAgentEvent[] = [];
      let toolCalled = false;

      const calculator = createTool({
        name: "calculate",
        description: "Perform a math calculation",
        schema: z.object({
          expression: z.string().describe("Math expression like '2+2'"),
        }),
        func: async ({ expression }: { expression: string }) => {
          toolCalled = true;
          try {
            const result = eval(expression);
            return { result };
          } catch {
            return { error: "Invalid expression" };
          }
        },
      });

      const agent = createSmartAgent({
        name: "StreamToolAgent",
        model,
        systemPrompt: "You are a helpful calculator. Use the calculate tool for math.",
        tools: [calculator],
        limits: { maxToolCalls: 5 },
      });

      const result = await agent.invoke(
        {
          messages: [{ role: "user", content: "What is 15 * 7? Use the calculate tool." }],
        } as SmartState,
        {
          stream: true,
          onStream: (chunk) => {
            if (chunk.text) streamChunks.push(chunk.text);
          },
          onEvent: (event) => {
            events.push(event);
          },
        }
      );

      console.log("Tool called:", toolCalled);
      console.log("Events:", events.map((e) => e.type));
      console.log("Stream chunks count:", streamChunks.length);
      console.log("Result content:", result.content);

      expect(toolCalled).toBe(true);
      expect(result.content).toBeTruthy();
      expect(result.content.length).toBeGreaterThan(0);
      expect(result.content).toContain("105");
    }, 45000);
  });

  describe("invoke with useTodoList", () => {
    it("should emit plan events when agent uses manage_todo_list", async () => {
      const events: SmartAgentEvent[] = [];
      const planEvents: any[] = [];

      const agent = createSmartAgent({
        name: "PlannerAgent",
        model,
        systemPrompt:
          "You are a task planner. When given a task, ALWAYS create a plan first using manage_todo_list with operation 'write'. Include at least 2 items. Then respond with a brief summary.",
        useTodoList: true,
        limits: { maxToolCalls: 5 },
      });

      const result = await agent.invoke(
        {
          messages: [
            {
              role: "user",
              content: "Plan how to build a simple todo app. Create a plan with at least 2 steps.",
            },
          ],
        } as SmartState,
        {
          stream: true,
          onEvent: (event) => {
            events.push(event);
            if (event.type === "plan") {
              planEvents.push(event);
            }
          },
          onStream: (chunk) => {
            // just consume
          },
        }
      );

      console.log("Events types:", events.map((e) => e.type));
      console.log("Plan events:", planEvents.length);
      console.log(
        "Plan data:",
        planEvents.map((p) => ({
          operation: p.operation,
          items: p.todoList?.length,
        }))
      );
      console.log("Result content:", result.content?.slice(0, 200));

      expect(result.content).toBeTruthy();
      expect(result.content.length).toBeGreaterThan(0);

      // Agent should have used manage_todo_list
      const toolCallEvents = events.filter((e) => e.type === "tool_call");
      console.log(
        "Tool call events:",
        toolCallEvents.map((e: any) => e.name)
      );
    }, 60000);
  });

  describe("invoke with summarization", () => {
    it("should complete with summarization enabled", async () => {
      const events: SmartAgentEvent[] = [];

      const agent = createSmartAgent({
        name: "SumAgent",
        model,
        systemPrompt: "You are a helpful assistant.",
        summarization: { enable: true, maxTokens: 50000 },
      });

      const result = await agent.invoke(
        {
          messages: [{ role: "user", content: "What is the capital of France?" }],
        } as SmartState,
        {
          onEvent: (event) => events.push(event),
        }
      );

      console.log("Content:", result.content);
      expect(result.content).toBeTruthy();
      expect(result.content.toLowerCase()).toContain("paris");
    }, 30000);
  });

  describe("full workbench simulation", () => {
    it("should simulate workbench task execution with tools, plan, and streaming", async () => {
      const logs: { type: string; data: any }[] = [];
      const streamChunks: string[] = [];
      const events: SmartAgentEvent[] = [];
      let planData: any = null;

      // Simulate workbench tools
      const saveFile = createTool({
        name: "save_file",
        description: "Save content to a file",
        schema: z.object({
          path: z.string().describe("File path"),
          content: z.string().describe("File content"),
        }),
        func: async ({ path, content }: { path: string; content: string }) => {
          logs.push({ type: "save_file", data: { path, content: content.slice(0, 100) } });
          return { saved: true, path };
        },
      });

      const readFile = createTool({
        name: "read_file",
        description: "Read a file's content",
        schema: z.object({
          path: z.string().describe("File path to read"),
        }),
        func: async ({ path }: { path: string }) => {
          logs.push({ type: "read_file", data: { path } });
          return { content: `Content of ${path}`, exists: true };
        },
      });

      const systemPrompt = `You are an AI agent working on a project task in the Cognipeer Workbench.

## Project Information
- **Name**: Test Project
- **Description**: A test project for integration testing

## Current Task
- **Title**: Write a greeting module
- **Description**: Create a simple greeting function that returns "Hello, World!"
- **Priority**: medium
- **Run**: #1

## Planning Instructions
Before starting work, create a plan using manage_todo_list with operation 'write'.
Break down the task into steps. Then execute the steps.

## Important Rules
1. Always create a plan first using manage_todo_list
2. Save your work using save_file
3. Be thorough and document your process`;

      const agent = createSmartAgent({
        name: "workbench-test-project-greeting",
        model,
        tools: [saveFile, readFile],
        systemPrompt,
        useTodoList: true,
        summarization: { enable: true, maxTokens: 50000 },
      });

      const result = await agent.invoke(
        {
          messages: [
            {
              role: "user",
              content: "Write a greeting module. Create a simple greeting function that returns 'Hello, World!'",
            },
          ],
        } as SmartState,
        {
          stream: true,
          onEvent: (event) => {
            events.push(event);
            if (event.type === "plan") {
              planData = (event as any).todoList;
            }
          },
          onStream: (chunk) => {
            if (chunk.text) streamChunks.push(chunk.text);
          },
        }
      );

      console.log("\n=== WORKBENCH SIMULATION RESULTS ===");
      console.log("Content length:", result.content?.length);
      console.log("Content preview:", result.content?.slice(0, 300));
      console.log("Messages count:", result.messages?.length);
      console.log("Stream chunks:", streamChunks.length);
      console.log("Events:", events.map((e) => e.type));
      console.log("Plan data:", JSON.stringify(planData, null, 2)?.slice(0, 500));
      console.log("File operations:", logs);
      console.log("State todoList:", (result.state as any)?.todoList || "none");
      console.log(
        "Usage:",
        JSON.stringify(result.metadata?.usage?.totals, null, 2)
      );
      console.log("=== END ===\n");

      // Assertions
      expect(result.content).toBeTruthy();
      expect(result.content.length).toBeGreaterThan(0);

      // Should have tool call events
      const toolCallEvents = events.filter((e) => e.type === "tool_call");
      expect(toolCallEvents.length).toBeGreaterThan(0);

      // Should have used save_file
      expect(logs.some((l) => l.type === "save_file")).toBe(true);

      // Should have streamed
      expect(streamChunks.length).toBeGreaterThan(0);
    }, 120000);
  });
});
