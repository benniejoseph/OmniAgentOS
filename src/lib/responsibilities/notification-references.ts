import type { SqlClient } from "@/lib/db/sql-types";
import { canonicalRequestActorBindingFromSecurityContext } from "@/lib/security/canonical-actor";
import type { SecurityContext } from "@/lib/security/types";
import { findTodayNotificationPreferencesWithSql } from "@/lib/today/briefs";
import type { ResponsibilityRecord } from "./contracts";
import type { ResponsibilityLifecycle } from "./runtime-contracts";
import { assertSamePilot, resolveResponsibilityPilot, resolveRuntimeOwnerContext } from "./runtime-references";
import { ResponsibilityError, type ResponsibilityOwner } from "./state";

/** Revalidates only the reviewed native Meeting lane. The current source may
 * have advanced; an older pending change still names its own immutable proof.
 * This read neither creates preferences nor grants a push/provider destination. */
export async function resolveNotificationReferences(sql: SqlClient, owner: ResponsibilityOwner, record: ResponsibilityRecord, runtime: ResponsibilityLifecycle, now: string,
  expectedContext: SecurityContext) {
  const resolved = await resolveResponsibilityPilot(sql, owner, record, now, false);
  assertSamePilot(resolved.configuration, runtime.configuration);
  if (resolved.context.actorId !== expectedContext.actorId) throw new ResponsibilityError("The current destination account changed.", 409, "responsibility_notification_destination_unavailable");
  const binding = canonicalRequestActorBindingFromSecurityContext(resolved.context);
  if (!binding || binding.canonicalActorId !== owner.actorId) throw new ResponsibilityError("The in-app destination is unavailable.", 403, "responsibility_notification_destination_unavailable");
  const preferences = await findTodayNotificationPreferencesWithSql(sql, { tenantId: owner.tenantId, actorId: resolved.context.actorId, requestActorBinding: binding });
  if (!preferences) throw new ResponsibilityError("Save notification preferences before enabling in-app updates.", 409, "responsibility_notification_preferences_unavailable");
  if (!preferences.notificationsEnabled) throw new ResponsibilityError("In-app notifications are disabled in your saved preferences.", 409, "responsibility_notification_notifications_disabled");
  return { ...resolved, preferences, binding };
}
export { resolveRuntimeOwnerContext as resolveNotificationOwnerContext };
