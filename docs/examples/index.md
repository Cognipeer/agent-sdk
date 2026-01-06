# Examples

Comprehensive examples demonstrating Agent SDK capabilities.

## Quick Links

| Example | Capability | Description |
|---------|-----------|-------------|
| [Basic Agent](#basic-agent) | Core loop | Simple agent with tools |
| [Planning](#planning-todos) | TODOs | Structured task planning |
| [Multi-Agent](#multi-agent) | Composition | Agent delegation |
| [Tool Approval](#tool-approval) | Human-in-loop | Approval workflows |
| [Structured Output](#structured-output) | Validation | Schema-based responses |
| [Guardrails](#guardrails) | Safety | Content filtering |
| [Pause & Resume](#pause-resume) | State | Long-running sessions |
| [Vision](#vision) | Multimodal | Image + text input |
| [MCP](#mcp-tools) | Integration | Remote tool servers |

## Example Coverage Matrix

| Folder | Capability | Highlights |
|--------|------------|------------|
| `basic` | Base agent loop | Minimal tool call run with a real model |
| `tools` | Multiple tools + events | Tavily search integration, `onEvent` logging |
| `todo-planning` | Planning discipline | Enforced TODO updates with `useTodoList` |
| `tool-limit` | Tool cap + finalize | Shows injected finalize system notice |
| `summarization` | Token threshold | Demonstrates summarization triggers |
| `summarize-context` | Summary + retrieval | Uses `get_tool_response` to fetch archived data |
| `rewrite-summary` | Continue after summaries | Works with summarized history in follow-up turns |
| `structured-output` | Schema finalize | Parses JSON into typed outputs |
| `multi-agent` | Agent-as-tool | Delegation via `agent.asTool` |
| `handoff` | Runtime handoff | Transfers control between agents |
| `mcp-tavily` | MCP tools | Demonstrates remote MCP tool usage |
| `guardrails` | Policy enforcement | Guardrails blocking secrets and code responses |
| `vision` | Multimodal input | Sends text + image parts through the adapter |

## Running Examples

All examples are in the `examples/` directory at the repository root:

```bash
# Clone repository
git clone https://github.com/Cognipeer/agent-sdk
cd agent-sdk

# Install root dependencies
npm install

# Install example dependencies
cd examples
npm install

# Set up API key
export OPENAI_API_KEY=sk-...

# Run an example
npm run example:basic
npm run example:planning
npm run example:multi-agent
```

## Example Details

### Basic Agent

Simple agent with a few tools demonstrating the core loop.

**File**: `examples/basic/basic.ts`

**Features**:
- Tool creation with Zod schemas
- Basic invoke flow
- Simple error handling

```typescript
import { createSmartAgent, createTool } from "@cognipeer/agent-sdk";
import { z } from "zod";

const echo = createTool({
  name: "echo",
  description: "Echo back text",
  schema: z.object({ text: z.string() }),
  func: async ({ text }) => ({ echoed: text }),
});

const agent = createSmartAgent({ model, tools: [echo] });
const result = await agent.invoke({
  messages: [{ role: "user", content: "Say hello" }],
});
```

### Planning & TODOs

Demonstrates structured planning with TODO management.

**File**: `examples/todo-planning/todo-planning.ts`

**Features**:
- Planning mode enabled
- Plan event monitoring
- Multi-step task breakdown

```typescript
const agent = createSmartAgent({
  model,
  tools,
  useTodoList: true,
  onEvent: (event) => {
    if (event.type === "plan") {
      console.log("Plan:", event.todoList);
    }
  },
});
```

### Multi-Agent

Agent composition and delegation patterns.

**File**: `examples/multi-agent/multi-agent.ts`

**Features**:
- Agent-as-tool delegation
- Nested agent execution
- Result aggregation

```typescript
const specialist = createSmartAgent({
  name: "Specialist",
  model,
  tools: [specializedTool],
});

const coordinator = createSmartAgent({
  name: "Coordinator",
  model,
  tools: [specialist.asTool({ toolName: "delegate" })],
});
```

### Tool Approval

Human-in-the-loop approval workflow.

**File**: `examples/tool-approval/tool-approval.ts`

**Features**:
- Pause before tool execution
- User approval prompt
- Resume after approval

```typescript
const result = await agent.invoke(state, {
  onStateChange: (s) => {
    const lastMsg = s.messages.at(-1);
    if (lastMsg?.tool_calls) {
      // Pause for approval
      return true;
    }
  },
});

// Show tools to user, get approval
const approved = await getUserApproval(result.state);

if (approved) {
  const resumed = await agent.resume(
    agent.snapshot(result.state)
  );
}
```

### Structured Output

Schema-based output validation and parsing.

**File**: `examples/structured-output/structured-output.ts`

**Features**:
- Zod schema validation
- Automatic parsing
- Type-safe outputs

```typescript
const agent = createSmartAgent({
  model,
  tools,
  outputSchema: z.object({
    summary: z.string(),
    items: z.array(z.string()),
    confidence: z.number().min(0).max(1),
  }),
});

const result = await agent.invoke({ messages });
console.log(result.output); // Typed and validated
```

### Guardrails

Content filtering and safety checks.

**File**: `examples/guardrails/guardrails.ts`

**Features**:
- Built-in guardrail presets
- Custom guardrail checks
- Severity levels (warn/block)

```typescript
import { guardrailPresets } from "@cognipeer/agent-sdk";

const agent = createSmartAgent({
  model,
  tools,
  guardrails: [
    ...guardrailPresets.noSecrets,
    ...guardrailPresets.noCodeExecution,
  ],
});
```

### Pause & Resume

Long-running session management.

**File**: `examples/pause-resume/pause-resume.ts`

**Features**:
- State snapshots
- Checkpoint persistence
- Resume from snapshot

```typescript
// Initial run
const result = await agent.invoke(state, {
  onStateChange: (s) => shouldPause(s),
});

// Save snapshot
const snapshot = agent.snapshot(result.state, {
  tag: "checkpoint-1",
});
fs.writeFileSync("checkpoint.json", JSON.stringify(snapshot));

// Later: resume
const savedSnapshot = JSON.parse(fs.readFileSync("checkpoint.json"));
const resumed = await agent.resume(savedSnapshot);
```

### Vision

Multimodal input with images and text.

**File**: `examples/vision/vision.ts`

**Features**:
- Image URL input
- Base64 image support
- Mixed text + image messages

```typescript
const result = await agent.invoke({
  messages: [{
    role: "user",
    content: [
      { type: "text", text: "What's in this image?" },
      { type: "image_url", image_url: "https://example.com/image.jpg" },
    ],
  }],
});
```

### MCP Tools

Integration with Model Context Protocol servers.

**File**: `examples/mcp-tavily/mcp-tavily.ts`

**Features**:
- MCP client setup
- Remote tool discovery
- Tool execution

```typescript
import { Client } from "@modelcontextprotocol/sdk/client/index.js";

const client = new Client(/* ... */);
await client.connect(transport);

const mcpTools = await client.listTools();
const tools = fromLangchainTools(/* convert MCP tools */);

const agent = createSmartAgent({ model, tools });
```

## Next Steps

1. **Clone the repository** and explore `examples/` folder
2. **Read the source code** for each example
3. **Run examples locally** with your API keys
4. **Modify examples** to test your use cases
5. **Check the logs** in `logs/` directory after running

## See Also

- [Getting Started](/guide/getting-started) - Setup guide
- [API Reference](/api/agent) - Complete API docs
- [GitHub Repository](https://github.com/Cognipeer/agent-sdk) - Source code
