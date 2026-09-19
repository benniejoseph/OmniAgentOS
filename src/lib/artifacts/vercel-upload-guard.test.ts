import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("Vercel artifact source upload guard", () => {
  it("only ignores the root runtime artifact directory", () => {
    const patterns = readFileSync(".vercelignore", "utf8")
      .split(/\r?\n/u)
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && !line.startsWith("#"));

    expect(patterns).toContain("/artifacts/");
    expect(patterns).not.toContain("artifacts");
  });
});
