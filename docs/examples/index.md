# Examples

This section is a recipe catalog, not a loose folder dump. Each example is here to demonstrate one concrete runtime behavior, how to run it, what to inspect, and which integration problem it helps solve.

## Browse by track

<div class="example-grid">
	<a class="example-card" href="/agent-sdk/examples/basic">
		<span class="example-card-badge">Fundamentals</span>
		<strong>Basic Agent</strong>
		<span>Understand the minimal loop, one tool call, and final response assembly.</span>
		<code>example:basic</code>
	</a>
	<a class="example-card" href="/agent-sdk/examples/tools">
		<span class="example-card-badge">Fundamentals</span>
		<strong>Tools</strong>
		<span>See typed local tools, env checks, and an external API-backed tool in one place.</span>
		<code>example:tools</code>
	</a>
	<a class="example-card" href="/agent-sdk/examples/planning">
		<span class="example-card-badge">Smart Runtime</span>
		<strong>Planning &amp; TODOs</strong>
		<span>Inspect how a smart agent turns multi-step work into durable plan state.</span>
		<code>example:todo-planning</code>
	</a>
	<a class="example-card" href="/agent-sdk/examples/summarization">
		<span class="example-card-badge">Smart Runtime</span>
		<span>Understand context compaction before adding retrieval and resume behaviors.</span>
		<code>example:summarization</code>
	</a>
	<a class="example-card" href="/agent-sdk/examples/summarize-context">
		<span class="example-card-badge">Smart Runtime</span>
		<span>Recover raw tool payloads after the runtime archived heavy responses.</span>
		<code>example:summarize-context</code>
	</a>
	<a class="example-card" href="/agent-sdk/examples/rewrite-summary">
		<span class="example-card-badge">Smart Runtime</span>
		<span>Continue on a later turn after history was already rewritten into a compact form.</span>
		<code>example:rewrite-summary</code>
	</a>
	<a class="example-card" href="/agent-sdk/examples/tool-limit">
		<span class="example-card-badge">Smart Runtime</span>
		<span>See how the runtime forces a direct answer once the tool-call budget is exhausted.</span>
		<code>example:tool-limit</code>
	</a>
	<a class="example-card" href="/agent-sdk/examples/tool-approval">
		<span class="example-card-badge">Control &amp; Safety</span>
		<span>Pause before sensitive execution, then resume from an approved runtime state.</span>
		<code>example:tool-approval</code>
	</a>
	<a class="example-card" href="/agent-sdk/examples/pause-resume">
		<span class="example-card-badge">Control &amp; Safety</span>
		<span>Snapshot a paused run, serialize it, and continue later without replaying the session.</span>
		<code>example:pause-resume</code>
	</a>
	<a class="example-card" href="/agent-sdk/examples/structured-output">
		<span class="example-card-badge">Control &amp; Safety</span>
		<span>Require a schema-shaped final result while keeping the standard assistant response path.</span>
		<code>example:structured-output</code>
	</a>
	<a class="example-card" href="/agent-sdk/examples/guardrails">
		<span class="example-card-badge">Control &amp; Safety</span>
		<span>Enforce request and response policy at runtime instead of relying on prompt wording.</span>
		<code>example:guardrails</code>
	</a>
	<a class="example-card" href="/agent-sdk/examples/multi-agent">
		<span class="example-card-badge">Orchestration</span>
		<span>Compose specialist agents as tools without moving into a heavier orchestration stack.</span>
		<code>example:multi-agent</code>
	</a>
	<a class="example-card" href="/agent-sdk/examples/handoff">
		<span class="example-card-badge">Orchestration</span>
		<span>Transfer ownership to another agent and inspect explicit handoff events.</span>
		<code>example:handoff</code>
	</a>
	<a class="example-card" href="/agent-sdk/examples/vision">
		<span class="example-card-badge">Integrations</span>
		<span>Start with the smallest multimodal message format before wrapping it in a full agent.</span>
		<code>example:vision</code>
	</a>
	<a class="example-card" href="/agent-sdk/examples/mcp">
		<span class="example-card-badge">Integrations</span>
		<span>Connect a remote MCP server and run discovered tools inside the same smart runtime.</span>
		<code>example:mcp-tavily</code>
	</a>
</div>


1. Pick the runtime problem you are trying to solve.
2. Open the closest example page.
3. Run the script from `examples/package.json`.
4. Compare the documented flow with the example source and the output you see locally.
## Setup once

```bash
cd examples
npm install

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

## Suggested learning path

### 1. Fundamentals

- `basic`
- `tools`
- `planning`

### 2. Smart runtime behavior

- `summarization`
- `summarize-context`
- `rewrite-summary`
- `tool-limit`

### 3. Production control surfaces

- `tool-approval`
- `pause-resume`
- `structured-output`
- `guardrails`

### 4. Orchestration and integrations

- `multi-agent`
- `handoff`
- `vision`
- `mcp`
