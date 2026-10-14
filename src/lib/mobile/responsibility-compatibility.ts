import type { SecurityContext } from "@/lib/security/types";
import { ResponsibilityError } from "@/lib/responsibilities/state";
import { getResponsibilityDraft } from "@/lib/responsibilities/service";
import { getResponsibilityLifecycle } from "@/lib/responsibilities/lifecycle-service";
import { getResponsibilityNotifications } from "@/lib/responsibilities/notification-service";

/** v55 has a closed meeting-only decoder. Never send it a work-item shape. */
export function needsLegacyResponsibilityContract(context: SecurityContext) {
  return context.source === "mobile" && (context.native?.clientContractVersion ?? 0) < 56;
}

function needsRecoveryContract(context: SecurityContext) {
  return context.source === "mobile" && (context.native?.clientContractVersion ?? 0) < 57;
}

function containsRecoveryShape(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  if (Array.isArray(value)) return value.some(containsRecoveryShape);
  const object = value as Record<string, unknown>;
  if (object.recovery === "reviewed_authority_change" || Object.hasOwn(object, "configurationReceipts") || Object.hasOwn(object, "baselineRebinds") ||
      (Object.hasOwn(object, "expectedRuntimeRevision") && (Object.hasOwn(object, "expectedRevision") || Object.hasOwn(object, "expectedGeneration"))) ||
      (object.action === "enable" && (Object.hasOwn(object, "expectedRevision") || Object.hasOwn(object, "expectedGeneration")))) return true;
  if (hasRepinnedHistory(object)) return true;
  return Object.values(object).some(containsRecoveryShape);
}

function hasRepinnedHistory(value: Record<string, unknown>): boolean {
  if (value.contract !== "asael-responsibility-runtime:1" && value.contract !== "asael-responsibility-notifications:1") return false;
  const record = (item: unknown): Record<string, unknown> | undefined => item && typeof item === "object" && !Array.isArray(item)
    ? item as Record<string, unknown> : undefined;
  const currentHash = record(record(value.current)?.configuration)?.configurationSha256;
  if (typeof currentHash !== "string") return false;
  const receipts = [...(Array.isArray(value.receipts) ? value.receipts : []), ...(value.receipt ? [value.receipt] : [])];
  if (receipts.some((item) => {
    const hash = record(record(record(item)?.snapshot)?.configuration)?.configurationSha256;
    return typeof hash === "string" && hash !== currentHash;
  })) return true;
  const rows = [...(Array.isArray(value.wakes) ? value.wakes : []), ...(Array.isArray(value.candidates) ? value.candidates : [])];
  return rows.some((item) => typeof record(item)?.configurationSha256 === "string" && record(item)?.configurationSha256 !== currentHash);
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
  if (needsRecoveryContract(context) && containsRecoveryShape(value)) {
    throw recoveryUpgradeRequired();
  }
  if (needsLegacyResponsibilityContract(context) && containsWorkItemTracking(value)) {
    throw new ResponsibilityError("Update Asael to view or change work-item tracking.", 409, "responsibility_client_upgrade_required");
  }
  return value;
}

/** Check the current record before a mutation; revision/hash admission still runs in its transaction. */
export async function requireCompatibleResponsibilityRecord(context: SecurityContext, id: string, area: "draft" | "lifecycle" | "notifications" = "draft", mutation?: unknown) {
  if (needsLegacyResponsibilityContract(context)) {
    compatibleResponsibilityValue(context, await getResponsibilityDraft(context, id, false));
  }
  if (needsRecoveryContract(context)) {
    // A draft may change independently after activation. The immutable runtime
    // and notification configurations, not that editable draft, govern effects.
    if (area !== "draft") {
      const lifecycle = compatibleResponsibilityValue(context, await getResponsibilityLifecycle(context, id, false));
      if (area === "lifecycle" && lifecycle.current?.state === "blocked" &&
          mutation && typeof mutation === "object" && "action" in mutation && mutation.action === "resume") throw recoveryUpgradeRequired();
    }
    if (area === "notifications") compatibleResponsibilityValue(context, await getResponsibilityNotifications(context, id, false));
  }
}

function recoveryUpgradeRequired() {
  return new ResponsibilityError("Update Asael to review tracking recovery and its retained history.", 409, "responsibility_client_upgrade_required");
}
