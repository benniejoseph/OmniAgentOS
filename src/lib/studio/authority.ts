import { hasDatabaseUrl } from "@/lib/db/client";
import { canonicalRequestActorBindingFromSecurityContext } from "@/lib/security/canonical-actor";
import type { SecurityContext } from "@/lib/security/types";
import { StudioError, type StudioOwner } from "./server-types";
import type { StudioTransaction } from "./store";
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
  if (!hasDatabaseUrl())
    return {
      workspaceId:
        requestedWorkspaceId || `workspace:personal:${owner.actorId}`,
      legacyActorId: owner.legacyActorId,
    };
  const sql = tx.sql!;
  const rows =
    await sql`SELECT * FROM public.omni_studio_authority_v1(${owner.tenantId},${owner.actorId},${requestedWorkspaceId ?? null},${projectId ?? null})`;
  if (rows.length !== 1)
    throw new StudioError(
      "The flow owner no longer has access to this workspace or project.",
      403,
      "studio_workspace_unavailable",
    );
  return {
    workspaceId: String(rows[0].workspace_id),
    legacyActorId: String(rows[0].legacy_actor_id),
  };
}
