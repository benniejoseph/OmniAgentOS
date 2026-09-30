import { createHash } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getAgentRun: vi.fn(),
  getWorkflowRun: vi.fn(),
  actorScopes: [] as Array<[string, readonly string[]]>,
}));

vi.mock("@/lib/db/client", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/db/client")>();
  return {
    ...original,
    runWithDatabaseActorScope: <T,>(
      tenantId: string,
      actorIds: readonly string[],
      operation: () => T | Promise<T>,
    ) => {
      mocks.actorScopes.push([tenantId, actorIds]);
      return original.runWithDatabaseActorScope(tenantId, actorIds, operation);
    },
  };
});
vi.mock("@/lib/runs/store", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/runs/store")>()),
  getAgentRun: mocks.getAgentRun,
}));
vi.mock("@/lib/workflows/store", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/workflows/store")>()),
  getWorkflowRun: mocks.getWorkflowRun,
}));

import { reconcileMissionProjections } from "@/lib/missions/reconcile";
import {
  attachMissionExecutor,
  syncMissionExecutor,
} from "@/lib/missions/runtime";
import {
  createMission,
  ensureMissionTask,
  getMissionDetail,
  requestMissionTaskChanges,
  transitionMissionAttempt,
  transitionMissionTask,
} from "@/lib/missions/store";

const tenantId = "tenant-mission-repair";
const startedAt = Date.parse("2026-09-30T12:00:00.000Z");
const atMinute = (minute: number) =>
  new Date(startedAt + minute * 60_000).toISOString();
const sha256 = (text: string) =>
  createHash("sha256").update(text).digest("hex");

/** A mission with one task whose attempt started on the given run. */
async function taskOnRun(
  executorId: string,
  options: {
    executorType?: "agent_run" | "workflow_run";
    payload?: Record<string, unknown>;
    metadata?: Record<string, unknown>;
    actorId?: string;
    tenantId?: string;
  } = {},
) {
  const owner = {
    tenantId: options.tenantId || tenantId,
    actorId: options.actorId || "owner-a",
  };
  const mission = await createMission({
    ...owner,
    title: `Mission for ${executorId}`,
    objective: "Finish one task.",
    sourceKey: `mission:${executorId}`,
  });
  const task = await ensureMissionTask(mission.id, {
    sourceKey: `task:${executorId}`,
    title: `Task for ${executorId}`,
    metadata: options.metadata,
  }, owner);
  const attempt = await attachMissionExecutor({
    taskId: task.id,
    executorType: options.executorType || "agent_run",
    executorId,
    status: "running",
    payload: options.payload,
  }, owner);
  return { mission, task, attempt, owner };
}

function agentRun(
  status: string,
  completedAt?: string,
  details: Record<string, unknown> = {},
) {
  return { tenantId, status, startedAt: atMinute(0), completedAt, ...details };
}

describe("mission projection repair", () => {
  let errorLog: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    delete process.env.DATABASE_URL;
    process.env.OMNIAGENT_DATA_DIR = await mkdtemp(
      path.join(os.tmpdir(), "asael-mission-repair-"),
    );
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(startedAt);
    mocks.getAgentRun.mockReset().mockResolvedValue(null);
    mocks.getWorkflowRun.mockReset().mockResolvedValue(null);
    mocks.actorScopes.length = 0;
    errorLog = vi.spyOn(console, "error").mockImplementation(() => undefined);
  });

  afterEach(() => {
    errorLog.mockRestore();
    vi.useRealTimers();
  });

  it("finishes the task and mission of an agent run that ended without them", async () => {
    const { mission, owner } = await taskOnRun("run-ended");
    const foreign = await taskOnRun("run-foreign", { tenantId: "tenant-other" });
    // An end exactly two minutes old is settled.
    mocks.getAgentRun.mockResolvedValue(
      agentRun("completed", atMinute(1), { response: "The brief is ready." }),
    );
    vi.setSystemTime(startedAt + 3 * 60_000);

    await expect(reconcileMissionProjections({ tenantId })).resolves.toEqual({
      repaired: 1,
      failed: 0,
    });

    expect(mocks.getAgentRun.mock.calls).toEqual([["run-ended", { tenantId }]]);
    expect(await getMissionDetail(mission.id, owner)).toMatchObject({
      mission: { status: "succeeded" },
      tasks: [{ status: "succeeded" }],
      attempts: [{
        status: "succeeded",
        output: {
          responseLength: 19,
          responseSha256: sha256("The brief is ready."),
        },
      }],
      artifacts: [{ kind: "execution_receipt" }],
    });
    expect(await getMissionDetail(foreign.mission.id, foreign.owner)).toMatchObject({
      tasks: [{ status: "running" }],
      attempts: [{ status: "running" }],
    });
  });

  it.each([
    [
      "completed",
      // A write after its end moves its update time, not its end.
      { status: "completed", completedAt: atMinute(0.5), updatedAt: atMinute(1.5), result: { report: "Weekly report" } },
      { status: "succeeded", output: { verified: true, reportLength: 13, reportSha256: sha256("Weekly report") } },
    ],
    [
      "failed",
      { status: "failed", updatedAt: atMinute(0.5), error: "The calendar source stopped answering." },
      { status: "failed", error: "The calendar source stopped answering." },
    ],
  ])("ends the task of a workflow run that %s as its run ended", async (
    _,
    run,
    attempt,
  ) => {
    const { mission, owner } = await taskOnRun("workflow-ended", {
      executorType: "workflow_run",
    });
    mocks.getWorkflowRun.mockResolvedValue({ tenantId, ...run });
    vi.setSystemTime(startedAt + 3 * 60_000);

    await expect(reconcileMissionProjections({ tenantId })).resolves.toEqual({
      repaired: 1,
      failed: 0,
    });

    expect(mocks.getWorkflowRun.mock.calls).toEqual([["workflow-ended", { tenantId }]]);
    expect(await getMissionDetail(mission.id, owner)).toMatchObject({
      mission: { status: attempt.status },
      tasks: [{ status: attempt.status }],
      attempts: [attempt],
    });
  });

  it.each([
    ["is still running", agentRun("running")],
    ["ended under two minutes ago", agentRun("completed", atMinute(1.5), { response: "Done." })],
    ["cannot be found", null],
  ])("leaves an attempt whose run %s", async (_, run) => {
    const { mission, owner } = await taskOnRun("run-open");
    mocks.getAgentRun.mockResolvedValue(run);
    vi.setSystemTime(startedAt + 3 * 60_000);

    await expect(reconcileMissionProjections({ tenantId })).resolves.toEqual({
      repaired: 0,
      failed: 0,
    });

    expect(mocks.getAgentRun).toHaveBeenCalledTimes(1);
    expect(await getMissionDetail(mission.id, owner)).toMatchObject({
      mission: { status: "running" },
      tasks: [{ status: "running" }],
      attempts: [{ status: "running" }],
    });
  });

  it("leaves the open attempt of a task that was canceled", async () => {
    const { mission, task, owner } = await taskOnRun("run-task-canceled");
    await transitionMissionTask(task.id, "canceled", owner);
    mocks.getAgentRun.mockResolvedValue(agentRun("completed", atMinute(0.5)));
    vi.setSystemTime(startedAt + 3 * 60_000);

    // Only the mission, whose one task ended, is repaired.
    await expect(reconcileMissionProjections({ tenantId })).resolves.toEqual({
      repaired: 1,
      failed: 0,
    });

    expect(mocks.getAgentRun).not.toHaveBeenCalled();
    expect(await getMissionDetail(mission.id, owner)).toMatchObject({
      mission: { status: "canceled" },
      tasks: [{ status: "canceled" }],
      attempts: [{ status: "running" }],
    });
  });

  it("leaves a workflow's attempt whose run ended under two minutes ago", async () => {
    const { mission, owner } = await taskOnRun("workflow-recent", {
      executorType: "workflow_run",
    });
    mocks.getWorkflowRun.mockResolvedValue({
      tenantId,
      status: "failed",
      updatedAt: atMinute(1.5),
      error: "The calendar source stopped answering.",
    });
    vi.setSystemTime(startedAt + 3 * 60_000);

    await expect(reconcileMissionProjections({ tenantId })).resolves.toEqual({
      repaired: 0,
      failed: 0,
    });

    expect(mocks.getWorkflowRun).toHaveBeenCalledTimes(1);
    expect((await getMissionDetail(mission.id, owner))?.tasks[0].status)
      .toBe("running");
  });

  it.each([
    ["failed", 0.5, 1],
    ["running", 1.5, 0],
  ])("leaves the task %s when its attempt ended at minute %s", async (
    status,
    minute,
    repaired,
  ) => {
    const { mission, attempt, owner } = await taskOnRun("run-attempt-ended");
    vi.setSystemTime(startedAt + minute * 60_000);
    await transitionMissionAttempt(attempt.id, "failed", {
      fenceToken: attempt.fenceToken,
      error: "The run stopped.",
      agentRunId: attempt.agentRunId,
    }, owner);
    vi.setSystemTime(startedAt + 3 * 60_000);

    await expect(reconcileMissionProjections({ tenantId })).resolves.toEqual({
      repaired,
      failed: 0,
    });

    expect(mocks.getAgentRun).not.toHaveBeenCalled();
    expect(await getMissionDetail(mission.id, owner)).toMatchObject({
      mission: { status },
      tasks: [{ status }],
      attempts: [{ status: "failed", error: "The run stopped." }],
    });
  });

  it("leaves a task a reviewer sent back after its attempt ended", async () => {
    const { mission, task, owner } = await taskOnRun("run-reviewed", {
      metadata: { reviewRequired: true },
    });
    vi.setSystemTime(startedAt + 30_000);
    await syncMissionExecutor({
      executorType: "agent_run",
      executorId: "run-reviewed",
      status: "succeeded",
    }, owner);
    vi.setSystemTime(startedAt + 45_000);
    await requestMissionTaskChanges(task.id, {
      reason: "Cite the sources.",
      sourceKey: "review:run-reviewed",
    }, owner);
    vi.setSystemTime(startedAt + 3 * 60_000);

    await expect(reconcileMissionProjections({ tenantId })).resolves.toEqual({
      repaired: 0,
      failed: 0,
    });

    expect(await getMissionDetail(mission.id, owner)).toMatchObject({
      tasks: [{ status: "pending" }],
      attempts: [{ status: "succeeded" }],
    });
  });

  it.each([
    ["its run ended", false],
    ["its attempt ended", true],
  ])("keeps a specialist's findings before its task succeeds when %s", async (
    _,
    attemptEnded,
  ) => {
    const { mission, attempt, owner } = await taskOnRun("run-specialist", {
      payload: { kind: "durable_specialist", agentId: "scout" },
    });
    const response = "Three suppliers ship by Friday.";
    mocks.getAgentRun.mockResolvedValue(
      agentRun("completed", atMinute(0.5), { response }),
    );
    if (attemptEnded) {
      vi.setSystemTime(startedAt + 30_000);
      await transitionMissionAttempt(attempt.id, "succeeded", {
        fenceToken: attempt.fenceToken,
        agentRunId: attempt.agentRunId,
      }, owner);
    }
    vi.setSystemTime(startedAt + 3 * 60_000);

    await expect(reconcileMissionProjections({ tenantId })).resolves.toEqual({
      repaired: 1,
      failed: 0,
    });

    const detail = await getMissionDetail(mission.id, owner);
    expect(detail).toMatchObject({
      tasks: [{ status: "succeeded" }],
      attempts: [{ status: "succeeded" }],
    });
    expect(detail?.artifacts).toContainEqual(expect.objectContaining({
      kind: "specialist_result",
      sourceKey: "subagent:run-specialist:result",
      title: expect.stringContaining("durable findings"),
      data: {
        agentId: "scout",
        response,
        responseLength: response.length,
        responseSha256: sha256(response),
      },
    }));
    if (!attemptEnded) {
      expect(detail?.attempts[0].output).toEqual({
        agentId: "scout",
        responseLength: response.length,
        responseSha256: sha256(response),
      });
    }
  });

  it("ends a mission whose tasks all ended once the last end is two minutes old", async () => {
    const endTask = async (sourceKey: string, minute: number) => {
      const owner = { tenantId, actorId: "owner-a" };
      const mission = await createMission({
        ...owner,
        title: `Mission ${sourceKey}`,
        objective: "Finish one task.",
        sourceKey,
      });
      const task = await ensureMissionTask(mission.id, {
        sourceKey,
        title: `Task ${sourceKey}`,
      }, owner);
      vi.setSystemTime(startedAt + minute * 60_000);
      await transitionMissionTask(task.id, "canceled", owner);
      vi.setSystemTime(startedAt);
      return mission;
    };
    const settled = await endTask("mission-settled", 1);
    const recent = await endTask("mission-recent", 1.5);
    // A mission with no tasks has not ended.
    await createMission({
      tenantId,
      actorId: "owner-a",
      title: "Mission with no tasks",
      objective: "Plan it later.",
      sourceKey: "mission-empty",
    });
    vi.setSystemTime(startedAt + 3 * 60_000);

    await expect(reconcileMissionProjections({ tenantId })).resolves.toEqual({
      repaired: 1,
      failed: 0,
    });

    const owner = { tenantId, actorId: "owner-a" };
    expect((await getMissionDetail(settled.id, owner))?.mission.status).toBe("canceled");
    expect((await getMissionDetail(recent.id, owner))?.mission.status).toBe("draft");
    expect(mocks.actorScopes).toEqual([[tenantId, ["owner-a"]]]);
  });

  it("repairs the most recent changes first, as each owner, up to its limit", async () => {
    const changedLast = await taskOnRun("run-changed-last", { actorId: "owner-a" });
    vi.setSystemTime(startedAt + 10_000);
    const oldest = await taskOnRun("run-oldest", { actorId: "owner-b" });
    vi.setSystemTime(startedAt + 20_000);
    const newest = await taskOnRun("run-newest", { actorId: "owner-a" });
    vi.setSystemTime(startedAt + 30_000);
    const going = await taskOnRun("run-going", { actorId: "owner-b" });
    vi.setSystemTime(startedAt + 40_000);
    await transitionMissionAttempt(changedLast.attempt.id, "waiting", {
      fenceToken: changedLast.attempt.fenceToken,
      agentRunId: changedLast.attempt.agentRunId,
    }, changedLast.owner);
    mocks.getAgentRun.mockImplementation(async (runId: string) =>
      runId === "run-going"
        ? agentRun("running")
        : agentRun("failed", atMinute(0.5), { error: "The run stopped." })
    );
    vi.setSystemTime(startedAt + 3 * 60_000);

    await expect(reconcileMissionProjections({ tenantId, limit: 2 })).resolves.toEqual({
      repaired: 2,
      failed: 0,
    });

    const attempt = async ({ mission, owner }: Awaited<ReturnType<typeof taskOnRun>>) =>
      (await getMissionDetail(mission.id, owner))?.attempts[0];
    expect(await attempt(changedLast)).toMatchObject({
      status: "failed",
      error: "The run stopped.",
    });
    expect(await attempt(newest)).toMatchObject({ status: "failed" });
    expect(await attempt(oldest)).toMatchObject({ status: "running" });
    expect(await attempt(going)).toMatchObject({ status: "running" });
    expect(mocks.actorScopes).toEqual([
      [tenantId, ["owner-a"]],
      [tenantId, ["owner-b"]],
      [tenantId, ["owner-a"]],
    ]);
  });

  it("goes on past a repair that fails and logs it without secrets", async () => {
    await taskOnRun("run-good");
    vi.setSystemTime(startedAt + 10_000);
    const broken = await taskOnRun("run-broken");
    const good = await taskOnRun("run-good-too", { actorId: "owner-b" });
    const secret = `sk-${"a".repeat(24)}`;
    mocks.getAgentRun.mockImplementation(async (runId: string) => {
      if (runId === "run-broken") throw new Error(`Run store refused ${secret}.`);
      return agentRun("canceled", atMinute(0.5));
    });
    vi.setSystemTime(startedAt + 3 * 60_000);

    await expect(reconcileMissionProjections({ tenantId })).resolves.toEqual({
      repaired: 2,
      failed: 1,
    });

    expect((await getMissionDetail(good.mission.id, good.owner))?.tasks[0].status)
      .toBe("canceled");
    expect(errorLog).toHaveBeenCalledTimes(1);
    const [line] = errorLog.mock.calls[0];
    expect(JSON.parse(String(line))).toEqual({
      level: "error",
      msg: "mission_projection_repair_failed",
      tenantId,
      attemptId: broken.attempt.id,
      error: "Run store refused [redacted-api-key].",
    });
  });
});
