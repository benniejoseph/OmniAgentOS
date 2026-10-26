import { hasDatabaseUrl } from "@/lib/db/client";
import { canonicalRequestActorBindingFromSecurityContext } from "@/lib/security/canonical-actor";
import type { SecurityContext } from "@/lib/security/types";
import { StudioError, type StudioOwner } from "./server-types";
import type { StudioTransaction } from "./store";
import { requireStudioProject } from "./project-catalog";
export function studioOwner(context: SecurityContext): StudioOwner {
  const binding = canonicalRequestActorBindingFromSecurityContext(context);
  if (!binding)
    throw new StudioError(
      "Sign in to your workspace to use Studio.",
      403,
      "studio_owner_required",
    );
  return {
    tenantId: context.tenantId,
    actorId: binding.canonicalActorId,
    legacyActorId: context.actorId,
  };
}
export async function verifyStudioAuthority(
  tx: StudioTransaction,
  owner: StudioOwner,
  requestedWorkspaceId?: string,
  projectId?: string | null,
) {
  const project = projectId
    ? await requireStudioProject(tx, owner, projectId)
    : null;
  if (
    project &&
    requestedWorkspaceId &&
    project.workspaceId !== requestedWorkspaceId
  )
    throw new StudioError(
      "This project belongs to another workspace.",
      403,
      "studio_workspace_unavailable",
    );
  if (!hasDatabaseUrl())
    return {
      workspaceId:
        project?.workspaceId ||
        requestedWorkspaceId ||
        `workspace:personal:${owner.actorId}`,
      projectId: project?.id ?? null,
      legacyActorId: owner.legacyActorId,
    };
  const sql = tx.sql!;
  const rows =
    await sql`SELECT * FROM public.omni_studio_authority_v1(${owner.tenantId},${owner.actorId},${project?.workspaceId ?? requestedWorkspaceId ?? null},${project?.id ?? null})`;
  if (rows.length !== 1)
    throw new StudioError(
      "The flow owner no longer has access to this workspace or project.",
      403,
      "studio_workspace_unavailable",
    );
  return {
    workspaceId: String(rows[0].workspace_id),
    projectId: project?.id ?? null,
    legacyActorId: String(rows[0].legacy_actor_id),
  };
}
