import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { listStreamEvents } from "@/lib/events/store";
import { createExecutionScope } from "@/lib/security/execution-scope";

beforeAll(async () => {
  process.env.OMNIAGENT_DATA_DIR = await mkdtemp(path.join(tmpdir(), "omni-workflow-cas-"));
  delete process.env.DATABASE_URL;
});

describe("workflow conditional transitions (file mode)", () => {
  it("keeps private workflow payloads out of the canonical event log", async () => {
    const store = await import("@/lib/workflows/store");
    const executionScope = createExecutionScope({
      tenantId: "tenant-workflow-events",
      initiatingActorId: "workflow-owner",
      executingPrincipalType: "user",
      executingPrincipalId: "workflow-owner",
      correlationId: "workflow-request-1",
      purpose: "workflow.run",
    });
    const detail = await store.createWorkflowRun({
      tenantId: "tenant-workflow-events",
      goal: "Private workflow objective",
      executionAuthority: {
        executionScope,
        requesterRole: "admin",
      },
    });
    await store.appendWorkflowEvent(
      detail.run.id,
      "workflow.private_result_observed",
      { report: "Private generated report", status: "completed" },
    );

    const events = await listStreamEvents(`workflow:${detail.run.id}`, {
      tenantId: "tenant-workflow-events",
    });
    const created = events.find((event) => event.type === "workflow.created");
    const observed = events.find(
      (event) => event.type === "workflow.private_result_observed",
    );
    expect(created).toMatchObject({
      actorId: "workflow-owner",
      correlationId: "workflow-request-1",
      payload: {
        schemaVersion: 1,
        eventType: "workflow.created",
        payloadFieldCount: 1,
      },
    });
    expect(observed).toMatchObject({
      actorId: "workflow-owner",
      correlationId: "workflow-request-1",
      payload: {
        schemaVersion: 1,
        eventType: "workflow.private_result_observed",
        payloadFieldCount: 2,
      },
    });
    expect(JSON.stringify(events)).not.toContain("Private workflow objective");
    expect(JSON.stringify(events)).not.toContain("Private generated report");
  });

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

  it("commits terminal state and scoped outcome events together", async () => {
    const store = await import("@/lib/workflows/store");
    const executionScope = createExecutionScope({
      tenantId: "tenant-terminal-events",
      initiatingActorId: "workflow-owner",
      executingPrincipalType: "user",
      executingPrincipalId: "workflow-owner",
      correlationId: "workflow-terminal-request",
      purpose: "workflow.run",
    });
    const authority = { executionScope, requesterRole: "admin" as const };
    const detail = await store.createWorkflowRun({
      tenantId: "tenant-terminal-events",
      goal: "Finish with an exact outcome receipt",
      executionAuthority: authority,
    });
    const running = await store.transitionWorkflowRun(
      detail.run.id,
      ["queued"],
      { status: "running" },
      { tenantId: "tenant-terminal-events" },
    );

    const completed = await store.transitionWorkflowRunWithEvents(
      detail.run.id,
      ["running"],
      {
        status: "completed",
        result: { report: "Private report", outcomeEvaluation: { exact: true } },
        completedAt: new Date().toISOString(),
      },
      [
        {
          type: "workflow.outcome_evaluated",
          payload: { disposition: "verified_success", privateEvidence: "secret" },
        },
        { type: "workflow.completed", payload: {} },
      ],
      {
        tenantId: "tenant-terminal-events",
        expectedUpdatedAt: running!.updatedAt,
        executionAuthority: authority,
      },
    );

    expect(completed).toMatchObject({ status: "completed" });
    await expect(
      store.getWorkflowRunDetail(detail.run.id, {
        tenantId: "tenant-terminal-events",
      }),
    ).resolves.toMatchObject({
      run: { status: "completed", result: { report: "Private report" } },
      events: expect.arrayContaining([
        expect.objectContaining({ type: "workflow.outcome_evaluated" }),
        expect.objectContaining({ type: "workflow.completed" }),
      ]),
    });
    const canonical = await listStreamEvents(`workflow:${detail.run.id}`, {
      tenantId: "tenant-terminal-events",
    });
    const terminal = canonical.filter((event) =>
      event.type === "workflow.outcome_evaluated" ||
      event.type === "workflow.completed"
    );
    expect(terminal).toHaveLength(2);
    expect(terminal.every((event) =>
      event.actorId === "workflow-owner" &&
      event.correlationId === "workflow-terminal-request"
    )).toBe(true);
    expect(JSON.stringify(terminal)).not.toContain("secret");
  });

  it("rejects an unscoped terminal write before changing state", async () => {
    const store = await import("@/lib/workflows/store");
    const executionScope = createExecutionScope({
      tenantId: "tenant-terminal-authority",
      initiatingActorId: "workflow-owner",
      executingPrincipalType: "user",
      executingPrincipalId: "workflow-owner",
      correlationId: "workflow-terminal-authority",
      purpose: "workflow.run",
    });
    const detail = await store.createWorkflowRun({
      tenantId: "tenant-terminal-authority",
      goal: "Reject an unattributed completion",
      executionAuthority: { executionScope, requesterRole: "admin" },
    });
    await store.transitionWorkflowRun(
      detail.run.id,
      ["queued"],
      { status: "running" },
      { tenantId: "tenant-terminal-authority" },
    );

    await expect(store.transitionWorkflowRunWithEvents(
      detail.run.id,
      ["running"],
      { status: "completed", completedAt: new Date().toISOString() },
      [{ type: "workflow.completed" }],
      { tenantId: "tenant-terminal-authority" },
    )).rejects.toBeInstanceOf(store.WorkflowRunExecutionScopeBindingError);
    const unchanged = await store.getWorkflowRunDetail(detail.run.id, {
      tenantId: "tenant-terminal-authority",
    });
    expect(unchanged?.run.status).toBe("running");
    expect(unchanged?.events.some((event) => event.type === "workflow.completed"))
      .toBe(false);
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
    }, {
      tenantId: "tenant-cas",
      events: [{ type: "step.started" }],
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
        events: [{ type: "step.started" }],
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
          events: [{ type: "step.completed" }],
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

  it("reclaims a released workflow on its first reset delivery under its live lease", async () => {
    const store = await import("@/lib/workflows/store");
    const queue = await import("@/lib/operations/job-queue");
    const tenantId = "tenant-quarantine-redelivery";
    const detail = await store.createWorkflowRun({
      tenantId, goal: "Recover a released interrupted workflow",
    });
    await store.transitionWorkflowRun(detail.run.id, ["queued"], {
      status: "running", currentStep: "preflight",
    }, { tenantId });
    await store.updateWorkflowStep(detail.run.id, "preflight", {
      status: "running", attempt: 1,
    }, { tenantId, events: [{ type: "step.started" }] });
    const input = {
      tenantId,
      type: "workflow.tick" as const,
      dedupeKey: `workflow:${detail.run.id}`,
      payload: { workflowRunId: detail.run.id },
    };
    const job = await queue.enqueueOperationJob(input);
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      for (let lapse = 0; lapse < queue.OPERATION_JOB_QUARANTINE_LAPSES; lapse += 1) {
        const [leased] = await queue.leaseOperationJobs({ tenantId, leaseSeconds: 10 });
        if (lapse === 0) {
          await expect(store.reclaimWorkflowRunForQueueDelivery(detail.run.id, {
            tenantId, jobId: job.id, leaseOwner: leased.leaseOwner!,
            deliveryAttempt: 1, releasedFromQuarantine: true,
          })).resolves.toBe("stale");
        }
        vi.setSystemTime(Date.now() + 11_000);
        await queue.repairExpiredOperationJobs({ tenantId });
      }
      await expect(queue.releaseQuarantinedOperationJob(job.id, { tenantId }))
        .resolves.toMatchObject({ outcome: "released", job: { attempt: 0 } });
      // Operator ticking/bootstrap can coalesce the tick before dispatch.
      await queue.enqueueOperationJob(input);
      const [leased] = await queue.leaseOperationJobs({ tenantId, leaseSeconds: 10 });
      expect(leased).toMatchObject({
        attempt: 1, payload: { __workflowQuarantineReleased: true },
      });
      const reclaim = {
        tenantId, jobId: job.id, leaseOwner: leased.leaseOwner!,
        deliveryAttempt: leased.attempt, releasedFromQuarantine: true,
      };
      await expect(store.reclaimWorkflowRunForQueueDelivery(detail.run.id, {
        ...reclaim, leaseOwner: "former-worker",
      })).resolves.toBe("stale");
      await expect(store.reclaimWorkflowRunForQueueDelivery(detail.run.id, reclaim))
        .resolves.toBe("requeued");
      await expect(store.getWorkflowRunDetail(detail.run.id, { tenantId }))
        .resolves.toMatchObject({
          run: { status: "queued" },
          steps: expect.arrayContaining([
            expect.objectContaining({ stepKey: "preflight", status: "pending", attempt: 1 }),
          ]),
        });
      const completed = await queue.completeOperationJob(job.id, leased.leaseOwner, tenantId);
      expect(completed?.payload).not.toHaveProperty("__workflowQuarantineReleased");
    } finally {
      vi.useRealTimers();
    }
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

  it("attributes reviewed plan creation and claim without logging plan content", async () => {
    const planner = await import("@/lib/workflows/planner");
    const store = await import("@/lib/workflows/store");
    const executionScope = createExecutionScope({
      tenantId: "tenant-plan-ledger",
      initiatingActorId: "plan-owner",
      executingPrincipalType: "user",
      executingPrincipalId: "plan-owner",
      correlationId: "workflow-plan-request-1",
      purpose: "workflow.plan.create",
    });
    const plan = await planner.buildDynamicWorkflowPlan({
      tenantId: "tenant-plan-ledger",
      actorId: "plan-owner",
      goal: "Private reviewed workflow plan content",
      executionScope,
    });
    const createdEvents = await listStreamEvents(`workflow-plan:${plan.id}`, {
      tenantId: "tenant-plan-ledger",
    });
    expect(createdEvents).toEqual([
      expect.objectContaining({
        actorId: "plan-owner",
        correlationId: "workflow-plan-request-1",
        type: "workflow.plan.created",
        payload: expect.objectContaining({
          schemaVersion: 1,
          planId: plan.id,
          goalSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
          planSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
          idempotencyKeySha256: expect.stringMatching(/^[a-f0-9]{64}$/),
        }),
      }),
    ]);

    const workflow = await store.createWorkflowRun({
      tenantId: "tenant-plan-ledger",
      goal: plan.goal,
      executionAuthority: { executionScope, requesterRole: "admin" },
    });
    await planner.claimWorkflowPlanForRun({
      planId: plan.id,
      workflowRunId: workflow.run.id,
      tenantId: "tenant-plan-ledger",
    });
    const workflowEvents = await listStreamEvents(`workflow:${workflow.run.id}`, {
      tenantId: "tenant-plan-ledger",
    });
    expect(workflowEvents).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: "workflow.plan.claimed",
        payload: expect.objectContaining({
          planId: plan.id,
          workflowRunId: workflow.run.id,
          idempotencyKeySha256: expect.stringMatching(/^[a-f0-9]{64}$/),
        }),
      }),
    ]));
    expect(JSON.stringify([...createdEvents, ...workflowEvents])).not.toContain(
      "Private reviewed workflow plan content",
    );
  });
});
