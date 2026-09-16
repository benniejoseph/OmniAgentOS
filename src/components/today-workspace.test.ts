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
    expect(source).toContain("Trusted status");
    expect(source).toContain("Data confidence");
    expect(source).toContain("instead of pretending it is empty");
    expect(source).not.toContain("WorkspaceReadinessCard");
    expect(source).not.toContain("useWorkspaceReadiness");
    expect(source).toContain("cosmicBackdrop");
    expect(source).toContain("Active agents");
    expect(source).toContain("visibleSections");
    expect(source).toContain("today-overview-dial");
    expect(source).toContain("today-overview-summary");

    const consumptionIndex = source.indexOf("<UsageCockpit");
    const dataConfidenceIndex = source.indexOf(
      '<section className={styles.projectionStatus}',
    );
    const knowledgeConfidenceIndex = source.indexOf(
      '<SourceCoveragePanel surface="today" />',
    );
    expect(consumptionIndex).toBeGreaterThan(-1);
    expect(dataConfidenceIndex).toBeGreaterThan(consumptionIndex);
    expect(knowledgeConfidenceIndex).toBeGreaterThan(dataConfidenceIndex);
  });

  it("keeps the authenticated actor scope inside the cohesive service boundary", async () => {
    const pageSource = await readFile(
      path.join(process.cwd(), "src/app/app/page.tsx"),
      "utf8",
    );
    const serviceSource = await readFile(
      path.join(process.cwd(), "src/lib/app-services/cohesive-today.ts"),
      "utf8",
    );

    expect(pageSource).toContain("showCohesiveTodayService");
    expect(serviceSource).toContain("runWithDatabaseActorScope");
    expect(serviceSource).toContain(
      "actorBinding?.readableOwnerActorIds || [caller.context.actorId]",
    );
  });
});
