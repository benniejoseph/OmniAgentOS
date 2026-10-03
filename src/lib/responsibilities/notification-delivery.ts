import { ensureDatabaseSchema, getSql, hasDatabaseUrl, runWithDatabaseActorScope, runWithDatabaseSystemScope } from "@/lib/db/client";
import type { SqlClient } from "@/lib/db/sql-types";
import { notificationDecisionExecutionScope } from "@/lib/mobile/notification-decision-events";
import { decideServerNotification, notificationDispositionCoordinates, responsibilityChangeNotificationCandidate } from "@/lib/mobile/notification-delivery-policy";
import { applyNotificationDispositionDecision } from "@/lib/mobile/notification-disposition-store";
import { canonicalAuthUserActorFromSecurityContext, canonicalRequestActorBindingFromSecurityContext } from "@/lib/security/canonical-actor";
import type { SecurityContext } from "@/lib/security/types";
import { isQuietHoursActive, recordResponsibilityInboxNotificationWithSql } from "@/lib/today/notifications";
import { canonicalJsonSha256 } from "@/lib/tools/effect-receipt";
import { responsibilityIdSchema } from "./contracts";
import { readRuntimeDraft, readRuntimeHead, runtimeDatabaseNow, withResponsibilityRuntimeTransaction } from "./lifecycle-store";
import type { NotificationCandidateReason, ResponsibilityNotificationCandidate } from "./notification-contracts";
import { resolveNotificationOwnerContext, resolveNotificationReferences } from "./notification-references";
import { pendingNotificationCandidate, transitionNotificationCandidate } from "./notification-state";
import { persistNotificationTransition, readNotificationAdmission, readNotificationCandidate, syncNotificationLifecycleWithSql } from "./notification-store";
import { ResponsibilityError, storageInvalid, type ResponsibilityOwner } from "./state";

export const emptyResponsibilityNotificationSummary = () => ({ inspected: 0, delivered: 0, held: 0, closed: 0, failed: 0 });
type AttemptResult = "delivered" | "held" | "closed" | "unchanged";

/** Existing protected scheduler callers only. Enumeration returns opaque
 * coordinates; each finite attempt reacquires the canonical owner's lock. */
export async function processDueResponsibilityNotifications(input: { limit?: number; deadlineAt?: number; context?: SecurityContext } = {}) {
  const summary = emptyResponsibilityNotificationSummary();
  if (!hasDatabaseUrl()) return summary;
  await ensureDatabaseSchema();
  const limit = Math.min(20, Math.max(1, Math.trunc(input.limit ?? 5)));
  const canonical = input.context && canonicalAuthUserActorFromSecurityContext(input.context);
  if (input.context && !canonical) return summary;
  const list = async () => input.context && canonical
    ? getSql()`SELECT tenant_id,actor_id,responsibility_id,id FROM omni_responsibility_notification_candidates
        WHERE tenant_id = ${input.context.tenantId} AND actor_id = ${canonical.actorId} AND state IN ('pending','held')
          AND (next_attempt_at <= now() OR expires_at <= now()) ORDER BY next_attempt_at,id LIMIT ${limit}`
    : getSql()`SELECT tenant_id,actor_id,responsibility_id,id FROM omni_responsibility_notification_candidates
        WHERE state IN ('pending','held') AND (next_attempt_at <= now() OR expires_at <= now())
        ORDER BY next_attempt_at,tenant_id,actor_id,id LIMIT ${limit}`;
  const rows = input.context && canonical ? await runWithDatabaseActorScope(input.context.tenantId, [canonical.actorId], list)
    : await runWithDatabaseSystemScope("Enumerate bounded opaque Responsibility inbox candidate owner coordinates.", list);
  for (const row of rows) {
    if (Date.now() >= (input.deadlineAt ?? Infinity)) break;
    summary.inspected++;
    if (typeof row.tenant_id !== "string" || typeof row.actor_id !== "string" || typeof row.id !== "string" ||
      !responsibilityIdSchema.safeParse(row.responsibility_id).success) { summary.failed++; continue; }
    try {
      const result = await attemptResponsibilityNotification({ tenantId: row.tenant_id, actorId: row.actor_id }, String(row.responsibility_id), row.id);
      if (result !== "unchanged") summary[result]++;
    } catch { summary.failed++; }
  }
  return summary;
}

/** No provider call, push enqueue, or browser notification participates here.
 * The actual inbox row, disposition, cumulative debit and receipt co-commit. */
export async function attemptResponsibilityNotification(owner: ResponsibilityOwner, id: string, candidateId: string): Promise<AttemptResult> {
  try {
    const identity = await withResponsibilityRuntimeTransaction(owner, (sql) => resolveNotificationOwnerContext(sql, owner));
    const binding = canonicalRequestActorBindingFromSecurityContext(identity);
    if (!binding || binding.canonicalActorId !== owner.actorId) throw storageInvalid();
    return await withResponsibilityRuntimeTransaction(owner, async (sql) => {
      const pending = await loadPending(sql, owner, id, candidateId);
      if (!pending) return "unchanged";
      const { head, candidate, runtime } = pending;
      const checkedAt = await runtimeDatabaseNow(sql);
      if (candidate.expiresAt <= checkedAt) return settle(sql, head, candidate, "expire", "expired", checkedAt);
      if (candidate.nextAttemptAt! > checkedAt) return "unchanged";
      // Uses existing scoped source/consent/pin readers before any delivery.
      // Their row locks remain held through the ledger commit.
      const resolved = await resolveNotificationReferences(sql, owner, await readRuntimeDraft(sql, owner, id), runtime, checkedAt, identity);
      const now = await runtimeDatabaseNow(sql);
      if (candidate.expiresAt <= now || head.configuration.expiresAt <= now) return settle(sql, head, candidate, "expire", "expired", now);
      if (resolved.authorityExpiresAt && resolved.authorityExpiresAt <= now) {
        return settle(sql, head, candidate, "block", "source_unavailable", now);
      }
      const coordinates = { tenantId: owner.tenantId, actorId: owner.actorId, sourceKind: "responsibility_change" as const,
        sourceId: id, occurrenceKey: candidate.id };
      const decision = decideServerNotification({ candidate: responsibilityChangeNotificationCandidate(coordinates), policy: {
        evaluatedAt: now, quietHoursActive: isQuietHoursActive(resolved.preferences, new Date(now)), cooldownActive: false, digestEnabled: false } });
      const targetSha256 = canonicalJsonSha256({ ...owner, channel: "owner_in_app", responsibilityId: id,
        candidateId: candidate.id, changeId: candidate.changeId, changeSha256: candidate.changeSha256 });
      let notificationId: string | undefined;
      const disposition = await applyNotificationDispositionDecision({
        coordinates: notificationDispositionCoordinates({ ...coordinates, ownerActorId: owner.actorId, decision }), decision, sql, now: new Date(now),
        executionScope: notificationDecisionExecutionScope({ ...owner, sourceId: id, producerId: "responsibility-in-app", decision }),
        directDelivery: async (deliverySql) => {
          // This callback is invoked only for an actual send decision inside
          // the same owner transaction, after the disposition's exact lock.
          const dispatchedAt = await runtimeDatabaseNow(deliverySql);
          if (candidate.expiresAt <= dispatchedAt || head.configuration.expiresAt <= dispatchedAt ||
            (resolved.authorityExpiresAt !== null && resolved.authorityExpiresAt <= dispatchedAt) ||
            !resolved.evidence.projection.meeting?.startsAt || resolved.evidence.projection.meeting.startsAt <= dispatchedAt) {
            throw new ResponsibilityError("The current in-app delivery authority expired.", 409, "responsibility_notification_delivery_expired");
          }
          const notification = await recordResponsibilityInboxNotificationWithSql(deliverySql, { ...owner, responsibilityId: id, candidateId: candidate.id, now: dispatchedAt });
          notificationId = notification.id;
          return { deliveryKind: "notification_ledger", deliveryIds: [notification.id], targetSha256 };
        },
      });
      if (decision.outcome === "defer" && decision.reason === "quiet_hours" && disposition.record.state === "pending") {
        return settle(sql, head, candidate, "hold", "quiet_hours", now, { dispositionId: disposition.record.id });
      }
      if (decision.outcome !== "send" || !disposition.applied || disposition.record.state !== "terminal" ||
        disposition.record.deliveryKind !== "notification_ledger" || !disposition.record.deliveryBindingSha256 || !notificationId ||
        disposition.deliveryIds.length !== 1 || disposition.deliveryIds[0] !== notificationId) throw storageInvalid();
      const next = transitionNotificationCandidate(head, candidate, { now: await runtimeDatabaseNow(sql), outcome: "deliver", reason: "in_app_recorded",
        delivery: { notificationId, dispositionId: disposition.record.id, deliveryBindingSha256: disposition.record.deliveryBindingSha256 } });
      await persistNotificationTransition(sql, { previous: head, previousCandidate: candidate, ...next, action: "deliver",
        key: `notification:attempt:${candidate.id}:${candidate.revision}`, request: { candidateId: candidate.id, revision: candidate.revision, outcome: "deliver" } });
      return "delivered";
    }, binding.readableOwnerActorIds);
  } catch (error) {
    // A rejected/unknown transaction never proves delivery. Reacquiring the
    // same lock first sees a committed terminal receipt, if one exists.
    return withResponsibilityRuntimeTransaction(owner, async (sql) => {
      const pending = await loadPending(sql, owner, id, candidateId);
      if (!pending) return "unchanged";
      const now = await runtimeDatabaseNow(sql);
      if (pending.candidate.expiresAt <= now) return settle(sql, pending.head, pending.candidate, "expire", "expired", now);
      if (error instanceof ResponsibilityError && (error.status === 403 || error.status === 409)) {
        return settle(sql, pending.head, pending.candidate, "block", refusalReason(error.code), now);
      }
      return settle(sql, pending.head, pending.candidate, "retry", "delivery_retry", now);
    });
  }
}

async function loadPending(sql: SqlClient, owner: ResponsibilityOwner, id: string, candidateId: string) {
  const runtime = await readRuntimeHead(sql, owner, id); if (!runtime) throw storageInvalid();
  await syncNotificationLifecycleWithSql(sql, runtime, await runtimeDatabaseNow(sql));
  const head = await readNotificationAdmission(sql, owner, id); const candidate = await readNotificationCandidate(sql, owner, id, candidateId);
  if (!head || !candidate || !pendingNotificationCandidate(candidate)) return null;
  if (head.generation !== candidate.generation || !["enabled", "draining"].includes(head.state)) throw storageInvalid();
  return { head, candidate, runtime };
}
async function settle(sql: SqlClient, head: NonNullable<Awaited<ReturnType<typeof readNotificationAdmission>>>, candidate: ResponsibilityNotificationCandidate,
  outcome: "hold" | "retry" | "block" | "expire", reason: NotificationCandidateReason, now: string, extra: { dispositionId?: string } = {}): Promise<AttemptResult> {
  const next = transitionNotificationCandidate(head, candidate, { now, outcome, reason, ...extra });
  await persistNotificationTransition(sql, { previous: head, previousCandidate: candidate, ...next, action: outcome,
    key: `notification:attempt:${candidate.id}:${candidate.revision}`, request: { candidateId: candidate.id, revision: candidate.revision, outcome } });
  return pendingNotificationCandidate(next.candidate) ? "held" : "closed";
}
function refusalReason(code: string): NotificationCandidateReason {
  if (code === "responsibility_notification_notifications_disabled") return "notifications_disabled";
  if (code === "responsibility_notification_preferences_unavailable") return "preferences_unavailable";
  if (code === "responsibility_notification_destination_unavailable" || code === "responsibility_owner_revoked") return "destination_unavailable";
  return "source_unavailable";
}
