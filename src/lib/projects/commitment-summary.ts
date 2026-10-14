import { canonicalStatusForProjectTask, type CanonicalStatus } from "@/lib/status/canonical";
import type { ProjectTask } from "./types";

type CommitmentSummaryTask = Pick<ProjectTask,
  "status" | "workflowStatus" | "updatedAt" | "humanOwner" | "dueAt" | "dueDate" | "dependsOn"
> & { workItemStatus?: { status: CanonicalStatus } };

/** Read-only counts over the tasks actually returned by an authorized read.
 * This is neither a frozen multi-page snapshot nor a comparison of saved prose
 * with documents. A claimed completion retains its canonical verification state.
 */
export function buildProjectCommitmentSummary(input: {
  tasks: readonly CommitmentSummaryTask[];
  readAt: string;
  coverage: "complete" | "partial";
}) {
  const summary = {
    version: "project-commitment-summary:1" as const,
    readAt: input.readAt,
    consistency: "current_read_not_snapshot" as const,
    coverage: input.coverage,
    commitmentCount: input.tasks.length,
    openCount: 0,
    closedUnverifiedCount: 0,
    verifiedSuccessCount: 0,
    failedCount: 0,
    canceledCount: 0,
    blockedCount: 0,
    unassignedOpenCount: 0,
    undatedOpenCount: 0,
    dependencyCount: 0,
    lastChangedAt: null as string | null,
    narrativeAssessment: "not_compared" as const,
  };
  for (const task of input.tasks) {
    const status = task.workItemStatus?.status ?? canonicalStatusForProjectTask(task).status;
    const open = !["unverified", "succeeded", "failed", "canceled"].includes(status);
    if (open) {
      summary.openCount += 1;
      if (!task.humanOwner?.trim()) summary.unassignedOpenCount += 1;
      if (!task.dueAt && !task.dueDate) summary.undatedOpenCount += 1;
    }
    if (status === "unverified") summary.closedUnverifiedCount += 1;
    if (status === "succeeded") summary.verifiedSuccessCount += 1;
    if (status === "failed") summary.failedCount += 1;
    if (status === "canceled") summary.canceledCount += 1;
    if (status === "blocked") summary.blockedCount += 1;
    if (task.dependsOn.length) summary.dependencyCount += 1;
    if (summary.lastChangedAt === null || Date.parse(task.updatedAt) > Date.parse(summary.lastChangedAt)) {
      summary.lastChangedAt = task.updatedAt;
    }
  }
  return Object.freeze(summary);
}

export type ProjectCommitmentSummary = ReturnType<typeof buildProjectCommitmentSummary>;
