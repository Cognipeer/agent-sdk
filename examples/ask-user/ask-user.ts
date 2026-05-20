import { createAgent } from "@cognipeer/agent-sdk";

// Fake model: turn 1 asks the user, turn 2 produces the final answer using
// whatever the user picked.
let turn = 0;
const fakeModel = {
  bindTools() {
    return this;
  },
  async invoke(messages: any[]) {
    turn += 1;
    if (turn === 1) {
      return {
        role: "assistant",
        content: "",
        tool_calls: [
          {
            id: "call_ask_1",
            type: "function",
            function: {
              name: "ask_user_question",
              arguments: JSON.stringify({
                questions: [
                  {
                    question: "Which deployment target should I use?",
                    header: "Target",
                    options: [
                      { label: "Vercel", description: "Hobby tier is free" },
                      { label: "Fly.io", description: "Run closer to your DB" },
                      { label: "AWS Lambda", description: "Pay-per-request" },
                    ],
                  },
                  {
                    question: "Pin a specific region?",
                    header: "Region",
                    options: [
                      { label: "Auto" },
                      { label: "us-east-1" },
                      { label: "eu-west-1" },
                    ],
                  },
                ],
              }),
            },
          },
        ],
      };
    }

    const lastToolMessage = [...messages].reverse().find((m) => m.role === "tool");
    const payload = lastToolMessage ? JSON.parse(lastToolMessage.content) : { answers: [] };
    const summary = payload.answers
      .map((a: any) => `${a.question} → ${a.values.join(", ") || a.freeText || "(no answer)"}`)
      .join("; ");
    return {
      role: "assistant",
      content: `Locked in your choices: ${summary}.`,
    };
  },
};

const agent = createAgent({
  name: "DeployHelper",
  model: fakeModel as any,
  humanInTheLoop: {
    askUser: {
      // Set to false to disable the "Other" / free-text path entirely.
      allowFreeText: true,
      onQuestion: (event) => {
        if (event.status === "pending") {
          console.log("\nAgent is asking the user:");
          for (const q of event.questions ?? []) {
            console.log(` - ${q.question}`);
            for (const opt of q.options ?? []) {
              console.log(`     • ${opt.label}${opt.description ? `  — ${opt.description}` : ""}`);
            }
          }
        }
      },
    },
  },
});

const first = await agent.invoke({
  messages: [{ role: "user", content: "Deploy the marketing site." }],
});

const pending = first.state?.pendingUserQuestions?.[0];
if (!pending) {
  console.log("No question asked. Final answer:", first.content);
  process.exit(0);
}

// In a real app the host would render a form and capture the user's choices.
// Here we simulate the response: pick Fly.io + auto region.
const resolved = agent.resolveUserQuestion(first.state!, {
  id: pending.id,
  answeredBy: "demo-user",
  answers: {
    "Which deployment target should I use?": { values: ["Fly.io"] },
    "Pin a specific region?": { values: ["Auto"] },
  },
});

const second = await agent.invoke(resolved);

console.log("\nFinal assistant reply:", second.content);
console.log("\nQuestion log:", second.state?.pendingUserQuestions);
