import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

function walk(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (p.endsWith(".ts")) out.push(p);
  }
  return out;
}

describe("LangChain stays an optional peer", () => {
  it("no src file imports a LangChain package statically", () => {
    const offenders = walk(join(__dirname, "../../src")).filter((f) =>
      /^\s*(import|export)\b[^;]*\bfrom\s+["'](@langchain\/|langchain)/m.test(readFileSync(f, "utf8")),
    );
    expect(offenders).toEqual([]);
  });

  it("package.json declares every @langchain/* peer as optional", () => {
    const pkg = JSON.parse(readFileSync(join(__dirname, "../../package.json"), "utf8"));
    for (const name of Object.keys(pkg.peerDependencies)) {
      expect(pkg.peerDependenciesMeta[name]?.optional).toBe(true);
    }
    expect(Object.keys(pkg.peerDependencies)).toContain("@langchain/core");
    expect(pkg.dependencies["@langchain/core"]).toBeUndefined();
  });
});
