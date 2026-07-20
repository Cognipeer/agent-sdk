import { describe, it, expect } from "vitest";
import { z } from "zod";
import {
  regexRule,
  jsonSchemaRule,
  codePresenceRule,
  customCallbackRule,
  agentVerdictRule,
} from "../../../src/guardrails/checks.js";
import { createRegexGuardrail, createJsonGuardrail, createCodeGuardrail } from "../../../src/guardrails/index.js";
import { GuardrailPhase } from "../../../src/types.js";
import type { GuardrailContext } from "../../../src/types.js";

function ctx(latest: string, all: string[] = [latest]): GuardrailContext {
  return {
    phase: GuardrailPhase.Response,
    messages: all.map((content) => ({ role: "user", content })) as any,
    latestMessage: { role: "user", content: latest } as any,
    state: {} as any,
    options: {} as any,
  };
}

describe("guardrails/checks", () => {
  describe("regexRule", () => {
    it("blocks on a match by default and allows otherwise", async () => {
      const rule = regexRule({ pattern: /ssn/i });
      expect((await rule.evaluate(ctx("my SSN is..."))).passed).toBe(false);
      expect((await rule.evaluate(ctx("clean text"))).passed).toBe(true);
    });

    it("supports allowIfMatch (must match to pass)", async () => {
      const rule = regexRule({ pattern: "approved", allowIfMatch: true });
      expect((await rule.evaluate(ctx("approved request"))).passed).toBe(true);
      expect((await rule.evaluate(ctx("denied"))).passed).toBe(false);
    });

    it("honors a custom disposition and selector", async () => {
      const rule = regexRule({ pattern: /secret/, matchDisposition: "warn", selector: (c) => String(c.messages[0]?.content) });
      const res = await rule.evaluate(ctx("clean", ["this is secret"]));
      expect(res.passed).toBe(false);
      expect(res.disposition).toBe("warn");
    });
  });

  describe("jsonSchemaRule", () => {
    it("validates against a zod schema", async () => {
      const rule = jsonSchemaRule({ schema: z.object({ ok: z.boolean() }) });
      expect((await rule.evaluate(ctx(JSON.stringify({ ok: true })))).passed).toBe(true);
      expect((await rule.evaluate(ctx(JSON.stringify({ ok: "nope" })))).passed).toBe(false);
    });

    it("validates against a JSON Schema (ajv)", async () => {
      const rule = jsonSchemaRule({ schema: { type: "object", required: ["id"], properties: { id: { type: "number" } } } as any });
      expect((await rule.evaluate(ctx(JSON.stringify({ id: 1 })))).passed).toBe(true);
      const bad = await rule.evaluate(ctx(JSON.stringify({ id: "x" })));
      expect(bad.passed).toBe(false);
      expect(bad.details?.errors?.length).toBeGreaterThan(0);
    });

    it("handles non-JSON content per allowOnParseError", async () => {
      expect((await jsonSchemaRule({ schema: z.any(), allowOnParseError: true }).evaluate(ctx("not json"))).passed).toBe(true);
      const blocked = await jsonSchemaRule({ schema: z.any() }).evaluate(ctx("not json"));
      expect(blocked.passed).toBe(false);
      expect(blocked.reason).toMatch(/valid JSON/i);
    });
  });

  describe("codePresenceRule", () => {
    it("detects fenced code, keywords, and html; empty passes", async () => {
      expect((await codePresenceRule().evaluate(ctx("```js\nx\n```"))).passed).toBe(false);
      expect((await codePresenceRule().evaluate(ctx("const x = 1"))).passed).toBe(false);
      expect((await codePresenceRule().evaluate(ctx("<div>hi</div>"))).passed).toBe(false);
      expect((await codePresenceRule().evaluate(ctx("just prose"))).passed).toBe(true);
      expect((await codePresenceRule().evaluate(ctx(""))).passed).toBe(true);
    });

    it("respects the allowList", async () => {
      const rule = codePresenceRule({ allowList: [/sanctioned snippet/] });
      expect((await rule.evaluate(ctx("here is a sanctioned snippet: const x=1"))).passed).toBe(true);
    });

    it("defaults to a warn disposition", async () => {
      expect((await codePresenceRule().evaluate(ctx("import x"))).disposition).toBe("warn");
    });
  });

  describe("customCallbackRule", () => {
    it("accepts boolean and object outcomes", async () => {
      expect((await customCallbackRule({ callback: () => true }).evaluate(ctx("x"))).passed).toBe(true);
      const blocked = await customCallbackRule({ callback: () => false }).evaluate(ctx("x"));
      expect(blocked.passed).toBe(false);
      expect(blocked.disposition).toBe("block");
      const warned = await customCallbackRule({ callback: async () => ({ allow: false, disposition: "warn", reason: "meh" }) }).evaluate(ctx("x"));
      expect(warned).toMatchObject({ passed: false, disposition: "warn", reason: "meh" });
    });
  });

  describe("agentVerdictRule", () => {
    it("uses the guardian agent's structured output", async () => {
      const agent = { invoke: async () => ({ output: { allow: false, disposition: "block", reason: "unsafe" }, content: "" }) } as any;
      const res = await agentVerdictRule({ agent }).evaluate(ctx("review me"));
      expect(res).toMatchObject({ passed: false, disposition: "block", reason: "unsafe" });
    });

    it("falls back to parsing the content when no structured output", async () => {
      const agent = { invoke: async () => ({ output: undefined, content: JSON.stringify({ allow: true }) }) } as any;
      const res = await agentVerdictRule({ agent }).evaluate(ctx("review me"));
      expect(res.passed).toBe(true);
      expect(res.disposition).toBe("allow");
    });

    it("blocks when the guardian returns unparseable content", async () => {
      const agent = { invoke: async () => ({ output: undefined, content: "garbage" }) } as any;
      const res = await agentVerdictRule({ agent }).evaluate(ctx("review me"));
      expect(res.passed).toBe(false);
    });
  });

  describe("preset guardrail builders", () => {
    it("createRegexGuardrail wires a rule into a ConversationGuardrail", async () => {
      const g = createRegexGuardrail(/badword/, { phases: [GuardrailPhase.Request] });
      expect(g.appliesTo).toEqual([GuardrailPhase.Request]);
      expect(g.rules).toHaveLength(1);
      expect((await g.rules[0].evaluate(ctx("contains badword"))).passed).toBe(false);
    });

    it("createJsonGuardrail and createCodeGuardrail produce guardrails", async () => {
      const j = createJsonGuardrail(z.object({ a: z.number() }));
      expect((await j.rules[0].evaluate(ctx(JSON.stringify({ a: 1 })))).passed).toBe(true);
      const c = createCodeGuardrail();
      expect((await c.rules[0].evaluate(ctx("const y = 2"))).passed).toBe(false);
    });
  });
});
