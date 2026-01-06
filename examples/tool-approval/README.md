# Tool Approval Example

Shows how to flag a tool with `needsApproval`, inspect the pending approval queue, record a human decision, and continue the agent run once approval is granted.

## Scenario

1. The assistant requests to execute `dangerous_write`.
2. Because the tool requires approval, the run stops and returns `pendingApprovals` metadata.
3. A human (our script) approves the request via `agent.resolveToolApproval`.
4. We immediately pass the updated state back into `agent.invoke`, the tool executes, and the assistant replies with the final answer.

## Run

From the `examples/` directory:

```bash
npm run example:tool-approval
```

Or directly:
```bash
npx tsx tool-approval/tool-approval.ts
```

To simulate a rejection, change the approval payload to `{ approved: false, comment: "Rejected" }` and observe the agent receive the rejection message on its next turn.
