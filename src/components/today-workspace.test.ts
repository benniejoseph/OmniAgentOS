import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

describe("cohesive Today workspace", () => {
  it("uses one canonical projection while preserving suggestion and unknown-state boundaries", async () => {
    const source = await readFile(
      path.join(process.cwd(), "src/components/today-workspace.tsx"),
      "utf8",
    );

    expect(source).toContain("/api/today/agenda?workLimit=16&approvalLimit=12&meetingLimit=50&accountLimit=50");
    expect(source).not.toContain("/api/workspace-summary?limit");
    expect(source).not.toContain("/api/usage/summary");
    expect(source).toContain("Customer attention");
    expect(source).toContain("Evidence-bound next actions");
    expect(source).toContain("confidence · suggested");
    expect(source).toContain("pendingApprovals");
    expect(source).toContain("overdueCommitments");
    expect(source).toContain("Meetings, confirmed commitments, and personal reminders");
    expect(source).toContain("What Today knows");
    expect(source).toContain("An unavailable source stays unknown instead of becoming an empty fact");
    expect(source).toContain("Active agents");
    expect(source).toContain("visibleSections");
  });
});
