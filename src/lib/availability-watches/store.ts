import { ensureDatabaseSchema, getSql, hasDatabaseUrl, runWithDatabaseActorScope } from "@/lib/db/client";
import type { SqlClient, SqlRow } from "@/lib/db/sql-types";
import { appendScopedDomainEvent } from "@/lib/events/store";
import { createExecutionScope } from "@/lib/security/execution-scope";
import type { SecurityContext } from "@/lib/security/types";
import { canonicalJsonSha256 } from "@/lib/tools/effect-receipt";
import { AvailabilityWatchCheckSchema, AvailabilityWatchError, AvailabilityWatchOwnerSchema, AvailabilityWatchProjectionSchema,
  type AvailabilityWatchOwner, type AvailabilityWatchProjection, type AvailabilityWatchCheck } from "./contracts";

export type WatchHead = { watch: AvailabilityWatchProjection; pendingCheckId: string | null };
export type AvailabilityWatchEventAction = "created" | "stopped" | "owner_unavailable" | "check_queued" | "opening_observed" |
  "source_recovered" | "checked" | "check_failed" | "notification_updated" | "expired" | "exhausted";
export async function withAvailabilityOwner<T>(owner: AvailabilityWatchOwner, work: (sql: SqlClient) => Promise<T>): Promise<T> {
  AvailabilityWatchOwnerSchema.parse({ tenantId: owner.tenantId, actorId: owner.actorId });
  if (!hasDatabaseUrl()) throw new AvailabilityWatchError("Availability watches require durable server storage.", 503, "availability_watch_storage_unavailable");
  await ensureDatabaseSchema();
  // Resolve the exact current legacy owner alias before expanding RLS. Recheck it
  // under the transaction lock so email changes cannot admit another account.
  // Inactive owners remain resolvable here so the scheduler can stop their watch;
  // each action separately validates active scheduling/notification access.
  const email = await runWithDatabaseActorScope(owner.tenantId, [owner.actorId], async () =>
    getSql().transaction(async (sql: SqlClient) => readAvailabilityOwnerEmail(sql, owner)) as Promise<string>);
  return runWithDatabaseActorScope(owner.tenantId, [owner.actorId, email], async () => getSql().transaction(async (sql: SqlClient) => {
    if (await readAvailabilityOwnerEmail(sql, owner) !== email) throw new AvailabilityWatchError("The watch account changed; retry the request.", 409, "availability_watch_owner_changed");
    return work(sql);
  }) as Promise<T>);
}
async function readAvailabilityOwnerEmail(sql: SqlClient, owner: AvailabilityWatchOwner): Promise<string> {
  const rows = await sql`SELECT id,actor_id,email FROM omni_auth_users WHERE id = ${owner.actorId.slice(6)} AND actor_id = ${owner.actorId} FOR SHARE`;
  if (rows.length !== 1 || rows[0].actor_id !== owner.actorId || typeof rows[0].email !== "string" || !rows[0].email) {
    throw new AvailabilityWatchError("The watch owner account is unavailable.", 403, "availability_watch_owner_unavailable");
  }
  return rows[0].email;
}
export async function availabilityNow(sql: SqlClient): Promise<string> {
  const rows = await sql`SELECT clock_timestamp() AS now`; const value = rows[0]?.now;
  const now = value instanceof Date ? value.toISOString() : new Date(String(value)).toISOString(); return now;
}
export async function lockAvailabilityOwner(sql: SqlClient, owner: AvailabilityWatchOwner) {
  await sql`SELECT pg_advisory_xact_lock(hashtextextended(${JSON.stringify(["availability-watch:1", owner.tenantId, owner.actorId])}, 0))`;
}
export async function resolveAvailabilityOwner(sql: SqlClient, owner: AvailabilityWatchOwner): Promise<SecurityContext> {
  if (!sql.transactionScoped) throw new AvailabilityWatchError("Current owner validation requires a transaction.", 503);
  const userId = owner.actorId.slice(6);
  const rows = await sql`SELECT account.id,account.email,membership.role,tenant.name FROM omni_auth_users account
    JOIN omni_auth_memberships membership ON membership.user_id = account.id JOIN omni_auth_tenants tenant ON tenant.id = membership.tenant_id
    WHERE account.id = ${userId} AND membership.tenant_id = ${owner.tenantId} AND account.status = 'active' AND membership.status = 'active'
    FOR SHARE OF account,membership`;
  const row = rows[0];
  if (rows.length !== 1 || typeof row.email !== "string" || !["operator", "admin", "system"].includes(String(row.role))) {
    throw new AvailabilityWatchError("The watch owner no longer has active scheduling access.", 403, "availability_watch_owner_unavailable");
  }
  return { tenantId: owner.tenantId, actorId: row.email, role: row.role as SecurityContext["role"], source: "session",
    auth: { userId, email: row.email, sessionId: "availability-watch-current-account", tenantName: String(row.name) } };
}
export async function readAvailabilityHead(sql: SqlClient, owner: AvailabilityWatchOwner, id: string, lock = true): Promise<WatchHead | null> {
  const rows = lock
    ? await sql`SELECT * FROM omni_availability_watches WHERE tenant_id = ${owner.tenantId} AND actor_id = ${owner.actorId} AND id = ${id} FOR UPDATE`
    : await sql`SELECT * FROM omni_availability_watches WHERE tenant_id = ${owner.tenantId} AND actor_id = ${owner.actorId} AND id = ${id}`;
  if (rows.length > 1) throw corrupt();
  return rows[0] ? availabilityHeadFromRow(rows[0], owner) : null;
}
export function availabilityHeadFromRow(row: SqlRow, owner: AvailabilityWatchOwner): WatchHead {
  const watch = AvailabilityWatchProjectionSchema.parse(row.snapshot);
  if (row.tenant_id !== owner.tenantId || row.actor_id !== owner.actorId || row.id !== watch.id || Number(row.revision) !== watch.revision ||
    Number(row.generation) !== watch.generation || row.state !== watch.state || row.config_sha256 !== canonicalJsonSha256(watch.config)) throw corrupt();
  return { watch, pendingCheckId: typeof row.pending_check_id === "string" ? row.pending_check_id : null };
}
export async function saveAvailabilityHead(sql: SqlClient, owner: AvailabilityWatchOwner, head: WatchHead, previousRevision?: number) {
  const watch = AvailabilityWatchProjectionSchema.parse(head.watch);
  const notificationDue = watch.state === "fulfilled" && watch.notification?.state !== "recorded" ? watch.notification?.nextAttemptAt || null : null;
  if (previousRevision === undefined) {
    await sql`INSERT INTO omni_availability_watches (tenant_id,actor_id,id,revision,generation,state,config_sha256,snapshot,pending_check_id,next_check_at,notification_due_at,expires_at,created_at,updated_at)
      VALUES (${owner.tenantId},${owner.actorId},${watch.id},${watch.revision},${watch.generation},${watch.state},${canonicalJsonSha256(watch.config)},${watch}::jsonb,
        ${head.pendingCheckId},${watch.nextCheckAt},${notificationDue},${watch.config.expiresAt},${watch.createdAt},${watch.updatedAt})`;
  } else {
    const rows = await sql`UPDATE omni_availability_watches SET revision = ${watch.revision},generation = ${watch.generation},state = ${watch.state},snapshot = ${watch}::jsonb,
      pending_check_id = ${head.pendingCheckId},next_check_at = ${watch.nextCheckAt},notification_due_at = ${notificationDue},updated_at = ${watch.updatedAt}
      WHERE tenant_id = ${owner.tenantId} AND actor_id = ${owner.actorId} AND id = ${watch.id} AND revision = ${previousRevision} RETURNING id`;
    if (rows.length !== 1) throw new AvailabilityWatchError("The watch changed; refresh it before trying again.", 409, "availability_watch_changed");
  }
}
export async function appendAvailabilityEvent(sql: SqlClient, owner: AvailabilityWatchOwner, watch: AvailabilityWatchProjection, action: AvailabilityWatchEventAction, extra: Record<string, unknown> = {}) {
  await appendScopedDomainEvent({ id: `availability-event:${canonicalJsonSha256([owner, watch.id, watch.revision, action])}`,
    streamId: `availability-watch:${owner.tenantId}:${watch.id}`, type: `availability_watch.${action}`,
    executionScope: createExecutionScope({ ...owner, initiatingActorId: owner.actorId, executingPrincipalType: "system", executingPrincipalId: "availability-watch-runtime",
      correlationId: watch.id, purpose: `availability_watch.${action}` }),
    payload: { watchId: watch.id, revision: watch.revision, generation: watch.generation, state: watch.state, checksUsed: watch.checksUsed, ...extra } }, { sql });
}
export async function readAvailabilityCheck(sql: SqlClient, owner: AvailabilityWatchOwner, watchId: string, id: string) {
  const rows = await sql`SELECT * FROM omni_availability_watch_checks WHERE tenant_id = ${owner.tenantId} AND actor_id = ${owner.actorId} AND watch_id = ${watchId} AND id = ${id} FOR UPDATE`;
  if (rows.length !== 1) throw corrupt();
  return { check: AvailabilityWatchCheckSchema.parse(rows[0].snapshot), jobId: String(rows[0].job_id) };
}
export async function saveAvailabilityCheck(sql: SqlClient, owner: AvailabilityWatchOwner, watchId: string, check: AvailabilityWatchCheck, jobId?: string) {
  AvailabilityWatchCheckSchema.parse(check);
  if (jobId) {
    await sql`INSERT INTO omni_availability_watch_checks (tenant_id,actor_id,watch_id,id,generation,scheduled_for,state,job_id,snapshot,created_at,updated_at)
      VALUES (${owner.tenantId},${owner.actorId},${watchId},${check.id},${check.generation},${check.scheduledFor},${check.state},${jobId},${check}::jsonb,clock_timestamp(),clock_timestamp())`;
  } else {
    await sql`UPDATE omni_availability_watch_checks SET state = ${check.state},snapshot = ${check}::jsonb,updated_at = clock_timestamp()
      WHERE tenant_id = ${owner.tenantId} AND actor_id = ${owner.actorId} AND watch_id = ${watchId} AND id = ${check.id} AND state IN ('queued','running')`;
  }
}
export async function readAvailabilityMutation(sql: SqlClient, owner: AvailabilityWatchOwner, requestId: string, request: unknown) {
  if (!requestId || requestId.length > 240 || /[\u0000-\u001f\u007f]/.test(requestId)) throw new AvailabilityWatchError("A bounded idempotency key is required.");
  const rows = await sql`SELECT request_sha256,snapshot FROM omni_availability_watch_mutations WHERE tenant_id = ${owner.tenantId} AND actor_id = ${owner.actorId} AND idempotency_sha256 = ${canonicalJsonSha256(requestId)}`;
  if (!rows.length) return null;
  if (rows.length !== 1 || rows[0].request_sha256 !== canonicalJsonSha256(request)) throw new AvailabilityWatchError("This request key is already bound to another watch action.", 409, "availability_watch_idempotency_conflict");
  return AvailabilityWatchProjectionSchema.parse(rows[0].snapshot);
}
export async function saveAvailabilityMutation(sql: SqlClient, owner: AvailabilityWatchOwner, requestId: string, request: unknown, watch: AvailabilityWatchProjection) {
  await sql`INSERT INTO omni_availability_watch_mutations (tenant_id,actor_id,idempotency_sha256,request_sha256,watch_id,snapshot,created_at)
    VALUES (${owner.tenantId},${owner.actorId},${canonicalJsonSha256(requestId)},${canonicalJsonSha256(request)},${watch.id},${watch}::jsonb,clock_timestamp())`;
}
function corrupt() { return new AvailabilityWatchError("The saved watch state is inconsistent.", 503, "availability_watch_state_invalid"); }
