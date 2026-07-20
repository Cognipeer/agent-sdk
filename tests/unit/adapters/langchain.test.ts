import { describe, it, expect } from "vitest";
import { z } from "zod";
import { fromLangchainTools, toLangchainTools } from "../../../src/adapters/langchain.js";
import { createTool } from "../../../src/tool.js";

describe("adapters/langchain", () => {
  describe("fromLangchainTools", () => {
    it("wraps a LangChain-style tool exposing invoke()", async () => {
      const lc = { name: "lc_invoke", description: "d", schema: z.object({ x: z.string() }), invoke: async (i: any) => ({ got: i.x }) };
      const [wrapped] = fromLangchainTools([lc]);
      expect(wrapped.name).toBe("lc_invoke");
      expect(wrapped.description).toBe("d");
      expect((wrapped as any).__source).toBe("langchain");
      expect(await wrapped.invoke!({ x: "y" })).toEqual({ got: "y" });
    });

    it("supports call(), _call(), run(), and func() dispatch", async () => {
      const variants = [
        { name: "c_call", call: async () => "call" },
        { name: "c_underscore", _call: async () => "_call" },
        { name: "c_run", run: async () => "run" },
        { name: "c_func", func: async () => "func" },
      ];
      const wrapped = fromLangchainTools(variants as any);
      expect(await wrapped[0].invoke!({})).toBe("call");
      expect(await wrapped[1].invoke!({})).toBe("_call");
      expect(await wrapped[2].invoke!({})).toBe("run");
      expect(await wrapped[3].invoke!({})).toBe("func");
    });

    it("reads name/description/schema from lc_kwargs", async () => {
      const lc = { lc_kwargs: { name: "kw_tool", description: "kw desc", schema: z.any() }, invoke: async () => "ok" };
      const [wrapped] = fromLangchainTools([lc as any]);
      expect(wrapped.name).toBe("kw_tool");
      expect(wrapped.description).toBe("kw desc");
    });

    it("wraps a bare (nameless) function as anonymous_tool", async () => {
      const fn: any = (i: any) => `echo:${i}`;
      Object.defineProperty(fn, "name", { value: "" }); // truly anonymous
      const [wrapped] = fromLangchainTools([fn]);
      expect(wrapped.name).toBe("anonymous_tool");
      expect(await wrapped.invoke!("hi")).toBe("echo:hi");
    });

    it("passes through native SDK tools untouched", () => {
      const native = createTool({ name: "native", description: "n", schema: z.object({}), func: async () => 1 });
      const [out] = fromLangchainTools([native]);
      expect(out).toBe(native);
    });

    it("defaults the name to 'tool' when none is provided", () => {
      const [wrapped] = fromLangchainTools([{ invoke: async () => "x" } as any]);
      expect(wrapped.name).toBe("tool");
    });
  });

  describe("toLangchainTools", () => {
    it("preserves arity and returns invokable tools (with or without @langchain/core)", async () => {
      const t = createTool({ name: "t", description: "d", schema: z.object({ a: z.string() }), func: async ({ a }) => a });
      const out = toLangchainTools([t]);
      expect(out).toHaveLength(1);
      // Either a real LC tool (has .invoke) or the original passthrough.
      const candidate: any = out[0];
      expect(typeof candidate.invoke === "function" || typeof candidate.func === "function").toBe(true);
    });

    it("does not throw on an empty list", () => {
      expect(toLangchainTools([])).toEqual([]);
    });
  });
});
