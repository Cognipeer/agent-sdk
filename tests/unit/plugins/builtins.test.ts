/**
 * Built-in plugins: piiRedaction, toolPolicy/pathSandbox, budgetGuard, the
 * guardrail transport stack (normalizeVerdicts / httpGuardrail /
 * createGuardrailPlugin / cognipeerGuardrail / portkeyGuardrail) and the stores.
 *
 * Everything that is a plugin is driven through a real `createPluginHost` run
 * handle rather than by calling the hook function directly: the composition
 * rules (escalation, per-run store lifetime, fail-closed) are what make these
 * plugins behave the way their docs claim, so bypassing the host would test a
 * different program than the one that ships.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  budgetGuard,
  conversationHistory,
  createGuardrailPlugin,
  createPluginHost,
  customGuardrail,
  cognipeerGuardrail,
  defineHook,
  httpGuardrail,
  inMemoryConversationStore,
  isValidIban,
  isValidLuhn,
  isValidTckn,
  normalizeVerdicts,
  pathSandbox,
  piiRedaction,
  portkeyGuardrail,
  redactText,
  toolPolicy,
} from "../../../src/plugins/index.js";
import type {
  AgentPlugin,
  GuardrailRequest,
  GuardrailVerdict,
  PluginLogger,
  PluginRunHost,
} from "../../../src/plugins/index.js";
import type { Message, SmartAgentEvent, SmartState } from "../../../src/types.js";

afterEach(() => {
  vi.restoreAllMocks();
  // `restoreAllMocks` does not undo `stubGlobal`, and the whole suite shares one
  // process — a leaked `fetch` would poison every later file.
  vi.unstubAllGlobals();
});

// ─── Harness ─────────────────────────────────────────────────────────────────

const silentLogger: PluginLogger = { debug: () => {}, warn: () => {}, error: () => {} };

type Harness = {
  host: ReturnType<typeof createPluginHost>;
  run: PluginRunHost;
  events: SmartAgentEvent[];
  /** Open a second run over the same host — what a resume looks like to a plugin. */
  restart: () => PluginRunHost;
};

function harness(plugins: AgentPlugin[], state: Partial<SmartState> = {}): Harness {
  const events: SmartAgentEvent[] = [];
  const host = createPluginHost(plugins, { logger: silentLogger });
  const getState = () => ({ messages: [], ...state }) as SmartState;
  const begin = (runId: string) =>
    host.beginRun({ runId, agentName: "test-agent", getState, emit: (event) => events.push(event) });
  let current = begin("run-1");
  return {
    host,
    get run() {
      return current;
    },
    events,
    restart: () => {
      current.end();
      current = begin("run-2");
      return current;
    },
  } as Harness;
}

const userMessage = (text: string): Message => ({ role: "user", content: text });

const toolInput = (toolName: string, args: unknown) => ({
  toolName,
  toolCallId: "call_1",
  args,
  tool: { name: toolName } as never,
  executionCount: 0,
});

const modelInput = () => ({ messages: [], tools: [], params: {}, model: null, iteration: 1 });

const metadataEvents = (events: SmartAgentEvent[]): Array<Record<string, unknown>> =>
  events.filter((event) => (event as { type?: string }).type === "metadata") as never;

/** Restore env exactly, so no global survives the test. */
function withoutEnv(keys: string[], fn: () => void): void {
  const saved = new Map<string, string | undefined>();
  for (const key of keys) {
    saved.set(key, process.env[key]);
    delete process.env[key];
  }
  try {
    fn();
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

// ─── piiRedaction: validators ────────────────────────────────────────────────

/**
 * Builds a checksummed TCKN from its first nine digits using the documented
 * algorithm, so the test never carries a real person's identifier:
 *   d10 = (7 * (d1+d3+d5+d7+d9) - (d2+d4+d6+d8)) mod 10
 *   d11 = (d1..d10) mod 10
 */
function makeTckn(firstNine: string): string {
  const d = firstNine.split("").map(Number);
  const oddSum = d[0] + d[2] + d[4] + d[6] + d[8];
  const evenSum = d[1] + d[3] + d[5] + d[7];
  const tenth = (((oddSum * 7 - evenSum) % 10) + 10) % 10;
  const eleventh = (d.reduce((total, digit) => total + digit, 0) + tenth) % 10;
  return `${firstNine}${tenth}${eleventh}`;
}

const VALID_TCKN = makeTckn("123456789"); // -> 12345678950
const VALID_IBAN = "TR330006100519786457841326";

describe("piiRedaction validators", () => {
  it("isValidTckn accepts a checksummed id and rejects arbitrary 11-digit numbers", () => {
    expect(VALID_TCKN).toBe("12345678950");
    expect(isValidTckn(VALID_TCKN)).toBe(true);
    expect(isValidTckn(makeTckn("987654321"))).toBe(true);

    // Same length, same leading digit, wrong checksum digits.
    expect(isValidTckn("12345678901")).toBe(false);
    expect(isValidTckn("12345678951")).toBe(false);
    // Structural rules.
    expect(isValidTckn("01234567890")).toBe(false); // leading zero
    expect(isValidTckn("1234567895")).toBe(false); // 10 digits
    expect(isValidTckn("123456789500")).toBe(false); // 12 digits
    expect(isValidTckn("")).toBe(false);
  });

  it("isValidTckn accepts a valid id whose 10th-digit checksum needs a non-negative modulo", () => {
    // 7 * oddSum < evenSum here, so the checksum only comes out right under a
    // floored modulo: 7 * 1 - 36 = -29, and -29 mod 10 = 1 = d10.
    expect(makeTckn("190909090")).toBe("19090909018");
    expect(isValidTckn("19090909018")).toBe(true);
  });

  it("isValidLuhn accepts real card checksums and enforces the length window", () => {
    expect(isValidLuhn("4111111111111111")).toBe(true);
    expect(isValidLuhn("4539578763621486")).toBe(true);
    expect(isValidLuhn("4111 1111 1111 1111")).toBe(true); // separators stripped

    expect(isValidLuhn("4111111111111112")).toBe(false); // checksum off by one
    expect(isValidLuhn("79927398713")).toBe(false); // Luhn-valid but only 11 digits
    expect(isValidLuhn("41111111111111111111")).toBe(false); // 20 digits
  });

  it("isValidIban applies the mod-97 check", () => {
    expect(isValidIban(VALID_IBAN)).toBe(true);
    expect(isValidIban("GB82 WEST 1234 5698 7654 32")).toBe(true); // spaced
    expect(isValidIban("gb82-west-1234-5698-7654-32")).toBe(true); // lowercase + dashes

    expect(isValidIban("GB82WEST12345698765433")).toBe(false); // last digit changed
    expect(isValidIban("TR340006100519786457841326")).toBe(false); // check digits changed
    expect(isValidIban("GB82WEST123")).toBe(false); // too short for the shape
    expect(isValidIban("1234WEST12345698765432")).toBe(false); // no country code
  });
});

// ─── piiRedaction: redactText ────────────────────────────────────────────────

const defaultMask = (entity: string, _match: string) => `[REDACTED:${entity}]`;

/**
 * `BUILTIN_DETECTORS` is module-private, so `redactText` is exercised with the
 * documented patterns wired to the exported (real) validators. The same sample
 * is then pushed through the plugin, which uses the shipped detector list — if
 * the two ever diverge, the plugin assertion is the one that fails.
 */
function builtinLikeDetectors() {
  return [
    { entity: "TCKN", pattern: /\b[1-9]\d{10}\b/g, validate: isValidTckn },
    {
      entity: "IBAN",
      pattern: /\b[A-Z]{2}\d{2}[\s-]?(?:[A-Z0-9][\s-]?){11,30}\b/g,
      validate: isValidIban,
    },
    { entity: "EMAIL", pattern: /\b[\w.%+-]+@[\w.-]+\.[A-Za-z]{2,}\b/g },
    { entity: "CREDIT_CARD", pattern: /\b(?:\d[ -]?){13,19}\b/g, validate: isValidLuhn },
  ];
}

describe("redactText", () => {
  const sample = [
    `Customer ali.veli@example.com placed order 12345678901.`,
    `Refund to IBAN ${VALID_IBAN}.`,
    `National id ${VALID_TCKN} on file.`,
  ].join(" ");

  it("masks EMAIL / IBAN / TCKN and leaves an unchecksummed 11-digit order number alone", () => {
    const result = redactText(sample, builtinLikeDetectors(), defaultMask);

    expect(result.text).toContain("[REDACTED:EMAIL]");
    expect(result.text).toContain("[REDACTED:IBAN]");
    expect(result.text).toContain("[REDACTED:TCKN]");
    expect(result.text).not.toContain("ali.veli@example.com");
    expect(result.text).not.toContain(VALID_IBAN);
    expect(result.text).not.toContain(VALID_TCKN);

    // The whole point of the checksum stage: a plain order number is not PII.
    expect(result.text).toContain("order 12345678901");

    const byEntity = Object.fromEntries(result.findings.map((f) => [f.entity, f.count]));
    expect(byEntity).toEqual({ TCKN: 1, IBAN: 1, EMAIL: 1 });
  });

  it("the shipped detector set behaves the same through the plugin", async () => {
    const { run } = harness([piiRedaction({ apply: ["input"] })]);
    const gate = await run.runGate("userPromptSubmit", { text: sample, message: userMessage(sample) });

    const text = gate.input.text;
    expect(text).toContain("[REDACTED:EMAIL]");
    expect(text).toContain("[REDACTED:IBAN]");
    expect(text).toContain("[REDACTED:TCKN]");
    expect(text).toContain("order 12345678901");
  });

  it("keepLast leaves the requested number of trailing characters visible", async () => {
    const { run } = harness([piiRedaction({ keepLast: 4, apply: ["input"] })]);
    const gate = await run.runGate("userPromptSubmit", {
      text: `id ${VALID_TCKN} iban ${VALID_IBAN}`,
      message: userMessage("x"),
    });

    expect(gate.input.text).toContain("[REDACTED:TCKN:…8950]");
    expect(gate.input.text).toContain("[REDACTED:IBAN:…1326]");
  });

  it("a detector's global regex has no lastIndex leakage across two calls", () => {
    const detector = { entity: "TICKET", pattern: /TCK-\d{4}/g };
    const text = "TCK-1111 and TCK-2222";

    const first = redactText(text, [detector], defaultMask);
    expect(first.text).toBe("[REDACTED:TICKET] and [REDACTED:TICKET]");
    expect(first.findings).toEqual([{ entity: "TICKET", count: 2 }]);

    // Poison the shared object: if redactText used it directly, `String#replace`
    // would reset this to 0 and a `test()`-style detector would skip matches.
    detector.pattern.lastIndex = 7;
    const second = redactText(text, [detector], defaultMask);

    expect(second.text).toBe(first.text);
    expect(second.findings).toEqual(first.findings);
    expect(detector.pattern.lastIndex).toBe(7); // untouched -> a fresh instance was used
  });

  it("forces the `g` flag on, so a caller's non-global detector still masks every match", () => {
    const result = redactText("TCK-1111 and TCK-2222", [{ entity: "TICKET", pattern: /TCK-\d{4}/ }], defaultMask);

    expect(result.text).toBe("[REDACTED:TICKET] and [REDACTED:TICKET]");
    expect(result.findings).toEqual([{ entity: "TICKET", count: 2 }]);
  });

  it("returns the input untouched when there is nothing to redact", () => {
    const result = redactText("", [{ entity: "X", pattern: /x/g }], defaultMask);
    expect(result).toEqual({ text: "", findings: [] });
    expect(redactText("nothing here", [{ entity: "X", pattern: /zzz/g }], defaultMask).findings).toEqual([]);
  });
});

describe("piiRedaction plugin", () => {
  it("rewrites the user turn, the final answer and tool output, and announces findings", async () => {
    const { run, events } = harness([piiRedaction()]);

    const prompt = await run.runGate("userPromptSubmit", {
      text: `mail me at ali@example.com`,
      message: userMessage("mail me at ali@example.com"),
    });
    expect(prompt.decision).toBe("allow"); // this plugin rewrites, it never blocks
    expect(prompt.mutated).toBe(true);
    expect(prompt.input.text).toBe("mail me at [REDACTED:EMAIL]");

    const toolGate = await run.runGate("postToolUse", {
      toolName: "lookup",
      toolCallId: "call_1",
      args: {},
      output: { note: `write to ops@example.com`, ok: true },
      durationMs: 3,
      executionId: "exec_1",
    });
    // A JSON payload is redacted and handed back as an object, not a string.
    expect(toolGate.input.output).toEqual({ note: "write to [REDACTED:EMAIL]", ok: true });

    const finalGate = await run.runGate("preFinalAnswer", { content: `contact ali@example.com` });
    expect(finalGate.input.content).toBe("contact [REDACTED:EMAIL]");

    const announced = metadataEvents(events).filter((event) => event.piiRedaction);
    expect(announced).toHaveLength(3);
    expect(announced.map((event) => (event.piiRedaction as { where: string }).where)).toEqual([
      "input",
      "tool:lookup",
      "finalAnswer",
    ]);
  });

  it("leaves surfaces outside `apply` untouched", async () => {
    const { run } = harness([piiRedaction()]); // default apply: input, toolOutput, finalAnswer
    const gate = await run.runGate("postModelCall", {
      message: { role: "assistant", content: "reply to ali@example.com" } as never,
      durationMs: 1,
      iteration: 1,
      shortCircuited: false,
    });
    expect(gate.mutated).toBe(false);
    expect((gate.input.message as { content: string }).content).toBe("reply to ali@example.com");
  });
});

// ─── toolPolicy ──────────────────────────────────────────────────────────────

describe("toolPolicy", () => {
  it("denies tools on the deny list", async () => {
    const { run } = harness([toolPolicy({ deny: ["shell", /^danger_/] })]);

    const denied = await run.runGate("preToolUse", toolInput("shell", { cmd: "rm -rf /" }));
    expect(denied.decision).toBe("deny");
    expect(denied.deniedBy).toBe("tool-policy");
    expect(denied.reason).toContain('Tool "shell" is blocked by policy.');

    expect((await run.runGate("preToolUse", toolInput("danger_wipe", {}))).decision).toBe("deny");
    expect((await run.runGate("preToolUse", toolInput("echo", {}))).decision).toBe("allow");
  });

  it("escalates tools on the ask list to human approval", async () => {
    const { run } = harness([toolPolicy({ ask: ["deploy"] })]);
    const gate = await run.runGate("preToolUse", toolInput("deploy", { env: "prod" }));

    expect(gate.decision).toBe("ask");
    expect(gate.deniedBy).toBeUndefined();
    expect((gate as unknown as { approvalPrompt?: string }).approvalPrompt).toContain('Approve "deploy"?');
    expect((gate as unknown as { approvalPrompt?: string }).approvalPrompt).toContain('"env":"prod"');
  });

  it("allowOnly denies everything not named", async () => {
    const { run } = harness([toolPolicy({ allowOnly: ["echo", /^read_/] })]);

    expect((await run.runGate("preToolUse", toolInput("echo", {}))).decision).toBe("allow");
    expect((await run.runGate("preToolUse", toolInput("read_file", {}))).decision).toBe("allow");

    const gate = await run.runGate("preToolUse", toolInput("write_file", {}));
    expect(gate.decision).toBe("deny");
    expect(gate.reason).toContain("not on this agent's allow-list");
  });

  it("maxExecutionsPerTool caps a tool per run, as a flat number and per tool", async () => {
    const flat = harness([toolPolicy({ maxExecutionsPerTool: 2 })]);
    expect((await flat.run.runGate("preToolUse", toolInput("search", {}))).decision).toBe("allow");
    expect((await flat.run.runGate("preToolUse", toolInput("search", {}))).decision).toBe("allow");
    const third = await flat.run.runGate("preToolUse", toolInput("search", {}));
    expect(third.decision).toBe("deny");
    expect(third.reason).toContain('Per-run execution limit reached for "search" (2)');

    // The budget is per tool name, and per run: a new run starts clean.
    expect((await flat.run.runGate("preToolUse", toolInput("echo", {}))).decision).toBe("allow");
    const resumed = flat.restart();
    expect((await resumed.runGate("preToolUse", toolInput("search", {}))).decision).toBe("allow");

    const perTool = harness([toolPolicy({ maxExecutionsPerTool: { search: 1 } })]);
    expect((await perTool.run.runGate("preToolUse", toolInput("search", {}))).decision).toBe("allow");
    expect((await perTool.run.runGate("preToolUse", toolInput("search", {}))).decision).toBe("deny");
    // Tools without an entry are unlimited.
    for (let i = 0; i < 5; i += 1) {
      expect((await perTool.run.runGate("preToolUse", toolInput("echo", {}))).decision).toBe("allow");
    }
  });

  it("a rule's `when` predicate narrows it to matching arguments", async () => {
    const seen: Array<Record<string, unknown>> = [];
    const { run } = harness([
      toolPolicy({
        rules: [
          {
            tool: "sql",
            action: "deny",
            when: (args) => {
              seen.push(args);
              return typeof args.query === "string" && /drop\s+table/i.test(args.query);
            },
            reason: (args, toolName) => `${toolName} refuses: ${String(args.query)}`,
          },
        ],
      }),
    ]);

    const blocked = await run.runGate("preToolUse", toolInput("sql", { query: "DROP TABLE users" }));
    expect(blocked.decision).toBe("deny");
    expect(blocked.reason).toContain("sql refuses: DROP TABLE users");

    const allowed = await run.runGate("preToolUse", toolInput("sql", { query: "SELECT 1" }));
    expect(allowed.decision).toBe("allow");

    // The predicate saw the parsed arguments, and a non-object arg degrades to {}.
    expect(seen[0]).toEqual({ query: "DROP TABLE users" });
    await run.runGate("preToolUse", toolInput("sql", "not-an-object"));
    expect(seen[2]).toEqual({});
  });

  it('an explicit "allow" rule only stops rule evaluation — it grants nothing', async () => {
    const asker = defineHook(
      "preToolUse",
      () => ({ decision: "ask" as const, approvalPrompt: "human, please" }),
      { name: "asker", priority: 50 },
    );
    const policy = toolPolicy({
      rules: [
        { tool: "echo", action: "allow" },
        { tool: /.*/, action: "deny", reason: "catch-all" },
      ],
    });
    const { run } = harness([policy, asker]);

    // The allow rule stops the policy's own catch-all deny from firing…
    const gate = await run.runGate("preToolUse", toolInput("echo", {}));
    // …but cannot downgrade another plugin's escalation.
    expect(gate.decision).toBe("ask");
    expect((gate as unknown as { approvalPrompt?: string }).approvalPrompt).toBe("human, please");

    // Any other tool falls through to the catch-all, and deny ends the chain
    // before the asker runs.
    const other = await run.runGate("preToolUse", toolInput("calculator", {}));
    expect(other.decision).toBe("deny");
    expect(other.reason).toContain("catch-all");
    expect(other.deniedBy).toBe("tool-policy");
  });
});

// ─── pathSandbox ─────────────────────────────────────────────────────────────

describe("pathSandbox", () => {
  const sandbox = pathSandbox({ roots: ["/workspace/data/"] });

  it("rejects ../ traversal out of a root", async () => {
    const { run } = harness([sandbox]);
    const gate = await run.runGate(
      "preToolUse",
      toolInput("read_file", { path: "/workspace/data/../../etc/passwd" }),
    );
    expect(gate.decision).toBe("deny");
    expect(gate.deniedBy).toBe("path-sandbox");
    expect(gate.reason).toContain("outside the allowed roots (/workspace/data)");
  });

  it("rejects an absolute path outside the roots", async () => {
    const { run } = harness([sandbox]);
    expect((await run.runGate("preToolUse", toolInput("read_file", { path: "/etc/passwd" }))).decision).toBe(
      "deny",
    );
    // A sibling directory that merely shares a prefix is still outside.
    expect(
      (await run.runGate("preToolUse", toolInput("read_file", { path: "/workspace/data-secrets/x" })))
        .decision,
    ).toBe("deny");
    // Every documented path-carrying argument name is inspected.
    expect(
      (await run.runGate("preToolUse", toolInput("write_file", { file_path: "../outside.txt" }))).decision,
    ).toBe("deny");
  });

  it("accepts a path inside a root", async () => {
    const { run } = harness([sandbox]);
    const gate = await run.runGate("preToolUse", toolInput("read_file", { path: "/workspace/data/report.csv" }));
    expect(gate.decision).toBe("allow");
    expect(gate.mutated).toBe(false);

    // The root itself, and a normalized detour that stays inside, are fine.
    expect(
      (await run.runGate("preToolUse", toolInput("read_file", { path: "/workspace/data" }))).decision,
    ).toBe("allow");
    expect(
      (await run.runGate("preToolUse", toolInput("read_file", { path: "/workspace/data/a/../b.txt" })))
        .decision,
    ).toBe("allow");
    // Arguments that carry no path are ignored.
    expect((await run.runGate("preToolUse", toolInput("echo", { message: "/etc/passwd" }))).decision).toBe(
      "allow",
    );
  });

  it("only governs the tools it was scoped to", async () => {
    const scoped = pathSandbox({ roots: ["/workspace"], tools: ["read_file"], name: "scoped-sandbox" });
    const { run } = harness([scoped]);
    expect((await run.runGate("preToolUse", toolInput("read_file", { path: "/etc/passwd" }))).decision).toBe(
      "deny",
    );
    expect((await run.runGate("preToolUse", toolInput("other_tool", { path: "/etc/passwd" }))).decision).toBe(
      "allow",
    );
  });
});

// ─── budgetGuard ─────────────────────────────────────────────────────────────

function usageState(outputTokens: number, calls = 1): Partial<SmartState> {
  return {
    usage: {
      perRequest: Array.from({ length: calls }, (_, index) => ({
        id: `req_${index}`,
        modelName: "gpt-test",
        usage: { prompt_tokens: 100, completion_tokens: Math.round(outputTokens / calls) },
        timestamp: new Date(0).toISOString(),
        turn: index + 1,
      })),
      totals: {
        "gpt-test": { input: 100 * calls, output: outputTokens, total: 100 * calls + outputTokens, cachedInput: 0 },
      },
    },
  };
}

describe("budgetGuard", () => {
  it("reads spend from state.usage, so a resumed run is still over budget on its first model call", async () => {
    // The spend already happened in a previous (snapshotted) run: a plugin that
    // kept its own counter would start this run at zero and let it through.
    const { run, restart, events } = harness([budgetGuard({ maxOutputTokens: 1000 })], usageState(4200, 3));

    const first = await run.runGate("preModelCall", modelInput());
    expect(first.decision).toBe("deny");
    expect(first.reason).toContain("Output token ceiling exceeded: 4200 of 1000.");
    expect(first.deniedBy).toBe("budget-guard");

    const resumed = restart(); // fresh per-run plugin store, same state
    const afterResume = await resumed.runGate("preModelCall", modelInput());
    expect(afterResume.decision).toBe("deny");

    const exceeded = metadataEvents(events).filter((event) => event.budgetExceeded);
    expect(exceeded).toHaveLength(2);
    expect(exceeded[0].budgetExceeded).toMatchObject({ outputTokens: 4200, modelCalls: 3, enforced: true });
  });

  it("allows a run that is inside the ceilings and denies on cost with an estimator", async () => {
    const under = harness([budgetGuard({ maxOutputTokens: 1000 })], usageState(120));
    expect((await under.run.runGate("preModelCall", modelInput())).decision).toBe("allow");

    const costly = harness(
      [budgetGuard({ maxUsd: 0.5, costEstimator: ({ outputTokens }) => outputTokens * 0.001 })],
      usageState(900),
    );
    const gate = await costly.run.runGate("preModelCall", modelInput());
    expect(gate.decision).toBe("deny");
    expect(gate.reason).toContain("Cost ceiling exceeded: $0.9000 of $0.5.");

    // Without an estimator the USD ceiling is inert by design.
    const inert = harness([budgetGuard({ maxUsd: 0.5 })], usageState(900));
    expect((await inert.run.runGate("preModelCall", modelInput())).decision).toBe("allow");
  });

  it("warn mode only emits — it never denies", async () => {
    const { run, events } = harness(
      [budgetGuard({ maxOutputTokens: 100, onExceeded: "warn" })],
      usageState(5000),
    );

    const gate = await run.runGate("preModelCall", modelInput());
    expect(gate.decision).toBe("allow");
    expect(gate.deniedBy).toBeUndefined();

    const exceeded = metadataEvents(events).filter((event) => event.budgetExceeded);
    expect(exceeded).toHaveLength(1);
    expect(exceeded[0].budgetExceeded).toMatchObject({ enforced: false, outputTokens: 5000 });
  });

  it("emits the approaching-budget warning exactly once per run", async () => {
    const { run, events, restart } = harness([budgetGuard({ maxOutputTokens: 1000 })], usageState(900));

    await run.runGate("preModelCall", modelInput());
    await run.runGate("preModelCall", modelInput());
    const warnings = metadataEvents(events).filter((event) => event.budget);
    expect(warnings).toHaveLength(1);
    expect(warnings[0].budget).toMatchObject({ outputTokens: 900, usedFraction: 0.9 });

    // The "already warned" flag lives in the per-run store, so a new run warns again.
    const resumed = restart();
    await resumed.runGate("preModelCall", modelInput());
    expect(metadataEvents(events).filter((event) => event.budget)).toHaveLength(2);
  });

  it("summarises spend on sessionEnd without failing the run", async () => {
    const { run, events } = harness([budgetGuard({ maxOutputTokens: 10 })], usageState(50, 2));
    await run.runObservers("sessionEnd", { status: "success", durationMs: 12 });

    const summary = metadataEvents(events).find((event) => event.budgetSummary);
    expect(summary?.budgetSummary).toMatchObject({ outputTokens: 50, modelCalls: 2, status: "success" });
  });
});

// ─── guardrail: normalizeVerdicts ────────────────────────────────────────────

const requests = (count: number): GuardrailRequest[] =>
  Array.from({ length: count }, (_, index) => ({ phase: "input" as const, content: `content-${index}` }));

describe("normalizeVerdicts", () => {
  it("accepts a bare array and preserves request order", () => {
    const verdicts = normalizeVerdicts([{ action: "allow" }, { action: "block", reason: "nope" }], requests(2));
    expect(verdicts.map((v) => v.action)).toEqual(["allow", "block"]);
    expect(verdicts[1].message).toBe("nope");
  });

  it("accepts { results: [] } and { items: [] } envelopes", () => {
    expect(normalizeVerdicts({ results: [{ decision: "denied" }] }, requests(1))[0].action).toBe("block");
    expect(normalizeVerdicts({ items: [{ verdict: "pass" }] }, requests(1))[0].action).toBe("allow");
    expect(normalizeVerdicts({ verdicts: [{ status: "clean" }] }, requests(1))[0].action).toBe("allow");
    expect(normalizeVerdicts({ data: [{ result: "rejected" }] }, requests(1))[0].action).toBe("block");
  });

  it("accepts a single object for a single request", () => {
    const [verdict] = normalizeVerdicts({ action: "block", message: "policy hit" }, requests(1));
    expect(verdict.action).toBe("block");
    expect(verdict.message).toBe("policy hit");
    expect(verdict.raw).toEqual({ action: "block", message: "policy hit" });
  });

  it("understands boolean-shaped services", () => {
    expect(normalizeVerdicts({ blocked: true }, requests(1))[0].action).toBe("block");
    expect(normalizeVerdicts({ denied: true }, requests(1))[0].action).toBe("block");
    expect(normalizeVerdicts({ passed: false }, requests(1))[0].action).toBe("block");
    expect(normalizeVerdicts({ ok: false }, requests(1))[0].action).toBe("block");
    expect(normalizeVerdicts({ allowed: false }, requests(1))[0].action).toBe("block");
    expect(normalizeVerdicts({ flagged: true }, requests(1))[0].action).toBe("block");
    expect(normalizeVerdicts({ passed: true }, requests(1))[0].action).toBe("allow");

    const [flaggedWithMask] = normalizeVerdicts({ flagged: true, maskedContent: "***" }, requests(1));
    expect(flaggedWithMask).toMatchObject({ action: "mask", maskedContent: "***" });
  });

  it("degrades a mask verdict with no masked content to a block", () => {
    expect(normalizeVerdicts({ action: "mask" }, requests(1))[0].action).toBe("block");
    expect(normalizeVerdicts([{ action: "redact" }], requests(1))[0].action).toBe("block");
    expect(normalizeVerdicts([{ action: "mask", masked_content: "###" }], requests(1))).toMatchObject([
      { action: "mask", maskedContent: "###" },
    ]);
  });

  it("falls back to allow for missing, empty or unrecognised entries", () => {
    expect(normalizeVerdicts(null, requests(2)).map((v) => v.action)).toEqual(["allow", "allow"]);
    expect(normalizeVerdicts({ results: [] }, requests(1))[0].action).toBe("allow");
    expect(normalizeVerdicts("not json-ish", requests(1))[0].action).toBe("allow");
    expect(normalizeVerdicts({ something: "else" }, requests(1))[0].action).toBe("allow");
    // Two requests but a single-object body: nothing to map, so nothing is blocked.
    expect(normalizeVerdicts({ blocked: true }, requests(2)).map((v) => v.action)).toEqual([
      "allow",
      "allow",
    ]);
  });

  it("carries violations through under either field name", () => {
    const [a] = normalizeVerdicts([{ action: "block", violations: [{ type: "pii" }] }], requests(1));
    const [b] = normalizeVerdicts([{ action: "block", findings: [{ type: "toxicity" }] }], requests(1));
    expect(a.violations).toEqual([{ type: "pii" }]);
    expect(b.violations).toEqual([{ type: "toxicity" }]);
  });
});

// ─── guardrail: httpGuardrail ────────────────────────────────────────────────

const jsonResponse = (body: unknown, status = 200) => ({
  // `ok` follows the real Response rule (200-299), so a verdict-carrying 446
  // arrives as not-ok exactly the way fetch would deliver it.
  ok: status >= 200 && status < 300,
  status,
  statusText: status === 200 ? "OK" : "",
  json: async () => body,
  text: async () => JSON.stringify(body),
});

const errorResponse = (status: number, statusText = "", body = "") => ({
  ok: false,
  status,
  statusText,
  json: async () => ({}),
  text: async () => body,
});

type FetchCall = [string, { method?: string; headers?: Record<string, string>; body?: string }];

function stubFetch(impl: (url: string, init: FetchCall[1]) => Promise<unknown>) {
  const mock = vi.fn(impl);
  vi.stubGlobal("fetch", mock as unknown as typeof fetch);
  return mock;
}

const callCtx = { runId: "run-1", agentName: "test-agent", traceId: "trace-1" };

describe("httpGuardrail", () => {
  it("batches every pending check into one request by default", async () => {
    const fetchMock = stubFetch(async () =>
      jsonResponse({ results: [{ action: "allow" }, { action: "block", message: "bad tool args" }] }),
    );
    const transport = httpGuardrail({ url: "https://guard.example.com/evaluate" });

    const verdicts = await transport.evaluate(
      [
        { phase: "input", content: "hello" },
        { phase: "tool", content: '{"cmd":"rm"}', subject: "shell" },
      ],
      callCtx,
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://guard.example.com/evaluate");
    expect(init.method).toBe("POST");
    expect(init.headers?.["content-type"]).toBe("application/json");
    const body = JSON.parse(init.body!);
    expect(body).toMatchObject({ runId: "run-1", traceId: "trace-1", agentName: "test-agent" });
    expect(body.items).toHaveLength(2);
    expect(verdicts.map((v) => v.action)).toEqual(["allow", "block"]);
  });

  it("sends one request per check when batching is off", async () => {
    const fetchMock = stubFetch(async () => jsonResponse({ action: "allow" }));
    const transport = httpGuardrail({ url: "https://guard.example.com/evaluate", batch: false });

    const verdicts = await transport.evaluate(
      [
        { phase: "input", content: "a" },
        { phase: "output", content: "b" },
      ],
      callCtx,
    );

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(JSON.parse(fetchMock.mock.calls[0][1].body!).items).toHaveLength(1);
    expect(JSON.parse(fetchMock.mock.calls[1][1].body!).items[0].content).toBe("b");
    expect(verdicts).toHaveLength(2);
  });

  it("returns immediately for an empty request list", async () => {
    const fetchMock = stubFetch(async () => jsonResponse({}));
    const transport = httpGuardrail({ url: "https://guard.example.com/evaluate" });
    expect(await transport.evaluate([], callCtx)).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("retries a 503 once and then succeeds", async () => {
    let attempts = 0;
    const fetchMock = stubFetch(async () => {
      attempts += 1;
      return attempts === 1
        ? errorResponse(503, "Service Unavailable", "overloaded")
        : jsonResponse({ results: [{ action: "allow" }] });
    });
    const transport = httpGuardrail({ url: "https://guard.example.com/evaluate", retries: 1 });

    const verdicts = await transport.evaluate([{ phase: "input", content: "hi" }], callCtx);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(verdicts[0].action).toBe("allow");
  });

  it("does not retry a 400", async () => {
    const fetchMock = stubFetch(async () => errorResponse(400, "Bad Request", "malformed policy id"));
    const transport = httpGuardrail({ url: "https://guard.example.com/evaluate", retries: 2 });

    await expect(transport.evaluate([{ phase: "input", content: "hi" }], callCtx)).rejects.toThrow(
      /HTTP 400 Bad Request - malformed policy id/,
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("aborts a hanging call at timeoutMs instead of stalling the turn", async () => {
    const fetchMock = stubFetch(
      (_url, init) =>
        new Promise((_resolve, reject) => {
          (init as unknown as { signal: AbortSignal }).signal.addEventListener("abort", () =>
            reject(new Error("The operation was aborted.")),
          );
        }),
    );
    const transport = httpGuardrail({ url: "https://guard.example.com/evaluate", timeoutMs: 20, retries: 0 });

    await expect(transport.evaluate([{ phase: "input", content: "hi" }], callCtx)).rejects.toThrow(
      /network error - The operation was aborted\./,
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("forwards the run's own cancellation signal", async () => {
    const controller = new AbortController();
    const fetchMock = stubFetch(
      (_url, init) =>
        new Promise((_resolve, reject) => {
          (init as unknown as { signal: AbortSignal }).signal.addEventListener("abort", () =>
            reject(new Error("cancelled by caller")),
          );
        }),
    );
    const transport = httpGuardrail({ url: "https://guard.example.com/evaluate", retries: 0 });

    const pending = transport.evaluate([{ phase: "input", content: "hi" }], {
      ...callCtx,
      signal: controller.signal,
    });
    controller.abort();

    await expect(pending).rejects.toThrow(/cancelled by caller/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

// ─── guardrail: createGuardrailPlugin ────────────────────────────────────────

const blockingTransport = (verdict: GuardrailVerdict = { action: "block", message: "policy hit" }) =>
  customGuardrail(() => verdict, "fake");

describe("createGuardrailPlugin", () => {
  it("shadow mode never denies but still reports what it would have done", async () => {
    const evaluate = vi.fn(() => ({ action: "block" as const, message: "would block" }));
    const plugin = createGuardrailPlugin({
      name: "shadow-guard",
      transport: customGuardrail(evaluate, "fake"),
      mode: "shadow",
    });
    const { run, events } = harness([plugin]);

    const gate = await run.runGate("userPromptSubmit", {
      text: "sensitive",
      message: userMessage("sensitive"),
    });

    expect(gate.decision).toBe("allow");
    expect(gate.mutated).toBe(false);
    expect(evaluate).toHaveBeenCalledTimes(1);

    const reported = metadataEvents(events).find((event) => event.guardrail);
    expect(reported?.guardrail).toMatchObject({
      plugin: "shadow-guard",
      action: "block",
      message: "would block",
      enforced: false,
    });
  });

  it("enforce mode blocks, and honours a mask verdict by rewriting the payload", async () => {
    const blocked = harness([createGuardrailPlugin({ name: "g", transport: blockingTransport() })]);
    const denyGate = await blocked.run.runGate("userPromptSubmit", {
      text: "sensitive",
      message: userMessage("sensitive"),
    });
    expect(denyGate.decision).toBe("deny");
    expect(denyGate.deniedBy).toBe("g");
    expect(denyGate.reason).toContain("policy hit");

    const masked = harness([
      createGuardrailPlugin({
        name: "g",
        transport: blockingTransport({ action: "mask", maskedContent: "[masked]" }),
      }),
    ]);
    const maskGate = await masked.run.runGate("userPromptSubmit", {
      text: "my card is 4111111111111111",
      message: userMessage("x"),
    });
    expect(maskGate.decision).toBe("allow");
    expect(maskGate.mutated).toBe(true);
    expect(maskGate.input.text).toBe("[masked]");
  });

  it("memoizes verdicts per run, so two identical checks make one HTTP call", async () => {
    const fetchMock = stubFetch(async () => jsonResponse({ results: [{ action: "allow" }] }));
    const plugin = createGuardrailPlugin({
      name: "cached-guard",
      transport: httpGuardrail({ url: "https://guard.example.com/evaluate" }),
    });
    const { run, restart } = harness([plugin]);

    await run.runGate("userPromptSubmit", { text: "same question", message: userMessage("same question") });
    await run.runGate("userPromptSubmit", { text: "same question", message: userMessage("same question") });
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await run.runGate("userPromptSubmit", { text: "different", message: userMessage("different") });
    expect(fetchMock).toHaveBeenCalledTimes(2);

    // The cache lives in the per-run store and does not survive into a new run.
    const next = restart();
    await next.runGate("userPromptSubmit", { text: "same question", message: userMessage("same question") });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("skips the network for empty content and for phases it was not applied to", async () => {
    const evaluate = vi.fn(() => ({ action: "block" as const }));
    const plugin = createGuardrailPlugin({
      name: "input-only",
      transport: customGuardrail(evaluate, "fake"),
      apply: ["input"],
    });
    const { run } = harness([plugin]);

    await run.runGate("userPromptSubmit", { text: "   ", message: userMessage("   ") });
    expect(evaluate).not.toHaveBeenCalled();

    const toolGate = await run.runGate("preToolUse", toolInput("echo", { message: "hi" }));
    expect(toolGate.decision).toBe("allow");
    expect(evaluate).not.toHaveBeenCalled();
  });

  it("turns a transport failure into a deny when fail-closed, and a pass-through when not", async () => {
    const exploding = customGuardrail(() => {
      throw new Error("guardrail service unreachable");
    }, "fake");

    const closed = harness([createGuardrailPlugin({ name: "closed-guard", transport: exploding })]);
    const denied = await closed.run.runGate("userPromptSubmit", {
      text: "hello",
      message: userMessage("hello"),
    });
    expect(denied.decision).toBe("deny");
    expect(denied.deniedBy).toBe("closed-guard");
    expect(denied.reason).toContain("fail-closed");
    expect(metadataEvents(closed.events).some((event) => event.guardrailError)).toBe(true);

    const open = harness([
      createGuardrailPlugin({ name: "open-guard", transport: exploding, failClosed: false }),
    ]);
    const allowed = await open.run.runGate("userPromptSubmit", {
      text: "hello",
      message: userMessage("hello"),
    });
    expect(allowed.decision).toBe("allow");
  });
});

// ─── guardrail presets ───────────────────────────────────────────────────────

describe("cognipeerGuardrail / portkeyGuardrail", () => {
  it("throw a clear error when no api key is available", () => {
    withoutEnv(["COGNIPEER_API_KEY"], () => {
      expect(() => cognipeerGuardrail()).toThrow(
        /cognipeerGuardrail requires an apiKey \(pass `apiKey` or set COGNIPEER_API_KEY\)/,
      );
    });
    withoutEnv(["PORTKEY_API_KEY"], () => {
      expect(() => portkeyGuardrail()).toThrow(
        /portkeyGuardrail requires an apiKey \(pass `apiKey` or set PORTKEY_API_KEY\)/,
      );
    });
  });

  it("cognipeerGuardrail posts the console HOOK contract with a bearer token", async () => {
    const fetchMock = stubFetch(async () => jsonResponse({ decision: "allow", enforced: true, passed: true }));
    const plugin = cognipeerGuardrail({
      apiKey: "sk-console-test",
      baseUrl: "https://console.example.com/",
      guardrailKeys: ["sdk-e2e-pii", "sdk-e2e-tox"],
      only: ["pii"],
    });
    expect(plugin.name).toBe("cognipeer-guardrail");

    const { run } = harness([plugin]);
    await run.runGate("userPromptSubmit", {
      text: "hello",
      content: "hello",
      attachments: [],
      message: userMessage("hello"),
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://console.example.com/api/client/v1/guardrails/hooks/evaluate");
    expect(init.headers?.Authorization).toBe("Bearer sk-console-test");

    const body = JSON.parse(init.body!);
    // `input.pre` today: the deployed Console rejects any id outside its five,
    // and a 400 per turn under fail-closed reads as "blocked". `prompt.pre` is
    // opt-in via `hookIds` until that deployment carries it.
    expect(body).toMatchObject({
      hook: "input.pre",
      guardrail_keys: ["sdk-e2e-pii", "sdk-e2e-tox"],
      text: "hello",
      provider_ref: "agent-sdk",
      only: ["pii"],
    });
  });

  it("cognipeerGuardrail maps each SDK hook onto its console hook id", async () => {
    const fetchMock = stubFetch(async () => jsonResponse({ decision: "allow", enforced: true }));
    const { run } = harness([
      cognipeerGuardrail({
        apiKey: "k",
        baseUrl: "https://console.example.com",
        guardrailKey: "pii",
        apply: ["input", "output", "tool", "tool_result"],
      }),
    ]);

    await run.runGate("userPromptSubmit", {
      text: "hi", content: "hi", attachments: [], message: userMessage("hi"),
    });
    await run.runGate("postModelCall", {
      message: { role: "assistant", content: "there" } as any,
      durationMs: 1, iteration: 1, shortCircuited: false,
    });
    await run.runGate("preToolUse", {
      toolName: "deploy", toolCallId: "c1", args: { env: "prod" }, tool: { name: "deploy" } as any, executionCount: 0,
    });
    await run.runGate("postToolUse", {
      toolName: "deploy", toolCallId: "c1", args: { env: "prod" }, output: { ok: true }, durationMs: 1, executionId: "e1",
    });

    const hooks = fetchMock.mock.calls.map((call: any) => JSON.parse(call[1].body).hook);
    expect(hooks).toEqual(["input.pre", "output.pre", "tool.pre", "tool.post"]);

    const toolPre = JSON.parse(fetchMock.mock.calls[2][1].body);
    expect(toolPre).toMatchObject({ tool_name: "deploy", tool_args: { env: "prod" } });
    const toolPost = JSON.parse(fetchMock.mock.calls[3][1].body);
    expect(toolPost).toMatchObject({ tool_name: "deploy", tool_result: { ok: true } });
  });

  it("cognipeerGuardrail blocks on an ENFORCED block decision", async () => {
    stubFetch(async () =>
      jsonResponse({
        decision: "block",
        enforced: true,
        passed: false,
        blocked_message: "PII policy violation",
        findings: [{ family: "pii" }],
      }),
    );
    const { run } = harness([
      cognipeerGuardrail({ apiKey: "k", baseUrl: "https://console.example.com", guardrailKey: "pii" }),
    ]);

    const gate = await run.runGate("userPromptSubmit", {
      text: "national id 12345678950",
      content: "national id 12345678950",
      attachments: [],
      message: userMessage("national id 12345678950"),
    });

    expect(gate.decision).toBe("deny");
    expect(gate.reason).toContain("PII policy violation");
  });

  it("cognipeerGuardrail does NOT block when the decision was not enforced", async () => {
    // Monitor / dry run. Blocking on `decision: "block"` alone would turn every
    // observation policy into an enforcing one the day it is switched on to
    // watch — which is the opposite of what monitoring is for.
    stubFetch(async () =>
      jsonResponse({
        decision: "block",
        would_be_decision: "block",
        enforced: false,
        mode: "monitor",
        passed: false,
        blocked_message: "PII policy violation",
      }),
    );
    const { run } = harness([
      cognipeerGuardrail({ apiKey: "k", baseUrl: "https://console.example.com", guardrailKey: "pii" }),
    ]);

    const gate = await run.runGate("userPromptSubmit", {
      text: "national id 12345678950",
      content: "national id 12345678950",
      attachments: [],
      message: userMessage("national id 12345678950"),
    });

    expect(gate.decision).toBe("allow");
  });

  it("cognipeerGuardrail applies a redact by substituting the rewritten text", async () => {
    stubFetch(async () =>
      jsonResponse({ decision: "redact", enforced: true, passed: true, redacted_text: "national id [REDACTED]" }),
    );
    const { run } = harness([
      cognipeerGuardrail({ apiKey: "k", baseUrl: "https://console.example.com", guardrailKey: "pii" }),
    ]);

    const gate = await run.runGate("userPromptSubmit", {
      text: "national id 12345678950",
      content: "national id 12345678950",
      attachments: [],
      message: userMessage("national id 12345678950"),
    });

    expect(gate.decision).toBe("allow");
    expect(gate.input.text).toBe("national id [REDACTED]");
  });

  it("cognipeerGuardrail treats a 446 as a verdict, not a transport failure", async () => {
    // The console emits 446 only when a guardrail opts into verdict status
    // codes. Routing it through the failureMode path would block for the right
    // outcome but the wrong reason, with a transport error as the message.
    stubFetch(async () =>
      jsonResponse({ decision: "block", enforced: true, blocked_message: "blocked by policy" }, 446),
    );
    const { run } = harness([
      cognipeerGuardrail({ apiKey: "k", baseUrl: "https://console.example.com", guardrailKey: "pii" }),
    ]);

    const gate = await run.runGate("userPromptSubmit", {
      text: "bad", content: "bad", attachments: [], message: userMessage("bad"),
    });

    expect(gate.decision).toBe("deny");
    expect(gate.reason).toContain("blocked by policy");
  });

  it("cognipeerGuardrail can be pointed at prompt.pre once the console ships it", async () => {
    const fetchMock = stubFetch(async () => jsonResponse({ decision: "allow", enforced: true }));
    const { run } = harness([
      cognipeerGuardrail({
        apiKey: "k",
        baseUrl: "https://console.example.com",
        guardrailKey: "pii",
        hookIds: { userPromptSubmit: "prompt.pre" },
      }),
    ]);

    await run.runGate("userPromptSubmit", {
      text: "hi", content: "hi", attachments: [], message: userMessage("hi"),
    });

    expect(JSON.parse(fetchMock.mock.calls[0][1].body).hook).toBe("prompt.pre");
  });

  it("cognipeerGuardrail reads the body out of a structured blocked_message", async () => {
    // Verified against a live Console: `blocked_message` is an object, not a
    // string. Passing it through renders the refusal a person reads as
    // "[object Object]".
    stubFetch(async () =>
      jsonResponse({
        decision: "block",
        enforced: true,
        passed: false,
        blocked_message: {
          reasonClass: "pii",
          body: "This didn't go through, because it looks like it contains personal information.",
          mode: "error",
          status: 400,
          traceId: "c258a123",
        },
        findings: [{ family: "pii", checkId: "legacy:pii", span: { start: 9, end: 33 } }],
      }),
    );
    const { run } = harness([
      cognipeerGuardrail({ apiKey: "k", baseUrl: "https://console.example.com", guardrailKey: "pii" }),
    ]);

    const gate = await run.runGate("userPromptSubmit", {
      text: "write to ada@example.com", content: "write to ada@example.com", attachments: [],
      message: userMessage("write to ada@example.com"),
    });

    expect(gate.decision).toBe("deny");
    expect(gate.reason).toContain("personal information");
    expect(gate.reason).not.toContain("[object Object]");
  });

  it("cognipeerGuardrail SUBSTITUTES rather than refuses when the block asks for replace", async () => {
    // `mode: "replace"` is a different product behaviour from a refusal: the
    // turn continues with this text standing in. A guardrail that chose the
    // softer one must not silently get the harder one.
    stubFetch(async () =>
      jsonResponse({
        decision: "block",
        enforced: true,
        passed: false,
        blocked_message: {
          reasonClass: "pii",
          body: "I can't share that here.",
          mode: "replace",
          status: 200,
          traceId: "t1",
        },
      }),
    );
    const { run } = harness([
      cognipeerGuardrail({ apiKey: "k", baseUrl: "https://console.example.com", guardrailKey: "pii" }),
    ]);

    const gate = await run.runGate("userPromptSubmit", {
      text: "leaky", content: "leaky", attachments: [], message: userMessage("leaky"),
    });

    expect(gate.decision).toBe("allow");
    expect(gate.input.text).toBe("I can't share that here.");
  });

  it("cognipeerGuardrail refuses to construct without a guardrail key", () => {
    // The plugin falls back to COGNIPEER_GUARDRAIL_KEY(S), so a shell that has
    // one exported — anyone running the live Console tests in the same pass —
    // supplies the very key this test asserts the absence of, and it then fails
    // on the environment rather than on the code.
    withoutEnv(["COGNIPEER_GUARDRAIL_KEYS", "COGNIPEER_GUARDRAIL_KEY"], () => {
      expect(() => cognipeerGuardrail({ apiKey: "sk-console-test" })).toThrow(/guardrailKey/);
    });
  });

  it("portkeyGuardrail posts to the portkey endpoint with its own api-key header", async () => {
    const fetchMock = stubFetch(async () => jsonResponse([{ action: "allow" }]));
    const plugin = portkeyGuardrail({ apiKey: "pk-test", checks: ["pii", "toxicity"] });
    expect(plugin.name).toBe("portkey-guardrail");
    expect(plugin.priority).toBe(25);

    const { run } = harness([plugin]);
    await run.runGate("userPromptSubmit", { text: "hello", message: userMessage("hello") });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://api.portkey.ai/v1/guardrails/evaluate");
    expect(init.headers?.["x-portkey-api-key"]).toBe("pk-test");
    expect(init.headers?.Authorization).toBeUndefined();

    const body = JSON.parse(init.body!);
    expect(body.checks).toEqual(["pii", "toxicity"]);
    expect(body.items).toEqual([{ type: "input", text: "hello", metadata: {} }]);
  });
});

// ─── stores ──────────────────────────────────────────────────────────────────

describe("stores", () => {
  it("inMemoryConversationStore round-trips a thread", async () => {
    const store = inMemoryConversationStore();
    expect(await store.load("t1")).toEqual([]);

    await store.append("t1", [userMessage("hi")]);
    await store.append("t1", [{ role: "assistant", content: "hello" } as Message]);

    expect(await store.load("t1")).toEqual([
      { role: "user", content: "hi" },
      { role: "assistant", content: "hello" },
    ]);
    // Threads are isolated.
    expect(await store.load("t2")).toEqual([]);

    await store.clear?.("t1");
    expect(await store.load("t1")).toEqual([]);
  });

  it("conversationHistory hydrates the transcript on a fresh run", async () => {
    const store = inMemoryConversationStore();
    await store.append("t1", [userMessage("older"), { role: "assistant", content: "earlier" } as Message]);
    const loadSpy = vi.spyOn(store, "load");

    const { run } = harness([conversationHistory({ store, threadId: "t1" })]);
    const gate = await run.runGate("sessionStart", { messages: [userMessage("new")], resumed: false });

    expect(loadSpy).toHaveBeenCalledWith("t1");
    expect(gate.mutated).toBe(true);
    expect(gate.input.messages).toEqual([
      { role: "user", content: "older" },
      { role: "assistant", content: "earlier" },
      { role: "user", content: "new" },
    ]);
  });

  it("conversationHistory does NOT reload history when the run is resumed", async () => {
    const store = inMemoryConversationStore();
    await store.append("t1", [userMessage("older"), { role: "assistant", content: "earlier" } as Message]);
    const loadSpy = vi.spyOn(store, "load");

    const { run } = harness([conversationHistory({ store, threadId: "t1" })]);
    const messages = [userMessage("older"), { role: "assistant", content: "earlier" } as Message];
    const gate = await run.runGate("sessionStart", { messages, resumed: true });

    // A resumed run already carries its transcript; reloading would duplicate it.
    expect(loadSpy).not.toHaveBeenCalled();
    expect(gate.mutated).toBe(false);
    expect(gate.input.messages).toBe(messages);
  });

  it("conversationHistory honours maxMessages when hydrating", async () => {
    const store = inMemoryConversationStore();
    await store.append("t1", [userMessage("a"), userMessage("b"), userMessage("c")]);

    const { run } = harness([conversationHistory({ store, threadId: "t1", maxMessages: 2 })]);
    const gate = await run.runGate("sessionStart", { messages: [userMessage("new")], resumed: false });

    expect(gate.input.messages).toEqual([
      { role: "user", content: "b" },
      { role: "user", content: "c" },
      { role: "user", content: "new" },
    ]);
  });

  it("conversationHistory persists the incoming user turn", async () => {
    const store = inMemoryConversationStore();
    const finalMessages = [userMessage("hi"), { role: "assistant", content: "hello" } as Message];
    const { run } = harness([conversationHistory({ store, threadId: "t1" })], {
      messages: finalMessages,
    });

    await run.runGate("sessionStart", { messages: [userMessage("hi")], resumed: false });
    await run.runObservers("sessionEnd", { status: "success", durationMs: 5 });

    expect(await store.load("t1")).toEqual(finalMessages);
  });

  it("a resumed run appends only the turns it produced", async () => {
    const store = inMemoryConversationStore();
    const carried = [userMessage("hi"), { role: "assistant", content: "hello" } as Message];
    await store.append("t1", carried);

    const finalMessages = [...carried, { role: "assistant", content: "after resume" } as Message];
    const { run } = harness([conversationHistory({ store, threadId: "t1" })], {
      messages: finalMessages,
    });

    await run.runGate("sessionStart", { messages: carried, resumed: true });
    await run.runObservers("sessionEnd", { status: "success", durationMs: 5 });

    expect(await store.load("t1")).toEqual(finalMessages);
  });
});
