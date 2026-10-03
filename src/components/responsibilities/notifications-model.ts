import type { NotificationAdmission, NotificationConfiguration, NotificationControlRequest, ResponsibilityNotificationCandidate, ResponsibilityNotificationReceipt } from "@/lib/responsibilities/notification-contracts";

// Types only: server validation/storage and Node crypto never enter this client.
export type { NotificationAdmission, NotificationConfiguration, NotificationControlRequest, ResponsibilityNotificationCandidate, ResponsibilityNotificationReceipt };
export const NOTIFICATIONS_CONTRACT = "asael-responsibility-notifications:1";
export type NotificationPreview = { state: "ready"; authorityEffect: "none"; configuration: NotificationConfiguration; expectedRuntimeRevision: number; expectedRuntimeGeneration: number }
  | { state: "blocked"; authorityEffect: "none"; reason: string };
export type NotificationsView = {
  current: NotificationAdmission | null; candidates: ResponsibilityNotificationCandidate[]; receipts: ResponsibilityNotificationReceipt[];
  coverage: { limit: 40; total: null; hasMoreCandidates: boolean; hasMoreReceipts: boolean };
  disclosure: string; externalDelivery: false; preview?: NotificationPreview;
};
export type NotificationsResult = { current: NotificationAdmission; receipt: ResponsibilityNotificationReceipt; replayed: boolean };
