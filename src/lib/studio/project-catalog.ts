import { hasDatabaseUrl } from "@/lib/db/client";
import { getOwnedProject, listProjects } from "@/lib/projects/store";
import type { StudioProject } from "./contracts";
import { StudioError, type StudioOwner } from "./server-types";
import type { StudioTransaction } from "./store";

type ProjectEntry = Omit<StudioProject, "profile">;
/** A closed database reader verifies current membership and project ownership before returning metadata. */
export async function studioProjectCatalog(
  tx: StudioTransaction,
  owner: StudioOwner,
  projectId?: string,
): Promise<ProjectEntry[]> {
  if (hasDatabaseUrl()) {
    const rows =
      await tx.sql!`SELECT * FROM public.omni_studio_projects_v1(${owner.tenantId},${owner.actorId},${projectId ?? null})`;
    return rows.map((row) => ({
      id: String(row.project_id),
      legacyProjectId: row.source_id ? String(row.source_id) : null,
      title: String(row.title),
      status: String(row.lifecycle_status) as StudioProject["status"],
      workspaceId: String(row.workspace_id),
    }));
  }
  const scope = {
    tenantId: owner.tenantId,
    actorId: owner.legacyActorId ?? owner.actorId,
  };
  const rows = projectId
    ? [await getOwnedProject(projectId, scope)].filter(Boolean)
    : await listProjects(100, scope);
  return rows.map((row) => ({
    id: row!.id,
    legacyProjectId: row!.id,
    title: row!.title,
    status: row!.status,
    workspaceId: `workspace:personal:${owner.actorId}`,
  }));
}
export async function requireStudioProject(
  tx: StudioTransaction,
  owner: StudioOwner,
  projectId: string,
) {
  const rows = await studioProjectCatalog(tx, owner, projectId);
  if (rows.length !== 1)
    throw new StudioError(
      "This project is unavailable to your workspace account.",
      403,
      "studio_project_unavailable",
    );
  return rows[0];
}
