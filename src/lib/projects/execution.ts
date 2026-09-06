import {
  claimProjectTaskForDispatch,
  getProject,
  listExecutingProjects,
  listProjectArtifacts,
  listProjectTasks,
  updateProjectExecution,
  updateProjectTaskExecution,
  type ProjectMutationContext,
} from "@/lib/projects/store";
import { ensureProjectWorkflowArtifact } from "@/lib/projects/artifacts";
import type { PersonalProject, ProjectTask } from "@/lib/projects/types";
import {
  createExecutionScope,
  deriveExecutionScope,
  type ExecutionScope,
} from "@/lib/security/execution-scope";
import { projectMutationSha256 } from "@/lib/projects/events";
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
  executionScope?: ExecutionScope;
  idempotencyKey?: string;
}) {
  let project = await getProject(input.projectId, input);
  if (!project) return undefined;
  const executionScope = input.executionScope || createExecutionScope({
    tenantId: project.tenantId,
    initiatingActorId: project.actorId,
    executingPrincipalType: "system",
    executingPrincipalId: "omniagent-project-worker",
    projectId: project.id,
    correlationId: `project-sync:${project.id}:${project.updatedAt}`,
    purpose: "project.execution.sync",
  });
  const mutationFor = (
    purpose: string,
    causationId: string,
    value: unknown,
  ) => ({
    executionScope: deriveExecutionScope(executionScope, {
      projectId: project!.id,
      causationId,
      purpose,
    }),
    idempotencyKey: `project-execution:${projectMutationSha256({
      correlationId: executionScope.correlationId,
      purpose,
      causationId,
      value,
    })}`,
  });
  let tasks = await listProjectTasks(project.id, { tenantId: project.tenantId });

  for (const task of tasks.filter((item) => item.workflowRunId)) {
    const detail = await getWorkflowRunDetail(task.workflowRunId!, { tenantId: project.tenantId });
    if (!detail) continue;
    const run = detail.run;
    if (run.status === "completed" || run.status === "failed" || run.status === "canceled") {
      await ensureProjectWorkflowArtifact({
        project,
        task,
        run,
        mutation: mutationFor(
          "project.artifact.save",
          run.id,
          { status: run.status, completedAt: run.completedAt },
        ),
      });
    }
    if (run.status === task.workflowStatus && !(run.status === "completed" && task.status !== "done")) continue;
    if (run.status === "completed") {
      await updateProjectTaskExecution(project.id, task.id, {
        status: "done",
        workflowRunId: run.id,
        workflowStatus: "completed",
        completedAt: run.completedAt || new Date().toISOString(),
      }, {
        tenantId: project.tenantId,
        actorId: project.actorId,
        mutation: mutationFor(
          "project.task.execution.complete",
          task.id,
          { workflowRunId: run.id, status: run.status },
        ),
      });
    } else if (run.status === "failed" || run.status === "canceled") {
      await updateProjectTaskExecution(project.id, task.id, {
        status: "open",
        workflowRunId: run.id,
        workflowStatus: run.status,
        executionError: run.error || `Workflow ${run.status}.`,
      }, {
        tenantId: project.tenantId,
        actorId: project.actorId,
        mutation: mutationFor(
          "project.task.execution.terminal",
          task.id,
          { workflowRunId: run.id, status: run.status },
        ),
      });
    } else {
      await updateProjectTaskExecution(project.id, task.id, {
        status: "doing",
        workflowRunId: run.id,
        workflowStatus: run.status,
      }, {
        tenantId: project.tenantId,
        actorId: project.actorId,
        mutation: mutationFor(
          "project.task.execution.sync",
          task.id,
          { workflowRunId: run.id, status: run.status },
        ),
      });
    }
  }

  tasks = await listProjectTasks(project.id, { tenantId: project.tenantId });
  if (tasks.length && tasks.every((task) => task.status === "done")) {
    project = (await updateProjectExecution(project.id, {
      executionStatus: "completed",
      lastSyncedAt: new Date().toISOString(),
    }, {
      ...input,
      mutation: mutationFor(
        "project.execution.complete",
        project.id,
        { executionStatus: "completed" },
      ),
    })) || project;
    return executionSnapshot(project, tasks, []);
  }

  const failedTask = tasks.find((task) => task.workflowStatus === "failed" || task.workflowStatus === "canceled");
  if (failedTask) {
    project = (await updateProjectExecution(project.id, {
      executionStatus: "failed",
      lastSyncedAt: new Date().toISOString(),
    }, {
      ...input,
      mutation: mutationFor(
        "project.execution.fail",
        project.id,
        { executionStatus: "failed", taskId: failedTask.id },
      ),
    })) || project;
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
      const result = await dispatchProjectTask(
        project,
        task,
        input.drain ?? false,
        mutationFor(
          "project.task.dispatch_claim",
          task.id,
          { dispatchAttempt: task.dispatchAttempt + 1 },
        ),
      );
      if (result) {
        dispatched.push(result);
        project = (await updateProjectExecution(
          project.id,
          { incrementDispatched: 1 },
          {
            ...input,
            mutation: mutationFor(
              "project.execution.dispatch_count",
              task.id,
              { dispatchAttempt: result.dispatchAttempt },
            ),
          },
        )) || project;
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
  }, {
    ...input,
    mutation: mutationFor(
      "project.execution.status",
      project.id,
      { executionStatus: nextStatus, tasksDispatched: project.tasksDispatched },
    ),
  })) || project;
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
  actorId: string;
  executionScope: ExecutionScope;
  signal: "pause" | "resume";
}) {
  const tasks = await listProjectTasks(input.projectId, input);
  const candidates = tasks.filter((task) => task.workflowRunId && (
    input.signal === "pause"
      ? task.workflowStatus === "queued" || task.workflowStatus === "running"
      : task.workflowStatus === "paused"
  ));
  for (const task of candidates) {
    await signalWorkflowRun(task.workflowRunId!, input.signal, {
      tenantId: input.tenantId,
      actorId: input.actorId,
      executionScope: input.executionScope,
    });
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
  executionScope: ExecutionScope;
}) {
  const task = (await listProjectTasks(input.projectId, input)).find((item) => item.id === input.taskId);
  if (!task?.workflowRunId) return undefined;
  const detail = await signalWorkflowRun(task.workflowRunId, input.signal, {
    tenantId: input.tenantId,
    actorId: input.actorId,
    reason: `Project task ${input.signal}.`,
    executionScope: input.executionScope,
  });
  await enqueueWorkflowRunTick(task.workflowRunId, `project_task_${input.signal}`, 10, input.tenantId);
  scheduleWorkflowQueueDrain(1, input.tenantId);
  return detail;
}

async function dispatchProjectTask(
  project: PersonalProject,
  task: ProjectTask,
  drain: boolean,
  mutation: ProjectMutationContext,
) {
  const claimed = await claimProjectTaskForDispatch(project.id, task.id, {
    tenantId: project.tenantId,
    actorId: project.actorId,
    mutation,
  });
  if (!claimed) return undefined;
  try {
    const workflow = await createWorkflowRun({
      tenantId: project.tenantId,
      executionAuthority: {
        executionScope: deriveExecutionScope(mutation.executionScope, {
          executingPrincipalType: "agent",
          executingPrincipalId: task.agentId,
          projectId: project.id,
          causationId: task.id,
          purpose: "project.task.workflow",
        }),
        requesterRole: "operator",
      },
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
    }, {
      tenantId: project.tenantId,
      actorId: project.actorId,
      mutation: childProjectMutation(
        mutation,
        "project.task.dispatch_bound",
        { taskId: task.id, workflowRunId: workflow.run.id },
      ),
    });
    await enqueueWorkflowRunTick(workflow.run.id, "project_task_dispatched", 10, project.tenantId);
    if (drain) scheduleWorkflowQueueDrain(1, project.tenantId);
    return claimed;
  } catch (error) {
    await updateProjectTaskExecution(project.id, task.id, {
      status: "open",
      executionError: error instanceof Error ? error.message : "Task dispatch failed.",
    }, {
      tenantId: project.tenantId,
      actorId: project.actorId,
      mutation: childProjectMutation(
        mutation,
        "project.task.dispatch_failed",
        { taskId: task.id, dispatchAttempt: claimed.dispatchAttempt },
      ),
    });
    throw error;
  }
}

function childProjectMutation(
  parent: ProjectMutationContext,
  purpose: string,
  value: unknown,
): ProjectMutationContext {
  return {
    executionScope: deriveExecutionScope(parent.executionScope, { purpose }),
    idempotencyKey: `project-execution:${projectMutationSha256({
      parentIdempotencyKey: parent.idempotencyKey,
      purpose,
      value,
    })}`,
  };
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
