
# Tool Approvals (Human-in-the-Loop)

Some tool calls need a human to confirm inputs before they execute—think payments, deployments, or data export. This page explains how to integrate human-in-the-loop approvals with the Smart Agent runtime.

## Enabling approvals on a tool

Set `needsApproval: true` when creating a tool. Optionally include UI hints:

```ts
const deploy = createTool({
  name: "deploy_service",
  description: "Roll out the current build to production",
  schema: z.object({ version: z.string() }),
  needsApproval: true,
  approvalPrompt: "Send build {{version}} to prod?",
  approvalDefaults: { channel: "ops", priority: "high" },
  async func({ version }) {
    return rollout(version);
  },
});
```

Once selected by the model, the agent will:

1. Append a `pendingApprovals` entry to the state.
2. Emit a `tool_approval` event with `status: "pending"`.
3. Pause execution until the approval is resolved.

## Approving per call, from the arguments

A boolean decides for the tool as a whole, which is too coarse for most real
tools: the dangerous half of `bash` is not its name, it is what it was asked to
run. Pass a **predicate** instead and the decision is made per call, with the
parsed arguments in hand:

```ts
const bash = createTool({
  name: "bash",
  description: "Run a shell command",
  schema: z.object({ command: z.string() }),
  // Ask before anything destructive; let the rest run.
  needsApproval: (args) => /^\s*(rm|shutdown|mkfs)\b/.test(args.command),
  approvalPrompt: (args) => `Run \`${args.command}\`?`,
  async func({ command }) {
    return exec(command);
  },
});
```

The predicate runs immediately before the call would execute, so it sees the same
arguments the tool would receive.

Three rules worth knowing:

- **A predicate that throws counts as `true`.** A gate that cannot reach a
  decision has not granted anything, and the cost is asymmetric — an unnecessary
  prompt is an annoyance, a skipped one is an unreviewed action.
- **A predicate-bearing tool never runs in parallel.** The parallel/sequential
  split happens before arguments are parsed, so any tool that decides per call is
  placed in the sequential group and its verdict is reached once, where the pause
  can actually stop the turn.
- **Tracing records `approval.conditional: true`** instead of `approval.required`,
  because there is no static answer to record. The verdict for each call lives on
  that call's `pendingApprovals` entry.

`approvalPrompt` takes the same treatment: as a function it receives the
arguments, so the question quotes what is actually about to happen rather than
describing the tool in general. If it throws, the pause still happens — only the
wording is lost.

Both forms are fully backward compatible: `needsApproval: true | false` and a
plain `approvalPrompt` string behave exactly as before.

## Inspecting `pendingApprovals`

Each entry contains all the data you need to render a review form:

```ts
{
  id: "approve_deploy_1",
  createdAt: "2025-10-08T11:24:33.120Z",
  toolName: "deploy_service",
  toolCallId: "call_abc",
  args: { version: "1.4.2" },
  metadata: {
    prompt: "Send build 1.4.2 to prod?",
    defaults: { channel: "ops", priority: "high" }
  }
}
```

You can serialize the whole state (using `agent.snapshot`) and surface the approval queue in your app or dashboard.

## Resolving an approval

Call `agent.resolveToolApproval` with the original state and the decision:

```ts
const decision = await agent.resolveToolApproval(state, {
  id: pending.id,
  approved: true,
  decidedBy: "on-call",
  comment: "Go for it",
  approvedArgs: { ...pending.args, dryRun: false },
});

const resumed = await agent.invoke(decision);
```

- `approved: true` – the tool executes immediately on the next turn.
- `approved: false` – the tool is skipped; the agent receives a rejection message.
- `approvedArgs` (optional) – override arguments before execution.

## Coordinating with `onStateChange`

Pair approvals with `onStateChange` checkpoints to pause at the right moment:

```ts
const result = await agent.invoke(state, {
  onStateChange(current) {
    if (current.ctx?.__awaitingApproval) return true; // capture snapshot
    return false;
  },
  checkpointReason: "awaiting-human-approval",
});
```

This ensures the run returns immediately after the approval is queued, letting you persist the checkpoint and resume once a reviewer acts.

## Event stream integration

Approvals emit structured events you can feed into telemetry pipelines:

- `status: "pending"` – tool call is waiting for review.
- `status: "approved"` – reviewer green-lit the call.
- `status: "rejected"` – reviewer blocked the call.

Inside the event payload you’ll find `toolName`, `toolCallId`, and the `id` you need to resolve the approval later.

## Recommended UX flow

1. **Detect pause** – `onStateChange` or direct state inspection shows `ctx.__awaitingApproval`.
2. **Display review card** – render `toolName`, arguments, prompt, and metadata.
3. **Collect decision** – allow reviewers to tweak arguments or annotate decisions.
4. **Resolve + resume** – call `resolveToolApproval`; optionally re-run with `agent.resume` if you persisted a snapshot.

> Need a full working example? Check `examples/tool-approval/tool-approval.ts` for end-to-end wiring.

For deeper internals, see the [Tool Development](../tool-development/) guide. To combine approvals with checkpoints and resumable runs, continue with [State Management](../state-management/).
