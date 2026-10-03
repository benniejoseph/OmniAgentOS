import { canonicalJsonSha256 } from "@/lib/tools/effect-receipt";
import { instantSchema, type ResponsibilityRecord } from "./contracts";
import { verifyLifecycle } from "./lifecycle-state";
import { responsibilityChangeRecordSchema, type ResponsibilityChangeRecord } from "./observation-contracts";
import { type ResponsibilityLifecycle } from "./runtime-contracts";
import { idempotencySha256, ResponsibilityError, storageInvalid } from "./state";
import {
  notificationAdmissionSchema, notificationCandidateSchema, notificationConfigurationSchema, notificationEnableRequestSchema, notificationReceiptSchema,
  RESPONSIBILITY_NOTIFICATION_CONTRACT, RESPONSIBILITY_NOTIFICATION_MAX_AGE_MS, RESPONSIBILITY_NOTIFICATION_POLICY, RESPONSIBILITY_NOTIFICATION_RETRY_MS,
  type NotificationAdmission, type NotificationCandidateReason, type NotificationConfiguration, type ResponsibilityNotificationCandidate, type ResponsibilityNotificationReceipt,
} from "./notification-contracts";

export function verifyNotificationConfiguration(value: unknown): NotificationConfiguration {
  const configuration = notificationConfigurationSchema.parse(value); const { configurationSha256, ...body } = configuration;
  if (configurationSha256 !== canonicalJsonSha256(body)) throw storageInvalid();
  return configuration;
}
export function verifyNotificationAdmission(value: unknown): NotificationAdmission {
  const head = notificationAdmissionSchema.parse(value); const configuration = verifyNotificationConfiguration(head.configuration);
  if (head.tenantId !== configuration.tenantId || head.actorId !== configuration.actorId || head.responsibilityId !== configuration.responsibilityId ||
    head.used + head.reserved > configuration.maximumNotifications || head.enabledAt > head.updatedAt ||
    ((head.state === "ended" || head.state === "paused") && head.reserved !== 0)) throw storageInvalid();
  return head;
}
export const pendingNotificationCandidate = (candidate: ResponsibilityNotificationCandidate) => candidate.state === "pending" || candidate.state === "held";
export function notificationCandidateId(value: Pick<ResponsibilityNotificationCandidate, "tenantId" | "actorId" | "responsibilityId" | "changeId" | "changeSha256">) {
  return `responsibility-notification:${canonicalJsonSha256([value.tenantId, value.actorId, value.responsibilityId, value.changeId, value.changeSha256, "owner_in_app"])}`;
}
export function verifyNotificationCandidate(value: unknown): ResponsibilityNotificationCandidate {
  const candidate = notificationCandidateSchema.parse(value); const pending = pendingNotificationCandidate(candidate); const delivered = candidate.state === "delivered";
  if (candidate.id !== notificationCandidateId(candidate) || candidate.updatedAt < candidate.createdAt || candidate.expiresAt <= candidate.createdAt ||
    pending !== (candidate.terminalAt === null) || pending !== (candidate.nextAttemptAt !== null) ||
    (candidate.nextAttemptAt !== null && (candidate.nextAttemptAt < candidate.updatedAt || candidate.nextAttemptAt > candidate.expiresAt)) ||
    (candidate.terminalAt !== null && candidate.terminalAt !== candidate.updatedAt) ||
    delivered !== (candidate.notificationId !== null) || delivered !== (candidate.deliveryBindingSha256 !== null) ||
    (delivered && (candidate.dispositionId === null || candidate.reason !== "in_app_recorded"))) throw storageInvalid();
  return candidate;
}
export function buildNotificationConfiguration(record: ResponsibilityRecord, runtimeValue: ResponsibilityLifecycle, now: string): NotificationConfiguration {
  const runtime = verifyLifecycle(runtimeValue); instantSchema.parse(now);
  if (runtime.state !== "active" || runtime.configuration.cadence.expiresAt <= now || record.state !== "reviewed" || !record.review ||
    record.tenantId !== runtime.tenantId || record.actorId !== runtime.actorId || record.id !== runtime.responsibilityId ||
    record.revision !== runtime.configuration.responsibilityRevision || record.review.reviewSha256 !== runtime.configuration.reviewSha256 ||
    record.draftSha256 !== runtime.configuration.draftSha256 || !record.draft.notificationRule || !record.draft.limits?.maxNotifications) throw notificationConflict("responsibility_notification_not_ready");
  const body = { schemaVersion: 1 as const, tenantId: runtime.tenantId, actorId: runtime.actorId, responsibilityId: runtime.responsibilityId,
    policy: RESPONSIBILITY_NOTIFICATION_POLICY, runtimeConfigurationSha256: runtime.configuration.configurationSha256,
    responsibilityRevision: record.revision, reviewSha256: record.review.reviewSha256, draftSha256: record.draftSha256, source: runtime.configuration.source,
    destination: "owner_in_app" as const, quietOnNoChange: true as const, maximumNotifications: record.draft.limits.maxNotifications, expiresAt: runtime.configuration.cadence.expiresAt };
  return verifyNotificationConfiguration({ ...body, configurationSha256: canonicalJsonSha256(body) });
}
export function enableNotificationAdmission(configurationValue: NotificationConfiguration, runtime: ResponsibilityLifecycle, requestValue: unknown, now: string): NotificationAdmission {
  const configuration = verifyNotificationConfiguration(configurationValue); const request = notificationEnableRequestSchema.parse(requestValue); instantSchema.parse(now);
  if (runtime.state !== "active" || runtime.revision !== request.expectedRuntimeRevision || runtime.generation !== request.expectedRuntimeGeneration ||
    configuration.configurationSha256 !== request.configurationSha256 || configuration.runtimeConfigurationSha256 !== runtime.configuration.configurationSha256 || configuration.expiresAt <= now) throw notificationConflict("responsibility_notification_preview_changed");
  return verifyNotificationAdmission({ schemaVersion: 1, contract: RESPONSIBILITY_NOTIFICATION_CONTRACT, tenantId: configuration.tenantId, actorId: configuration.actorId,
    responsibilityId: configuration.responsibilityId, revision: 1, generation: 1, state: "enabled", reason: "owner_enabled", configuration, used: 0, reserved: 0, enabledAt: now, updatedAt: now });
}
export function admitNotificationCandidate(headValue: NotificationAdmission, changeValue: ResponsibilityChangeRecord, freshUntil: string, now: string) {
  const head = verifyNotificationAdmission(headValue); const change = responsibilityChangeRecordSchema.parse(changeValue); instantSchema.parse(freshUntil); instantSchema.parse(now);
  const { changeSha256, ...changeBody } = change;
  if (canonicalJsonSha256(changeBody) !== changeSha256 || change.target.tenantId !== head.tenantId || change.target.actorId !== head.actorId ||
    change.target.responsibilityId !== head.responsibilityId || change.target.reviewSha256 !== head.configuration.reviewSha256 || change.target.responsibilityRevision !== head.configuration.responsibilityRevision) throw storageInvalid();
  if (head.state !== "enabled" || head.configuration.expiresAt <= now || freshUntil <= now || now < head.enabledAt) throw notificationConflict("responsibility_notification_admission_closed");
  const expiresAt = new Date(Math.min(Date.parse(freshUntil), Date.parse(head.configuration.expiresAt), Date.parse(now) + RESPONSIBILITY_NOTIFICATION_MAX_AGE_MS)).toISOString();
  const body = { schemaVersion: 1 as const, tenantId: head.tenantId, actorId: head.actorId, responsibilityId: head.responsibilityId,
    changeId: change.id, changeSha256, configurationSha256: head.configuration.configurationSha256, generation: head.generation, revision: 1,
    state: "pending" as const, reason: "material_change" as const, attempts: 0, expiresAt, nextAttemptAt: now,
    notificationId: null, dispositionId: null, deliveryBindingSha256: null, createdAt: now, updatedAt: now, terminalAt: null };
  const limited = head.used + head.reserved >= head.configuration.maximumNotifications;
  const candidate = verifyNotificationCandidate({ ...body, id: notificationCandidateId(body), ...(limited ? { state: "blocked", reason: "notification_limit", nextAttemptAt: null, terminalAt: now } : {}) });
  return { current: verifyNotificationAdmission({ ...head, revision: head.revision + 1, reserved: head.reserved + (limited ? 0 : 1), updatedAt: now }), candidate };
}
export function transitionNotificationCandidate(headValue: NotificationAdmission, previousValue: ResponsibilityNotificationCandidate, input: {
  now: string; outcome: "hold" | "retry" | "deliver" | "cancel" | "block" | "expire"; reason: NotificationCandidateReason;
  delivery?: { notificationId: string; dispositionId: string; deliveryBindingSha256: string }; dispositionId?: string;
}) {
  const head = verifyNotificationAdmission(headValue); const previous = verifyNotificationCandidate(previousValue); const now = instantSchema.parse(input.now);
  if (!pendingNotificationCandidate(previous) || head.tenantId !== previous.tenantId || head.actorId !== previous.actorId || head.responsibilityId !== previous.responsibilityId ||
    head.configuration.configurationSha256 !== previous.configurationSha256 || head.reserved < 1 || now < previous.updatedAt) throw storageInvalid();
  const retry = input.outcome === "hold" || input.outcome === "retry"; const delivered = input.outcome === "deliver";
  if (delivered && (!input.delivery || previous.generation !== head.generation || !["enabled", "draining"].includes(head.state) || now >= previous.expiresAt)) throw notificationConflict("responsibility_notification_fenced");
  if (!delivered && input.delivery) throw storageInvalid();
  const expired = retry && (now >= previous.expiresAt || previous.attempts >= 99);
  const candidate = verifyNotificationCandidate({ ...previous, revision: previous.revision + 1, attempts: Math.min(100, previous.attempts + 1),
    state: expired || input.outcome === "expire" ? "expired" : retry ? "held" : delivered ? "delivered" : input.outcome === "cancel" ? "canceled" : "blocked",
    reason: expired ? "expired" : input.reason,
    nextAttemptAt: retry && !expired ? new Date(Math.min(Date.parse(previous.expiresAt), Date.parse(now) + RESPONSIBILITY_NOTIFICATION_RETRY_MS)).toISOString() : null,
    dispositionId: input.delivery?.dispositionId ?? input.dispositionId ?? previous.dispositionId,
    notificationId: input.delivery?.notificationId ?? null, deliveryBindingSha256: input.delivery?.deliveryBindingSha256 ?? null,
    updatedAt: now, terminalAt: retry && !expired ? null : now });
  return { current: verifyNotificationAdmission({ ...head, revision: head.revision + 1, reserved: head.reserved - (pendingNotificationCandidate(candidate) ? 0 : 1),
    used: head.used + (delivered ? 1 : 0), updatedAt: now }), candidate };
}
/** Checks may finish while a finite already-admitted inbox delivery drains.
 * Explicit stops invalidate the delivery generation; canceled rows never reopen. */
export function notificationLifecycleTarget(head: NotificationAdmission, runtime: ResponsibilityLifecycle, now: string): { state: NotificationAdmission["state"]; reason: NotificationAdmission["reason"]; cancelReason: NotificationCandidateReason | null } {
  if (head.configuration.expiresAt <= now) return { state: "ended", reason: "expired", cancelReason: "expired" };
  if (runtime.state === "ended" && runtime.reason === "budget_exhausted") return { state: "draining", reason: "checks_exhausted", cancelReason: null };
  if (runtime.state === "active") return { state: "enabled", reason: head.state === "paused" ? "runtime_resumed" : head.reason, cancelReason: null };
  if (runtime.state === "pausing" || runtime.state === "paused") return { state: "paused", reason: "runtime_paused", cancelReason: "owner_paused" };
  return { state: "ended", reason: runtime.state === "blocked" ? "runtime_blocked" : "runtime_ended", cancelReason: runtime.state === "blocked" ? "runtime_blocked" : "owner_ended" };
}
export function buildNotificationReceipt(input: { previous: NotificationAdmission | null; current: NotificationAdmission; candidate?: ResponsibilityNotificationCandidate;
  key: string; request: unknown; action: ResponsibilityNotificationReceipt["action"] }) {
  const snapshot = verifyNotificationAdmission(input.current); const key = idempotencySha256(input.key);
  const body = { schemaVersion: 1 as const, id: `responsibility-notification-receipt:${canonicalJsonSha256([snapshot.tenantId, snapshot.actorId, key])}`,
    idempotencySha256: key, requestSha256: canonicalJsonSha256(input.request), previousRevision: input.previous?.revision ?? 0, action: input.action,
    snapshot, candidate: input.candidate ? verifyNotificationCandidate(input.candidate) : null, savedAt: snapshot.updatedAt, contentIncluded: false as const };
  return verifyNotificationReceipt({ ...body, receiptSha256: canonicalJsonSha256(body) });
}
export function verifyNotificationReceipt(value: unknown): ResponsibilityNotificationReceipt {
  const receipt = notificationReceiptSchema.parse(value); const { receiptSha256, ...body } = receipt;
  verifyNotificationAdmission(receipt.snapshot); if (receipt.candidate) verifyNotificationCandidate(receipt.candidate);
  if (receiptSha256 !== canonicalJsonSha256(body) || receipt.snapshot.revision !== receipt.previousRevision + 1 || receipt.savedAt !== receipt.snapshot.updatedAt ||
    ["enable", "stop", "lifecycle"].includes(receipt.action) !== (receipt.candidate === null) ||
    receipt.id !== `responsibility-notification-receipt:${canonicalJsonSha256([receipt.snapshot.tenantId, receipt.snapshot.actorId, receipt.idempotencySha256])}` ||
    (receipt.candidate && (receipt.candidate.tenantId !== receipt.snapshot.tenantId || receipt.candidate.actorId !== receipt.snapshot.actorId ||
      receipt.candidate.responsibilityId !== receipt.snapshot.responsibilityId || receipt.candidate.configurationSha256 !== receipt.snapshot.configuration.configurationSha256 ||
      receipt.candidate.generation !== receipt.snapshot.generation || receipt.candidate.updatedAt !== receipt.savedAt))) throw storageInvalid();
  return receipt;
}
export function notificationConflict(code: string) { return new ResponsibilityError("The exact in-app notification admission changed or is unavailable.", 409, code); }
