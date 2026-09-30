import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = readFileSync("src/components/agent-runs-workspace.tsx", "utf8");

describe("Command routing preference", () => {
  it("lets the server choose between a direct run and a workflow", () => {
    expect(source.match(/strategy: "auto",/g)).toHaveLength(2);
    expect(source).not.toContain('strategy: "direct",');
    expect(source).not.toContain('"auto" : "direct"');
  });
});
