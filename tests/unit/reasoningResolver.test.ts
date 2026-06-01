/**
 * Unit tests for reasoning resolution, validation and reflection cadence logic.
 */

import { describe, it, expect } from "vitest";
import { resolveReasoning, validateReasoningConfig } from "../../src/smart/reasoning.js";
import { shouldRunReflection } from "../../src/nodes/reflect.js";
import type { SmartState } from "../../src/types.js";

describe("resolveReasoning", () => {
  it("returns undefined when disabled or empty", () => {
    expect(resolveReasoning(undefined)).toBeUndefined();
    expect(resolveReasoning({ enabled: false })).toBeUndefined();
    expect(resolveReasoning({})).toBeUndefined();
  });

  it("applies the minimal level preset", () => {
    const r = resolveReasoning({ level: "minimal" })!;
    expect(r.native?.effort).toBe("minimal");
    // minimal disables reflection by default
    expect(r.reflection.enabled).toBe(false);
    expect(r.reflection.cadence).toBe("off");
  });

  it("medium/high default to initial_then_after_tool cadence", () => {
    expect(resolveReasoning({ level: "medium" })!.reflection.cadence).toBe("initial_then_after_tool");
    expect(resolveReasoning({ level: "high" })!.reflection.cadence).toBe("initial_then_after_tool");
  });

  it("low defaults to on_branch cadence", () => {
    expect(resolveReasoning({ level: "low" })!.reflection.cadence).toBe("on_branch");
  });

  it("explicit sub-fields win over preset", () => {
    const r = resolveReasoning({
      level: "high",
      native: { effort: "low" },
      reflection: { cadence: "every_turn", feedTo: "memory" },
    })!;
    expect(r.native?.effort).toBe("low");
    expect(r.reflection.cadence).toBe("every_turn");
    expect(r.reflection.feedTo).toBe("memory");
  });

  it("native:false disables native reasoning but keeps reflection", () => {
    const r = resolveReasoning({ level: "medium", native: false })!;
    expect(r.native).toBeUndefined();
    expect(r.reflection.enabled).toBe(true);
  });

  it("feedTo defaults to none", () => {
    expect(resolveReasoning({ level: "high" })!.reflection.feedTo).toBe("none");
  });
});

describe("validateReasoningConfig", () => {
  it("accepts valid configs", () => {
    expect(() => validateReasoningConfig({ level: "minimal" })).not.toThrow();
    expect(() => validateReasoningConfig({ reflection: { cadence: "initial_then_after_tool" } })).not.toThrow();
  });

  it("rejects an invalid level", () => {
    expect(() => validateReasoningConfig({ level: "ultra" as any })).toThrow(/level/);
  });

  it("rejects an invalid cadence", () => {
    expect(() => validateReasoningConfig({ reflection: { cadence: "sometimes" as any } })).toThrow(/cadence/);
  });

  it("rejects negative budgetTokens and everyNTurns < 1", () => {
    expect(() => validateReasoningConfig({ native: { budgetTokens: -5 } })).toThrow(/budgetTokens/);
    expect(() => validateReasoningConfig({ reflection: { everyNTurns: 0 } })).toThrow(/everyNTurns/);
  });

  it("rejects an invalid feedTo", () => {
    expect(() => validateReasoningConfig({ reflection: { feedTo: "disk" as any } })).toThrow(/feedTo/);
  });
});

describe("shouldRunReflection cadence", () => {
  const mkState = (messages: any[], reflections: any[] = []): SmartState =>
    ({ messages, reflections, toolCallCount: messages.filter((m) => m.role === "tool").length } as any);

  it("off never fires; every_turn always fires", () => {
    const s = mkState([{ role: "user", content: "hi" }]);
    expect(shouldRunReflection("off", s, true)).toBe(false);
    expect(shouldRunReflection("every_turn", s, false)).toBe(true);
  });

  it("after_tool and initial_then_after_tool fire only when tools ran", () => {
    const s = mkState([{ role: "user", content: "hi" }]);
    expect(shouldRunReflection("after_tool", s, false)).toBe(false);
    expect(shouldRunReflection("after_tool", s, true)).toBe(true);
    expect(shouldRunReflection("initial_then_after_tool", s, false)).toBe(false);
    expect(shouldRunReflection("initial_then_after_tool", s, true)).toBe(true);
  });

  it("on_branch fires on the first tool turn", () => {
    const s = mkState([
      { role: "user", content: "hi" },
      { role: "assistant", content: "", tool_calls: [{}] },
      { role: "tool", name: "search", content: "x" },
    ]);
    expect(shouldRunReflection("on_branch", s, true)).toBe(true);
  });

  it("on_branch does not fire when tool set is unchanged across turns", () => {
    const s = mkState([
      { role: "assistant", content: "", tool_calls: [{}] },
      { role: "tool", name: "search", content: "a" },
      { role: "assistant", content: "", tool_calls: [{}] },
      { role: "tool", name: "search", content: "b" },
    ]);
    expect(shouldRunReflection("on_branch", s, true)).toBe(false);
  });

  it("on_branch fires when the tool set changes across turns", () => {
    const s = mkState([
      { role: "assistant", content: "", tool_calls: [{}] },
      { role: "tool", name: "search", content: "a" },
      { role: "assistant", content: "", tool_calls: [{}] },
      { role: "tool", name: "write_file", content: "b" },
    ]);
    expect(shouldRunReflection("on_branch", s, true)).toBe(true);
  });
});
