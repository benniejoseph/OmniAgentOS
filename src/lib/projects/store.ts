import { randomUUID } from "node:crypto";
import {
  ensureDatabaseSchema,
  getDatabaseTenantContext,
  getSql,
  hasDatabaseUrl,
} from "@/lib/db/client";
import type { SupervisorAgentId } from "@/lib/orchestration/supervisor";
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
import { redactSensitive } from "@/lib/security/context";
import { readJsonFile, updateJsonFile } from "@/lib/storage/json";
import { getDataPath } from "@/lib/storage/paths";

export async function createProject(input: {
  tenantId?: string;
  actorId: string;
  title: string;
  objective: string;
  status?: ProjectStatus;
  targetDate?: string;
}) {
  const now = new Date().toISOString();
  const project: PersonalProject = {
    id: randomUUID(),
    tenantId: normalizeTenantId(input.tenantId),
    actorId: safeText(input.actorId, 200),
    title: safeText(input.title, 180),
    objective: safeText(input.objective, 2_000),
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
    const rows = await getSql()`
      INSERT INTO omni_projects (
        id, tenant_id, actor_id, title, objective, status, autonomy_mode,
        execution_status, task_budget, tasks_dispatched, max_parallel_tasks,
        require_approval, target_date, created_at, updated_at
      ) VALUES (
        ${project.id}, ${project.tenantId}, ${project.actorId}, ${project.title},
        ${project.objective}, ${project.status}, ${project.autonomyMode},
        ${project.executionStatus}, ${project.taskBudget}, ${project.tasksDispatched},
        ${project.maxParallelTasks}, ${project.requireApproval}, ${project.targetDate || null}, ${now}, ${now}
      ) RETURNING *
    `;
    return projectFromRow(rows[0]);
  }
  await updateLedger((ledger) => ({ ...ledger, projects: [project, ...ledger.projects] }));
  return project;
}

export async function listProjects(
  limit = 50,
  options: { tenantId?: string; actorId: string },
) {
  const tenantId = normalizeTenantId(options.tenantId);
  const actorId = safeText(options.actorId, 200);
  const bounded = Math.min(Math.max(limit, 1), 100);
  if (hasDatabaseUrl()) {
    await ensureDatabaseSchema();
    const rows = await getSql()`
      SELECT * FROM omni_projects
      WHERE tenant_id = ${tenantId} AND actor_id = ${actorId}
      ORDER BY
        CASE status WHEN 'active' THEN 0 WHEN 'draft' THEN 1 WHEN 'completed' THEN 2 ELSE 3 END,
        updated_at DESC
      LIMIT ${bounded}
    `;
    return rows.map(projectFromRow);
  }
  const ledger = await readLedger();
  return ledger.projects
    .filter((item) => item.tenantId === tenantId && item.actorId === actorId)
    .sort(compareProjects)
    .slice(0, bounded);
}

export async function listProjectSummaries(
  limit = 50,
  options: { tenantId?: string; actorId: string },
): Promise<ProjectSummary[]> {
  const tenantId = normalizeTenantId(options.tenantId);
  const actorId = safeText(options.actorId, 200);
  const bounded = Math.min(Math.max(limit, 1), 50);
  if (hasDatabaseUrl()) {
    await ensureDatabaseSchema();
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
      WHERE projects.tenant_id = ${tenantId} AND projects.actor_id = ${actorId}
      ORDER BY
        CASE projects.status WHEN 'active' THEN 0 WHEN 'draft' THEN 1 WHEN 'completed' THEN 2 ELSE 3 END,
        projects.updated_at DESC
      LIMIT ${bounded}
    `;
    return rows.map(projectSummaryFromRow);
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
      return {
        ...project,
        taskCount: tasks.length,
        completedTaskCount: tasks.filter((task) => task.status === "done").length,
        activeTaskCount: tasks.filter((task) => task.status === "doing").length,
        artifactCount: ledger.artifacts.filter((artifact) =>
          artifact.tenantId === tenantId && artifact.projectId === project.id
        ).length,
      };
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

export async function updateProject(
  id: string,
  input: { title?: string; objective?: string; status?: ProjectStatus; targetDate?: string | null },
  options: { tenantId?: string; actorId: string },
) {
  const current = await getProject(id, options);
  if (!current) return undefined;
  if (input.status && !canTransitionProject(current.status, input.status)) {
    throw new ProjectTransitionError(`Project cannot move from ${current.status} to ${input.status}.`);
  }
  const now = new Date().toISOString();
  const next: PersonalProject = {
    ...current,
    title: input.title ? safeText(input.title, 180) : current.title,
    objective: input.objective ? safeText(input.objective, 2_000) : current.objective,
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
    const rows = await getSql()`
      UPDATE omni_projects SET
        title = ${next.title}, objective = ${next.objective}, status = ${next.status},
        target_date = ${next.targetDate || null}, execution_status = ${next.executionStatus},
        completed_at = ${next.completedAt || null}, updated_at = ${now}
      WHERE id = ${id} AND tenant_id = ${next.tenantId} AND actor_id = ${next.actorId}
      RETURNING *
    `;
    return rows[0] ? projectFromRow(rows[0]) : undefined;
  }
  await updateLedger((ledger) => ({
    ...ledger,
    projects: ledger.projects.map((item) => item.id === id ? next : item),
  }));
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
  options: { tenantId?: string; actorId: string },
) {
  const current = await getProject(id, options);
  if (!current) return undefined;
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
    const rows = await getSql()`
      UPDATE omni_projects SET
        autonomy_mode = ${next.autonomyMode}, execution_status = ${next.executionStatus},
        task_budget = ${next.taskBudget}, tasks_dispatched = ${next.tasksDispatched},
        max_parallel_tasks = ${next.maxParallelTasks}, require_approval = ${next.requireApproval},
        last_synced_at = ${next.lastSyncedAt || null}, updated_at = ${now}
      WHERE id = ${id} AND tenant_id = ${next.tenantId} AND actor_id = ${next.actorId}
      RETURNING *
    `;
    return rows[0] ? projectFromRow(rows[0]) : undefined;
  }
  await updateLedger((ledger) => ({
    ...ledger,
    projects: ledger.projects.map((item) => item.id === id ? next : item),
  }));
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
  options: { tenantId?: string; projectId: string },
) {
  const tenantId = normalizeTenantId(options.tenantId);
  const now = new Date().toISOString();
  const lesson = safeTextBlock(input.lesson, 1_200);
  if (hasDatabaseUrl()) {
    await ensureDatabaseSchema();
    const rows = await getSql()`
      UPDATE omni_project_artifacts SET verdict = ${input.verdict}, lesson = ${lesson},
        reflection_memory_id = ${input.reflectionMemoryId}, reviewed_at = ${now}, updated_at = ${now}
      WHERE id = ${artifactId} AND tenant_id = ${tenantId} AND project_id = ${options.projectId}
      RETURNING *
    `;
    return rows[0] ? artifactFromRow(rows[0]) : undefined;
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
  if (hasDatabaseUrl()) {
    await ensureDatabaseSchema();
    const rows = await getSql()`
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
    return artifactFromRow(rows[0]);
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
  return saved;
}

export async function createProjectTasks(
  projectId: string,
  inputs: Array<{
    title: string;
    detail?: string;
    priority?: ProjectTaskPriority;
    agentId?: SupervisorAgentId;
    origin?: ProjectTask["origin"];
    dueAt?: string;
    dependsOn?: string[];
  }>,
  options: { tenantId?: string },
) {
  const tenantId = normalizeTenantId(options.tenantId);
  const existing = await listProjectTasks(projectId, { tenantId });
  const existingTitles = new Set(existing.map((item) => item.title.toLowerCase()));
  const now = new Date().toISOString();
  const tasks = inputs
    .filter((input) => !existingTitles.has(safeText(input.title, 240).toLowerCase()))
    .slice(0, 20)
    .map((input, index): ProjectTask => ({
      id: randomUUID(),
      tenantId,
      projectId,
      title: safeText(input.title, 240),
      detail: safeText(input.detail || "", 1_000),
      status: "open",
      priority: input.priority || "medium",
      agentId: input.agentId || "atlas",
      position: existing.length + index,
      origin: input.origin || "manual",
      dueAt: optionalDate(input.dueAt),
      dependsOn: sanitizeIds(input.dependsOn),
      dispatchAttempt: 0,
      createdAt: now,
      updatedAt: now,
    }));
  if (!tasks.length) return [];
  if (hasDatabaseUrl()) {
    await ensureDatabaseSchema();
    for (const task of tasks) {
      await getSql()`
        INSERT INTO omni_project_tasks (
          id, tenant_id, project_id, title, detail, status, priority, agent_id,
          position, origin, due_at, dependency_ids, created_at, updated_at
        ) VALUES (
          ${task.id}, ${task.tenantId}, ${task.projectId}, ${task.title}, ${task.detail},
          ${task.status}, ${task.priority}, ${task.agentId}, ${task.position},
          ${task.origin}, ${task.dueAt || null}, ${task.dependsOn}::jsonb, ${task.createdAt}, ${task.updatedAt}
        )
      `;
    }
    return tasks;
  }
  await updateLedger((ledger) => ({ ...ledger, tasks: [...ledger.tasks, ...tasks] }));
  return tasks;
}

export async function replaceProjectTaskDependencies(
  projectId: string,
  dependencies: Array<{ taskId: string; dependsOn: string[] }>,
  options: { tenantId?: string },
) {
  const tenantId = normalizeTenantId(options.tenantId);
  const allowed = new Set((await listProjectTasks(projectId, { tenantId })).map((task) => task.id));
  const safe = dependencies.map((item) => ({
    taskId: item.taskId,
    dependsOn: sanitizeIds(item.dependsOn).filter((id) => allowed.has(id) && id !== item.taskId),
  })).filter((item) => allowed.has(item.taskId));
  if (hasDatabaseUrl()) {
    await ensureDatabaseSchema();
    for (const item of safe) {
      await getSql()`UPDATE omni_project_tasks SET dependency_ids = ${item.dependsOn}::jsonb, updated_at = NOW() WHERE id = ${item.taskId} AND project_id = ${projectId} AND tenant_id = ${tenantId}`;
    }
  } else {
    await updateLedger((ledger) => ({
      ...ledger,
      tasks: ledger.tasks.map((task) => {
        const item = safe.find((entry) => entry.taskId === task.id);
        return item ? { ...task, dependsOn: item.dependsOn, updatedAt: new Date().toISOString() } : task;
      }),
    }));
  }
  return listProjectTasks(projectId, { tenantId });
}

export async function claimProjectTaskForDispatch(
  projectId: string,
  taskId: string,
  options: { tenantId?: string },
) {
  const tenantId = normalizeTenantId(options.tenantId);
  const now = new Date().toISOString();
  if (hasDatabaseUrl()) {
    await ensureDatabaseSchema();
    const rows = await getSql()`
      UPDATE omni_project_tasks SET workflow_status = 'dispatching', dispatched_at = ${now},
        dispatch_attempt = dispatch_attempt + 1, execution_error = NULL, updated_at = ${now}
      WHERE id = ${taskId} AND project_id = ${projectId} AND tenant_id = ${tenantId}
        AND status = 'open' AND workflow_run_id IS NULL AND workflow_status IS NULL
      RETURNING *
    `;
    return rows[0] ? taskFromRow(rows[0]) : undefined;
  }
  let claimed: ProjectTask | undefined;
  await updateLedger((ledger) => ({
    ...ledger,
    tasks: ledger.tasks.map((task) => {
      if (task.id !== taskId || task.projectId !== projectId || task.tenantId !== tenantId || task.status !== "open" || task.workflowRunId || task.workflowStatus) return task;
      claimed = { ...task, workflowStatus: "dispatching", dispatchedAt: now, dispatchAttempt: (task.dispatchAttempt || 0) + 1, executionError: undefined, updatedAt: now };
      return claimed;
    }),
  }));
  return claimed;
}

export async function updateProjectTaskExecution(
  projectId: string,
  taskId: string,
  patch: Pick<ProjectTask, "status"> & Partial<Pick<ProjectTask, "workflowRunId" | "workflowStatus" | "executionError" | "completedAt">>,
  options: { tenantId?: string },
) {
  const tenantId = normalizeTenantId(options.tenantId);
  const now = new Date().toISOString();
  if (hasDatabaseUrl()) {
    await ensureDatabaseSchema();
    const rows = await getSql()`
      UPDATE omni_project_tasks SET status = ${patch.status}, workflow_run_id = ${patch.workflowRunId || null},
        workflow_status = ${patch.workflowStatus || null}, execution_error = ${patch.executionError || null},
        completed_at = ${patch.completedAt || null}, updated_at = ${now}
      WHERE id = ${taskId} AND project_id = ${projectId} AND tenant_id = ${tenantId}
      RETURNING *
    `;
    return rows[0] ? taskFromRow(rows[0]) : undefined;
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
  return updated;
}

export async function updateProjectTask(
  projectId: string,
  taskId: string,
  input: { title?: string; detail?: string; status?: ProjectTaskStatus; priority?: ProjectTaskPriority; agentId?: SupervisorAgentId; dueAt?: string | null },
  options: { tenantId?: string; actorId: string },
) {
  const tenantId = normalizeTenantId(options.tenantId);
  const project = await getProject(projectId, options);
  if (!project) return undefined;
  if (project.status !== "active") {
    throw new ProjectTransitionError("Tasks can only change while their project is active.");
  }
  const tasks = await listProjectTasks(projectId, { tenantId });
  const current = tasks.find((item) => item.id === taskId);
  if (!current) return undefined;
  if (input.status && !canTransitionTask(current.status, input.status)) {
    throw new ProjectTransitionError(`Task cannot move from ${current.status} to ${input.status}.`);
  }
  const now = new Date().toISOString();
  const next: ProjectTask = {
    ...current,
    title: input.title ? safeText(input.title, 240) : current.title,
    detail: input.detail !== undefined ? safeText(input.detail, 1_000) : current.detail,
    status: input.status || current.status,
    priority: input.priority || current.priority,
    agentId: input.agentId || current.agentId,
    dueAt: input.dueAt === null ? undefined : optionalDate(input.dueAt) || current.dueAt,
    completedAt: input.status === "done" ? now : input.status === "open" || input.status === "doing" ? undefined : current.completedAt,
    workflowRunId: input.status === "open" ? undefined : current.workflowRunId,
    workflowStatus: input.status === "open" ? undefined : current.workflowStatus,
    executionError: input.status === "open" ? undefined : current.executionError,
    updatedAt: now,
  };
  if (hasDatabaseUrl()) {
    await ensureDatabaseSchema();
    const rows = await getSql()`
      UPDATE omni_project_tasks SET
        title = ${next.title}, detail = ${next.detail}, status = ${next.status},
        priority = ${next.priority}, agent_id = ${next.agentId}, due_at = ${next.dueAt || null},
        workflow_run_id = ${next.workflowRunId || null}, workflow_status = ${next.workflowStatus || null},
        execution_error = ${next.executionError || null}, completed_at = ${next.completedAt || null}, updated_at = ${now}
      WHERE id = ${taskId} AND project_id = ${projectId} AND tenant_id = ${tenantId}
      RETURNING *
    `;
    return rows[0] ? taskFromRow(rows[0]) : undefined;
  }
  await updateLedger((ledger) => ({
    ...ledger,
    tasks: ledger.tasks.map((item) => item.id === taskId && item.projectId === projectId ? next : item),
  }));
  return next;
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
  return { id: String(row.id), tenantId: String(row.tenant_id), actorId: String(row.actor_id), title: safeText(row.title, 180), objective: safeText(row.objective, 2_000), status: String(row.status) as ProjectStatus, autonomyMode: String(row.autonomy_mode || "manual") as ProjectAutonomyMode, executionStatus: String(row.execution_status || "idle") as ProjectExecutionStatus, taskBudget: Number(row.task_budget || 12), tasksDispatched: Number(row.tasks_dispatched || 0), maxParallelTasks: Number(row.max_parallel_tasks || 1), requireApproval: row.require_approval === undefined ? true : Boolean(row.require_approval), lastSyncedAt: optionalDateValue(row.last_synced_at), targetDate: optionalDateValue(row.target_date), createdAt: dateValue(row.created_at), updatedAt: dateValue(row.updated_at), completedAt: optionalDateValue(row.completed_at) };
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
function taskFromRow(row: Record<string, unknown>): ProjectTask {
  return { id: String(row.id), tenantId: String(row.tenant_id), projectId: String(row.project_id), title: safeText(row.title, 240), detail: safeText(row.detail, 1_000), status: String(row.status) as ProjectTaskStatus, priority: String(row.priority) as ProjectTaskPriority, agentId: String(row.agent_id) as SupervisorAgentId, position: Number(row.position), origin: String(row.origin) === "agent" ? "agent" : "manual", dueAt: optionalDateValue(row.due_at), dependsOn: jsonStringArray(row.dependency_ids), workflowRunId: optionalText(row.workflow_run_id), workflowStatus: optionalText(row.workflow_status) as ProjectTask["workflowStatus"], executionError: optionalText(row.execution_error), dispatchedAt: optionalDateValue(row.dispatched_at), dispatchAttempt: Number(row.dispatch_attempt || 0), createdAt: dateValue(row.created_at), updatedAt: dateValue(row.updated_at), completedAt: optionalDateValue(row.completed_at) };
}
function artifactFromRow(row: Record<string, unknown>): ProjectArtifact {
  return { id: String(row.id), tenantId: String(row.tenant_id), projectId: String(row.project_id), taskId: String(row.task_id), workflowRunId: String(row.workflow_run_id), agentId: String(row.agent_id) as SupervisorAgentId, status: String(row.status) as ProjectArtifactStatus, title: safeText(row.title, 240), content: safeTextBlock(row.content, 50_000), memoryId: optionalText(row.memory_id), sourceMemoryId: optionalText(row.source_memory_id), verdict: optionalText(row.verdict) as ProjectArtifactVerdict | undefined, lesson: optionalText(row.lesson), reflectionMemoryId: optionalText(row.reflection_memory_id), reviewedAt: optionalDateValue(row.reviewed_at), evidenceRefs: jsonStringArray(row.evidence_refs), createdAt: dateValue(row.created_at), updatedAt: dateValue(row.updated_at) };
}
function compareProjects(left: PersonalProject, right: PersonalProject) { const order: Record<ProjectStatus, number> = { active: 0, draft: 1, completed: 2, archived: 3 }; return order[left.status] - order[right.status] || right.updatedAt.localeCompare(left.updatedAt); }
function optionalDate(value?: string | null) { if (!value) return undefined; const timestamp = Date.parse(value); return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : undefined; }
function optionalDateValue(value: unknown) { return value ? dateValue(value) : undefined; }
function dateValue(value: unknown) { return value instanceof Date ? value.toISOString() : String(value); }
function safeText(value: unknown, max: number) { return String(redactSensitive(String(value || ""))).replace(/\s+/g, " ").trim().slice(0, max); }
function safeTextBlock(value: unknown, max: number) { return String(redactSensitive(String(value || ""))).trim().slice(0, max); }
function optionalText(value: unknown) { const text = value === undefined || value === null ? "" : String(value).trim(); return text || undefined; }
function sanitizeIds(value?: string[]) { return [...new Set((value || []).map((id) => safeText(id, 120)).filter(Boolean))].slice(0, 20); }
function sanitizeEvidenceRefs(value?: string[]) { return [...new Set((value || []).map((item) => safeText(item, 240)).filter(Boolean))].slice(0, 32); }
function jsonStringArray(value: unknown) { if (Array.isArray(value)) return sanitizeIds(value.map(String)); if (typeof value === "string") { try { return jsonStringArray(JSON.parse(value)); } catch { return []; } } return []; }
function boundedInteger(value: number | undefined, fallback: number, min: number, max: number) { return value === undefined ? fallback : Math.min(Math.max(Math.trunc(value), min), max); }
function normalizeTenantId(value?: string) { return (value || getDatabaseTenantContext() || process.env.OMNIAGENT_DEFAULT_TENANT || "default").trim().replace(/[^a-zA-Z0-9_.:-]/g, "_").slice(0, 120) || "default"; }
