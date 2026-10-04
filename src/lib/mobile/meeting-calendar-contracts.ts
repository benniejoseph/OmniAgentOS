import { z } from "zod";
import { appServiceReceiptSchema } from "@/lib/app-services/receipt-contracts";
import { canonicalJsonSha256 } from "@/lib/tools/effect-receipt";

export const MEETING_CALENDAR_READ_CONTRACT = "asael-meeting-calendar-read:1" as const;
export const MEETING_CALENDAR_SYNC_CONTRACT = "asael-meeting-calendar-sync:1" as const;
export const MEETING_CALENDAR_ACCEPTANCE_CONTRACT = "asael-meeting-calendar-sync-acceptance:1" as const;
const sha = z.string().regex(/^[a-f0-9]{64}$/);
const at = z.string().datetime({ offset: true });
const integer = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const actor = z.string().regex(/^actor:[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/);
const issue = (context: z.RefinementCtx, message: string) => context.addIssue({ code: "custom", message });

export const nativeMeetingCalendarSyncIdSchema = z.string().regex(/^meeting-calendar-sync:[a-f0-9]{64}$/);
export const nativeMeetingCalendarScopeSchema = z.object({
  tenantId: z.string().min(1).max(120),
  ownerActorId: z.string().min(1).max(256),
  canonicalActorId: actor,
  workspaceId: z.string().regex(/^workspace:personal:[a-f0-9-]{36}$/),
}).strict().superRefine((value, context) => {
  if (value.workspaceId !== `workspace:personal:${value.canonicalActorId.slice(6)}`) issue(context, "Calendar projection must use its owner's personal workspace.");
});
export const nativeMeetingCalendarQuerySchema = z.object({}).strict();
export const nativeMeetingCalendarSyncReadQuerySchema = z.object({ acceptanceKeySha256: sha }).strict();
export const nativeMeetingCalendarSyncRequestSchema = z.object({
  contract: z.literal(MEETING_CALENDAR_SYNC_CONTRACT),
  connectionId: z.string().uuid(),
  expectedAuthorizationGeneration: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
}).strict();
export const nativeMeetingCalendarCoverageSchema = z.object({
  status: z.enum(["syncing", "healthy", "error"]),
  backfillState: z.enum(["unknown", "in_progress", "complete"]),
  lastAttemptedAt: at,
  lastSuccessfulAt: at.nullable(),
  failureCode: z.enum(["none", "provider_unauthorized", "provider_forbidden", "provider_rate_limited", "provider_unavailable", "processing_failed"]),
}).strict();
export const nativeMeetingCalendarConnectionSchema = z.object({
  id: z.string().uuid(), tenantId: z.string().min(1).max(120), ownerActorId: z.string().min(1).max(256),
  accountEmail: z.string().email().max(320),
  authorizationGeneration: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
  status: z.enum(["active", "revoked"]), calendarReadAllowed: z.boolean(),
  coverage: nativeMeetingCalendarCoverageSchema.nullable(),
  lastSyncedAt: at.nullable(), retryAfter: at.nullable(), updatedAt: at,
}).strict();
export const nativeMeetingCalendarAcceptanceSchema = z.object({
  contract: z.literal(MEETING_CALENDAR_ACCEPTANCE_CONTRACT),
  id: nativeMeetingCalendarSyncIdSchema,
  scope: nativeMeetingCalendarScopeSchema,
  connectionId: z.string().uuid(), authorizationGeneration: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
  idempotencyKeySha256: sha, requestSha256: sha, acceptedAt: at,
}).strict().superRefine((value, context) => {
  if (value.id !== meetingCalendarSyncId(value.scope, value.idempotencyKeySha256) ||
    value.requestSha256 !== meetingCalendarRequestSha256(value.scope, {
      contract: MEETING_CALENDAR_SYNC_CONTRACT, connectionId: value.connectionId,
      expectedAuthorizationGeneration: value.authorizationGeneration,
    })) issue(context, "Calendar acceptance identity or reviewed request digest differs.");
});
export const nativeMeetingCalendarSettlementSchema = z.object({
  status: z.enum(["healthy", "partial", "error"]), imported: integer, removed: integer,
  cursorAdvanced: z.boolean(), coverage: nativeMeetingCalendarCoverageSchema, settledAt: at,
}).strict().superRefine((value, context) => {
  const expected = value.coverage.status === "healthy" ? "healthy" : value.coverage.status === "syncing" ? "partial" : "error";
  if (value.status !== expected) issue(context, "Calendar-only result and source coverage disagree.");
});
export const nativeMeetingCalendarSyncSchema = z.object({
  acceptance: nativeMeetingCalendarAcceptanceSchema,
  state: z.enum(["accepted", "settled", "unconfirmed"]),
  settlement: nativeMeetingCalendarSettlementSchema.nullable(), updatedAt: at,
}).strict().superRefine((value, context) => {
  if ((value.state === "settled") !== (value.settlement !== null) ||
    (value.settlement && value.updatedAt !== value.settlement.settledAt) ||
    Date.parse(value.updatedAt) < Date.parse(value.acceptance.acceptedAt)) issue(context, "Sync state does not match its durable settlement.");
});

export type MeetingCalendarScope = z.infer<typeof nativeMeetingCalendarScopeSchema>;
export type MeetingCalendarSyncRequest = z.infer<typeof nativeMeetingCalendarSyncRequestSchema>;
export type MeetingCalendarAcceptance = z.infer<typeof nativeMeetingCalendarAcceptanceSchema>;
export type MeetingCalendarSync = z.infer<typeof nativeMeetingCalendarSyncSchema>;
export type MeetingCalendarSettlement = z.infer<typeof nativeMeetingCalendarSettlementSchema>;
export function meetingCalendarSyncId(scope: MeetingCalendarScope, rawKeySha256: string) {
  return `meeting-calendar-sync:${canonicalJsonSha256(["meeting-calendar-sync:1", scope.tenantId, scope.ownerActorId, rawKeySha256])}`;
}
export function meetingCalendarRequestSha256(scope: MeetingCalendarScope, request: MeetingCalendarSyncRequest) {
  return canonicalJsonSha256({ contract: MEETING_CALENDAR_ACCEPTANCE_CONTRACT, scope, request });
}
function receipt(operation: string, mutation = false) {
  return appServiceReceiptSchema.superRefine((value, context) => {
    if (value.operation !== operation || value.resourceType !== "meeting_calendar" ||
      value.action !== (mutation ? "write.memory" : "read") || value.accessMode !== (mutation ? "mutation" : "read") ||
      value.eventContract !== (mutation ? "meeting-calendar-sync-events.v1" : "read_only:no_domain_mutation") ||
      (value.idempotencyKeySha256 !== null) !== mutation) issue(context, "Receipt does not describe this Calendar operation.");
  });
}
function bindOutcome(value: { serviceReceipt: z.infer<typeof appServiceReceiptSchema> }, count: number, context: z.RefinementCtx) {
  const { serviceReceipt, ...body } = value;
  if (serviceReceipt.outcomeSha256 !== canonicalJsonSha256(body) || serviceReceipt.resourceCount !== count) issue(context, "Receipt must bind this exact body and count.");
}
function bindSync(scope: MeetingCalendarScope, sync: MeetingCalendarSync, context: z.RefinementCtx) {
  if (canonicalJsonSha256(scope) !== canonicalJsonSha256(sync.acceptance.scope)) issue(context, "Sync acceptance belongs to another owner or workspace.");
}
export const nativeMeetingCalendarStatusResponseSchema = z.object({
  contract: z.literal(MEETING_CALENDAR_READ_CONTRACT), scope: nativeMeetingCalendarScopeSchema,
  connection: nativeMeetingCalendarConnectionSchema.nullable(),
  blockedSync: nativeMeetingCalendarSyncSchema.nullable(),
  serviceReceipt: receipt("meetings.calendar.get"),
}).strict().superRefine((value, context) => {
  bindOutcome(value, value.connection ? 1 : 0, context);
  if (value.connection && (value.connection.tenantId !== value.scope.tenantId || value.connection.ownerActorId !== value.scope.ownerActorId)) issue(context, "Connection belongs to another owner.");
  if (value.blockedSync) {
    bindSync(value.scope, value.blockedSync, context);
    if (value.blockedSync.state === "settled" || value.blockedSync.acceptance.connectionId !== value.connection?.id) issue(context, "Blocked sync must match the current connection.");
  }
});
export const nativeMeetingCalendarSyncReadResponseSchema = z.object({
  contract: z.literal(MEETING_CALENDAR_READ_CONTRACT), scope: nativeMeetingCalendarScopeSchema,
  sync: nativeMeetingCalendarSyncSchema, serviceReceipt: receipt("meetings.calendar.sync.get"),
}).strict().superRefine((value, context) => { bindSync(value.scope, value.sync, context); bindOutcome(value, 1, context); });
export const nativeMeetingCalendarSyncResponseSchema = z.object({
  contract: z.literal(MEETING_CALENDAR_SYNC_CONTRACT), scope: nativeMeetingCalendarScopeSchema,
  sync: nativeMeetingCalendarSyncSchema, replayed: z.boolean(), serviceReceipt: receipt("meetings.calendar.sync", true),
}).strict().superRefine((value, context) => { bindSync(value.scope, value.sync, context); bindOutcome(value, 1, context); });
export const nativeMeetingCalendarErrorSchema = z.object({ error: z.string().min(1).max(4_000), code: z.string().min(1).max(200).optional(), message: z.string().max(4_000).optional() }).strict();
export const nativeMeetingCalendarSchemas = Object.freeze({
  NativeMeetingCalendarQuery: nativeMeetingCalendarQuerySchema,
  NativeMeetingCalendarSyncReadQuery: nativeMeetingCalendarSyncReadQuerySchema,
  NativeMeetingCalendarSyncRequest: nativeMeetingCalendarSyncRequestSchema,
  NativeMeetingCalendarStatusResponse: nativeMeetingCalendarStatusResponseSchema,
  NativeMeetingCalendarSyncReadResponse: nativeMeetingCalendarSyncReadResponseSchema,
  NativeMeetingCalendarSyncResponse: nativeMeetingCalendarSyncResponseSchema,
  NativeMeetingCalendarError: nativeMeetingCalendarErrorSchema,
});
