import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";

beforeAll(async () => {
  process.env.OMNIAGENT_DATA_DIR = await mkdtemp(path.join(tmpdir(), "omni-workflow-cas-"));
  delete process.env.DATABASE_URL;
});

describe("workflow conditional transitions (file mode)", () => {
  it("returns a tenant-scoped status projection without workflow history", async () => {
    const store = await import("@/lib/workflows/store");
    const detail = await store.createWorkflowRun({
      tenantId: "tenant-status",
      goal: "Poll only workflow status",
    });

    await expect(
      store.getWorkflowRunStatus(detail.run.id, {
        tenantId: "tenant-status",
      }),
    ).resolves.toEqual({
      id: detail.run.id,
      status: "queued",
      currentStep: "preflight",
      error: undefined,
      updatedAt: expect.any(String),
      completedAt: undefined,
    });
    await expect(
      store.getWorkflowRunStatus(detail.run.id, {
        tenantId: "other-tenant",
      }),
    ).resolves.toBeNull();
  });

  it("claims a queued run once and fences stale completion after pause", async () => {
    const store = await import("@/lib/workflows/store");
    const detail = await store.createWorkflowRun({
      tenantId: "tenant-cas",
      goal: "Exercise conditional workflow transitions",
    });

    const claims = await Promise.all(
      Array.from({ length: 12 }, () =>
        store.transitionWorkflowRun(
          detail.run.id,
          ["queued"],
          { status: "running" },
          { tenantId: "tenant-cas" },
        ),
      ),
    );
    expect(claims.filter(Boolean)).toHaveLength(1);

    await expect(store.transitionWorkflowRun(
      detail.run.id,
      ["running"],
      { status: "paused", pausedAt: new Date().toISOString() },
      { tenantId: "tenant-cas" },
    )).resolves.toMatchObject({ status: "paused" });

    await expect(store.transitionWorkflowRun(
      detail.run.id,
      ["running"],
      { status: "completed", completedAt: new Date().toISOString() },
      { tenantId: "tenant-cas" },
    )).resolves.toBeNull();
    await expect(
      store.getWorkflowRunDetail(detail.run.id, { tenantId: "tenant-cas" }),
    ).resolves.toMatchObject({ run: { status: "paused" } });
  });

  it("reports invalid workflow signals without changing state", async () => {
    const store = await import("@/lib/workflows/store");
    const {
      signalWorkflowRun,
      WorkflowSignalConflictError,
    } = await import("@/lib/workflows/runner");
    const detail = await store.createWorkflowRun({
      tenantId: "tenant-cas",
      goal: "Reject an invalid resume signal",
    });

    await expect(
      signalWorkflowRun(detail.run.id, "resume", {
        tenantId: "tenant-cas",
      }),
    ).rejects.toBeInstanceOf(WorkflowSignalConflictError);
    await expect(
      store.getWorkflowRunDetail(detail.run.id, { tenantId: "tenant-cas" }),
    ).resolves.toMatchObject({ run: { status: "queued" } });
  });

  it("atomically releases an approval gate only once", async () => {
    const store = await import("@/lib/workflows/store");
    const detail = await store.createWorkflowRun({
      tenantId: "tenant-cas",
      goal: "Release one approval gate",
    });
    await store.updateWorkflowStep(detail.run.id, "approval_gate", {
      status: "running",
    });
    await store.transitionWorkflowRun(
      detail.run.id,
      ["queued"],
      { status: "waiting_approval", currentStep: "approval_gate" },
      { tenantId: "tenant-cas" },
    );

    const approvals = await Promise.all(
      Array.from({ length: 8 }, () =>
        store.approveWorkflowRun(detail.run.id, {
          tenantId: "tenant-cas",
        }),
      ),
    );
    expect(approvals.filter(Boolean)).toHaveLength(1);
    await expect(
      store.getWorkflowRunDetail(detail.run.id, {
        tenantId: "tenant-cas",
      }),
    ).resolves.toMatchObject({
      run: {
        status: "queued",
        currentStep: "execute",
      },
      steps: expect.arrayContaining([
        expect.objectContaining({
          stepKey: "approval_gate",
          status: "completed",
        }),
      ]),
    });
  });

  it("reclaims an interrupted redelivery and fences the stale owner", async () => {
    const store = await import("@/lib/workflows/store");
    const detail = await store.createWorkflowRun({
      tenantId: "tenant-redelivery",
      goal: "Recover an interrupted workflow delivery",
    });
    const running = await store.transitionWorkflowRun(
      detail.run.id,
      ["queued"],
      { status: "running", currentStep: "preflight" },
      { tenantId: "tenant-redelivery" },
    );
    expect(running).toBeTruthy();
    await store.updateWorkflowStepForRunFence(
      detail.run.id,
      "preflight",
      { status: "running", attempt: 1, startedAt: new Date().toISOString() },
      {
        tenantId: "tenant-redelivery",
        expectedRunUpdatedAt: running!.updatedAt,
      },
    );

    await expect(
      store.reclaimWorkflowRunForQueueDelivery(detail.run.id, {
        tenantId: "tenant-redelivery",
        jobId: "job-redelivery",
        leaseOwner: "worker-b",
        deliveryAttempt: 2,
      }),
    ).resolves.toBe("requeued");
    await expect(
      store.updateWorkflowStepForRunFence(
        detail.run.id,
        "preflight",
        { status: "completed" },
        {
          tenantId: "tenant-redelivery",
          expectedRunUpdatedAt: running!.updatedAt,
        },
      ),
    ).resolves.toBeNull();
    await expect(
      store.getWorkflowRunDetail(detail.run.id, {
        tenantId: "tenant-redelivery",
      }),
    ).resolves.toMatchObject({
      run: { status: "queued" },
      steps: expect.arrayContaining([
        expect.objectContaining({
          stepKey: "preflight",
          status: "pending",
          attempt: 1,
        }),
      ]),
    });
  });

  it("reuses one run when a reviewed plan start is retried", async () => {
    const planner = await import("@/lib/workflows/planner");
    const store = await import("@/lib/workflows/store");
    const plan = await planner.buildDynamicWorkflowPlan({
      tenantId: "tenant-cas",
      goal: "Execute one reviewed plan exactly once",
      mode: "orchestrate",
      requireApproval: true,
    });
    const input = {
      tenantId: "tenant-cas",
      goal: plan.goal,
      mode: plan.plan.mode,
      requireApproval: plan.approvalRequired,
      idempotencyKey: `reviewed-plan:${plan.id}`,
    } as const;

    const [first, retry] = await Promise.all([
      store.createWorkflowRun(input),
      store.createWorkflowRun(input),
    ]);
    expect(retry.run.id).toBe(first.run.id);

    const claims = await Promise.all([
      planner.claimWorkflowPlanForRun({
        planId: plan.id,
        workflowRunId: first.run.id,
        tenantId: "tenant-cas",
      }),
      planner.claimWorkflowPlanForRun({
        planId: plan.id,
        workflowRunId: retry.run.id,
        tenantId: "tenant-cas",
      }),
    ]);
    expect(claims.filter(Boolean)).toHaveLength(1);
    await expect(
      planner.getWorkflowPlanById(plan.id, { tenantId: "tenant-cas" }),
    ).resolves.toMatchObject({ workflowRunId: first.run.id });
  });
});
