# Agent SDK Examples

This directory contains examples demonstrating various features of the Agent SDK.

## Installation

Before running examples, first install dependencies from the root directory:

```bash
# From the root of the repository
npm install

# Then install example dependencies
cd examples
npm install
```

This will install the Agent SDK from the root directory and set up all example dependencies.

## Running Examples

From the `examples/` directory, run any example using:

```bash
npm run example:<name>
```

For example:
```bash
npm run example:basic
npm run example:multi-agent
npm run example:planning
```

## Available Examples

### Basic Usage
- **basic** - Basic agent setup and usage with simple tools
- **tools** - Multiple tools with event handling and Tavily search integration

### Planning & Task Management
- **todo-planning** - Structured task planning with TODO management
- **tool-limit** - Managing tool usage limits with finalize notices

### Advanced Features
- **guardrails** - Safety guardrails and content filtering
- **handoff** - Agent handoff and delegation patterns
- **multi-agent** - Multi-agent orchestration with agent-as-tool
- **structured-output** - Schema-based structured outputs with validation
- **vision** - Vision capabilities with multimodal input (text + images)

### State Management
- **pause-resume** - Pause and resume agent execution for long-running sessions
- **rewrite-summary** - Content rewriting and working with summarized history
- **summarization** - Token threshold-based automatic summarization
- **summarize-context** - Context-aware summarization with archived data retrieval

### Human-in-the-Loop
- **tool-approval** - Tool approval workflows with user confirmation

### Integrations
- **mcp-tavily** - MCP (Model Context Protocol) Tavily integration with remote tools

## Environment Setup

Most examples require API keys. Set them as environment variables:

```bash
export OPENAI_API_KEY=sk-...
# or for Anthropic examples
export ANTHROPIC_API_KEY=sk-ant-...
```

## Example Structure

Each example contains:
- **README.md** - Detailed explanation of the example
- **[name].ts** - TypeScript implementation
- Some examples also include `.mjs` files for ESM usage

## Requirements

- Node.js 18+
- API keys for OpenAI or Anthropic (depending on example)
- tsx for running TypeScript files directly
