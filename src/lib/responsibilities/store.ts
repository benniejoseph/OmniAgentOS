import { ensureDatabaseSchema, getSql, hasDatabaseUrl, runWithDatabaseActorScope } from "@/lib/db/client";
import type { SqlClient, SqlRow } from "@/lib/db/sql-types";
import { appendScopedDomainEvent } from "@/lib/events/store";
import { createExecutionScope } from "@/lib/security/execution-scope";
import type { ResponsibilityMutation, ResponsibilityPreview, ResponsibilityRecord } from "./contracts";
import {
  idempotencySha256, prepareResponsibilityChange, ResponsibilityError, storageInvalid, verifiedReceipt, verifiedRecord,
  type ResponsibilityChangeResult, type ResponsibilityOwner,
} from "./state";

export type ResponsibilityStore = {
  list(owner: ResponsibilityOwner, limit: number): Promise<{ records: ResponsibilityRecord[]; hasMore: boolean }>;
  read(owner: ResponsibilityOwner, id: string): Promise<ResponsibilityRecord | undefined>;
  replay(owner: ResponsibilityOwner, id: string, mutation: ResponsibilityMutation, key: string): Promise<ResponsibilityChangeResult | undefined>;
  change(owner: ResponsibilityOwner, id: string, mutation: ResponsibilityMutation, key: string, preview?: ResponsibilityPreview): Promise<ResponsibilityChangeResult>;
};
export const responsibilityStore: ResponsibilityStore = { list: listResponsibilities, read: readResponsibility, replay: replayResponsibility, change: changeResponsibility };

async function scoped<T>(owner: ResponsibilityOwner, callback: () => Promise<T>) {
  if (!hasDatabaseUrl()) throw new ResponsibilityError("Responsibilities require durable database storage.", 503, "responsibility_storage_unavailable");
  await ensureDatabaseSchema();
  return runWithDatabaseActorScope(owner.tenantId, [owner.actorId], callback);
}
export async function listResponsibilities(owner: ResponsibilityOwner, limit: number) {
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new ResponsibilityError("The list limit must be 1–100.", 400, "responsibility_limit_invalid");
  return scoped(owner, async () => {
    const rows = await getSql()`SELECT * FROM omni_responsibilities
      WHERE tenant_id = ${owner.tenantId} AND actor_id = ${owner.actorId}
      ORDER BY updated_at DESC, id ASC LIMIT ${limit + 1}`;
    return { records: rows.slice(0, limit).map((row) => recordFromRow(row, owner)), hasMore: rows.length > limit };
  });
}
export async function readResponsibility(owner: ResponsibilityOwner, id: string) {
  return scoped(owner, () => readHead(getSql(), owner, id));
}
async function readHead(sql: SqlClient, owner: ResponsibilityOwner, id: string) {
  const rows = await sql`SELECT * FROM omni_responsibilities
    WHERE tenant_id = ${owner.tenantId} AND actor_id = ${owner.actorId} AND id = ${id} LIMIT 2`;
  if (rows.length > 1) throw storageInvalid();
  return rows[0] ? recordFromRow(rows[0], owner) : undefined;
}
async function readReceipt(sql: SqlClient, owner: ResponsibilityOwner, key: string) {
  const rows = await sql`SELECT * FROM omni_responsibility_mutations
    WHERE tenant_id = ${owner.tenantId} AND actor_id = ${owner.actorId} AND idempotency_sha256 = ${idempotencySha256(key)} LIMIT 2`;
  if (rows.length > 1) throw storageInvalid();
  if (!rows[0]) return undefined;
  const row = rows[0];
  const receipt = verifiedReceipt(row.receipt);
  if (receipt.snapshot.tenantId !== owner.tenantId || receipt.snapshot.actorId !== owner.actorId || row.tenant_id !== owner.tenantId || row.actor_id !== owner.actorId ||
    row.id !== receipt.id || row.responsibility_id !== receipt.snapshot.id || row.idempotency_sha256 !== receipt.idempotencySha256 || row.request_sha256 !== receipt.requestSha256 ||
    Number(row.expected_revision) !== receipt.expectedRevision || Number(row.revision) !== receipt.snapshot.revision || row.action !== receipt.action || instant(row.saved_at) !== receipt.savedAt) throw storageInvalid();
  return receipt;
}
export async function replayResponsibility(owner: ResponsibilityOwner, id: string, mutation: ResponsibilityMutation, key: string) {
  return scoped(owner, async () => {
    const sql = getSql();
    const existing = await readReceipt(sql, owner, key);
    if (!existing) return undefined;
    const current = await readHead(sql, owner, id);
    return prepareResponsibilityChange({ owner, id, mutation, key, current, existing, now: new Date().toISOString() });
  });
}
export async function changeResponsibility(owner: ResponsibilityOwner, id: string, mutation: ResponsibilityMutation, key: string, preview?: ResponsibilityPreview) {
  return scoped(owner, async () => await getSql().transaction(async (sql: SqlClient) => {
    // The owner-wide lock covers idempotency keys shared across different drafts.
    await sql`SELECT pg_advisory_xact_lock(hashtextextended(${JSON.stringify(["responsibility-draft:1", owner.tenantId, owner.actorId])}, 0))`;
    const current = await readHead(sql, owner, id);
    const existing = await readReceipt(sql, owner, key);
    const result = prepareResponsibilityChange({ owner, id, mutation, key, current, existing, preview, now: new Date().toISOString() });
    if (result.replayed) return result;
    const record = result.current;
    const receipt = result.receipt;
    const rows = current ? await sql`UPDATE omni_responsibilities
      SET revision = ${record.revision}, state = ${record.state}, draft_sha256 = ${record.draftSha256}, snapshot = ${record}::jsonb, updated_at = ${record.updatedAt}
      WHERE tenant_id = ${owner.tenantId} AND actor_id = ${owner.actorId} AND id = ${id} AND revision = ${mutation.expectedRevision} RETURNING *`
      : await sql`INSERT INTO omni_responsibilities (schema_version, id, tenant_id, actor_id, revision, state, draft_sha256, snapshot, created_at, updated_at)
        VALUES (1, ${id}, ${owner.tenantId}, ${owner.actorId}, ${record.revision}, ${record.state}, ${record.draftSha256}, ${record}::jsonb, ${record.createdAt}, ${record.updatedAt}) RETURNING *`;
    if (rows.length !== 1) throw new ResponsibilityError("The responsibility changed. Reload its current draft.", 409, "responsibility_revision_conflict");
    const saved = recordFromRow(rows[0], owner);
    await sql`INSERT INTO omni_responsibility_mutations
      (schema_version, id, tenant_id, actor_id, idempotency_sha256, request_sha256, responsibility_id, expected_revision, revision, action, receipt, saved_at)
      VALUES (1, ${receipt.id}, ${owner.tenantId}, ${owner.actorId}, ${receipt.idempotencySha256}, ${receipt.requestSha256}, ${id}, ${receipt.expectedRevision}, ${record.revision}, ${receipt.action}, ${receipt}::jsonb, ${receipt.savedAt})`;
    await appendScopedDomainEvent({
      id: receipt.id, streamId: `responsibility:${owner.tenantId}:${id}`, type: `responsibility.draft.${receipt.action}`,
      executionScope: createExecutionScope({ tenantId: owner.tenantId, initiatingActorId: owner.actorId, executingPrincipalType: "user", executingPrincipalId: owner.actorId,
        correlationId: receipt.id, purpose: "responsibility.draft.v1" }),
      payload: { schemaVersion: 1, responsibilityId: id, revision: record.revision, draftSha256: record.draftSha256,
        reviewSha256: record.review?.reviewSha256 ?? null, requestSha256: receipt.requestSha256, receiptId: receipt.id,
        authorityEffect: "none", activationSupported: false, scheduled: false, notificationCreated: false },
    }, { sql });
    return { ...result, current: saved };
  }) as ResponsibilityChangeResult);
}
function recordFromRow(row: SqlRow, owner: ResponsibilityOwner) {
  const record = verifiedRecord(row.snapshot);
  if (row.schema_version !== 1 || record.tenantId !== owner.tenantId || record.actorId !== owner.actorId || row.tenant_id !== owner.tenantId || row.actor_id !== owner.actorId ||
    row.id !== record.id || Number(row.revision) !== record.revision || row.state !== record.state || row.draft_sha256 !== record.draftSha256 ||
    instant(row.created_at) !== record.createdAt || instant(row.updated_at) !== record.updatedAt) throw storageInvalid();
  return record;
}
function instant(value: unknown) { return value instanceof Date ? value.toISOString() : value; }
