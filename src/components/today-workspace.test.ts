import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

describe("Today customer-success projection", () => {
  it("shows governed portfolio attention without presenting suggestions as decisions", async () => {
    const source = await readFile(
      path.join(process.cwd(), "src/components/today-workspace.tsx"),
      "utf8",
    );

    expect(source).toContain("/api/customer-accounts/portfolio?limit=20");
    expect(source).toContain("Customer attention");
    expect(source).toContain("Evidence-bound next actions");
    expect(source).toContain("confidence · suggested");
    expect(source).toContain("pendingApprovals");
    expect(source).toContain("overdueCommitments");
  });
});
