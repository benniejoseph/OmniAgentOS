import { describe, expect, it } from "vitest";
import { MEETING_CALENDAR_ACCEPTANCE_CONTRACT, MEETING_CALENDAR_SYNC_CONTRACT, meetingCalendarRequestSha256, meetingCalendarSyncId,
  nativeMeetingCalendarAcceptanceSchema, nativeMeetingCalendarScopeSchema, nativeMeetingCalendarSyncSchema,
  nativeMeetingCalendarSyncRequestSchema, nativeMeetingCalendarSyncReadQuerySchema, nativeMeetingCalendarConnectionSchema } from "./meeting-calendar-contracts";
const scope = { tenantId: "calendar-owner", ownerActorId: "owner@example.test", canonicalActorId: "actor:11111111-1111-4111-8111-111111111111",
  workspaceId: "workspace:personal:11111111-1111-4111-8111-111111111111" };
const request = { contract: MEETING_CALENDAR_SYNC_CONTRACT, connectionId: "22222222-2222-4222-8222-222222222222", expectedAuthorizationGeneration: 2 };
const at = "2026-10-04T00:00:00.000Z", keySha = "a".repeat(64);
const acceptance = { contract: MEETING_CALENDAR_ACCEPTANCE_CONTRACT, id: meetingCalendarSyncId(scope, keySha), scope,
  connectionId: request.connectionId, authorizationGeneration: 2, idempotencyKeySha256: keySha, requestSha256: meetingCalendarRequestSha256(scope, request), acceptedAt: at };
describe("strict Calendar publication boundary", () => {
  it("pins an exact connection and generation without generic source or workspace selectors", () => {
    expect(nativeMeetingCalendarSyncRequestSchema.parse(request)).toEqual(request);
    for (const extra of [{ source: "mail" }, { sources: ["calendar"] }, { workspaceId: scope.workspaceId }, { idempotencyKey: "invented" }]) {
      expect(nativeMeetingCalendarSyncRequestSchema.safeParse({ ...request, ...extra }).success).toBe(false);
    }
    expect(nativeMeetingCalendarSyncReadQuerySchema.safeParse({}).success).toBe(false);
  });
  it("rejects a different personal workspace or owner/key/request digest", () => {
    expect(nativeMeetingCalendarScopeSchema.safeParse({ ...scope, workspaceId: "workspace:personal:33333333-3333-4333-8333-333333333333" }).success).toBe(false);
    expect(nativeMeetingCalendarAcceptanceSchema.parse(acceptance)).toEqual(acceptance);
    for (const change of [{ idempotencyKeySha256: "b".repeat(64) }, { requestSha256: "b".repeat(64) }, { authorizationGeneration: 3 }, { scope: { ...scope, ownerActorId: "other@example.test" } }]) {
      expect(nativeMeetingCalendarAcceptanceSchema.safeParse({ ...acceptance, ...change }).success).toBe(false);
    }
  });
  it("never labels accepted or unconfirmed work as settled", () => {
    expect(nativeMeetingCalendarSyncSchema.parse({ acceptance, state: "accepted", settlement: null, updatedAt: at })).toBeTruthy();
    expect(nativeMeetingCalendarSyncSchema.safeParse({ acceptance, state: "settled", settlement: null, updatedAt: at }).success).toBe(false);
  });
  it("rejects credential/cursor/source payload properties in the public connection", () => {
    const connection = { id: request.connectionId, tenantId: scope.tenantId, ownerActorId: scope.ownerActorId, accountEmail: scope.ownerActorId,
      authorizationGeneration: 2, status: "active", calendarReadAllowed: true, coverage: null, lastSyncedAt: null, retryAfter: null, updatedAt: at };
    expect(nativeMeetingCalendarConnectionSchema.parse(connection)).toEqual(connection);
    for (const extra of [{ token: "secret" }, { syncCursor: "cursor" }, { subject: "provider-subject" }, { scopes: [] }]) {
      expect(nativeMeetingCalendarConnectionSchema.safeParse({ ...connection, ...extra }).success).toBe(false);
    }
  });
});
