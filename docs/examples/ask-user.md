# Ask User

This example shows how the runtime pauses when the model needs information from the user, surfaces a structured prompt, and resumes after the host injects an answer back into the conversation.

<div class="example-meta"><a class="example-source-link" href="https://github.com/Cognipeer/agent-sdk/blob/main/examples/ask-user/ask-user.ts" target="_blank" rel="noreferrer">Open source: examples/ask-user/ask-user.ts</a></div>

## Use this when

- the model genuinely needs a decision from the user (target, region, plan, persona)
- you want a structured multi-choice prompt instead of free-form back-and-forth
- the answer should land in runtime state, not in prompt text the model has to remember

## What it shows

- enabling the built-in `ask_user_question` tool via `humanInTheLoop.askUser`
- a pending question recorded on `state.pendingUserQuestions`
- `resolveUserQuestion(...)` injecting the answer as a tool result so the model can finish the run

## Run it

```bash
cd examples
npm run example:ask-user
```

## Core code

```ts
const agent = createAgent({
  model: fakeModel,
  humanInTheLoop: {
    askUser: {
      allowFreeText: true,
      onQuestion: (event) => console.log("Asking:", event.questions),
    },
  },
});

const first = await agent.invoke({
  messages: [{ role: "user", content: "Deploy the marketing site." }],
});

const pending = first.state!.pendingUserQuestions![0];

const resolved = agent.resolveUserQuestion(first.state!, {
  id: pending.id,
  answeredBy: "demo-user",
  answers: {
    "Which deployment target should I use?": { values: ["Fly.io"] },
    "Pin a specific region?": { values: ["Auto"] },
  },
});

const second = await agent.invoke(resolved);
```

## End-to-end flow

1. The model calls `ask_user_question` with one or more questions and options.
2. The runtime pauses, sets `ctx.__awaitingUserQuestion`, and appends a `pendingUserQuestions` entry.
3. Your app reads `state.pendingUserQuestions`, renders the form, and collects an answer set.
4. `agent.resolveUserQuestion(state, { id, answers })` validates the answer and appends it as a `role: "tool"` message bound to the original `tool_call_id`.
5. `agent.invoke(resolved)` resumes — the model sees the answer as a normal tool result and produces the final response.

## Why it matters

The model can stop guessing when the user holds the missing fact. By making the question part of runtime state (not a chat reply), you get a deterministic UI contract, easy snapshotting, and a structured trace event for telemetry.

## Look for

- the `humanInTheLoop.askUser` block on `createAgent`
- the paused state with `pendingUserQuestions` and `ctx.__awaitingUserQuestion`
- the `user_question` events emitted through `onEvent` and `onQuestion`
- the appended `role: "tool"` message after `resolveUserQuestion`

## Production takeaway

`allowFreeText` is decided at agent construction time so every question and every UI form is rendered against the same contract. Flip it to `false` to enforce strict multi-choice; the model is told free-text is unavailable and the resolver rejects custom answers.

## Expected output

- the agent prints the pending questions before asking the user
- after `resolveUserQuestion`, the final assistant message reflects the choices
- `state.pendingUserQuestions[0].status` flips from `"pending"` to `"answered"` with `answeredAt` and `answeredBy` filled in

## Common failure modes

- forgetting `humanInTheLoop.askUser` on the agent — the tool is never injected, so the model can't ask
- sending answers keyed by something other than the original `question` text (or the `header`) — the resolver throws `Missing answer for required question`
- supplying `freeText` while running with `allowFreeText: false` — the resolver rejects with a clear error
- calling `agent.invoke` without first calling `resolveUserQuestion` — the run resumes with the same pending question still blocking the next turn
