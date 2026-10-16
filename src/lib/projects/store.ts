import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  ensureDatabaseSchema,
  getDatabaseTenantContext,
  getSql,
  hasDatabaseUrl,
} from "@/lib/db/client";
import { appendScopedDomainEvent } from "@/lib/events/store";
import type { SupervisorAgentId } from "@/lib/orchestration/supervisor";
import { projectActorReadOrder } from "@/lib/projects/actor-scope";
import {
  applyProjectTaskDeadlinePatch,
  assertProjectTaskDependencyGraph,
  projectTaskDependenciesSchema,
  projectTaskHumanOwnerSchema,
  type ProjectTaskCommitmentInput,
} from "@/lib/projects/task-commitments";
import {
  PROJECT_EVENT_SCHEMA_VERSION,
  projectIdForIdempotencyKey,
  projectTaskIdForIdempotencyKey,
  projectMutationEventId,
  projectMutationEventPayloadSchema,
  projectMutationSha256,
} from "@/lib/projects/events";
import type {
  PersonalProject,
  ProjectArtifact,
  ProjectArtifactStatus,
  ProjectArtifactVerdict,
  ProjectLedger,
  ProjectAutonomyMode,
  ProjectExecutionStatus,
  ProjectStatus,
  ProjectSummary,
  ProjectTask,
  ProjectTaskPriority,
  ProjectTaskStatus,
} from "@/lib/projects/types";
import type { CanonicalRequestActorBindingV1 } from "@/lib/security/canonical-actor";
import { redactSensitive } from "@/lib/security/context";
import {
  assertExecutionScopeTenant,
  parsePersistedExecutionScope,
  type ExecutionScope,
} from "@/lib/security/execution-scope";
import { readJsonFile, updateJsonFile } from "@/lib/storage/json";
import { getDataPath } from "@/lib/storage/paths";
import { projectCanonicalShadowWrite } from "@/lib/workspaces/canonical-store";

export type ProjectMutationContext = Readonly<{
  executionScope: ExecutionScope;
  idempotencyKey: string;
  /** Selected by a trusted service, never from model or request arguments. */
  principalMode?: "user_or_agent";
}>;

export async function createProject(input: {
  tenantId?: string;
  actorId: string;
  title: string;
  objective: string;
  status?: ProjectStatus;
  targetDate?: string;
  mutation?: ProjectMutationContext;
  /** Atomic setup callers must not adopt a pre-existing deterministic target. */
  requireNew?: boolean;
}) {
  const tenantId = normalizeTenantId(input.tenantId);
  const mutation = input.mutation
    ? exactProjectMutationContext(input.mutation, tenantId, input.actorId)
    : undefined;
  const now = new Date().toISOString();
  const project: PersonalProject = {
    id: mutation
      ? projectIdForIdempotencyKey(tenantId, mutation.idempotencyKey)
      : randomUUID(),
    tenantId,
    actorId: safeText(input.actorId, 200),
    title: safeText(input.title, 180),
    objective: projectTextForWrite(input.objective, 2_000, "Project objective"),
    status: input.status || "active",
    autonomyMode: "manual",
    executionStatus: "idle",
    taskBudget: 12,
    tasksDispatched: 0,
    maxParallelTasks: 1,
    requireApproval: true,
    targetDate: optionalDate(input.targetDate),
    createdAt: now,
    updatedAt: now,
  };
  if (hasDatabaseUrl()) {
    await ensureDatabaseSchema();
    if (!mutation) {
      throw new Error("Project creation requires an execution scope and idempotency key.");
    }
    return getSql().transaction(async (sql: ProjectSqlClient) => {
      const rows = await insertProject(sql, project, now, true);
      if (input.requireNew && !rows[0]) throw new Error("The project target already exists without this setup acceptance.");
      const saved = rows[0]
        ? projectFromRow(rows[0])
        : await getProjectById(sql, project.id, project.tenantId);
      if (!saved || !sameProjectCreateRequest(saved, project)) {
        throw new Error(
          "Idempotency-Key is already bound to a different project request.",
        );
      }
      await appendProjectMutationEvent({
        mutation,
        project: saved,
        operation: "project_created",
        status: saved.status,
        changedFieldIds: ["objective", "status", "target_date", "title"],
        mutationInput: projectCreateMutationInput(project),
      }, sql);
      return saved;
    }) as Promise<PersonalProject>;
  }
  let saved = project;
  await updateLedger((ledger) => {
    const existing = ledger.projects.find((item) => item.id === project.id);
    if (existing) {
      if (input.requireNew) throw new Error("The project target already exists without this setup acceptance.");
      if (!sameProjectCreateRequest(existing, project)) {
        throw new Error(
          "Idempotency-Key is already bound to a different project request.",
        );
      }
      saved = existing;
      return ledger;
    }
    return { ...ledger, projects: [project, ...ledger.projects] };
  });
  if (mutation) {
    await appendProjectMutationEvent({
      mutation,
      project: saved,
      operation: "project_created",
      status: saved.status,
      changedFieldIds: ["objective", "status", "target_date", "title"],
      mutationInput: projectCreateMutationInput(project),
    });
  }
  return saved;
}

export async function listProjects(
  limit = 50,
  options: {
    tenantId?: string;
    actorId: string;
    requestActorBinding?: CanonicalRequestActorBindingV1;
  },
) {
  const tenantId = normalizeTenantId(options.tenantId);
  const actorId = safeText(options.actorId, 200);
  const bounded = Math.min(Math.max(limit, 1), 100);
  if (hasDatabaseUrl()) {
    await ensureDatabaseSchema();
    const actorReadOrder = projectActorReadOrder(
      options.actorId,
      options.requestActorBinding,
      actorId,
    );
    const canonicalActorId = actorReadOrder[0];
    const exactActorId = actorReadOrder[1];
    const rows = await getSql()`
      SELECT * FROM omni_projects
      WHERE tenant_id = ${tenantId}
        AND (actor_id = ${canonicalActorId} OR actor_id = ${exactActorId})
      ORDER BY
        CASE status WHEN 'active' THEN 0 WHEN 'draft' THEN 1 WHEN 'completed' THEN 2 ELSE 3 END,
        updated_at DESC,
        id ASC
      LIMIT ${bounded}
    `;
    return rows.map((row) =>
      projectForRequest(projectFromRow(row), exactActorId),
    );
  }
  const ledger = await readLedger();
  return ledger.projects
    .filter((item) => item.tenantId === tenantId && item.actorId === actorId)
    .sort(compareProjects)
    .slice(0, bounded)
    .map((project) => projectForRequest(project, actorId));
}

export async function listProjectSummaries(
  limit = 50,
  options: {
    tenantId?: string;
    actorId: string;
    requestActorBinding?: CanonicalRequestActorBindingV1;
  },
): Promise<ProjectSummary[]> {
  const tenantId = normalizeTenantId(options.tenantId);
  const actorId = safeText(options.actorId, 200);
  const bounded = Math.min(Math.max(limit, 1), 50);
  if (hasDatabaseUrl()) {
    await ensureDatabaseSchema();
    const actorReadOrder = projectActorReadOrder(
      options.actorId,
      options.requestActorBinding,
      actorId,
    );
    const canonicalActorId = actorReadOrder[0];
    const exactActorId = actorReadOrder[1];
    const rows = await getSql()`
      SELECT projects.*,
        COALESCE(tasks.task_count, 0)::integer AS task_count,
        COALESCE(tasks.completed_task_count, 0)::integer AS completed_task_count,
        COALESCE(tasks.active_task_count, 0)::integer AS active_task_count,
        COALESCE(artifacts.artifact_count, 0)::integer AS artifact_count
      FROM omni_projects projects
      LEFT JOIN LATERAL (
        SELECT
          COUNT(*) AS task_count,
          COUNT(*) FILTER (WHERE status = 'done') AS completed_task_count,
          COUNT(*) FILTER (WHERE status = 'doing') AS active_task_count
        FROM omni_project_tasks
        WHERE tenant_id = ${tenantId} AND project_id = projects.id
      ) tasks ON TRUE
      LEFT JOIN LATERAL (
        SELECT COUNT(*) AS artifact_count
        FROM omni_project_artifacts
        WHERE tenant_id = ${tenantId} AND project_id = projects.id
      ) artifacts ON TRUE
      WHERE projects.tenant_id = ${tenantId}
        AND (projects.actor_id = ${canonicalActorId} OR projects.actor_id = ${exactActorId})
      ORDER BY
        CASE projects.status WHEN 'active' THEN 0 WHEN 'draft' THEN 1 WHEN 'completed' THEN 2 ELSE 3 END,
        projects.updated_at DESC,
        projects.id ASC
      LIMIT ${bounded}
    `;
    return rows.map((row) =>
      projectForRequest(projectSummaryFromRow(row), exactActorId),
    );
  }
  const ledger = await readLedger();
  return ledger.projects
    .filter((item) => item.tenantId === tenantId && item.actorId === actorId)
    .sort(compareProjects)
    .slice(0, bounded)
    .map((project) => {
      const tasks = ledger.tasks.filter((task) =>
        task.tenantId === tenantId && task.projectId === project.id
      );
      return projectForRequest({
        ...project,
        taskCount: tasks.length,
        completedTaskCount: tasks.filter((task) => task.status === "done").length,
        activeTaskCount: tasks.filter((task) => task.status === "doing").length,
        artifactCount: ledger.artifacts.filter((artifact) =>
          artifact.tenantId === tenantId && artifact.projectId === project.id
        ).length,
      }, actorId);
    });
}

export async function listExecutingProjects(
  limit = 25,
  options: { tenantId?: string } = {},
) {
  const tenantId = normalizeTenantId(options.tenantId);
  const bounded = Math.min(Math.max(limit, 1), 100);
  if (hasDatabaseUrl()) {
    await ensureDatabaseSchema();
    const rows = await getSql()`
      SELECT * FROM omni_projects
      WHERE tenant_id = ${tenantId} AND status = 'active' AND execution_status IN ('running', 'waiting_approval')
      ORDER BY last_synced_at ASC NULLS FIRST, updated_at ASC
      LIMIT ${bounded}
    `;
    return rows.map(projectFromRow);
  }
  const ledger = await readLedger();
  return ledger.projects
    .filter((project) => project.tenantId === tenantId && project.status === "active" && ["running", "waiting_approval"].includes(project.executionStatus))
    .sort((left, right) => (left.lastSyncedAt || "").localeCompare(right.lastSyncedAt || ""))
    .slice(0, bounded);
}

export async function getProject(
  id: string,
  options: { tenantId?: string; actorId: string },
) {
  const tenantId = normalizeTenantId(options.tenantId);
  const actorId = safeText(options.actorId, 200);
  if (hasDatabaseUrl()) {
    await ensureDatabaseSchema();
    const rows = await getSql()`SELECT * FROM omni_projects WHERE id = ${id} AND tenant_id = ${tenantId} AND actor_id = ${actorId} LIMIT 1`;
    return rows[0] ? projectFromRow(rows[0]) : undefined;
  }
  const ledger = await readLedger();
  return ledger.projects.find((item) => item.id === id && item.tenantId === tenantId && item.actorId === actorId);
}

export async function getOwnedProject(
  id: string,
  options: {
    tenantId?: string;
    actorId: string;
    requestActorBinding?: CanonicalRequestActorBindingV1;
  },
) {
  const tenantId = normalizeTenantId(options.tenantId);
  const actorId = safeText(options.actorId, 200);
  if (hasDatabaseUrl()) {
    await ensureDatabaseSchema();
    const actorReadOrder = projectActorReadOrder(
      options.actorId,
      options.requestActorBinding,
      actorId,
    );
    const canonicalActorId = actorReadOrder[0];
    const exactActorId = actorReadOrder[1];
    const rows = await getSql()`
      SELECT * FROM omni_projects
      WHERE id = ${id} AND tenant_id = ${tenantId}
        AND (actor_id = ${canonicalActorId} OR actor_id = ${exactActorId})
      LIMIT 1
    `;
    return rows[0]
      ? projectForRequest(projectFromRow(rows[0]), exactActorId)
      : undefined;
  }
  const ledger = await readLedger();
  const project = ledger.projects.find((item) =>
    item.id === id && item.tenantId === tenantId && item.actorId === actorId
  );
  return project ? projectForRequest(project, actorId) : undefined;
}

/** Parent authorization precedes the exact child lookup; a task ID grants no project access. */
export async function getOwnedProjectTask(
  projectId: string, taskId: string, options: Parameters<typeof getOwnedProject>[1],
) {
  const project = await getOwnedProject(projectId, options);
  if (!project || project.status === "archived") return null;
  if (hasDatabaseUrl()) {
    return (await getProjectTaskById(getSql(), taskId, project.tenantId, project.id)) || null;
  }
  const ledger = await readLedger();
  return ledger.tasks.find((task) => task.id === taskId && task.projectId === project.id && task.tenantId === project.tenantId) || null;
}

export async function updateProject(
  id: string,
  input: { title?: string; objective?: string; status?: ProjectStatus; targetDate?: string | null },
  options: { tenantId?: string; actorId: string; mutation?: ProjectMutationContext },
) {
  const current = await getProject(id, options);
  if (!current) return undefined;
  const mutation = options.mutation
    ? exactProjectMutationContext(
        options.mutation,
        current.tenantId,
        current.actorId,
      )
    : undefined;
  if (
    mutation?.executionScope.projectId &&
    mutation.executionScope.projectId !== current.id
  ) {
    throw new Error("Project mutation scope does not match the target project.");
  }
  if (input.status && !canTransitionProject(current.status, input.status)) {
    throw new ProjectTransitionError(`Project cannot move from ${current.status} to ${input.status}.`);
  }
  const now = new Date().toISOString();
  const next: PersonalProject = {
    ...current,
    title: input.title ? safeText(input.title, 180) : current.title,
    objective: input.objective ? projectTextForWrite(input.objective, 2_000, "Project objective") : current.objective,
    status: input.status || current.status,
    executionStatus: input.status === "completed"
      ? "completed"
      : input.status === "archived"
        ? "paused"
        : input.status === "active" && current.status !== "active"
          ? "idle"
          : current.executionStatus,
    targetDate: input.targetDate === null ? undefined : optionalDate(input.targetDate) || current.targetDate,
    completedAt: input.status === "completed" ? now : input.status === "active" ? undefined : current.completedAt,
    updatedAt: now,
  };
  if (hasDatabaseUrl()) {
    await ensureDatabaseSchema();
    if (!mutation) {
      throw new Error("Project update requires an execution scope and idempotency key.");
    }
    return getSql().transaction(async (sql: ProjectSqlClient) => {
      const rows = await updateProjectRow(sql, next, now);
      const saved = rows[0] ? projectFromRow(rows[0]) : undefined;
      if (!saved) return undefined;
      await appendProjectMutationEvent({
        mutation,
        project: saved,
        operation: "project_updated",
        status: saved.status,
        changedFieldIds: Object.keys(input),
        mutationInput: input,
      }, sql);
      return saved;
    }) as Promise<PersonalProject | undefined>;
  }
  await updateLedger((ledger) => ({
    ...ledger,
    projects: ledger.projects.map((item) => item.id === id ? next : item),
  }));
  if (mutation) {
    await appendProjectMutationEvent({
      mutation,
      project: next,
      operation: "project_updated",
      status: next.status,
      changedFieldIds: Object.keys(input),
      mutationInput: input,
    });
  }
  return next;
}

export async function updateProjectExecution(
  id: string,
  input: {
    autonomyMode?: ProjectAutonomyMode;
    executionStatus?: ProjectExecutionStatus;
    taskBudget?: number;
    maxParallelTasks?: number;
    requireApproval?: boolean;
    incrementDispatched?: number;
    lastSyncedAt?: string;
  },
  options: {
    tenantId?: string;
    actorId: string;
    mutation?: ProjectMutationContext;
    /** Writes only while the project's execution is still in this status. */
    expectedExecutionStatus?: ProjectExecutionStatus;
  },
) {
  const current = await getProject(id, options);
  if (!current) return undefined;
  const expectedStatus = options.expectedExecutionStatus || null;
  const mutation = options.mutation
    ? exactProjectMutationContext(
        options.mutation,
        current.tenantId,
        current.actorId,
        "delegated",
      )
    : undefined;
  const now = new Date().toISOString();
  const next: PersonalProject = {
    ...current,
    autonomyMode: input.autonomyMode || current.autonomyMode,
    executionStatus: input.executionStatus || current.executionStatus,
    taskBudget: boundedInteger(input.taskBudget, current.taskBudget, 1, 50),
    maxParallelTasks: boundedInteger(input.maxParallelTasks, current.maxParallelTasks, 1, 3),
    requireApproval: input.requireApproval ?? current.requireApproval,
    tasksDispatched: Math.max(0, current.tasksDispatched + (input.incrementDispatched || 0)),
    lastSyncedAt: input.lastSyncedAt || current.lastSyncedAt,
    updatedAt: now,
  };
  if (hasDatabaseUrl()) {
    await ensureDatabaseSchema();
    if (!mutation) {
      throw new Error("Project execution mutation requires an execution scope and idempotency key.");
    }
    return getSql().transaction(async (sql: ProjectSqlClient) => {
      const rows = await sql`
        UPDATE omni_projects SET
          autonomy_mode = ${next.autonomyMode}, execution_status = ${next.executionStatus},
          task_budget = ${next.taskBudget}, tasks_dispatched = ${next.tasksDispatched},
          max_parallel_tasks = ${next.maxParallelTasks}, require_approval = ${next.requireApproval},
          last_synced_at = ${next.lastSyncedAt || null}, updated_at = ${now}
        WHERE id = ${id} AND tenant_id = ${next.tenantId} AND actor_id = ${next.actorId}
          AND (${expectedStatus}::text IS NULL OR execution_status = ${expectedStatus})
        RETURNING *
      `;
      const saved = rows[0] ? projectFromRow(rows[0]) : undefined;
      if (!saved) return undefined;
      await appendProjectMutationEvent({
        mutation,
        project: saved,
        operation: "project_execution_updated",
        priorStatus: current.executionStatus,
        status: saved.executionStatus,
        changedFieldIds: Object.keys(input),
        mutationInput: input,
      }, sql);
      return saved;
    }) as Promise<PersonalProject | undefined>;
  }
  let written = false;
  await updateLedger((ledger) => ({
    ...ledger,
    projects: ledger.projects.map((item) => {
      if (item.id !== id) return item;
      if (expectedStatus && item.executionStatus !== expectedStatus) return item;
      written = true;
      return next;
    }),
  }));
  if (!written) return undefined;
  if (mutation) {
    await appendProjectMutationEvent({
      mutation,
      project: next,
      operation: "project_execution_updated",
      priorStatus: current.executionStatus,
      status: next.executionStatus,
      changedFieldIds: Object.keys(input),
      mutationInput: input,
    });
  }
  return next;
}

export async function listProjectTasks(
  projectId: string,
  options: { tenantId?: string; limit?: number },
) {
  const tenantId = normalizeTenantId(options.tenantId);
  const limit = Math.min(Math.max(options.limit || 500, 1), 1_000);
  if (hasDatabaseUrl()) {
    await ensureDatabaseSchema();
    const rows = await getSql()`
      SELECT * FROM omni_project_tasks
      WHERE tenant_id = ${tenantId} AND project_id = ${projectId}
      ORDER BY position ASC, created_at ASC
      LIMIT ${limit}
    `;
    return rows.map(taskFromRow);
  }
  const ledger = await readLedger();
  return ledger.tasks
    .filter((item) => item.tenantId === tenantId && item.projectId === projectId)
    .sort((left, right) => left.position - right.position || left.createdAt.localeCompare(right.createdAt))
    .slice(0, limit);
}

const taskPageCursorSchema = z.object({
  version: z.literal(1), scope: z.string().regex(/^[a-f0-9]{64}$/),
  id: z.string().min(1).max(200), position: z.number().int().nonnegative(),
  createdAt: z.string().min(1).max(40).refine((value) => Number.isFinite(Date.parse(value))),
}).strict();

/** Keyset inventory reads retain owner checks on every page. A cursor only
 * locates a row; it never establishes project access or a frozen snapshot. */
export async function listOwnedProjectTasksPage(
  projectId: string,
  options: Parameters<typeof getOwnedProject>[1] & { limit?: number; cursor?: string },
) {
  const tenantId = normalizeTenantId(options.tenantId);
  const actorId = safeText(options.actorId, 200);
  const limit = z.number().int().min(1).max(200).parse(options.limit ?? 100);
  const scope = projectMutationSha256({ contract: "owned-project-task-page:1", tenantId, actorId, projectId,
    canonicalActorId: options.requestActorBinding?.canonicalActorId ?? null });
  let cursor: z.infer<typeof taskPageCursorSchema> | undefined;
  if (options.cursor !== undefined) {
    try {
      if (!/^[A-Za-z0-9_-]{1,2048}$/.test(options.cursor)) throw new Error();
      cursor = taskPageCursorSchema.parse(JSON.parse(Buffer.from(options.cursor, "base64url").toString("utf8")));
      if (cursor.scope !== scope) throw new Error();
    } catch { throw new Error("Project task cursor is invalid for this owner and project. Restart the inventory."); }
  }
  const project = await getOwnedProject(projectId, options);
  if (!project) return undefined;
  let tasks: Array<{ task: ProjectTask; createdAt: string }>;
  if (hasDatabaseUrl()) {
    const [canonicalActorId, exactActorId] = projectActorReadOrder(options.actorId, options.requestActorBinding, actorId);
    const sql = getSql();
    if (cursor) {
      const anchor = await sql`
        SELECT tasks.id FROM omni_project_tasks tasks
        JOIN omni_projects projects ON projects.id = tasks.project_id AND projects.tenant_id = tasks.tenant_id
        WHERE tasks.tenant_id = ${tenantId} AND tasks.project_id = ${projectId}
          AND (projects.actor_id = ${canonicalActorId} OR projects.actor_id = ${exactActorId})
          AND tasks.id = ${cursor.id} AND tasks.position = ${cursor.position}
          AND tasks.created_at = ${cursor.createdAt}::timestamptz
        LIMIT 1
      `;
      if (anchor.length !== 1) throw new Error("Project task cursor changed or is unavailable. Restart the inventory.");
    }
    const rows = await sql`
      SELECT tasks.*, tasks.created_at::text AS page_created_at FROM omni_project_tasks tasks
      JOIN omni_projects projects ON projects.id = tasks.project_id AND projects.tenant_id = tasks.tenant_id
      WHERE tasks.tenant_id = ${tenantId} AND tasks.project_id = ${projectId}
        AND (projects.actor_id = ${canonicalActorId} OR projects.actor_id = ${exactActorId})
        AND (${!cursor} OR (tasks.position, tasks.created_at, tasks.id) >
          (${cursor?.position ?? 0}, ${cursor?.createdAt ?? "1970-01-01T00:00:00Z"}::timestamptz, ${cursor?.id ?? ""}))
      ORDER BY tasks.position ASC, tasks.created_at ASC, tasks.id ASC
      LIMIT ${limit + 1}
    `;
    // Preserve PostgreSQL microseconds in the cursor instead of rounding through Date.
    tasks = rows.map((row) => ({ task: taskFromRow(row), createdAt: String(row.page_created_at) }));
  } else {
    const ledger = await readLedger();
    if (!ledger.projects.some((item) => item.id === projectId && item.tenantId === tenantId && item.actorId === actorId)) return undefined;
    const owned = ledger.tasks.filter((task) => task.tenantId === tenantId && task.projectId === projectId);
    if (cursor && !owned.some((task) => task.id === cursor.id && task.position === cursor.position && task.createdAt === cursor.createdAt)) {
      throw new Error("Project task cursor changed or is unavailable. Restart the inventory.");
    }
    tasks = owned.sort(compareTaskPosition)
      .filter((task) => !cursor || compareTaskPosition(task, cursor) > 0)
      .slice(0, limit + 1).map((task) => ({ task, createdAt: task.createdAt }));
  }
  return {
    project,
    hasMore: tasks.length > limit,
    entries: tasks.slice(0, limit).map(({ task, createdAt }) => ({
      task,
      cursor: Buffer.from(JSON.stringify(taskPageCursorSchema.parse({ version: 1, scope, id: task.id, position: task.position, createdAt }))).toString("base64url"),
    })),
  };
}

function compareTaskPosition(left: Pick<ProjectTask, "position" | "createdAt" | "id">, right: Pick<ProjectTask, "position" | "createdAt" | "id">) {
  return left.position - right.position || left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id);
}

export async function listProjectArtifacts(
  projectId: string,
  options: { tenantId?: string; limit?: number },
) {
  const tenantId = normalizeTenantId(options.tenantId);
  const limit = Math.min(Math.max(options.limit || 250, 1), 500);
  if (hasDatabaseUrl()) {
    await ensureDatabaseSchema();
    const rows = await getSql()`
      SELECT * FROM omni_project_artifacts
      WHERE tenant_id = ${tenantId} AND project_id = ${projectId}
      ORDER BY created_at DESC
      LIMIT ${limit}
    `;
    return rows.map(artifactFromRow);
  }
  const ledger = await readLedger();
  return ledger.artifacts
    .filter((artifact) => artifact.tenantId === tenantId && artifact.projectId === projectId)
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
    .slice(0, limit);
}

export async function listProjectCollections(
  projectIds: string[],
  options: { tenantId?: string },
) {
  const tenantId = normalizeTenantId(options.tenantId);
  const ids = [...new Set(projectIds.map((id) => safeText(id, 120)).filter(Boolean))].slice(0, 100);
  const tasksByProject = new Map<string, ProjectTask[]>(ids.map((id) => [id, []]));
  const artifactsByProject = new Map<string, ProjectArtifact[]>(ids.map((id) => [id, []]));
  if (!ids.length) return { tasksByProject, artifactsByProject };
  if (hasDatabaseUrl()) {
    await ensureDatabaseSchema();
    const [taskRows, artifactRows] = await Promise.all([
      getSql()`SELECT * FROM omni_project_tasks WHERE tenant_id = ${tenantId} AND project_id = ANY(${ids}) ORDER BY project_id, position ASC, created_at ASC`,
      getSql()`SELECT * FROM omni_project_artifacts WHERE tenant_id = ${tenantId} AND project_id = ANY(${ids}) ORDER BY project_id, created_at DESC`,
    ]);
    for (const row of taskRows) {
      const task = taskFromRow(row);
      tasksByProject.get(task.projectId)?.push(task);
    }
    for (const row of artifactRows) {
      const artifact = artifactFromRow(row);
      artifactsByProject.get(artifact.projectId)?.push(artifact);
    }
    return { tasksByProject, artifactsByProject };
  }
  const ledger = await readLedger();
  for (const task of ledger.tasks) {
    if (task.tenantId === tenantId) tasksByProject.get(task.projectId)?.push(task);
  }
  for (const artifact of ledger.artifacts) {
    if (artifact.tenantId === tenantId) artifactsByProject.get(artifact.projectId)?.push(artifact);
  }
  for (const tasks of tasksByProject.values()) tasks.sort((left, right) => left.position - right.position || left.createdAt.localeCompare(right.createdAt));
  for (const artifacts of artifactsByProject.values()) artifacts.sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  return { tasksByProject, artifactsByProject };
}

export async function getProjectArtifact(
  artifactId: string,
  options: { tenantId?: string; projectId?: string } = {},
) {
  const tenantId = normalizeTenantId(options.tenantId);
  if (hasDatabaseUrl()) {
    await ensureDatabaseSchema();
    const rows = options.projectId
      ? await getSql()`SELECT * FROM omni_project_artifacts WHERE id = ${artifactId} AND tenant_id = ${tenantId} AND project_id = ${options.projectId} LIMIT 1`
      : await getSql()`SELECT * FROM omni_project_artifacts WHERE id = ${artifactId} AND tenant_id = ${tenantId} LIMIT 1`;
    return rows[0] ? artifactFromRow(rows[0]) : undefined;
  }
  const ledger = await readLedger();
  return ledger.artifacts.find((artifact) => artifact.id === artifactId && artifact.tenantId === tenantId && (!options.projectId || artifact.projectId === options.projectId));
}

export async function listReviewedProjectArtifacts(
  options: { tenantId?: string; limit?: number } = {},
) {
  const tenantId = normalizeTenantId(options.tenantId);
  const limit = Math.min(Math.max(options.limit || 500, 1), 2_000);
  if (hasDatabaseUrl()) {
    await ensureDatabaseSchema();
    const rows = await getSql()`SELECT * FROM omni_project_artifacts WHERE tenant_id = ${tenantId} AND verdict IS NOT NULL ORDER BY reviewed_at DESC NULLS LAST LIMIT ${limit}`;
    return rows.map(artifactFromRow);
  }
  const ledger = await readLedger();
  return ledger.artifacts
    .filter((artifact) => artifact.tenantId === tenantId && artifact.verdict)
    .sort((left, right) => (right.reviewedAt || right.updatedAt).localeCompare(left.reviewedAt || left.updatedAt))
    .slice(0, limit);
}

export async function listTenantProjectArtifacts(
  options: { tenantId?: string; limit?: number } = {},
) {
  const tenantId = normalizeTenantId(options.tenantId);
  const limit = Math.min(Math.max(options.limit || 1_000, 1), 5_000);
  if (hasDatabaseUrl()) {
    await ensureDatabaseSchema();
    const rows = await getSql()`SELECT * FROM omni_project_artifacts WHERE tenant_id = ${tenantId} ORDER BY created_at DESC LIMIT ${limit}`;
    return rows.map(artifactFromRow);
  }
  const ledger = await readLedger();
  return ledger.artifacts
    .filter((artifact) => artifact.tenantId === tenantId)
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
    .slice(0, limit);
}

export async function recordProjectArtifactFeedback(
  artifactId: string,
  input: {
    verdict: ProjectArtifactVerdict;
    lesson: string;
    reflectionMemoryId: string;
  },
  options: {
    tenantId?: string;
    projectId: string;
    actorId: string;
    mutation?: ProjectMutationContext;
  },
) {
  const tenantId = normalizeTenantId(options.tenantId);
  const project = await getProject(options.projectId, options);
  if (!project) return undefined;
  const mutation = options.mutation
    ? exactProjectMutationContext(
        options.mutation,
        tenantId,
        project.actorId,
      )
    : undefined;
  const now = new Date().toISOString();
  const lesson = safeTextBlock(input.lesson, 1_200);
  if (hasDatabaseUrl()) {
    await ensureDatabaseSchema();
    if (!mutation) {
      throw new Error("Project artifact review requires an execution scope and idempotency key.");
    }
    return getSql().transaction(async (sql: ProjectSqlClient) => {
      const rows = await sql`
        UPDATE omni_project_artifacts SET verdict = ${input.verdict}, lesson = ${lesson},
          reflection_memory_id = ${input.reflectionMemoryId}, reviewed_at = ${now}, updated_at = ${now}
        WHERE id = ${artifactId} AND tenant_id = ${tenantId} AND project_id = ${options.projectId}
        RETURNING *
      `;
      const saved = rows[0] ? artifactFromRow(rows[0]) : undefined;
      if (!saved) return undefined;
      await appendProjectMutationEvent({
        mutation,
        project,
        taskId: saved.taskId,
        operation: "project_artifact_reviewed",
        status: input.verdict,
        changedFieldIds: ["lesson", "reflection_memory_id", "verdict"],
        mutationInput: input,
      }, sql);
      return saved;
    }) as Promise<ProjectArtifact | undefined>;
  }
  let updated: ProjectArtifact | undefined;
  await updateLedger((ledger) => ({
    ...ledger,
    artifacts: ledger.artifacts.map((artifact) => {
      if (artifact.id !== artifactId || artifact.tenantId !== tenantId || artifact.projectId !== options.projectId) return artifact;
      updated = { ...artifact, verdict: input.verdict, lesson, reflectionMemoryId: input.reflectionMemoryId, reviewedAt: now, updatedAt: now };
      return updated;
    }),
  }));
  if (updated && mutation) {
    await appendProjectMutationEvent({
      mutation,
      project,
      operation: "project_artifact_reviewed",
      status: input.verdict,
      changedFieldIds: ["lesson", "reflection_memory_id", "verdict"],
      mutationInput: input,
    });
  }
  return updated;
}

export async function saveProjectArtifact(input: {
  id: string;
  tenantId?: string;
  projectId: string;
  taskId: string;
  workflowRunId: string;
  agentId: SupervisorAgentId;
  status: ProjectArtifactStatus;
  title: string;
  content: string;
  memoryId?: string;
  sourceMemoryId?: string;
  evidenceRefs?: string[];
  actorId: string;
  mutation?: ProjectMutationContext;
}) {
  const now = new Date().toISOString();
  const artifact: ProjectArtifact = {
    id: safeText(input.id, 200),
    tenantId: normalizeTenantId(input.tenantId),
    projectId: safeText(input.projectId, 120),
    taskId: safeText(input.taskId, 120),
    workflowRunId: safeText(input.workflowRunId, 120),
    agentId: input.agentId,
    status: input.status,
    title: safeText(input.title, 240),
    content: safeTextBlock(input.content, 50_000),
    memoryId: optionalText(input.memoryId),
    sourceMemoryId: optionalText(input.sourceMemoryId),
    evidenceRefs: sanitizeEvidenceRefs(input.evidenceRefs),
    createdAt: now,
    updatedAt: now,
  };
  const project = await getProject(artifact.projectId, {
    tenantId: artifact.tenantId,
    actorId: input.actorId,
  });
  if (!project) throw new Error("Project not found for artifact mutation.");
  const mutation = input.mutation
    ? exactProjectMutationContext(
        input.mutation,
        artifact.tenantId,
        project.actorId,
        "delegated",
      )
    : undefined;
  if (hasDatabaseUrl()) {
    await ensureDatabaseSchema();
    if (!mutation) {
      throw new Error("Project artifact mutation requires an execution scope and idempotency key.");
    }
    return getSql().transaction(async (sql: ProjectSqlClient) => {
      const rows = await sql`
        INSERT INTO omni_project_artifacts (
          id, tenant_id, project_id, task_id, workflow_run_id, agent_id, status,
          title, content, memory_id, source_memory_id, evidence_refs, created_at, updated_at
        ) VALUES (
          ${artifact.id}, ${artifact.tenantId}, ${artifact.projectId}, ${artifact.taskId},
          ${artifact.workflowRunId}, ${artifact.agentId}, ${artifact.status}, ${artifact.title},
          ${artifact.content}, ${artifact.memoryId || null}, ${artifact.sourceMemoryId || null},
          ${artifact.evidenceRefs}, ${now}, ${now}
        )
        ON CONFLICT (id) DO UPDATE SET
          status = EXCLUDED.status, title = EXCLUDED.title, content = EXCLUDED.content,
          memory_id = COALESCE(EXCLUDED.memory_id, omni_project_artifacts.memory_id),
          source_memory_id = COALESCE(EXCLUDED.source_memory_id, omni_project_artifacts.source_memory_id),
          evidence_refs = EXCLUDED.evidence_refs, updated_at = EXCLUDED.updated_at
        WHERE omni_project_artifacts.tenant_id = EXCLUDED.tenant_id
        RETURNING *
      `;
      if (!rows[0]) throw new Error("Project artifact id collided across tenants.");
      const saved = artifactFromRow(rows[0]);
      await appendProjectMutationEvent({
        mutation,
        project,
        taskId: saved.taskId,
        operation: "project_artifact_saved",
        status: saved.status,
        changedFieldIds: [
          "content",
          "evidence_refs",
          "memory_id",
          "source_memory_id",
          "status",
          "title",
        ],
        mutationInput: {
          artifactId: artifact.id,
          status: artifact.status,
          title: artifact.title,
          contentSha256: projectMutationSha256(artifact.content),
          evidenceRefs: artifact.evidenceRefs,
        },
      }, sql);
      return saved;
    }) as Promise<ProjectArtifact>;
  }
  let saved = artifact;
  await updateLedger((ledger) => {
    const existing = ledger.artifacts.find((item) => item.id === artifact.id);
    if (existing && existing.tenantId !== artifact.tenantId) throw new Error("Project artifact id collided across tenants.");
    saved = existing ? { ...existing, ...artifact, createdAt: existing.createdAt } : artifact;
    return {
      ...ledger,
      artifacts: existing
        ? ledger.artifacts.map((item) => item.id === artifact.id ? saved : item)
        : [saved, ...ledger.artifacts],
    };
  });
  if (mutation) {
    await appendProjectMutationEvent({
      mutation,
      project,
      operation: "project_artifact_saved",
      status: saved.status,
      changedFieldIds: [
        "content",
        "evidence_refs",
        "memory_id",
        "source_memory_id",
        "status",
        "title",
      ],
      mutationInput: {
        artifactId: artifact.id,
        status: artifact.status,
        title: artifact.title,
        contentSha256: projectMutationSha256(artifact.content),
        evidenceRefs: artifact.evidenceRefs,
      },
    });
  }
  return saved;
}

export async function createProjectTasks(
  projectId: string,
  inputs: Array<ProjectTaskCommitmentInput & {
    title: string;
    detail?: string;
    priority?: ProjectTaskPriority;
    agentId?: SupervisorAgentId;
    origin?: ProjectTask["origin"];
    dueAt?: string;
  }>,
  options: {
    tenantId?: string;
    actorId?: string;
    mutation?: ProjectMutationContext;
    /** Refuse existing task identities instead of adopting partial setup. */
    requireNew?: boolean;
  },
) {
  const tenantId = normalizeTenantId(options.tenantId);
  const mutation = options.mutation
    ? exactProjectMutationContext(
        options.mutation,
        tenantId,
        options.actorId || "",
        "delegated",
      )
    : undefined;
  if (
    mutation?.executionScope.projectId &&
    mutation.executionScope.projectId !== projectId
  ) {
    throw new Error("Project task mutation scope does not match the target project.");
  }
  const mutationProject = mutation
    ? await getProject(projectId, {
        tenantId,
        actorId: options.actorId || "",
      })
    : undefined;
  if (mutation && !mutationProject) {
    throw new Error("Project not found for task mutation.");
  }
  const existing = await listProjectTasks(projectId, { tenantId });
  const existingTitles = new Set(existing.map((item) => item.title.toLowerCase()));
  const now = new Date().toISOString();
  const prepared = inputs.slice(0, 20).map((input, index) => {
    const itemMutation = mutation
      ? projectBatchMutationContext(mutation, index, inputs.length)
      : undefined;
    const id = itemMutation
      ? projectTaskIdForIdempotencyKey(
          tenantId,
          projectId,
          itemMutation.idempotencyKey,
        )
      : randomUUID();
    const replay = existing.find((item) => item.id === id);
    if (options.requireNew && replay) throw new Error("The task target already exists without this setup acceptance.");
    if (replay && !sameProjectTaskCreateRequest(replay, input)) {
      throw new Error(
        "Idempotency-Key is already bound to a different project task request.",
      );
    }
    const normalizedTitle = safeText(input.title, 240);
    if (!replay && existingTitles.has(normalizedTitle.toLowerCase())) {
      return undefined;
    }
    const task: ProjectTask = replay || {
      id,
      tenantId,
      projectId,
      title: normalizedTitle,
      detail: projectTextForWrite(input.detail || "", 1_000, "Work-item detail"),
      status: "open",
      priority: input.priority || "medium",
      agentId: input.agentId || "atlas",
      position: existing.length + index,
      origin: input.origin || "manual",
      ...applyProjectTaskDeadlinePatch({}, input),
      humanOwner: input.humanOwner === undefined || input.humanOwner === null ? undefined : projectTaskHumanOwnerSchema.parse(safeText(input.humanOwner, 160)),
      dependsOn: input.dependsOn ? projectTaskDependenciesSchema.parse(input.dependsOn) : [],
      dispatchAttempt: 0,
      createdAt: now,
      updatedAt: now,
    };
    existingTitles.add(normalizedTitle.toLowerCase());
    return { input, mutation: itemMutation, replay: Boolean(replay), task };
  }).filter((item): item is NonNullable<typeof item> => Boolean(item));
  if (!prepared.length) return [];
  if (hasDatabaseUrl()) {
    await ensureDatabaseSchema();
    if (!mutation || !mutationProject) {
      throw new Error("Project task creation requires an actor, execution scope, and idempotency key.");
    }
    return getSql().transaction(async (sql: ProjectSqlClient) => {
      const { project, tasks } = await lockProjectTaskMutation(sql, projectId, tenantId, options.actorId!);
      validateProjectTaskDependencies([...tasks, ...prepared.filter((item) => !tasks.some((task) => task.id === item.task.id)).map((item) => item.task)]);
      const savedTasks: ProjectTask[] = [];
      for (const item of prepared) {
        const rows = item.replay
          ? []
          : await insertProjectTask(sql, item.task, true);
        if (options.requireNew && !rows[0]) throw new Error("The task target already exists without this setup acceptance.");
        const saved = rows[0]
          ? taskFromRow(rows[0])
          : await getProjectTaskById(
              sql,
              item.task.id,
              tenantId,
              projectId,
            );
        if (!saved || !sameProjectTaskCreateRequest(saved, item.input)) {
          throw new Error(
            "Idempotency-Key is already bound to a different project task request.",
          );
        }
        await appendProjectMutationEvent({
          mutation: item.mutation!,
          project,
          taskId: saved.id,
          operation: "project_task_created",
          status: saved.status,
          changedFieldIds: [
            "agent_id",
            "dependency_ids",
            "detail",
            "due_at",
            ...(saved.humanOwner ? ["human_owner"] : []),
            ...(saved.dueDate ? ["due_date"] : []),
            ...(saved.dueTimeZone ? ["due_time_zone"] : []),
            "origin",
            "priority",
            "title",
          ],
          mutationInput: projectTaskCreateMutationInput(saved),
        }, sql);
        savedTasks.push(saved);
      }
      return savedTasks;
    }) as Promise<ProjectTask[]>;
  }
  const tasks = prepared.map((item) => item.task);
  const newTasks = prepared.filter((item) => !item.replay).map((item) => item.task);
  await updateLedger((ledger) => {
    const currentProject = ledger.projects.find((item) => item.id === projectId && item.tenantId === tenantId);
    if (!currentProject || currentProject.status !== "active") throw new ProjectTransitionError("Tasks can only change while their project is active.");
    const current = ledger.tasks.filter((task) => task.tenantId === tenantId && task.projectId === projectId);
    validateProjectTaskDependencies([...current, ...newTasks.filter((task) => !current.some((item) => item.id === task.id))]);
    return { ...ledger, tasks: [...ledger.tasks, ...newTasks.filter((task) => !current.some((item) => item.id === task.id))] };
  });
  if (mutation) {
    for (const item of prepared) {
      await appendProjectMutationEvent({
        mutation: item.mutation!,
        project: mutationProject!,
        taskId: item.task.id,
        operation: "project_task_created",
        status: item.task.status,
        changedFieldIds: [
          "agent_id",
          "dependency_ids",
          "detail",
          "due_at",
          ...(item.task.humanOwner ? ["human_owner"] : []),
          ...(item.task.dueDate ? ["due_date"] : []),
          ...(item.task.dueTimeZone ? ["due_time_zone"] : []),
          "origin",
          "priority",
          "title",
        ],
        mutationInput: projectTaskCreateMutationInput(item.task),
      });
    }
  }
  return tasks;
}

export async function replaceProjectTaskDependencies(
  projectId: string,
  dependencies: Array<{ taskId: string; dependsOn: string[] }>,
  options: {
    tenantId?: string;
    actorId?: string;
    mutation?: ProjectMutationContext;
  },
) {
  const tenantId = normalizeTenantId(options.tenantId);
  const safe = dependencies.map((item) => ({ taskId: item.taskId, dependsOn: projectTaskDependenciesSchema.parse(item.dependsOn) }));
  if (new Set(safe.map((item) => item.taskId)).size !== safe.length) throw new ProjectTransitionError("A task can have only one dependency replacement per request.");
  if (!safe.length) return listProjectTasks(projectId, { tenantId });
  const apply = (tasks: ProjectTask[]) => {
    if (safe.some((item) => !tasks.some((task) => task.id === item.taskId))) throw new ProjectTransitionError("Every changed task must belong to this project.");
    const next = tasks.map((task) => {
      const replacement = safe.find((item) => item.taskId === task.id);
      if (replacement) assertTaskDependencyChangeAllowed(task, replacement.dependsOn);
      return replacement ? { ...task, dependsOn: replacement.dependsOn, updatedAt: new Date().toISOString() } : task;
    });
    validateProjectTaskDependencies(next);
    return next;
  };
  const project = options.actorId
    ? await getProject(projectId, {
        tenantId,
        actorId: options.actorId,
      })
    : undefined;
  const mutation = project && options.mutation
    ? exactProjectMutationContext(
        options.mutation,
        tenantId,
        project.actorId,
        "delegated",
      )
    : undefined;
  if (mutation?.executionScope.projectId && mutation.executionScope.projectId !== projectId) {
    throw new ProjectTransitionError("Project task mutation scope does not match the target project.");
  }
  if (hasDatabaseUrl()) {
    await ensureDatabaseSchema();
    if (!project || !mutation) {
      throw new Error("Project dependency mutation requires an actor, execution scope, and idempotency key.");
    }
    await getSql().transaction(async (sql: ProjectSqlClient) => {
      const locked = await lockProjectTaskMutation(sql, projectId, tenantId, project.actorId);
      apply(locked.tasks);
      for (const item of safe) {
        await sql`UPDATE omni_project_tasks SET dependency_ids = ${item.dependsOn}::jsonb, updated_at = NOW() WHERE id = ${item.taskId} AND project_id = ${projectId} AND tenant_id = ${tenantId}`;
      }
      await appendProjectMutationEvent({
        mutation,
        project: locked.project,
        taskIds: safe.map((item) => item.taskId),
        operation: "project_task_dependencies_replaced",
        status: project.status,
        changedFieldIds: ["dependency_ids"],
        mutationInput: safe,
      }, sql);
    });
  } else {
    await updateLedger((ledger) => {
      const currentProject = ledger.projects.find((item) => item.id === projectId && item.tenantId === tenantId);
      if (!currentProject || currentProject.status !== "active") throw new ProjectTransitionError("Tasks can only change while their project is active.");
      const next = new Map(apply(ledger.tasks.filter((task) => task.tenantId === tenantId && task.projectId === projectId)).map((task) => [task.id, task]));
      return { ...ledger, tasks: ledger.tasks.map((task) => task.tenantId === tenantId && task.projectId === projectId ? next.get(task.id)! : task) };
    });
    if (project && mutation) {
      await appendProjectMutationEvent({
        mutation,
        project,
        operation: "project_task_dependencies_replaced",
        status: project.status,
        changedFieldIds: ["dependency_ids"],
        mutationInput: safe,
      });
    }
  }
  return listProjectTasks(projectId, { tenantId });
}

export async function claimProjectTaskForDispatch(
  projectId: string,
  taskId: string,
  options: {
    tenantId?: string;
    actorId?: string;
    mutation?: ProjectMutationContext;
  },
) {
  const tenantId = normalizeTenantId(options.tenantId);
  const project = options.actorId
    ? await getProject(projectId, { tenantId, actorId: options.actorId })
    : undefined;
  const mutation = project && options.mutation
    ? exactProjectMutationContext(
        options.mutation,
        tenantId,
        project.actorId,
        "delegated",
      )
    : undefined;
  const now = new Date().toISOString();
  if (hasDatabaseUrl()) {
    await ensureDatabaseSchema();
    if (!project || !mutation) {
      throw new Error("Project task dispatch requires an actor, execution scope, and idempotency key.");
    }
    return getSql().transaction(async (sql: ProjectSqlClient) => {
      const locked = await lockProjectTaskMutation(sql, projectId, tenantId, project.actorId);
      const current = locked.tasks.find((task) => task.id === taskId);
      if (!current || !projectTaskDependenciesCompleted(current, locked.tasks)) return undefined;
      const rows = await sql`
        UPDATE omni_project_tasks SET workflow_status = 'dispatching', dispatched_at = ${now},
          dispatch_attempt = dispatch_attempt + 1, execution_error = NULL, updated_at = ${now}
        WHERE id = ${taskId} AND project_id = ${projectId} AND tenant_id = ${tenantId}
          AND status = 'open' AND workflow_run_id IS NULL AND workflow_status IS NULL
        RETURNING *
      `;
      const saved = rows[0] ? taskFromRow(rows[0]) : undefined;
      if (!saved) return undefined;
      await appendProjectMutationEvent({
        mutation,
        project,
        taskId,
        operation: "project_task_dispatch_claimed",
        status: saved.workflowStatus || saved.status,
        changedFieldIds: [
          "dispatch_attempt",
          "dispatched_at",
          "execution_error",
          "workflow_status",
        ],
        mutationInput: {
          taskId,
          dispatchAttempt: saved.dispatchAttempt,
        },
      }, sql);
      return saved;
    }) as Promise<ProjectTask | undefined>;
  }
  let claimed: ProjectTask | undefined;
  await updateLedger((ledger) => ({
    ...ledger,
    tasks: ledger.tasks.map((task) => {
      if (task.id !== taskId || task.projectId !== projectId || task.tenantId !== tenantId || task.status !== "open" || task.workflowRunId || task.workflowStatus ||
        !projectTaskDependenciesCompleted(task, ledger.tasks.filter((item) => item.projectId === projectId && item.tenantId === tenantId))) return task;
      claimed = { ...task, workflowStatus: "dispatching", dispatchedAt: now, dispatchAttempt: (task.dispatchAttempt || 0) + 1, executionError: undefined, updatedAt: now };
      return claimed;
    }),
  }));
  if (claimed && project && mutation) {
    await appendProjectMutationEvent({
      mutation,
      project,
      taskId,
      operation: "project_task_dispatch_claimed",
      status: claimed.workflowStatus || claimed.status,
      changedFieldIds: [
        "dispatch_attempt",
        "dispatched_at",
        "execution_error",
        "workflow_status",
      ],
      mutationInput: { taskId, dispatchAttempt: claimed.dispatchAttempt },
    });
  }
  return claimed;
}

export async function updateProjectTaskExecution(
  projectId: string,
  taskId: string,
  patch: Pick<ProjectTask, "status"> & Partial<Pick<ProjectTask, "workflowRunId" | "workflowStatus" | "executionError" | "completedAt">>,
  options: {
    tenantId?: string;
    actorId?: string;
    mutation?: ProjectMutationContext;
  },
) {
  const tenantId = normalizeTenantId(options.tenantId);
  const project = options.actorId
    ? await getProject(projectId, { tenantId, actorId: options.actorId })
    : undefined;
  const mutation = project && options.mutation
    ? exactProjectMutationContext(
        options.mutation,
        tenantId,
        project.actorId,
        "delegated",
      )
    : undefined;
  const now = new Date().toISOString();
  if (hasDatabaseUrl()) {
    await ensureDatabaseSchema();
    if (!project || !mutation) {
      throw new Error("Project task execution mutation requires an actor, execution scope, and idempotency key.");
    }
    return getSql().transaction(async (sql: ProjectSqlClient) => {
      const rows = await sql`
        UPDATE omni_project_tasks SET status = ${patch.status}, workflow_run_id = ${patch.workflowRunId || null},
          workflow_status = ${patch.workflowStatus || null}, execution_error = ${patch.executionError || null},
          completed_at = ${patch.completedAt || null}, updated_at = ${now}
        WHERE id = ${taskId} AND project_id = ${projectId} AND tenant_id = ${tenantId}
        RETURNING *
      `;
      const saved = rows[0] ? taskFromRow(rows[0]) : undefined;
      if (!saved) return undefined;
      await appendProjectMutationEvent({
        mutation,
        project,
        taskId,
        operation: "project_task_execution_updated",
        status: saved.workflowStatus || saved.status,
        changedFieldIds: Object.keys(patch),
        mutationInput: patch,
      }, sql);
      return saved;
    }) as Promise<ProjectTask | undefined>;
  }
  let updated: ProjectTask | undefined;
  await updateLedger((ledger) => ({
    ...ledger,
    tasks: ledger.tasks.map((task) => {
      if (task.id !== taskId || task.projectId !== projectId || task.tenantId !== tenantId) return task;
      updated = {
        ...task,
        ...patch,
        workflowRunId: patch.workflowRunId,
        workflowStatus: patch.workflowStatus,
        executionError: patch.executionError,
        completedAt: patch.completedAt,
        updatedAt: now,
      };
      return updated;
    }),
  }));
  if (updated && project && mutation) {
    await appendProjectMutationEvent({
      mutation,
      project,
      taskId,
      operation: "project_task_execution_updated",
      status: updated.workflowStatus || updated.status,
      changedFieldIds: Object.keys(patch),
      mutationInput: patch,
    });
  }
  return updated;
}

export async function updateProjectTask(
  projectId: string,
  taskId: string,
  input: ProjectTaskCommitmentInput & { title?: string; detail?: string; status?: ProjectTaskStatus; priority?: ProjectTaskPriority; agentId?: SupervisorAgentId; dueAt?: string | null },
  options: {
    tenantId?: string;
    actorId: string;
    mutation?: ProjectMutationContext;
  },
) {
  const tenantId = normalizeTenantId(options.tenantId);
  const project = await getProject(projectId, options);
  if (!project) return undefined;
  const mutation = options.mutation
    ? exactProjectMutationContext(
        options.mutation,
        tenantId,
        project.actorId,
      )
    : undefined;
  if (
    mutation?.executionScope.projectId &&
    mutation.executionScope.projectId !== projectId
  ) {
    throw new Error("Project task mutation scope does not match the target project.");
  }
  if (project.status !== "active") {
    throw new ProjectTransitionError("Tasks can only change while their project is active.");
  }
  const apply = (current: ProjectTask, tasks: ProjectTask[], now: string): ProjectTask => {
    if (input.dependsOn !== undefined) assertTaskDependencyChangeAllowed(current, input.dependsOn);
    if (input.status && !canTransitionTask(current.status, input.status)) {
      throw new ProjectTransitionError(`Task cannot move from ${current.status} to ${input.status}.`);
    }
    let commitments;
    try {
      commitments = {
        ...applyProjectTaskDeadlinePatch(current, input),
        humanOwner: input.humanOwner === undefined ? current.humanOwner : input.humanOwner === null ? undefined : projectTaskHumanOwnerSchema.parse(safeText(input.humanOwner, 160)),
        dependsOn: input.dependsOn === undefined ? current.dependsOn : projectTaskDependenciesSchema.parse(input.dependsOn),
      };
    } catch (error) { throw new ProjectTransitionError(error instanceof Error ? error.message : "Invalid commitment fields."); }
    const next: ProjectTask = {
      ...current,
      title: input.title ? safeText(input.title, 240) : current.title,
      detail: input.detail !== undefined ? projectTextForWrite(input.detail, 1_000, "Work-item detail") : current.detail,
      status: input.status || current.status,
      priority: input.priority || current.priority,
      agentId: input.agentId || current.agentId,
      ...commitments,
      completedAt: input.status === "done" ? now : input.status === "open" || input.status === "doing" ? undefined : current.completedAt,
      workflowRunId: input.status === "open" ? undefined : current.workflowRunId,
      workflowStatus: input.status === "open" ? undefined : current.workflowStatus,
      executionError: input.status === "open" ? undefined : current.executionError,
      updatedAt: now,
    };
    if (input.dependsOn !== undefined) validateProjectTaskDependencies(tasks.map((task) => task.id === next.id ? next : task));
    return next;
  };
  const record = async (saved: ProjectTask, currentProject: PersonalProject, sql?: ProjectSqlClient) => {
    if (!mutation) return;
    await appendProjectMutationEvent({ mutation, project: currentProject, taskId: saved.id,
      operation: "project_task_updated", status: saved.status,
      changedFieldIds: Object.keys(input), mutationInput: input }, sql);
  };
  if (hasDatabaseUrl()) {
    await ensureDatabaseSchema();
    if (!mutation) throw new Error("Project task update requires an execution scope and idempotency key.");
    return getSql().transaction(async (sql: ProjectSqlClient) => {
      const locked = await lockProjectTaskMutation(sql, projectId, tenantId, options.actorId);
      if (locked.project.status !== "active") throw new ProjectTransitionError("Tasks can only change while their project is active.");
      const current = locked.tasks.find((task) => task.id === taskId);
      if (!current) return undefined;
      const now = new Date().toISOString();
      const next = apply(current, locked.tasks, now);
      const rows = await updateProjectTaskRow(sql, next, now);
      const saved = rows[0] ? taskFromRow(rows[0]) : undefined;
      if (saved) await record(saved, locked.project, sql);
      return saved;
    }) as Promise<ProjectTask | undefined>;
  }
  let saved: ProjectTask | undefined;
  await updateLedger((ledger) => {
    const currentProject = ledger.projects.find((item) => item.id === projectId && item.tenantId === tenantId && item.actorId === options.actorId);
    if (!currentProject) return ledger;
    if (currentProject.status !== "active") throw new ProjectTransitionError("Tasks can only change while their project is active.");
    const tasks = ledger.tasks.filter((task) => task.tenantId === tenantId && task.projectId === projectId);
    const current = tasks.find((task) => task.id === taskId);
    if (!current) return ledger;
    saved = apply(current, tasks, new Date().toISOString());
    return { ...ledger, tasks: ledger.tasks.map((task) => task.id === taskId && task.tenantId === tenantId && task.projectId === projectId ? saved! : task) };
  });
  if (saved) await record(saved, project);
  return saved;
}

export function canTransitionProject(from: ProjectStatus, to: ProjectStatus) {
  if (from === to) return true;
  const transitions: Record<ProjectStatus, ProjectStatus[]> = {
    draft: ["active", "archived"],
    active: ["completed", "archived"],
    completed: ["active", "archived"],
    archived: ["active"],
  };
  return transitions[from].includes(to);
}

export function canTransitionTask(from: ProjectTaskStatus, to: ProjectTaskStatus) {
  if (from === to) return true;
  const transitions: Record<ProjectTaskStatus, ProjectTaskStatus[]> = {
    open: ["doing", "done"],
    doing: ["open", "done"],
    done: ["open"],
  };
  return transitions[from].includes(to);
}

export class ProjectTransitionError extends Error {}

type ProjectSqlClient = ReturnType<typeof getSql>;

function validateProjectTaskDependencies(tasks: readonly ProjectTask[]) {
  try { assertProjectTaskDependencyGraph(tasks); }
  catch (error) { throw new ProjectTransitionError(error instanceof Error ? error.message : "Invalid task dependencies."); }
}

function projectTaskDependenciesCompleted(task: ProjectTask, tasks: readonly ProjectTask[]) {
  const completed = new Set(tasks.filter((item) => item.status === "done").map((item) => item.id));
  return task.dependsOn.every((id) => completed.has(id));
}

function assertTaskDependencyChangeAllowed(task: ProjectTask, dependsOn: readonly string[]) {
  if (JSON.stringify([...dependsOn].sort()) !== JSON.stringify(task.dependsOn.slice().sort()) &&
    task.workflowStatus && ["dispatching", "queued", "running", "waiting_approval", "paused"].includes(task.workflowStatus)) {
    throw new ProjectTransitionError("Dependencies cannot change while this task has an active workflow.");
  }
}

/** Every dependency writer takes the same parent lock before reading the graph.
 * Validation and mutation therefore see one serial order even for opposing edges. */
async function lockProjectTaskMutation(sql: ProjectSqlClient, projectId: string, tenantId: string, actorId: string) {
  const projects = await sql.query(`SELECT * FROM omni_projects WHERE id = $1 AND tenant_id = $2 AND actor_id = $3 FOR UPDATE`, [projectId, tenantId, actorId]);
  if (projects.length !== 1) throw new ProjectTransitionError("Project not found for task mutation.");
  const project = projectFromRow(projects[0]);
  if (project.status !== "active") throw new ProjectTransitionError("Tasks can only change while their project is active.");
  const rows = await sql.query(`SELECT * FROM omni_project_tasks WHERE project_id = $1 AND tenant_id = $2 ORDER BY id LIMIT 10001 FOR UPDATE`, [projectId, tenantId]);
  if (rows.length > 10_000) throw new ProjectTransitionError("The project has too many tasks to validate dependencies safely.");
  return { project, tasks: rows.map(taskFromRow) };
}

function exactProjectMutationContext(
  value: ProjectMutationContext,
  tenantId: string,
  actorId: string,
  fallbackPrincipalMode: "interactive_user" | "delegated" = "interactive_user",
) {
  const executionScope = parsePersistedExecutionScope(value.executionScope);
  if (!executionScope) {
    throw new Error("Project mutation requires an execution scope.");
  }
  assertExecutionScopeTenant(executionScope, tenantId);
  const exactActorId = safeText(actorId, 200);
  const actorMatches = Boolean(executionScope.initiatingActorId) &&
    executionScope.initiatingActorId === exactActorId;
  // App services admit the initiating user or their attributed Agent. Internal
  // workflow callers retain their explicit delegated mode; interactive callers
  // remain user-only unless a trusted service selected the narrower admission.
  const principalMode = value.principalMode ?? fallbackPrincipalMode;
  const userPrincipalMatches = executionScope.executingPrincipalType === "user" &&
    executionScope.executingPrincipalId === exactActorId;
  const principalMatches = principalMode === "delegated"
    ? Boolean(executionScope.executingPrincipalId)
    : userPrincipalMatches || (
        principalMode === "user_or_agent" &&
        executionScope.executingPrincipalType === "agent" &&
        Boolean(executionScope.executingPrincipalId)
      );
  if (!actorMatches || !principalMatches) {
    throw new Error(
      principalMode === "delegated"
        ? "Project mutation scope must bind its initiating actor and executing principal."
        : principalMode === "user_or_agent"
          ? "Project mutation scope must bind its initiating actor and a user or agent principal."
          : "Interactive project mutation scope must bind the initiating user principal.",
    );
  }
  const idempotencyKey = value.idempotencyKey.trim();
  if (
    !idempotencyKey ||
    idempotencyKey.length > 200 ||
    !/^[A-Za-z0-9._:-]+$/.test(idempotencyKey)
  ) {
    throw new Error(
      "Project mutation Idempotency-Key must use 1-200 letters, numbers, dots, underscores, colons, or hyphens.",
    );
  }
  return { executionScope, idempotencyKey } as const;
}

function projectBatchMutationContext(
  mutation: ReturnType<typeof exactProjectMutationContext>,
  index: number,
  inputCount: number,
) {
  if (inputCount === 1) return mutation;
  return {
    executionScope: mutation.executionScope,
    idempotencyKey: `project-task-batch:${projectMutationSha256({
      rootIdempotencyKey: mutation.idempotencyKey,
      index,
    })}`,
  } as const;
}

async function insertProject(
  sql: ProjectSqlClient,
  project: PersonalProject,
  now: string,
  idempotent = false,
) {
  const conflictClause = idempotent ? "ON CONFLICT (id) DO NOTHING" : "";
  return sql.query(
    `INSERT INTO omni_projects (
       id, tenant_id, actor_id, title, objective, status, autonomy_mode,
       execution_status, task_budget, tasks_dispatched, max_parallel_tasks,
       require_approval, target_date, created_at, updated_at
     ) VALUES (
       $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15
     ) ${conflictClause}
     RETURNING *`,
    [
      project.id,
      project.tenantId,
      project.actorId,
      project.title,
      project.objective,
      project.status,
      project.autonomyMode,
      project.executionStatus,
      project.taskBudget,
      project.tasksDispatched,
      project.maxParallelTasks,
      project.requireApproval,
      project.targetDate || null,
      now,
      now,
    ],
  );
}

async function getProjectById(
  sql: ProjectSqlClient,
  projectId: string,
  tenantId: string,
) {
  const rows = await sql.query(
    "SELECT * FROM omni_projects WHERE id = $1 AND tenant_id = $2 LIMIT 1",
    [projectId, tenantId],
  );
  return rows[0] ? projectFromRow(rows[0]) : undefined;
}

async function updateProjectRow(
  sql: ProjectSqlClient,
  project: PersonalProject,
  now: string,
) {
  return sql.query(
    `UPDATE omni_projects SET
       title = $1, objective = $2, status = $3, target_date = $4,
       execution_status = $5, completed_at = $6, updated_at = $7
     WHERE id = $8 AND tenant_id = $9 AND actor_id = $10
     RETURNING *`,
    [
      project.title,
      project.objective,
      project.status,
      project.targetDate || null,
      project.executionStatus,
      project.completedAt || null,
      now,
      project.id,
      project.tenantId,
      project.actorId,
    ],
  );
}

async function insertProjectTask(
  sql: ProjectSqlClient,
  task: ProjectTask,
  idempotent = false,
) {
  const conflictClause = idempotent ? "ON CONFLICT (id) DO NOTHING" : "";
  return sql.query(
    `INSERT INTO omni_project_tasks (
       id, tenant_id, project_id, title, detail, status, priority, agent_id,
       position, origin, due_at, dependency_ids, created_at, updated_at,
       human_owner, due_date, due_time_zone
     ) VALUES (
       $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::jsonb, $13, $14,
       $15, $16::date, $17
     ) ${conflictClause}
     RETURNING *`,
    [
      task.id,
      task.tenantId,
      task.projectId,
      task.title,
      task.detail,
      task.status,
      task.priority,
      task.agentId,
      task.position,
      task.origin,
      task.dueAt || null,
      JSON.stringify(task.dependsOn),
      task.createdAt,
      task.updatedAt,
      task.humanOwner || null,
      task.dueDate || null,
      task.dueTimeZone || null,
    ],
  );
}

async function getProjectTaskById(
  sql: ProjectSqlClient,
  taskId: string,
  tenantId: string,
  projectId: string,
) {
  const rows = await sql.query(
    `SELECT * FROM omni_project_tasks
     WHERE id = $1 AND tenant_id = $2 AND project_id = $3
     LIMIT 1`,
    [taskId, tenantId, projectId],
  );
  return rows[0] ? taskFromRow(rows[0]) : undefined;
}

async function updateProjectTaskRow(
  sql: ProjectSqlClient,
  task: ProjectTask,
  now: string,
) {
  return sql.query(
    `UPDATE omni_project_tasks SET
       title = $1, detail = $2, status = $3, priority = $4, agent_id = $5,
       due_at = $6, workflow_run_id = $7, workflow_status = $8,
       execution_error = $9, completed_at = $10, updated_at = $11,
       human_owner = $15, due_date = $16::date, due_time_zone = $17,
       dependency_ids = $18::jsonb
     WHERE id = $12 AND project_id = $13 AND tenant_id = $14
     RETURNING *`,
    [
      task.title,
      task.detail,
      task.status,
      task.priority,
      task.agentId,
      task.dueAt || null,
      task.workflowRunId || null,
      task.workflowStatus || null,
      task.executionError || null,
      task.completedAt || null,
      now,
      task.id,
      task.projectId,
      task.tenantId,
      task.humanOwner || null,
      task.dueDate || null,
      task.dueTimeZone || null,
      JSON.stringify(task.dependsOn),
    ],
  );
}

// Direct create replay keeps its historical whitespace equivalence and digest.
// The first saved paragraph layout is returned unchanged. Governed tool calls
// additionally bind their exact input before reaching this store.
function projectCreateMutationInput(project: PersonalProject) {
  return {
    title: project.title,
    objective: safeText(project.objective, 2_000),
    status: project.status,
    targetDate: project.targetDate || null,
  };
}

function sameProjectCreateRequest(
  existing: PersonalProject,
  requested: PersonalProject,
) {
  return existing.tenantId === requested.tenantId &&
    existing.actorId === requested.actorId &&
    projectMutationSha256(projectCreateMutationInput(existing)) ===
      projectMutationSha256(projectCreateMutationInput(requested));
}

function projectTaskCreateMutationInput(task: ProjectTask) {
  return {
    title: task.title,
    detail: safeText(task.detail, 1_000),
    priority: task.priority,
    agentId: task.agentId,
    origin: task.origin,
    dueAt: task.dueAt || null,
    ...(task.humanOwner ? { humanOwner: task.humanOwner } : {}),
    ...(task.dueDate ? { dueDate: task.dueDate } : {}),
    ...(task.dueTimeZone ? { dueTimeZone: task.dueTimeZone } : {}),
    dependsOn: task.dependsOn,
  };
}

function sameProjectTaskCreateRequest(
  existing: ProjectTask,
  requested: ProjectTaskCommitmentInput & {
    title: string;
    detail?: string;
    priority?: ProjectTaskPriority;
    agentId?: SupervisorAgentId;
    origin?: ProjectTask["origin"];
    dueAt?: string;
  },
) {
  return projectMutationSha256(projectTaskCreateMutationInput(existing)) ===
    projectMutationSha256({
      title: safeText(requested.title, 240),
      detail: safeText(projectTextForWrite(requested.detail || "", 1_000, "Work-item detail"), 1_000),
      priority: requested.priority || "medium",
      agentId: requested.agentId || "atlas",
      origin: requested.origin || "manual",
      dueAt: applyProjectTaskDeadlinePatch({}, requested).dueAt || null,
      ...(requested.humanOwner ? { humanOwner: safeText(requested.humanOwner, 160) } : {}),
      ...(requested.dueDate ? { dueDate: requested.dueDate } : {}),
      ...(requested.dueTimeZone ? { dueTimeZone: requested.dueTimeZone } : {}),
      dependsOn: requested.dependsOn ? projectTaskDependenciesSchema.parse(requested.dependsOn) : [],
    });
}

async function appendProjectMutationEvent(
  input: {
    mutation: ReturnType<typeof exactProjectMutationContext>;
    project: PersonalProject;
    taskId?: string;
    taskIds?: string[];
    operation: "project_created" | "project_updated" |
      "project_task_created" | "project_task_updated" |
      "project_execution_updated" |
      "project_task_dependencies_replaced" |
      "project_task_dispatch_claimed" |
      "project_task_execution_updated" |
      "project_artifact_saved" |
      "project_artifact_reviewed";
    priorStatus?: string;
    status: string;
    changedFieldIds: string[];
    mutationInput: unknown;
  },
  sql?: ProjectSqlClient,
) {
  if (sql) {
    const taskIds = [...new Set([
      ...(input.taskId ? [input.taskId] : []),
      ...(input.taskIds || []),
    ])];
    if (!taskIds.length) {
      await projectCanonicalShadowWrite({
        sql,
        project: input.project,
        attribution: {
          executionScope: input.mutation.executionScope,
          changedFieldIds: input.changedFieldIds,
        },
      });
    } else {
      for (const taskId of taskIds) {
        const task = await getProjectTaskById(
          sql,
          taskId,
          input.project.tenantId,
          input.project.id,
        );
        if (!task) {
          throw new Error("Canonical WorkItem source is unavailable.");
        }
        await projectCanonicalShadowWrite({
          sql,
          project: input.project,
          task,
          attribution: {
            executionScope: input.mutation.executionScope,
            changedFieldIds: input.changedFieldIds,
          },
        });
      }
    }
  }
  const payload = projectMutationEventPayloadSchema.parse({
    schemaVersion: PROJECT_EVENT_SCHEMA_VERSION,
    projectId: input.project.id,
    taskId: input.taskId || null,
    operation: input.operation,
    priorStatus: input.priorStatus || null,
    status: input.status,
    changedFieldIds: [...new Set(input.changedFieldIds)].sort(),
    mutationInputSha256: projectMutationSha256(input.mutationInput),
    idempotencyKeySha256: projectMutationSha256({
      tenantId: input.project.tenantId,
      idempotencyKey: input.mutation.idempotencyKey,
    }),
  });
  await appendScopedDomainEvent({
    id: projectMutationEventId({
      tenantId: input.project.tenantId,
      operation: input.operation,
      idempotencyKey: input.mutation.idempotencyKey,
    }),
    streamId: `project:${input.project.id}`,
    type: input.operation.replaceAll("_", "."),
    executionScope: input.mutation.executionScope,
    payload,
  }, sql ? { sql } : {});
}

async function readLedger() {
  const ledger = await readJsonFile<ProjectLedger>(getDataPath("projects.json"), { projects: [], tasks: [], artifacts: [] });
  return {
    projects: ledger.projects.map((project) => ({
      ...project,
      autonomyMode: project.autonomyMode || "manual",
      executionStatus: project.executionStatus || "idle",
      taskBudget: project.taskBudget || 12,
      tasksDispatched: project.tasksDispatched || 0,
      maxParallelTasks: project.maxParallelTasks || 1,
      requireApproval: project.requireApproval ?? true,
    })),
    tasks: ledger.tasks.map((task) => ({ ...task, dependsOn: task.dependsOn || [], dispatchAttempt: task.dispatchAttempt || 0 })),
    artifacts: (ledger.artifacts || []).map((artifact) => ({ ...artifact, evidenceRefs: artifact.evidenceRefs || [] })),
  };
}
function updateLedger(mutate: (ledger: ProjectLedger) => ProjectLedger) {
  return updateJsonFile<ProjectLedger>(getDataPath("projects.json"), { projects: [], tasks: [], artifacts: [] }, (ledger) => {
    const next = mutate({ ...ledger, artifacts: ledger.artifacts || [] });
    return { projects: next.projects.slice(0, 250), tasks: next.tasks.slice(-5_000), artifacts: next.artifacts.slice(0, 5_000) };
  });
}
function projectFromRow(row: Record<string, unknown>): PersonalProject {
  return { id: String(row.id), tenantId: String(row.tenant_id), actorId: String(row.actor_id), title: safeText(row.title, 180), objective: safeTextBlock(row.objective, 2_000), status: String(row.status) as ProjectStatus, autonomyMode: String(row.autonomy_mode || "manual") as ProjectAutonomyMode, executionStatus: String(row.execution_status || "idle") as ProjectExecutionStatus, taskBudget: Number(row.task_budget || 12), tasksDispatched: Number(row.tasks_dispatched || 0), maxParallelTasks: Number(row.max_parallel_tasks || 1), requireApproval: row.require_approval === undefined ? true : Boolean(row.require_approval), lastSyncedAt: optionalDateValue(row.last_synced_at), targetDate: optionalDateValue(row.target_date), createdAt: dateValue(row.created_at), updatedAt: dateValue(row.updated_at), completedAt: optionalDateValue(row.completed_at) };
}
function projectSummaryFromRow(row: Record<string, unknown>): ProjectSummary {
  return {
    ...projectFromRow(row),
    taskCount: Number(row.task_count || 0),
    completedTaskCount: Number(row.completed_task_count || 0),
    activeTaskCount: Number(row.active_task_count || 0),
    artifactCount: Number(row.artifact_count || 0),
  };
}
function projectForRequest<T extends PersonalProject>(project: T, requestActorId: string): T {
  return { ...project, actorId: requestActorId };
}
function taskFromRow(row: Record<string, unknown>): ProjectTask {
  return { id: String(row.id), tenantId: String(row.tenant_id), projectId: String(row.project_id), title: safeText(row.title, 240), detail: safeTextBlock(row.detail, 1_000), status: String(row.status) as ProjectTaskStatus, priority: String(row.priority) as ProjectTaskPriority, agentId: String(row.agent_id) as SupervisorAgentId, position: Number(row.position), origin: String(row.origin) === "agent" ? "agent" : "manual", dueAt: optionalDateValue(row.due_at), humanOwner: optionalText(row.human_owner), dueDate: row.due_date ? (row.due_date instanceof Date ? row.due_date.toISOString().slice(0, 10) : String(row.due_date)) : undefined, dueTimeZone: optionalText(row.due_time_zone), dependsOn: jsonDependencyIds(row.dependency_ids), workflowRunId: optionalText(row.workflow_run_id), workflowStatus: optionalText(row.workflow_status) as ProjectTask["workflowStatus"], executionError: optionalText(row.execution_error), dispatchedAt: optionalDateValue(row.dispatched_at), dispatchAttempt: Number(row.dispatch_attempt || 0), createdAt: dateValue(row.created_at), updatedAt: dateValue(row.updated_at), completedAt: optionalDateValue(row.completed_at) };
}
function artifactFromRow(row: Record<string, unknown>): ProjectArtifact {
  return { id: String(row.id), tenantId: String(row.tenant_id), projectId: String(row.project_id), taskId: String(row.task_id), workflowRunId: String(row.workflow_run_id), agentId: String(row.agent_id) as SupervisorAgentId, status: String(row.status) as ProjectArtifactStatus, title: safeText(row.title, 240), content: safeTextBlock(row.content, 50_000), memoryId: optionalText(row.memory_id), sourceMemoryId: optionalText(row.source_memory_id), verdict: optionalText(row.verdict) as ProjectArtifactVerdict | undefined, lesson: optionalText(row.lesson), reflectionMemoryId: optionalText(row.reflection_memory_id), reviewedAt: optionalDateValue(row.reviewed_at), evidenceRefs: jsonStringArray(row.evidence_refs), createdAt: dateValue(row.created_at), updatedAt: dateValue(row.updated_at) };
}
function compareProjects(left: PersonalProject, right: PersonalProject) { const order: Record<ProjectStatus, number> = { active: 0, draft: 1, completed: 2, archived: 3 }; return order[left.status] - order[right.status] || right.updatedAt.localeCompare(left.updatedAt) || left.id.localeCompare(right.id); }
function optionalDate(value?: string | null) { if (!value) return undefined; const timestamp = Date.parse(value); return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : undefined; }
function optionalDateValue(value: unknown) { return value ? dateValue(value) : undefined; }
function dateValue(value: unknown) { return value instanceof Date ? value.toISOString() : String(value); }
function safeText(value: unknown, max: number) { return String(redactSensitive(String(value || ""))).replace(/\s+/g, " ").trim().slice(0, max); }
function safeTextBlock(value: unknown, max: number) { return String(redactSensitive(String(value || ""))).trim().slice(0, max); }
function projectTextForWrite(value: string, max: number, label: string) {
  const text = value.trim();
  if (text.length > max) {
    throw new ProjectTransitionError(`${label} has ${text.length} characters after trimming; limit ${max}.`);
  }
  const redacted = String(redactSensitive(text)).trim();
  if (redacted.length > max) {
    throw new ProjectTransitionError(`${label} exceeds the ${max}-character limit after redaction.`);
  }
  return redacted;
}
function optionalText(value: unknown) { const text = value === undefined || value === null ? "" : String(value).trim(); return text || undefined; }
function sanitizeIds(value?: string[]) { return [...new Set((value || []).map((id) => safeText(id, 120)).filter(Boolean))].slice(0, 20); }
function sanitizeEvidenceRefs(value?: string[]) { return [...new Set((value || []).map((item) => safeText(item, 240)).filter(Boolean))].slice(0, 32); }
function jsonDependencyIds(value: unknown): string[] {
  if (Array.isArray(value)) return [...new Set(value.map(String))];
  if (typeof value === "string") { try { return jsonDependencyIds(JSON.parse(value)); } catch { return []; } }
  return [];
}
function jsonStringArray(value: unknown) { if (Array.isArray(value)) return sanitizeIds(value.map(String)); if (typeof value === "string") { try { return jsonStringArray(JSON.parse(value)); } catch { return []; } } return []; }
function boundedInteger(value: number | undefined, fallback: number, min: number, max: number) { return value === undefined ? fallback : Math.min(Math.max(Math.trunc(value), min), max); }
function normalizeTenantId(value?: string) { return (value || getDatabaseTenantContext() || process.env.OMNIAGENT_DEFAULT_TENANT || "default").trim().replace(/[^a-zA-Z0-9_.:-]/g, "_").slice(0, 120) || "default"; }
