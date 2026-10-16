import { WatchReadinessSchema, type WatchReadiness } from "./readiness-contracts";
import { AvailabilityWatchIdSchema, AvailabilityWatchError, availabilitySourceUrl, type AvailabilityWatchOwner } from "./contracts";
import { withAvailabilityOwner, readAvailabilityHead, resolveAvailabilityOwner } from "./store";
import { findActiveNotificationOwnerPreferencesWithSql } from "@/lib/mobile/notification-owner";
import { browserPushConfiguration } from "@/lib/web-push/store";
import { mobilePushProviderConfiguration } from "@/lib/mobile/push-providers";

export async function getAvailabilityWatchReadiness(id: string, owner: AvailabilityWatchOwner): Promise<WatchReadiness> {
  AvailabilityWatchIdSchema.parse(id);
  return withAvailabilityOwner(owner,async sql => {
    await resolveAvailabilityOwner(sql,owner);
    const head = await readAvailabilityHead(sql,owner,id,false);
    if (!head) throw new AvailabilityWatchError("This watch is unavailable in your account.",404,"availability_watch_not_found");
    const preferences = await findActiveNotificationOwnerPreferencesWithSql(sql,owner.tenantId,owner.actorId);
    const android = await sql`SELECT COUNT(*) FILTER (WHERE session.client_contract_version >= 60)::int AS eligible,
      COUNT(*) FILTER (WHERE COALESCE(session.client_contract_version,0) < 60)::int AS needs_update
      FROM omni_mobile_push_registrations registration JOIN omni_mobile_sessions session ON session.id = registration.mobile_session_id
        AND session.tenant_id = registration.tenant_id AND session.user_id = registration.user_id AND session.device_id = registration.device_id
      JOIN omni_auth_users account ON account.email = registration.owner_actor_id
      WHERE registration.tenant_id = ${owner.tenantId} AND account.actor_id = ${owner.actorId} AND registration.state = 'active'
        AND registration.provider = 'fcm' AND session.revoked_at IS NULL AND session.refresh_expires_at > clock_timestamp()`;
    const browsers = await sql`SELECT COUNT(*)::int AS eligible FROM omni_web_push_registrations registration
      JOIN omni_auth_sessions session ON session.id = registration.session_id AND session.user_id = registration.user_id AND session.tenant_id = registration.tenant_id
      WHERE registration.tenant_id = ${owner.tenantId} AND registration.actor_id = ${owner.actorId} AND registration.state = 'active' AND session.expires_at > clock_timestamp()`;
    const receipts = await sql`SELECT COUNT(*) FILTER (WHERE delivery.state IN ('queued','running'))::int AS queued,
      COUNT(*) FILTER (WHERE delivery.accepted_at IS NOT NULL)::int AS accepted,COUNT(*) FILTER (WHERE delivery.received_at IS NOT NULL)::int AS received,
      COUNT(*) FILTER (WHERE delivery.opened_at IS NOT NULL)::int AS opened,COUNT(*) FILTER (WHERE delivery.state = 'failed')::int AS failed
      FROM omni_web_push_deliveries delivery JOIN omni_personal_notifications notice ON notice.id = delivery.notification_id
        AND notice.tenant_id = delivery.tenant_id AND notice.actor_id = delivery.actor_id
      WHERE delivery.tenant_id = ${owner.tenantId} AND delivery.actor_id = ${owner.actorId} AND notice.source_type = 'availability_watch'
        AND notice.source_id = ${id} AND notice.occurrence_key = ${head.watch.openingId}`;
    const watch = head.watch;
    return WatchReadinessSchema.parse({ schemaVersion:1,sourceUrl:availabilitySourceUrl(watch.config),
      method:"Asael's server scheduler reads the public District cinema page for the selected date, then matches the exact movie, language, seating, showtime and available seats. Atlas can delegate review to its agents. No browser or AI model stays running between checks.",
      schedule:`A check is scheduled every ${watch.config.intervalMinutes} minute(s). Scheduler and source delays can extend that interval; this is periodic checking, not an instant feed.`,
      checking:["active","degraded"].includes(watch.state) ? head.pendingCheckId ? "queued" : "scheduled" : "stopped",
      notificationsEnabled:preferences?.notificationsEnabled === true,inbox:preferences?.notificationsEnabled ? "ready" : "disabled",
      alertPolicy:"Booking openings are time-sensitive: one alert bypasses Asael quiet hours, while notifications-off and device permissions still apply.",
      android:{ eligible:Number(android[0]?.eligible ?? 0),needsUpdate:Number(android[0]?.needs_update ?? 0),configured:mobilePushProviderConfiguration().fcm === "configured" },
      browser:{ eligible:Number(browsers[0]?.eligible ?? 0),configured:browserPushConfiguration().configured,
        ...Object.fromEntries(["queued","accepted","received","opened","failed"].map(key => [key,Number(receipts[0]?.[key] ?? 0)])) },
      limitations:["Only this District cinema page is checked; BookMyShow and PVR's own website are not checked.",
        "Source failures are reported as unknown, not as closed booking.","Android needs an eligible signed-in app and notification permission. Browser alerts need this browser's permission and an active Asael sign-in.",
        "OS Do Not Disturb, connectivity and push provider delays can postpone a device alert. This Mac build receives local alerts only while Asael is open."] });
  });
}
