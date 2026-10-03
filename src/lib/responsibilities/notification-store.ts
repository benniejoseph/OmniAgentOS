import type { SqlClient, SqlRow } from "@/lib/db/sql-types";
import { appendScopedDomainEvent } from "@/lib/events/store";
import { createExecutionScope } from "@/lib/security/execution-scope";
import { canonicalJsonSha256 } from "@/lib/tools/effect-receipt";
import { instantSchema } from "./contracts";
import type { ResponsibilityLifecycle } from "./runtime-contracts";
import type { ResponsibilityObservationReceipt } from "./observation-contracts";
import { verifiedObservationReceipt } from "./observation-store";
import { idempotencySha256, storageInvalid, type ResponsibilityOwner } from "./state";
import type { NotificationAdmission, ResponsibilityNotificationCandidate, ResponsibilityNotificationReceipt } from "./notification-contracts";
import { admitNotificationCandidate, buildNotificationReceipt, notificationCandidateId, notificationConflict,
  notificationLifecycleTarget, pendingNotificationCandidate, transitionNotificationCandidate,
  verifyNotificationAdmission, verifyNotificationCandidate, verifyNotificationReceipt } from "./notification-state";

export async function readNotificationAdmission(sql: SqlClient, owner: ResponsibilityOwner, id: string) {
  const rows = await sql`SELECT * FROM omni_responsibility_notification_admissions
    WHERE tenant_id = ${owner.tenantId} AND actor_id = ${owner.actorId} AND responsibility_id = ${id} FOR UPDATE`;
  if (rows.length > 1) throw storageInvalid();
  return rows[0] ? admissionFromRow(rows[0], owner, id) : null;
}
export async function readNotificationCandidate(sql: SqlClient, owner: ResponsibilityOwner, id: string, candidateId: string) {
  const rows = await sql`SELECT * FROM omni_responsibility_notification_candidates
    WHERE tenant_id = ${owner.tenantId} AND actor_id = ${owner.actorId} AND responsibility_id = ${id} AND id = ${candidateId} FOR UPDATE`;
  if (rows.length > 1) throw storageInvalid();
  return rows[0] ? candidateFromRow(rows[0], owner, id) : null;
}
export async function readNotificationReceipt(sql: SqlClient, owner: ResponsibilityOwner, key: string, request: unknown) {
  const digest = idempotencySha256(key);
  const rows = await sql`SELECT receipt FROM omni_responsibility_notification_receipts
    WHERE tenant_id = ${owner.tenantId} AND actor_id = ${owner.actorId} AND idempotency_sha256 = ${digest} LIMIT 2`;
  if (rows.length > 1) throw storageInvalid();
  if (!rows[0]) return null;
  const receipt = verifyNotificationReceipt(rows[0].receipt);
  if (receipt.snapshot.tenantId !== owner.tenantId || receipt.snapshot.actorId !== owner.actorId || receipt.idempotencySha256 !== digest) throw storageInvalid();
  if (receipt.requestSha256 !== canonicalJsonSha256(request)) throw notificationConflict("responsibility_idempotency_conflict");
  return receipt;
}

/** The owner advisory lock is shared with draft, observation and lifecycle
 * writers. Every budget transition, immutable receipt and event co-commits. */
export async function persistNotificationTransition(sql: SqlClient, input: {
  previous: NotificationAdmission | null; current: NotificationAdmission;
  previousCandidate?: ResponsibilityNotificationCandidate; candidate?: ResponsibilityNotificationCandidate;
  action: ResponsibilityNotificationReceipt["action"]; key: string; request: unknown;
}) {
  if (!sql.transactionScoped) throw storageInvalid();
  const current = verifyNotificationAdmission(input.current); const previous = input.previous && verifyNotificationAdmission(input.previous);
  if (previous && (previous.tenantId !== current.tenantId || previous.actorId !== current.actorId || previous.responsibilityId !== current.responsibilityId ||
    previous.configuration.configurationSha256 !== current.configuration.configurationSha256 || current.used < previous.used)) throw storageInvalid();
  const receipt = buildNotificationReceipt(input);
  const saved = previous ? await sql`UPDATE omni_responsibility_notification_admissions
      SET revision = ${current.revision}, generation = ${current.generation}, state = ${current.state}, snapshot = ${current}::jsonb, updated_at = ${current.updatedAt}
      WHERE tenant_id = ${current.tenantId} AND actor_id = ${current.actorId} AND responsibility_id = ${current.responsibilityId} AND revision = ${previous.revision} RETURNING responsibility_id`
    : await sql`INSERT INTO omni_responsibility_notification_admissions
      (tenant_id,actor_id,responsibility_id,revision,generation,state,snapshot,enabled_at,updated_at)
      VALUES (${current.tenantId},${current.actorId},${current.responsibilityId},${current.revision},${current.generation},${current.state},${current}::jsonb,${current.enabledAt},${current.updatedAt}) RETURNING responsibility_id`;
  if (saved.length !== 1) throw notificationConflict("responsibility_notification_changed");
  if (input.candidate) {
    const candidate = verifyNotificationCandidate(input.candidate); const prior = input.previousCandidate && verifyNotificationCandidate(input.previousCandidate);
    if (candidate.revision !== (prior?.revision ?? 0) + 1 || (prior && (!pendingNotificationCandidate(prior) || candidate.id !== prior.id ||
      candidate.configurationSha256 !== prior.configurationSha256 || candidate.generation !== prior.generation || candidate.expiresAt !== prior.expiresAt))) throw storageInvalid();
    const rows = prior ? await sql`UPDATE omni_responsibility_notification_candidates
        SET revision = ${candidate.revision}, state = ${candidate.state}, next_attempt_at = ${candidate.nextAttemptAt}, snapshot = ${candidate}::jsonb, updated_at = ${candidate.updatedAt}
        WHERE tenant_id = ${candidate.tenantId} AND actor_id = ${candidate.actorId} AND responsibility_id = ${candidate.responsibilityId} AND id = ${candidate.id} AND revision = ${prior.revision} RETURNING id`
      : await sql`INSERT INTO omni_responsibility_notification_candidates
        (tenant_id,actor_id,responsibility_id,id,change_id,change_sha256,revision,generation,state,next_attempt_at,expires_at,snapshot,created_at,updated_at)
        VALUES (${candidate.tenantId},${candidate.actorId},${candidate.responsibilityId},${candidate.id},${candidate.changeId},${candidate.changeSha256},${candidate.revision},${candidate.generation},${candidate.state},${candidate.nextAttemptAt},${candidate.expiresAt},${candidate}::jsonb,${candidate.createdAt},${candidate.updatedAt}) RETURNING id`;
    if (rows.length !== 1) throw notificationConflict("responsibility_notification_changed");
  }
  await sql`INSERT INTO omni_responsibility_notification_receipts
    (id,tenant_id,actor_id,responsibility_id,idempotency_sha256,request_sha256,revision,action,receipt,saved_at)
    VALUES (${receipt.id},${current.tenantId},${current.actorId},${current.responsibilityId},${receipt.idempotencySha256},${receipt.requestSha256},${current.revision},${receipt.action},${receipt}::jsonb,${receipt.savedAt})`;
  await appendScopedDomainEvent({ id: receipt.id, streamId: `responsibility:${current.tenantId}:${current.responsibilityId}`, type: "responsibility.notification.transitioned",
    executionScope: createExecutionScope({ tenantId: current.tenantId, initiatingActorId: current.actorId,
      executingPrincipalType: input.action === "enable" || input.action === "stop" ? "user" : "system", executingPrincipalId: input.action === "enable" || input.action === "stop" ? current.actorId : "responsibility-notifications",
      correlationId: receipt.id, causationId: input.candidate?.changeId, purpose: "responsibility.notification.v1" }),
    payload: notificationEventPayload(receipt),
  }, { sql });
  return receipt;
}

/** Called only alongside a newly committed governed observation. Reading a
 * historical change or enabling delivery never admits/backfills a candidate. */
export async function admitObservedNotificationWithSql(sql: SqlClient, owner: ResponsibilityOwner, receiptValue: ResponsibilityObservationReceipt, now: string) {
  const observation = verifiedObservationReceipt(receiptValue); const change = observation.plan.change;
  if (!change || observation.plan.outcome !== "material_change") return null;
  const head = await readNotificationAdmission(sql, owner, change.target.responsibilityId);
  if (!head || head.state !== "enabled" || head.configuration.expiresAt <= now) return null;
  if (change.target.tenantId !== owner.tenantId || change.target.actorId !== owner.actorId || observation.savedAt !== now) throw storageInvalid();
  const rows = await sql`SELECT snapshot FROM omni_responsibility_changes
    WHERE tenant_id = ${owner.tenantId} AND actor_id = ${owner.actorId} AND responsibility_id = ${head.responsibilityId}
      AND id = ${change.id} AND change_sha256 = ${change.changeSha256} AND observation_id = ${change.observationId}`;
  if (rows.length !== 1 || canonicalJsonSha256(rows[0].snapshot) !== canonicalJsonSha256(change)) throw storageInvalid();
  const candidateId = notificationCandidateId({ ...owner, responsibilityId: head.responsibilityId, changeId: change.id, changeSha256: change.changeSha256 });
  if (await readNotificationCandidate(sql, owner, head.responsibilityId, candidateId)) return null;
  const freshness = observation.plan.observation.sources.map((source) => source.state === "accepted" ? source.freshUntil : null);
  if (!freshness.length || freshness.some((value) => !value)) throw storageInvalid();
  const freshUntil = (freshness as string[]).sort()[0];
  if (freshUntil <= now) return null;
  const transition = admitNotificationCandidate(head, change, freshUntil, now);
  return persistNotificationTransition(sql, { previous: head, ...transition, action: "admit", key: `notification:admit:${candidateId}`, request: { changeId: change.id, changeSha256: change.changeSha256 } });
}

/** A finite pending delivery may drain after checks are exhausted. Explicit
 * pause/end/expiry/revocation cancels each reservation and fences its generation. */
export async function syncNotificationLifecycleWithSql(sql: SqlClient, runtime: ResponsibilityLifecycle, now: string) {
  const owner = { tenantId: runtime.tenantId, actorId: runtime.actorId }; let head = await readNotificationAdmission(sql, owner, runtime.responsibilityId);
  if (!head || head.state === "ended") return;
  const target = notificationLifecycleTarget(head, runtime, now);
  if (head.state === target.state && head.reason === target.reason) return;
  if (target.cancelReason) {
    const rows = await sql`SELECT * FROM omni_responsibility_notification_candidates
      WHERE tenant_id = ${owner.tenantId} AND actor_id = ${owner.actorId} AND responsibility_id = ${runtime.responsibilityId}
        AND state IN ('pending','held') ORDER BY created_at,id FOR UPDATE`;
    // The reviewed cumulative limit bounds this loop to at most 1,000 rows.
    if (rows.length > head.configuration.maximumNotifications) throw storageInvalid();
    for (const row of rows) {
      const candidate = candidateFromRow(row, owner, runtime.responsibilityId);
      const action = target.cancelReason === "expired" ? "expire" : "cancel";
      const next = transitionNotificationCandidate(head, candidate, { now, outcome: action, reason: target.cancelReason });
      await persistNotificationTransition(sql, { previous: head, previousCandidate: candidate, ...next, action,
        key: `notification:stop:${candidate.id}:${runtime.revision}`, request: { runtimeRevision: runtime.revision, reason: target.cancelReason } });
      head = next.current;
    }
  }
  const current = verifyNotificationAdmission({ ...head, revision: head.revision + 1, generation: head.generation + (target.cancelReason ? 1 : 0),
    state: target.state, reason: target.reason, updatedAt: now });
  const request = { runtimeRevision: runtime.revision, runtimeGeneration: runtime.generation, previousNotificationRevision: head.revision,
    state: target.state, reason: target.reason };
  await persistNotificationTransition(sql, { previous: head, current, action: "lifecycle",
    key: `notification:lifecycle:${canonicalJsonSha256({ responsibilityId: runtime.responsibilityId, ...request })}`, request });
}

/** Explicitly stop only the separately enabled inbox authority. Runtime checks
 * are unaffected; delivered history and cumulative use cannot be reset. */
export async function stopNotificationAdmissionWithSql(sql: SqlClient, current: NotificationAdmission, key: string, request: unknown, now: string) {
  let head = verifyNotificationAdmission(current);
  if (head.state === "ended") throw notificationConflict("responsibility_notification_already_stopped");
  const rows = await sql`SELECT * FROM omni_responsibility_notification_candidates
    WHERE tenant_id = ${head.tenantId} AND actor_id = ${head.actorId} AND responsibility_id = ${head.responsibilityId}
      AND state IN ('pending','held') ORDER BY created_at,id FOR UPDATE`;
  if (rows.length !== head.reserved || rows.length > head.configuration.maximumNotifications) throw storageInvalid();
  for (const row of rows) {
    const candidate = candidateFromRow(row, head, head.responsibilityId);
    const next = transitionNotificationCandidate(head, candidate, { now, outcome: "cancel", reason: "owner_stopped" });
    await persistNotificationTransition(sql, { previous: head, previousCandidate: candidate, ...next, action: "cancel",
      key: `notification:owner-stop:${canonicalJsonSha256([key, candidate.id, candidate.revision])}`, request: { stopRequest: request, candidateId: candidate.id, candidateRevision: candidate.revision } });
    head = next.current;
  }
  const next = verifyNotificationAdmission({ ...head, revision: head.revision + 1, generation: head.generation + 1,
    state: "ended", reason: "owner_stopped", updatedAt: now });
  const receipt = await persistNotificationTransition(sql, { previous: head, current: next, action: "stop", key, request });
  return { current: next, receipt };
}
export function notificationEventPayload(receipt: ResponsibilityNotificationReceipt) {
  const { snapshot, candidate } = receipt;
  return { schemaVersion: 1, responsibilityId: snapshot.responsibilityId, revision: snapshot.revision, generation: snapshot.generation,
    action: receipt.action, state: snapshot.state, reason: snapshot.reason, configurationSha256: snapshot.configuration.configurationSha256,
    receiptId: receipt.id, receiptSha256: receipt.receiptSha256, candidateId: candidate?.id ?? null, candidateState: candidate?.state ?? null,
    candidateReason: candidate?.reason ?? null, changeId: candidate?.changeId ?? null, changeSha256: candidate?.changeSha256 ?? null,
    used: snapshot.used, reserved: snapshot.reserved, notificationId: candidate?.notificationId ?? null,
    deliveryBindingSha256: candidate?.deliveryBindingSha256 ?? null, contentIncluded: false, externalDelivery: false };
}
export function admissionFromRow(row: SqlRow, owner: ResponsibilityOwner, id: string) {
  const head = verifyNotificationAdmission(row.snapshot);
  if (row.tenant_id !== owner.tenantId || row.actor_id !== owner.actorId || row.responsibility_id !== id || head.tenantId !== owner.tenantId || head.actorId !== owner.actorId || head.responsibilityId !== id ||
    Number(row.revision) !== head.revision || Number(row.generation) !== head.generation || row.state !== head.state || instant(row.enabled_at) !== head.enabledAt || instant(row.updated_at) !== head.updatedAt) throw storageInvalid();
  return head;
}
export function candidateFromRow(row: SqlRow, owner: ResponsibilityOwner, id: string) {
  const candidate = verifyNotificationCandidate(row.snapshot);
  if (row.tenant_id !== owner.tenantId || row.actor_id !== owner.actorId || row.responsibility_id !== id || candidate.tenantId !== owner.tenantId || candidate.actorId !== owner.actorId || candidate.responsibilityId !== id ||
    row.id !== candidate.id || row.change_id !== candidate.changeId || row.change_sha256 !== candidate.changeSha256 || Number(row.revision) !== candidate.revision || Number(row.generation) !== candidate.generation || row.state !== candidate.state ||
    (row.next_attempt_at === null ? null : instant(row.next_attempt_at)) !== candidate.nextAttemptAt || instant(row.expires_at) !== candidate.expiresAt || instant(row.created_at) !== candidate.createdAt || instant(row.updated_at) !== candidate.updatedAt) throw storageInvalid();
  return candidate;
}
function instant(value: unknown) { return instantSchema.parse(value instanceof Date ? value.toISOString() : value); }
