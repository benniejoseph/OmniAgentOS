import { ensureDatabaseSchema, getSql, hasDatabaseUrl } from "@/lib/db/client";
import { canonicalActorIdFromExactRequestBinding, type CanonicalRequestActorBindingV1 } from "@/lib/security/canonical-actor";
import { searchDate, searchLikePattern, searchPage, type SearchPosition } from "./contracts";

/** Pure projection read: never creates a personal workspace or repairs a shadow. */
type WorkSearchInput = {
  tenantId: string; actorId: string; requestActorBinding?: CanonicalRequestActorBindingV1;
  query: string; limit: number; after?: SearchPosition;
};
export function searchOwnedWorkPage(input: WorkSearchInput) { return readOwnedWork(input); }
export async function resolveOwnedSearchWork(input: Omit<WorkSearchInput, "query" | "limit" | "after"> & { projectId: string; taskId?: string }) {
  if (!input.projectId || input.projectId.length > 200 || (input.taskId !== undefined && (!input.taskId || input.taskId.length > 200))) {
    throw new Error("An exact work destination is required.");
  }
  return (await readOwnedWork({ ...input, query: "", limit: 1 }, { projectId: input.projectId, taskId: input.taskId })).items[0] ?? null;
}
async function readOwnedWork(input: WorkSearchInput, exact?: { projectId: string; taskId?: string }) {
  const canonicalActorId = canonicalActorIdFromExactRequestBinding(input.actorId, input.requestActorBinding);
  if (!canonicalActorId || !input.tenantId.trim() || !hasDatabaseUrl()) {
    throw new Error("Work search requires a current canonical owner and database.");
  }
  await ensureDatabaseSchema();
  const limit = Math.min(20, Math.max(1, Math.trunc(input.limit)));
  const pattern = exact ? "" : searchLikePattern(input.query);
  const rows = await getSql()`
    WITH owned_projects AS MATERIALIZED (
      SELECT project.*, original.id AS original_project_id
      FROM omni_work_projects project
      JOIN omni_tenant_workspaces workspace
        ON workspace.tenant_id = project.tenant_id AND workspace.workspace_id = project.workspace_id
        AND workspace.state = 'active'
      JOIN omni_tenant_workspace_memberships membership
        ON membership.tenant_id = project.tenant_id AND membership.workspace_id = project.workspace_id
        AND membership.subject_kind = 'user' AND membership.subject_actor_id = ${canonicalActorId}
        AND membership.state = 'active'
      JOIN omni_work_project_memberships project_membership
        ON project_membership.tenant_id = project.tenant_id
        AND project_membership.workspace_id = project.workspace_id
        AND project_membership.project_id = project.project_id
        AND project_membership.subject_actor_id = ${canonicalActorId} AND project_membership.state = 'active'
      JOIN omni_work_compatibility_mappings mapping
        ON mapping.tenant_id = project.tenant_id AND mapping.workspace_id = project.workspace_id
        AND mapping.project_id = project.project_id AND mapping.work_item_id IS NULL
        AND mapping.source_kind = 'legacy_project' AND mapping.source_id = project.source_id
        AND mapping.source_revision_sha256 = project.source_revision_sha256
        AND mapping.canonical_owner_actor_id = ${canonicalActorId} AND mapping.state = 'active'
      JOIN omni_projects original
        ON original.tenant_id = project.tenant_id AND original.id = mapping.source_id
        AND original.actor_id = mapping.source_owner_actor_id
        AND original.actor_id IN (${canonicalActorId}, ${input.actorId}) AND original.status <> 'archived'
      WHERE project.tenant_id = ${input.tenantId} AND project.owner_actor_id = ${canonicalActorId}
        AND project.source_authority = 'legacy_project' AND project.lifecycle_status <> 'archived'
        AND project.source_owner_actor_id = original.actor_id
    ), matches AS (
      SELECT 'project:' || project.project_id AS id, project.title, project.updated_at,
        project.original_project_id AS project_id, NULL::text AS task_id, 'Project'::text AS kind
      FROM owned_projects project
      WHERE (${exact?.projectId ?? ""} = '' AND (project.title ILIKE ${pattern} OR project.objective ILIKE ${pattern}))
        OR (project.original_project_id = ${exact?.projectId ?? ""} AND ${exact?.taskId ?? ""} = '')
      UNION ALL
      SELECT 'task:' || item.work_item_id AS id, item.title, item.updated_at,
        project.original_project_id AS project_id, original_task.id AS task_id, 'Task'::text AS kind
      FROM owned_projects project
      JOIN omni_work_items item ON item.tenant_id = project.tenant_id
        AND item.workspace_id = project.workspace_id AND item.project_id = project.project_id
        AND item.source_authority = 'legacy_project_task'
        AND item.source_owner_actor_id IN (${canonicalActorId}, ${input.actorId})
      JOIN omni_work_compatibility_mappings mapping
        ON mapping.tenant_id = item.tenant_id AND mapping.workspace_id = item.workspace_id
        AND mapping.project_id = item.project_id AND mapping.work_item_id = item.work_item_id
        AND mapping.source_kind = 'legacy_project_task' AND mapping.source_id = item.source_id
        AND mapping.source_revision_sha256 = item.source_revision_sha256
        AND mapping.source_owner_actor_id = item.source_owner_actor_id
        AND mapping.canonical_owner_actor_id = ${canonicalActorId} AND mapping.state = 'active'
      JOIN omni_project_tasks original_task
        ON original_task.tenant_id = item.tenant_id AND original_task.id = mapping.source_id
        AND original_task.project_id = project.original_project_id
      WHERE (${exact?.projectId ?? ""} = '' AND (item.title ILIKE ${pattern} OR item.detail ILIKE ${pattern}))
        OR (project.original_project_id = ${exact?.projectId ?? ""} AND original_task.id = ${exact?.taskId ?? ""})
    ) SELECT id, title, updated_at, project_id, task_id, kind,
      to_char(updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS cursor_updated_at FROM matches
    WHERE (${input.after?.updatedAt ?? null}::text::timestamptz IS NULL
      OR updated_at < ${input.after?.updatedAt ?? null}::text::timestamptz
      OR (updated_at = ${input.after?.updatedAt ?? null}::text::timestamptz AND id COLLATE "C" > ${input.after?.id ?? ""} COLLATE "C"))
    ORDER BY updated_at DESC, id COLLATE "C" ASC LIMIT ${limit + 1}
  `;
  return searchPage(rows.map((row) => ({
    id: String(row.id), title: String(row.title), updatedAt: row.cursor_updated_at ? String(row.cursor_updated_at) : searchDate(row.updated_at),
    projectId: String(row.project_id), taskId: row.task_id ? String(row.task_id) : null, kind: String(row.kind),
  })), limit);
}
