import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProjectTaskWorkflowStatus } from "@/lib/projects/types";
import type { WorkflowRunStatus } from "@/lib/workflows/types";

const mocks = vi.hoisted(() => ({
  cancelWorkflowRunTick: vi.fn(),
  enqueueWorkflowRunTick: vi.fn(),
  scheduleWorkflowQueueDrain: vi.fn(),
  beforeSignal: vi.fn(),
  afterTaskList: vi.fn(),
}));

vi.mock("@/lib/projects/store", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/projects/store")>();
  return {
    ...original,
    listProjectTasks: async (
      ...args: Parameters<typeof original.listProjectTasks>
    ) => {
      const tasks = await original.listProjectTasks(...args);
      await mocks.afterTaskList();
      return tasks;
    },
  };
});
vi.mock("@/lib/workflows/queue", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/workflows/queue")>()),
  cancelWorkflowRunTick: mocks.cancelWorkflowRunTick,
  enqueueWorkflowRunTick: mocks.enqueueWorkflowRunTick,
  scheduleWorkflowQueueDrain: mocks.scheduleWorkflowQueueDrain,
}));
vi.mock("@/lib/workflows/runner", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/workflows/runner")>();
  return {
    ...original,
    signalWorkflowRun: async (
      ...args: Parameters<typeof original.signalWorkflowRun>
    ) => {
      await mocks.beforeSignal(...args);
      return original.signalWorkflowRun(...args);
    },
  };
});
vi.mock("@/lib/workspaces/read-model", () => ({
  canonicalWorkItemSurfaces: async (
    _tenantId: string,
    _sourceAuthority: string,
    fallbacks: Array<{ sourceId: string; status: string }>,
  ) => new Map(fallbacks.map((fallback) => [fallback.sourceId, { status: fallback.status }])),
}));

import { createAppServiceCaller } from "@/lib/app-services/contracts";
import { controlProjectExecutionService } from "@/lib/app-services/projects";
import { signalProjectWorkflows, syncProjectExecution } from "@/lib/projects/execution";
import {
  createProject,
  createProjectTasks,
  getProject,
  updateProjectExecution,
  updateProjectTaskExecution,
} from "@/lib/projects/store";
import { createExecutionScope } from "@/lib/security/execution-scope";
import {
  createWorkflowRun,
  getWorkflowRun,
  transitionWorkflowRun,
} from "@/lib/workflows/store";

const tenantId = "tenant-project-signals";
const owner = { tenantId, actorId: "owner-a" };
const executionScope = createExecutionScope({
  tenantId,
  initiatingActorId: owner.actorId,
  executingPrincipalType: "user",
  executingPrincipalId: owner.actorId,
  correlationId: "project-signals",
  purpose: "project.execution.control",
});

/** A project whose tasks each run a workflow in the given live status. */
async function projectWithRuns(
  runs: Array<{ live?: WorkflowRunStatus; cached?: ProjectTaskWorkflowStatus }>,
) {
  const project = await createProject({
    ...owner,
    title: "Signals",
    objective: "Pause and resume every run.",
  });
  const tasks = await createProjectTasks(
    project.id,
    runs.map((_, index) => ({ title: `Task ${index + 1}` })),
    { tenantId },
  );
  const runIds: string[] = [];
  for (const [index, { live, cached }] of runs.entries()) {
    if (!live) continue;
    const { run } = await createWorkflowRun({ tenantId, goal: `Run task ${index + 1}.` });
    if (live !== "queued") {
      await transitionWorkflowRun(run.id, ["queued"], {
        status: live,
        completedAt: live === "completed" ? new Date().toISOString() : undefined,
      }, { tenantId });
    }
    await updateProjectTaskExecution(project.id, tasks[index].id, {
      status: "doing",
      workflowRunId: run.id,
      workflowStatus: cached || live,
    }, owner);
    runIds.push(run.id);
  }
  return { project, tasks, runIds };
}

const liveStatuses = (runIds: string[]) => Promise.all(
  runIds.map(async (runId) => (await getWorkflowRun(runId, { tenantId }))?.status),
);

describe("project workflow signals", () => {
  let errorLog: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    delete process.env.DATABASE_URL;
    process.env.OMNIAGENT_DATA_DIR = await mkdtemp(
      path.join(os.tmpdir(), "asael-project-signals-"),
    );
    mocks.cancelWorkflowRunTick.mockReset().mockResolvedValue([]);
    mocks.enqueueWorkflowRunTick.mockReset().mockResolvedValue(undefined);
    mocks.scheduleWorkflowQueueDrain.mockReset();
    mocks.beforeSignal.mockReset().mockResolvedValue(undefined);
    mocks.afterTaskList.mockReset().mockResolvedValue(undefined);
    errorLog = vi.spyOn(console, "error").mockImplementation(() => undefined);
  });

  afterEach(() => {
    errorLog.mockRestore();
  });

  it("pauses each run by its live status and goes on past runs that moved or failed", async () => {
    const { project, runIds } = await projectWithRuns([
      { live: "running" },
      // The task still shows the approval its run has since passed.
      { live: "running", cached: "waiting_approval" },
      { live: "completed", cached: "running" },
      { live: "running" },
      { live: "queued" },
      { live: "queued" },
      {},
    ]);
    const [running, approved, , endsFirst, broken, queued] = runIds;
    const secret = `sk-${"a".repeat(24)}`;
    mocks.beforeSignal.mockImplementation(async (runId: string) => {
      if (runId === endsFirst) {
        await transitionWorkflowRun(runId, ["running"], {
          status: "completed",
          completedAt: new Date().toISOString(),
        }, { tenantId });
      }
      if (runId === broken) throw new Error(`Run store refused ${secret}.`);
    });
    // A paused run keeps its tick when the tick cannot be canceled.
    mocks.cancelWorkflowRunTick.mockImplementation(async (runId: string) => {
      if (runId === queued) throw new Error("Queue unavailable.");
      return [];
    });

    await expect(signalProjectWorkflows({
      projectId: project.id,
      ...owner,
      executionScope,
      signal: "pause",
    })).resolves.toEqual({ signaled: 3, unchanged: 2, failed: 1 });

    expect(await liveStatuses(runIds)).toEqual([
      "paused", "paused", "completed", "completed", "queued", "paused",
    ]);
    expect(mocks.beforeSignal.mock.calls.map(([runId]) => runId))
      .toEqual([running, approved, endsFirst, broken, queued]);
    expect(mocks.cancelWorkflowRunTick.mock.calls).toEqual([
      [running, "Project execution paused.", tenantId],
      [approved, "Project execution paused.", tenantId],
      [queued, "Project execution paused.", tenantId],
    ]);
    expect(mocks.scheduleWorkflowQueueDrain).not.toHaveBeenCalled();
    expect(errorLog.mock.calls.map(([line]) => JSON.parse(String(line)))).toEqual([
      {
        level: "error",
        msg: "project_workflow_signal_failed",
        tenantId,
        projectId: project.id,
        workflowRunId: broken,
        signal: "pause",
        error: "Run store refused [redacted-api-key].",
      },
      {
        level: "error",
        msg: "project_workflow_tick_update_failed",
        tenantId,
        projectId: project.id,
        workflowRunId: queued,
        signal: "pause",
        error: "Queue unavailable.",
      },
    ]);
  });

  it("resumes each paused run and drains up to three of them", async () => {
    const { project, runIds } = await projectWithRuns([
      { live: "paused" },
      { live: "paused", cached: "running" },
      { live: "paused" },
      { live: "paused" },
      // The task still shows the pause its run has since left.
      { live: "queued", cached: "paused" },
    ]);

    await expect(signalProjectWorkflows({
      projectId: project.id,
      ...owner,
      executionScope,
      signal: "resume",
    })).resolves.toEqual({ signaled: 4, unchanged: 1, failed: 0 });

    expect(await liveStatuses(runIds)).toEqual([
      "queued", "queued", "queued", "queued", "queued",
    ]);
    expect(mocks.enqueueWorkflowRunTick.mock.calls).toEqual(runIds.slice(0, 4).map(
      (runId) => [runId, "project_execution_resumed", 10, tenantId],
    ));
    expect(mocks.scheduleWorkflowQueueDrain.mock.calls).toEqual([[3, tenantId]]);
    expect(errorLog).not.toHaveBeenCalled();
  });

  it("drains only the runs a resume moved", async () => {
    const { project, runIds } = await projectWithRuns([
      { live: "paused" },
      { live: "queued", cached: "paused" },
      { live: "completed", cached: "paused" },
    ]);

    await expect(signalProjectWorkflows({
      projectId: project.id,
      ...owner,
      executionScope,
      signal: "resume",
    })).resolves.toEqual({ signaled: 1, unchanged: 2, failed: 0 });

    expect(await liveStatuses(runIds)).toEqual(["queued", "queued", "completed"]);
    expect(mocks.scheduleWorkflowQueueDrain.mock.calls).toEqual([[1, tenantId]]);
  });

  it("records a pause before it signals the runs, and a resume after", async () => {
    const { project, runIds } = await projectWithRuns([
      { live: "running" },
      { live: "queued" },
    ]);
    await updateProjectExecution(project.id, { executionStatus: "running" }, owner);
    const statusAtSignal: string[] = [];
    mocks.beforeSignal.mockImplementation(async () => {
      statusAtSignal.push((await getProject(project.id, owner))!.executionStatus);
    });
    const control = (action: "pause" | "resume") => controlProjectExecutionService(
      createAppServiceCaller({
        context: { ...owner, role: "admin", source: "session" },
        executionScope,
        idempotencyKey: `project-signals-${action}`,
      }),
      { projectId: project.id, action },
    );

    const paused = await control("pause");

    expect(statusAtSignal).toEqual(["paused", "paused"]);
    expect(paused.data).toMatchObject({
      snapshot: { project: { executionStatus: "paused" } },
      workflows: { signaled: 2, unchanged: 0, failed: 0 },
    });
    expect(await liveStatuses(runIds)).toEqual(["paused", "paused"]);

    statusAtSignal.length = 0;
    const resumed = await control("resume");

    expect(statusAtSignal).toEqual(["paused", "paused"]);
    expect(resumed.data).toMatchObject({
      snapshot: { project: { executionStatus: "running" } },
      workflows: { signaled: 2, unchanged: 0, failed: 0 },
    });
    expect(await liveStatuses(runIds)).toEqual(["queued", "queued"]);
  });

  it.each([
    ["while it dispatches a task", false],
    ["after it counts its last dispatch", true],
  ])("keeps a pause that lands in a sync %s", async (_, afterDispatch) => {
    const project = await createProject({
      ...owner,
      title: "Overlap",
      objective: "A pause made during a sync stands.",
    });
    const [task] = await createProjectTasks(project.id, [
      { title: "Research the constraints", agentId: "scout" },
    ], { tenantId });
    await updateProjectExecution(project.id, {
      autonomyMode: "supervised",
      executionStatus: "running",
      taskBudget: 3,
      maxParallelTasks: 1,
    }, owner);
    const pause = async () => {
      await updateProjectExecution(project.id, { executionStatus: "paused" }, owner);
    };
    // The owner pauses the project once the task's run is queued, or once the
    // sync has counted the dispatch and lists the tasks again.
    mocks.enqueueWorkflowRunTick.mockImplementationOnce(async () => {
      if (afterDispatch) mocks.afterTaskList.mockImplementationOnce(pause);
      else await pause();
    });

    const snapshot = await syncProjectExecution({ projectId: project.id, ...owner });

    expect(snapshot).toMatchObject({
      dispatchedTaskIds: [task.id],
      project: { executionStatus: "paused", tasksDispatched: 1 },
    });
    expect(await getProject(project.id, owner)).toMatchObject({
      executionStatus: "paused",
      tasksDispatched: 1,
    });
  });
});
