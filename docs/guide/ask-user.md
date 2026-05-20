
# Ask the User (Structured Human-in-the-Loop)

Some agent runs hit a fork that the model cannot resolve alone — pick a deployment target, confirm a destructive action, choose between two API designs. Instead of guessing or printing a vague "what should I do?" message, the agent can pause and surface a structured prompt to your application. The host renders the question, collects the answer, and resumes the agent with that answer wired in as a normal tool result.

This is different from [Tool Approvals](./tool-approvals): approvals ask "may I run *this specific tool*?"; ask-user asks "I need *information* from you before I can pick a tool at all."

## Enabling ask-user

Ask-user is opt-in. Turn it on per agent and the SDK injects a built-in `ask_user_question` tool the model can call:

```ts
import { createAgent } from "@cognipeer/agent-sdk";

const agent = createAgent({
  model,
  humanInTheLoop: {
    askUser: true, // shorthand for { allowFreeText: true }
  },
});
```

Or with the full options object:

```ts
const agent = createAgent({
  model,
  humanInTheLoop: {
    askUser: {
      // Globally allow / disallow the "Other" free-text path.
      // When false, every question must include >= 2 `options`.
      allowFreeText: true,
      // Optional: replace the tool description sent to the model.
      promptOverride: "Only call this when blocked on missing information.",
      // Optional convenience hook — fires on every user_question event
      // without needing to subscribe through onEvent.
      onQuestion: (event) => {
        renderQuestionsInUI(event.questions);
      },
    },
  },
});
```

When ask-user is **not** enabled, the tool is never registered and the model has no way to call it.

::: tip Why a global flag for free-text?
"Other" / free-text changes the contract of *every* question — both what the model is told it can do, and how the UI renders the form. Mixing per-question free-text with strict-options ones makes both prompts and forms inconsistent. The decision belongs at agent-construction time.
:::

## What the model sends

When the model needs information, it emits a single `ask_user_question` call carrying 1–4 related questions:

```json
{
  "questions": [
    {
      "question": "Which framework should we scaffold with?",
      "header": "Framework",
      "options": [
        { "label": "React" },
        { "label": "Vue" },
        { "label": "Svelte", "description": "Smallest bundle" }
      ]
    },
    {
      "question": "Pick the package manager",
      "header": "PM",
      "multiSelect": false,
      "options": [{ "label": "pnpm" }, { "label": "npm" }, { "label": "yarn" }]
    }
  ]
}
```

Question shape:

- `question` — full prompt shown to the user.
- `header` — short chip / tag (≤ ~12 chars recommended).
- `options` — `{ label, value?, description?, preview? }[]`. Required when free-text is disabled.
- `multiSelect` — allow more than one selection. Default `false`.
- `placeholder` — placeholder for the free-text input when enabled.
- `required` — default `true`.

## Inspecting `pendingUserQuestions`

The runtime pauses, sets `ctx.__awaitingUserQuestion`, and pushes an entry onto `state.pendingUserQuestions`:

```ts
{
  id: "uq_abc123",
  toolCallId: "call_q1",
  toolName: "ask_user_question",
  status: "pending",
  requestedAt: "2026-05-20T19:50:35.662Z",
  allowFreeText: true,
  questions: [/* the items above */]
}
```

This object is everything your UI needs to render the prompt. You can snapshot the whole state (`agent.snapshot(state)`) and surface the queue from another process.

## Resolving an answer

Once the user submits, call `agent.resolveUserQuestion` and re-invoke:

```ts
const pending = first.state!.pendingUserQuestions![0];

const resolved = agent.resolveUserQuestion(first.state!, {
  id: pending.id,
  answeredBy: "alex@team",
  answers: {
    "Which framework should we scaffold with?": { values: ["Svelte"] },
    "Pick the package manager": { values: ["pnpm"] },
  },
});

const second = await agent.invoke(resolved);
```

The resolver appends a `role: "tool"` message bound to the original `tool_call_id`, so the model sees the answer as a normal tool result on the next turn.

### Answer shape

```ts
type UserQuestionAnswer = {
  values: string[];      // selected option values; single-select = one entry
  freeText?: string;     // only valid when allowFreeText is true
  notes?: string;        // optional reviewer note
};

type UserQuestionAnswerSet = Record<string /* question text */, UserQuestionAnswer>;
```

The resolver validates:

- every required question is answered
- single-select questions receive exactly one value
- option values match the provided list (unless `allowFreeText` is enabled, in which case unknown values are treated as a custom answer)
- `freeText` is rejected when `allowFreeText: false`

### Cancellation

If the user dismisses the prompt:

```ts
const resolved = agent.resolveUserQuestion(first.state!, {
  id: pending.id,
  cancelled: true,
  notes: "User closed the modal",
});
```

The tool message carries `{ status: "cancelled", message }` so the model can react gracefully instead of looping back on `ask_user_question` again.

## Event stream

Subscribe through `invoke({ onEvent })` or the `humanInTheLoop.askUser.onQuestion` shortcut to receive `user_question` events:

```ts
type UserQuestionEvent = {
  type: "user_question";
  status: "pending" | "answered" | "cancelled";
  id: string;
  toolCallId: string;
  questions?: UserQuestionItem[];
  answers?: UserQuestionAnswerSet;
  answeredBy?: string;
  allowFreeText?: boolean;
};
```

The `pending` event fires the moment the tool is invoked; subsequent `answered` / `cancelled` notifications are something you emit from your application after a resolution so downstream telemetry stays in sync.

## Pairing with checkpoints

`onStateChange` checkpoints work with ask-user just like they do with approvals:

```ts
const result = await agent.invoke(state, {
  onStateChange(current) {
    return Boolean(current.ctx?.__awaitingUserQuestion);
  },
  checkpointReason: "awaiting-user-answer",
});
```

This returns immediately after the question is queued so you can persist a snapshot and let the host process resume the run when the answer arrives.

## Recommended UX flow

1. **Detect pause** — `ctx.__awaitingUserQuestion` is set, or you receive a `user_question` event with `status: "pending"`.
2. **Render the form** — drive it directly off `pendingUserQuestions[i].questions`. `header` becomes the chip, `options[].description` and `options[].preview` round out the layout.
3. **Collect the answer** — build a `UserQuestionAnswerSet` keyed by `question`.
4. **Resolve and resume** — call `resolveUserQuestion`, then `agent.invoke(resolved)`.

## When NOT to use ask-user

- For information you can derive from the conversation, the system prompt, or another tool result.
- As a fallback when the model is unsure — instructions belong in the system prompt and guardrails belong in [Guardrails](./guardrails).
- To replace [Tool Approvals](./tool-approvals) for "may I run X?" decisions — those are a different control surface.

> See `examples/ask-user/ask-user.ts` for an end-to-end runnable demo with a scripted model.
