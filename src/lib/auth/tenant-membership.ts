import type { AuthLedger } from "@/lib/auth/types";
import { ensureDatabaseSchema, getSql, hasDatabaseUrl } from "@/lib/db/client";
import { readJsonFile } from "@/lib/storage/json";
import { getDataPath } from "@/lib/storage/paths";

/**
 * Whether at most one account is an active member of the tenant. Only then
 * is the tenant's unattributed memory, knowledge and topic graph one
 * person's own; once a second member joins, it is shared by all of them.
 */
export async function tenantHasAtMostOneActiveMember(tenantId: string) {
  if (hasDatabaseUrl()) {
    await ensureDatabaseSchema();
    const rows = await getSql()`
      SELECT 1
      FROM omni_auth_memberships
      WHERE tenant_id = ${tenantId}
        AND status = 'active'
      LIMIT 2
    `;
    return rows.length <= 1;
  }
  const ledger = await readJsonFile<Partial<AuthLedger>>(
    getDataPath("auth.json"),
    {},
  );
  return (ledger.memberships || []).filter((membership) =>
    membership.tenantId === tenantId && membership.status === "active"
  ).length <= 1;
}
