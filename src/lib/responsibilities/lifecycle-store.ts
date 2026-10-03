import { ensureDatabaseSchema, getSql, hasDatabaseUrl, runWithDatabaseActorScope } from "@/lib/db/client";
import type { SqlClient, SqlRow } from "@/lib/db/sql-types";
import { appendScopedDomainEvent } from "@/lib/events/store";
import { createExecutionScope } from "@/lib/security/execution-scope";
import { canonicalJsonSha256 } from "@/lib/tools/effect-receipt";
import { instantSchema, responsibilityIdSchema } from "./contracts";
import { buildRuntimeReceipt, changeResponsibilityLifecycle, verifyLifecycle, verifyRuntimeReceipt, verifyWake } from "./lifecycle-state";
import { RESPONSIBILITY_PILOT_DISCLOSURE, RESPONSIBILITY_RUNTIME_CONTRACT, responsibilityLifecycleRequestSchema,
  type ResponsibilityLifecycle, type ResponsibilityRuntimeReceipt, type ResponsibilityWake } from "./runtime-contracts";
import { nextPilotDue, resolveResponsibilityPilot } from "./runtime-references";
import { idempotencySha256, notFound, ResponsibilityError, storageInvalid, verifiedRecord, type ResponsibilityOwner } from "./state";
import { syncNotificationLifecycleWithSql } from "./notification-store";

export async function withResponsibilityRuntimeTransaction<T>(owner: ResponsibilityOwner, work: (sql: SqlClient) => Promise<T>, readableActors: readonly string[] = [owner.actorId]): Promise<T> {
  if (!hasDatabaseUrl()) throw new ResponsibilityError("Responsibility runtime requires durable database storage.", 503, "responsibility_storage_unavailable");
  await ensureDatabaseSchema();
  return runWithDatabaseActorScope(owner.tenantId, readableActors, async () => await getSql().transaction(async (sql: SqlClient) => {
    await sql`SELECT pg_advisory_xact_lock(hashtextextended(${JSON.stringify(["responsibility-draft:1", owner.tenantId, owner.actorId])}, 0))`;
    return work(sql);
  }) as T);
}
export async function readRuntimeDraft(sql: SqlClient, owner: ResponsibilityOwner, id: string) {
  const rows = await sql`SELECT snapshot FROM omni_responsibilities WHERE tenant_id = ${owner.tenantId} AND actor_id = ${owner.actorId} AND id = ${id} FOR UPDATE`;
  if (!rows.length) throw notFound();
  if (rows.length !== 1) throw storageInvalid();
  const record = verifiedRecord(rows[0].snapshot);
  if (record.tenantId !== owner.tenantId || record.actorId !== owner.actorId || record.id !== id) throw storageInvalid();
  return record;
}
export async function readRuntimeHead(sql: SqlClient, owner: ResponsibilityOwner, id: string) {
  const rows = await sql`SELECT * FROM omni_responsibility_lifecycles WHERE tenant_id = ${owner.tenantId} AND actor_id = ${owner.actorId} AND responsibility_id = ${id} FOR UPDATE`;
  if (rows.length > 1) throw storageInvalid();
  return rows[0] ? lifecycleFromRow(rows[0], owner, id) : null;
}
export async function readRuntimeWake(sql: SqlClient, owner: ResponsibilityOwner, id: string, wakeId: string) {
  const rows = await sql`SELECT * FROM omni_responsibility_wakes WHERE tenant_id = ${owner.tenantId} AND actor_id = ${owner.actorId} AND responsibility_id = ${id} AND id = ${wakeId} FOR UPDATE`;
  if (rows.length !== 1) throw notFound();
  return wakeFromRow(rows[0], owner, id);
}
export async function readRuntimeReceipt(sql: SqlClient, owner: ResponsibilityOwner, key: string, request: unknown) {
  const rows = await sql`SELECT receipt FROM omni_responsibility_runtime_receipts WHERE tenant_id = ${owner.tenantId} AND actor_id = ${owner.actorId}
    AND idempotency_sha256 = ${idempotencySha256(key)} LIMIT 2`;
  if (rows.length > 1) throw storageInvalid();
  if (!rows[0]) return null;
  const receipt = verifyRuntimeReceipt(rows[0].receipt);
  if (receipt.snapshot.tenantId !== owner.tenantId || receipt.snapshot.actorId !== owner.actorId || receipt.idempotencySha256 !== idempotencySha256(key)) throw storageInvalid();
  if (receipt.requestSha256 !== canonicalJsonSha256(request)) throw new ResponsibilityError("This Idempotency-Key names a different responsibility transition.", 409, "responsibility_idempotency_conflict");
  return receipt;
}
export async function readResponsibilityRuntime(owner: ResponsibilityOwner, id: string, preview: boolean) {
  responsibilityIdSchema.parse(id);
  return withResponsibilityRuntimeTransaction(owner, async (sql) => {
    const record = await readRuntimeDraft(sql, owner, id); const current = await readRuntimeHead(sql, owner, id);
    const rows = await sql`SELECT * FROM omni_responsibility_wakes WHERE tenant_id = ${owner.tenantId} AND actor_id = ${owner.actorId} AND responsibility_id = ${id}
      ORDER BY created_at DESC, id ASC LIMIT 41`;
    const receipts = await sql`SELECT receipt FROM omni_responsibility_runtime_receipts WHERE tenant_id = ${owner.tenantId} AND actor_id = ${owner.actorId} AND responsibility_id = ${id}
      ORDER BY revision DESC LIMIT 41`;
    const base = { schemaVersion: 1, contract: RESPONSIBILITY_RUNTIME_CONTRACT, current, disclosure: RESPONSIBILITY_PILOT_DISCLOSURE,
      wakes: rows.slice(0, 40).map((row) => wakeFromRow(row, owner, id)), receipts: receipts.slice(0, 40).map((row) => verifyRuntimeReceipt(row.receipt)),
      coverage: { limit: 40, total: null, hasMoreWakes: rows.length > 40, hasMoreReceipts: receipts.length > 40 },
      dispatchReadiness: "not_observed" as const, deliverySupported: false };
    if (!preview) return base;
    try {
      const resolved = await resolveResponsibilityPilot(sql, owner, record, await runtimeDatabaseNow(sql), current === null);
      return { ...base, preview: { state: "ready" as const, configuration: resolved.configuration,
        authorityEffect: "none" as const, dispatchReadiness: "not_observed" as const } };
    } catch (error) {
      if (error instanceof ResponsibilityError && (error.status === 409 || error.status === 403)) return { ...base, preview: { state: "blocked" as const, reason: error.code, authorityEffect: "none" as const } };
      throw error;
    }
  });
}

export async function controlResponsibilityRuntime(owner: ResponsibilityOwner, id: string, rawRequest: unknown, key: string) {
  responsibilityIdSchema.parse(id); const parsed = responsibilityLifecycleRequestSchema.safeParse(rawRequest);
  if (!parsed.success) throw new ResponsibilityError("The exact responsibility lifecycle request is invalid.", 400, "responsibility_request_invalid");
  const request = parsed.data; const boundRequest = { responsibilityId: id, ...request };
  return withResponsibilityRuntimeTransaction(owner, async (sql) => {
    const current = await readRuntimeHead(sql, owner, id); const prior = await readRuntimeReceipt(sql, owner, key, boundRequest);
    if (prior) {
      if (!current || prior.snapshot.responsibilityId !== id || current.revision < prior.snapshot.revision) throw storageInvalid();
      return { schemaVersion: 1, contract: RESPONSIBILITY_RUNTIME_CONTRACT, current, receipt: prior, replayed: true };
    }
    const now = await runtimeDatabaseNow(sql);
    const resolved = request.action === "activate" || request.action === "resume"
      ? await resolveResponsibilityPilot(sql, owner, await readRuntimeDraft(sql, owner, id), now, request.action === "activate") : undefined;
    const nextDueAt = resolved ? nextPilotDue(resolved.schedule, new Date(Date.parse(now) - 1).toISOString(), current?.budget.usedChecks ?? 0) : null;
    const next = changeResponsibilityLifecycle({ owner, responsibilityId: id, request, current, configuration: resolved?.configuration, nextDueAt, now });
    const receipt = await persistRuntimeTransition(sql, { previous: current, current: next, key, request: boundRequest, action: request.action });
    return { schemaVersion: 1, contract: RESPONSIBILITY_RUNTIME_CONTRACT, current: next, receipt, replayed: false };
  });
}

/** One writer for every lifecycle/budget/wake transition. Caller owns the owner
 * lock and (for settlement) the same observation/tool-audit transaction. */
export async function persistRuntimeTransition(sql: SqlClient, input: {
  previous: ResponsibilityLifecycle | null; current: ResponsibilityLifecycle; previousWake?: ResponsibilityWake; wake?: ResponsibilityWake;
  key: string; request: unknown; action: ResponsibilityRuntimeReceipt["action"];
}) {
  if (!sql.transactionScoped) throw storageInvalid();
  const current = verifyLifecycle(input.current); const previous = input.previous && verifyLifecycle(input.previous);
  if (current.revision !== (previous?.revision ?? 0) + 1 || (previous && (previous.tenantId !== current.tenantId || previous.actorId !== current.actorId || previous.responsibilityId !== current.responsibilityId))) throw storageInvalid();
  const receipt = buildRuntimeReceipt({ ...input, previousRevision: previous?.revision ?? 0 });
  const rows = previous ? await sql`UPDATE omni_responsibility_lifecycles SET revision = ${current.revision}, generation = ${current.generation}, state = ${current.state},
      next_due_at = ${current.nextDueAt}, snapshot = ${current}::jsonb, updated_at = ${current.updatedAt}
    WHERE tenant_id = ${current.tenantId} AND actor_id = ${current.actorId} AND responsibility_id = ${current.responsibilityId} AND revision = ${previous.revision} RETURNING responsibility_id`
    : await sql`INSERT INTO omni_responsibility_lifecycles (tenant_id,actor_id,responsibility_id,revision,generation,state,next_due_at,snapshot,activated_at,updated_at)
      VALUES (${current.tenantId},${current.actorId},${current.responsibilityId},${current.revision},${current.generation},${current.state},${current.nextDueAt},${current}::jsonb,${current.activatedAt},${current.updatedAt}) RETURNING responsibility_id`;
  if (rows.length !== 1) throw new ResponsibilityError("The responsibility lifecycle changed.", 409, "responsibility_lifecycle_changed");
  if (input.wake) {
    const wake = verifyWake(input.wake);
    if (wake.tenantId !== current.tenantId || wake.actorId !== current.actorId || wake.responsibilityId !== current.responsibilityId || wake.revision !== (input.previousWake?.revision ?? 0) + 1) throw storageInvalid();
    const saved = input.previousWake ? await sql`UPDATE omni_responsibility_wakes SET revision = ${wake.revision}, state = ${wake.state}, workflow_run_id = ${wake.workflowRunId},
        lease_expires_at = ${wake.leaseExpiresAt}, snapshot = ${wake}::jsonb, updated_at = ${wake.updatedAt}
      WHERE tenant_id = ${wake.tenantId} AND actor_id = ${wake.actorId} AND responsibility_id = ${wake.responsibilityId} AND id = ${wake.id} AND revision = ${input.previousWake.revision} RETURNING id`
      : await sql`INSERT INTO omni_responsibility_wakes (tenant_id,actor_id,responsibility_id,id,revision,generation,scheduled_for,state,workflow_run_id,lease_expires_at,snapshot,created_at,updated_at)
        VALUES (${wake.tenantId},${wake.actorId},${wake.responsibilityId},${wake.id},${wake.revision},${wake.generation},${wake.scheduledFor},${wake.state},${wake.workflowRunId},${wake.leaseExpiresAt},${wake}::jsonb,${wake.createdAt},${wake.updatedAt}) RETURNING id`;
    if (saved.length !== 1) throw new ResponsibilityError("The responsibility wake changed.", 409, "responsibility_wake_changed");
  }
  await sql`INSERT INTO omni_responsibility_runtime_receipts (id,tenant_id,actor_id,responsibility_id,idempotency_sha256,request_sha256,revision,generation,action,receipt,saved_at)
    VALUES (${receipt.id},${current.tenantId},${current.actorId},${current.responsibilityId},${receipt.idempotencySha256},${receipt.requestSha256},${current.revision},${current.generation},${receipt.action},${receipt}::jsonb,${receipt.savedAt})`;
  const budgetEntry = { schemaVersion: 1, receiptId: receipt.id, responsibilityId: current.responsibilityId, revision: current.revision,
    wakeId: input.wake?.id ?? null, before: previous?.budget ?? null, after: current.budget };
  await sql`INSERT INTO omni_responsibility_budget_entries (id,tenant_id,actor_id,responsibility_id,revision,wake_id,entry,saved_at)
    VALUES (${receipt.id},${current.tenantId},${current.actorId},${current.responsibilityId},${current.revision},${input.wake?.id ?? null},${budgetEntry}::jsonb,${receipt.savedAt})`;
  await appendScopedDomainEvent({ id: receipt.id, streamId: `responsibility:${current.tenantId}:${current.responsibilityId}`, type: "responsibility.runtime.transitioned",
    executionScope: createExecutionScope({ tenantId: current.tenantId, initiatingActorId: current.actorId,
      executingPrincipalType: ["activate", "pause", "resume", "end"].includes(input.action) ? "user" : "system",
      executingPrincipalId: ["activate", "pause", "resume", "end"].includes(input.action) ? current.actorId : "responsibility-runtime",
      correlationId: receipt.id, causationId: input.wake?.id, purpose: "responsibility.runtime.transition.v1" }),
    payload: runtimeEventPayload(receipt),
  }, { sql });
  await syncNotificationLifecycleWithSql(sql, current, current.updatedAt);
  return receipt;
}
export function runtimeEventPayload(receipt: ResponsibilityRuntimeReceipt) {
  const { snapshot, wake } = receipt;
  return { schemaVersion: 1, responsibilityId: snapshot.responsibilityId, revision: snapshot.revision, generation: snapshot.generation,
    action: receipt.action, state: snapshot.state, reason: snapshot.reason, configurationSha256: snapshot.configuration.configurationSha256,
    receiptId: receipt.id, receiptSha256: receipt.receiptSha256, wakeId: wake?.id ?? null, wakeState: wake?.state ?? null,
    observationId: wake?.observationId ?? null, usedChecks: snapshot.budget.usedChecks, reservedChecks: snapshot.budget.reservedChecks,
    budgetSha256: canonicalJsonSha256(snapshot.budget), notificationCreated: false, approvalCreated: false };
}
export async function runtimeDatabaseNow(sql: SqlClient) {
  const rows = await sql`SELECT clock_timestamp() AS responsibility_now`;
  return instantSchema.parse(instant(rows[0]?.responsibility_now));
}
export function lifecycleFromRow(row: SqlRow, owner: ResponsibilityOwner, id: string) {
  const current = verifyLifecycle(row.snapshot);
  if (row.tenant_id !== owner.tenantId || row.actor_id !== owner.actorId || row.responsibility_id !== id || current.tenantId !== owner.tenantId || current.actorId !== owner.actorId || current.responsibilityId !== id ||
    Number(row.revision) !== current.revision || Number(row.generation) !== current.generation || row.state !== current.state || (row.next_due_at === null ? null : instant(row.next_due_at)) !== current.nextDueAt || instant(row.activated_at) !== current.activatedAt || instant(row.updated_at) !== current.updatedAt) throw storageInvalid();
  return current;
}
export function wakeFromRow(row: SqlRow, owner: ResponsibilityOwner, id: string) {
  const wake = verifyWake(row.snapshot);
  if (row.tenant_id !== owner.tenantId || row.actor_id !== owner.actorId || row.responsibility_id !== id || wake.tenantId !== owner.tenantId || wake.actorId !== owner.actorId || wake.responsibilityId !== id ||
    row.id !== wake.id || Number(row.revision) !== wake.revision || Number(row.generation) !== wake.generation || row.state !== wake.state || row.workflow_run_id !== wake.workflowRunId ||
    instant(row.scheduled_for) !== wake.scheduledFor || (row.lease_expires_at === null ? null : instant(row.lease_expires_at)) !== wake.leaseExpiresAt || instant(row.created_at) !== wake.createdAt || instant(row.updated_at) !== wake.updatedAt) throw storageInvalid();
  return wake;
}
function instant(value: unknown) { return value instanceof Date ? value.toISOString() : value; }
