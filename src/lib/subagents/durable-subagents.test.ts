import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_AGENT_RUN_BUDGET_LIMITS } from "@/lib/runs/budgets";
import { createExecutionScope } from "@/lib/security/execution-scope";

function parentExecutionScope(
  owner: { tenantId: string; actorId: string },
  missionId: string,
  requestId: string,
  agentId: string,
) {
  return createExecutionScope({
    tenantId: owner.tenantId,
    initiatingActorId: owner.actorId,
    executingPrincipalType: "agent",
    executingPrincipalId: agentId,
    missionId,
    correlationId: requestId,
    contextGrantIds: [],
    capabilityGrantIds: [],
    purpose: "agent.run",
  });
}

describe("durable specialist delegation", () => {
  beforeEach(async () => {
    delete process.env.DATABASE_URL;
    delete process.env.OPENAI_API_KEY;
    delete process.env.GEMINI_API_KEY;
    process.env.OMNIAGENT_DATA_DIR = await mkdtemp(
      path.join(tmpdir(), "asael-durable-subagents-"),
    );
  });

  it("partitions delegated authority without allowing child fan-out", async () => {
    const { deriveSpecialistBudgetLimits } = await import(
      "@/lib/subagents/scheduler"
    );
    const child = deriveSpecialistBudgetLimits(
      DEFAULT_AGENT_RUN_BUDGET_LIMITS,
      2,
    );

    expect(child).toMatchObject({
      modelTurns: 3,
      tokens: 32_000,
      toolCalls: 15,
      agents: 1,
      fanOut: 0,
      retries: 1,
      replans: 0,
    });
  });

  it("prepares deterministic queued runs and jobs across supervisor retries", async () => {
    const missions = await import("@/lib/missions/store");
    const scheduler = await import("@/lib/subagents/scheduler");
    const runs = await import("@/lib/runs/store");
    const queue = await import("@/lib/operations/job-queue");
    const owner = { tenantId: "personal", actorId: "bennie" };
    const mission = await missions.createMission({
      ...owner,
      title: "Prepare a durable brief",
      objective: "Research and verify a durable brief.",
      sourceKey: "durable-specialist-idempotency",
    });
    const input = {
      owner,
      parentExecutionScope: parentExecutionScope(
        owner,
        mission.id,
        "request-1",
        "atlas",
      ),
      missionId: mission.id,
      requestId: "request-1",
      objective: mission.objective,
      mode: "research" as const,
      primaryAgentId: "atlas" as const,
      specialistIds: ["scout", "sentinel"] as const,
      parentBudgetLimits: DEFAULT_AGENT_RUN_BUDGET_LIMITS,
    };
    const first = await scheduler.prepareDurableSpecialistDelegation({
      ...input,
      specialistIds: [...input.specialistIds],
    });
    const second = await scheduler.prepareDurableSpecialistDelegation({
      ...input,
      specialistIds: [...input.specialistIds],
    });

    expect(first).toHaveLength(2);
    expect(second).toEqual(first);
    const preparedJobs = await queue.listOperationJobs(20, {
      tenantId: owner.tenantId,
      type: "agent.execute",
    });
    expect(preparedJobs).toHaveLength(2);
    expect(preparedJobs.every((job) => job.payload.ready === false)).toBe(true);
    await expect(Promise.all(first.map((item) =>
      runs.getAgentRunExecutionScope(item.runId, {
        tenantId: owner.tenantId,
      })
    ))).resolves.toEqual(first.map((item) => item.executionScope));
    await expect(Promise.all(first.map((item) =>
      runs.getAgentRun(item.runId, { tenantId: owner.tenantId })
    ))).resolves.toEqual(expect.arrayContaining([
      expect.objectContaining({ status: "queued", agentId: "scout" }),
      expect.objectContaining({ status: "queued", agentId: "sentinel" }),
    ]));
    await expect(runs.claimQueuedAgentRun(first[0].runId, {
      tenantId: owner.tenantId,
    })).resolves.toMatchObject({ status: "running" });
    await expect(runs.claimQueuedAgentRun(first[0].runId, {
      tenantId: owner.tenantId,
    })).resolves.toBeUndefined();

    const firstJobs = await scheduler.bindDurableSpecialistsToWorkflow(
      first,
      "workflow-1",
      owner,
    );
    const secondJobs = await scheduler.bindDurableSpecialistsToWorkflow(
      second,
      "workflow-1",
      owner,
    );
    expect(secondJobs.map((job) => job.id)).toEqual(
      firstJobs.map((job) => job.id),
    );
    expect(await queue.listOperationJobs(20, {
      tenantId: owner.tenantId,
      type: "agent.execute",
    })).toHaveLength(2);
    expect((await queue.listOperationJobs(20, {
      tenantId: owner.tenantId,
      type: "agent.execute",
    })).every((job) => job.payload.ready === true && job.payload.workflowRunId === "workflow-1"))
      .toBe(true);
  });

  it("does not lease new specialist work after the worker deadline", async () => {
    const missions = await import("@/lib/missions/store");
    const scheduler = await import("@/lib/subagents/scheduler");
    const worker = await import("@/lib/subagents/worker");
    const queue = await import("@/lib/operations/job-queue");
    const owner = { tenantId: "personal-deadline", actorId: "bennie" };
    const mission = await missions.createMission({
      ...owner,
      title: "Deadline safety",
      objective: "Keep unstarted work queued when the worker budget is exhausted.",
    });
    await scheduler.prepareDurableSpecialistDelegation({
      owner,
      parentExecutionScope: parentExecutionScope(
        owner,
        mission.id,
        "deadline-request",
        "atlas",
      ),
      missionId: mission.id,
      requestId: "deadline-request",
      objective: mission.objective,
      mode: "research",
      primaryAgentId: "atlas",
      specialistIds: ["sentinel"],
      parentBudgetLimits: DEFAULT_AGENT_RUN_BUDGET_LIMITS,
    });

    await expect(worker.processDurableSpecialistQueue({
      tenantId: owner.tenantId,
      limit: 2,
      deadline: Date.now(),
    })).resolves.toMatchObject({ leased: 0 });
    expect((await queue.listOperationJobs(10, {
      tenantId: owner.tenantId,
      type: "agent.execute",
    }))[0]).toMatchObject({ status: "queued" });
  });

  it("keeps an unbound outbox intent queued instead of running it prematurely", async () => {
    const missions = await import("@/lib/missions/store");
    const scheduler = await import("@/lib/subagents/scheduler");
    const worker = await import("@/lib/subagents/worker");
    const runs = await import("@/lib/runs/store");
    const queue = await import("@/lib/operations/job-queue");
    const owner = { tenantId: "personal-outbox", actorId: "bennie" };
    const mission = await missions.createMission({
      ...owner,
      title: "Crash-safe delegation",
      objective: "Do not execute until the parent workflow is durable.",
    });
    const [specialist] = await scheduler.prepareDurableSpecialistDelegation({
      owner,
      parentExecutionScope: parentExecutionScope(
        owner,
        mission.id,
        "outbox-request",
        "atlas",
      ),
      missionId: mission.id,
      requestId: "outbox-request",
      objective: mission.objective,
      mode: "research",
      primaryAgentId: "atlas",
      specialistIds: ["sentinel"],
      parentBudgetLimits: DEFAULT_AGENT_RUN_BUDGET_LIMITS,
    });

    await expect(worker.processDurableSpecialistQueue({
      tenantId: owner.tenantId,
      limit: 1,
      deadline: Date.now() + 30_000,
    })).resolves.toMatchObject({ leased: 1, stale: 1, completed: 0 });
    await expect(runs.getAgentRun(specialist.runId, {
      tenantId: owner.tenantId,
    })).resolves.toMatchObject({ status: "queued" });
    expect((await queue.listOperationJobs(10, {
      tenantId: owner.tenantId,
      type: "agent.execute",
    }))[0]).toMatchObject({ status: "queued", payload: { ready: false } });
  });

  it("joins a read-only specialist exactly once before the parent workflow starts", async () => {
    vi.doMock("@/lib/orchestration/agent-runner", () => ({
      runAgent: async function* (request: { preclaimedRunId?: string }) {
        const runId = request.preclaimedRunId;
        if (!runId) throw new Error("Expected a preclaimed durable run.");
        const runStore = await import("@/lib/runs/store");
        const response = "Sentinel verified the objective, identified rollback evidence, and found no write operation was needed.";
        await runStore.completeAgentRun(runId, response);
        yield { type: "done" as const, response };
      },
    }));
    const missions = await import("@/lib/missions/store");
    const missionRuntime = await import("@/lib/missions/runtime");
    const scheduler = await import("@/lib/subagents/scheduler");
    const subagentContext = await import("@/lib/subagents/context");
    const worker = await import("@/lib/subagents/worker");
    const runs = await import("@/lib/runs/store");
    const queue = await import("@/lib/operations/job-queue");
    const workflows = await import("@/lib/workflows/store");
    const workflowRunner = await import("@/lib/workflows/runner");
    const owner = { tenantId: "personal-worker", actorId: "bennie" };
    const mission = await missions.createMission({
      ...owner,
      title: "Verify the launch plan",
      objective: "Produce a safe launch plan with evidence.",
      sourceKey: "durable-specialist-worker",
      priority: "high",
    });
    const specialists = await scheduler.prepareDurableSpecialistDelegation({
      owner,
      parentExecutionScope: parentExecutionScope(
        owner,
        mission.id,
        "request-worker",
        "scout",
      ),
      missionId: mission.id,
      requestId: "request-worker",
      objective: mission.objective,
      mode: "research",
      primaryAgentId: "scout",
      specialistIds: ["scout"],
      parentBudgetLimits: DEFAULT_AGENT_RUN_BUDGET_LIMITS,
    });
    expect(specialists).toHaveLength(1);
    expect(specialists[0].agentId).toBe("sentinel");

    const mainTask = await missions.ensureMissionTask(mission.id, {
      sourceKey: "main-workflow-task",
      title: "Execute the parent workflow",
      dependencyIds: specialists.map((item) => item.taskId),
    }, owner);
    const workflow = await workflows.createWorkflowRun({
      tenantId: owner.tenantId,
      goal: mission.objective,
      mode: "research",
      requireApproval: false,
      metadata: {
        actorId: owner.actorId,
        missionId: mission.id,
        missionTaskId: mainTask.id,
        specialistTaskIds: specialists.map((item) => item.taskId),
        specialistRunIds: specialists.map((item) => item.runId),
      },
      idempotencyKey: "durable-specialist-workflow",
    });
    await missionRuntime.attachMissionExecutor({
      taskId: mainTask.id,
      executorType: "workflow_run",
      executorId: workflow.run.id,
      status: "queued",
    }, owner);
    await scheduler.bindDurableSpecialistsToWorkflow(
      specialists,
      workflow.run.id,
      owner,
    );

    const pending = await subagentContext.inspectWorkflowSpecialistDependencies(workflow);
    expect(pending).toMatchObject({ state: "pending" });
    const gated = await workflowRunner.tickWorkflowRun(workflow.run.id, {
      tenantId: owner.tenantId,
    });
    expect(gated.run.status).toBe("queued");
    expect(gated.steps.every((step) => step.attempt === 0)).toBe(true);
    await expect(
      missions.transitionMissionTask(mainTask.id, "running", owner),
    ).rejects.toThrow(/dependencies must succeed/i);

    await expect(worker.processDurableSpecialistQueue({
      tenantId: owner.tenantId,
      limit: 2,
    })).resolves.toMatchObject({ leased: 1, completed: 1, failed: 0 });

    const specialistRun = await runs.getAgentRun(specialists[0].runId, {
      tenantId: owner.tenantId,
    });
    expect(specialistRun).toMatchObject({ status: "completed" });
    const missionAfter = await missions.getMissionDetail(mission.id, owner);
    expect(missionAfter?.tasks.find((task) => task.id === specialists[0].taskId))
      .toMatchObject({ status: "succeeded" });
    expect(missionAfter?.artifacts).toEqual(expect.arrayContaining([
      expect.objectContaining({
        taskId: specialists[0].taskId,
        kind: "specialist_result",
      }),
    ]));

    const readyWorkflow = await workflows.getWorkflowRunDetail(workflow.run.id, {
      tenantId: owner.tenantId,
    });
    expect(readyWorkflow).toBeTruthy();
    await expect(
      subagentContext.inspectWorkflowSpecialistDependencies(readyWorkflow!),
    ).resolves.toMatchObject({ state: "ready" });

    const preflight = await workflowRunner.tickWorkflowRun(workflow.run.id, {
      tenantId: owner.tenantId,
    });
    expect(preflight.run.status).toBe("queued");
    expect(preflight.steps.find((step) => step.stepKey === "preflight"))
      .toMatchObject({ status: "completed", attempt: 1 });
    const retrieved = await workflowRunner.tickWorkflowRun(workflow.run.id, {
      tenantId: owner.tenantId,
    });
    expect(retrieved.steps.find((step) => step.stepKey === "retrieve_context")?.output)
      .toMatchObject({ specialistCount: 1 });
    expect(JSON.stringify(
      retrieved.steps.find((step) => step.stepKey === "retrieve_context")?.output,
    )).toContain("durable_read_only_subagents");

    const terminalJob = await queue.listOperationJobs(20, {
      tenantId: owner.tenantId,
      type: "agent.execute",
    });
    expect(terminalJob[0]).toMatchObject({ status: "completed" });
    await scheduler.bindDurableSpecialistsToWorkflow(
      specialists,
      workflow.run.id,
      owner,
    );
    await expect(worker.processDurableSpecialistQueue({
      tenantId: owner.tenantId,
      limit: 2,
    })).resolves.toMatchObject({ leased: 0 });
    await expect(runs.getAgentRun(specialists[0].runId, {
      tenantId: owner.tenantId,
    })).resolves.toMatchObject({
      status: "completed",
      startedAt: specialistRun?.startedAt,
    });
  }, 30_000);

  it("fails the parent workflow without claiming a step when a dependency fails", async () => {
    const missions = await import("@/lib/missions/store");
    const missionRuntime = await import("@/lib/missions/runtime");
    const workflows = await import("@/lib/workflows/store");
    const workflowRunner = await import("@/lib/workflows/runner");
    const owner = { tenantId: "personal-failed-gate", actorId: "bennie" };
    const mission = await missions.createMission({
      ...owner,
      title: "Fail closed",
      objective: "Do not start after failed evidence review.",
      sourceKey: "failed-specialist-gate",
    });
    const dependency = await missions.ensureMissionTask(mission.id, {
      sourceKey: "failed-dependency",
      title: "Review evidence",
    }, owner);
    const mainTask = await missions.ensureMissionTask(mission.id, {
      sourceKey: "blocked-main",
      title: "Execute only after review",
      dependencyIds: [dependency.id],
    }, owner);
    await missions.transitionMissionTask(dependency.id, "failed", owner);
    const workflow = await workflows.createWorkflowRun({
      tenantId: owner.tenantId,
      goal: mission.objective,
      requireApproval: false,
      metadata: {
        actorId: owner.actorId,
        missionId: mission.id,
        missionTaskId: mainTask.id,
        specialistTaskIds: [dependency.id],
      },
      idempotencyKey: "failed-specialist-workflow",
    });
    await missionRuntime.attachMissionExecutor({
      taskId: mainTask.id,
      executorType: "workflow_run",
      executorId: workflow.run.id,
      status: "queued",
    }, owner);

    const failed = await workflowRunner.tickWorkflowRun(workflow.run.id, {
      tenantId: owner.tenantId,
    });
    expect(failed.run).toMatchObject({
      status: "failed",
      error: expect.stringMatching(/dependencies failed/i),
    });
    expect(failed.steps.every((step) => step.attempt === 0)).toBe(true);
    await expect(missions.getMissionDetail(mission.id, owner)).resolves.toMatchObject({
      mission: { status: "failed" },
      tasks: expect.arrayContaining([
        expect.objectContaining({ id: mainTask.id, status: "failed" }),
      ]),
    });
  });
});
