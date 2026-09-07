import { appendDomainEvent, appendScopedDomainEvent } from "@/lib/events/store";
import type { Mission, MissionArtifact, MissionTask } from "@/lib/missions/types";
import type { PersonalProject, ProjectArtifact, ProjectTask } from "@/lib/projects/types";
import type { ExecutionScope } from "@/lib/security/execution-scope";
import { canonicalJsonSha256 } from "@/lib/tools/effect-receipt";
import {
  buildCanonicalWorkEventV1,
  type CanonicalProjectV1,
  type CanonicalWorkCompatibilityV1,
  type CanonicalWorkItemV1,
} from "@/lib/workspaces/contracts";
import {
  activeCompatibilityMapping,
  missionProjectCanonicalProjection,
  missionRootCanonicalProjection,
  missionTaskCanonicalProjection,
  projectCanonicalProjection,
  projectTaskCanonicalProjection,
} from "@/lib/workspaces/legacy-projection";

type WorkSqlClient = {
  (strings: TemplateStringsArray, ...params: unknown[]): Promise<Record<string, unknown>[]>;
};

type MutationAttribution = Readonly<{
  executionScope?: ExecutionScope;
  changedFieldIds: readonly string[];
}>;

type ProjectArtifactSource = Pick<
  ProjectArtifact,
  "id" | "taskId" | "status" | "evidenceRefs" | "updatedAt"
>;
type MissionArtifactSource = Pick<
  MissionArtifact,
  "id" | "taskId" | "kind" | "updatedAt"
>;

export async function projectCanonicalShadowWrite(input: {
  sql: WorkSqlClient;
  project: PersonalProject;
  task?: ProjectTask;
  attribution: MutationAttribution;
}) {
  const authority = await ensurePersonalWorkspace(
    input.sql,
    input.project.tenantId,
    input.project.actorId,
  );
  await upsertProject({
    sql: input.sql,
    candidate: (revision) => projectCanonicalProjection(
      input.project,
      authority,
      revision,
    ),
    sourceKind: "legacy_project",
    sourceId: input.project.id,
    sourceOwnerActorId: input.project.actorId,
    attribution: input.attribution,
  });
  if (!input.task) return authority;
  const artifacts = await projectArtifacts(input.sql, input.task);
  await upsertWorkItem({
    sql: input.sql,
    candidate: (revision) => projectTaskCanonicalProjection(
      input.project,
      input.task!,
      artifacts,
      authority,
      revision,
    ),
    sourceKind: "legacy_project_task",
    sourceId: input.task.id,
    sourceOwnerActorId: input.project.actorId,
    attribution: input.attribution,
  });
  return authority;
}

export async function missionCanonicalShadowWrite(input: {
  sql: WorkSqlClient;
  mission: Mission;
  task?: MissionTask;
  attribution: MutationAttribution;
}) {
  const authority = await ensurePersonalWorkspace(
    input.sql,
    input.mission.tenantId,
    input.mission.actorId,
  );
  const artifacts = await missionArtifacts(input.sql, input.mission);
  await upsertProject({
    sql: input.sql,
    candidate: (revision) => missionProjectCanonicalProjection(
      input.mission,
      authority,
      revision,
    ),
    sourceKind: "legacy_mission",
    sourceId: input.mission.id,
    sourceOwnerActorId: input.mission.actorId,
    attribution: input.attribution,
  });
  await upsertWorkItem({
    sql: input.sql,
    candidate: (revision) => missionRootCanonicalProjection(
      input.mission,
      artifacts,
      authority,
      revision,
    ),
    sourceKind: "legacy_mission",
    sourceId: input.mission.id,
    sourceOwnerActorId: input.mission.actorId,
    attribution: input.attribution,
  });
  if (!input.task) return authority;
  await upsertWorkItem({
    sql: input.sql,
    candidate: (revision) => missionTaskCanonicalProjection(
      input.mission,
      input.task!,
      artifacts,
      authority,
      revision,
    ),
    sourceKind: "legacy_mission_task",
    sourceId: input.task.id,
    sourceOwnerActorId: input.mission.actorId,
    attribution: input.attribution,
  });
  return authority;
}

async function ensurePersonalWorkspace(
  sql: WorkSqlClient,
  tenantId: string,
  actorIdentifier: string,
) {
  const rows = await sql`
    SELECT workspace_id, owner_actor_id
    FROM omni_ensure_personal_workspace_v1(${tenantId}, ${actorIdentifier})
  `;
  const workspaceId = String(rows[0]?.workspace_id || "");
  const canonicalOwnerActorId = String(rows[0]?.owner_actor_id || "");
  if (!workspaceId || !canonicalOwnerActorId || rows.length !== 1) {
    throw new Error("Canonical personal Workspace could not be resolved.");
  }
  return { workspaceId, canonicalOwnerActorId } as const;
}

async function upsertProject(input: {
  sql: WorkSqlClient;
  candidate: (revision: number) => Readonly<{
    projection: CanonicalProjectV1;
    projectionSha256: string;
    sourceRevisionSha256: string;
  }>;
  sourceKind: "legacy_project" | "legacy_mission";
  sourceId: string;
  sourceOwnerActorId: string;
  attribution: MutationAttribution;
}) {
  const existingRows = await input.sql`
    SELECT lifecycle_revision, source_revision_sha256
    FROM omni_work_projects
    WHERE source_authority = ${input.sourceKind}
      AND source_id = ${input.sourceId}
    FOR UPDATE
  `;
  const existing = existingRows[0];
  const revision = Number(existing?.lifecycle_revision || 0) + 1;
  const candidate = input.candidate(revision);
  const project = candidate.projection;
  const changed = existing?.source_revision_sha256 !== candidate.sourceRevisionSha256;
  if (changed) {
    await input.sql`
      INSERT INTO omni_work_projects (
        schema_version, tenant_id, workspace_id, project_id, owner_actor_id,
        title, objective, lifecycle_status, source_authority, source_id,
        source_owner_actor_id, target_date, lifecycle_revision,
        source_revision_sha256, projection_sha256, projection,
        created_at, updated_at, completed_at
      ) VALUES (
        ${project.schemaVersion}, ${project.tenantId}, ${project.workspaceId},
        ${project.projectId}, ${project.ownerActorId}, ${project.title},
        ${project.objective}, ${project.lifecycleStatus}, ${project.sourceAuthority},
        ${input.sourceId}, ${input.sourceOwnerActorId}, ${project.targetDate},
        ${project.lifecycleRevision}, ${candidate.sourceRevisionSha256},
        ${candidate.projectionSha256}, ${project}::JSONB, ${project.createdAt},
        clock_timestamp(), ${project.completedAt}
      )
      ON CONFLICT (tenant_id, source_authority, source_id) DO UPDATE SET
        title = EXCLUDED.title,
        objective = EXCLUDED.objective,
        lifecycle_status = EXCLUDED.lifecycle_status,
        target_date = EXCLUDED.target_date,
        lifecycle_revision = EXCLUDED.lifecycle_revision,
        source_revision_sha256 = EXCLUDED.source_revision_sha256,
        projection_sha256 = EXCLUDED.projection_sha256,
        projection = EXCLUDED.projection,
        updated_at = clock_timestamp(),
        completed_at = EXCLUDED.completed_at
      WHERE omni_work_projects.source_revision_sha256
        IS DISTINCT FROM EXCLUDED.source_revision_sha256
    `;
  }
  await input.sql`
    INSERT INTO omni_work_project_memberships (
      tenant_id, workspace_id, project_id, subject_actor_id, access_level,
      state, membership_revision, created_at, updated_at
    ) VALUES (
      ${project.tenantId}, ${project.workspaceId}, ${project.projectId},
      ${project.ownerActorId}, 'manager', 'active', 1,
      ${project.createdAt}, clock_timestamp()
    ) ON CONFLICT DO NOTHING
  `;
  if (input.sourceKind === "legacy_project") {
    await upsertCompatibilityMapping({
      sql: input.sql,
      sourceKind: input.sourceKind,
      sourceId: input.sourceId,
      sourceOwnerActorId: input.sourceOwnerActorId,
      sourceRevisionSha256: candidate.sourceRevisionSha256,
      tenantId: project.tenantId,
      workspaceId: project.workspaceId,
      projectId: project.projectId,
      workItemId: null,
      canonicalOwnerActorId: project.ownerActorId,
      createdAt: project.createdAt,
      updatedAt: project.updatedAt,
    });
  }
  if (changed) {
    await appendWorkEvent({
      sql: input.sql,
      projection: project,
      sourceRevisionSha256: candidate.sourceRevisionSha256,
      eventType: "work.project.projected",
      status: project.lifecycleStatus,
      revision,
      attribution: input.attribution,
    });
  }
}

async function upsertWorkItem(input: {
  sql: WorkSqlClient;
  candidate: (revision: number) => Readonly<{
    projection: CanonicalWorkItemV1;
    projectionSha256: string;
    sourceRevisionSha256: string;
  }>;
  sourceKind: "legacy_project_task" | "legacy_mission" | "legacy_mission_task";
  sourceId: string;
  sourceOwnerActorId: string;
  attribution: MutationAttribution;
}) {
  const existingRows = await input.sql`
    SELECT status_revision, source_revision_sha256, canonical_status, source_status
    FROM omni_work_items
    WHERE source_authority = ${input.sourceKind}
      AND source_id = ${input.sourceId}
    FOR UPDATE
  `;
  const existing = existingRows[0];
  const revision = Number(existing?.status_revision || 0) + 1;
  const candidate = input.candidate(revision);
  const workItem = candidate.projection;
  const changed = existing?.source_revision_sha256 !== candidate.sourceRevisionSha256;
  if (changed) {
    await input.sql`
      INSERT INTO omni_work_items (
        schema_version, tenant_id, workspace_id, project_id, work_item_id,
        parent_work_item_id, kind, title, detail, priority, canonical_status,
        source_status, status_revision, source_authority, source_id,
        source_owner_actor_id, dependency_work_item_ids, owner_actor_ids,
        assigned_agents, schedule, recurrence, risks, decisions, artifacts,
        source_revision_sha256, projection_sha256, projection,
        created_at, updated_at, terminal_at
      ) VALUES (
        ${workItem.schemaVersion}, ${workItem.tenantId}, ${workItem.workspaceId},
        ${workItem.projectId}, ${workItem.workItemId}, ${workItem.parentWorkItemId},
        ${workItem.kind}, ${workItem.title}, ${workItem.detail}, ${workItem.priority},
        ${workItem.canonicalStatus}, ${workItem.sourceStatus},
        ${workItem.statusRevision}, ${workItem.sourceAuthority}, ${input.sourceId},
        ${input.sourceOwnerActorId}, ${workItem.dependencyWorkItemIds}::JSONB,
        ${workItem.ownerActorIds}::JSONB, ${workItem.assignedAgents}::JSONB,
        ${workItem.schedule}::JSONB, ${workItem.recurrence}::JSONB,
        ${workItem.risks}::JSONB, ${workItem.decisions}::JSONB,
        ${workItem.artifacts}::JSONB, ${candidate.sourceRevisionSha256},
        ${candidate.projectionSha256}, ${workItem}::JSONB, ${workItem.createdAt},
        clock_timestamp(), ${workItem.terminalAt}
      )
      ON CONFLICT (tenant_id, source_authority, source_id) DO UPDATE SET
        parent_work_item_id = EXCLUDED.parent_work_item_id,
        kind = EXCLUDED.kind,
        title = EXCLUDED.title,
        detail = EXCLUDED.detail,
        priority = EXCLUDED.priority,
        canonical_status = EXCLUDED.canonical_status,
        source_status = EXCLUDED.source_status,
        status_revision = EXCLUDED.status_revision,
        dependency_work_item_ids = EXCLUDED.dependency_work_item_ids,
        owner_actor_ids = EXCLUDED.owner_actor_ids,
        assigned_agents = EXCLUDED.assigned_agents,
        schedule = EXCLUDED.schedule,
        recurrence = EXCLUDED.recurrence,
        risks = EXCLUDED.risks,
        decisions = EXCLUDED.decisions,
        artifacts = EXCLUDED.artifacts,
        source_revision_sha256 = EXCLUDED.source_revision_sha256,
        projection_sha256 = EXCLUDED.projection_sha256,
        projection = EXCLUDED.projection,
        updated_at = clock_timestamp(),
        terminal_at = EXCLUDED.terminal_at
      WHERE omni_work_items.source_revision_sha256
        IS DISTINCT FROM EXCLUDED.source_revision_sha256
    `;
  }
  await upsertCompatibilityMapping({
    sql: input.sql,
    sourceKind: input.sourceKind,
    sourceId: input.sourceId,
    sourceOwnerActorId: input.sourceOwnerActorId,
    sourceRevisionSha256: candidate.sourceRevisionSha256,
    tenantId: workItem.tenantId,
    workspaceId: workItem.workspaceId,
    projectId: workItem.projectId,
    workItemId: workItem.workItemId,
    canonicalOwnerActorId: workItem.ownerActorIds[0],
    createdAt: workItem.createdAt,
    updatedAt: workItem.updatedAt,
  });
  if (!changed) return;
  const statusChanged = Boolean(existing) && (
    existing.canonical_status !== workItem.canonicalStatus ||
    existing.source_status !== workItem.sourceStatus
  );
  const event = await appendWorkEvent({
    sql: input.sql,
    projection: workItem,
    sourceRevisionSha256: candidate.sourceRevisionSha256,
    eventType: statusChanged ? "work.item.status_changed" : "work.item.projected",
    status: workItem.canonicalStatus,
    revision,
    attribution: input.attribution,
  });
  await input.sql`
    INSERT INTO omni_work_item_status_history (
      tenant_id, workspace_id, project_id, work_item_id, status_revision,
      canonical_status, source_status, source_revision_sha256,
      event_sha256, occurred_at
    ) VALUES (
      ${workItem.tenantId}, ${workItem.workspaceId}, ${workItem.projectId},
      ${workItem.workItemId}, ${revision}, ${workItem.canonicalStatus},
      ${workItem.sourceStatus}, ${candidate.sourceRevisionSha256},
      ${event.eventSha256}, ${event.occurredAt}
    ) ON CONFLICT DO NOTHING
  `;
}

async function upsertCompatibilityMapping(input: {
  sql: WorkSqlClient;
  sourceKind: CanonicalWorkCompatibilityV1["sourceKind"];
  sourceId: string;
  sourceOwnerActorId: string;
  sourceRevisionSha256: string;
  tenantId: string;
  workspaceId: string;
  projectId: string;
  workItemId: string | null;
  canonicalOwnerActorId: string;
  createdAt: string;
  updatedAt: string;
}) {
  const rows = await input.sql`
    SELECT mapping_revision, source_revision_sha256
    FROM omni_work_compatibility_mappings
    WHERE tenant_id = ${input.tenantId}
      AND source_kind = ${input.sourceKind}
      AND source_id = ${input.sourceId}
    FOR UPDATE
  `;
  const revision = Number(rows[0]?.mapping_revision || 0) + 1;
  const mapping = activeCompatibilityMapping({ ...input, revision });
  if (rows[0]?.source_revision_sha256 === input.sourceRevisionSha256) return;
  await input.sql`
    INSERT INTO omni_work_compatibility_mappings (
      schema_version, tenant_id, mapping_id, source_kind, source_id,
      source_owner_actor_id, canonical_owner_actor_id, workspace_id,
      project_id, work_item_id, state, quarantine_code,
      source_revision_sha256, mapping_revision, created_at, updated_at
    ) VALUES (
      ${mapping.schemaVersion}, ${mapping.tenantId}, ${mapping.mappingId},
      ${mapping.sourceKind}, ${mapping.sourceId}, ${mapping.sourceOwnerActorId},
      ${mapping.canonicalOwnerActorId}, ${mapping.workspaceId}, ${mapping.projectId},
      ${mapping.workItemId}, ${mapping.state}, ${mapping.quarantineCode},
      ${mapping.sourceRevisionSha256}, ${mapping.mappingRevision},
      ${mapping.createdAt}, clock_timestamp()
    )
    ON CONFLICT (tenant_id, source_kind, source_id) DO UPDATE SET
      canonical_owner_actor_id = EXCLUDED.canonical_owner_actor_id,
      workspace_id = EXCLUDED.workspace_id,
      project_id = EXCLUDED.project_id,
      work_item_id = EXCLUDED.work_item_id,
      state = EXCLUDED.state,
      quarantine_code = EXCLUDED.quarantine_code,
      source_revision_sha256 = EXCLUDED.source_revision_sha256,
      mapping_revision = EXCLUDED.mapping_revision,
      updated_at = clock_timestamp()
    WHERE omni_work_compatibility_mappings.source_revision_sha256
      IS DISTINCT FROM EXCLUDED.source_revision_sha256
  `;
}

async function appendWorkEvent(input: {
  sql: WorkSqlClient;
  projection: CanonicalProjectV1 | CanonicalWorkItemV1;
  sourceRevisionSha256: string;
  eventType: "work.project.projected" | "work.item.projected" | "work.item.status_changed";
  status: string;
  revision: number;
  attribution: MutationAttribution;
}) {
  const project = input.projection;
  const workItemId = "workItemId" in project ? project.workItemId : null;
  const actorId = "ownerActorIds" in project
    ? project.ownerActorIds[0]
    : project.ownerActorId;
  const event = buildCanonicalWorkEventV1({
    tenantId: project.tenantId,
    workspaceId: project.workspaceId,
    projectId: project.projectId,
    workItemId,
    actorId,
    eventType: input.eventType,
    status: input.status,
    revision: input.revision,
    changedFieldIds: [...input.attribution.changedFieldIds],
    sourceRevisionSha256: input.sourceRevisionSha256,
    occurredAt: new Date().toISOString(),
  });
  const shared = {
    id: `work_event:${event.eventSha256}`,
    streamId: workItemId
      ? `work-item:${project.projectId}:${workItemId}`
      : `work-project:${project.projectId}`,
    type: event.eventType,
    payload: event,
  };
  if (input.attribution.executionScope) {
    await appendScopedDomainEvent({
      ...shared,
      executionScope: {
        ...input.attribution.executionScope,
        workspaceId: project.workspaceId,
        projectId: project.projectId,
      },
    }, {
      sql: input.sql as NonNullable<
        NonNullable<Parameters<typeof appendScopedDomainEvent>[1]>["sql"]
      >,
    });
  } else {
    await appendDomainEvent({
      ...shared,
      tenantId: project.tenantId,
      actorId,
    }, {
      sql: input.sql as NonNullable<
        NonNullable<Parameters<typeof appendDomainEvent>[1]>["sql"]
      >,
    });
  }
  return event;
}

async function projectArtifacts(sql: WorkSqlClient, task: ProjectTask) {
  const rows = await sql`
    SELECT id, task_id, status, evidence_refs, updated_at
    FROM omni_project_artifacts
    WHERE tenant_id = ${task.tenantId} AND task_id = ${task.id}
    ORDER BY id
  `;
  return rows.map((row): ProjectArtifactSource => ({
    id: String(row.id),
    taskId: String(row.task_id),
    status: String(row.status) as ProjectArtifactSource["status"],
    evidenceRefs: Array.isArray(row.evidence_refs)
      ? row.evidence_refs.map(String)
      : [],
    updatedAt: storedTimestamp(row.updated_at),
  }));
}

async function missionArtifacts(sql: WorkSqlClient, mission: Mission) {
  const rows = await sql`
    SELECT id, task_id, kind, updated_at
    FROM omni_mission_artifacts
    WHERE tenant_id = ${mission.tenantId}
      AND actor_id = ${mission.actorId}
      AND mission_id = ${mission.id}
    ORDER BY id
  `;
  return rows.map((row): MissionArtifactSource => ({
    id: String(row.id),
    taskId: row.task_id ? String(row.task_id) : undefined,
    kind: String(row.kind),
    updatedAt: storedTimestamp(row.updated_at),
  }));
}

function storedTimestamp(value: unknown) {
  const date = value instanceof Date ? value : new Date(String(value));
  if (Number.isNaN(date.valueOf())) {
    throw new Error("Canonical work source timestamp is invalid.");
  }
  return date.toISOString();
}

export function canonicalWorkShadowDigest(value: unknown) {
  return canonicalJsonSha256(value);
}
