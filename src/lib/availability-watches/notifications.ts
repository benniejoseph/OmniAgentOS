import type { SqlClient } from "@/lib/db/sql-types";
import { notificationDecisionExecutionScope } from "@/lib/mobile/notification-decision-events";
import { availabilityWatchNotificationCandidate, decideServerNotification, notificationDispositionCoordinates } from "@/lib/mobile/notification-delivery-policy";
import { applyNotificationDispositionDecision } from "@/lib/mobile/notification-disposition-store";
import { findActiveNotificationOwnerPreferencesWithSql } from "@/lib/mobile/notification-owner";
import { mobilePushProviderConfiguration } from "@/lib/mobile/push-providers";
import { enqueueMobilePush } from "@/lib/mobile/push-store";
import { isQuietHoursActive } from "@/lib/today/notifications";
import { canonicalJsonSha256 } from "@/lib/tools/effect-receipt";

export type AvailabilityWatchNotificationAdmission = {
  notificationId: string | null;
  dispositionId: string | null;
  pushDeliveryIds: string[];
  state: "held" | "disabled" | "recorded";
  nextAttemptAt: string | null;
};
type Owner = { tenantId: string; actorId: string };
type Opening = Owner & {
  watchId: string; generation: number; openingId: string; observedAt: string;
  title: string; expiresAt: string; now?: string;
};

/** Caller holds the current watch row, revalidated its generation and opening,
 * and will co-commit the returned linkage with that exact aggregate. */
export async function admitAvailabilityWatchOpeningWithSql(sql: SqlClient, input: Opening): Promise<AvailabilityWatchNotificationAdmission> {
  if (!sql.transactionScoped || !/^watch_[a-f0-9]{48}$/.test(input.watchId) ||
    !/^availability-opening:[a-f0-9]{64}$/.test(input.openingId) ||
    !/^actor:[a-f0-9-]{36}$/.test(input.actorId) || !Number.isSafeInteger(input.generation) || input.generation < 1) {
    throw new Error("Watch notification coordinates are invalid.");
  }
  const clock = await sql`SELECT clock_timestamp() AS now`;
  const now = new Date(clock[0].now as string | Date).toISOString();
  if (!Number.isFinite(Date.parse(input.expiresAt)) || input.expiresAt <= now) throw new Error("Watch delivery has expired.");
  const retryAt = new Date(Math.min(Date.parse(input.expiresAt), Date.parse(now) + 60_000)).toISOString();
  const preferences = await findActiveNotificationOwnerPreferencesWithSql(sql, input.tenantId, input.actorId);
  if (!preferences?.notificationsEnabled) return {
    state: "disabled", notificationId: null, dispositionId: null, pushDeliveryIds: [], nextAttemptAt: retryAt,
  };
  const accounts = await sql`SELECT email FROM omni_auth_users WHERE actor_id = ${input.actorId} AND status = 'active' FOR SHARE`;
  const transportActorId = accounts[0]?.email;
  if (accounts.length !== 1 || typeof transportActorId !== "string") throw new Error("The current watch delivery account is unavailable.");
  const coordinates = { tenantId: input.tenantId, actorId: input.actorId, sourceKind: "availability_watch" as const,
    sourceId: input.watchId, occurrenceKey: input.openingId };
  const decision = decideServerNotification({ candidate: availabilityWatchNotificationCandidate(coordinates), policy: {
    evaluatedAt: now, quietHoursActive: isQuietHoursActive(preferences, new Date(now)), cooldownActive: false, digestEnabled: false,
  } });
  const executionScope = notificationDecisionExecutionScope({ ...input, sourceId: input.watchId, producerId: "availability-watch-alert", decision });
  const id = `notification_${canonicalJsonSha256({ tenantId: input.tenantId, actorId: input.actorId, watchId: input.watchId, openingId: input.openingId }).slice(0, 48)}`;
  const disposition = await applyNotificationDispositionDecision({
    coordinates: notificationDispositionCoordinates({ ...coordinates, ownerActorId: input.actorId, decision }),
    decision, executionScope, sql, now: new Date(now),
    directDelivery: async (deliverySql) => {
      const title = input.title.replace(/\s+/g, " ").trim().slice(0, 260);
      await deliverySql`INSERT INTO omni_personal_notifications
        (id,tenant_id,actor_id,title,kind,source_type,source_id,occurrence_key,urgency,status,due_at,created_at,updated_at)
        VALUES (${id},${input.tenantId},${input.actorId},${title},'availability_watch','availability_watch',${input.watchId},${input.openingId},'update','unread',${input.observedAt},${now},${now})
        ON CONFLICT (tenant_id,actor_id,source_type,source_id,occurrence_key) DO NOTHING`;
      const rows = await deliverySql`SELECT id FROM omni_personal_notifications
        WHERE id = ${id} AND tenant_id = ${input.tenantId} AND actor_id = ${input.actorId}
          AND kind = 'availability_watch' AND source_type = 'availability_watch'
          AND source_id = ${input.watchId} AND occurrence_key = ${input.openingId}`;
      if (rows.length !== 1) throw new Error("Watch inbox confirmation is unavailable.");
      await enqueueMobilePush({ tenantId: input.tenantId, actorId: transportActorId, target: { kind: "notification", id },
        occurrenceKey: input.openingId, notificationId: id, minimumClientContractVersion: 60, executionScope: notificationDecisionExecutionScope({ ...input, actorId: transportActorId, sourceId: input.watchId, producerId: "availability-watch-push", decision }), sql: deliverySql });
      return { deliveryKind: "notification_ledger", deliveryIds: [id], targetSha256: canonicalJsonSha256({ ...coordinates, notificationId: id }) };
    },
  });
  if (disposition.record.state !== "terminal") return {
    state: "held", notificationId: null, dispositionId: disposition.record.id, pushDeliveryIds: [], nextAttemptAt: disposition.record.dueAt ?? retryAt,
  };
  if (disposition.record.deliveryKind !== "notification_ledger") throw new Error("Watch delivery confirmation is invalid.");
  const deliveries = await sql`SELECT id FROM omni_mobile_push_deliveries
    WHERE tenant_id = ${input.tenantId} AND owner_actor_id = ${transportActorId} AND notification_id = ${id} ORDER BY id`;
  return { state: "recorded", notificationId: id, dispositionId: disposition.record.id,
    pushDeliveryIds: deliveries.map((row) => String(row.id)), nextAttemptAt: null };
}

/** Stop and expiry preserve historical inbox/receipts and cancel unsent alerts. */
export async function cancelAvailabilityWatchPushWithSql(sql: SqlClient, owner: Owner, watchId: string) {
  if (!sql.transactionScoped) throw new Error("Watch cancellation requires its owner transaction.");
  await sql`UPDATE omni_mobile_push_deliveries AS delivery
    SET status = 'failed', last_error = 'watch_inactive: Watch stopped or expired.', lease_owner = NULL, lease_expires_at = NULL, updated_at = clock_timestamp()
    FROM omni_personal_notifications AS notice
    WHERE notice.id = delivery.notification_id AND notice.tenant_id = ${owner.tenantId}
      AND notice.actor_id = ${owner.actorId} AND notice.source_type = 'availability_watch' AND notice.source_id = ${watchId}
      AND delivery.tenant_id = notice.tenant_id
      AND delivery.owner_actor_id IN (SELECT email FROM omni_auth_users WHERE actor_id = ${owner.actorId}) AND delivery.status IN ('queued','running')`;
}

/** Read-only transport evidence; never describe provider acceptance as receipt. */
export async function readAvailabilityWatchPushStatusWithSql(sql: SqlClient, input: Owner & { watchId: string; openingId: string | null }) {
  const counts = await sql`SELECT
      COUNT(*) FILTER (WHERE delivery.status = 'queued')::int AS queued,
      COUNT(*) FILTER (WHERE delivery.status = 'running')::int AS running,
      COUNT(*) FILTER (WHERE delivery.provider_accepted_at IS NOT NULL)::int AS accepted,
      COUNT(*) FILTER (WHERE delivery.status = 'failed')::int AS failed,
      COUNT(*) FILTER (WHERE EXISTS (SELECT 1 FROM omni_mobile_push_delivery_receipts receipt
        WHERE receipt.tenant_id = delivery.tenant_id AND receipt.owner_actor_id = delivery.owner_actor_id
          AND receipt.delivery_id = delivery.id AND receipt.receipt_kind = 'received'))::int AS received,
      COUNT(*) FILTER (WHERE EXISTS (SELECT 1 FROM omni_mobile_push_delivery_receipts receipt
        WHERE receipt.tenant_id = delivery.tenant_id AND receipt.owner_actor_id = delivery.owner_actor_id
          AND receipt.delivery_id = delivery.id AND receipt.receipt_kind = 'opened'))::int AS opened
    FROM omni_mobile_push_deliveries delivery
    JOIN omni_personal_notifications notice ON notice.id = delivery.notification_id
      AND notice.tenant_id = delivery.tenant_id AND notice.actor_id = ${input.actorId}
    WHERE delivery.tenant_id = ${input.tenantId} AND delivery.owner_actor_id IN (SELECT email FROM omni_auth_users WHERE actor_id = ${input.actorId})
      AND notice.source_type = 'availability_watch' AND notice.source_id = ${input.watchId}
      AND notice.occurrence_key = ${input.openingId}`;
  const devices = await sql`SELECT COUNT(*)::int AS count FROM omni_mobile_push_registrations registration
    JOIN omni_mobile_sessions session ON session.id = registration.mobile_session_id
      AND session.tenant_id = registration.tenant_id AND session.user_id = registration.user_id AND session.device_id = registration.device_id
    WHERE registration.tenant_id = ${input.tenantId} AND registration.owner_actor_id IN (SELECT email FROM omni_auth_users WHERE actor_id = ${input.actorId})
      AND registration.state = 'active' AND session.revoked_at IS NULL AND session.refresh_expires_at > clock_timestamp()
      AND session.client_contract_version >= 60`;
  const row = counts[0] ?? {};
  return { queued: Number(row.queued ?? 0), running: Number(row.running ?? 0), providerAccepted: Number(row.accepted ?? 0),
    received: Number(row.received ?? 0), opened: Number(row.opened ?? 0), failed: Number(row.failed ?? 0),
    eligibleDevices: Number(devices[0]?.count ?? 0), providers: mobilePushProviderConfiguration() };
}
