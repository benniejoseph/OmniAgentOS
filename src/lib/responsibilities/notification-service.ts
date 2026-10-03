import { canonicalAuthUserActorFromSecurityContext, canonicalRequestActorBindingFromSecurityContext } from "@/lib/security/canonical-actor";
import { canPerform } from "@/lib/security/context";
import type { SecurityContext } from "@/lib/security/types";
import { responsibilityIdSchema } from "./contracts";
import { readRuntimeDraft, readRuntimeHead, runtimeDatabaseNow, withResponsibilityRuntimeTransaction } from "./lifecycle-store";
import { notificationControlRequestSchema, notificationEnableRequestSchema, notificationStopRequestSchema, RESPONSIBILITY_NOTIFICATION_CONTRACT } from "./notification-contracts";
import { resolveNotificationReferences } from "./notification-references";
import { buildNotificationConfiguration, enableNotificationAdmission, notificationConflict, verifyNotificationReceipt } from "./notification-state";
import { candidateFromRow, persistNotificationTransition, readNotificationAdmission, readNotificationReceipt, stopNotificationAdmissionWithSql } from "./notification-store";
import { ResponsibilityError, storageInvalid } from "./state";

export const RESPONSIBILITY_NOTIFICATION_DISCLOSURE = "Only an explicitly enabled, reviewed material change can create an item in this owner's Asael inbox. Quiet hours hold pending changes. No email, push, browser notification or provider delivery is authorized. Existing read-only activations remain unchanged.";
const envelope = () => ({ schemaVersion: 1 as const, contract: RESPONSIBILITY_NOTIFICATION_CONTRACT,
  disclosure: RESPONSIBILITY_NOTIFICATION_DISCLOSURE, externalDelivery: false as const });

export async function getResponsibilityNotifications(context: SecurityContext, id: string, preview = false) {
  const { owner, readable } = authorize(context, id, preview ? "manage.workflow" : "read");
  return withResponsibilityRuntimeTransaction(owner, async (sql) => {
    const record = await readRuntimeDraft(sql, owner, id); const runtime = await readRuntimeHead(sql, owner, id);
    const current = await readNotificationAdmission(sql, owner, id);
    const candidates = await sql`SELECT * FROM omni_responsibility_notification_candidates
      WHERE tenant_id = ${owner.tenantId} AND actor_id = ${owner.actorId} AND responsibility_id = ${id} ORDER BY created_at DESC,id LIMIT 41`;
    const receipts = await sql`SELECT receipt FROM omni_responsibility_notification_receipts
      WHERE tenant_id = ${owner.tenantId} AND actor_id = ${owner.actorId} AND responsibility_id = ${id} ORDER BY revision DESC LIMIT 41`;
    const base = { ...envelope(), current, candidates: candidates.slice(0, 40).map((row) => candidateFromRow(row, owner, id)),
      receipts: receipts.slice(0, 40).map((row) => {
        const receipt = verifyNotificationReceipt(row.receipt);
        if (receipt.snapshot.tenantId !== owner.tenantId || receipt.snapshot.actorId !== owner.actorId || receipt.snapshot.responsibilityId !== id) throw storageInvalid();
        return receipt;
      }), coverage: { limit: 40, total: null, hasMoreCandidates: candidates.length > 40, hasMoreReceipts: receipts.length > 40 } };
    if (!preview) return base;
    try {
      if (current) throw notificationConflict("responsibility_notification_already_enabled");
      if (!runtime) throw notificationConflict("responsibility_notification_not_active");
      const now = await runtimeDatabaseNow(sql);
      await resolveNotificationReferences(sql, owner, record, runtime, now, context);
      return { ...base, preview: { state: "ready" as const, authorityEffect: "none" as const,
        configuration: buildNotificationConfiguration(record, runtime, now), expectedRuntimeRevision: runtime.revision, expectedRuntimeGeneration: runtime.generation } };
    } catch (error) {
      if (error instanceof ResponsibilityError && (error.status === 403 || error.status === 409)) {
        return { ...base, preview: { state: "blocked" as const, reason: error.code, authorityEffect: "none" as const } };
      }
      throw error;
    }
  }, readable);
}
export async function enableResponsibilityNotifications(context: SecurityContext, id: string, rawRequest: unknown, key: string) {
  const { owner, readable } = authorize(context, id, "manage.workflow");
  const checked = notificationEnableRequestSchema.safeParse(rawRequest);
  if (!checked.success) throw new ResponsibilityError("The exact in-app notification request is invalid.", 400, "responsibility_request_invalid");
  const request = { responsibilityId: id, ...checked.data };
  return withResponsibilityRuntimeTransaction(owner, async (sql) => {
    const current = await readNotificationAdmission(sql, owner, id); const prior = await readNotificationReceipt(sql, owner, key, request);
    if (prior) {
      if (!current || prior.snapshot.responsibilityId !== id || current.revision < prior.snapshot.revision) throw storageInvalid();
      return { ...envelope(), current, receipt: prior, replayed: true };
    }
    if (current) throw notificationConflict("responsibility_notification_already_enabled");
    const record = await readRuntimeDraft(sql, owner, id); const runtime = await readRuntimeHead(sql, owner, id);
    if (!runtime) throw notificationConflict("responsibility_notification_not_active");
    const now = await runtimeDatabaseNow(sql);
    await resolveNotificationReferences(sql, owner, record, runtime, now, context);
    const configuration = buildNotificationConfiguration(record, runtime, now);
    const next = enableNotificationAdmission(configuration, runtime, checked.data, now);
    const receipt = await persistNotificationTransition(sql, { previous: null, current: next, key, request, action: "enable" });
    return { ...envelope(), current: next, receipt, replayed: false };
  }, readable);
}
export async function changeResponsibilityNotifications(context: SecurityContext, id: string, rawRequest: unknown, key: string) {
  const parsed = notificationControlRequestSchema.safeParse(rawRequest);
  if (!parsed.success) throw new ResponsibilityError("The exact in-app notification request is invalid.", 400, "responsibility_request_invalid");
  if (parsed.data.action === "enable") return enableResponsibilityNotifications(context, id, parsed.data, key);
  const { owner, readable } = authorize(context, id, "manage.workflow");
  const value = notificationStopRequestSchema.parse(parsed.data); const request = { responsibilityId: id, ...value };
  return withResponsibilityRuntimeTransaction(owner, async (sql) => {
    const current = await readNotificationAdmission(sql, owner, id); const prior = await readNotificationReceipt(sql, owner, key, request);
    if (prior) {
      if (!current || prior.snapshot.responsibilityId !== id || current.revision < prior.snapshot.revision) throw storageInvalid();
      return { ...envelope(), current, receipt: prior, replayed: true };
    }
    if (!current || current.revision !== value.expectedRevision || current.generation !== value.expectedGeneration) throw notificationConflict("responsibility_notification_changed");
    return { ...envelope(), ...await stopNotificationAdmissionWithSql(sql, current, key, request, await runtimeDatabaseNow(sql)), replayed: false };
  }, readable);
}
function authorize(context: SecurityContext, id: string, action: "read" | "manage.workflow") {
  if (!canPerform(context.role, action)) throw new ResponsibilityError("This account cannot perform that responsibility action.", 403, "responsibility_forbidden");
  const canonical = canonicalAuthUserActorFromSecurityContext(context); const binding = canonicalRequestActorBindingFromSecurityContext(context);
  if (!canonical || !binding) throw new ResponsibilityError("An authenticated canonical owner is required.", 409, "responsibility_owner_unbound");
  if (!responsibilityIdSchema.safeParse(id).success) throw new ResponsibilityError("The responsibility ID is invalid.", 400, "responsibility_request_invalid");
  return { owner: { tenantId: context.tenantId, actorId: canonical.actorId }, readable: binding.readableOwnerActorIds };
}
