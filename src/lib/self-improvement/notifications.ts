import { ensureDatabaseSchema, getSql, hasDatabaseUrl, runWithDatabaseSystemScope } from "@/lib/db/client";
import { withAvailabilityOwner } from "@/lib/availability-watches/store";
import type { SqlClient } from "@/lib/db/sql-types";
import { isQuietHoursActive } from "@/lib/today/notifications";
import { notificationDecisionExecutionScope } from "@/lib/mobile/notification-decision-events";
import { decideServerNotification, notificationDispositionCoordinates, selfImprovementNotificationCandidate } from "@/lib/mobile/notification-delivery-policy";
import { applyNotificationDispositionDecision } from "@/lib/mobile/notification-disposition-store";
import { findActiveNotificationOwnerPreferencesWithSql } from "@/lib/mobile/notification-owner";
import { enqueueMobilePush } from "@/lib/mobile/push-store";
import { enqueueBrowserSelfImprovementPush } from "@/lib/web-push/store";
import { canonicalJsonSha256 } from "@/lib/tools/effect-receipt";

export const SELF_IMPROVEMENT_NOTIFICATION_MIN_NATIVE_VERSION = 62;
const titles = {
  succeeded: "Asael deployed a verified improvement",
  failed: "Asael improvement needs attention",
  rolled_back: "Asael restored the previous release",
  review_required: "Asael improvement is ready for your review",
} as const;
export type SelfImprovementNotificationStage = keyof typeof titles;
export function selfImprovementNotificationTitle(stage: string): string | null {
  return Object.hasOwn(titles, stage) ? titles[stage as SelfImprovementNotificationStage] : null;
}
type Admission = { tenantId: string; actorId: string; cycleId: string; eventId: string; stage: string; occurredAt: string; summary?: string;
  eventType?: "self_improvement.cycle.updated" | "self_improvement.release.held"; category?: string };

/** Co-commit only SQL ledgers/outboxes with an exact typed cycle transition.
 * Provider IO remains in the existing bounded delivery workers. */
export async function admitSelfImprovementNotificationWithSql(sql: SqlClient, input: Admission) {
  const eventType = input.eventType ?? "self_improvement.cycle.updated";
  const held = eventType === "self_improvement.release.held";
  const title = held ? "Asael publication needs your attention" : selfImprovementNotificationTitle(input.stage);
  if (!title) return { state: "quiet" as const, notificationId: null };
  if (!sql.transactionScoped || !/^self_cycle_[a-f0-9]{64}$/.test(input.cycleId) ||
      !/^actor:[a-f0-9-]{36}$/.test(input.actorId) || !new RegExp(`^${input.cycleId}:[1-9][0-9]*$`).test(input.eventId)) {
    throw new Error("Improvement notification coordinates are invalid.");
  }
  if (held && (!["ready_for_release","releasing"].includes(input.stage) || !/^[a-z0-9_]{1,120}$/.test(input.category ?? ""))) {
    throw new Error("Improvement hold coordinates are invalid.");
  }
  const evidence = await sql`SELECT event.at,clock_timestamp() AS now FROM omni_events event
    JOIN omni_self_improvement_cycles cycle ON cycle.id=${input.cycleId} AND cycle.tenant_id=event.tenant_id AND cycle.owner_actor_id=event.actor_id
    WHERE event.id=${input.eventId} AND event.tenant_id=${input.tenantId} AND event.actor_id=${input.actorId}
      AND event.type=${eventType} AND event.payload->>'cycleId'=${input.cycleId}
      AND event.payload->>'stage'=${input.stage} AND cycle.stage=${input.stage}
      AND (${!held} OR (event.payload->>'category'=${input.category ?? null}
        AND cycle.controller_hold->>'category'=event.payload->>'category'
        AND (cycle.controller_hold->>'occurredAt')::timestamptz=event.at))
      AND event.at > clock_timestamp()-interval '7 days' FOR SHARE OF cycle`;
  if (evidence.length !== 1) return { state: "superseded" as const, notificationId: null };
  const now = new Date(evidence[0].now as string | Date).toISOString();
  const occurredAt = new Date(evidence[0].at as string | Date).toISOString();
  const preferences = await findActiveNotificationOwnerPreferencesWithSql(sql, input.tenantId, input.actorId);
  if (!preferences?.notificationsEnabled) return { state: "disabled" as const, notificationId: null };
  const accounts = await sql`SELECT email FROM omni_auth_users WHERE actor_id=${input.actorId} AND status='active' FOR SHARE`;
  if (accounts.length !== 1 || typeof accounts[0].email !== "string") throw new Error("The improvement notification owner is unavailable.");
  const transportActorId = accounts[0].email;
  const coordinates = { tenantId: input.tenantId, actorId: input.actorId, sourceKind: "self_improvement" as const,
    sourceId: input.cycleId, occurrenceKey: input.eventId };
  const decision = decideServerNotification({ candidate: selfImprovementNotificationCandidate(coordinates), policy: {
    evaluatedAt: now, quietHoursActive: isQuietHoursActive(preferences, new Date(now)), cooldownActive: false, digestEnabled: false,
  } });
  const scope = (actorId: string) => notificationDecisionExecutionScope({ ...input, actorId, sourceId: input.cycleId, producerId: "self-improvement-alert", decision });
  const id = `notification_${canonicalJsonSha256(coordinates).slice(0,48)}`;
  const result = await applyNotificationDispositionDecision({ sql, now: new Date(now), decision, executionScope: scope(input.actorId),
    coordinates: notificationDispositionCoordinates({ ...coordinates, ownerActorId: input.actorId, decision }),
    directDelivery: async deliverySql => {
      await deliverySql`INSERT INTO omni_personal_notifications
        (id,tenant_id,actor_id,title,kind,source_type,source_id,occurrence_key,urgency,status,due_at,created_at,updated_at)
        VALUES (${id},${input.tenantId},${input.actorId},${title},'self_improvement','self_improvement',${input.cycleId},${input.eventId},'update','unread',${occurredAt},${now},${now})
        ON CONFLICT (tenant_id,actor_id,source_type,source_id,occurrence_key) DO NOTHING`;
      const saved = await deliverySql`SELECT id FROM omni_personal_notifications WHERE id=${id} AND tenant_id=${input.tenantId}
        AND actor_id=${input.actorId} AND kind='self_improvement' AND source_type='self_improvement'
        AND source_id=${input.cycleId} AND occurrence_key=${input.eventId}`;
      if (saved.length !== 1) throw new Error("Improvement inbox confirmation is unavailable.");
      await enqueueMobilePush({ tenantId: input.tenantId, actorId: transportActorId, target: { kind: "notification", id },
        occurrenceKey: input.eventId, notificationId: id, minimumClientContractVersion: SELF_IMPROVEMENT_NOTIFICATION_MIN_NATIVE_VERSION,
        executionScope: scope(transportActorId), sql: deliverySql });
      await enqueueBrowserSelfImprovementPush(deliverySql, input, id, input.eventId, new Date(Date.parse(occurredAt)+7*86_400_000).toISOString());
      return { deliveryKind: "notification_ledger", deliveryIds: [id], targetSha256: canonicalJsonSha256({ ...coordinates, notificationId: id }) };
    },
  });
  return { state: result.record.state === "terminal" ? "recorded" as const : "held" as const,
    notificationId: result.record.deliveryKind === "notification_ledger" ? id : null };
}

/** Retry exact deferred occurrences after quiet hours, without running a cycle again. */
export async function processDueSelfImprovementNotificationsForTenant(input: { tenantId: string; deadlineAt: number; limit?: number }) {
  if (!hasDatabaseUrl()) return { processed: 0 };
  await ensureDatabaseSchema();
  const rows = await runWithDatabaseSystemScope("Enumerate bounded deferred self-improvement notification coordinates.", () => getSql()`
    SELECT disposition.owner_actor_id,disposition.source_id,disposition.occurrence_key FROM omni_notification_dispositions disposition
    JOIN omni_events event ON event.id=disposition.occurrence_key AND event.tenant_id=disposition.tenant_id AND event.actor_id=disposition.owner_actor_id
    JOIN omni_self_improvement_cycles cycle ON cycle.id=disposition.source_id AND cycle.tenant_id=disposition.tenant_id AND cycle.owner_actor_id=disposition.owner_actor_id
    WHERE disposition.tenant_id=${input.tenantId} AND disposition.source_kind='self_improvement' AND disposition.state='pending'
      AND disposition.due_at<=clock_timestamp() AND event.type IN ('self_improvement.cycle.updated','self_improvement.release.held')
      AND event.payload->>'stage'=cycle.stage AND event.at>clock_timestamp()-interval '7 days'
      AND (event.type='self_improvement.cycle.updated' OR (cycle.controller_hold->>'category'=event.payload->>'category'
        AND (cycle.controller_hold->>'occurredAt')::timestamptz=event.at))
    ORDER BY disposition.due_at,disposition.id LIMIT ${Math.max(1, Math.min(10,input.limit || 5))}`);
  let processed=0;
  for (const row of rows) {
    if (Date.now()+2_000>=input.deadlineAt) break;
    await withAvailabilityOwner({ tenantId: input.tenantId, actorId: String(row.owner_actor_id) }, async (sql: SqlClient) => {
      const events = await sql`SELECT payload,at,type FROM omni_events WHERE tenant_id=${input.tenantId} AND actor_id=${row.owner_actor_id}
        AND id=${row.occurrence_key} AND type IN ('self_improvement.cycle.updated','self_improvement.release.held')`;
      if (events.length !== 1) return;
      await admitSelfImprovementNotificationWithSql(sql, { tenantId: input.tenantId, actorId: String(row.owner_actor_id),
        cycleId: String(row.source_id), eventId: String(row.occurrence_key), stage: String((events[0].payload as Record<string,unknown>).stage),
        eventType: events[0].type as Admission["eventType"], category: String((events[0].payload as Record<string,unknown>).category ?? ""),
        occurredAt: new Date(events[0].at as string | Date).toISOString() });
    });
    processed++;
  }
  return { processed };
}
