import type { SqlClient } from "@/lib/db/sql-types";
import type { ResponsibilityOwner } from "./state";

/** Preserve revocation ordering without granting the serving role UPDATE on
 * workspace authority. The database function validates its transaction-local
 * tenant/actor scope and keeps shared locks until this transaction completes. */
export async function lockResponsibilityWorkspace(sql: SqlClient, owner: ResponsibilityOwner, workspaceId: string): Promise<boolean> {
  if (!sql.transactionScoped) return false;
  const rows = await sql`SELECT public.omni_lock_responsibility_workspace_v1(${owner.tenantId}, ${owner.actorId}, ${workspaceId}) AS allowed`;
  return rows.length === 1 && rows[0].allowed === true;
}
