---
title: Examples
nav_order: 9
permalink: /examples/
---

# Examples

Build the package once (`npm run build` from repo root) and then run any example with `tsx`. Each folder ships a README with extra notes.

| Folder | Capability | Notes |
|--------|------------|-------|
| `basic/` | Minimal loop | Single tool call with a real model (OpenAI). |
| `tools/` | Multiple tools + events | Includes Tavily search integration and `onEvent` logging. |
| `tool-limit/` | Global tool cap | Shows finalize system notice injection when limit is hit. |
| `structured-output/` | Zod finalize | Demonstrates `outputSchema` with parsed JSON results. |
| `todo-planning/` | Planning discipline | Enforces TODO workflow via `useTodoList: true`. |
| `summarization/` | Token threshold | Triggers summarization based on `summarization.maxTokens`. |
| `summarize-context/` | Summary + raw retrieval | Uses `get_tool_response` to fetch archived outputs. |
| `rewrite-summary/` | Post-summary continuation | Continues conversation after context has been summarized. |
| `multi-agent/` | Delegation | Wraps an agent as a tool to answer sub-questions. |
| `handoff/` | Runtime handoff | Transfers control between specialist agents. |
| `mcp-tavily/` | MCP tools | Discovers and uses MCP-hosted Tavily search. |
| `vision/` | Multimodal | Sends text + image message parts through the adapter. |

Required environment variables:
- `OPENAI_API_KEY` – needed for all OpenAI-backed examples.
- `TAVILY_API_KEY` – optional; enables real Tavily results in `tools/` and the MCP example.

Tip: enable `tracing.enabled: true` while testing and review `logs/[session]/trace.session.json` for full event history, payloads, and usage details.
