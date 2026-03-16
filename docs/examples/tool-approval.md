# Tool Approval

This example shows how the runtime pauses before a risky action, records the pending approval, and continues only after a decision is applied.

<div class="example-meta"><a class="example-source-link" href="https://github.com/Cognipeer/agent-sdk/blob/main/examples/tool-approval/tool-approval.ts" target="_blank" rel="noreferrer">Open source: examples/tool-approval/tool-approval.ts</a></div>

## Use this when

- tools can mutate state or call sensitive systems
- a human or policy service must approve execution first
- you need approval to live inside runtime state instead of prompt text

## What it shows

- tools marked with `needsApproval: true`
- a pending approval state inside the runtime
- `resolveToolApproval(...)` to continue safely

## Run it

```bash
cd examples
npm run example:tool-approval
```

## Core code

```ts
const writeFile = createTool({
	name: "dangerous_write",
	description: "Pretend to write content to disk. Requires human approval before executing.",
	schema: z.object({ path: z.string().min(1), content: z.string().min(1) }),
	needsApproval: true,
	approvalPrompt: "Confirm that the agent is allowed to write the supplied content to the given path.",
	func: async ({ path, content }) => ({ ok: true, path, bytesWritten: Buffer.byteLength(content) }),
});

const first = await agent.invoke({ messages: [{ role: "user", content: "Please write the release notes to disk." }] });
const approvedState = agent.resolveToolApproval(first.state, {
	id: pending.id,
	approved: true,
	decidedBy: "team-lead",
	comment: "Looks safe to write.",
});
```

## End-to-end flow

1. The model requests a call to `dangerous_write`.
2. The runtime stops before execution because the tool requires approval.
3. The pending approval is stored in state.
4. External code resolves the approval decision.
5. The agent continues from the same state and finishes the run.

## Why it matters

Approval gates keep powerful tools inside the normal agent loop instead of pushing safety checks into brittle prompt text.

## Look for

- the approval prompt on the tool definition
- the paused state before execution
- the approval resolution step that resumes the run

## Production takeaway

This pattern is stronger than asking the model to "be careful". Approval becomes enforceable state, not a suggestion.

## Expected output

- the first run pauses and prints the pending approval information
- the resumed run prints a final success message after approval is resolved
- approval history remains visible in runtime state

## Common failure modes

- the tool is not marked with `needsApproval: true`, so the runtime never pauses
- the code tries to resolve approval before checking that a pending approval exists
