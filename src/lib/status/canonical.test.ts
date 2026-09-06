import { describe, expect, it } from "vitest";
import {
  CANONICAL_STATUSES,
  canonicalStatusForAccessRequest,
  canonicalStatusForAgentProfile,
  canonicalStatusForAgentRun,
  canonicalStatusForMission,
  canonicalStatusForProject,
  canonicalStatusForProjectArtifact,
  canonicalStatusForProjectTask,
  canonicalStatusForSloPolicyChange,
  canonicalStatusForTerminalReceipt,
  canonicalStatusForToolExecution,
  canonicalStatusForWorkflowPlan,
  canonicalStatusForWorkflowPlanNode,
  canonicalStatusForWorkflowRun,
} from "@/lib/status/canonical";

describe("canonical status projections", () => {
  it("defines the complete version-1 vocabulary", () => {
    expect(CANONICAL_STATUSES).toEqual([
      "preview",
      "running",
      "waiting",
      "blocked",
      "partial",
      "unverified",
      "failed",
      "canceled",
      "succeeded",
    ]);
  });

  it("never upgrades legacy success-like states to succeeded", () => {
    const projections = [
      canonicalStatusForAgentRun("completed"),
      canonicalStatusForToolExecution("executed"),
      canonicalStatusForWorkflowRun("completed"),
      canonicalStatusForMission("succeeded"),
      canonicalStatusForProject({ status: "completed", executionStatus: "completed" }),
      canonicalStatusForProjectTask({ status: "done", workflowStatus: "completed" }),
      canonicalStatusForProjectArtifact("verified"),
      canonicalStatusForAgentProfile("learning"),
      canonicalStatusForSloPolicyChange("applied"),
      canonicalStatusForAccessRequest("provisioned"),
    ];

    expect(projections.map((projection) => projection.status)).toEqual(
      projections.map(() => "unverified"),
    );
    expect(projections.every((projection) => projection.basis === "legacy_status")).toBe(true);
  });

  it("projects previews, pauses, blockers, skips, failures, and cancellations distinctly", () => {
    expect(canonicalStatusForToolExecution("dry_run").status).toBe("preview");
    expect(canonicalStatusForWorkflowPlan("planned").status).toBe("preview");
    expect(canonicalStatusForAgentRun("waiting_approval").status).toBe("waiting");
    expect(canonicalStatusForAgentRun("waiting_clarification").status).toBe("waiting");
    expect(canonicalStatusForToolExecution("blocked").status).toBe("blocked");
    expect(canonicalStatusForWorkflowPlanNode("skipped").status).toBe("unverified");
    expect(canonicalStatusForWorkflowRun("failed").status).toBe("failed");
    expect(canonicalStatusForMission("canceled").status).toBe("canceled");
  });

  it("treats completed dry-run nodes as preview only", () => {
    expect(
      canonicalStatusForWorkflowPlanNode({ status: "completed", policy: "dry_run" }).status,
    ).toBe("preview");
    expect(
      canonicalStatusForWorkflowPlanNode({ status: "failed", policy: "dry_run" }).status,
    ).toBe("failed");
  });

  it("fails closed for unknown status values and unknown composite children", () => {
    expect(canonicalStatusForAgentRun("new_future_state").status).toBe("unverified");
    expect(canonicalStatusForAgentRun("COMPLETED").status).toBe("unverified");
    expect(canonicalStatusForAgentRun(undefined).sourceStatus).toBe("unknown");
    expect(
      canonicalStatusForProject({ status: "draft", executionStatus: "new_future_state" }).status,
    ).toBe("unverified");
    expect(
      canonicalStatusForProjectTask({ status: "done", workflowStatus: "new_future_state" }).status,
    ).toBe("unverified");
  });

  it("allows succeeded only for an explicitly verified outcome-evaluator receipt", () => {
    expect(canonicalStatusForTerminalReceipt({
      disposition: "succeeded",
      executionMode: "live",
      source: "outcome_evaluator",
      verificationState: "verified",
    }).status).toBe("succeeded");

    for (const receipt of [
      {
        disposition: "succeeded",
        executionMode: "live",
        source: "legacy_adapter",
        verificationState: "verified",
      },
      {
        disposition: "succeeded",
        executionMode: "live",
        source: "outcome_evaluator",
        verificationState: "partially_verified",
      },
      {
        disposition: "succeeded",
        executionMode: "live",
        source: "outcome_evaluator",
        verificationState: "unassessed",
      },
      {
        disposition: "SUCCEEDED",
        executionMode: "live",
        source: "outcome_evaluator",
        verificationState: "verified",
      },
      {
        disposition: "succeeded",
        executionMode: "dry_run",
        source: "outcome_evaluator",
        verificationState: "verified",
      },
    ]) {
      expect(canonicalStatusForTerminalReceipt(receipt).status).toBe("unverified");
    }
  });

  it("preserves non-success terminal receipt dispositions", () => {
    expect(canonicalStatusForTerminalReceipt({ disposition: "partial" }).status).toBe("partial");
    expect(canonicalStatusForTerminalReceipt({ disposition: "waiting_approval" }).status).toBe("waiting");
    expect(canonicalStatusForTerminalReceipt({ disposition: "blocked" }).status).toBe("blocked");
    expect(canonicalStatusForTerminalReceipt({ disposition: "failed" }).status).toBe("failed");
    expect(canonicalStatusForTerminalReceipt({ disposition: "canceled" }).status).toBe("canceled");
  });
});
