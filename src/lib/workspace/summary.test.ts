import { describe, expect, it, vi } from "vitest";
import { loadWorkspaceSummary } from "@/lib/workspace/summary";

describe("workspace summary", () => {
  it("loads tenant-scoped sources independently and projects private fields", async () => {
    const listRuns = vi.fn().mockResolvedValue([
      {
        id: "run-1",
        tenantId: "tenant-a",
        mode: "research",
        status: "completed",
        prompt: "Summarize",
        response: "Done",
        messages: [{ role: "user", content: "private" }],
        memoryContextCount: 1,
        continuation: {
          pendingToolCall: {
            executionId: "execution-1",
            toolId: "tool-1",
            toolName: "Private tool",
          },
          secret: true,
        },
        startedAt: "2026-08-23T00:00:00.000Z",
        completedAt: "2026-08-23T00:00:01.000Z",
      },
    ]);
    const listWorkflows = vi.fn().mockRejectedValue(new Error("workflow unavailable"));
    const getApprovals = vi.fn().mockResolvedValue({
      items: [
        {
          kind: "tool",
          id: "approval-1",
          title: "Approve tool",
          status: "approval_required",
          riskLevel: 2,
          createdAt: "2026-08-23T00:00:00.000Z",
          input: { secret: true },
          record: { output: "sealed" },
        },
      ],
    });

    const summary = await loadWorkspaceSummary(
      { tenantId: "tenant-a", role: "operator", limit: 8 },
      { listRuns, listWorkflows, getApprovals },
    );

    expect(listRuns).toHaveBeenCalledWith(8, { tenantId: "tenant-a" });
    expect(listWorkflows).toHaveBeenCalledWith(8, { tenantId: "tenant-a" });
    expect(getApprovals).toHaveBeenCalledWith(8, { tenantId: "tenant-a" });
    expect(summary.sources.runs).toMatchObject({
      status: "ready",
      data: [{ id: "run-1", response: "Done" }],
    });
    expect(JSON.stringify(summary.sources.runs)).not.toContain("messages");
    expect(summary.sources.workflows).toEqual({
      status: "error",
      error: "workflow unavailable",
    });
    expect(summary.sources.approvals).toMatchObject({
      status: "ready",
      data: [{ id: "approval-1", title: "Approve tool" }],
    });
    expect(JSON.stringify(summary.sources.approvals)).not.toContain("sealed");
    expect(JSON.stringify(summary.sources.approvals)).not.toContain("secret");
  });

  it("does not query approvals for viewer sessions", async () => {
    const getApprovals = vi.fn();
    const summary = await loadWorkspaceSummary(
      { tenantId: "tenant-a", role: "viewer" },
      {
        listRuns: vi.fn().mockResolvedValue([]),
        listWorkflows: vi.fn().mockResolvedValue([]),
        getApprovals,
      },
    );

    expect(getApprovals).not.toHaveBeenCalled();
    expect(summary.sources.approvals).toEqual({
      status: "restricted",
      error: "Operator role required for approval items.",
    });
  });

  it("projects completed workflow reports for summary consumers", async () => {
    const summary = await loadWorkspaceSummary(
      { tenantId: "tenant-a", role: "viewer" },
      {
        listRuns: vi.fn().mockResolvedValue([]),
        listWorkflows: vi.fn().mockResolvedValue([
          {
            id: "workflow-1",
            workflowType: "research",
            status: "completed",
            goal: "Prepare a report",
            currentStep: "persist_report",
            attempt: 1,
            maxAttempts: 1,
            approvalRequired: false,
            result: { report: "Final workflow report" },
            createdAt: "2026-08-23T00:00:00.000Z",
            updatedAt: "2026-08-23T00:00:01.000Z",
            completedAt: "2026-08-23T00:00:01.000Z",
          },
        ]),
        getApprovals: vi.fn(),
      },
    );

    expect(summary.sources.workflows).toMatchObject({
      status: "ready",
      data: [{ id: "workflow-1", report: "Final workflow report" }],
    });
  });
});
