import { z } from "zod";
import { authorizeAppServiceCall, completeAppServiceCall, type AppServiceCaller } from "@/lib/app-services/contracts";
import { getAppServiceOperationContract } from "@/lib/app-services/registry";
import { googleConnectorAccountPolicyForIdentity } from "@/lib/connectors/oauth-providers";
import { syncPersonalProvider } from "@/lib/connectors/personal-sync";
import {
  acceptMeetingCalendarSync, readMeetingCalendarConnection, readBlockedMeetingCalendarSync,
  readMeetingCalendarSync, settleMeetingCalendarSync, MeetingCalendarError, type MeetingCalendarAuthority,
} from "@/lib/connectors/meeting-calendar-sync-store";
import {
  MEETING_CALENDAR_READ_CONTRACT, MEETING_CALENDAR_SYNC_CONTRACT,
  nativeMeetingCalendarQuerySchema, nativeMeetingCalendarSyncRequestSchema, nativeMeetingCalendarSyncReadQuerySchema,
  nativeMeetingCalendarSyncIdSchema, nativeMeetingCalendarSettlementSchema,
} from "@/lib/mobile/meeting-calendar-contracts";
import { canonicalAuthUserActorFromSecurityContext } from "@/lib/security/canonical-actor";
import { personalWorkspaceId } from "@/lib/workspaces/contracts";

function authority(caller: AppServiceCaller): MeetingCalendarAuthority {
  const canonical = canonicalAuthUserActorFromSecurityContext(caller.context);
  if (!canonical || !caller.context.auth?.email) throw new MeetingCalendarError("calendar_authority_invalid", 403,
    "A current authenticated account is required for Calendar access.");
  let account;
  try { account = googleConnectorAccountPolicyForIdentity({ tenantId: caller.context.tenantId, email: caller.context.auth.email }); }
  catch { throw new MeetingCalendarError("calendar_account_unavailable", 403, "The current account's Calendar policy is unavailable."); }
  return { scope: { tenantId: caller.context.tenantId, ownerActorId: caller.context.actorId, canonicalActorId: canonical.actorId,
    workspaceId: personalWorkspaceId(canonical.actorId) }, accountEmail: account.email, executionScope: caller.executionScope };
}
export async function showMeetingCalendarService(caller: AppServiceCaller, input: z.input<typeof nativeMeetingCalendarQuerySchema> = {}) {
  nativeMeetingCalendarQuerySchema.parse(input);
  const authorized = authorizeAppServiceCall(caller, getAppServiceOperationContract("meetings.calendar.get"));
  const owner = authority(caller), connection = await readMeetingCalendarConnection(owner);
  const blockedSync = connection ? await readBlockedMeetingCalendarSync(owner, connection.id) : null;
  return completeAppServiceCall(authorized, { contract: MEETING_CALENDAR_READ_CONTRACT, scope: owner.scope, connection, blockedSync }, { resourceCount: connection ? 1 : 0 });
}
export async function inspectMeetingCalendarSyncService(caller: AppServiceCaller, id: string, input: z.input<typeof nativeMeetingCalendarSyncReadQuerySchema>) {
  nativeMeetingCalendarSyncIdSchema.parse(id);
  const query = nativeMeetingCalendarSyncReadQuerySchema.parse(input);
  const authorized = authorizeAppServiceCall(caller, getAppServiceOperationContract("meetings.calendar.sync.get")), owner = authority(caller);
  const sync = await readMeetingCalendarSync(owner, id, query.acceptanceKeySha256);
  if (!sync) throw new MeetingCalendarError("calendar_acceptance_not_found", 404, "Calendar sync acceptance was not found.");
  return completeAppServiceCall(authorized, { contract: MEETING_CALENDAR_READ_CONTRACT, scope: owner.scope, sync }, { resourceCount: 1 });
}
export async function syncMeetingCalendarService(caller: AppServiceCaller, input: z.input<typeof nativeMeetingCalendarSyncRequestSchema>, abortSignal?: AbortSignal) {
  const request = nativeMeetingCalendarSyncRequestSchema.parse(input);
  const authorized = authorizeAppServiceCall(caller, getAppServiceOperationContract("meetings.calendar.sync")), owner = authority(caller);
  if (!caller.idempotencyKey) throw new MeetingCalendarError("calendar_key_invalid", 400, "A valid Idempotency-Key is required.");
  const committed = await acceptMeetingCalendarSync({ authority: owner, request, idempotencyKey: caller.idempotencyKey });
  let sync = committed.sync;
  if (committed.newlyAccepted) {
    try {
      // The accepted request is immutable. A changed/revoked connection never
      // silently switches authorization generations or accounts before work.
      const connection = await readMeetingCalendarConnection(owner, request.connectionId);
      if (abortSignal?.aborted || !connection || connection.status !== "active" || !connection.calendarReadAllowed ||
        connection.authorizationGeneration !== request.expectedAuthorizationGeneration) {
        throw new Error("The reviewed Calendar authorization changed before execution.");
      }
      const observed = await syncPersonalProvider({ tenantId: owner.scope.tenantId, actorId: owner.scope.ownerActorId,
        provider: "google", connectionId: request.connectionId, sources: ["calendar"],
        expectedAuthorizationGeneration: request.expectedAuthorizationGeneration, expectedAccountEmail: owner.accountEmail, abortSignal });
      const source = observed.sources[0];
      if (observed.provider !== "google" || observed.sources.length !== 1 || source?.source !== "calendar" ||
        observed.grant.id !== request.connectionId || observed.grant.tenantId !== owner.scope.tenantId ||
        observed.grant.actorId !== owner.scope.ownerActorId || observed.grant.authorizationGeneration !== request.expectedAuthorizationGeneration ||
        observed.grant.accountEmail !== owner.accountEmail || observed.imported !== source.imported || observed.removed !== source.removed) {
        throw new Error("Calendar sync did not return an exact scoped settlement.");
      }
      const settlement = nativeMeetingCalendarSettlementSchema.parse({ status: observed.status, imported: observed.imported,
        removed: observed.removed, cursorAdvanced: observed.cursorAdvanced,
        coverage: { status: source.status, backfillState: source.backfillState, lastAttemptedAt: source.lastAttemptedAt,
          lastSuccessfulAt: source.lastSuccessfulAt ?? null, failureCode: source.failureCode ?? "none" }, settledAt: new Date().toISOString() });
      sync = await settleMeetingCalendarSync(owner, sync.acceptance.id, settlement);
    } catch {
      // No retry is safe after provider/projection work may have happened. A
      // crash or failed settlement leaves the accepted intent permanently held.
      try { sync = await settleMeetingCalendarSync(owner, sync.acceptance.id, null); }
      catch { /* The already durable acceptance remains evidence, not success. */ }
    }
  }
  return completeAppServiceCall(authorized, { contract: MEETING_CALENDAR_SYNC_CONTRACT, scope: owner.scope, sync,
    replayed: !committed.newlyAccepted }, { resourceCount: 1 });
}
