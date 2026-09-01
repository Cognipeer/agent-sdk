# Plugins and hooks

An integration usually needs to do three different things: **intercept** the run
(a guardrail, a redactor, a rate limiter), **add** to it (a tool, a prompt
block, a guardrail), and sometimes **replace** one of the SDK's own components
(the summarizer, the memory store). The plugin layer gives each of those its own
shape, and packages them under one name.

```ts
import {
  createSmartAgent,
  cognipeerGuardrail,
  piiRedaction,
  toolPolicy,
} from "@cognipeer/agent-sdk";

const agent = createSmartAgent({
  model,
  tools,
  plugins: [
    piiRedaction({ entities: ["TCKN", "IBAN", "EMAIL"] }),
    cognipeerGuardrail({ guardrailKey: "prod-default" }),
    toolPolicy({ ask: ["delete_record"], deny: [/^admin_/] }),
  ],
  // One-off rules need no plugin at all:
  hooks: {
    preToolUse: ({ toolName }) => (toolName === "shell" ? { decision: "ask" } : undefined),
  },
});
```

## The three kinds

| Kind | What it does | When two of them meet |
| --- | --- | --- |
| **Hook** | Intercepts a point in the run | All run, chained in priority order; decisions merge |
| **Contribution** | Adds a tool, prompt block, guardrail, model wrapper | All run, results accumulate |
| **Slot** | Replaces an SDK default | Exactly one owner — two claimants is a startup error |

## Hook points

| Hook | Fires | Can |
| --- | --- | --- |
| `sessionStart` | Start of a run, once, including on resume | Replace the transcript, append to the system prompt |
| `userPromptSubmit` | A new user message enters the transcript | Rewrite the text, add context, deny |
| `preModelCall` | Before every model call | Rewrite wire messages, narrow the tool menu, merge invoke params, short-circuit, deny |
| `postModelCall` | After the assistant turn comes back | Rewrite the message, deny, retry |
| `preToolUse` | After argument validation, before the approval gate | Rewrite args, deny, escalate to approval, short-circuit with a result |
| `postToolUse` | On the raw tool output, before compression | Rewrite the output, deny |
| `preCompact` / `postCompact` | Around summarization | Pin messages, skip a pass, observe |
| `preFinalAnswer` | Before the answer returns to the caller | Rewrite, deny |
| `subagentStart` / `subagentStop` | Around a sub-agent task | Rewrite the task, deny, observe |
| `notification` | Approval, question or limit | Observe |
| `sessionEnd` | Every exit path: success, error, paused, cancelled | Observe |

A hook returns `undefined` to mean "nothing changed". Every output field is
optional, so new capability can be added without breaking existing plugins.

```ts
import { definePlugin } from "@cognipeer/agent-sdk";

export const officeHours = definePlugin<{ from: number; to: number }>((cfg) => ({
  name: "office-hours",
  priority: 10,
  hooks: {
    preToolUse: ({ toolName }) => {
      const hour = new Date().getHours();
      if (hour >= cfg.from && hour < cfg.to) return;
      return { decision: "ask", approvalPrompt: `${toolName} outside office hours — approve?` };
    },
  },
}));
```

## How several plugins compose

1. **Order is deterministic** — `priority` ascending (default 100), then
   declaration order. A plugin that must see raw text before a guardrail
   forwards it declares a lower number; `piiRedaction` ships at 10 and the
   guardrail presets at 20 for exactly this reason.
2. **Mutations chain.** The second handler sees the first one's output. That is
   what makes "mask, then scan the masked text" work.
3. **Decisions escalate: `deny` > `ask` > `allow`.** The first `deny` ends the
   chain. `allow` never downgrades anything — a plugin cannot switch off a
   tool's own `needsApproval`.
4. **First short-circuit wins.** A second one is dropped and reported.
5. **Failure posture is per plugin.** `failureMode: "open"` (the default) logs
   and continues; `"closed"` turns an error or a timeout into a deny. Guardrail
   plugins ship as `"closed"` — silently not guarding is worse than stopping.
6. **Timeouts are per handler.** `timeoutMs` defaults to 10s; the guardrail
   presets use 3s, because they sit on the critical path of every turn.
7. **Observers never block.** `sessionEnd`, `notification`, `postCompact` and
   `subagentStop` run concurrently and their failures are swallowed.

### What a `deny` actually does

It never throws. Each hook maps to a termination the runtime already knows, so
the model sees the refusal and can recover:

| Hook | Effect |
| --- | --- |
| `userPromptSubmit` | Run ends before the first model call with a guardrail message |
| `preModelCall` | Model is not called; one assistant turn carries the reason |
| `postModelCall` | The offending assistant turn is **replaced**, not appended |
| `preToolUse` | Tool does not run; the reason returns as the tool result and `toolHistory` records `status: "rejected"` |
| `postToolUse` | The output is replaced by the reason before it reaches the model |
| `preFinalAnswer` | The answer is replaced by the reason, and a parsed `output` is cleared with it |

## Contributions

```ts
definePlugin<Config>((cfg) => ({
  name: "my-integration",
  tools: async (ctx) => connectAndDiscoverTools(cfg),   // merged by name; built-ins win
  systemPrompt: (current) => `${current}\n\n${cfg.instructions}`,
  toolDescriptions: { delegate_to: (d) => `${d} Prefer the researcher for facts.` },
  guardrails: [myConversationGuardrail],                  // v1 guardrails, packaged
  wrapModel: (model) => withRetries(model),
  setup: async (ctx) => { /* open clients */ return () => close(); },
  dispose: async () => { /* or here */ },
}));
```

Tool contributions reach the live loop, `resume()` and the `asTool` path alike.
A contributed tool never shadows a built-in of the same name.

## Slots

A slot replaces one of the SDK's defaults. Exactly one plugin may fill each one;
two claimants throw at construction, naming both plugins, because a summarizer
that silently lost is not debuggable.

| Slot | Replaces | Status |
| --- | --- | --- |
| `memoryStore` | `memory.store` | **live** |
| `tokenCounter` | The `tokenCounter` option | **live** |
| `costEstimator` | The `costEstimator` option | **live** |
| `conversationStore` | Thread history load/save | **live** — `conversationHistory` does the work through `sessionStart`/`sessionEnd`; the slot is the registry |
| `checkpointStore` | Where `snapshot()` output is persisted | **live** — same shape, via `sessionEnd` |
| `summarizer` | The compression step of context compaction | declared, not wired yet |
| `approvalTransport` | How a pending approval reaches a human | declared, not wired yet |
| `skillSource` / `promptSource` | Where skills and prompts come from | declared, not wired yet |
| `contextBuilder` | Model-message assembly (advanced) | declared, not wired yet |

A slot marked *declared, not wired* is validated (one owner, a conflict throws)
and readable from `host.slots`, but no call site consumes it: filling one today
does nothing at runtime. `webhookApproval` is in that position — it is written
and tested against the slot contract, and waits on the runtime side.

Selection and validation stay in the SDK: a slot changes *how* a step is done,
never the invariants around it. The summarizer slot receives the message set the
SDK already chose as compressable and returns a `StructuredSummary`; the
protected recency window, tool-call adjacency and archive bookkeeping are not
negotiable.

## Sub-agents inherit plugins

Every plugin propagates to sub-agents and delegated children unless it declares
`inheritToSubagents: false`. A policy that a delegation could shed would not be
a policy — "have a sub-agent do it" must not be a way around a guardrail.

## Approvals and `ask_user_question`

Neither is a separate subsystem the plugin layer can ignore.

**Approvals compose with `preToolUse`.** A hook returning `decision: "ask"`
raises approval for a tool that never declared `needsApproval`, and the two
combine with OR — a hook can escalate a call, never wave one through. The
escalation survives the resume: `needsApproval` recomputes to `false` on the
resumed turn (the tool itself never required it), so the pending-approval ledger
entry is what keeps the gate closed. A call a human **rejected** does not run.

An approval pause ends the plugin session with `status: "paused"`, and the
resume opens a new one with `resumed: true`. A plugin metering runs therefore
never sees one open-ended session spanning however long a person took to answer.
`notification` fires with `kind: "approval"` when a call parks.

**`ask_user_question` is a tool**, so every tool hook fires on it:

- `preToolUse` runs on it and can rewrite, deny or gate it like any other tool.
- `postToolUse` does **not** run for the call that parks the run. The pause
  marker is consumed first, deliberately: emitting a result for a `tool_use`
  that is still unresolved is what would stop the call being re-selected on
  resume.
- `notification` fires with `kind: "user_question"`.

### Two things worth knowing

**An allow-list does not govern the SDK's own tools.** `toolPolicy({ allowOnly })`
exempts `ask_user_question`, `manage_plan`, `get_tool_response`, `response`,
`open_skill` and the rest of the control plane. Nobody writing an allow-list
means "and also stop the agent asking me a question or returning its structured
output", and governing them silently breaks human-in-the-loop, planning and
structured output at once — with a symptom that points nowhere near the policy.
Pass `governControlPlaneTools: true` to include them anyway; an explicit `deny`
entry or rule still applies either way.

**The human's answer reaches the transcript without passing a hook.**
`resolveUserQuestion` is a pure state helper with no host, so it injects the
answer as a `role: "tool"` message directly, outside the tools node and
therefore outside `postToolUse`. A redactor configured for tool output does not
see what the person typed. If that matters, sanitize the answers before calling
`resolveUserQuestion`. This is pinned by a test so a future fix is a visible
change rather than a silent one.

## Multimodal turns

A user turn is not always a string. When it carries an image, audio, video or a
file, `userPromptSubmit` hands the hook three views of the same value:

```ts
defineHook("userPromptSubmit", ({ text, content, attachments }) => {
  // text        — the text parts, joined. Empty string for a media-only turn.
  // content     — the whole thing: a string, or the parts array.
  // attachments — the non-text parts, normalized: kind, mediaType, size, url.
  if (attachments.some((a) => a.kind === "video")) {
    return { decision: "deny", reason: "Video is not supported here." };
  }
});
```

**Returning `text` rewrites the text parts and leaves the attachments where
they are.** Assigning a plain string over a multi-part message is how an
attached image silently disappears, so the layer never does it: the rewrite is
written back through the parts. With several text parts the replacement lands in
the first and the rest are dropped, because the hook only saw their
concatenation — return `content` when that distinction matters. `piiRedaction`
does exactly that, redacting each text part in place so an image between two
paragraphs keeps its position.

`mediaPolicy` covers the structural checks a text guardrail cannot see:

```ts
mediaPolicy({
  allow: ["image", "file"],          // no audio, no video
  maxAttachments: 4,
  maxBytesPerAttachment: 5_000_000,
  allowedMediaTypes: ["image/", "application/pdf"],
  requireHttps: true,                // the provider fetches URLs server-side
  action: "deny",                    // or "strip" to continue without them
})
```

Guardrail transports receive the attachments too, described rather than inlined
(kind, media type, size) — shipping a base64 image on every check would multiply
the cost of the guardrail by the size of the upload. Two uploads under the same
caption are two different cache entries.

## Not yet wired

`preFinalAnswer.continueWith` and trace-sink contributions are inert in this
release and say so at runtime:
`preFinalAnswer.continueWith` (re-entering the loop would reset the wall-clock,
iteration and reflection budgets) and trace-sink contributions (the tracing
runtime carries a single sink; configure sinks through `tracing` for now).

## Streaming caveat

`postModelCall` and `preFinalAnswer` rewrites fix the transcript, but chunks
already streamed to the caller cannot be recalled. When a redaction plugin is
active, either disable streaming for that run or buffer it on your side.

## Observability

Decisions, mutations, short-circuits and hook errors are emitted as `plugin`
events on `onEvent`:

```ts
await agent.invoke(input, {
  onEvent(event) {
    if (event.type === "plugin") {
      console.log(`[${event.plugin}] ${event.hook} → ${event.decision ?? "ok"} (${event.durationMs}ms)`);
    }
  },
});
```

Pass `pluginOptions: { debug: true }` to emit an event for every handler call,
not only the interesting ones.

## Writing a guardrail integration

Any policy service plugs in through one transport interface:

```ts
import { createGuardrailPlugin, httpGuardrail } from "@cognipeer/agent-sdk";

export const myGuardrail = (cfg) =>
  createGuardrailPlugin({
    name: "my-guardrail",
    apply: ["input", "output", "tool"],
    failClosed: true,
    transport: httpGuardrail({
      url: cfg.url,
      headers: { Authorization: `Bearer ${cfg.apiKey}` },
      timeoutMs: 3000,
      // The service contract lives here and nowhere else.
      buildRequest: (requests, ctx) => ({ items: requests, traceId: ctx.traceId }),
      mapVerdict: (response) => [/* allow | block | mask */],
    }),
  });
```

`cognipeerGuardrail` and `portkeyGuardrail` are exactly this, with the endpoint
and auth convention filled in. Use `mode: "shadow"` to measure what a policy
*would* have blocked before enforcing it.

## The built-ins

| Plugin | Does |
| --- | --- |
| `cognipeerGuardrail` · `portkeyGuardrail` · `openAIModeration` · `azureContentSafety` · `bedrockGuardrail` · `regexGuardrail` | Policy services on one transport seam |
| `piiRedaction` | Masks TCKN, IBAN, card, email, phone, JWT, API keys — checksummed where possible |
| `promptInjectionGuard` | Heuristics for instructions smuggled into fetched content |
| `mediaPolicy` | Kind, count, size, media type and source rules for attachments |
| `toolPolicy` · `pathSandbox` | Central allow/ask/deny rules and a filesystem boundary |
| `outputGuard` · `languageGuard` | Final-answer contract and response-language checks |
| `budgetGuard` · `rateLimit` | Spend ceilings and token buckets |
| `responseCache` | Exact-match model response cache via `preModelCall` short-circuit |
| `auditLog` · `sessionMetrics` | Attempt log and one structured record per run |
| `langfuseTracing` · `otelTracing` | Observability exporters |
| `conversationHistory` · `checkpointing` · `webhookApproval` | Slot implementations: thread history, pause persistence, human approval |
| `mcp` | Connect/discover/close lifecycle for an MCP server, with no added dependency |
