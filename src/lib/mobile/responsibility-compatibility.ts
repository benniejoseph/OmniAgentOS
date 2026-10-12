import type { SecurityContext } from "@/lib/security/types";
import { ResponsibilityError } from "@/lib/responsibilities/state";
import { getResponsibilityDraft } from "@/lib/responsibilities/service";
import { getResponsibilityLifecycle } from "@/lib/responsibilities/lifecycle-service";
import { getResponsibilityNotifications } from "@/lib/responsibilities/notification-service";

/** v47 has a closed meeting-only decoder. Never send it a work-item shape. */
export function needsLegacyResponsibilityContract(context: SecurityContext) {
  return context.source === "mobile" && (context.native?.clientContractVersion ?? 0) < 48;
}

function containsWorkItemTracking(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  if (Array.isArray(value)) return value.some(containsWorkItemTracking);
  const object = value as Record<string, unknown>;
  if (object.kind === "work_item" || object.pilot === "canonical_work_item_followthrough_v1" ||
      object.acknowledgePilot === "canonical_work_item_followthrough_v1" ||
      object.id === "responsibility-work-item-comparison:1") return true;
  return Object.values(object).some(containsWorkItemTracking);
}

export function compatibleResponsibilityValue<T>(context: SecurityContext, value: T): T {
  if (needsLegacyResponsibilityContract(context) && containsWorkItemTracking(value)) {
    throw new ResponsibilityError("Update Asael to view or change work-item tracking.", 409, "responsibility_client_upgrade_required");
  }
  return value;
}

/** Check the current record before a mutation; revision/hash admission still runs in its transaction. */
export async function requireCompatibleResponsibilityRecord(context: SecurityContext, id: string, area: "draft" | "lifecycle" | "notifications" = "draft") {
  if (needsLegacyResponsibilityContract(context)) {
    compatibleResponsibilityValue(context, await getResponsibilityDraft(context, id, false));
    // A draft may change independently after activation. The immutable runtime
    // and notification configurations, not that editable draft, govern effects.
    if (area !== "draft") compatibleResponsibilityValue(context, await getResponsibilityLifecycle(context, id, false));
    if (area === "notifications") compatibleResponsibilityValue(context, await getResponsibilityNotifications(context, id, false));
  }
}
