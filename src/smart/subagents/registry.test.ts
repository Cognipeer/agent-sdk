import { describe, expect, it } from "vitest";
import { z } from "zod";

import { createTool } from "../../tool.js";
import {
  buildSubagentCatalogBlock,
  canSpawn,
  findSubagent,
  resolveAvailableSubagents,
  resolveSubagentTools,
  seedChildMessages,
  withinDepth,
} from "./registry.js";
import { createSubagentRegistryRef, DEFAULT_SUBAGENT_POLICY, type SubagentDef } from "./types.js";

const TOOL_NAMES = { delegate: "delegate_to", spawn: "spawn_subagent", parallel: "spawn_subagents_parallel" };

describe("subagents/registry", () => {
  it("seedChildMessages: minimal passes only the input", () => {
    const parent = [
      { role: "system", content: "sys" },
      { role: "user", content: "old task" },
      { role: "assistant", content: "answer" },
    ] as any;
    const msgs = seedChildMessages("minimal", parent, "the input");
    expect(msgs).toHaveLength(1);
    expect(msgs[0]).toMatchObject({ role: "user", content: "the input" });
  });

  it("seedChildMessages: scoped keeps last user + input but drops the parent system prompt", () => {
    const parent = [
      { role: "system", content: "sys" },
      { role: "user", content: "first" },
      { role: "assistant", content: "a" },
      { role: "user", content: "latest user" },
    ] as any;
    const msgs = seedChildMessages("scoped", parent, "task");
    expect(msgs.map((m: any) => m.role)).toEqual(["user", "user"]);
    expect((msgs[0] as any).content).toBe("latest user");
    expect((msgs[1] as any).content).toBe("task");
  });

  it("seedChildMessages: full keeps the transcript (minus system) + input", () => {
    const parent = [
      { role: "system", content: "sys" },
      { role: "user", content: "u1" },
    ] as any;
    const msgs = seedChildMessages("full", parent, "task");
    expect(msgs.map((m: any) => m.role)).toEqual(["user", "user"]);
    expect((msgs[1] as any).content).toBe("task");
  });

  it("canSpawn enforces the per-run child-call budget", () => {
    const ref = createSubagentRegistryRef();
    const policy = { ...DEFAULT_SUBAGENT_POLICY, maxChildCalls: 2 };
    expect(canSpawn(ref, policy, 1).ok).toBe(true);
    ref.spawnedCount = 2;
    const blocked = canSpawn(ref, policy, 1);
    expect(blocked.ok).toBe(false);
    if (!blocked.ok) expect(blocked.reason).toContain("budget");
  });

  it("canSpawn refuses when mode is off", () => {
    const ref = createSubagentRegistryRef();
    expect(canSpawn(ref, { ...DEFAULT_SUBAGENT_POLICY, mode: "off" }).ok).toBe(false);
  });

  it("withinDepth enforces maxDepth", () => {
    expect(withinDepth(0, { ...DEFAULT_SUBAGENT_POLICY, maxDepth: 2 }).ok).toBe(true);
    expect(withinDepth(2, { ...DEFAULT_SUBAGENT_POLICY, maxDepth: 2 }).ok).toBe(false);
  });

  it("resolveSubagentTools maps string names against the parent tool set", async () => {
    const a = createTool({ name: "a", description: "", schema: z.object({}), func: async () => 1 });
    const b = createTool({ name: "b", description: "", schema: z.object({}), func: async () => 2 });
    const resolved = await resolveSubagentTools(["b"], [a, b]);
    expect(resolved.map((t) => t.name)).toEqual(["b"]);
  });

  it("resolveAvailableSubagents filters by isAvailable", async () => {
    const subs: SubagentDef[] = [
      { name: "yes", header: "h", isAvailable: () => true },
      { name: "no", header: "h", isAvailable: async () => false },
      { name: "default", header: "h" },
    ];
    const out = await resolveAvailableSubagents(subs);
    expect(out.map((s) => s.name)).toEqual(["yes", "default"]);
  });

  it("findSubagent looks up by name", () => {
    const subs: SubagentDef[] = [{ name: "x", header: "h" }];
    expect(findSubagent(subs, "x")?.name).toBe("x");
    expect(findSubagent(subs, "missing")).toBeUndefined();
  });

  it("buildSubagentCatalogBlock lists registry entries + ad-hoc affordance", () => {
    const subs: SubagentDef[] = [{ name: "researcher", header: "deep web research" }];
    const block = buildSubagentCatalogBlock(subs, DEFAULT_SUBAGENT_POLICY, TOOL_NAMES);
    expect(block).toContain("<available_subagents>");
    expect(block).toContain("researcher: deep web research");
    expect(block).toContain("delegate_to");
    expect(block).toContain("spawn_subagent(");
    expect(block).toContain("spawn_subagents_parallel");
  });

  it("buildSubagentCatalogBlock hides ad-hoc affordance in registry_only mode", () => {
    const block = buildSubagentCatalogBlock([{ name: "r", header: "h" }], { ...DEFAULT_SUBAGENT_POLICY, mode: "registry_only" }, TOOL_NAMES);
    expect(block).not.toContain("spawn_subagent(");
  });
});
