import {
  claimProjectTaskForDispatch,
  getProject,
  listExecutingProjects,
  listProjectArtifacts,
  listProjectTasks,
  updateProjectExecution,
  updateProjectTaskExecution,
} from "@/lib/projects/store";
import { ensureProjectWorkflowArtifact } from "@/lib/projects/artifacts";
import type { PersonalProject, ProjectTask } from "@/lib/projects/types";
import { cancelWorkflowRunTick, enqueueWorkflowRunTick, scheduleWorkflowQueueDrain } from "@/lib/workflows/queue";
import { signalWorkflowRun } from "@/lib/workflows/runner";
import { createWorkflowRun, getWorkflowRunDetail } from "@/lib/workflows/store";
import type { WorkflowRunStatus } from "@/lib/workflows/types";

const activeWorkflowStatuses = new Set<WorkflowRunStatus>([
  "queued", "running", "waiting_approval", "paused",
]);

export async function syncProjectExecution(input: {
  projectId: string;
  tenantId?: string;
  actorId: string;
  drain?: boolean;
}) {
  let project = await getProject(input.projectId, input);
  if (!project) return undefined;
  let tasks = await listProjectTasks(project.id, { tenantId: project.tenantId });

  for (const task of tasks.filter((item) => item.workflowRunId)) {
    const detail = await getWorkflowRunDetail(task.workflowRunId!, { tenantId: project.tenantId });
    if (!detail) continue;
    const run = detail.run;
    if (run.status === "completed" || run.status === "failed" || run.status === "canceled") {
      await ensureProjectWorkflowArtifact({ project, task, run });
    }
    if (run.status === task.workflowStatus && !(run.status === "completed" && task.status !== "done")) continue;
    if (run.status === "completed") {
      await updateProjectTaskExecution(project.id, task.id, {
        status: "done",
        workflowRunId: run.id,
        workflowStatus: "completed",
        completedAt: run.completedAt || new Date().toISOString(),
      }, { tenantId: project.tenantId });
    } else if (run.status === "failed" || run.status === "canceled") {
      await updateProjectTaskExecution(project.id, task.id, {
        status: "open",
        workflowRunId: run.id,
        workflowStatus: run.status,
        executionError: run.error || `Workflow ${run.status}.`,
      }, { tenantId: project.tenantId });
    } else {
      await updateProjectTaskExecution(project.id, task.id, {
        status: "doing",
        workflowRunId: run.id,
        workflowStatus: run.status,
      }, { tenantId: project.tenantId });
    }
  }

  tasks = await listProjectTasks(project.id, { tenantId: project.tenantId });
  if (tasks.length && tasks.every((task) => task.status === "done")) {
    project = (await updateProjectExecution(project.id, {
      executionStatus: "completed",
      lastSyncedAt: new Date().toISOString(),
    }, input)) || project;
    return executionSnapshot(project, tasks, []);
  }

  const failedTask = tasks.find((task) => task.workflowStatus === "failed" || task.workflowStatus === "canceled");
  if (failedTask) {
    project = (await updateProjectExecution(project.id, {
      executionStatus: "failed",
      lastSyncedAt: new Date().toISOString(),
    }, input)) || project;
    return executionSnapshot(project, tasks, []);
  }

  const waitingApproval = tasks.some((task) => task.workflowStatus === "waiting_approval");
  if (project.executionStatus !== "running" && project.executionStatus !== "waiting_approval") {
    return executionSnapshot(project, tasks, []);
  }

  const activeCount = tasks.filter((task) => task.workflowStatus && activeWorkflowStatuses.has(task.workflowStatus as WorkflowRunStatus)).length;
  const capacity = Math.max(0, project.maxParallelTasks - activeCount);
  const budgetRemaining = Math.max(0, project.taskBudget - project.tasksDispatched);
  const completedIds = new Set(tasks.filter((task) => task.status === "done").map((task) => task.id));
  const automaticDispatch = project.autonomyMode !== "manual";
  const ready = tasks.filter((task) =>
    automaticDispatch &&
    task.status === "open" &&
    !task.workflowRunId &&
    !task.workflowStatus &&
    (task.dependsOn || []).every((dependency) => completedIds.has(dependency)),
  ).slice(0, Math.min(capacity, budgetRemaining));
  const dispatched: ProjectTask[] = [];

  if (!waitingApproval) {
    for (const task of ready) {
      const result = await dispatchProjectTask(project, task, input.drain ?? false);
      if (result) {
        dispatched.push(result);
        project = (await updateProjectExecution(project.id, { incrementDispatched: 1 }, input)) || project;
      }
    }
  }

  tasks = await listProjectTasks(project.id, { tenantId: project.tenantId });
  const nextStatus = tasks.some((task) => task.workflowStatus === "waiting_approval")
    ? "waiting_approval"
    : project.tasksDispatched >= project.taskBudget && !tasks.every((task) => task.status === "done")
      ? "paused"
      : "running";
  project = (await updateProjectExecution(project.id, {
    executionStatus: nextStatus,
    lastSyncedAt: new Date().toISOString(),
  }, input)) || project;
  return executionSnapshot(project, tasks, dispatched);
}

export async function processActiveProjectExecutions(options: { tenantId?: string; limit?: number }) {
  const projects = await listExecutingProjects(options.limit || 10, options);
  const results = [];
  for (const project of projects) {
    const result = await syncProjectExecution({
      projectId: project.id,
      tenantId: project.tenantId,
      actorId: project.actorId,
      drain: false,
    });
    if (result) results.push(result);
  }
  return results;
}

export async function signalProjectWorkflows(input: {
  projectId: string;
  tenantId?: string;
  signal: "pause" | "resume";
}) {
  const tasks = await listProjectTasks(input.projectId, input);
  const candidates = tasks.filter((task) => task.workflowRunId && (
    input.signal === "pause"
      ? task.workflowStatus === "queued" || task.workflowStatus === "running"
      : task.workflowStatus === "paused"
  ));
  for (const task of candidates) {
    await signalWorkflowRun(task.workflowRunId!, input.signal, { tenantId: input.tenantId });
    if (input.signal === "pause") {
      await cancelWorkflowRunTick(task.workflowRunId!, "Project execution paused.", input.tenantId);
    } else {
      await enqueueWorkflowRunTick(task.workflowRunId!, "project_execution_resumed", 10, input.tenantId);
    }
  }
  if (input.signal === "resume" && candidates.length) {
    scheduleWorkflowQueueDrain(Math.min(candidates.length, 3), input.tenantId);
  }
  return candidates.length;
}

export async function signalProjectTask(input: {
  projectId: string;
  taskId: string;
  tenantId?: string;
  actorId: string;
  signal: "approve" | "retry";
}) {
  const task = (await listProjectTasks(input.projectId, input)).find((item) => item.id === input.taskId);
  if (!task?.workflowRunId) return undefined;
  const detail = await signalWorkflowRun(task.workflowRunId, input.signal, {
    tenantId: input.tenantId,
    actorId: input.actorId,
    reason: `Project task ${input.signal}.`,
  });
  await enqueueWorkflowRunTick(task.workflowRunId, `project_task_${input.signal}`, 10, input.tenantId);
  scheduleWorkflowQueueDrain(1, input.tenantId);
  return detail;
}

async function dispatchProjectTask(project: PersonalProject, task: ProjectTask, drain: boolean) {
  const claimed = await claimProjectTaskForDispatch(project.id, task.id, { tenantId: project.tenantId });
  if (!claimed) return undefined;
  try {
    const workflow = await createWorkflowRun({
      tenantId: project.tenantId,
      idempotencyKey: `project-task:${task.id}:${claimed.dispatchAttempt}`,
      goal: projectTaskGoal(project, task),
      mode: modeForAgent(task.agentId),
      requireApproval: project.autonomyMode !== "autonomous" || project.requireApproval,
      maxAttempts: 3,
      metadata: {
        source: "project",
        projectId: project.id,
        projectTaskId: task.id,
        assignedAgentId: task.agentId,
      },
    });
    await updateProjectTaskExecution(project.id, task.id, {
      status: "doing",
      workflowRunId: workflow.run.id,
      workflowStatus: workflow.run.status,
    }, { tenantId: project.tenantId });
    await enqueueWorkflowRunTick(workflow.run.id, "project_task_dispatched", 10, project.tenantId);
    if (drain) scheduleWorkflowQueueDrain(1, project.tenantId);
    return claimed;
  } catch (error) {
    await updateProjectTaskExecution(project.id, task.id, {
      status: "open",
      executionError: error instanceof Error ? error.message : "Task dispatch failed.",
    }, { tenantId: project.tenantId });
    throw error;
  }
}

function modeForAgent(agentId: ProjectTask["agentId"]) {
  if (agentId === "scout" || agentId === "sentinel") return "research" as const;
  if (agentId === "mnemosyne") return "learn" as const;
  return agentId === "forge" ? "execute" as const : "orchestrate" as const;
}

function projectTaskGoal(project: PersonalProject, task: ProjectTask) {
  return [
    `You are ${task.agentId}, working as a specialist inside a private personal agent system.`,
    `Project: ${project.title}`,
    `Objective: ${project.objective}`,
    `Task: ${task.title}`,
    task.detail ? `Completion detail: ${task.detail}` : "",
    "Complete only this bounded task. Verify the outcome, preserve evidence, and report blockers honestly. Do not expand scope or make external commitments without governed approval.",
  ].filter(Boolean).join("\n");
}

async function executionSnapshot(project: PersonalProject, tasks: ProjectTask[], dispatched: ProjectTask[]) {
  return {
    project,
    tasks,
    artifacts: await listProjectArtifacts(project.id, { tenantId: project.tenantId }),
    dispatchedTaskIds: dispatched.map((task) => task.id),
    active: tasks.filter((task) => task.workflowStatus && activeWorkflowStatuses.has(task.workflowStatus as WorkflowRunStatus)).length,
    completed: tasks.filter((task) => task.status === "done").length,
  };
}
