import { object, responsibilityId, sha256 } from "./client";
import { sameJson, type Owner } from "./model";
import { NOTIFICATIONS_CONTRACT, type NotificationAdmission, type NotificationConfiguration, type NotificationControlRequest, type NotificationsResult, type NotificationsView, type ResponsibilityNotificationCandidate, type ResponsibilityNotificationReceipt } from "./notifications-model";

const fail = (): never => { throw new Error("The in-app notification response could not be verified for this responsibility and account. Refresh before continuing."); };
const text = (value: unknown, maximum = 240): value is string => typeof value === "string" && value.length > 0 && value.length <= maximum && value.trim() === value;
const integer = (value: unknown, maximum = Number.MAX_SAFE_INTEGER - 1): value is number => Number.isSafeInteger(value) && Number(value) >= 0 && Number(value) <= maximum;
const revision = (value: unknown): value is number => integer(value) && value > 0;
const digest = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const date = (value: unknown): value is string => text(value) && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
const member = (value: unknown, choices: readonly string[]) => typeof value === "string" && choices.includes(value);
const keys = (value: Record<string, unknown>, required: string, optional = "") => required.split(" ").every((key) => Object.hasOwn(value, key)) && Object.keys(value).every((key) => `${required} ${optional}`.split(" ").includes(key));
const exactId = (value: unknown): value is string => text(value) && /^[A-Za-z0-9][A-Za-z0-9._:@/+~-]*$/.test(value);
const owned = (value: Record<string, unknown>, owner: Owner, id: string) => value.tenantId === owner.tenantId && typeof value.actorId === "string" && /^actor:[a-f0-9-]{36}$/.test(value.actorId) && (!owner.actorId || value.actorId === owner.actorId) && value.responsibilityId === id && responsibilityId(id);
const envelope = (value: unknown): value is Record<string, unknown> => object(value) && value.schemaVersion === 1 && value.contract === NOTIFICATIONS_CONTRACT && value.externalDelivery === false && text(value.disclosure, 4000);
const nullableId = (value: unknown, expression: RegExp) => value === null || typeof value === "string" && expression.test(value);

async function configuration(value: unknown, owner: Owner, id: string): Promise<NotificationConfiguration> {
  if (!object(value) || !keys(value, "schemaVersion tenantId actorId responsibilityId policy runtimeConfigurationSha256 responsibilityRevision reviewSha256 draftSha256 source destination quietOnNoChange maximumNotifications expiresAt configurationSha256") || value.schemaVersion !== 1 || !owned(value, owner, id) ||
    value.policy !== "owner_in_app_material_change_v1" || !digest(value.runtimeConfigurationSha256) || !revision(value.responsibilityRevision) || !digest(value.reviewSha256) || !digest(value.draftSha256) ||
    !object(value.source) || !keys(value.source, "kind id workspaceId") || value.source.kind !== "meeting" || !exactId(value.source.id) || !exactId(value.source.workspaceId) ||
    value.destination !== "owner_in_app" || value.quietOnNoChange !== true || !revision(value.maximumNotifications) || value.maximumNotifications > 1000 || !date(value.expiresAt)) return fail();
  const { configurationSha256, ...body } = value;
  if (configurationSha256 !== await sha256(body)) return fail();
  return value as unknown as NotificationConfiguration;
}
async function admission(value: unknown, owner: Owner, id: string): Promise<NotificationAdmission> {
  if (!object(value) || !keys(value, "schemaVersion contract tenantId actorId responsibilityId revision generation state reason configuration used reserved enabledAt updatedAt") || value.schemaVersion !== 1 || value.contract !== NOTIFICATIONS_CONTRACT || !owned(value, owner, id) ||
    !revision(value.revision) || !revision(value.generation) || !member(value.state, ["enabled", "paused", "draining", "ended"]) || !member(value.reason, ["owner_enabled", "owner_stopped", "runtime_paused", "runtime_resumed", "runtime_ended", "runtime_blocked", "expired", "checks_exhausted"]) ||
    !integer(value.used, 1000) || !integer(value.reserved, 1000) || !date(value.enabledAt) || !date(value.updatedAt) || value.updatedAt < value.enabledAt) return fail();
  const config = await configuration(value.configuration, owner, id);
  if (value.used + value.reserved > config.maximumNotifications || member(value.state, ["paused", "ended"]) && value.reserved !== 0 || value.reason === "owner_stopped" && value.state !== "ended") return fail();
  return value as unknown as NotificationAdmission;
}
async function candidate(value: unknown, owner: Owner, id: string): Promise<ResponsibilityNotificationCandidate> {
  if (!object(value) || !keys(value, "schemaVersion tenantId actorId responsibilityId id changeId changeSha256 configurationSha256 generation revision state reason attempts expiresAt nextAttemptAt notificationId dispositionId deliveryBindingSha256 createdAt updatedAt terminalAt") || value.schemaVersion !== 1 || !owned(value, owner, id) ||
    !text(value.changeId) || !/^responsibility-change:[a-f0-9]{64}$/.test(value.changeId) || !digest(value.changeSha256) || !digest(value.configurationSha256) || !revision(value.generation) || !revision(value.revision) || !integer(value.attempts, 100) ||
    !member(value.state, ["pending", "held", "delivered", "canceled", "blocked", "expired"]) || !member(value.reason, ["material_change", "quiet_hours", "delivery_retry", "in_app_recorded", "owner_paused", "owner_ended", "owner_stopped", "runtime_blocked", "expired", "source_unavailable", "destination_unavailable", "notifications_disabled", "preferences_unavailable", "notification_limit"]) ||
    !date(value.expiresAt) || !date(value.createdAt) || !date(value.updatedAt) || value.updatedAt < value.createdAt || value.expiresAt <= value.createdAt ||
    !nullableId(value.notificationId, /^notification_[a-f0-9]{48}$/) || !nullableId(value.dispositionId, /^notification_disposition_[a-f0-9]{48}$/) || value.deliveryBindingSha256 !== null && !digest(value.deliveryBindingSha256)) return fail();
  const pending = member(value.state, ["pending", "held"]); const delivered = value.state === "delivered";
  if (pending ? value.terminalAt !== null || !date(value.nextAttemptAt) || value.nextAttemptAt < value.updatedAt || value.nextAttemptAt > value.expiresAt : value.nextAttemptAt !== null || value.terminalAt !== value.updatedAt) return fail();
  if (delivered !== (value.notificationId !== null) || delivered !== (value.deliveryBindingSha256 !== null) || delivered && (value.dispositionId === null || value.reason !== "in_app_recorded") ||
    value.id !== `responsibility-notification:${await sha256([value.tenantId, value.actorId, id, value.changeId, value.changeSha256, "owner_in_app"])}`) return fail();
  return value as unknown as ResponsibilityNotificationCandidate;
}
async function receipt(value: unknown, owner: Owner, id: string): Promise<ResponsibilityNotificationReceipt> {
  if (!object(value) || !keys(value, "schemaVersion id idempotencySha256 requestSha256 previousRevision action snapshot candidate savedAt contentIncluded receiptSha256") || value.schemaVersion !== 1 || !digest(value.idempotencySha256) || !digest(value.requestSha256) || !integer(value.previousRevision, Number.MAX_SAFE_INTEGER - 2) ||
    !member(value.action, ["enable", "stop", "admit", "hold", "retry", "deliver", "cancel", "block", "expire", "lifecycle"]) || value.contentIncluded !== false || !date(value.savedAt)) return fail();
  const head = await admission(value.snapshot, owner, id); const exact = { tenantId: head.tenantId, actorId: head.actorId };
  const item = value.candidate === null ? null : await candidate(value.candidate, exact, id);
  const { receiptSha256, ...body } = value;
  if (receiptSha256 !== await sha256(body) || head.revision !== value.previousRevision + 1 || value.savedAt !== head.updatedAt ||
    value.id !== `responsibility-notification-receipt:${await sha256([head.tenantId, head.actorId, value.idempotencySha256])}` ||
    member(value.action, ["enable", "stop", "lifecycle"]) !== (item === null) || item && (item.configurationSha256 !== head.configuration.configurationSha256 || item.generation !== head.generation || item.updatedAt !== value.savedAt)) return fail();
  return value as unknown as ResponsibilityNotificationReceipt;
}
export async function readNotifications(value: unknown, owner: Owner, id: string): Promise<NotificationsView> {
  if (!envelope(value) || !keys(value, "schemaVersion contract disclosure externalDelivery current candidates receipts coverage", "preview") || !Array.isArray(value.candidates) || value.candidates.length > 40 || !Array.isArray(value.receipts) || value.receipts.length > 40 ||
    !object(value.coverage) || !keys(value.coverage, "limit total hasMoreCandidates hasMoreReceipts") || value.coverage.limit !== 40 || value.coverage.total !== null || typeof value.coverage.hasMoreCandidates !== "boolean" || typeof value.coverage.hasMoreReceipts !== "boolean") return fail();
  const current = value.current === null ? null : await admission(value.current, owner, id); const exact = current ? { tenantId: current.tenantId, actorId: current.actorId } : owner;
  if (!current && (value.candidates.length || value.receipts.length || value.coverage.hasMoreCandidates || value.coverage.hasMoreReceipts)) return fail();
  const candidates: ResponsibilityNotificationCandidate[] = []; const receipts: ResponsibilityNotificationReceipt[] = [];
  for (const row of value.candidates) {
    const item = await candidate(row, exact, id);
    if (!current || item.configurationSha256 !== current.configuration.configurationSha256 || item.generation > current.generation || item.updatedAt > current.updatedAt) return fail();
    if (member(item.state, ["pending", "held"]) && (item.generation !== current.generation || !member(current.state, ["enabled", "draining"]))) return fail();
    candidates.push(item);
  }
  // This is a bounded history, so displayed rows may undercount the ledger.
  // They cannot exceed confirmed cumulative use or current reservations.
  if (current && (candidates.filter((item) => member(item.state, ["pending", "held"])).length > current.reserved ||
    candidates.filter((item) => item.state === "delivered").length > current.used)) return fail();
  for (const row of value.receipts) {
    const item = await receipt(row, exact, id);
    if (!current || item.snapshot.revision > current.revision || !sameJson(item.snapshot.configuration, current.configuration) || item.snapshot.revision === current.revision && !sameJson(item.snapshot, current)) return fail();
    receipts.push(item);
  }
  if (new Set(candidates.map((item) => item.id)).size !== candidates.length || new Set(receipts.map((item) => item.snapshot.revision)).size !== receipts.length || new Set(receipts.map((item) => item.id)).size !== receipts.length) return fail();
  if (value.preview !== undefined) {
    if (!object(value.preview) || value.preview.authorityEffect !== "none") return fail();
    if (value.preview.state === "ready") {
      if (current || !keys(value.preview, "state authorityEffect configuration expectedRuntimeRevision expectedRuntimeGeneration") || !revision(value.preview.expectedRuntimeRevision) || !revision(value.preview.expectedRuntimeGeneration)) return fail();
      await configuration(value.preview.configuration, owner, id);
    } else if (value.preview.state !== "blocked" || !keys(value.preview, "state authorityEffect reason") || !text(value.preview.reason)) return fail();
  }
  return value as unknown as NotificationsView;
}
export async function verifyNotificationsResult(value: unknown, owner: Owner, id: string, input: NotificationControlRequest, key: string): Promise<NotificationsResult> {
  if (!envelope(value) || !keys(value, "schemaVersion contract disclosure externalDelivery current receipt replayed") || typeof value.replayed !== "boolean") return fail();
  const accepted = await receipt(value.receipt, owner, id); const snapshot = accepted.snapshot;
  const current = await admission(value.current, { tenantId: snapshot.tenantId, actorId: snapshot.actorId }, id);
  if (accepted.action !== input.action || accepted.idempotencySha256 !== await sha256(["responsibility-idempotency:1", key]) || accepted.requestSha256 !== await sha256({ responsibilityId: id, ...input }) ||
    current.revision < snapshot.revision || !sameJson(current.configuration, snapshot.configuration) || current.revision === snapshot.revision && !sameJson(current, snapshot) || !value.replayed && !sameJson(current, snapshot)) return fail();
  if (input.action === "enable") {
    if (accepted.previousRevision !== 0 || snapshot.revision !== 1 || snapshot.generation !== 1 || snapshot.state !== "enabled" || snapshot.reason !== "owner_enabled" || snapshot.used !== 0 || snapshot.reserved !== 0 || snapshot.configuration.configurationSha256 !== input.configurationSha256) return fail();
  } else if (accepted.previousRevision < input.expectedRevision || snapshot.generation !== input.expectedGeneration + 1 || snapshot.state !== "ended" || snapshot.reason !== "owner_stopped" || snapshot.reserved !== 0) return fail();
  return { current, receipt: accepted, replayed: value.replayed };
}
