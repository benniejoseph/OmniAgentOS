import type { SqlClient } from "@/lib/db/sql-types";
import type { CanonicalRequestActorBindingV1 } from "@/lib/security/canonical-actor";
import { todayActorReadOrder } from "@/lib/today/actor-scope";
import { findTodayNotificationPreferencesWithSql } from "@/lib/today/briefs";
import type { TodayPreferences } from "@/lib/today/types";

/** Lock the active account, membership and exact notification preference row. */
export async function findActiveNotificationOwnerPreferencesWithSql(
  sql: SqlClient,
  tenantId: string,
  candidateActorId: string,
): Promise<TodayPreferences | undefined> {
  if (!sql.transactionScoped) {
    throw new Error("Notification owner resolution requires a managed transaction.");
  }
  const rows = await sql`
    SELECT account.id, account.actor_id, account.email,
      account.status AS user_status, membership.tenant_id,
      membership.status AS membership_status
    FROM omni_auth_users account
    JOIN omni_auth_memberships membership ON membership.user_id = account.id
    WHERE membership.tenant_id = ${tenantId}
      AND (account.actor_id = ${candidateActorId} OR account.email = ${candidateActorId})
      AND account.status = 'active'
      AND membership.status = 'active'
    LIMIT 2
    FOR SHARE OF account, membership
  `;
  if (rows.length !== 1) return undefined;
  const row = rows[0];
  if (
    typeof row.id !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(row.id) ||
    row.actor_id !== `actor:${row.id}` ||
    typeof row.email !== "string" ||
    row.tenant_id !== tenantId ||
    row.user_status !== "active" ||
    row.membership_status !== "active" ||
    (candidateActorId !== row.actor_id && candidateActorId !== row.email)
  ) return undefined;
  const binding: CanonicalRequestActorBindingV1 = Object.freeze({
    version: 1,
    kind: "auth_user",
    authUserId: row.id,
    canonicalActorId: row.actor_id,
    legacyOwnerActorIds: Object.freeze([row.email]),
    readableOwnerActorIds: Object.freeze([row.actor_id, row.email]),
  });
  const [canonicalActorId, exactActorId] = todayActorReadOrder(row.email, binding);
  if (canonicalActorId !== row.actor_id || exactActorId !== row.email) {
    return undefined;
  }
  return findTodayNotificationPreferencesWithSql(sql, {
    tenantId,
    actorId: row.email,
    requestActorBinding: binding,
  });
}

