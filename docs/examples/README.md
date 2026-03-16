---
title: Examples
nav_order: 9
permalink: /examples/
---

# Examples

This section is a recipe catalog, not a loose folder dump. Each example is here to demonstrate one concrete runtime behavior, how to run it, what to inspect, and which integration problem it helps solve.

## Browse by track

<div class="example-grid">
	<a class="example-card" href="/agent-sdk/examples/basic">
		<strong>Basic Agent</strong>
		<span>Understand the minimal loop, one tool call, and final response assembly.</span>
		<code>example:basic</code>
	</a>
	<a class="example-card" href="/agent-sdk/examples/tools">
		<strong>Tools</strong>
		<span>See typed local tools, env checks, and an external API-backed tool in one place.</span>
		<code>example:tools</code>
	</a>
	<a class="example-card" href="/agent-sdk/examples/planning">
		<strong>Planning &amp; TODOs</strong>
		<span>Inspect how a smart agent turns multi-step work into durable plan state.</span>
		<code>example:todo-planning</code>
	</a>
	<a class="example-card" href="/agent-sdk/examples/summarization">
		<strong>Summarization</strong>
		<span>Understand context compaction before adding retrieval and resume behaviors.</span>
		<code>example:summarization</code>
	</a>
	<a class="example-card" href="/agent-sdk/examples/summarize-context">
		<strong>Archived Tool Retrieval</strong>
		<span>Recover raw tool payloads after the runtime archived heavy responses.</span>
		<code>example:summarize-context</code>
	</a>
	<a class="example-card" href="/agent-sdk/examples/rewrite-summary">
		<strong>Rewrite After Summary</strong>
		<span>Continue on a later turn after history was already rewritten into a compact form.</span>
		<code>example:rewrite-summary</code>
	</a>
	<a class="example-card" href="/agent-sdk/examples/tool-limit">
		<strong>Tool Limit Finalize</strong>
		<span>See how the runtime forces a direct answer once the tool-call budget is exhausted.</span>
		<code>example:tool-limit</code>
	</a>
	<a class="example-card" href="/agent-sdk/examples/tool-approval">
		<strong>Tool Approval</strong>
		<span>Pause before sensitive execution, then resume from an approved runtime state.</span>
		<code>example:tool-approval</code>
	</a>
	<a class="example-card" href="/agent-sdk/examples/pause-resume">
		<strong>Pause &amp; Resume</strong>
		<span>Snapshot a paused run, serialize it, and continue later without replaying the session.</span>
		<code>example:pause-resume</code>
	</a>
	<a class="example-card" href="/agent-sdk/examples/structured-output">
		<strong>Structured Output</strong>
		<span>Require a schema-shaped final result while keeping the standard assistant response path.</span>
		<code>example:structured-output</code>
	</a>
	<a class="example-card" href="/agent-sdk/examples/guardrails">
		<strong>Guardrails</strong>
		<span>Enforce request and response policy at runtime instead of relying on prompt wording.</span>
		<code>example:guardrails</code>
	</a>
	<a class="example-card" href="/agent-sdk/examples/multi-agent">
		<strong>Multi-Agent</strong>
		<span>Compose specialist agents as tools without moving into a heavier orchestration stack.</span>
		<code>example:multi-agent</code>
	</a>
	<a class="example-card" href="/agent-sdk/examples/handoff">
		<strong>Handoff</strong>
		<span>Transfer ownership to another agent and inspect explicit handoff events.</span>
		<code>example:handoff</code>
	</a>
	<a class="example-card" href="/agent-sdk/examples/vision">
		<strong>Vision</strong>
		<span>Start with the smallest multimodal message format before wrapping it in a full agent.</span>
		<code>example:vision</code>
	</a>
	<a class="example-card" href="/agent-sdk/examples/mcp">
		<strong>MCP Tools</strong>
		<span>Connect a remote MCP server and run discovered tools inside the same smart runtime.</span>
		<code>example:mcp-tavily</code>
	</a>
</div>

## Browse by track

<div class="example-grid">
	<a class="example-card" href="/agent-sdk/examples/basic">
		<strong>Basic Agent</strong>
		<span>Understand the minimal loop, one tool call, and final response assembly.</span>
		<code>example:basic</code>
	</a>
	<a class="example-card" href="/agent-sdk/examples/tools">
		<strong>Tools</strong>
		<span>See typed local tools, env checks, and an external API-backed tool in one place.</span>
		<code>example:tools</code>
	</a>
	<a class="example-card" href="/agent-sdk/examples/planning">
		<strong>Planning &amp; TODOs</strong>
		<span>Inspect how a smart agent turns multi-step work into durable plan state.</span>
		<code>example:todo-planning</code>
	</a>
	<a class="example-card" href="/agent-sdk/examples/summarization">
		<strong>Summarization</strong>
		<span>Understand context compaction before adding retrieval and resume behaviors.</span>
		<code>example:summarization</code>
	</a>
	<a class="example-card" href="/agent-sdk/examples/summarize-context">
		<strong>Archived Tool Retrieval</strong>
		<span>Recover raw tool payloads after the runtime archived heavy responses.</span>
		<code>example:summarize-context</code>
	</a>
	<a class="example-card" href="/agent-sdk/examples/rewrite-summary">
		<strong>Rewrite After Summary</strong>
		<span>Continue on a later turn after history was already rewritten into a compact form.</span>
		<code>example:rewrite-summary</code>
	</a>
	<a class="example-card" href="/agent-sdk/examples/tool-limit">
		<strong>Tool Limit Finalize</strong>
		<span>See how the runtime forces a direct answer once the tool-call budget is exhausted.</span>
		<code>example:tool-limit</code>
	</a>
	<a class="example-card" href="/agent-sdk/examples/tool-approval">
		<strong>Tool Approval</strong>
		<span>Pause before sensitive execution, then resume from an approved runtime state.</span>
		<code>example:tool-approval</code>
	</a>
	<a class="example-card" href="/agent-sdk/examples/pause-resume">
		<strong>Pause &amp; Resume</strong>
		<span>Snapshot a paused run, serialize it, and continue later without replaying the session.</span>
		<code>example:pause-resume</code>
	</a>
	<a class="example-card" href="/agent-sdk/examples/structured-output">
		<strong>Structured Output</strong>
		<span>Require a schema-shaped final result while keeping the standard assistant response path.</span>
		<code>example:structured-output</code>
	</a>
	<a class="example-card" href="/agent-sdk/examples/guardrails">
		<strong>Guardrails</strong>
		<span>Enforce request and response policy at runtime instead of relying on prompt wording.</span>
		<code>example:guardrails</code>
	</a>
	<a class="example-card" href="/agent-sdk/examples/multi-agent">
		<strong>Multi-Agent</strong>
		<span>Compose specialist agents as tools without moving into a heavier orchestration stack.</span>
		<code>example:multi-agent</code>
	</a>
	<a class="example-card" href="/agent-sdk/examples/handoff">
		<strong>Handoff</strong>
		<span>Transfer ownership to another agent and inspect explicit handoff events.</span>
		<code>example:handoff</code>
	</a>
	<a class="example-card" href="/agent-sdk/examples/vision">
		<strong>Vision</strong>
		<span>Start with the smallest multimodal message format before wrapping it in a full agent.</span>
		<code>example:vision</code>
	</a>
	<a class="example-card" href="/agent-sdk/examples/mcp">
		<strong>MCP Tools</strong>
		<span>Connect a remote MCP server and run discovered tools inside the same smart runtime.</span>
		<code>example:mcp-tavily</code>
	</a>
</div>

## How to use this section

1. Pick the runtime problem you are trying to solve.
2. Open the closest example page.
3. Run the script from `examples/package.json`.
4. Compare the documented flow with the example source and the output you see locally.

## Setup once

```bash
cd examples
npm install
```

Some examples run entirely with fake models. Others need real provider credentials.

## Environment matrix

| Example type | Real provider key required | Notes |
|---|---|---|
| `basic`, `planning`, `summarization`, `tool-limit` | optional | These examples include a fake model fallback. |
| `tools` | `OPENAI_API_KEY` | `TAVILY_API_KEY` is optional unless the search tool is used. |
| `structured-output` | optional | Includes a fake model fallback. |
| `pause-resume`, `tool-approval`, `guardrails` | no | Built for local runtime behavior inspection. |
| `multi-agent` | optional | Includes fake-model fallback. |
| `handoff` | yes | Uses `ChatOpenAI` directly. |
| `vision` | yes | Requires a multimodal-capable provider model. |
| `mcp` | yes | Requires `OPENAI_API_KEY` and `TAVILY_API_KEY`. |

## Choose by product need

| If you need to... | Open this example first |
|---|---|
| understand the minimal runtime loop | `/examples/basic` |
| define and call local typed tools | `/examples/tools` |
| make the agent manage multi-step work | `/examples/planning` |
| keep a long-running agent alive under context pressure | `/examples/summarization` |
| recover archived raw tool payloads | `/examples/summarize-context` |
| continue after compaction on a later turn | `/examples/rewrite-summary` |
| stop unbounded tool recursion | `/examples/tool-limit` |
| pause for human approval | `/examples/tool-approval` |
| snapshot and resume later | `/examples/pause-resume` |
| force typed final output | `/examples/structured-output` |
| block unsafe requests or responses | `/examples/guardrails` |
| compose specialist agents | `/examples/multi-agent` |
| hand off ownership to another agent | `/examples/handoff` |
| connect a remote MCP tool server | `/examples/mcp` |
| send image input to a multimodal model | `/examples/vision` |
