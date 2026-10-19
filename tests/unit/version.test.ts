import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { SDK_VERSION } from "../../src/version.js";

describe("SDK_VERSION", () => {
  it("equals the version in package.json, so a release bump cannot forget src/version.ts", () => {
    const pkg = JSON.parse(fs.readFileSync(path.resolve(__dirname, "../../package.json"), "utf8"));
    expect(SDK_VERSION).toBe(pkg.version);
  });
});
