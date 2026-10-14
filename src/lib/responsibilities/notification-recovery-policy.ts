import type { NotificationConfiguration } from "./notification-contracts";

/** Re-review can replace authority pins, never the destination or allowance. */
export function sameNotificationScope(previous: NotificationConfiguration, next: NotificationConfiguration): boolean {
  return previous.schemaVersion === next.schemaVersion && previous.tenantId === next.tenantId && previous.actorId === next.actorId &&
    previous.responsibilityId === next.responsibilityId && previous.policy === next.policy && previous.draftSha256 === next.draftSha256 &&
    previous.destination === next.destination && previous.quietOnNoChange === next.quietOnNoChange &&
    previous.maximumNotifications === next.maximumNotifications && previous.expiresAt === next.expiresAt &&
    previous.source.kind === next.source.kind && previous.source.id === next.source.id && previous.source.workspaceId === next.source.workspaceId &&
    (previous.source.kind !== "work_item" || next.source.kind === "work_item" && previous.source.projectId === next.source.projectId);
}

export function isLaterNotificationReview(previous: NotificationConfiguration, next: NotificationConfiguration): boolean {
  return sameNotificationScope(previous, next) && next.responsibilityRevision > previous.responsibilityRevision &&
    next.reviewSha256 !== previous.reviewSha256 && next.runtimeConfigurationSha256 !== previous.runtimeConfigurationSha256 &&
    next.configurationSha256 !== previous.configurationSha256;
}
