import { describe, expect, it } from "vitest";
import { buildProjectCommitmentSummary } from "./commitment-summary";
import type { ProjectTask } from "./types";

const readAt = "2026-10-14T08:00:00.000Z";
function task(patch: Partial<ProjectTask> = {}): ProjectTask {
  return { id: "task-a", tenantId: "tenant-a", projectId: "project-a", title: "Jonah to finish on 17 October",
    detail: "Owner and deadline in prose are not structured facts.", status: "open", priority: "medium", agentId: "atlas",
    position: 0, origin: "manual", dependsOn: [], dispatchAttempt: 0, createdAt: "2026-10-13T07:00:00.000Z",
    updatedAt: "2026-10-13T07:00:00.000Z", ...patch };
}

describe("current project commitment summary", () => {
  it("counts saved commitments without interpreting prose or upgrading done to verified success", () => {
    const result = buildProjectCommitmentSummary({ readAt, coverage: "complete", tasks: [
      task({ status: "done", humanOwner: "Maya Chen", dueDate: "2026-10-14" }),
      task({ humanOwner: "Jonah Patel", dueDate: "2026-10-17", dependsOn: ["admin", "dictionary"] }),
      task({ humanOwner: "Elena Ruiz", dueDate: "2026-10-16" }),
      task({ humanOwner: "Leo Martins", dueDate: "2026-10-19" }),
      task({ humanOwner: "Sara Okafor", dueDate: "2026-10-21", dependsOn: ["knowledge"], updatedAt: "2026-10-14T07:30:00.000Z" }),
    ] });
    expect(result).toMatchObject({ commitmentCount: 5, openCount: 4, closedUnverifiedCount: 1,
      verifiedSuccessCount: 0, unassignedOpenCount: 0, undatedOpenCount: 0, dependencyCount: 2,
      lastChangedAt: "2026-10-14T07:30:00.000Z", narrativeAssessment: "not_compared",
      readAt, coverage: "complete", consistency: "current_read_not_snapshot" });
    const legacy = buildProjectCommitmentSummary({ readAt, coverage: "complete", tasks: [task()] });
    expect(legacy).toMatchObject({ openCount: 1, unassignedOpenCount: 1, undatedOpenCount: 1 });
  });

  it("uses returned canonical outcomes and distinguishes blocked, failed, canceled and unverified work", () => {
    const result = buildProjectCommitmentSummary({ readAt, coverage: "partial", tasks: [
      { ...task(), workItemStatus: { status: "succeeded" } },
      { ...task({ status: "done" }), workItemStatus: { status: "blocked" } },
      { ...task(), workItemStatus: { status: "failed" } },
      { ...task(), workItemStatus: { status: "canceled" } },
      task({ status: "done" }),
      task({ status: "done", workflowStatus: "running", dueAt: "2026-10-15T09:00:00.000Z" }),
    ] });
    expect(result).toMatchObject({ coverage: "partial", commitmentCount: 6, openCount: 2, blockedCount: 1,
      verifiedSuccessCount: 1, closedUnverifiedCount: 1, failedCount: 1, canceledCount: 1,
      unassignedOpenCount: 2, undatedOpenCount: 1 });
  });

  it("reports only loaded rows and reflects a changed current read without claiming narrative consistency", () => {
    const previous = task();
    const before = buildProjectCommitmentSummary({ readAt, coverage: "partial", tasks: [previous] });
    const after = buildProjectCommitmentSummary({ readAt, coverage: "complete", tasks: [
      { ...previous, humanOwner: "Elena Ruiz", dueDate: "2026-10-16", updatedAt: "2026-10-14T07:59:00.000Z" },
    ] });
    expect(before).toMatchObject({ commitmentCount: 1, unassignedOpenCount: 1, undatedOpenCount: 1, coverage: "partial" });
    expect(after).toMatchObject({ commitmentCount: 1, unassignedOpenCount: 0, undatedOpenCount: 0,
      lastChangedAt: "2026-10-14T07:59:00.000Z", narrativeAssessment: "not_compared" });
    expect(previous.humanOwner).toBeUndefined();
    expect(Object.isFrozen(after)).toBe(true);
    expect(buildProjectCommitmentSummary({ readAt, coverage: "complete", tasks: [] }))
      .toMatchObject({ commitmentCount: 0, openCount: 0, lastChangedAt: null, narrativeAssessment: "not_compared" });
  });
});
